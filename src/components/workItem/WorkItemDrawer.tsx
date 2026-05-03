import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Drawer,
  IconButton,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import CloseIcon from '@mui/icons-material/Close'
import LaunchIcon from '@mui/icons-material/Launch'
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong'
import PersonOutlineIcon from '@mui/icons-material/PersonOutline'
import { useNavigate } from 'react-router-dom'
import {
  useBatchGetWorkItemsQuery,
  useGetConnectionQuery,
  useGetWorkItemWithRelationsQuery,
  useListTeamMembersQuery,
  usePatchWorkItemMutation
} from '@/store/api/adoApi'
import { IPC } from '@shared/contract'
import { useAppDispatch, useAppSelector } from '@/store'
import { selectWorkItem, setSource } from '@/store/workspaceSlice'
import {
  getAreaPath,
  getAssignee,
  getAssigneeName,
  getChangedDate,
  getCreatedDate,
  getDescription,
  getIterationPath,
  getPriority,
  getStartDate,
  getState,
  getTags,
  getTargetDate,
  getTeamProject,
  getTitle,
  getType,
  relationTargetId
} from '@/utils/workItemFields'
import { colorForState, colorForType, readableTextColor } from '@/utils/adoColors'
import { relativeTime } from '@/utils/sanitize'
import { buildSubtreeWiql } from '@/utils/wiql'
import RichDescription from './RichDescription'
import type { AdoIdentity, AdoJsonPatch, AdoRelation, AdoWorkItem } from '@shared/adoTypes'

const STATE_PRESETS: Record<string, string[]> = {
  Bug: ['New', 'Active', 'Resolved', 'Closed', 'Removed'],
  Defect: ['New', 'Active', 'Resolved', 'Closed', 'Removed'],
  Task: ['To Do', 'In Progress', 'Done', 'Removed'],
  'User Story': ['New', 'Active', 'Resolved', 'Closed', 'Removed'],
  'Product Backlog Item': ['New', 'Approved', 'Committed', 'Done', 'Removed'],
  Feature: ['New', 'In Progress', 'Done', 'Removed'],
  Epic: ['New', 'In Progress', 'Done', 'Removed']
}

const RELATION_GROUPS: Array<{
  id: 'parent' | 'children' | 'predecessors' | 'successors' | 'related'
  label: string
  rels: string[]
  empty: string
}> = [
  {
    id: 'parent',
    label: 'Parent',
    rels: ['System.LinkTypes.Hierarchy-Reverse'],
    empty: 'No parent'
  },
  {
    id: 'children',
    label: 'Children',
    rels: ['System.LinkTypes.Hierarchy-Forward'],
    empty: 'No children'
  },
  {
    id: 'predecessors',
    label: 'Predecessors',
    rels: ['System.LinkTypes.Dependency-Reverse'],
    empty: 'No predecessors'
  },
  {
    id: 'successors',
    label: 'Successors',
    rels: ['System.LinkTypes.Dependency-Forward'],
    empty: 'No successors'
  },
  {
    id: 'related',
    label: 'Related',
    rels: ['System.LinkTypes.Related'],
    empty: 'No related links'
  }
]

function isoDate(value: Date | null): string {
  if (!value) return ''
  return value.toISOString().slice(0, 10)
}

function dateToIso(d: string | undefined): string | null {
  if (!d) return null
  const t = new Date(`${d}T00:00:00.000Z`)
  return Number.isNaN(t.getTime()) ? null : t.toISOString()
}

function MetadataRow({
  label,
  value
}: {
  label: string
  value: React.ReactNode
}): JSX.Element {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ width: 90, flexShrink: 0, pt: '2px', textTransform: 'uppercase', letterSpacing: 0.4 }}
      >
        {label}
      </Typography>
      <Typography variant="body2" sx={{ flex: 1, wordBreak: 'break-word' }}>
        {value}
      </Typography>
    </Box>
  )
}

interface RelationRowProps {
  targetId: number
  rel: string
  title?: string
  type?: string
  state?: string
  assignee?: string
  inWorkspace: boolean
  onClick: () => void
}

function RelationRow({
  targetId,
  title,
  type,
  state,
  assignee,
  inWorkspace,
  onClick
}: RelationRowProps): JSX.Element {
  const typeColor = colorForType(type)
  const stateColor = colorForState(state)
  const stateTextColor = readableTextColor(stateColor)
  return (
    <Box
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick()
      }}
      sx={{
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        py: 0.75,
        px: 1,
        borderRadius: 1,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        transition: 'background-color 120ms, border-color 120ms',
        '&:hover': { bgcolor: 'action.hover', borderColor: 'primary.main' }
      }}
    >
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
        <Chip
          size="small"
          label={type ?? '?'}
          sx={{
            bgcolor: typeColor,
            color: readableTextColor(typeColor),
            height: 20,
            '& .MuiChip-label': { px: 0.75, fontSize: 10, fontWeight: 700 }
          }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
          #{targetId}
        </Typography>
        {state && (
          <Chip
            size="small"
            label={state}
            sx={{
              bgcolor: stateColor,
              color: stateTextColor,
              height: 20,
              fontWeight: 600,
              '& .MuiChip-label': { px: 0.75, fontSize: 10 }
            }}
          />
        )}
        {!inWorkspace && (
          <Tooltip title="Not in current workspace query">
            <Chip
              size="small"
              label="ext"
              variant="outlined"
              sx={{ height: 18, '& .MuiChip-label': { px: 0.5, fontSize: 9 } }}
            />
          </Tooltip>
        )}
      </Stack>
      <Typography
        variant="body2"
        sx={{
          fontWeight: 500,
          lineHeight: 1.3,
          fontStyle: title ? 'normal' : 'italic',
          color: title ? 'text.primary' : 'text.secondary',
          // Allow up to 2 lines, then ellipsis — long titles stay readable
          // without ballooning the relations list.
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden'
        }}
      >
        {title ?? 'Loading…'}
      </Typography>
      {assignee && assignee !== 'Unassigned' && (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <PersonOutlineIcon sx={{ fontSize: 12, color: 'text.secondary' }} />
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11 }}>
            {assignee}
          </Typography>
        </Stack>
      )}
    </Box>
  )
}

export default function WorkItemDrawer(): JSX.Element {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const { selectedWorkItemId, projectId, teamId } = useAppSelector((s) => s.workspace)
  const open = selectedWorkItemId != null
  const [tab, setTab] = useState<'details' | 'edit'>('details')

  const itemQ = useGetWorkItemWithRelationsQuery(
    selectedWorkItemId != null && projectId
      ? { projectId, id: selectedWorkItemId }
      : (undefined as never),
    { skip: !open || !projectId }
  )

  const membersQ = useListTeamMembersQuery(
    projectId && teamId ? { projectId, teamId } : (undefined as never),
    { skip: !projectId || !teamId }
  )

  const [patch, patchState] = usePatchWorkItemMutation()

  const item = itemQ.data
  const type = item ? getType(item) : ''
  const stateOptions = useMemo(() => {
    if (!type) return []
    return STATE_PRESETS[type] ?? ['New', 'Active', 'Resolved', 'Closed', 'Removed']
  }, [type])

  // Resolve all related work-item ids and grab their titles in one batch call,
  // so the relations panel renders something meaningful even for items that
  // aren't part of the active workspace query.
  const relatedIds = useMemo(() => {
    if (!item?.relations) return [] as number[]
    const set = new Set<number>()
    for (const r of item.relations) {
      const id = relationTargetId(r.url)
      if (id != null && id !== item.id) set.add(id)
    }
    return [...set]
  }, [item])

  const relatedQ = useBatchGetWorkItemsQuery(
    projectId && relatedIds.length > 0
      ? {
          projectId,
          ids: relatedIds,
          fields: [
            'System.Id',
            'System.Title',
            'System.WorkItemType',
            'System.State',
            'System.AssignedTo'
          ]
        }
      : (undefined as never),
    { skip: !projectId || relatedIds.length === 0 }
  )

  const titleById = useMemo(() => {
    const m = new Map<number, AdoWorkItem>()
    for (const w of relatedQ.data ?? []) m.set(w.id, w)
    return m
  }, [relatedQ.data])

  const groupedRelations = useMemo(() => {
    const map = new Map<string, AdoRelation[]>()
    if (!item?.relations) return map
    for (const r of item.relations) {
      if (!map.has(r.rel)) map.set(r.rel, [])
      map.get(r.rel)!.push(r)
    }
    return map
  }, [item])

  const [stateValue, setStateValue] = useState('')
  const [assignee, setAssignee] = useState<AdoIdentity | null>(null)
  const [start, setStart] = useState('')
  const [target, setTarget] = useState('')

  // ------- Back / forward navigation history -------
  // The user can drill from one work item to another via Related-items
  // links, or by clicking other items in the visualisations while the
  // drawer is open. We keep a stack of previously-viewed ids so the
  // header can show a Back button.
  //
  // Push rules:
  //   - When `selectedWorkItemId` changes from A → B (both non-null and
  //     different), and the change wasn't itself a Back nav, push A.
  //   - When the drawer closes (id → null), clear the stack.
  // The `isBackNavRef` flag is set right before we dispatch a Back
  // navigation so the effect knows not to re-push.
  const [history, setHistory] = useState<number[]>([])
  const prevIdRef = useRef<number | null>(null)
  const isBackNavRef = useRef(false)

  useEffect(() => {
    const prev = prevIdRef.current
    if (selectedWorkItemId === null) {
      setHistory([])
    } else if (
      prev !== null &&
      prev !== selectedWorkItemId &&
      !isBackNavRef.current
    ) {
      setHistory((h) => [...h, prev])
    }
    isBackNavRef.current = false
    prevIdRef.current = selectedWorkItemId
  }, [selectedWorkItemId])

  const goBack = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h
      const prev = h[h.length - 1]
      isBackNavRef.current = true
      dispatch(selectWorkItem(prev))
      return h.slice(0, -1)
    })
  }, [dispatch])

  useEffect(() => {
    if (!item) return
    setStateValue(getState(item))
    setAssignee(getAssignee(item) ?? null)
    setStart(isoDate(getStartDate(item)))
    setTarget(isoDate(getTargetDate(item)))
  }, [item])

  useEffect(() => {
    if (open) setTab('details')
  }, [selectedWorkItemId, open])

  const dirty = useMemo(() => {
    if (!item) return false
    return (
      stateValue !== getState(item) ||
      (assignee?.uniqueName ?? null) !== (getAssignee(item)?.uniqueName ?? null) ||
      isoDate(getStartDate(item)) !== start ||
      isoDate(getTargetDate(item)) !== target
    )
  }, [item, stateValue, assignee, start, target])

  function close(): void {
    dispatch(selectWorkItem(null))
  }

  async function save(): Promise<void> {
    if (!item) return
    const ops: AdoJsonPatch[] = []
    const original = {
      state: getState(item),
      assignee: getAssignee(item)?.uniqueName ?? null,
      start: isoDate(getStartDate(item)),
      target: isoDate(getTargetDate(item))
    }

    if (stateValue !== original.state) {
      ops.push({ op: 'add', path: '/fields/System.State', value: stateValue })
    }
    const newAssignee = assignee?.uniqueName ?? null
    if (newAssignee !== original.assignee) {
      ops.push({
        op: 'add',
        path: '/fields/System.AssignedTo',
        value: newAssignee ?? ''
      })
    }
    if (start !== original.start) {
      ops.push({
        op: 'add',
        path: '/fields/Microsoft.VSTS.Scheduling.StartDate',
        value: dateToIso(start) ?? ''
      })
    }
    if (target !== original.target) {
      ops.push({
        op: 'add',
        path: '/fields/Microsoft.VSTS.Scheduling.TargetDate',
        value: dateToIso(target) ?? ''
      })
    }

    if (ops.length === 0) return
    await patch({ projectId: projectId ?? undefined, id: item.id, patch: ops }).unwrap()
  }

  function focusSubtree(): void {
    if (!item) return
    dispatch(
      setSource({
        kind: 'wiql',
        wiql: buildSubtreeWiql(item.id),
        label: `Subtree of #${item.id}`
      })
    )
    // Close the drawer and route to the visualisation page so the user
    // can actually *see* the new subtree they just focused on. Without
    // this, the workspace state would change silently behind whatever
    // page they were on (Sprint, Workspace settings, etc.).
    close()
    navigate('/visualize')
  }

  const connectionQ = useGetConnectionQuery()
  const orgUrl = connectionQ.data?.organizationUrl ?? ''

  const webUrl = useMemo(() => {
    if (!item || !orgUrl) return null
    const base = orgUrl.replace(/\/+$/, '')
    // Prefer the work item's own TeamProject — the workspace selection may
    // differ (especially when opening cross-project items via search). If
    // we don't know the project, fall back to the org-level path; ADO
    // redirects /{org}/_workitems/edit/{id} to the correct project.
    const ownProject = getTeamProject(item)
    const project = ownProject ? `/${encodeURIComponent(ownProject)}` : ''
    return `${base}${project}/_workitems/edit/${item.id}`
  }, [item, orgUrl])

  async function openInBrowser(): Promise<void> {
    if (!webUrl) return
    try {
      await window.ado.invoke(IPC.ShellOpenExternal, { url: webUrl })
    } catch (err) {
      console.error('Failed to open external URL', webUrl, err)
    }
  }

  const descriptionHtml = useMemo(
    () => (item ? getDescription(item) : ''),
    [item]
  )
  const tags = item ? getTags(item) : []
  const priority = item ? getPriority(item) : null
  const created = item ? getCreatedDate(item) : null
  const changed = item ? getChangedDate(item) : null

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={close}
      PaperProps={{ sx: { width: 480 } }}
    >
      <Box
        sx={{
          p: 2,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 1,
          borderBottom: '1px solid',
          borderColor: 'divider'
        }}
      >
        {history.length > 0 && (
          <Tooltip
            title={`Back to #${history[history.length - 1]} (${history.length} in history)`}
          >
            <IconButton
              onClick={goBack}
              size="small"
              sx={{ mt: 0.25 }}
              aria-label="Back to previous work item"
            >
              <ArrowBackIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
            {item && (
              <Chip
                label={type}
                size="small"
                sx={{
                  bgcolor: colorForType(type),
                  color: readableTextColor(colorForType(type)),
                  fontWeight: 600,
                  height: 22
                }}
              />
            )}
            <Typography variant="overline" color="text.secondary">
              #{selectedWorkItemId}
            </Typography>
          </Stack>
          <Typography
            variant="h6"
            sx={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3, wordBreak: 'break-word' }}
          >
            {item ? getTitle(item) : 'Loading…'}
          </Typography>
        </Box>
        {webUrl && (
          <Tooltip title="Open in Azure DevOps">
            <IconButton onClick={openInBrowser} size="small">
              <LaunchIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <IconButton onClick={close} size="small" aria-label="Close drawer">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {item && (
        <Stack
          direction="row"
          spacing={1}
          sx={{ px: 2, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}
        >
          <Button
            size="small"
            variant="contained"
            startIcon={<CenterFocusStrongIcon />}
            onClick={focusSubtree}
          >
            Focus on this subtree
          </Button>
        </Stack>
      )}

      <Tabs
        value={tab}
        onChange={(_e, v: 'details' | 'edit') => setTab(v)}
        variant="fullWidth"
        sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 36 }}
      >
        <Tab label="Details" value="details" sx={{ minHeight: 36, py: 0 }} />
        <Tab label="Edit" value="edit" sx={{ minHeight: 36, py: 0 }} />
      </Tabs>

      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        {itemQ.isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        )}
        {itemQ.error != null && <Alert severity="error">Failed to load work item.</Alert>}

        {item && tab === 'details' && (
          <Stack spacing={2.5}>
            <Stack spacing={0.75}>
              <MetadataRow label="State" value={
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Box sx={{
                    width: 10, height: 10, borderRadius: '50%',
                    bgcolor: colorForState(getState(item)),
                    border: '1px solid rgba(0,0,0,0.08)'
                  }} />
                  {getState(item)}
                </Stack>
              } />
              <MetadataRow label="Assignee" value={getAssigneeName(item)} />
              {priority != null && (
                <MetadataRow label="Priority" value={`P${priority}`} />
              )}
              {getIterationPath(item) && (
                <MetadataRow label="Iteration" value={getIterationPath(item)} />
              )}
              {getAreaPath(item) && (
                <MetadataRow label="Area" value={getAreaPath(item)} />
              )}
              {(getStartDate(item) || getTargetDate(item)) && (
                <MetadataRow
                  label="Schedule"
                  value={
                    [
                      getStartDate(item)?.toLocaleDateString(),
                      getTargetDate(item)?.toLocaleDateString()
                    ]
                      .filter(Boolean)
                      .join('  →  ') || '—'
                  }
                />
              )}
              {tags.length > 0 && (
                <MetadataRow
                  label="Tags"
                  value={
                    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                      {tags.map((t) => (
                        <Chip key={t} label={t} size="small" sx={{ height: 20 }} />
                      ))}
                    </Stack>
                  }
                />
              )}
              {created && (
                <MetadataRow
                  label="Created"
                  value={
                    <Tooltip title={created.toLocaleString()}>
                      <span>{relativeTime(created)}</span>
                    </Tooltip>
                  }
                />
              )}
              {changed && (
                <MetadataRow
                  label="Changed"
                  value={
                    <Tooltip title={changed.toLocaleString()}>
                      <span>{relativeTime(changed)}</span>
                    </Tooltip>
                  }
                />
              )}
            </Stack>

            {descriptionHtml && (
              <Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}
                >
                  Description
                </Typography>
                <Box
                  sx={{
                    mt: 0.5,
                    p: 1.5,
                    bgcolor: 'action.hover',
                    borderRadius: 1,
                    maxHeight: 360,
                    overflow: 'auto'
                  }}
                >
                  <RichDescription html={descriptionHtml} />
                </Box>
              </Box>
            )}

            <Box>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}
              >
                Related items
              </Typography>
              <Stack spacing={1.5} sx={{ mt: 0.5 }}>
                {RELATION_GROUPS.map((group) => {
                  const rs = group.rels.flatMap((r) => groupedRelations.get(r) ?? [])
                  return (
                    <Box key={group.id}>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                        <Typography variant="caption" sx={{ fontWeight: 600 }}>
                          {group.label}
                        </Typography>
                        <Chip
                          size="small"
                          label={rs.length}
                          variant="outlined"
                          sx={{ height: 18, '& .MuiChip-label': { px: 0.75, fontSize: 10 } }}
                        />
                      </Stack>
                      {rs.length === 0 ? (
                        <Typography
                          variant="caption"
                          color="text.disabled"
                          sx={{ pl: 1, display: 'block' }}
                        >
                          {group.empty}
                        </Typography>
                      ) : (
                        <Stack spacing={0.75}>
                          {rs.map((r) => {
                            const targetId = relationTargetId(r.url)
                            if (targetId == null) return null
                            const target = titleById.get(targetId)
                            return (
                              <RelationRow
                                key={`${group.id}:${targetId}`}
                                targetId={targetId}
                                rel={r.rel}
                                title={target ? getTitle(target) : undefined}
                                type={target ? getType(target) : undefined}
                                state={target ? getState(target) : undefined}
                                assignee={target ? getAssigneeName(target) : undefined}
                                inWorkspace={!!target}
                                onClick={() => dispatch(selectWorkItem(targetId))}
                              />
                            )
                          })}
                        </Stack>
                      )}
                    </Box>
                  )
                })}
              </Stack>
            </Box>
          </Stack>
        )}

        {item && tab === 'edit' && (
          <Stack spacing={2}>
            <TextField
              select
              label="State"
              size="small"
              value={stateValue}
              onChange={(e) => setStateValue(e.target.value)}
              SelectProps={{ native: true }}
            >
              {stateOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              {!stateOptions.includes(stateValue) && stateValue && (
                <option value={stateValue}>{stateValue}</option>
              )}
            </TextField>

            <Autocomplete
              options={membersQ.data?.map((m) => m.identity) ?? []}
              getOptionLabel={(opt) => opt.displayName}
              isOptionEqualToValue={(a, b) =>
                (a.uniqueName ?? a.id ?? '') === (b.uniqueName ?? b.id ?? '')
              }
              value={assignee}
              onChange={(_e, value) => setAssignee(value)}
              disabled={!teamId}
              renderInput={(params) => (
                <TextField
                  {...params}
                  size="small"
                  label={
                    teamId
                      ? membersQ.isLoading
                        ? 'Loading members…'
                        : 'Assigned to'
                      : 'Assigned to (select a team to enable picker)'
                  }
                />
              )}
            />

            <Stack direction="row" spacing={2}>
              <TextField
                label="Start date"
                type="date"
                size="small"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                fullWidth
              />
              <TextField
                label="Target date"
                type="date"
                size="small"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                fullWidth
              />
            </Stack>

            {patchState.error != null && (
              <Alert severity="error">
                {(patchState.error as { data?: { message?: string } }).data?.message ??
                  'Update failed.'}
              </Alert>
            )}

            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button onClick={close}>Cancel</Button>
              <Button
                variant="contained"
                disabled={!dirty || patchState.isLoading}
                onClick={save}
                startIcon={
                  patchState.isLoading ? <CircularProgress size={16} /> : undefined
                }
              >
                Save changes
              </Button>
            </Stack>
          </Stack>
        )}
      </Box>
    </Drawer>
  )
}
