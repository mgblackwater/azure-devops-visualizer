import { forwardRef, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  InputAdornment,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
  type PaperProps
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import CloseIcon from '@mui/icons-material/Close'
import HistoryIcon from '@mui/icons-material/History'
import LocalOfferIcon from '@mui/icons-material/LocalOffer'
import PersonOutlineIcon from '@mui/icons-material/PersonOutline'
import FilterListIcon from '@mui/icons-material/FilterList'
import { useNavigate } from 'react-router-dom'
import { useAppDispatch, useAppSelector } from '@/store'
import { selectWorkItem, setSource } from '@/store/workspaceSlice'
import {
  clearRecent,
  enrichRecent,
  pushRecent,
  removeRecent
} from '@/store/recentSearchesSlice'
import {
  useBatchGetWorkItemsQuery,
  useRunWiqlQuery
} from '@/store/api/adoApi'
import { buildSearchWiql, buildSubtreeWiql } from '@/utils/wiql'
import {
  getAssigneeName,
  getState,
  getTags,
  getTitle,
  getType,
  typeBadge
} from '@/utils/workItemFields'
import { colorForState, colorForType, readableTextColor } from '@/utils/adoColors'

/** Parse "1234", "1234, 5678", or "1234 5678" into a list of unique ids. */
function parseIds(input: string): number[] {
  const parts = input.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
  const ids = new Set<number>()
  for (const p of parts) {
    const n = Number(p)
    if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) ids.add(n)
  }
  return [...ids]
}

/** Returns true when every non-whitespace char is a digit, comma, or space. */
function isPureIdInput(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed) return false
  return /^[\d,\s]+$/.test(trimmed) && parseIds(trimmed).length > 0
}

/**
 * The dropdown lives in two modes:
 *  - "recent": shows the user's previously-opened items (no text query).
 *  - "match":  shows live ADO search hits (text query active).
 * Discriminated by `kind` so the renderer can tailor each row.
 */
type SearchOption =
  | {
      kind: 'recent'
      id: number
      title?: string
      type?: string
      ts: number
    }
  | {
      kind: 'match'
      id: number
      title: string
      type: string
      state: string
      assignee: string
      tags: string[]
    }

const TEXT_SEARCH_MIN_LENGTH = 2
const TEXT_SEARCH_DEBOUNCE_MS = 350
const TEXT_SEARCH_RESULT_LIMIT = 30

/**
 * Canonical work-item types offered in the type filter. We deliberately
 * hard-code the common set rather than fetching the project's process
 * because (a) it keeps the filter immediately usable on first render and
 * (b) ADO process types vary by template — this list covers Agile, Scrum,
 * CMMI and Basic. Items whose type isn't in the list are still searchable
 * via the inline `type:` token.
 */
const TYPE_FILTER_OPTIONS: ReadonlyArray<string> = [
  'Epic',
  'Feature',
  'Product Backlog Item',
  'User Story',
  'Bug',
  'Defect',
  'Issue',
  'Task',
  'Test Case'
]

export default function WorkItemSearchBox(): JSX.Element {
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)
  const dispatch = useAppDispatch()
  const navigate = useNavigate()

  const projectId = useAppSelector((s) => s.workspace.projectId)
  const recents = useAppSelector((s) =>
    projectId ? s.recentSearches.byProject[projectId] ?? [] : []
  )

  // Type-filter state. Empty array means "any type". We expose a small
  // chip + popover so the user can constrain both the live search and the
  // recents view without having to remember the `type:` token syntax.
  const [selectedTypes, setSelectedTypes] = useState<string[]>([])
  const [typeMenuAnchor, setTypeMenuAnchor] = useState<HTMLElement | null>(null)
  const typeChipRef = useRef<HTMLDivElement | null>(null)
  const typeFilterActive = selectedTypes.length > 0

  const trimmed = value.trim()
  const ids = parseIds(value)
  const valid = ids.length > 0
  // Numeric input keeps the original "open by id" path; only text input
  // triggers the live ADO search.
  const isIdInput = isPureIdInput(trimmed)
  const textQuery = isIdInput ? '' : trimmed
  // We allow type-only searches: if the user has picked one or more types
  // but typed nothing, fall back to "show recently changed items of those
  // types" so the dropdown doesn't sit empty.
  const isTextMode =
    textQuery.length >= TEXT_SEARCH_MIN_LENGTH ||
    (typeFilterActive && !isIdInput && !valid)

  // Debounce the live search so we don't fire a WIQL on every keystroke.
  // We only commit to a search after TEXT_SEARCH_DEBOUNCE_MS of quiet typing.
  // Toggling the type filter, on the other hand, *does* re-fire immediately
  // (no debounce) — there's no per-keystroke storm to coalesce there.
  const [debouncedTextQuery, setDebouncedTextQuery] = useState('')
  useEffect(() => {
    if (!isTextMode) {
      setDebouncedTextQuery('')
      return
    }
    const t = setTimeout(() => setDebouncedTextQuery(textQuery), TEXT_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [textQuery, isTextMode])

  // Lazy-fetch titles/types for any recent items that don't have them yet,
  // so the dropdown shows meaningful labels even after a fresh app launch.
  const unenrichedIds = useMemo(
    () => recents.filter((r) => !r.title).map((r) => r.id),
    [recents]
  )

  const enrichQ = useBatchGetWorkItemsQuery(
    projectId && unenrichedIds.length > 0
      ? {
          projectId,
          ids: unenrichedIds,
          fields: ['System.Id', 'System.Title', 'System.WorkItemType']
        }
      : (undefined as never),
    { skip: !projectId || unenrichedIds.length === 0 }
  )

  useEffect(() => {
    if (!projectId || !enrichQ.data) return
    for (const w of enrichQ.data) {
      dispatch(
        enrichRecent({
          projectId,
          id: w.id,
          title: getTitle(w) || undefined,
          type: getType(w) || undefined
        })
      )
    }
  }, [enrichQ.data, projectId, dispatch])

  // ----- Live text search via WIQL -----
  // Step 1: query work-item ids matching the user's text against title/tags/
  // assignee in the configured project, restricted to the selected types
  // (if any). When the user has only picked types and not typed any text,
  // we still issue the search so they can browse recently-changed items
  // of those types.
  const searchWiql = useMemo(() => {
    if (!isTextMode) return ''
    return buildSearchWiql(debouncedTextQuery, {
      top: TEXT_SEARCH_RESULT_LIMIT,
      types: selectedTypes
    })
  }, [debouncedTextQuery, selectedTypes, isTextMode])
  const searchQ = useRunWiqlQuery(
    projectId && searchWiql ? { projectId, wiql: searchWiql, top: TEXT_SEARCH_RESULT_LIMIT } : (undefined as never),
    { skip: !projectId || !searchWiql }
  )

  // Step 2: hydrate the matched ids with the fields we need for the dropdown.
  const matchIds = useMemo(
    () =>
      (searchQ.data?.workItems ?? [])
        .slice(0, TEXT_SEARCH_RESULT_LIMIT)
        .map((w) => w.id),
    [searchQ.data]
  )
  const matchHydratedQ = useBatchGetWorkItemsQuery(
    projectId && matchIds.length > 0
      ? {
          projectId,
          ids: matchIds,
          fields: [
            'System.Id',
            'System.Title',
            'System.WorkItemType',
            'System.State',
            'System.AssignedTo',
            'System.Tags'
          ]
        }
      : (undefined as never),
    { skip: !projectId || matchIds.length === 0 }
  )

  // The list shown in the dropdown is mode-dependent: text → matches,
  // otherwise → recents. We deliberately don't merge the two so the user
  // always knows what they're looking at. Type filter is applied in both
  // modes for consistency.
  const typeSet = useMemo(
    () => new Set(selectedTypes.map((t) => t.toLowerCase())),
    [selectedTypes]
  )
  const options: SearchOption[] = useMemo(() => {
    if (isTextMode) {
      const data = matchHydratedQ.data
      if (!data) return []
      // Preserve ADO's recently-changed-first ordering from the WIQL.
      const order = new Map<number, number>()
      matchIds.forEach((id, idx) => order.set(id, idx))
      return data
        .slice()
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
        .map<SearchOption>((w) => ({
          kind: 'match',
          id: w.id,
          title: getTitle(w),
          type: getType(w),
          state: getState(w),
          assignee: getAssigneeName(w),
          tags: getTags(w)
        }))
    }
    return recents
      .filter((r) => {
        if (!typeFilterActive) return true
        // Type may be missing on un-enriched recents — keep them visible
        // so the user can still navigate, the type will fill in shortly
        // via the enrichment query.
        if (!r.type) return true
        return typeSet.has(r.type.toLowerCase())
      })
      .map<SearchOption>((r) => ({ kind: 'recent', ...r }))
  }, [isTextMode, matchHydratedQ.data, matchIds, recents, typeFilterActive, typeSet])

  // Text mode is "loading" any time we have a query in flight or are still
  // waiting on the debounce window.
  const searchLoading =
    isTextMode &&
    (debouncedTextQuery !== textQuery ||
      searchQ.isFetching ||
      matchHydratedQ.isFetching)

  function remember(idsToRemember: number[]): void {
    if (!projectId) return
    for (const id of idsToRemember) {
      dispatch(pushRecent({ projectId, id }))
    }
  }

  function openInDrawer(idsArg: number[] = ids): void {
    if (idsArg.length === 0) return
    dispatch(selectWorkItem(idsArg[0]))
    remember([idsArg[0]])
    setValue('')
    setOpen(false)
  }

  function loadAsSet(idsArg: number[] = ids): void {
    if (idsArg.length === 0) return
    const list = idsArg.join(', ')
    dispatch(
      setSource({
        kind: 'wiql',
        wiql: `SELECT [System.Id] FROM WorkItems WHERE [System.Id] IN (${list})`,
        label: `IDs: ${list}`
      })
    )
    remember(idsArg)
    setValue('')
    setOpen(false)
    // If no project is selected we can't render the visualisations, so
    // the user is sent to the workspace page to pick one. Otherwise jump
    // straight to the visualisations so the freshly-loaded set is visible.
    navigate(projectId ? '/visualize' : '/workspace')
  }

  function loadAsSubtree(idsArg: number[] = ids): void {
    if (idsArg.length === 0) return
    dispatch(
      setSource({
        kind: 'wiql',
        wiql: buildSubtreeWiql(idsArg[0]),
        label: `Subtree of #${idsArg[0]}`
      })
    )
    remember([idsArg[0]])
    setValue('')
    setOpen(false)
    navigate(projectId ? '/visualize' : '/workspace')
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key !== 'Enter') return
    if (!valid) return
    // Stop Autocomplete from also acting on Enter (creating a free-solo entry).
    e.preventDefault()
    e.stopPropagation()
    if (e.shiftKey) loadAsSubtree()
    else openInDrawer()
  }

  // Custom popper Paper so we can pin a "Clear history" footer beneath the
  // option list. onMouseDown.preventDefault keeps the input focused so the
  // popper doesn't close before the click handler runs.
  function PopperPaper(props: PaperProps): JSX.Element {
    return (
      <Paper {...props}>
        {props.children}
        {recents.length > 0 && (
          <Box
            sx={{
              borderTop: '1px solid',
              borderColor: 'divider',
              px: 1,
              py: 0.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
          >
            <Typography variant="caption" color="text.secondary">
              {recents.length} recent
            </Typography>
            <Button
              size="small"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (projectId) dispatch(clearRecent({ projectId }))
              }}
            >
              Clear history
            </Button>
          </Box>
        )}
      </Paper>
    )
  }

  const noOptionsText = isTextMode
    ? searchLoading
      ? 'Searching Azure DevOps…'
      : `No items match "${textQuery}"`
    : trimmed
      ? 'No matches in history'
      : 'No recent searches'

  function toggleType(t: string): void {
    setSelectedTypes((cur) =>
      cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]
    )
  }

  return (
    <>
    <Autocomplete<SearchOption, false, false, true>
      freeSolo
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      options={options}
      loading={searchLoading}
      // Server-side filtering for matches (ADO already filtered them);
      // for the recents list, keep client-side filter so the user can
      // narrow within their history without hitting the network.
      filterOptions={(opts, state) => {
        if (isTextMode) return opts
        const q = state.inputValue.trim().toLowerCase()
        if (!q) return opts
        return opts.filter(
          (o) =>
            String(o.id).includes(q) ||
            (o.title?.toLowerCase().includes(q) ?? false)
        )
      }}
      groupBy={(opt) => (opt.kind === 'match' ? 'Matches' : 'Recent')}
      getOptionLabel={(opt) =>
        typeof opt === 'string' ? opt : String(opt.id)
      }
      isOptionEqualToValue={(a, b) => a.id === b.id}
      inputValue={value}
      onInputChange={(_e, v, reason) => {
        if (reason === 'reset') return
        setValue(v)
      }}
      value={null}
      onChange={(_e, v) => {
        if (v && typeof v === 'object') openInDrawer([v.id])
      }}
      noOptionsText={noOptionsText}
      sx={{ width: 380 }}
      PaperComponent={PopperPaper}
      slotProps={{
        listbox: { sx: { maxHeight: 380, py: 0 } }
      }}
      renderOption={(liProps, option) => {
        const { key, ...rest } = liProps as typeof liProps & { key?: React.Key }
        return (
          <Box
            component="li"
            key={key ?? `${option.kind}:${option.id}`}
            {...rest}
            sx={{ display: 'block', py: 0.75, px: 1.25 }}
          >
            {option.kind === 'match' ? (
              <SearchMatchRow option={option} highlight={textQuery} />
            ) : (
              <RecentRow
                option={option}
                onRemove={() => {
                  if (projectId) {
                    dispatch(removeRecent({ projectId, id: option.id }))
                  }
                }}
              />
            )}
          </Box>
        )
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          size="small"
          placeholder='Search by id, title, tag:critical, @bob…'
          onKeyDown={onKeyDown}
          slotProps={{
            input: {
              ...params.InputProps,
              startAdornment: (
                <InputAdornment position="start" sx={{ gap: 0.5 }}>
                  <SearchIcon fontSize="small" />
                  <TypeFilterChip
                    ref={typeChipRef}
                    selected={selectedTypes}
                    onClick={() => setTypeMenuAnchor(typeChipRef.current)}
                  />
                </InputAdornment>
              ),
              endAdornment: (
                <>
                  {searchLoading && (
                    <CircularProgress size={14} sx={{ mr: 0.5 }} />
                  )}
                  {valid && (
                    <>
                      <Tooltip title="Open in drawer (Enter)">
                        <span>
                          <IconButton
                            size="small"
                            onClick={() => openInDrawer()}
                          >
                            <OpenInNewIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip
                        title={
                          ids.length === 1
                            ? 'Focus on this subtree (Shift+Enter)'
                            : `Load these ${ids.length} items`
                        }
                      >
                        <span>
                          <IconButton
                            size="small"
                            onClick={() =>
                              ids.length === 1 ? loadAsSubtree() : loadAsSet()
                            }
                          >
                            <AccountTreeIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </>
                  )}
                  {!valid && !isTextMode && recents.length > 0 && (
                    <Tooltip title="Recent searches">
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => setOpen((o) => !o)}
                        >
                          <HistoryIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  )}
                  {params.InputProps.endAdornment}
                </>
              )
            }
          }}
        />
      )}
    />
    <Menu
      anchorEl={typeMenuAnchor}
      open={!!typeMenuAnchor}
      onClose={() => setTypeMenuAnchor(null)}
      // Don't auto-focus the first menu item — that visual jump from the
      // input into the menu is jarring for what is essentially a chip
      // press; the user can still keyboard-navigate with arrow keys.
      autoFocus={false}
      slotProps={{ paper: { sx: { minWidth: 220 } } }}
    >
      <Box sx={{ px: 1.5, py: 0.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
          Filter by type
        </Typography>
        {typeFilterActive && (
          <Button
            size="small"
            sx={{ minWidth: 0, fontSize: 11, py: 0 }}
            onClick={() => setSelectedTypes([])}
          >
            Clear
          </Button>
        )}
      </Box>
      <Divider />
      {TYPE_FILTER_OPTIONS.map((t) => {
        const checked = selectedTypes.includes(t)
        const color = colorForType(t)
        return (
          <MenuItem key={t} dense onClick={() => toggleType(t)}>
            <Checkbox size="small" checked={checked} sx={{ p: 0.5, mr: 1 }} />
            <Chip
              size="small"
              label={typeBadge(t)}
              sx={{
                bgcolor: color,
                color: readableTextColor(color),
                height: 18,
                minWidth: 32,
                mr: 1,
                '& .MuiChip-label': {
                  px: 0.5,
                  fontSize: 10,
                  fontWeight: 700
                }
              }}
            />
            <ListItemText primary={t} primaryTypographyProps={{ fontSize: 13 }} />
          </MenuItem>
        )
      })}
    </Menu>
    </>
  )
}

interface RecentRowProps {
  option: Extract<SearchOption, { kind: 'recent' }>
  onRemove: () => void
}

function RecentRow({ option, onRemove }: RecentRowProps): JSX.Element {
  const typeColor = colorForType(option.type)
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Chip
        size="small"
        label={typeBadge(option.type)}
        sx={{
          bgcolor: typeColor,
          color: readableTextColor(typeColor),
          height: 20,
          minWidth: 36,
          '& .MuiChip-label': {
            px: 0.75,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.3
          }
        }}
      />
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ minWidth: 56, fontVariantNumeric: 'tabular-nums' }}
      >
        #{option.id}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          flex: 1,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          fontStyle: option.title ? 'normal' : 'italic',
          color: option.title ? 'text.primary' : 'text.secondary'
        }}
      >
        {option.title ?? 'Loading…'}
      </Typography>
      <Tooltip title="Remove from history">
        <IconButton
          size="small"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          sx={{ ml: 0.5 }}
        >
          <CloseIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
    </Stack>
  )
}

interface SearchMatchRowProps {
  option: Extract<SearchOption, { kind: 'match' }>
  highlight: string
}

function SearchMatchRow({ option, highlight }: SearchMatchRowProps): JSX.Element {
  const typeColor = colorForType(option.type)
  const stateColor = colorForState(option.state)
  const stateText = readableTextColor(stateColor)
  return (
    <Stack spacing={0.5}>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
        <Chip
          size="small"
          label={typeBadge(option.type)}
          sx={{
            bgcolor: typeColor,
            color: readableTextColor(typeColor),
            height: 20,
            minWidth: 36,
            '& .MuiChip-label': {
              px: 0.75,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.3
            }
          }}
        />
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}
        >
          #{option.id}
        </Typography>
        <Chip
          size="small"
          label={option.state}
          sx={{
            bgcolor: stateColor,
            color: stateText,
            height: 20,
            fontWeight: 600,
            '& .MuiChip-label': { px: 0.75, fontSize: 10 }
          }}
        />
      </Stack>
      <Typography
        variant="body2"
        sx={{
          fontWeight: 500,
          lineHeight: 1.3,
          // Two-line clamp keeps long titles readable without forcing the
          // dropdown to scroll horizontally.
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden'
        }}
      >
        <HighlightedText text={option.title} term={highlight} />
      </Typography>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{ flexWrap: 'wrap', rowGap: 0.25 }}
      >
        {option.assignee && option.assignee !== 'Unassigned' && (
          <Stack direction="row" spacing={0.25} alignItems="center">
            <PersonOutlineIcon sx={{ fontSize: 12, color: 'text.secondary' }} />
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11 }}>
              {option.assignee}
            </Typography>
          </Stack>
        )}
        {option.tags.length > 0 && (
          <Stack direction="row" spacing={0.25} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 0.25 }}>
            <LocalOfferIcon sx={{ fontSize: 11, color: 'text.secondary' }} />
            {option.tags.slice(0, 4).map((tag) => (
              <Chip
                key={tag}
                size="small"
                label={tag}
                variant="outlined"
                sx={{
                  height: 16,
                  '& .MuiChip-label': { px: 0.5, fontSize: 10 }
                }}
              />
            ))}
            {option.tags.length > 4 && (
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                +{option.tags.length - 4}
              </Typography>
            )}
          </Stack>
        )}
      </Stack>
    </Stack>
  )
}

/**
 * Splits `text` around case-insensitive occurrences of `term` and renders
 * matched segments inside <mark> for visual emphasis. Falls back to plain
 * text if `term` is empty so we don't pay the regex cost for recent rows.
 */
function HighlightedText({
  text,
  term
}: {
  text: string
  term: string
}): JSX.Element {
  const trimmedTerm = term.trim()
  if (!trimmedTerm) return <>{text}</>
  const parts: Array<{ text: string; match: boolean }> = []
  const lcText = text.toLowerCase()
  const lcTerm = trimmedTerm.toLowerCase()
  let cursor = 0
  while (cursor < text.length) {
    const idx = lcText.indexOf(lcTerm, cursor)
    if (idx === -1) {
      parts.push({ text: text.slice(cursor), match: false })
      break
    }
    if (idx > cursor) parts.push({ text: text.slice(cursor, idx), match: false })
    parts.push({ text: text.slice(idx, idx + trimmedTerm.length), match: true })
    cursor = idx + trimmedTerm.length
  }
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <Box
            component="mark"
            key={i}
            sx={{
              bgcolor: 'rgba(255,235,59,0.55)',
              color: 'inherit',
              px: 0.25,
              borderRadius: 0.5
            }}
          >
            {p.text}
          </Box>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  )
}

interface TypeFilterChipProps {
  selected: string[]
  onClick: () => void
}

/**
 * Inline pill that lives inside the search input's start adornment and
 * acts as the trigger for the type-filter Menu.
 *
 * The label compresses depending on how many types the user has picked:
 *   - 0 selected → just the funnel icon, "Any type" tooltip
 *   - 1 selected → short badge (PBI / BUG / …)
 *   - n selected → first badge + "+N"
 */
const TypeFilterChip = forwardRef<HTMLDivElement, TypeFilterChipProps>(
  function TypeFilterChip({ selected, onClick }, ref) {
    const active = selected.length > 0
    const firstBadge = active ? typeBadge(selected[0]) : ''
    const moreCount = selected.length - 1
    const label = !active
      ? 'Any type'
      : moreCount > 0
        ? `${firstBadge} +${moreCount}`
        : firstBadge
    const tooltip = active ? `Type: ${selected.join(', ')}` : 'Filter by type'
    return (
      <Tooltip title={tooltip}>
        <Chip
          ref={ref}
          size="small"
          icon={<FilterListIcon sx={{ fontSize: 14 }} />}
          label={label}
          onClick={onClick}
          // Stop the input from losing focus when the chip is clicked,
          // so the dropdown doesn't close out from under the user.
          onMouseDown={(e) => e.preventDefault()}
          variant={active ? 'filled' : 'outlined'}
          color={active ? 'primary' : 'default'}
          sx={{
            height: 22,
            cursor: 'pointer',
            '& .MuiChip-label': { px: 0.75, fontSize: 11, fontWeight: 600 },
            '& .MuiChip-icon': { ml: 0.5, mr: -0.25 }
          }}
        />
      </Tooltip>
    )
  }
)
