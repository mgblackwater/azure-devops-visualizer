/**
 * Lazy-on-hover summary chip for a PR's file changes. Lives in each
 * row of `PullRequestsList`.
 *
 * The chip itself is plain text until the user hovers it long enough
 * for the 400 ms `enterDelay` to elapse — only then do we flip
 * `hasBeenHovered` and let RTK Query drop the `skip` flag, sending
 * one request per row that the user actually looked at. Quick mouse
 * passes through 50 rows therefore fan out zero fetches.
 *
 * Why a per-row dedicated component (and not an inline ternary in
 * `PullRequestsList`):
 *   - keeps the row file lean,
 *   - isolates the local `hasBeenHovered` state so a re-render of the
 *     row (e.g. from list re-sort) doesn't cascade through every
 *     other chip's state,
 *   - gives the tooltip body a natural home for its 10-row layout.
 *
 * The hover gate never resets — a row that has been hovered once
 * stays subscribed for as long as it's mounted, and the hook's
 * `keepUnusedDataFor: 300` keeps the entry warm for five minutes
 * after the last subscriber unmounts. Re-hover within that window is
 * an instant cache hit.
 */
import { useState, type ReactNode } from 'react'
import {
  Box,
  Chip,
  CircularProgress,
  Skeleton,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import type {
  AdoPullRequest,
  AdoPullRequestChange,
  AdoPullRequestChangeKind,
  PullRequestChangesSummary
} from '@shared/adoTypes'
import { useGetPullRequestChangesSummaryQuery } from '@/store/api/adoApi'

/** Tooltip enter delay — long enough that quick mouse passes through
 *  the row don't fan out fetches across 50 rows, short enough that
 *  intentional hover still feels snappy. */
const HOVER_ENTER_DELAY_MS = 400

/** Cap for the per-row file list shown in the tooltip. Anything
 *  beyond this is summarised by an `…and N more` footer. */
const MAX_TOOLTIP_ROWS = 10

interface FilesSummaryChipProps {
  pr: AdoPullRequest
}

interface ChangeKindGlyph {
  letter: 'A' | 'M' | 'D' | 'R' | '?'
  /** MUI palette token for the glyph foreground. */
  color: string
}

function glyphFor(kind: AdoPullRequestChangeKind): ChangeKindGlyph {
  switch (kind) {
    case 'add':
      return { letter: 'A', color: 'success.main' }
    case 'edit':
      return { letter: 'M', color: 'text.primary' }
    case 'delete':
      return { letter: 'D', color: 'error.main' }
    case 'rename':
      return { letter: 'R', color: 'info.main' }
    case 'other':
    default:
      return { letter: '?', color: 'text.secondary' }
  }
}

export default function FilesSummaryChip({
  pr
}: FilesSummaryChipProps): JSX.Element {
  const projectId = pr.repository?.project?.id
  const repositoryId = pr.repository?.id
  const canFetch = !!projectId && !!repositoryId

  // One-way latch — set on the tooltip's `onOpen` (which only fires
  // after the 400 ms enterDelay), never cleared. RTK Query's `skip`
  // flag below derives from this so the network call is gated on
  // intentional hover rather than mouseenter.
  const [hasBeenHovered, setHasBeenHovered] = useState(false)

  const detailsQ = useGetPullRequestChangesSummaryQuery(
    canFetch && projectId && repositoryId
      ? { projectId, repositoryId, pullRequestId: pr.pullRequestId }
      : // Sentinel — RTK Query never reads `args` while `skip` is true.
        { projectId: '', repositoryId: '', pullRequestId: 0 },
    { skip: !hasBeenHovered || !canFetch }
  )

  const summary = detailsQ.data?.summary
  const isLoading = hasBeenHovered && detailsQ.isFetching && !summary
  const errorMessage = hasBeenHovered
    ? (detailsQ.error as { data?: { message?: string } } | undefined)?.data
        ?.message
    : undefined

  const chipLabel = chipLabelFor({ summary, isLoading, hasError: !!errorMessage })
  const chipIcon = isLoading ? (
    <CircularProgress size={12} sx={{ ml: 0.5 }} />
  ) : (
    <DescriptionOutlinedIcon sx={{ fontSize: 12 }} />
  )

  const labelColor = errorMessage
    ? 'warning.main'
    : !summary || summary.totalFiles === 0
      ? 'text.secondary'
      : 'text.primary'

  return (
    // Box wrapper handles click-stop without forcing the Chip into
    // MUI's `clickable` style (we don't want a button-shaped chip,
    // just a hover-revealing factual chip). The chip's :hover border
    // bump is pure CSS and works regardless.
    <Box
      component="span"
      onClick={(e) => e.stopPropagation()}
      sx={{ display: 'inline-flex' }}
    >
      <Tooltip
        title={
          <FilesSummaryTooltipBody
            summary={summary}
            isLoading={isLoading}
            errorMessage={errorMessage}
            hasBeenHovered={hasBeenHovered}
            canFetch={canFetch}
          />
        }
        enterDelay={HOVER_ENTER_DELAY_MS}
        enterNextDelay={HOVER_ENTER_DELAY_MS}
        onOpen={() => {
          if (!hasBeenHovered) setHasBeenHovered(true)
        }}
        slotProps={{
          tooltip: {
            sx: {
              maxWidth: 360,
              bgcolor: 'background.paper',
              color: 'text.primary',
              border: '1px solid',
              borderColor: 'divider',
              boxShadow: 3,
              p: 0
            }
          }
        }}
      >
        <Chip
          size="small"
          variant="outlined"
          icon={chipIcon}
          label={chipLabel}
          aria-label={`File changes for PR #${pr.pullRequestId}`}
          sx={{
            height: 20,
            cursor: 'help',
            borderColor: errorMessage ? 'warning.main' : 'divider',
            '& .MuiChip-label': {
              px: 0.75,
              fontSize: 11,
              fontWeight: 600,
              color: labelColor
            },
            '& .MuiChip-icon': { ml: 0.5, mr: -0.25 },
            // Subtle border bump on hover hints the chip is
            // interactive — the actual fetch is gated behind the
            // 400 ms enterDelay, but this gives the user a visual
            // cue that *something* will happen if they linger.
            '&:hover': {
              borderColor: errorMessage ? 'warning.dark' : 'primary.main'
            }
          }}
        />
      </Tooltip>
    </Box>
  )
}

/**
 * Decides what text the chip itself shows. Pulled out so the render
 * function reads as a flat list of states without nested ternaries.
 *
 * The line-count branch is wired here intentionally so the chip
 * lights up automatically once the iteration-changes endpoint starts
 * populating `totalAdded` / `totalDeleted` — see the
 * `TODO(v0.3.2+)` in `electron/ado/pullRequests.ts`.
 */
function chipLabelFor({
  summary,
  isLoading,
  hasError
}: {
  summary: PullRequestChangesSummary | undefined
  isLoading: boolean
  hasError: boolean
}): string {
  if (isLoading) return 'Loading…'
  if (hasError) return 'Files'
  if (!summary) return 'Files'
  if (summary.totalFiles === 0) return 'No files'
  const base =
    summary.totalFiles === 1 ? '1 file' : `${summary.totalFiles} files`
  if (
    typeof summary.totalAdded === 'number' &&
    typeof summary.totalDeleted === 'number'
  ) {
    return `${base} +${summary.totalAdded}/-${summary.totalDeleted}`
  }
  return base
}

interface FilesSummaryTooltipBodyProps {
  summary: PullRequestChangesSummary | undefined
  isLoading: boolean
  errorMessage: string | undefined
  hasBeenHovered: boolean
  canFetch: boolean
}

function FilesSummaryTooltipBody({
  summary,
  isLoading,
  errorMessage,
  hasBeenHovered,
  canFetch
}: FilesSummaryTooltipBodyProps): ReactNode {
  if (!canFetch) {
    return (
      <Box sx={{ p: 1 }}>
        <Typography variant="caption" color="text.secondary">
          File changes are unavailable for this PR.
        </Typography>
      </Box>
    )
  }
  // Defensive — Tooltip only opens after the enter delay (which is
  // also when we flip `hasBeenHovered`), so this branch shouldn't
  // render in practice. Guarding anyway so a future Tooltip change
  // can't surface a misleading "no files" panel.
  if (!hasBeenHovered) return null
  if (errorMessage) {
    return (
      <Box sx={{ p: 1 }}>
        <Typography variant="caption" color="warning.main">
          Couldn’t load file changes: {errorMessage}
        </Typography>
      </Box>
    )
  }
  if (isLoading || !summary) {
    return (
      <Box sx={{ p: 1, width: 280 }}>
        <Skeleton variant="text" width="60%" height={16} />
        <Stack spacing={0.5} sx={{ mt: 0.5 }}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} variant="text" width="100%" height={14} />
          ))}
        </Stack>
      </Box>
    )
  }
  if (summary.totalFiles === 0) {
    return (
      <Box sx={{ p: 1 }}>
        <Typography variant="caption" color="text.secondary">
          No file changes in the latest iteration.
        </Typography>
      </Box>
    )
  }

  const visibleFiles = summary.files.slice(0, MAX_TOOLTIP_ROWS)
  const overflowCount = summary.totalFiles - visibleFiles.length
  const hasLineCounts =
    typeof summary.totalAdded === 'number' &&
    typeof summary.totalDeleted === 'number'

  return (
    <Box sx={{ p: 1 }}>
      <Typography
        variant="caption"
        sx={{ fontWeight: 600, color: 'text.primary' }}
      >
        {summary.totalFiles} file{summary.totalFiles === 1 ? '' : 's'} changed
        {hasLineCounts &&
          ` · +${summary.totalAdded}/-${summary.totalDeleted}`}
      </Typography>
      <Stack spacing={0.25} sx={{ mt: 0.5 }}>
        {visibleFiles.map((f, i) => (
          <FileRow key={`${f.path}-${i}`} change={f} />
        ))}
      </Stack>
      {overflowCount > 0 && (
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            mt: 0.5,
            fontStyle: 'italic',
            color: 'text.secondary'
          }}
        >
          …and {overflowCount} more file{overflowCount === 1 ? '' : 's'}
        </Typography>
      )}
    </Box>
  )
}

function FileRow({ change }: { change: AdoPullRequestChange }): JSX.Element {
  const { letter, color } = glyphFor(change.changeType)
  const hasLineCounts =
    typeof change.addedLines === 'number' &&
    typeof change.deletedLines === 'number'

  return (
    <Stack
      direction="row"
      spacing={0.75}
      alignItems="center"
      sx={{ minWidth: 0 }}
    >
      <Box
        sx={{
          flex: '0 0 auto',
          width: 14,
          height: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'monospace',
          fontSize: 11,
          fontWeight: 700,
          color
        }}
      >
        {letter}
      </Box>
      <Typography
        variant="caption"
        title={change.path}
        sx={{
          // RTL trick: keep the basename visible while overflow
          // ellipses chew into the *front* of long paths. The text
          // itself is still left-to-right; setting `direction: rtl`
          // just flips which end the ellipsis eats from. The native
          // `title` attribute exposes the unmodified path on hover.
          flex: '1 1 auto',
          minWidth: 0,
          fontSize: 11,
          fontFamily: 'monospace',
          direction: 'rtl',
          textAlign: 'left',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {change.path}
      </Typography>
      {hasLineCounts && (
        <Typography
          variant="caption"
          sx={{
            flex: '0 0 auto',
            fontSize: 10,
            fontFamily: 'monospace',
            color: 'text.secondary'
          }}
        >
          (+{change.addedLines}/-{change.deletedLines})
        </Typography>
      )}
    </Stack>
  )
}
