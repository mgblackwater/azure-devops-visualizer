import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material'
import PersonOutlineIcon from '@mui/icons-material/PersonOutline'
import LocalOfferIcon from '@mui/icons-material/LocalOffer'
import {
  getAssigneeName,
  getChangedDate,
  getState,
  getTags,
  getTitle,
  getType,
  typeBadge
} from '@/utils/workItemFields'
import { colorForState, colorForType, readableTextColor } from '@/utils/adoColors'
import type { AdoWorkItem } from '@shared/adoTypes'

/**
 * Compact, list-friendly row for a work item. Designed for "My work"-style
 * lists where many items need to be scanned at a glance, but every row
 * should still be visually rich enough to identify the item without
 * opening it: type badge, id, state pill, two-line title, assignee, tags,
 * and last-changed timestamp.
 *
 * Click anywhere on the row to invoke the click handler — the parent
 * decides whether that opens the drawer, focuses a subtree, etc.
 */
export interface WorkItemListRowProps {
  item: AdoWorkItem
  onClick?: (id: number) => void
  /**
   * Optional secondary actions (right-aligned). Typically a `<Stack>` of
   * `IconButton`s — use `e.stopPropagation()` inside their handlers so
   * the row click doesn't also fire.
   */
  rightSlot?: React.ReactNode
  /**
   * Override the right-aligned relative timestamp. Defaults to the work
   * item's `System.ChangedDate`. Used by the Mentions list so the badge
   * reads "mentioned 5h ago" (the comment timestamp) instead of the
   * generic last-modified time. Pass `null` to hide the timestamp
   * entirely (e.g. when no mention timestamp is known).
   */
  timestamp?:
    | { date: Date; tooltipPrefix?: string }
    | null
  /**
   * Optional secondary line rendered between the title and the
   * assignee/tags row. Used by the Mentions list to show a preview of
   * the matching comment so the user can tell at a glance why the item
   * is in the list.
   */
  subtitle?: React.ReactNode
}

export default function WorkItemListRow({
  item,
  onClick,
  rightSlot,
  timestamp,
  subtitle
}: WorkItemListRowProps): JSX.Element {
  const type = getType(item)
  const state = getState(item)
  const title = getTitle(item)
  const assignee = getAssigneeName(item)
  const tags = getTags(item)
  // `timestamp === undefined` → fall back to ChangedDate (the existing
  // behaviour). `timestamp === null` → caller explicitly suppressed it.
  // `timestamp === { date }` → caller-provided override (e.g. mention
  // time). This three-way switch keeps the default zero-config call site
  // working while allowing the Mentions list to show comment timestamps.
  const fallbackChanged = getChangedDate(item)
  const stamp: { date: Date; tooltipPrefix?: string } | null =
    timestamp === undefined
      ? fallbackChanged
        ? { date: fallbackChanged }
        : null
      : timestamp
  const typeColor = colorForType(type)
  const stateColor = colorForState(state)

  return (
    <Box
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick ? () => onClick(item.id) : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') onClick(item.id)
            }
          : undefined
      }
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.25,
        px: 1.5,
        py: 1,
        borderBottom: '1px solid',
        borderColor: 'divider',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'background-color 120ms',
        '&:hover': onClick ? { bgcolor: 'action.hover' } : undefined,
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
          <Chip
            size="small"
            label={typeBadge(type)}
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
            #{item.id}
          </Typography>
          <Chip
            size="small"
            label={state}
            sx={{
              bgcolor: stateColor,
              color: readableTextColor(stateColor),
              height: 20,
              fontWeight: 600,
              '& .MuiChip-label': { px: 0.75, fontSize: 10 }
            }}
          />
          {stamp && (
            <Tooltip
              title={
                stamp.tooltipPrefix
                  ? `${stamp.tooltipPrefix} ${stamp.date.toLocaleString()}`
                  : stamp.date.toLocaleString()
              }
            >
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontSize: 11, ml: 'auto' }}
              >
                {formatRelative(stamp.date)}
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
          {title}
        </Typography>
        {subtitle && <Box sx={{ minWidth: 0 }}>{subtitle}</Box>}
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ flexWrap: 'wrap', rowGap: 0.25 }}
        >
          {assignee && assignee !== 'Unassigned' && (
            <Stack direction="row" spacing={0.25} alignItems="center">
              <PersonOutlineIcon
                sx={{ fontSize: 12, color: 'text.secondary' }}
              />
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontSize: 11 }}
              >
                {assignee}
              </Typography>
            </Stack>
          )}
          {tags.length > 0 && (
            <Stack
              direction="row"
              spacing={0.25}
              alignItems="center"
              sx={{ flexWrap: 'wrap', rowGap: 0.25 }}
            >
              <LocalOfferIcon sx={{ fontSize: 11, color: 'text.secondary' }} />
              {tags.slice(0, 4).map((tag) => (
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
              {tags.length > 4 && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontSize: 10 }}
                >
                  +{tags.length - 4}
                </Typography>
              )}
            </Stack>
          )}
        </Stack>
      </Stack>
      {rightSlot && (
        <Box
          onClick={(e) => e.stopPropagation()}
          sx={{ display: 'flex', alignItems: 'center' }}
        >
          {rightSlot}
        </Box>
      )}
    </Box>
  )
}

/**
 * Compact human-friendly delta (e.g. "5m", "3h", "2d", "May 3"). Designed
 * for the right-aligned timestamp on a list row where every pixel of
 * vertical space matters.
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
  // Older than a week → calendar date in the user's locale.
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
