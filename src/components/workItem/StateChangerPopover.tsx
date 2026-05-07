import { useMemo } from 'react'
import {
  Box,
  Chip,
  CircularProgress,
  Popover,
  Stack,
  Typography
} from '@mui/material'
import CheckIcon from '@mui/icons-material/Check'
import { useGetWorkItemTypeStatesQuery } from '@/store/api/adoApi'
import { readableTextColor } from '@/utils/adoColors'
import type { AdoWorkItemTypeState } from '@shared/adoTypes'

/**
 * Stable colour palette for ADO state *categories*. The category field
 * (`Proposed` / `InProgress` / `Resolved` / `Completed` / `Removed`)
 * survives process customisation, so colouring against it gives a
 * consistent look across orgs that have renamed the underlying state
 * names. The renderer's `colorForState` palette matches state *names*
 * — fine for the inline drawer chip where the names are well-known,
 * but the popover lists arbitrary process-customised states so we
 * fall back to the category here.
 *
 * Hex values are picked to roughly mirror the ADO web palette without
 * tying to a specific theme; readableTextColor covers contrast on
 * top of them.
 */
const CATEGORY_COLORS: Record<string, string> = {
  Proposed: '#2563EB', // blue
  InProgress: '#7C3AED', // purple
  Resolved: '#F59E0B', // orange
  Completed: '#10B981', // green
  Removed: '#6B7280' // grey
}

function colorForCategory(category: string | undefined): string {
  if (!category) return '#6B7280'
  return CATEGORY_COLORS[category] ?? '#6B7280'
}

interface StateChangerPopoverProps {
  open: boolean
  anchorEl: HTMLElement | null
  onClose: () => void
  /** The state currently shown on the work item. Highlighted with a check. */
  currentState: string
  /** Used to scope the type-states query. */
  projectId: string
  /** Used to scope the type-states query. Passed through verbatim. */
  workItemType: string
  /** Whether a transition is in flight — disables further clicks. */
  pending: boolean
  /** Called with the chosen state name. The current state is filtered
   *  out at the call site so this only fires for actual transitions. */
  onPick: (newState: string) => void
}

/**
 * Popover anchored to the drawer's state pill. Lists the valid next
 * `System.State` values for this work-item-type/project, coloured by
 * their stable ADO category. Clicking a state fires `onPick` and the
 * caller is responsible for actually invoking the mutation; this
 * component is intentionally state-less beyond the popover's open
 * flag so the parent can drive optimistic UI / error handling without
 * having to push state down here.
 *
 * Loading and empty/error states are inlined so the popover never
 * shows blank — it either lists states, shows a small shimmer, or
 * tells the user the lookup failed.
 */
export default function StateChangerPopover({
  open,
  anchorEl,
  onClose,
  currentState,
  projectId,
  workItemType,
  pending,
  onPick
}: StateChangerPopoverProps): JSX.Element {
  const statesQ = useGetWorkItemTypeStatesQuery(
    { projectId, workItemType },
    // Skip the network call until the popover actually opens — the
    // user may never click the chip, and 1 hour of cache lifetime
    // means the first open per session is the only round-trip anyway.
    { skip: !open || !projectId || !workItemType }
  )

  const states = useMemo<AdoWorkItemTypeState[]>(
    () => statesQ.data?.states ?? [],
    [statesQ.data]
  )

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      slotProps={{
        paper: {
          sx: { p: 1, minWidth: 200, maxWidth: 280 }
        }
      }}
    >
      <Stack spacing={0.5}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            px: 0.5,
            pb: 0.25
          }}
        >
          Change state
        </Typography>

        {statesQ.isLoading && (
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ px: 1, py: 1.5 }}
          >
            <CircularProgress size={14} />
            <Typography variant="caption" color="text.secondary">
              Loading states…
            </Typography>
          </Stack>
        )}

        {statesQ.error != null && (
          <Typography
            variant="caption"
            color="error"
            sx={{ px: 1, py: 1, display: 'block' }}
          >
            Couldn't load valid states.
          </Typography>
        )}

        {!statesQ.isLoading &&
          !statesQ.error &&
          states.length === 0 && (
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ px: 1, py: 1, display: 'block' }}
            >
              No states available.
            </Typography>
          )}

        {states.map((s) => {
          const isCurrent = s.name === currentState
          const bg = colorForCategory(s.category)
          const fg = readableTextColor(bg)
          return (
            <Box
              key={s.name}
              role="button"
              tabIndex={pending ? -1 : 0}
              aria-disabled={pending}
              onClick={() => {
                if (pending) return
                if (isCurrent) {
                  onClose()
                  return
                }
                onPick(s.name)
              }}
              onKeyDown={(e) => {
                if (pending) return
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                if (isCurrent) {
                  onClose()
                  return
                }
                onPick(s.name)
              }}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 0.75,
                py: 0.5,
                borderRadius: 1,
                cursor: pending ? 'wait' : 'pointer',
                opacity: pending ? 0.6 : 1,
                transition: 'background-color 120ms',
                '&:hover': pending
                  ? undefined
                  : { bgcolor: 'action.hover' }
              }}
            >
              <Chip
                size="small"
                label={s.name}
                sx={{
                  bgcolor: bg,
                  color: fg,
                  fontWeight: 600,
                  height: 22,
                  '& .MuiChip-label': { px: 0.75, fontSize: 11 }
                }}
              />
              {s.category && s.category !== s.name && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ flex: 1, fontSize: 10 }}
                >
                  {s.category}
                </Typography>
              )}
              {isCurrent && (
                <CheckIcon
                  fontSize="small"
                  color="primary"
                  sx={{ ml: 'auto', fontSize: 16 }}
                />
              )}
            </Box>
          )
        })}
      </Stack>
    </Popover>
  )
}
