import { useMemo, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Avatar,
  AvatarGroup,
  Box,
  Chip,
  IconButton,
  InputAdornment,
  LinearProgress,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import SearchIcon from '@mui/icons-material/Search'
import CheckIcon from '@mui/icons-material/Check'
import CloseIcon from '@mui/icons-material/Close'
import RemoveIcon from '@mui/icons-material/Remove'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import EditNoteIcon from '@mui/icons-material/EditNote'
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined'
import { IPC } from '@shared/contract'
import type {
  AdoGitRepository,
  AdoPullRequest,
  AdoPullRequestReviewer
} from '@shared/adoTypes'
import {
  useListPullRequestsQuery,
  useListRepositoriesQuery
} from '@/store/api/adoApi'
import { readableTextColor } from '@/utils/adoColors'

/** Status segment values shown in the UI. `drafts` is a client-side
 *  refinement of `active` (ADO returns drafts under the `active`
 *  status with `isDraft: true`). */
type StatusFilter = 'active' | 'drafts' | 'completed' | 'abandoned' | 'all'

/** Scope segment values. `mine` and `reviewer` require the current
 *  user's ADO id — when unavailable both are disabled with a tooltip. */
type ScopeFilter = 'all' | 'mine' | 'reviewer'

const STATUS_LABELS: Record<StatusFilter, string> = {
  active: 'Active',
  drafts: 'Drafts',
  completed: 'Completed',
  abandoned: 'Abandoned',
  all: 'All'
}

const SCOPE_LABELS: Record<ScopeFilter, string> = {
  all: 'All',
  mine: 'Mine',
  reviewer: 'Reviewer'
}

/**
 * Sentinel option representing "no repo filter" in the Autocomplete.
 * Picked to be impossible as a real ADO repo id (which are GUIDs) so
 * we can compare with a simple `=== ALL_REPOS_OPTION.id`.
 */
const ALL_REPOS_OPTION: AdoGitRepository = {
  id: '*',
  name: 'All repositories',
  project: { id: '', name: '' }
}

/**
 * Map UI status → server-side `searchCriteria.status`. Drafts are
 * surfaced to the user as a separate filter, but the API has no
 * `'drafts'` status — they live under `'active'` with `isDraft: true`.
 * We fetch active PRs and filter client-side in that case.
 */
function statusForServer(s: StatusFilter): 'active' | 'completed' | 'abandoned' | 'all' {
  if (s === 'drafts') return 'active'
  return s
}

interface PullRequestsListProps {
  projectId: string
  /**
   * Org URL like `https://dev.azure.com/contoso`. Combined with the
   * PR's repository.project.name + repo name + id to build the ADO web
   * URL we open via `shell.openExternal`. Treated as optional so the
   * list still renders for orgs that haven't reported it yet — the
   * row click is just disabled in that case.
   */
  orgUrl?: string
  /**
   * Authenticated user's ADO id (GUID from `connectionData`). When
   * absent, the Mine / Reviewer scope filters are disabled with a
   * tooltip explaining why.
   */
  currentUserId?: string
  /**
   * Phase 2 will swap this in — the detail drawer will subscribe to it
   * and open inline. For phase 1 the click handler ignores `onOpen` and
   * uses `shell.openExternal` instead, but the prop is here so the
   * HomePage wiring is already in shape.
   */
  onOpen?: (pullRequestId: number) => void
}

export default function PullRequestsList({
  projectId,
  orgUrl,
  currentUserId
}: PullRequestsListProps): JSX.Element {
  // TODO(future): persist these filters in workspaceSlice once we have
  // a per-project filter store. For now they live in component state
  // so a tab switch resets them — that's the conservative default
  // until product confirms which filters should survive.
  const [status, setStatus] = useState<StatusFilter>('active')
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [search, setSearch] = useState('')
  const [repoId, setRepoId] = useState<string>(ALL_REPOS_OPTION.id)

  const canFilterByIdentity = !!currentUserId
  // If identity-scoped filters get re-selected after the user signs in
  // / out we don't want them stuck disabled — but if the user *is*
  // unable to use them, force the segment back to "All" so we don't
  // silently send an empty creatorId/reviewerId to the API.
  const effectiveScope: ScopeFilter = canFilterByIdentity ? scope : 'all'

  const reposQ = useListRepositoriesQuery({ projectId }, { skip: !projectId })
  const repos = reposQ.data?.repositories ?? []
  const repoError =
    (reposQ.error as { data?: { message?: string } } | undefined)?.data?.message
  const selectedRepo = useMemo(
    () => repos.find((r) => r.id === repoId) ?? null,
    [repos, repoId]
  )

  const queryArgs = useMemo(
    () => ({
      projectId,
      status: statusForServer(status),
      creatorId:
        effectiveScope === 'mine' ? currentUserId : undefined,
      reviewerId:
        effectiveScope === 'reviewer' ? currentUserId : undefined,
      // Sentinel `'*'` means "no repo filter" → undefined so the main
      // process hits the project-wide endpoint. Any other value is
      // assumed to be a real ADO repo GUID and routes through the
      // repo-scoped endpoint.
      repositoryId:
        repoId && repoId !== ALL_REPOS_OPTION.id ? repoId : undefined,
      top: 100
    }),
    [projectId, status, effectiveScope, currentUserId, repoId]
  )

  const prsQ = useListPullRequestsQuery(queryArgs, { skip: !projectId })

  const allPrs = prsQ.data?.pullRequests ?? []

  /**
   * Filter + sort pipeline:
   *   1. Apply the Drafts client-side filter (server returned all
   *      `active` PRs; we narrow to drafts here).
   *   2. Apply the search box (case-insensitive substring match
   *      against title or `#id`, mirrors WorkItemSearchBox' client
   *      filter for recents).
   *   3. Sort by `creationDate` desc — ADO's PR list endpoint doesn't
   *      surface a stable `lastUpdatedTime`, so we use creationDate as
   *      the closest cross-org-compatible recency cue. `closedDate`
   *      ties on completed / abandoned PRs are an acceptable
   *      regression for phase 1 — the detail drawer in phase 2 can
   *      offer better sorting once we pull richer data per PR.
   */
  const visible = useMemo(() => {
    let rows = allPrs
    if (status === 'drafts') {
      rows = rows.filter((p) => p.isDraft)
    }
    const term = search.trim().toLowerCase()
    if (term) {
      const stripHash = term.replace(/^#/, '')
      rows = rows.filter((p) => {
        if (String(p.pullRequestId).includes(stripHash)) return true
        if (p.title?.toLowerCase().includes(term)) return true
        return false
      })
    }
    return [...rows].sort((a, b) => {
      const ta = Date.parse(a.creationDate) || 0
      const tb = Date.parse(b.creationDate) || 0
      return tb - ta
    })
  }, [allPrs, status, search])

  const loading = prsQ.isFetching
  const error =
    (prsQ.error as { data?: { message?: string } } | undefined)?.data?.message

  function handleOpen(pr: AdoPullRequest): void {
    // TODO(phase-2): replace shell.openExternal with `onOpen(pr.pullRequestId)`
    // to open the in-app PR detail drawer once that lands.
    if (!orgUrl) return
    const projectName = pr.repository?.project?.name
    const repoName = pr.repository?.name
    if (!projectName || !repoName) return
    const url = `${orgUrl.replace(/\/+$/, '')}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(repoName)}/pullrequest/${pr.pullRequestId}`
    void window.ado.invoke(IPC.ShellOpenExternal, { url })
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      {/*
       * Filter strip mirrors the Sprint page's toolbar: small toggle
       * groups + an inline search box, all on a single row that wraps
       * to a second row on narrow windows.
       */}
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{
          px: 1.5,
          py: 1,
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexWrap: 'wrap',
          rowGap: 1
        }}
      >
        <RepositoryFilter
          repositories={repos}
          loading={reposQ.isFetching}
          error={repoError}
          value={selectedRepo ?? ALL_REPOS_OPTION}
          onChange={(repo) => setRepoId(repo.id)}
        />

        <ToggleButtonGroup
          size="small"
          exclusive
          value={status}
          onChange={(_e, v: StatusFilter | null) => {
            if (v) setStatus(v)
          }}
          aria-label="Pull request status"
        >
          {(['active', 'drafts', 'completed', 'abandoned', 'all'] as StatusFilter[]).map(
            (s) => (
              <ToggleButton key={s} value={s} sx={{ textTransform: 'none', px: 1.25 }}>
                {STATUS_LABELS[s]}
              </ToggleButton>
            )
          )}
        </ToggleButtonGroup>

        <Tooltip
          title={
            canFilterByIdentity
              ? 'Filter by your relationship to the PR'
              : 'Requires identity resolution — sign-in identity not available yet'
          }
        >
          <span>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={effectiveScope}
              onChange={(_e, v: ScopeFilter | null) => {
                if (v) setScope(v)
              }}
              disabled={!canFilterByIdentity}
              aria-label="Pull request scope"
            >
              {(['all', 'mine', 'reviewer'] as ScopeFilter[]).map((s) => (
                <ToggleButton
                  key={s}
                  value={s}
                  sx={{ textTransform: 'none', px: 1.25 }}
                >
                  {SCOPE_LABELS[s]}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </span>
        </Tooltip>

        <TextField
          size="small"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title or #id"
          sx={{ flex: '1 1 220px', minWidth: 180 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              )
            }
          }}
        />
      </Stack>

      {loading && <LinearProgress />}
      {repoError && (
        // Surfaced separately from the PR-list error so the user knows
        // the dropdown is empty because of a load failure, not because
        // the project genuinely has no repos. Severity is `warning`
        // because the rest of the page (project-wide PR list) still
        // works fine — this is a degraded filter, not a hard failure.
        <Alert severity="warning" sx={{ m: 2 }}>
          Couldn&rsquo;t load repositories: {repoError}
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ m: 2 }}>
          {error}
        </Alert>
      )}

      {!loading && !error && visible.length === 0 && (
        <Box sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary" gutterBottom>
            {selectedRepo
              ? `No pull requests in ${selectedRepo.name} matching the current filters.`
              : 'No pull requests match these filters.'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {STATUS_LABELS[status]} · {SCOPE_LABELS[effectiveScope]}
            {selectedRepo && ` · ${selectedRepo.name}`}
            {search.trim() && ` · "${search.trim()}"`}
          </Typography>
        </Box>
      )}

      {visible.length > 0 && (
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
              {visible.length} pull request{visible.length === 1 ? '' : 's'}
              {' · sorted by creation date'}
            </Typography>
            <Tooltip title="Refresh">
              <span>
                <IconButton size="small" onClick={() => prsQ.refetch()}>
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
          <Box>
            {visible.map((pr) => (
              <PullRequestRow
                key={pr.pullRequestId}
                pr={pr}
                onOpen={handleOpen}
                disabled={!orgUrl}
              />
            ))}
          </Box>
        </>
      )}
    </Box>
  )
}

interface PullRequestRowProps {
  pr: AdoPullRequest
  onOpen: (pr: AdoPullRequest) => void
  /** When true, the row still renders but isn't clickable (e.g. no
   *  org URL available so we can't build the external link). */
  disabled?: boolean
}

function PullRequestRow({ pr, onOpen, disabled }: PullRequestRowProps): JSX.Element {
  const author = pr.createdBy
  const status = derivedStatus(pr)
  const statusColor = pillColorForStatus(status)
  const created = pr.creationDate ? new Date(pr.creationDate) : null
  // Reviewer summary: drop the author from the displayed avatars
  // (creating your own PR auto-adds you; showing your own avatar in
  // the reviewer stack is noisy). We *don't* drop reviewers with
  // `vote: 0` — the chip render highlights actual votes and the
  // outlined "no vote" chip is useful for showing required-but-
  // unvoted reviewers at a glance.
  const reviewers = (pr.reviewers ?? []).filter(
    (r) => !author?.id || r.id !== author.id
  )

  return (
    <Box
      role={disabled ? undefined : 'button'}
      tabIndex={disabled ? undefined : 0}
      onClick={disabled ? undefined : () => onOpen(pr)}
      onKeyDown={
        disabled
          ? undefined
          : (e) => {
              if (e.key === 'Enter' || e.key === ' ') onOpen(pr)
            }
      }
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.25,
        px: 1.5,
        py: 1,
        borderBottom: '1px solid',
        borderColor: 'divider',
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background-color 120ms',
        '&:hover': disabled ? undefined : { bgcolor: 'action.hover' },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: -2
        }
      }}
    >
      <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
        <Stack
          direction="row"
          spacing={0.75}
          alignItems="center"
          sx={{ flexWrap: 'wrap', rowGap: 0.5 }}
        >
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}
          >
            #{pr.pullRequestId}
          </Typography>
          {pr.repository?.name && (
            // Promoted out of the metadata line so the repo is legible
            // at a glance — it sits next to the PR id, which is where
            // the eye lands first on each row. Outlined chip + small
            // folder icon match the visual vocabulary of the existing
            // tag chips in `WorkItemListRow`.
            <Tooltip title={`Repository: ${pr.repository.name}`}>
              <Chip
                size="small"
                variant="outlined"
                icon={<FolderOutlinedIcon sx={{ fontSize: 12 }} />}
                label={pr.repository.name}
                sx={{
                  height: 20,
                  maxWidth: 200,
                  '& .MuiChip-label': {
                    px: 0.75,
                    fontSize: 11,
                    fontWeight: 600
                  },
                  '& .MuiChip-icon': { ml: 0.5, mr: -0.25 }
                }}
              />
            </Tooltip>
          )}
          <Chip
            size="small"
            icon={
              status === 'draft' ? (
                <EditNoteIcon style={{ fontSize: 14 }} />
              ) : undefined
            }
            label={statusLabel(status)}
            sx={{
              bgcolor: statusColor,
              color: readableTextColor(statusColor),
              height: 20,
              fontWeight: 600,
              '& .MuiChip-label': { px: 0.75, fontSize: 10 },
              '& .MuiChip-icon': { color: 'inherit', ml: 0.5, mr: -0.25 }
            }}
          />
          {created && (
            <Tooltip title={`Created ${created.toLocaleString()}`}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontSize: 11, ml: 'auto' }}
              >
                {formatRelative(created)}
              </Typography>
            </Tooltip>
          )}
        </Stack>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 500,
            lineHeight: 1.3,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-word'
          }}
        >
          {pr.title}
        </Typography>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ flexWrap: 'wrap', rowGap: 0.25 }}
        >
          {/* Repo name moved up next to the PR id — see the chip
              above. The metadata line now leads with the branch
              pair, which is where the user's eye goes once they've
              clocked the repo. */}
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{
              fontSize: 11,
              fontFamily: 'monospace',
              bgcolor: 'action.hover',
              px: 0.5,
              borderRadius: 0.5
            }}
          >
            {shortBranch(pr.sourceRefName)} → {shortBranch(pr.targetRefName)}
          </Typography>
        </Stack>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ flexWrap: 'wrap', rowGap: 0.25 }}
        >
          {author && (
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Avatar
                src={author.imageUrl}
                alt={author.displayName}
                sx={{ width: 18, height: 18, fontSize: 10 }}
              >
                {(author.displayName ?? '?').charAt(0)}
              </Avatar>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontSize: 11 }}
              >
                {author.displayName ?? 'Unknown'}
              </Typography>
            </Stack>
          )}
          {reviewers.length > 0 && <ReviewerSummary reviewers={reviewers} />}
        </Stack>
      </Stack>
    </Box>
  )
}

interface RepositoryFilterProps {
  repositories: AdoGitRepository[]
  loading: boolean
  /** Lifted error message from the repos query, shown inline. */
  error: string | undefined
  /** Currently-selected repo, or the "All repositories" sentinel. */
  value: AdoGitRepository
  onChange: (repo: AdoGitRepository) => void
}

/**
 * Compact Autocomplete that surfaces "All repositories" + the
 * project's repos as filter options. Sized to fit alongside the
 * status / scope segments on a single row, with `flex` so it shrinks
 * on narrow windows before wrapping to a second row like the rest of
 * the toolbar.
 */
function RepositoryFilter({
  repositories,
  loading,
  error,
  value,
  onChange
}: RepositoryFilterProps): JSX.Element {
  const options = useMemo(
    () => [ALL_REPOS_OPTION, ...repositories],
    [repositories]
  )

  const tooltipTitle = loading
    ? 'Loading repositories…'
    : error
      ? `Failed to load repositories: ${error}`
      : 'Filter pull requests by repository'

  return (
    <Tooltip title={tooltipTitle}>
      <span style={{ display: 'inline-flex', flex: '0 1 240px', minWidth: 180 }}>
        <Autocomplete<AdoGitRepository, false, true, false>
          fullWidth
          size="small"
          options={options}
          value={value}
          disableClearable
          // Disable while repos are loading so the user can't pick
          // something that isn't yet on the list, and disable on
          // error too — the inline alert tells them why.
          disabled={loading || !!error}
          loading={loading}
          getOptionLabel={(opt) => opt.name}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          onChange={(_e, v) => {
            if (v) onChange(v)
          }}
          renderOption={(liProps, option) => {
            const { key, ...rest } = liProps as typeof liProps & {
              key?: React.Key
            }
            const isAll = option.id === ALL_REPOS_OPTION.id
            return (
              <li
                key={key ?? option.id}
                {...rest}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  opacity: option.isDisabled ? 0.55 : 1
                }}
              >
                <FolderOutlinedIcon
                  sx={{
                    fontSize: 14,
                    color: isAll ? 'text.disabled' : 'text.secondary'
                  }}
                />
                <span style={{ fontStyle: isAll ? 'italic' : 'normal' }}>
                  {option.name}
                </span>
                {option.isDisabled && (
                  <Chip
                    size="small"
                    label="disabled"
                    sx={{
                      height: 16,
                      ml: 'auto',
                      '& .MuiChip-label': { px: 0.5, fontSize: 9 }
                    }}
                  />
                )}
              </li>
            )
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              size="small"
              placeholder="Repository"
              error={!!error}
              slotProps={{
                input: {
                  ...params.InputProps,
                  startAdornment: (
                    <InputAdornment position="start">
                      <FolderOutlinedIcon fontSize="small" />
                    </InputAdornment>
                  )
                }
              }}
            />
          )}
        />
      </span>
    </Tooltip>
  )
}

/**
 * Small avatar stack annotated with each reviewer's vote. We render at
 * most four avatars inline; anything beyond that collapses into MUI's
 * `+N` overflow chip. Each avatar wraps its `<VoteChip>` so hover
 * tooltips line up with the right person.
 */
function ReviewerSummary({
  reviewers
}: {
  reviewers: AdoPullRequestReviewer[]
}): JSX.Element {
  // Order so reviewers with strong votes (rejected, waiting, approved)
  // bubble to the front of the stack — required reviewers tie-break to
  // the front so the most-relevant signals are visible at a glance.
  const ordered = useMemo(() => {
    const score = (r: AdoPullRequestReviewer): number => {
      switch (r.vote) {
        case -10:
          return 5 // rejected → most urgent
        case -5:
          return 4 // waiting for author
        case 10:
          return 3
        case 5:
          return 2
        default:
          return r.isRequired ? 1 : 0
      }
    }
    return [...reviewers].sort((a, b) => score(b) - score(a))
  }, [reviewers])

  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <AvatarGroup
        max={4}
        sx={{
          '& .MuiAvatar-root': {
            width: 22,
            height: 22,
            fontSize: 10,
            border: '1px solid',
            borderColor: 'background.paper'
          }
        }}
      >
        {ordered.map((r) => {
          const decoration = voteDecoration(r.vote)
          return (
            <Tooltip
              key={`${r.id ?? r.uniqueName ?? r.displayName}`}
              title={
                <>
                  {r.displayName ?? 'Reviewer'}
                  {r.isRequired ? ' (required)' : ''}
                  {' · '}
                  {decoration.label}
                </>
              }
            >
              <Box sx={{ position: 'relative' }}>
                <Avatar
                  src={r.imageUrl}
                  alt={r.displayName}
                  sx={{ width: 22, height: 22, fontSize: 10 }}
                >
                  {(r.displayName ?? '?').charAt(0)}
                </Avatar>
                {decoration.icon && (
                  <Box
                    sx={{
                      position: 'absolute',
                      right: -3,
                      bottom: -3,
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      bgcolor: decoration.bg,
                      color: readableTextColor(decoration.bg),
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      border: '1px solid',
                      borderColor: 'background.paper'
                    }}
                  >
                    {decoration.icon}
                  </Box>
                )}
              </Box>
            </Tooltip>
          )
        })}
      </AvatarGroup>
    </Stack>
  )
}

/* ---------- formatting helpers ---------- */

function shortBranch(refName: string): string {
  // Strip the `refs/heads/` prefix that ADO returns; everything else
  // (refs/pull/, refs/tags/) is rare in PR contexts and we keep the
  // raw value visible so the user can still reason about it.
  return refName.replace(/^refs\/heads\//, '')
}

type DerivedStatus = 'draft' | 'active' | 'completed' | 'abandoned' | 'unknown'

function derivedStatus(pr: AdoPullRequest): DerivedStatus {
  if (pr.isDraft && pr.status === 'active') return 'draft'
  if (pr.status === 'active') return 'active'
  if (pr.status === 'completed') return 'completed'
  if (pr.status === 'abandoned') return 'abandoned'
  return 'unknown'
}

function statusLabel(s: DerivedStatus): string {
  switch (s) {
    case 'draft':
      return 'Draft'
    case 'active':
      return 'Active'
    case 'completed':
      return 'Completed'
    case 'abandoned':
      return 'Abandoned'
    default:
      return 'Unknown'
  }
}

function pillColorForStatus(s: DerivedStatus): string {
  // Hand-picked to line up with the existing work-item state palette
  // (`adoColors.ts`): blue for "in progress", green for "done", red for
  // "removed/abandoned", neutral grey for everything else.
  switch (s) {
    case 'active':
      return '#007ACC'
    case 'completed':
      return '#339933'
    case 'abandoned':
      return '#CC293D'
    case 'draft':
      return '#5D5D5D'
    default:
      return '#888888'
  }
}

interface VoteDecoration {
  label: string
  /** Background colour for the small vote pip on the avatar. */
  bg: string
  /** Icon rendered inside the pip — `null` for "no vote". */
  icon: JSX.Element | null
}

function voteDecoration(vote: number): VoteDecoration {
  // Match ADO's vote semantics exactly:
  //   10 → approved, 5 → approved with suggestions, 0 → no vote,
  //  -5 → waiting for author, -10 → rejected.
  // Anything else is treated as "no vote" so a future ADO addition
  // doesn't crash the row.
  switch (vote) {
    case 10:
      return {
        label: 'Approved',
        bg: '#339933',
        icon: <CheckIcon sx={{ fontSize: 9 }} />
      }
    case 5:
      return {
        label: 'Approved with suggestions',
        bg: '#7CB342',
        icon: <CheckIcon sx={{ fontSize: 9 }} />
      }
    case -5:
      return {
        label: 'Waiting for author',
        bg: '#FF9D00',
        icon: <WarningAmberIcon sx={{ fontSize: 9 }} />
      }
    case -10:
      return {
        label: 'Rejected',
        bg: '#CC293D',
        icon: <CloseIcon sx={{ fontSize: 9 }} />
      }
    case 0:
    default:
      return {
        label: 'No vote',
        bg: '#B2B2B2',
        icon: <RemoveIcon sx={{ fontSize: 9 }} />
      }
  }
}

/**
 * Compact human-friendly delta. Same formula as `WorkItemListRow`'s
 * inline helper — duplicated rather than extracted for phase 1 since
 * the spec asks us to keep the new component self-contained.
 */
function formatRelative(d: Date): string {
  const now = Date.now()
  const diffMs = now - d.getTime()
  if (diffMs < 0) return d.toLocaleDateString()
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
