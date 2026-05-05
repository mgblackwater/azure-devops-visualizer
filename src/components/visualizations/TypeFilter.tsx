import { Box, Button, Chip, Stack, Tooltip, Typography } from '@mui/material'
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff'
import { useAppDispatch, useAppSelector } from '@/store'
import { resetTypeFilter, toggleType } from '@/store/workspaceSlice'
import { typeStats, type TypeStat } from '@/hooks/useWorkItems'
import { colorForType, readableTextColor } from '@/utils/adoColors'
import type { AdoWorkItem } from '@shared/adoTypes'

interface Props {
  /** Raw, unfiltered items for this workspace. Counts come from these. */
  items: AdoWorkItem[]
  compact?: boolean
}

/**
 * Chip bar of work-item types with their counts. Click a chip to hide that
 * type from the visualizations; click again to bring it back.
 */
export default function TypeFilter({ items, compact }: Props): JSX.Element | null {
  const dispatch = useAppDispatch()
  const hidden = useAppSelector((s) => s.workspace.hiddenTypes)
  const stats: TypeStat[] = typeStats(items)

  if (stats.length === 0) return null

  const hiddenCount = items.filter((w) =>
    hidden.includes((w.fields['System.WorkItemType'] as string | undefined) ?? '')
  ).length

  return (
    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
      {!compact && (
        <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
          Types:
        </Typography>
      )}
      {stats.map(({ type, count }) => {
        const isHidden = hidden.includes(type)
        const bg = colorForType(type)
        const fg = readableTextColor(bg)
        return (
          <Tooltip key={type} title={isHidden ? `Show ${type}` : `Hide ${type}`}>
            <Chip
              size="small"
              label={`${type} ${count}`}
              onClick={() => dispatch(toggleType(type))}
              icon={isHidden ? <VisibilityOffIcon style={{ fontSize: 14 }} /> : undefined}
              sx={(theme) => ({
                bgcolor: isHidden ? 'transparent' : bg,
                color: isHidden ? 'text.disabled' : fg,
                border: `1px solid ${
                  isHidden ? theme.palette.divider : bg
                }`,
                fontWeight: 600,
                opacity: isHidden ? 0.65 : 1,
                textDecoration: isHidden ? 'line-through' : 'none',
                '& .MuiChip-icon': { color: 'inherit', marginLeft: '6px' },
                '&:hover': {
                  bgcolor: isHidden ? 'action.hover' : bg,
                  filter: isHidden ? 'none' : 'brightness(1.05)'
                }
              })}
            />
          </Tooltip>
        )
      })}
      {hidden.length > 0 && (
        <>
          <Box sx={{ flex: '0 0 auto' }}>
            <Button size="small" onClick={() => dispatch(resetTypeFilter())}>
              Show all
            </Button>
          </Box>
          {!compact && (
            <Typography variant="caption" color="text.disabled">
              {hiddenCount} hidden
            </Typography>
          )}
        </>
      )}
    </Stack>
  )
}
