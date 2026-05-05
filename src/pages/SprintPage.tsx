import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Box,
  Button,
  Chip,
  FormControlLabel,
  IconButton,
  InputAdornment,
  LinearProgress,
  Snackbar,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import SearchIcon from '@mui/icons-material/Search'
import ClearIcon from '@mui/icons-material/Clear'
import ViewWeekIcon from '@mui/icons-material/ViewWeek'
import TableChartIcon from '@mui/icons-material/TableChart'
import { useNavigate } from 'react-router-dom'
import {
  useBatchGetWorkItemsQuery,
  useListIterationsQuery,
  useListTeamMembersQuery,
  useListTeamsQuery,
  usePatchWorkItemMutation,
  useRunWiqlQuery
} from '@/store/api/adoApi'
import { useAppDispatch, useAppSelector } from '@/store'
import { selectWorkItem, setTeam } from '@/store/workspaceSlice'
import {
  bucketTasks,
  buildSprintWiql,
  classifyTask,
  inferLaneState,
  isDoneState,
  isPbiLike,
  KANBAN_LANES,
  laneOf,
  SPRINT_ROW_TYPES,
  TASK_COLUMN_TONE,
  TASK_COLUMNS,
  type KanbanLane,
  type TaskBucket
} from '@/utils/sprintTasks'
import {
  getAssignee,
  getAssigneeName,
  getState,
  getStackRank,
  getTags,
  getTitle,
  getType,
  typeBadge
} from '@/utils/workItemFields'
import { colorForState, colorForType, readableTextColor } from '@/utils/adoColors'
import { tokenizeForSearch } from '@/utils/wiql'
import type { AdoIdentity, AdoIteration, AdoWorkItem } from '@shared/adoTypes'

/* ---------- helpers ---------- */

function initials(name?: string): string {
  if (!name || name === 'Unassigned') return '—'
  const parts = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function timeFrameRank(tf?: 'past' | 'current' | 'future'): number {
  if (tf === 'current') return 0
  if (tf === 'future') return 1
  return 2
}

/** Pull the human-readable message out of an RTK Query error wrapping IpcError. */
function ipcErrorMessage(err: unknown): string | null {
  if (!err) return null
  const e = err as { data?: { message?: string }; error?: string }
  return e?.data?.message ?? e?.error ?? null
}

function compareIterations(a: AdoIteration, b: AdoIteration): number {
  const ra = timeFrameRank(a.attributes?.timeFrame)
  const rb = timeFrameRank(b.attributes?.timeFrame)
  if (ra !== rb) return ra - rb
  const da = a.attributes?.startDate ? Date.parse(a.attributes.startDate) : 0
  const db = b.attributes?.startDate ? Date.parse(b.attributes.startDate) : 0
  return db - da
}

/* ---------- compact task chip ---------- */

function TaskChip({
  task,
  onOpen
}: {
  task: AdoWorkItem
  onOpen: (id: number) => void
}): JSX.Element {
  const state = getState(task)
  const stateColor = colorForState(state)
  const assigneeName = getAssigneeName(task)
  const done = isDoneState(state)
  return (
    <Tooltip
      title={
        <span>
          <b>#{task.id}</b> · {getType(task)} · {state}
          <br />
          {getTitle(task)}
          <br />
          <i>{assigneeName}</i>
        </span>
      }
    >
      <Box
        role="button"
        tabIndex={0}
        onClick={() => onOpen(task.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onOpen(task.id)
        }}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 0.75,
          py: 0.25,
          borderRadius: 1,
          cursor: 'pointer',
          // "Done" gets a subtle green tint that works in both modes;
          // resting state uses MUI's action.hover token so the chip
          // settles onto its surrounding row neatly in dark mode too.
          bgcolor: done ? 'rgba(51,153,51,0.12)' : 'action.hover',
          border: '1px solid',
          borderColor: done ? 'rgba(51,153,51,0.4)' : 'divider',
          transition: 'background 120ms',
          '&:hover': { bgcolor: 'rgba(0,120,212,0.12)' },
          minWidth: 0
        }}
      >
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: stateColor,
            border: (theme) =>
              `1px solid ${
                theme.palette.mode === 'dark'
                  ? 'rgba(255,255,255,0.18)'
                  : 'rgba(0,0,0,0.1)'
              }`,
            flexShrink: 0
          }}
        />
        <Typography
          variant="caption"
          sx={{
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: done ? 'text.disabled' : 'text.primary',
            textDecoration: done ? 'line-through' : 'none'
          }}
        >
          {initials(assigneeName)}
        </Typography>
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            flex: 1
          }}
        >
          {state}
        </Typography>
      </Box>
    </Tooltip>
  )
}

/* ---------- page ---------- */

export default function SprintPage(): JSX.Element {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const { projectId, teamId } = useAppSelector((s) => s.workspace)

  const [iterationPath, setIterationPath] = useState<string | null>(null)
  /**
   * Whether the user filter should also consider task-level assignees.
   * Off by default so the row stays the unit of filtering — picking a
   * person shows every PBI/Bug they own with all their tasks intact
   * (matching the user's mental model of "their work for the sprint").
   * Turning it on adds task assignees to the match and narrows each
   * row's lanes to only the matching tasks.
   */
  const [includeTasksInFilter, setIncludeTasksInFilter] = useState(false)
  /** Selected uniqueName values; the special token `__unassigned__` means
   *  "show items with no assignee". Empty array = no user filter. */
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  /** Selected work-item types to include as rows. Empty = show all. */
  const [selectedTypes, setSelectedTypes] = useState<string[]>([])
  /**
   * Selected ADO `System.State` names. When non-empty, only tasks whose
   * state is in the set appear inside the Kanban lanes. The set holds raw
   * state names ("New", "Active", "Resolved", …), not the normalised lane
   * keys, so the user can disambiguate states that share a lane (e.g.
   * filter "Pending Review" without also pulling in "Active").
   *
   * Standalone rows (a PBI/Bug without children) are also filtered by
   * their *own* state so the row strip itself respects the filter — a
   * lone Bug that's "New" stays hidden when the user filters to "Active".
   */
  const [selectedStates, setSelectedStates] = useState<string[]>([])
  /**
   * Free-text filter that runs across the row's PBI/Bug fields *and* every
   * task under it. Tokenized on whitespace; a row is kept when every
   * token appears somewhere in the row's combined text (id, title, type,
   * state, assignee, tags). Pure substring match — keeps it predictable
   * and fast for the relatively small row sets in a sprint.
   */
  const [textFilter, setTextFilter] = useState('')
  const [viewMode, setViewMode] = useState<'matrix' | 'kanban'>('kanban')

  // Team selection lives on this page since iterations are team-scoped.
  // The list itself is project-scoped, so we kick it off as soon as a
  // project is picked.
  const teamsQ = useListTeamsQuery(
    projectId ? { projectId } : (undefined as never),
    { skip: !projectId }
  )

  const iterationsQ = useListIterationsQuery(
    projectId && teamId ? { projectId, teamId } : (undefined as never),
    { skip: !projectId || !teamId }
  )

  const teamMembersQ = useListTeamMembersQuery(
    projectId && teamId ? { projectId, teamId } : (undefined as never),
    { skip: !projectId || !teamId }
  )

  const sortedIterations = useMemo(() => {
    if (!iterationsQ.data) return []
    return [...iterationsQ.data].sort(compareIterations)
  }, [iterationsQ.data])

  // Default to the current iteration whenever the iteration list changes.
  useEffect(() => {
    if (iterationPath) return
    if (sortedIterations.length === 0) return
    const current = sortedIterations.find(
      (it) => it.attributes?.timeFrame === 'current'
    )
    setIterationPath((current ?? sortedIterations[0]).path)
  }, [sortedIterations, iterationPath])

  const wiql = useMemo(
    () => (iterationPath ? buildSprintWiql(iterationPath) : null),
    [iterationPath]
  )

  const wiqlQ = useRunWiqlQuery(
    projectId && wiql ? { projectId, wiql, teamId: teamId ?? undefined } : (undefined as never),
    { skip: !projectId || !wiql }
  )

  // When the WIQL fails, log the exact query so the user can paste it
  // into ADO's query editor for further diagnosis.
  useEffect(() => {
    if (!wiqlQ.error || !wiql) return
    console.warn('[Sprint] WIQL failed:\n' + wiql, wiqlQ.error)
  }, [wiqlQ.error, wiql])

  const allIds = useMemo(() => {
    if (!wiqlQ.data) return [] as number[]
    const set = new Set<number>()
    for (const w of wiqlQ.data.workItems ?? []) set.add(w.id)
    for (const l of wiqlQ.data.workItemRelations ?? []) {
      if (l.source) set.add(l.source.id)
      if (l.target) set.add(l.target.id)
    }
    return [...set]
  }, [wiqlQ.data])

  const batchQ = useBatchGetWorkItemsQuery(
    projectId && allIds.length > 0
      ? { projectId, ids: allIds }
      : (undefined as never),
    { skip: !projectId || allIds.length === 0 }
  )

  // Build PBI rows + their tasks from the link result.
  const rows = useMemo(() => {
    const items = batchQ.data ?? []
    if (items.length === 0) return [] as Array<{ pbi: AdoWorkItem; tasks: AdoWorkItem[] }>
    const byId = new Map<number, AdoWorkItem>()
    for (const w of items) byId.set(w.id, w)

    const childrenByParent = new Map<number, Set<number>>()
    // Items that appear as a Target (i.e. a child) of any other source.
    // We use this to suppress duplicates when e.g. a Bug is both eligible
    // as a top-level row AND nested under a PBI in the same iteration —
    // it should be shown as a child task only.
    const nestedChildIds = new Set<number>()
    for (const link of wiqlQ.data?.workItemRelations ?? []) {
      if (!link.source || !link.target) continue
      if (link.rel !== 'System.LinkTypes.Hierarchy-Forward') continue
      if (!childrenByParent.has(link.source.id)) {
        childrenByParent.set(link.source.id, new Set())
      }
      childrenByParent.get(link.source.id)!.add(link.target.id)
      nestedChildIds.add(link.target.id)
    }

    const pbis = items.filter(
      (w) => isPbiLike(w) && !nestedChildIds.has(w.id)
    )
    pbis.sort((a, b) => {
      const ra = getStackRank(a) ?? Number.MAX_SAFE_INTEGER
      const rb = getStackRank(b) ?? Number.MAX_SAFE_INTEGER
      if (ra !== rb) return ra - rb
      return a.id - b.id
    })

    return pbis.map((pbi) => {
      const childIds = childrenByParent.get(pbi.id) ?? new Set<number>()
      const tasks = [...childIds]
        .map((id) => byId.get(id))
        .filter((t): t is AdoWorkItem => !!t)
      return { pbi, tasks }
    })
  }, [batchQ.data, wiqlQ.data])

  /**
   * Stable, case-insensitive identity key. Email casing varies between ADO
   * endpoints (team members vs work item assignees), so we lowercase the
   * uniqueName before comparing anywhere.
   */
  function identityKey(id?: AdoIdentity | null): string | null {
    if (!id) return null
    const raw = id.uniqueName ?? id.id ?? id.displayName
    return raw ? raw.toLowerCase() : null
  }

  /**
   * Union of team members and people who actually own work in the sprint.
   * The latter is important because cross-team assignees (testers from QA,
   * reviewers from another squad) should still be filterable.
   */
  const availableUsers = useMemo(() => {
    const map = new Map<string, AdoIdentity>()
    for (const m of teamMembersQ.data ?? []) {
      const key = identityKey(m.identity)
      if (key) map.set(key, m.identity)
    }
    for (const { pbi, tasks } of rows) {
      const collect = (id?: AdoIdentity): void => {
        const k = identityKey(id ?? null)
        if (id && k) map.set(k, id)
      }
      collect(getAssignee(pbi))
      for (const t of tasks) collect(getAssignee(t))
    }
    return [...map.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName)
    )
  }, [teamMembersQ.data, rows])

  const userKeySet = useMemo(
    () => new Set(selectedUsers.map((s) => s.toLowerCase())),
    [selectedUsers]
  )
  const userFilterActive = userKeySet.size > 0

  function matchesUserFilter(item: AdoWorkItem): boolean {
    if (!userFilterActive) return true
    const k = identityKey(getAssignee(item))
    if (!k) return userKeySet.has('__unassigned__')
    return userKeySet.has(k)
  }

  /**
   * The work-item types currently present as rows in this sprint, sorted by
   * the canonical SPRINT_ROW_TYPES order so the chip strip is stable across
   * iterations.
   */
  const availableTypes = useMemo(() => {
    const present = new Set<string>()
    for (const { pbi } of rows) present.add(getType(pbi))
    const ordered = [...SPRINT_ROW_TYPES].filter((t) => present.has(t))
    // Anything unexpected (custom process type) is appended after the known set.
    for (const t of present) if (!ordered.includes(t)) ordered.push(t)
    return ordered
  }, [rows])

  const typeFilterActive = selectedTypes.length > 0
  const typeSet = useMemo(() => new Set(selectedTypes), [selectedTypes])

  /**
   * Distinct ADO state names present in this iteration (from tasks *and*
   * the row items themselves). Sorted by Kanban-lane order so the chip
   * strip reads left-to-right as To Do → In Progress → Done; within a
   * lane states are sorted alphabetically for stability.
   */
  const availableStates = useMemo(() => {
    const present = new Set<string>()
    for (const { pbi, tasks } of rows) {
      present.add(getState(pbi))
      for (const t of tasks) present.add(getState(t))
    }
    const laneOrder: Record<string, number> = {
      todo: 0,
      inProgress: 1,
      done: 2
    }
    return [...present].sort((a, b) => {
      const la = laneOrder[laneOf(a)] ?? 99
      const lb = laneOrder[laneOf(b)] ?? 99
      if (la !== lb) return la - lb
      return a.localeCompare(b)
    })
  }, [rows])

  const stateFilterActive = selectedStates.length > 0
  const stateSet = useMemo(() => new Set(selectedStates), [selectedStates])

  /**
   * Pre-tokenized text filter. Min length 1 (vs. 2 for ADO search) — the
   * sprint dataset is already small enough that a one-char token won't
   * blow up the result set, and it's nice to be able to type "1" to
   * narrow on an id digit.
   */
  const textTokens = useMemo(
    () => tokenizeForSearch(textFilter, 1),
    [textFilter]
  )
  const textFilterActive = textTokens.length > 0

  /**
   * Build a single lowercased haystack for an item — id, title, type,
   * state, assignee, and tags concatenated. Cheap to recompute and lets
   * the matcher use a simple `indexOf` per token.
   */
  function buildHaystack(w: AdoWorkItem): string {
    const tags = getTags(w).join(' ')
    return `${w.id} ${getTitle(w)} ${getType(w)} ${getState(w)} ${getAssigneeName(w)} ${tags}`.toLowerCase()
  }

  function matchesText(pbi: AdoWorkItem, tasks: AdoWorkItem[]): boolean {
    if (!textFilterActive) return true
    const haystacks = [buildHaystack(pbi), ...tasks.map(buildHaystack)]
    // A token is considered matched if it appears in *any* item haystack
    // (the PBI itself or any task). The row is kept when every token
    // matches somewhere — i.e. AND across tokens, OR across items.
    return textTokens.every((tok) => {
      const lc = tok.toLowerCase()
      return haystacks.some((h) => h.includes(lc))
    })
  }

  const filteredRows = useMemo(() => {
    return rows
      .map(({ pbi, tasks }) => {
        // Task lanes are narrowed in two situations:
        //   - "Include tasks in user filter" mode is on AND a user filter
        //     is active → keep only tasks owned by selected users.
        //   - A status filter is active → keep only tasks in selected
        //     states, regardless of who owns them.
        let filteredTasks = tasks
        if (userFilterActive && includeTasksInFilter) {
          filteredTasks = filteredTasks.filter(matchesUserFilter)
        }
        if (stateFilterActive) {
          filteredTasks = filteredTasks.filter((t) => stateSet.has(getState(t)))
        }
        return { pbi, tasks: filteredTasks, allTasks: tasks }
      })
      .filter(({ pbi, tasks, allTasks }) => {
        if (typeFilterActive && !typeSet.has(getType(pbi))) return false
        if (userFilterActive) {
          const pbiMatches = matchesUserFilter(pbi)
          if (includeTasksInFilter) {
            // Match on EITHER the PBI owner or any task assignee.
            if (!pbiMatches && tasks.length === 0) return false
          } else if (!pbiMatches) {
            // Strict PBI-level: row only kept if its owner matches.
            return false
          }
        }
        // State filter behaviour:
        //   - A row with children: keep it if at least one task survived
        //     the state filter (i.e. `tasks.length > 0` after filtering).
        //   - A row with no children (standalone PBI/Bug): keep it only
        //     if the row's *own* state matches — otherwise the row strip
        //     contains nothing relevant to the chosen filter.
        if (stateFilterActive) {
          if (allTasks.length === 0) {
            if (!stateSet.has(getState(pbi))) return false
          } else {
            if (tasks.length === 0) return false
          }
        }
        // Text filter runs against the *unfiltered* task list so the
        // user's search isn't accidentally hidden by the user/state
        // filters above. If the row contains a match anywhere, keep it.
        if (textFilterActive && !matchesText(pbi, allTasks)) {
          return false
        }
        return true
      })
      .map(({ pbi, tasks }) => ({ pbi, tasks }))
    // matchesUserFilter / matchesText close over state that is already
    // in the deps list (userKeySet, textTokens, etc).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rows,
    userKeySet,
    typeSet,
    includeTasksInFilter,
    stateSet,
    textTokens
  ])

  /* ---------- drag-and-drop (Kanban only) ---------- */

  /** Flat list of every visible work item — used to infer the right ADO
   *  state name (e.g. "Active" vs "In Progress") when a card is dropped. */
  const allItems = useMemo(() => {
    const out: AdoWorkItem[] = []
    for (const { pbi, tasks } of filteredRows) {
      out.push(pbi)
      for (const t of tasks) out.push(t)
    }
    return out
  }, [filteredRows])
  const itemById = useMemo(() => {
    const map = new Map<number, AdoWorkItem>()
    for (const it of allItems) map.set(it.id, it)
    return map
  }, [allItems])

  const [patch] = usePatchWorkItemMutation()
  const [dragError, setDragError] = useState<string | null>(null)

  /**
   * Drop handler. Resolves the right ADO state name for the card's type and
   * patches `System.State`. RTK Query applies the change optimistically
   * against any cached batchGetWorkItems result containing this id, so the
   * card visually relocates to the new lane immediately and rolls back if
   * ADO rejects the patch.
   */
  async function moveTaskToLane(
    taskId: number,
    targetLane: KanbanLane
  ): Promise<void> {
    if (!projectId) return
    const item = itemById.get(taskId)
    if (!item) return
    if (laneOf(getState(item)) === targetLane) return

    const targetState = inferLaneState(getType(item), targetLane, allItems)
    try {
      await patch({
        projectId,
        id: taskId,
        patch: [
          { op: 'add', path: '/fields/System.State', value: targetState }
        ]
      }).unwrap()
    } catch (err) {
      const msg =
        ipcErrorMessage(err) ??
        `Azure DevOps rejected setting state to "${targetState}".`
      setDragError(`#${taskId}: ${msg}`)
    }
  }

  /* ---------- guards ---------- */

  if (!projectId) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info" action={
          <Chip
            size="small"
            label="Open Home"
            onClick={() => navigate('/home')}
            color="primary"
          />
        }>
          Pick a project on Home to load the sprint view.
        </Alert>
      </Box>
    )
  }

  /* ---------- render ---------- */

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Stack
        direction="row"
        // useFlexGap switches Stack to CSS `gap` instead of margin-based
        // spacing, which is what makes wrapping rows look right (margin-based
        // spacing leaves visible offsets / clipped controls when items wrap).
        useFlexGap
        flexWrap="wrap"
        spacing={1.5}
        alignItems="center"
        sx={{
          p: 1.5,
          borderBottom: '1px solid',
          borderColor: 'divider',
          rowGap: 1
        }}
      >
        {/*
         * Team picker — lives here (not on the home page) because team
         * scope is what makes iterations meaningful: ADO returns the
         * iteration list per-team, and the Sprint WIQL needs the
         * team-relative iteration path. Switching team also resets the
         * iteration so we don't fall back on a path that belongs to a
         * different team.
         */}
        <Autocomplete
          size="small"
          sx={{
            flex: '1 1 220px',
            minWidth: 180,
            maxWidth: 320
          }}
          options={teamsQ.data ?? []}
          getOptionLabel={(opt) => opt.name}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          value={teamsQ.data?.find((t) => t.id === teamId) ?? null}
          onChange={(_e, value) => {
            dispatch(
              setTeam(value ? { id: value.id, name: value.name } : null)
            )
            // Clear the iteration so the default-pick effect re-runs and
            // selects the new team's current iteration on next load.
            setIterationPath(null)
          }}
          loading={teamsQ.isLoading}
          renderInput={(params) => (
            <TextField
              {...params}
              label={teamsQ.isLoading ? 'Loading teams…' : 'Team (required)'}
              size="small"
              required
              error={!teamId && !teamsQ.isLoading}
            />
          )}
        />

        <Autocomplete
          size="small"
          sx={{
            // Iteration is the primary control — give it a comfortable size
            // when there's room, but allow it to shrink so the rest of the
            // toolbar can stay on the same row at narrower widths.
            flex: '1 1 280px',
            minWidth: 220,
            maxWidth: 380
          }}
          options={sortedIterations}
          getOptionLabel={(opt) =>
            `${opt.name}${
              opt.attributes?.timeFrame === 'current' ? ' (current)' : ''
            }`
          }
          isOptionEqualToValue={(a, b) => a.path === b.path}
          value={
            sortedIterations.find((it) => it.path === iterationPath) ?? null
          }
          onChange={(_e, value) => setIterationPath(value?.path ?? null)}
          disabled={!teamId}
          renderOption={(liProps, option) => {
            const tf = option.attributes?.timeFrame
            const tone =
              tf === 'current'
                ? 'success.main'
                : tf === 'future'
                  ? 'info.main'
                  : 'text.disabled'
            const { key, ...rest } = liProps as typeof liProps & { key?: React.Key }
            return (
              <li
                key={key ?? option.id}
                {...rest}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: tone }} />
                <span>{option.name}</span>
                {option.attributes?.startDate && (
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
                    {new Date(option.attributes.startDate).toLocaleDateString()}
                  </Typography>
                )}
              </li>
            )
          }}
          renderInput={(params) => <TextField {...params} label="Iteration" />}
        />
        <TextField
          size="small"
          // The text filter sits next to the iteration picker (the other
          // primary control) so the user reaches for it first when
          // hunting for a specific PBI/task in a busy sprint.
          sx={{ flex: '1 1 220px', minWidth: 180, maxWidth: 320 }}
          placeholder="Find PBI or task… (id, title, tag, person)"
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: textFilter ? (
                <InputAdornment position="end">
                  <Tooltip title="Clear filter">
                    <IconButton
                      size="small"
                      edge="end"
                      onClick={() => setTextFilter('')}
                    >
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </InputAdornment>
              ) : null
            }
          }}
        />
        <Autocomplete<UserOption, true>
          multiple
          size="small"
          // Don't `flex-grow` the user filter — it would steal space from
          // every other control and force them to wrap before they need to.
          // It still shrinks when the row is tight (down to ~180px).
          //
          // Tighten the inner padding and chip margins so the field stays
          // the same height as a sibling small TextField even after a
          // chip is selected. Without this MUI's default chip (24px) +
          // multi-input padding pushes the field ~10px taller than its
          // neighbours, which made the toolbar look misaligned.
          sx={{
            flex: '0 1 260px',
            minWidth: 180,
            maxWidth: 360,
            '& .MuiAutocomplete-inputRoot': {
              py: '3px !important',
              gap: 0.25
            },
            '& .MuiAutocomplete-tag': {
              my: 0
            }
          }}
          options={[
            { key: '__unassigned__', label: 'Unassigned', isUnassigned: true },
            ...availableUsers.map<UserOption>((u) => ({
              key: (u.uniqueName ?? u.id ?? u.displayName).toLowerCase(),
              label: u.displayName,
              identity: u
            }))
          ]}
          getOptionLabel={(opt) => opt.label}
          isOptionEqualToValue={(a, b) => a.key === b.key}
          value={
            selectedUsers
              .map<UserOption | null>((rawKey) => {
                const k = rawKey.toLowerCase()
                if (k === '__unassigned__') {
                  return {
                    key: '__unassigned__',
                    label: 'Unassigned',
                    isUnassigned: true
                  }
                }
                const id = availableUsers.find(
                  (u) =>
                    (u.uniqueName ?? u.id ?? u.displayName).toLowerCase() === k
                )
                if (!id) return null
                return {
                  key: k,
                  label: id.displayName,
                  identity: id
                }
              })
              .filter((x): x is UserOption => x !== null)
          }
          onChange={(_e, value) => setSelectedUsers(value.map((v) => v.key))}
          renderTags={(value, getTagProps) =>
            value.map((opt, index) => {
              const { key, ...tagProps } = getTagProps({ index })
              return (
                <Chip
                  key={key ?? opt.key}
                  size="small"
                  label={opt.label}
                  {...tagProps}
                  // Constrain the chip so the whole field stays the same
                  // height as a sibling small TextField. Default small
                  // chip is 24px which, combined with the autocomplete
                  // input padding, pushes the field above 40px.
                  sx={{
                    height: 22,
                    '& .MuiChip-label': { px: 0.75, fontSize: 12 },
                    '& .MuiChip-deleteIcon': { fontSize: 14 }
                  }}
                />
              )
            })
          }
          renderInput={(params) => (
            <TextField
              {...params}
              label="Filter by user"
              // Suppress the placeholder once chips are present, otherwise
              // MUI keeps a second input line reserved for it under the
              // chips and the field renders almost twice as tall.
              placeholder={selectedUsers.length === 0 ? 'Add user…' : ''}
            />
          )}
        />
        <Tooltip
          title={
            includeTasksInFilter
              ? 'Filter also matches task assignees and narrows lanes to matching tasks'
              : 'Filter only matches the PBI/Bug owner — all tasks under a matching row stay visible'
          }
        >
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={includeTasksInFilter}
                onChange={(e) => setIncludeTasksInFilter(e.target.checked)}
              />
            }
            label="Include tasks"
          />
        </Tooltip>
        {availableTypes.length > 1 && (
          <Stack
            direction="row"
            useFlexGap
            flexWrap="wrap"
            spacing={0.5}
            alignItems="center"
            // Allow the chip strip itself to wrap on very narrow windows so
            // we don't end up with a single long block that overflows.
            sx={{ rowGap: 0.5 }}
          >
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mr: 0.25 }}
            >
              Types:
            </Typography>
            {availableTypes.map((type) => {
              // When no filter is active every chip is shown as "active"; once
              // the user starts selecting, only the chosen ones stay filled.
              const active = !typeFilterActive || typeSet.has(type)
              const color = colorForType(type)
              return (
                <Chip
                  key={type}
                  size="small"
                  label={typeBadge(type)}
                  onClick={() =>
                    setSelectedTypes((prev) =>
                      prev.includes(type)
                        ? prev.filter((t) => t !== type)
                        : [...prev, type]
                    )
                  }
                  sx={{
                    height: 22,
                    cursor: 'pointer',
                    bgcolor: active ? color : 'transparent',
                    color: active ? readableTextColor(color) : color,
                    border: `1px solid ${color}`,
                    fontWeight: 700,
                    '& .MuiChip-label': {
                      px: 0.75,
                      fontSize: 10,
                      letterSpacing: 0.3
                    },
                    '&:hover': { opacity: 0.85 }
                  }}
                />
              )
            })}
            {typeFilterActive && (
              <Tooltip title="Clear type filter">
                <Chip
                  size="small"
                  label="all"
                  onClick={() => setSelectedTypes([])}
                  sx={{
                    height: 22,
                    cursor: 'pointer',
                    bgcolor: 'transparent',
                    color: 'text.secondary',
                    border: '1px dashed',
                    borderColor: 'divider',
                    '& .MuiChip-label': { px: 0.75, fontSize: 10 }
                  }}
                />
              </Tooltip>
            )}
          </Stack>
        )}
        {/* Show the status filter strip whenever it's relevant: in Kanban
            mode (its primary use), or whenever a status filter is active
            (so it can't be set in Kanban and silently keep filtering Matrix
            view rows after switching). */}
        {(viewMode === 'kanban' || stateFilterActive) && availableStates.length > 1 && (
          <Stack
            direction="row"
            useFlexGap
            flexWrap="wrap"
            spacing={0.5}
            alignItems="center"
            sx={{ rowGap: 0.5 }}
          >
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mr: 0.25 }}
            >
              Status:
            </Typography>
            {availableStates.map((state) => {
              const active = !stateFilterActive || stateSet.has(state)
              const color = colorForState(state)
              return (
                <Chip
                  key={state}
                  size="small"
                  label={state}
                  onClick={() =>
                    setSelectedStates((prev) =>
                      prev.includes(state)
                        ? prev.filter((s) => s !== state)
                        : [...prev, state]
                    )
                  }
                  sx={{
                    height: 22,
                    cursor: 'pointer',
                    bgcolor: active ? color : 'transparent',
                    color: active ? readableTextColor(color) : color,
                    border: `1px solid ${color}`,
                    fontWeight: 600,
                    '& .MuiChip-label': {
                      px: 0.75,
                      fontSize: 11
                    },
                    '&:hover': { opacity: 0.85 }
                  }}
                />
              )
            })}
            {stateFilterActive && (
              <Tooltip title="Clear status filter">
                <Chip
                  size="small"
                  label="all"
                  onClick={() => setSelectedStates([])}
                  sx={{
                    height: 22,
                    cursor: 'pointer',
                    bgcolor: 'transparent',
                    color: 'text.secondary',
                    border: '1px dashed',
                    borderColor: 'divider',
                    '& .MuiChip-label': { px: 0.75, fontSize: 10 }
                  }}
                />
              </Tooltip>
            )}
          </Stack>
        )}
        <Tooltip title="Includes PBIs / User Stories / Requirements / Bugs / Defects">
          <Chip size="small" label={`${filteredRows.length}/${rows.length} rows`} />
        </Tooltip>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={viewMode}
          onChange={(_e, value: 'matrix' | 'kanban' | null) => {
            if (value) setViewMode(value)
          }}
        >
          <ToggleButton value="matrix">
            <Tooltip title="Matrix view (PBI × task type)">
              <TableChartIcon fontSize="small" />
            </Tooltip>
          </ToggleButton>
          <ToggleButton value="kanban">
            <Tooltip title="Kanban view (tasks by state)">
              <ViewWeekIcon fontSize="small" />
            </Tooltip>
          </ToggleButton>
        </ToggleButtonGroup>
        <Tooltip title="Refresh">
          <IconButton
            size="small"
            onClick={() => {
              wiqlQ.refetch()
              batchQ.refetch()
            }}
          >
            <RefreshIcon />
          </IconButton>
        </Tooltip>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            // Take the remaining space on the current row when there is some,
            // wrap to its own row otherwise (so it never causes other
            // controls to be pushed off-screen on narrow windows).
            flex: '1 1 220px',
            textAlign: 'right',
            minWidth: 0
          }}
        >
          {viewMode === 'matrix'
            ? 'Click any task chip to open it · rows sorted by stack rank'
            : 'Each row is a PBI · drag tasks between lanes to update state · click a card to open'}
        </Typography>
      </Stack>

      <Box sx={{ position: 'relative', flex: 1, overflow: 'auto', minHeight: 0 }}>
        {(wiqlQ.isFetching || batchQ.isFetching) && (
          <LinearProgress sx={{ position: 'sticky', top: 0, zIndex: 5 }} />
        )}
        {!teamId && (
          <Box sx={{ p: 3 }}>
            <Alert severity="info">
              <AlertTitle>Pick a team</AlertTitle>
              Iterations are scoped per ADO team — choose one above to
              load the sprint.{' '}
              {teamsQ.data && teamsQ.data.length === 0 && (
                <span>
                  This project has no teams visible to your PAT. Ask an
                  admin or pick a different project.
                </span>
              )}
            </Alert>
          </Box>
        )}
        {wiqlQ.error != null && (
          <Box sx={{ p: 2 }}>
            <Alert severity="error">
              <AlertTitle>Failed to load iteration</AlertTitle>
              {ipcErrorMessage(wiqlQ.error) ??
                'Azure DevOps rejected the sprint query.'}
              {wiql && (
                <Box
                  component="pre"
                  sx={{
                    mt: 1,
                    p: 1,
                    fontSize: 11,
                    bgcolor: 'action.hover',
                    borderRadius: 1,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }}
                >
                  {wiql}
                </Box>
              )}
            </Alert>
          </Box>
        )}
        {!!teamId &&
          !wiqlQ.isLoading &&
          !batchQ.isLoading &&
          rows.length === 0 && (
            <Box sx={{ p: 4, textAlign: 'center' }}>
              <Typography color="text.secondary">
                No backlog rows (PBI / User Story / Bug / Defect) found in this
                iteration.
              </Typography>
            </Box>
          )}
        {!wiqlQ.isLoading &&
          !batchQ.isLoading &&
          rows.length > 0 &&
          filteredRows.length === 0 && (
            <Box sx={{ p: 4, textAlign: 'center' }}>
              <Typography color="text.secondary" gutterBottom>
                No rows match the current filters.
              </Typography>
              {(textFilterActive ||
                stateFilterActive ||
                typeFilterActive ||
                userFilterActive) && (
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => {
                    setTextFilter('')
                    setSelectedStates([])
                    setSelectedTypes([])
                    setSelectedUsers([])
                  }}
                >
                  Clear all filters
                </Button>
              )}
            </Box>
          )}
        {filteredRows.length > 0 && viewMode === 'matrix' && (
          <SprintMatrix
            rows={filteredRows}
            onOpen={(id) => dispatch(selectWorkItem(id))}
          />
        )}
        {filteredRows.length > 0 && viewMode === 'kanban' && (
          <SprintKanban
            rows={filteredRows}
            onOpen={(id) => dispatch(selectWorkItem(id))}
            onMoveTask={(id, lane) => void moveTaskToLane(id, lane)}
          />
        )}
      </Box>
      <Snackbar
        open={!!dragError}
        autoHideDuration={5000}
        onClose={() => setDragError(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="error"
          onClose={() => setDragError(null)}
          variant="filled"
        >
          {dragError}
        </Alert>
      </Snackbar>
    </Box>
  )
}

interface UserOption {
  key: string
  label: string
  identity?: AdoIdentity
  isUnassigned?: boolean
}

/* ---------- matrix ---------- */

function SprintMatrix({
  rows,
  onOpen
}: {
  rows: Array<{ pbi: AdoWorkItem; tasks: AdoWorkItem[] }>
  onOpen: (id: number) => void
}): JSX.Element {
  const PBI_COL_WIDTH = 360
  const TASK_COL_WIDTH = 160

  return (
    <Box
      component="table"
      sx={{
        borderCollapse: 'separate',
        borderSpacing: 0,
        width: '100%',
        minWidth: PBI_COL_WIDTH + TASK_COL_WIDTH * TASK_COLUMNS.length + 120,
        tableLayout: 'fixed',
        fontSize: 13
      }}
    >
      <Box component="thead">
        <Box component="tr">
          <Box
            component="th"
            sx={{
              position: 'sticky',
              top: 0,
              left: 0,
              zIndex: 4,
              // The matrix header sits on top of the scrolling table body,
              // so it needs a solid surface colour. Use background.paper so
              // it inherits both light and dark theme tokens cleanly.
              bgcolor: 'background.paper',
              borderBottom: '1px solid',
              borderRight: '1px solid',
              borderColor: 'divider',
              textAlign: 'left',
              px: 1.5,
              py: 1,
              width: PBI_COL_WIDTH,
              minWidth: PBI_COL_WIDTH
            }}
          >
            PBI / Owner
          </Box>
          {TASK_COLUMNS.map((col) => (
            <Box
              component="th"
              key={col.key}
              sx={{
                position: 'sticky',
                top: 0,
                zIndex: 3,
                bgcolor: 'background.paper',
                borderBottom: '1px solid',
                borderColor: 'divider',
                px: 1,
                py: 1,
                textAlign: 'center',
                width: TASK_COL_WIDTH,
                minWidth: TASK_COL_WIDTH
              }}
            >
              <Box
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.5,
                  px: 0.75,
                  py: 0.25,
                  borderRadius: 1,
                  bgcolor: TASK_COLUMN_TONE[col.tone],
                  color: '#FFFFFF',
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: 0.3,
                  textTransform: 'uppercase'
                }}
              >
                {col.short}
              </Box>
            </Box>
          ))}
          <Box
            component="th"
            sx={{
              position: 'sticky',
              top: 0,
              zIndex: 3,
              bgcolor: 'background.paper',
              borderBottom: '1px solid',
              borderColor: 'divider',
              px: 1.5,
              py: 1,
              textAlign: 'left',
              width: 120,
              minWidth: 120
            }}
          >
            Progress
          </Box>
        </Box>
      </Box>
      <Box component="tbody">
        {rows.map(({ pbi, tasks }) => (
          <SprintRow
            key={pbi.id}
            pbi={pbi}
            tasks={tasks}
            onOpen={onOpen}
            pbiColWidth={PBI_COL_WIDTH}
            taskColWidth={TASK_COL_WIDTH}
          />
        ))}
      </Box>
    </Box>
  )
}

function SprintRow({
  pbi,
  tasks,
  onOpen,
  pbiColWidth,
  taskColWidth
}: {
  pbi: AdoWorkItem
  tasks: AdoWorkItem[]
  onOpen: (id: number) => void
  pbiColWidth: number
  taskColWidth: number
}): JSX.Element {
  const buckets = useMemo(() => bucketTasks(tasks), [tasks])
  const total = tasks.length
  const done = tasks.filter((t) => isDoneState(getState(t))).length
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  const pbiState = getState(pbi)
  const pbiType = getType(pbi)
  const ownerName = getAssigneeName(pbi)

  return (
    <Box
      component="tr"
      sx={{
        '&:hover td': { bgcolor: 'action.hover' }
      }}
    >
      <Box
        component="td"
        sx={{
          position: 'sticky',
          left: 0,
          zIndex: 2,
          bgcolor: 'background.paper',
          borderBottom: '1px solid',
          borderRight: '1px solid',
          borderColor: 'divider',
          px: 1.5,
          py: 1,
          verticalAlign: 'top',
          width: pbiColWidth,
          minWidth: pbiColWidth
        }}
      >
        <Stack spacing={0.5}>
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Chip
              label={pbiType}
              size="small"
              sx={{
                bgcolor: colorForType(pbiType),
                color: readableTextColor(colorForType(pbiType)),
                fontWeight: 700,
                height: 20,
                '& .MuiChip-label': { px: 0.75, fontSize: 10 }
              }}
            />
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            >
              #{pbi.id}
            </Typography>
            <Box
              sx={{
                ml: 0.5,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5
              }}
            >
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: colorForState(pbiState),
                  border: (theme) =>
                    `1px solid ${
                      theme.palette.mode === 'dark'
                        ? 'rgba(255,255,255,0.18)'
                        : 'rgba(0,0,0,0.1)'
                    }`
                }}
              />
              <Typography variant="caption" color="text.secondary">
                {pbiState}
              </Typography>
            </Box>
          </Stack>
          <Box
            role="button"
            tabIndex={0}
            onClick={() => onOpen(pbi.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onOpen(pbi.id)
            }}
            sx={{
              cursor: 'pointer',
              fontWeight: 600,
              lineHeight: 1.3,
              color: 'text.primary',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              '&:hover': { color: 'primary.main' }
            }}
          >
            {getTitle(pbi)}
          </Box>
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Tooltip title={ownerName}>
              <Box
                sx={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  bgcolor: (theme) =>
                    ownerName === 'Unassigned'
                      ? theme.palette.action.disabledBackground
                      : '#1A73E8',
                  color: (theme) =>
                    ownerName === 'Unassigned'
                      ? theme.palette.text.secondary
                      : '#FFFFFF',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 700
                }}
              >
                {initials(ownerName)}
              </Box>
            </Tooltip>
            <Typography variant="caption" color="text.secondary">
              {ownerName}
            </Typography>
          </Stack>
        </Stack>
      </Box>
      {TASK_COLUMNS.map((col) => (
        <TaskCell
          key={col.key}
          tasks={buckets[col.key as TaskBucket]}
          onOpen={onOpen}
          width={taskColWidth}
        />
      ))}
      <Box
        component="td"
        sx={{
          borderBottom: '1px solid',
          borderColor: 'divider',
          px: 1.5,
          py: 1,
          verticalAlign: 'top',
          width: 120,
          minWidth: 120
        }}
      >
        <Stack spacing={0.5}>
          <Typography
            variant="caption"
            sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
          >
            {done}/{total}
          </Typography>
          <LinearProgress
            variant="determinate"
            value={pct}
            sx={{
              height: 6,
              borderRadius: 3,
              bgcolor: 'action.hover',
              '& .MuiLinearProgress-bar': {
                bgcolor: pct === 100 ? '#339933' : '#1A73E8'
              }
            }}
          />
        </Stack>
      </Box>
    </Box>
  )
}

function TaskCell({
  tasks,
  onOpen,
  width
}: {
  tasks: AdoWorkItem[]
  onOpen: (id: number) => void
  width: number
}): JSX.Element {
  return (
    <Box
      component="td"
      sx={{
        borderBottom: '1px solid',
        borderLeft: '1px solid',
        borderColor: 'divider',
        px: 0.75,
        py: 0.75,
        verticalAlign: 'top',
        width,
        minWidth: width
      }}
    >
      {tasks.length === 0 ? (
        <Typography variant="caption" color="text.disabled">
          —
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {tasks.map((t) => (
            <TaskChip key={t.id} task={t} onOpen={onOpen} />
          ))}
        </Stack>
      )}
    </Box>
  )
}

/* ---------- kanban (swimlane, ADO-style taskboard) ---------- */

/**
 * Swimlane Kanban modelled after ADO's own taskboard. Rows are PBIs (the
 * row header carries the PBI's own state, but the PBI itself never appears
 * as a card in a lane), columns are the three normalised task states
 * (To Do / In Progress / Done), and each cell holds the tasks under that
 * PBI in that state.
 *
 * Standalone backlog items (PBI / Bug / Defect with no child tasks) still
 * need to be visible somewhere — for those rows we treat the row item
 * itself as the unit of work and place a single card in its matching state
 * lane. The card's left accent uses the work-item type colour so it
 * visually differs from a child task.
 */
/** MIME type for the dragged-task payload. Encodes both the task id and
 *  the source PBI id so cells can reject cross-row drops (state lives on
 *  the task itself, but moving a task across PBIs would also reparent it
 *  — a separate operation we don't yet support). */
const DRAG_MIME = 'application/x-ado-task-id'

function SprintKanban({
  rows,
  onOpen,
  onMoveTask
}: {
  rows: Array<{ pbi: AdoWorkItem; tasks: AdoWorkItem[] }>
  onOpen: (id: number) => void
  onMoveTask: (taskId: number, targetLane: KanbanLane) => void
}): JSX.Element {
  const PBI_COL_WIDTH = 320
  const LANE_MIN_WIDTH = 240

  /** Per-lane task counts shown in the column header chips. PBIs / Bugs
   *  themselves never count toward a lane — only their child tasks do. */
  const totals = useMemo(() => {
    const counts: Record<KanbanLane, number> = {
      todo: 0,
      inProgress: 0,
      done: 0
    }
    for (const { tasks } of rows) {
      for (const t of tasks) counts[laneOf(getState(t))] += 1
    }
    return counts
  }, [rows])

  return (
    <Box
      component="table"
      sx={{
        borderCollapse: 'separate',
        borderSpacing: 0,
        width: '100%',
        minWidth: PBI_COL_WIDTH + LANE_MIN_WIDTH * KANBAN_LANES.length,
        tableLayout: 'fixed',
        fontSize: 13
      }}
    >
      <Box component="thead">
        <Box component="tr">
          <Box
            component="th"
            sx={{
              position: 'sticky',
              top: 0,
              left: 0,
              zIndex: 4,
              bgcolor: 'background.paper',
              borderBottom: '1px solid',
              borderRight: '1px solid',
              borderColor: 'divider',
              textAlign: 'left',
              px: 1.5,
              py: 1,
              width: PBI_COL_WIDTH,
              minWidth: PBI_COL_WIDTH
            }}
          >
            PBI / Owner
          </Box>
          {KANBAN_LANES.map((lane) => (
            <Box
              component="th"
              key={lane.key}
              sx={{
                position: 'sticky',
                top: 0,
                zIndex: 3,
                bgcolor: 'background.paper',
                // Lane tone underlines stay vivid in dark mode (the hex
                // tones in KANBAN_LANES are saturated enough to read on
                // both surfaces); only the right divider needs a token.
                borderBottom: `2px solid ${lane.tone}`,
                borderRight: '1px solid',
                borderColor: 'divider',
                px: 1.5,
                py: 1,
                textAlign: 'left',
                minWidth: LANE_MIN_WIDTH
              }}
            >
              <Stack direction="row" spacing={1} alignItems="center">
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    bgcolor: lane.tone,
                    border: (theme) =>
                      `1px solid ${
                        theme.palette.mode === 'dark'
                          ? 'rgba(255,255,255,0.18)'
                          : 'rgba(0,0,0,0.1)'
                      }`
                  }}
                />
                <Typography
                  variant="subtitle2"
                  sx={{ fontWeight: 700, flex: 1 }}
                >
                  {lane.label}
                </Typography>
                <Chip
                  size="small"
                  label={totals[lane.key]}
                  sx={{
                    height: 18,
                    bgcolor: lane.tone,
                    color: '#FFFFFF',
                    '& .MuiChip-label': {
                      px: 0.75,
                      fontSize: 10,
                      fontWeight: 700
                    }
                  }}
                />
              </Stack>
            </Box>
          ))}
        </Box>
      </Box>
      <Box component="tbody">
        {rows.map(({ pbi, tasks }) => (
          <KanbanSwimRow
            key={pbi.id}
            pbi={pbi}
            tasks={tasks}
            onOpen={onOpen}
            onMoveTask={onMoveTask}
            pbiColWidth={PBI_COL_WIDTH}
          />
        ))}
      </Box>
    </Box>
  )
}

function KanbanSwimRow({
  pbi,
  tasks,
  onOpen,
  onMoveTask,
  pbiColWidth
}: {
  pbi: AdoWorkItem
  tasks: AdoWorkItem[]
  onOpen: (id: number) => void
  onMoveTask: (taskId: number, targetLane: KanbanLane) => void
  pbiColWidth: number
}): JSX.Element {
  const buckets = useMemo<Record<KanbanLane, AdoWorkItem[]>>(() => {
    const out: Record<KanbanLane, AdoWorkItem[]> = {
      todo: [],
      inProgress: [],
      done: []
    }
    // Lanes only ever contain tasks. A row with no children stays empty —
    // the PBI/Bug itself remains visible via the row header on the left.
    for (const t of tasks) out[laneOf(getState(t))].push(t)
    return out
  }, [tasks])

  const total = tasks.length
  const done = tasks.filter((t) => isDoneState(getState(t))).length
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  const pbiState = getState(pbi)
  const pbiType = getType(pbi)
  const ownerName = getAssigneeName(pbi)

  return (
    <Box
      component="tr"
      sx={{ '&:hover td': { bgcolor: 'action.hover' } }}
    >
      <Box
        component="td"
        sx={{
          position: 'sticky',
          left: 0,
          zIndex: 2,
          bgcolor: 'background.paper',
          borderBottom: '1px solid',
          borderRight: '1px solid',
          borderColor: 'divider',
          px: 1.5,
          py: 1,
          verticalAlign: 'top',
          width: pbiColWidth,
          minWidth: pbiColWidth
        }}
      >
        <Stack spacing={0.5}>
          <Stack
            direction="row"
            spacing={0.75}
            alignItems="center"
            useFlexGap
            flexWrap="wrap"
          >
            <Chip
              label={pbiType}
              size="small"
              sx={{
                bgcolor: colorForType(pbiType),
                color: readableTextColor(colorForType(pbiType)),
                fontWeight: 700,
                height: 20,
                '& .MuiChip-label': { px: 0.75, fontSize: 10 }
              }}
            />
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            >
              #{pbi.id}
            </Typography>
            <Box
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5
              }}
            >
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: colorForState(pbiState),
                  border: (theme) =>
                    `1px solid ${
                      theme.palette.mode === 'dark'
                        ? 'rgba(255,255,255,0.18)'
                        : 'rgba(0,0,0,0.1)'
                    }`
                }}
              />
              <Typography variant="caption" color="text.secondary">
                {pbiState}
              </Typography>
            </Box>
          </Stack>
          <Box
            role="button"
            tabIndex={0}
            onClick={() => onOpen(pbi.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onOpen(pbi.id)
            }}
            sx={{
              cursor: 'pointer',
              fontWeight: 600,
              lineHeight: 1.3,
              color: 'text.primary',
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              wordBreak: 'break-word',
              '&:hover': { color: 'primary.main' }
            }}
          >
            {getTitle(pbi)}
          </Box>
          <Stack
            direction="row"
            spacing={0.75}
            alignItems="center"
            sx={{ mt: 0.25 }}
          >
            <Tooltip title={ownerName}>
              <Box
                sx={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  bgcolor: (theme) =>
                    ownerName === 'Unassigned'
                      ? theme.palette.action.disabledBackground
                      : '#1A73E8',
                  color: (theme) =>
                    ownerName === 'Unassigned'
                      ? theme.palette.text.secondary
                      : '#FFFFFF',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 700,
                  flexShrink: 0
                }}
              >
                {initials(ownerName)}
              </Box>
            </Tooltip>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
                flex: 1
              }}
            >
              {ownerName}
            </Typography>
          </Stack>
          {total > 0 && (
            <Box sx={{ mt: 0.5 }}>
              <Box
                sx={{
                  height: 4,
                  borderRadius: 2,
                  bgcolor: 'action.hover',
                  overflow: 'hidden'
                }}
              >
                <Box
                  sx={{
                    width: `${pct}%`,
                    height: '100%',
                    bgcolor: pct === 100 ? 'success.main' : 'primary.main',
                    transition: 'width 200ms'
                  }}
                />
              </Box>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontSize: 10 }}
              >
                {done}/{total} done
              </Typography>
            </Box>
          )}
        </Stack>
      </Box>
      {KANBAN_LANES.map((lane) => (
        <KanbanSwimCell
          key={lane.key}
          pbi={pbi}
          lane={lane}
          items={buckets[lane.key]}
          onOpen={onOpen}
          onMoveTask={onMoveTask}
        />
      ))}
    </Box>
  )
}

function KanbanSwimCell({
  pbi,
  lane,
  items,
  onOpen,
  onMoveTask
}: {
  pbi: AdoWorkItem
  lane: { key: KanbanLane; label: string; tone: string }
  items: AdoWorkItem[]
  onOpen: (id: number) => void
  onMoveTask: (taskId: number, targetLane: KanbanLane) => void
}): JSX.Element {
  // Two states for visual feedback during a drag:
  //   `valid`   — drag entered this cell AND the source row matches (drop OK)
  //   `invalid` — drag entered this cell but the source row is different
  // Drag events bubble through children, so we count enter/leave pairs to
  // avoid the highlight flickering as the cursor moves over child cards.
  const [hover, setHover] = useState<'none' | 'valid' | 'invalid'>('none')
  const enterDepth = useRef(0)

  function readDrag(e: React.DragEvent):
    | { taskId: number; sourcePbiId: number }
    | null {
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (!raw) return null
    const [t, p] = raw.split('|').map(Number)
    if (!Number.isFinite(t) || !Number.isFinite(p)) return null
    return { taskId: t, sourcePbiId: p }
  }

  /** Many browsers hide the drag payload during dragenter/dragover (only
   *  the *types* list is exposed) — the row check has to be best-effort
   *  on hover and authoritative on drop. */
  function isOurDrag(e: React.DragEvent): boolean {
    return e.dataTransfer.types.includes(DRAG_MIME)
  }

  function handleDragEnter(e: React.DragEvent): void {
    if (!isOurDrag(e)) return
    enterDepth.current += 1
    // We don't know the source PBI here (payload is hidden during enter),
    // so optimistically assume valid; we'll downgrade in dragOver if the
    // payload becomes available, and re-check authoritatively on drop.
    setHover('valid')
  }
  function handleDragLeave(e: React.DragEvent): void {
    if (!isOurDrag(e)) return
    enterDepth.current = Math.max(0, enterDepth.current - 1)
    if (enterDepth.current === 0) setHover('none')
  }
  function handleDragOver(e: React.DragEvent): void {
    if (!isOurDrag(e)) return
    e.preventDefault() // required to allow a drop
    e.dataTransfer.dropEffect = 'move'
  }
  function handleDrop(e: React.DragEvent): void {
    if (!isOurDrag(e)) return
    e.preventDefault()
    enterDepth.current = 0
    setHover('none')
    const payload = readDrag(e)
    if (!payload) return
    if (payload.sourcePbiId !== pbi.id) {
      // Cross-row drop — silently ignored. We don't reparent yet.
      return
    }
    onMoveTask(payload.taskId, lane.key)
  }

  const tint =
    hover === 'valid'
      ? `${lane.tone}1A` // ~10% alpha tint of the lane colour
      : hover === 'invalid'
        ? 'rgba(217,48,37,0.12)'
        : 'background.paper'
  const outline =
    hover === 'valid'
      ? `2px dashed ${lane.tone}`
      : hover === 'invalid'
        ? '2px dashed rgba(217,48,37,0.6)'
        : 'none'

  return (
    <Box
      component="td"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      sx={{
        verticalAlign: 'top',
        borderBottom: '1px solid',
        borderRight: '1px solid',
        borderColor: 'divider',
        px: 0.75,
        py: 0.75,
        bgcolor: tint,
        outline,
        outlineOffset: -2,
        transition: 'background-color 120ms, outline-color 120ms'
      }}
    >
      {items.length === 0 ? (
        <Box
          sx={{
            minHeight: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: hover === 'valid' ? lane.tone : 'text.disabled',
            fontSize: 11,
            fontStyle: 'italic',
            // Pointer-events off so the placeholder doesn't generate its
            // own dragenter/leave events that would mess with the depth
            // counter on the parent cell.
            pointerEvents: 'none'
          }}
        >
          {hover === 'valid' ? 'Drop to move here' : '—'}
        </Box>
      ) : (
        <Stack spacing={0.75}>
          {items.map((t) => (
            <KanbanSwimCard
              key={t.id}
              task={t}
              pbiId={pbi.id}
              onOpen={onOpen}
            />
          ))}
        </Stack>
      )}
    </Box>
  )
}

function KanbanSwimCard({
  task,
  pbiId,
  onOpen
}: {
  task: AdoWorkItem
  /** Id of the swimlane row this card belongs to — encoded into the drag
   *  payload so cells can reject cross-row drops. */
  pbiId: number
  onOpen: (id: number) => void
}): JSX.Element {
  const taskTitle = getTitle(task)
  const taskState = getState(task)
  const assigneeName = getAssigneeName(task)
  const taskType = getType(task)
  const taskStateColor = colorForState(taskState)
  const done = isDoneState(taskState)
  const [dragging, setDragging] = useState(false)

  // Tasks are classified by title to surface FE/BE/QA badges. Anything
  // unrecognised falls back to the work-item type colour so e.g. an Issue
  // or a non-standard Task is still clearly differentiated.
  const bucket = classifyTask(taskTitle)
  const bucketDef = TASK_COLUMNS.find((c) => c.key === bucket) ?? null
  const accent =
    bucketDef && bucket !== 'other'
      ? TASK_COLUMN_TONE[bucketDef.tone]
      : colorForType(taskType)
  const badgeLabel =
    bucketDef && bucket !== 'other' ? bucketDef.short : typeBadge(taskType)

  function handleDragStart(e: React.DragEvent<HTMLDivElement>): void {
    e.dataTransfer.setData(DRAG_MIME, `${task.id}|${pbiId}`)
    e.dataTransfer.effectAllowed = 'move'
    setDragging(true)
  }
  function handleDragEnd(): void {
    setDragging(false)
  }

  return (
    <Box
      role="button"
      tabIndex={0}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={() => onOpen(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen(task.id)
      }}
      sx={{
        // `grab` advertises that the card is movable. Browsers auto-flip
        // to `grabbing` once a drag is in progress.
        cursor: 'grab',
        '&:active': { cursor: 'grabbing' },
        bgcolor: 'background.paper',
        borderRadius: 1,
        borderLeft: `3px solid ${accent}`,
        // Cards rely on shadow + the coloured left border for depth; in
        // dark mode a black drop-shadow disappears against the dark
        // surface, so we lean on a slightly heavier shadow that still
        // reads on top of #161A22.
        boxShadow: (theme) =>
          theme.palette.mode === 'dark'
            ? '0 1px 2px rgba(0,0,0,0.6)'
            : '0 1px 2px rgba(0,0,0,0.05)',
        p: 0.75,
        userSelect: 'none', // keeps drag from accidentally selecting text
        transition: 'box-shadow 120ms, transform 120ms, opacity 120ms',
        '&:hover': {
          boxShadow: (theme) =>
            theme.palette.mode === 'dark'
              ? '0 2px 8px rgba(0,0,0,0.7)'
              : '0 2px 6px rgba(0,0,0,0.12)',
          transform: 'translateY(-1px)'
        },
        opacity: dragging ? 0.4 : done ? 0.75 : 1
      }}
    >
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{ mb: 0.5 }}
      >
        <Chip
          size="small"
          label={badgeLabel}
          sx={{
            height: 16,
            bgcolor: accent,
            color: readableTextColor(accent),
            fontWeight: 700,
            '& .MuiChip-label': {
              px: 0.5,
              fontSize: 9,
              letterSpacing: 0.3,
              textTransform: 'uppercase'
            }
          }}
        />
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 10 }}
        >
          #{task.id}
        </Typography>
        {/* Real ADO state name (the lane is the normalised bucket). */}
        <Chip
          size="small"
          label={taskState}
          sx={{
            height: 14,
            ml: 'auto',
            border: `1px solid ${taskStateColor}`,
            color: taskStateColor,
            bgcolor: 'transparent',
            '& .MuiChip-label': { px: 0.5, fontSize: 9, fontWeight: 600 }
          }}
        />
      </Stack>
      <Typography
        variant="body2"
        sx={{
          fontWeight: 500,
          fontSize: 12,
          lineHeight: 1.3,
          color: 'text.primary',
          textDecoration: done ? 'line-through' : 'none',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          mb: 0.5,
          wordBreak: 'break-word'
        }}
      >
        {taskTitle}
      </Typography>
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Tooltip title={assigneeName}>
          <Box
            sx={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              bgcolor: (theme) =>
                assigneeName === 'Unassigned'
                  ? theme.palette.action.disabledBackground
                  : '#1A73E8',
              color: (theme) =>
                assigneeName === 'Unassigned'
                  ? theme.palette.text.secondary
                  : '#FFFFFF',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 9,
              fontWeight: 700,
              flexShrink: 0
            }}
          >
            {initials(assigneeName)}
          </Box>
        </Tooltip>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            flex: 1,
            fontSize: 10
          }}
        >
          {assigneeName}
        </Typography>
      </Stack>
    </Box>
  )
}
