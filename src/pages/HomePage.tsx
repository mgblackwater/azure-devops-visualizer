import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  IconButton,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import AssignmentIndIcon from '@mui/icons-material/AssignmentInd'
import AlternateEmailIcon from '@mui/icons-material/AlternateEmail'
import CallSplitIcon from '@mui/icons-material/CallSplit'
import RefreshIcon from '@mui/icons-material/Refresh'
import {
  useBatchGetWorkItemsQuery,
  useGetConnectionQuery,
  useGetLatestMentionsQuery,
  useListProjectsQuery,
  useRunWiqlQuery
} from '@/store/api/adoApi'
import { useAppDispatch, useAppSelector } from '@/store'
import {
  selectWorkItem,
  setGroupBy,
  setProject
} from '@/store/workspaceSlice'
import {
  clearDefaultProject,
  selectDefaultProjectId,
  setDefaultProject
} from '@/store/preferencesSlice'
import { selectFavorites } from '@/store/favoritesSlice'
import WorkItemListRow from '@/components/workItem/WorkItemListRow'
import FavoritesTab from '@/components/favorites/FavoritesTab'
import PullRequestsList from '@/components/pullRequests/PullRequestsList'
import {
  buildAssignedToMeWiql,
  buildMentionsMeWiql,
  normalizeMentionName
} from '@/utils/wiql'
import { getChangedDate } from '@/utils/workItemFields'

type MyWorkTab = 'assigned' | 'mentions' | 'favorites' | 'pullRequests'

const VALID_TABS: readonly MyWorkTab[] = [
  'assigned',
  'mentions',
  'favorites',
  'pullRequests'
]

/**
 * Read the active tab from the URL's `?tab=` parameter when present —
 * powers deep-links from the tray menu and notification clicks
 * (`'open-target'` payload). Falls back to `'assigned'` when missing
 * or invalid so a hand-typed `/home?tab=garbage` doesn't crash the
 * Tabs component.
 */
function tabFromSearch(search: string): MyWorkTab | null {
  const params = new URLSearchParams(search)
  const raw = params.get('tab')
  if (!raw) return null
  return (VALID_TABS as readonly string[]).includes(raw)
    ? (raw as MyWorkTab)
    : null
}

const MY_WORK_FIELDS = [
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.AssignedTo',
  'System.Tags',
  'System.ChangedDate'
] as const

const MY_WORK_LIMIT = 100

export default function HomePage(): JSX.Element {
  const dispatch = useAppDispatch()
  const { projectId, groupBy } = useAppSelector((s) => s.workspace)
  const connectionQ = useGetConnectionQuery()
  const connection = connectionQ.data
  const orgUrl = connection?.organizationUrl
  const me = connection?.authenticatedUser
  const defaultProjectId = useAppSelector((s) =>
    selectDefaultProjectId(s, orgUrl)
  )

  /**
   * One-shot refetch: when the user has a connection but no resolved
   * identity yet, give the main process a chance to backfill it lazily.
   * The first IPC call already triggers the backfill server-side, but
   * the renderer caches the result — so we explicitly refetch once to
   * pick up the freshly persisted identity. The ref guards against an
   * infinite loop if the server can't resolve identity at all.
   */
  const identityRefetchTried = useRef(false)
  useEffect(() => {
    if (identityRefetchTried.current) return
    if (!connection) return
    if (!connection.hasToken) return
    if (connection.authenticatedUser?.displayName) return
    identityRefetchTried.current = true
    void connectionQ.refetch()
  }, [connection, connectionQ])

  const projectsQ = useListProjectsQuery()

  const isDefault = !!projectId && projectId === defaultProjectId

  function togglePin(): void {
    if (!orgUrl || !projectId) return
    if (isDefault) {
      dispatch(clearDefaultProject({ organizationUrl: orgUrl }))
    } else {
      dispatch(setDefaultProject({ organizationUrl: orgUrl, projectId }))
    }
  }

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box sx={{ p: 3, pb: 2 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Home
        </Typography>

        {/*
         * Project is the only mandatory selection on this page — every
         * other view (Visualize, Sprint, Mentions, Assigned-to-me) keys
         * off it. Team selection moved to the Sprint view since it's
         * only needed there (iterations are team-scoped). Grouping is
         * a soft preference that survives in the snapshot for users
         * who have one.
         */}
        <Paper
          sx={{
            p: 2,
            border: !projectId ? '1px solid' : undefined,
            borderColor: !projectId ? 'primary.main' : undefined
          }}
        >
          <Stack spacing={1.25}>
            {!projectId && (
              <Typography
                variant="body2"
                color="primary"
                sx={{ fontWeight: 600 }}
              >
                Pick a project to get started — every view below depends
                on it.
              </Typography>
            )}
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={1.5}
              alignItems={{ xs: 'stretch', md: 'center' }}
            >
              {projectsQ.isLoading && (
                <Stack direction="row" alignItems="center" spacing={1}>
                  <CircularProgress size={14} />
                  <Typography variant="body2" color="text.secondary">
                    Loading projects…
                  </Typography>
                </Stack>
              )}
              {projectsQ.error != null && (
                <Alert severity="error" sx={{ flex: 1 }}>
                  Failed to load projects.
                </Alert>
              )}

              <Stack
                direction="row"
                spacing={0.5}
                alignItems="center"
                sx={{ flex: '1 1 320px', minWidth: 240 }}
              >
                <Autocomplete
                  fullWidth
                  size="small"
                  options={projectsQ.data ?? []}
                  getOptionLabel={(opt) => opt.name}
                  value={
                    projectsQ.data?.find((p) => p.id === projectId) ?? null
                  }
                  onChange={(_e, value) =>
                    dispatch(
                      setProject(
                        value ? { id: value.id, name: value.name } : null
                      )
                    )
                  }
                  renderOption={(liProps, option) => {
                    const { key, ...rest } = liProps as typeof liProps & {
                      key?: React.Key
                    }
                    const pinned = option.id === defaultProjectId
                    return (
                      <li
                        key={key ?? option.id}
                        {...rest}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8
                        }}
                      >
                        {pinned ? (
                          <StarIcon
                            sx={{ fontSize: 16, color: 'warning.main' }}
                          />
                        ) : (
                          <Box sx={{ width: 16 }} />
                        )}
                        <span>{option.name}</span>
                      </li>
                    )
                  }}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Project (required)"
                      size="small"
                      required
                      // Highlight the input until something is picked so
                      // users understand the rest of the app is gated
                      // on this selection.
                      error={!projectId && !projectsQ.isLoading}
                    />
                  )}
                />
                <Tooltip
                  title={
                    !projectId
                      ? 'Pick a project first'
                      : isDefault
                        ? 'Default for this organization — click to unpin'
                        : 'Pin as default for this organization'
                  }
                >
                  <span>
                    <IconButton
                      size="small"
                      onClick={togglePin}
                      disabled={!projectId || !orgUrl}
                      color={isDefault ? 'warning' : 'default'}
                    >
                      {isDefault ? <StarIcon /> : <StarBorderIcon />}
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>

              <FormControl
                size="small"
                sx={{ flex: '0 1 220px', minWidth: 180 }}
              >
                <InputLabel id="groupby-label">Default grouping</InputLabel>
                <Select
                  labelId="groupby-label"
                  label="Default grouping"
                  value={groupBy}
                  onChange={(e) =>
                    dispatch(setGroupBy(e.target.value as typeof groupBy))
                  }
                >
                  <MenuItem value="iteration">Iteration</MenuItem>
                  <MenuItem value="assignee">Assignee</MenuItem>
                  <MenuItem value="state">State</MenuItem>
                  <MenuItem value="type">Type</MenuItem>
                  <MenuItem value="none">None</MenuItem>
                </Select>
              </FormControl>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Team selection lives in the Sprint view (iterations are
              team-scoped). Other views work with project alone.
            </Typography>
          </Stack>
        </Paper>
      </Box>

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          px: 3,
          pb: 3,
          gap: 2,
          overflow: 'auto'
        }}
      >
        <Paper
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 360,
            overflow: 'hidden'
          }}
        >
          <MyWorkPanel
            projectId={projectId}
            orgUrl={orgUrl}
            displayName={me?.displayName}
            currentUserId={me?.id}
            identityLoading={connectionQ.isFetching}
            onRefetchIdentity={() => void connectionQ.refetch()}
            onOpen={(id) => dispatch(selectWorkItem(id))}
          />
        </Paper>
      </Box>
    </Box>
  )
}

/**
 * The "My work" tabbed list. Owns its own active-tab state and runs each
 * tab's WIQL only when it's the active one — so switching tabs the first
 * time triggers a fresh fetch but switching back uses the cached result.
 *
 * The Favorites tab is project-independent (favorites span an org), so
 * it bypasses the "pick a project first" gate that the other two tabs
 * sit behind.
 */
function MyWorkPanel({
  projectId,
  orgUrl,
  displayName,
  currentUserId,
  identityLoading,
  onRefetchIdentity,
  onOpen
}: {
  projectId: string | null
  orgUrl: string | undefined
  displayName: string | undefined
  currentUserId: string | undefined
  identityLoading: boolean
  onRefetchIdentity: () => void
  onOpen: (id: number) => void
}): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  // Tab is URL-driven so the `?tab=...` deep-link from the tray menu /
  // notification click lands on the right pane. Local clicks update
  // both the URL and component state via `setTab` so the back button
  // walks tab history naturally.
  const urlTab = tabFromSearch(location.search)
  const [tab, setTabState] = useState<MyWorkTab>(urlTab ?? 'assigned')
  useEffect(() => {
    if (urlTab && urlTab !== tab) setTabState(urlTab)
    // Intentionally skip `tab` from the deps — URL is the source of
    // truth for cross-window deep-links; user clicks update both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab])

  function setTab(next: MyWorkTab): void {
    setTabState(next)
    const params = new URLSearchParams(location.search)
    if (next === 'assigned') {
      params.delete('tab')
    } else {
      params.set('tab', next)
    }
    const query = params.toString()
    navigate(query ? `${location.pathname}?${query}` : location.pathname, {
      replace: true
    })
  }

  const favoritesCount = useAppSelector(
    (s) => selectFavorites(s, orgUrl).length
  )

  return (
    <>
      <Stack
        direction="row"
        alignItems="center"
        sx={{
          borderBottom: '1px solid',
          borderColor: 'divider',
          pr: 1
        }}
      >
        <Tabs
          value={tab}
          onChange={(_e, v: MyWorkTab) => setTab(v)}
          sx={{
            minHeight: 44,
            flex: 1,
            '& .MuiTab-root': {
              minHeight: 44,
              textTransform: 'none',
              fontWeight: 600
            }
          }}
        >
          <Tab
            value="assigned"
            label="Assigned to me"
            icon={<AssignmentIndIcon fontSize="small" />}
            iconPosition="start"
          />
          <Tab
            value="mentions"
            label="Mentions me"
            icon={<AlternateEmailIcon fontSize="small" />}
            iconPosition="start"
          />
          <Tab
            value="pullRequests"
            label="Pull requests"
            icon={<CallSplitIcon fontSize="small" />}
            iconPosition="start"
          />
          <Tab
            value="favorites"
            icon={<StarIcon fontSize="small" />}
            iconPosition="start"
            label={
              <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                Favorites
                {favoritesCount > 0 && (
                  <Chip
                    size="small"
                    label={favoritesCount}
                    sx={{
                      height: 18,
                      '& .MuiChip-label': { px: 0.75, fontSize: 10 }
                    }}
                  />
                )}
              </Box>
            }
          />
        </Tabs>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'favorites' ? (
          <FavoritesTab />
        ) : !projectId ? (
          <Box sx={{ p: 4, textAlign: 'center' }}>
            <Typography color="text.secondary">
              Pick a project above to see your work.
            </Typography>
          </Box>
        ) : tab === 'assigned' ? (
          <MyWorkList
            projectId={projectId}
            wiql={buildAssignedToMeWiql(MY_WORK_LIMIT)}
            onOpen={onOpen}
            emptyText="Nothing is assigned to you in this project."
          />
        ) : tab === 'pullRequests' ? (
          <PullRequestsList
            projectId={projectId}
            orgUrl={orgUrl}
            currentUserId={currentUserId}
            // Phase 2 will switch this to opening the in-app PR detail
            // drawer; for phase 1 the row click already routes through
            // shell.openExternal inside the component.
            onOpen={() => undefined}
          />
        ) : (
          <MentionsList
            projectId={projectId}
            displayName={displayName}
            identityLoading={identityLoading}
            onRefetchIdentity={onRefetchIdentity}
            onOpen={onOpen}
          />
        )}
      </Box>
    </>
  )
}

/**
 * Wrapper around `MyWorkList` for the Mentions tab — it has the extra
 * concern of needing the user's display name (resolved from the connection
 * query) to build the WIQL, plus a clearer empty-state when the name
 * isn't available yet.
 */
function MentionsList({
  projectId,
  displayName,
  identityLoading,
  onRefetchIdentity,
  onOpen
}: {
  projectId: string
  displayName: string | undefined
  identityLoading: boolean
  onRefetchIdentity: () => void
  onOpen: (id: number) => void
}): JSX.Element {
  /**
   * Two-stage state for the manual fallback so we don't fire a WIQL on
   * every keystroke (an N-character name = N expensive queries, and a
   * single-letter `CONTAINS` floods the dropdown with noise / sometimes
   * trips ADO's search throttle):
   *
   *   - `manualDraft` — bound to the input, free to be partial.
   *   - `submittedName` — only set when the user explicitly commits via
   *     Enter or the Search button. The WIQL builder reads from this.
   */
  const [manualDraft, setManualDraft] = useState('')
  const [submittedName, setSubmittedName] = useState('')
  const effectiveName = displayName ?? submittedName

  function commitDraft(): void {
    const trimmed = manualDraft.trim()
    // Require at least 2 characters so a stray one-char input doesn't
    // produce a WIQL that essentially says "match every comment".
    if (trimmed.length < 2) return
    setSubmittedName(trimmed)
  }

  if (!effectiveName) {
    return (
      <Box sx={{ p: 4, maxWidth: 520, mx: 'auto' }}>
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" spacing={1}>
            {identityLoading && <CircularProgress size={16} />}
            <Typography color="text.secondary">
              {identityLoading
                ? 'Resolving your identity…'
                : "Couldn't resolve your display name from Azure DevOps."}
            </Typography>
          </Stack>
          {!identityLoading && (
            <>
              <Typography variant="caption" color="text.secondary">
                Either Azure DevOps didn't return a profile (some PAT
                scopes block it), or this is a fresh build the main
                process hasn't picked up yet. Try Retry first; if that
                doesn't work, type your display name as it appears in
                ADO comments and press Enter.
              </Typography>
              <Stack direction="row" spacing={1}>
                <TextField
                  size="small"
                  fullWidth
                  placeholder="Your display name (e.g. Jane Doe)"
                  value={manualDraft}
                  onChange={(e) => setManualDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitDraft()
                  }}
                  helperText={
                    manualDraft.trim().length > 0 &&
                    manualDraft.trim().length < 2
                      ? 'Type at least 2 characters'
                      : 'Press Enter or click Search to use this name'
                  }
                />
                <Button
                  variant="contained"
                  size="small"
                  onClick={commitDraft}
                  disabled={manualDraft.trim().length < 2}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  Search
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={onRefetchIdentity}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  Retry
                </Button>
              </Stack>
            </>
          )}
        </Stack>
      </Box>
    )
  }

  return (
    <MyWorkList
      projectId={projectId}
      wiql={buildMentionsMeWiql(effectiveName, MY_WORK_LIMIT)}
      onOpen={onOpen}
      emptyText={`No items mention "${effectiveName}" yet.`}
      noteText={
        displayName
          ? 'Matches when your display name appears in a comment — including @-mentions and replies. Sorted by latest mention.'
          : `Searching with manually entered name "${effectiveName}". Click Retry above to try resolving from Azure DevOps again.`
      }
      // Tell MyWorkList to fetch comment timestamps for each result and
      // re-sort by "latest mention" instead of "last changed". Without
      // this, items where someone edited an unrelated field jump above
      // items where you were actually @-mentioned.
      mentionSearchText={normalizeMentionName(effectiveName)}
    />
  )
}

/**
 * Generic list backed by a WIQL → batch-hydrate pipeline. Used by both
 * tabs; the difference between them is purely the WIQL.
 *
 * When `mentionSearchText` is supplied, the list also fetches each item's
 * comments and re-sorts by *latest comment containing that text*. The
 * row timestamp likewise switches to "mentioned X ago" so the sort is
 * visible at a glance. Items with no matching comment fall back to
 * `ChangedDate` ordering at the bottom of the list — better than
 * dropping them, since they did match the WIQL.
 */
function MyWorkList({
  projectId,
  wiql,
  onOpen,
  emptyText,
  noteText,
  mentionSearchText
}: {
  projectId: string
  wiql: string
  onOpen: (id: number) => void
  emptyText: string
  noteText?: string
  mentionSearchText?: string
}): JSX.Element {
  const wiqlQ = useRunWiqlQuery(
    { projectId, wiql, top: MY_WORK_LIMIT },
    { skip: !projectId }
  )

  const ids = useMemo(
    () => (wiqlQ.data?.workItems ?? []).slice(0, MY_WORK_LIMIT).map((w) => w.id),
    [wiqlQ.data]
  )

  const batchQ = useBatchGetWorkItemsQuery(
    ids.length > 0
      ? { projectId, ids, fields: [...MY_WORK_FIELDS] }
      : (undefined as never),
    { skip: ids.length === 0 }
  )

  // Only fetch mention timestamps when the parent asked for them
  // (i.e. on the Mentions tab). The fan-out is one ADO call per item, so
  // we don't want to do it for "Assigned to me".
  const wantMentions = !!mentionSearchText && ids.length > 0
  const mentionsQ = useGetLatestMentionsQuery(
    wantMentions
      ? { projectId, ids, searchText: mentionSearchText! }
      : (undefined as never),
    { skip: !wantMentions }
  )

  /**
   * Final ordered list. Three modes:
   *   1. No mention sort requested → preserve WIQL `ChangedDate DESC`.
   *   2. Mention sort requested, mention data still loading → preserve
   *      WIQL ordering as a placeholder so the list isn't empty.
   *   3. Mention sort requested, mention data ready → re-rank items by
   *      latest mention timestamp DESC; items with no known mention
   *      timestamp drop to the bottom and keep their relative WIQL order.
   */
  const ordered = useMemo(() => {
    const map = new Map<number, NonNullable<typeof batchQ.data>[number]>()
    for (const w of batchQ.data ?? []) map.set(w.id, w)
    const baseOrder = ids
      .map((id) => map.get(id))
      .filter((w): w is NonNullable<typeof batchQ.data>[number] => !!w)

    if (!wantMentions || !mentionsQ.data) return baseOrder

    const mentionMs = new Map<number, number>()
    for (const [idStr, summary] of Object.entries(mentionsQ.data.byId)) {
      if (!summary) continue
      const ms = Date.parse(summary.date)
      if (Number.isFinite(ms)) mentionMs.set(Number(idStr), ms)
    }

    // Stable sort by mention timestamp DESC; missing → -Infinity so they
    // sink to the bottom. We fall back to the original WIQL order
    // (already ChangedDate DESC) for tie-breaks via the stable sort.
    return [...baseOrder].sort((a, b) => {
      const ma = mentionMs.get(a.id) ?? -Infinity
      const mb = mentionMs.get(b.id) ?? -Infinity
      return mb - ma
    })
  }, [batchQ.data, ids, mentionsQ.data, wantMentions])

  /**
   * Map id → mention summary (Date + snippet + author) for fast row
   * lookup when rendering. We keep both the Date map (for sort/header)
   * and the full summary (for the subtitle preview) here so each row
   * doesn't re-parse the IPC payload on every render.
   */
  const mentionByIdMemo = useMemo(() => {
    const summaries = new Map<
      number,
      { date: Date; snippet: string; author?: string }
    >()
    if (!mentionsQ.data) return summaries
    for (const [idStr, summary] of Object.entries(mentionsQ.data.byId)) {
      if (!summary) continue
      const ms = Date.parse(summary.date)
      if (!Number.isFinite(ms)) continue
      summaries.set(Number(idStr), {
        date: new Date(ms),
        snippet: summary.snippet,
        author: summary.author
      })
    }
    return summaries
  }, [mentionsQ.data])

  const loading = wiqlQ.isFetching || batchQ.isFetching
  const mentionsLoading = wantMentions && mentionsQ.isFetching
  const error =
    (wiqlQ.error as { data?: { message?: string } } | undefined)?.data?.message ??
    (batchQ.error as { data?: { message?: string } } | undefined)?.data?.message

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      {(loading || mentionsLoading) && <LinearProgress />}
      {error && (
        <Alert severity="error" sx={{ m: 2 }}>
          {error}
        </Alert>
      )}
      {!loading && !error && ordered.length === 0 && (
        <Box sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary" gutterBottom>
            {emptyText}
          </Typography>
          {noteText && (
            <Typography variant="caption" color="text.secondary">
              {noteText}
            </Typography>
          )}
        </Box>
      )}
      {ordered.length > 0 && (
        <>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{
              px: 1.5,
              py: 0.75,
              borderBottom: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.paper'
            }}
          >
            <Typography variant="caption" color="text.secondary">
              {ordered.length} item{ordered.length === 1 ? '' : 's'}
              {' · '}
              {wantMentions
                ? mentionsQ.isFetching
                  ? 'sorting by latest mention…'
                  : (() => {
                      const newest = [...mentionByIdMemo.values()]
                        .map((m) => m.date)
                        .sort((a, b) => b.getTime() - a.getTime())[0]
                      return newest
                        ? `latest mention ${newest.toLocaleString()}`
                        : 'sorted by latest mention'
                    })()
                : (() => {
                    const newest = ordered
                      .map(getChangedDate)
                      .filter((d): d is Date => !!d)
                      .sort((a, b) => b.getTime() - a.getTime())[0]
                    return newest
                      ? `last update ${newest.toLocaleString()}`
                      : 'sorted by last update'
                  })()}
            </Typography>
            <Tooltip title="Refresh">
              <span>
                <IconButton
                  size="small"
                  onClick={() => {
                    wiqlQ.refetch()
                    batchQ.refetch()
                    if (wantMentions) mentionsQ.refetch()
                  }}
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
          <Box>
            {ordered.map((item) => {
              if (!wantMentions) {
                return (
                  <WorkItemListRow
                    key={item.id}
                    item={item}
                    onClick={onOpen}
                  />
                )
              }
              const mention = mentionByIdMemo.get(item.id)
              return (
                <WorkItemListRow
                  key={item.id}
                  item={item}
                  onClick={onOpen}
                  // Show the mention timestamp when known; otherwise
                  // fall back to ChangedDate so the row still has *some*
                  // recency cue. The tooltip prefix makes the source of
                  // the timestamp explicit on hover.
                  timestamp={
                    mention
                      ? { date: mention.date, tooltipPrefix: 'Mentioned' }
                      : (() => {
                          const changed = getChangedDate(item)
                          return changed
                            ? { date: changed, tooltipPrefix: 'Last updated' }
                            : null
                        })()
                  }
                  subtitle={
                    mention ? (
                      <MentionSnippet
                        snippet={mention.snippet}
                        author={mention.author}
                      />
                    ) : undefined
                  }
                />
              )
            })}
          </Box>
        </>
      )}
    </Box>
  )
}

/**
 * Inline preview of the matching comment for a Mentions list row.
 * Renders as a quoted block under the title so the user can scan
 * "what was said" without opening the drawer. The snippet is already
 * plain text (HTML stripped + truncated in the main process), so this
 * component just handles layout and styling.
 */
function MentionSnippet({
  snippet,
  author
}: {
  snippet: string
  author?: string
}): JSX.Element | null {
  if (!snippet) return null
  return (
    <Box
      sx={{
        mt: 0.25,
        pl: 1,
        borderLeft: '2px solid',
        borderColor: 'primary.light',
        bgcolor: 'action.hover',
        borderRadius: '0 4px 4px 0',
        py: 0.5,
        pr: 1
      }}
    >
      {author && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontWeight: 600, mr: 0.5 }}
        >
          {author}:
        </Typography>
      )}
      <Typography
        component="span"
        variant="caption"
        color="text.primary"
        sx={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          lineHeight: 1.4,
          fontStyle: 'italic'
        }}
      >
        {snippet}
      </Typography>
    </Box>
  )
}
