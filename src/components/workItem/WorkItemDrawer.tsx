import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Drawer,
  IconButton,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import CloseIcon from '@mui/icons-material/Close'
import LaunchIcon from '@mui/icons-material/Launch'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import PersonOutlineIcon from '@mui/icons-material/PersonOutline'
import OpenInFullIcon from '@mui/icons-material/OpenInFull'
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen'
import { useNavigate } from 'react-router-dom'
import {
  useBatchGetWorkItemsQuery,
  useGetConnectionQuery,
  useGetWorkItemWithRelationsQuery,
  useListWorkItemCommentsQuery
} from '@/store/api/adoApi'
import { IPC } from '@shared/contract'
import { useAppDispatch, useAppSelector } from '@/store'
import { selectWorkItem, setSource } from '@/store/workspaceSlice'
import {
  getAreaPath,
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
import { normalizeMentionName, buildSubtreeWiql } from '@/utils/wiql'
import RichDescription from './RichDescription'
import FavoriteButton from '@/components/common/FavoriteButton'
import type {
  AdoComment,
  AdoRelation,
  AdoWorkItem
} from '@shared/adoTypes'

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

/**
 * Two-state size toggle: Compact (default narrow side pane for quick
 * glances while keeping context behind it) ⇄ Fullscreen (whole viewport
 * for deep reading without losing the drawer's back/forward history).
 *
 * Width is intentionally *not* persisted — the drawer always opens
 * compact when the app starts. This keeps "fullscreen" feeling like an
 * explicit, current-task gesture rather than something the user has to
 * remember to switch back from on the next launch.
 */
type DrawerWidth = 'compact' | 'fullscreen'

const DRAWER_WIDTH_PX: Record<DrawerWidth, string> = {
  compact: '480px',
  fullscreen: '100vw'
}

export default function WorkItemDrawer(): JSX.Element {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const { selectedWorkItemId, projectId } = useAppSelector((s) => s.workspace)
  const open = selectedWorkItemId != null
  // Local state — the drawer always boots compact on a fresh app
  // launch; the user can expand within a session and that choice
  // persists across opening different items in the same session, but
  // doesn't carry over to next launch.
  const [drawerWidth, setLocalDrawerWidth] = useState<DrawerWidth>('compact')
  const toggleWidth = useCallback(() => {
    setLocalDrawerWidth((w) => (w === 'compact' ? 'fullscreen' : 'compact'))
  }, [])

  const itemQ = useGetWorkItemWithRelationsQuery(
    selectedWorkItemId != null && projectId
      ? { projectId, id: selectedWorkItemId }
      : (undefined as never),
    { skip: !open || !projectId }
  )

  const item = itemQ.data
  const type = item ? getType(item) : ''

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

  function close(): void {
    dispatch(selectWorkItem(null))
  }

  function viewInTreeView(): void {
    if (!item) return
    dispatch(
      setSource({
        kind: 'wiql',
        wiql: buildSubtreeWiql(item.id),
        label: `Subtree of #${item.id}`
      })
    )
    // Close the drawer and land directly on the tree tab so the button
    // label matches what the user actually sees. The user can switch
    // tabs (Hierarchy / Timeline / etc.) after if they want a different
    // shape — but the entry point is unambiguous.
    close()
    navigate('/visualize?view=tree')
  }

  const connectionQ = useGetConnectionQuery()
  const orgUrl = connectionQ.data?.organizationUrl ?? ''
  // Highlight comments where my display name appears so the Mentions
  // tab → drawer flow makes it obvious *why* the item was in the list.
  // Falls back to undefined when identity isn't resolved yet, which
  // simply means no row is highlighted (still useful as a thread view).
  const myNameNeedle = useMemo(() => {
    const dn = connectionQ.data?.authenticatedUser?.displayName
    if (!dn) return undefined
    const trimmed = normalizeMentionName(dn)
    return trimmed ? trimmed.toLowerCase() : undefined
  }, [connectionQ.data])

  // Pull comments only for the open item. Cached briefly via RTK Query
  // so re-opening the same item from a relations link doesn't re-hit
  // the network.
  const commentsQ = useListWorkItemCommentsQuery(
    selectedWorkItemId != null && projectId
      ? { projectId, id: selectedWorkItemId }
      : (undefined as never),
    { skip: !open || !projectId }
  )

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
      PaperProps={{
        sx: {
          width: DRAWER_WIDTH_PX[drawerWidth],
          // Smooth the size change so toggling feels intentional rather
          // than jarring — MUI's Paper has no transition by default.
          transition: 'width 180ms ease'
        }
      }}
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
        {item && (
          <FavoriteButton
            kind="workItem"
            id={String(item.id)}
            label={getTitle(item)}
            projectId={projectId ?? undefined}
            meta={{ type: getType(item), state: getState(item) }}
            sx={{ mt: 0.25 }}
          />
        )}
        <Tooltip
          title={
            drawerWidth === 'compact'
              ? 'Expand to fullscreen'
              : 'Shrink to compact'
          }
        >
          <IconButton
            onClick={toggleWidth}
            size="small"
            aria-label={
              drawerWidth === 'compact'
                ? 'Expand drawer to fullscreen'
                : 'Shrink drawer to compact'
            }
          >
            {drawerWidth === 'compact' ? (
              <OpenInFullIcon fontSize="small" />
            ) : (
              <CloseFullscreenIcon fontSize="small" />
            )}
          </IconButton>
        </Tooltip>
        <IconButton onClick={close} size="small" aria-label="Close drawer">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {item && (
        <Stack
          direction="row"
          spacing={1}
          // useFlexGap + flexWrap lets the action row reflow gracefully
          // when the drawer is narrow (compact mode + zoomed text), so
          // the secondary button drops to a second line instead of
          // being clipped or pushing content off-screen.
          useFlexGap
          flexWrap="wrap"
          sx={{
            px: 2,
            py: 1,
            borderBottom: '1px solid',
            borderColor: 'divider',
            rowGap: 1
          }}
        >
          <Button
            size="small"
            variant="contained"
            startIcon={<AccountTreeIcon />}
            onClick={viewInTreeView}
          >
            View in tree view
          </Button>
          {webUrl && (
            <Button
              size="small"
              variant="outlined"
              // Use endIcon for the launch glyph — the right-aligned
              // arrow is the universal "this opens elsewhere" cue and
              // matches how external links are rendered in GitHub /
              // Notion / Linear.
              endIcon={<LaunchIcon fontSize="small" />}
              onClick={openInBrowser}
            >
              Open in Azure DevOps
            </Button>
          )}
        </Stack>
      )}

      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        {itemQ.isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        )}
        {itemQ.error != null && <Alert severity="error">Failed to load work item.</Alert>}

        {item && (
          <Stack spacing={2.5}>
            <Stack spacing={0.75}>
              <MetadataRow label="State" value={
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Box sx={{
                    width: 10, height: 10, borderRadius: '50%',
                    bgcolor: colorForState(getState(item)),
                    border: (theme) =>
                      `1px solid ${
                        theme.palette.mode === 'dark'
                          ? 'rgba(255,255,255,0.18)'
                          : 'rgba(0,0,0,0.08)'
                      }`
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
                    // Cap at 360 px in compact so the rest of the
                    // drawer is reachable without scrolling past a
                    // wall of description; in expanded modes there's
                    // plenty of vertical room so let it grow taller
                    // (the parent box scrolls anyway).
                    maxHeight: drawerWidth === 'compact' ? 360 : 'none',
                    overflow: 'auto'
                  }}
                >
                  <RichDescription html={descriptionHtml} />
                </Box>
              </Box>
            )}

            <DiscussionSection
              comments={commentsQ.data?.comments}
              loading={commentsQ.isFetching}
              error={commentsQ.error != null}
              myNameNeedle={myNameNeedle}
            />

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

      </Box>
    </Drawer>
  )
}

/**
 * Discussion / comments thread for the currently-open work item.
 *
 * Renders newest-first (server already sorts), each comment as a card
 * showing author + relative date + sanitised HTML body. When
 * `myNameNeedle` is supplied, comments containing that case-insensitive
 * substring are visually emphasised and labelled "Mentions you" — this
 * gives the user instant context on *why* the item appears in the
 * Mentions tab when they drill into it.
 *
 * The whole section collapses cleanly to a single "No comments yet"
 * line so the drawer doesn't waste vertical space on items without
 * discussion.
 */
function DiscussionSection({
  comments,
  loading,
  error,
  myNameNeedle
}: {
  comments: AdoComment[] | undefined
  loading: boolean
  error: boolean
  myNameNeedle?: string
}): JSX.Element {
  const list = comments ?? []
  return (
    <Box>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{ mb: 0.75 }}
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}
        >
          Discussion
        </Typography>
        {!loading && !error && (
          <Chip
            size="small"
            label={list.length}
            variant="outlined"
            sx={{ height: 18, '& .MuiChip-label': { px: 0.75, fontSize: 10 } }}
          />
        )}
        {loading && <CircularProgress size={12} />}
      </Stack>

      {error && (
        <Alert severity="error" sx={{ py: 0.5 }}>
          Failed to load comments.
        </Alert>
      )}

      {!loading && !error && list.length === 0 && (
        <Typography variant="caption" color="text.disabled" sx={{ pl: 1 }}>
          No comments yet.
        </Typography>
      )}

      {list.length > 0 && (
        <Stack spacing={1}>
          {list.map((c) => (
            <CommentCard
              key={c.id}
              comment={c}
              highlight={
                myNameNeedle && c.text
                  ? c.text.toLowerCase().includes(myNameNeedle)
                  : false
              }
            />
          ))}
        </Stack>
      )}
    </Box>
  )
}

/**
 * Single comment card. Reuses `RichDescription` so inline images and
 * @-mention markup render consistently with the work-item description
 * above.
 */
function CommentCard({
  comment,
  highlight
}: {
  comment: AdoComment
  highlight: boolean
}): JSX.Element {
  const created = comment.createdDate ? new Date(comment.createdDate) : null
  const author = comment.createdBy?.displayName ?? 'Unknown'
  return (
    <Box
      sx={(theme) => ({
        p: 1.25,
        borderRadius: 1,
        border: '1px solid',
        borderColor: highlight ? 'primary.main' : 'divider',
        bgcolor: highlight
          ? theme.palette.mode === 'dark'
            ? 'rgba(99, 167, 255, 0.10)'
            : 'rgba(25, 118, 210, 0.06)'
          : 'background.paper',
        // Subtle indicator on the left edge mirrors how chat apps mark
        // a thread you're tagged in.
        borderLeft: highlight ? '3px solid' : '1px solid',
        borderLeftColor: highlight ? 'primary.main' : 'divider'
      })}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{ mb: 0.5, flexWrap: 'wrap', rowGap: 0.25 }}
      >
        <PersonOutlineIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {author}
        </Typography>
        {created && (
          <Tooltip title={created.toLocaleString()}>
            <Typography variant="caption" color="text.secondary">
              · {relativeTime(created)}
            </Typography>
          </Tooltip>
        )}
        {highlight && (
          <Chip
            size="small"
            label="Mentions you"
            color="primary"
            sx={{
              height: 18,
              ml: 'auto',
              '& .MuiChip-label': { px: 0.75, fontSize: 10, fontWeight: 600 }
            }}
          />
        )}
      </Stack>
      <Box sx={{ pl: 0.5 }}>
        <RichDescription html={comment.text ?? ''} />
      </Box>
    </Box>
  )
}
