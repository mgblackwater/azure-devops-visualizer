import { useMemo, useState } from 'react'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin from '@fullcalendar/interaction'
import type { EventInput, EventDropArg } from '@fullcalendar/core'
import {
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography
} from '@mui/material'
import { applyTypeFilter, useWorkItems } from '@/hooks/useWorkItems'
import { useAppDispatch, useAppSelector } from '@/store'
import { selectWorkItem } from '@/store/workspaceSlice'
import { usePatchWorkItemMutation } from '@/store/api/adoApi'
import TypeFilter from './TypeFilter'
import {
  getStartDate,
  getState,
  getTargetDate,
  getTitle,
  getType
} from '@/utils/workItemFields'
import { colorForState, colorForType, readableTextColor } from '@/utils/adoColors'
import EmptyState from './EmptyState'

type ColorMode = 'type' | 'state'

export default function CalendarView(): JSX.Element {
  const raw = useWorkItems()
  const { source, projectId, hiddenTypes } = useAppSelector((s) => s.workspace)
  const filtered = useMemo(() => applyTypeFilter(raw, hiddenTypes), [raw, hiddenTypes])
  const { items, isLoading, isFetching, error } = filtered
  const dispatch = useAppDispatch()
  const [colorMode, setColorMode] = useState<ColorMode>('type')
  const [patch] = usePatchWorkItemMutation()

  const events = useMemo<EventInput[]>(() => {
    const out: EventInput[] = []
    for (const w of items) {
      const start = getStartDate(w)
      const target = getTargetDate(w)
      if (!start && !target) continue
      const startDate = start ?? target!
      const endDate = target ?? start!
      const type = getType(w)
      const state = getState(w)
      const bg = colorMode === 'type' ? colorForType(type) : colorForState(state)
      const fg = readableTextColor(bg)
      out.push({
        id: String(w.id),
        title: `#${w.id} ${getTitle(w)}`,
        start: startDate,
        end: new Date(endDate.getTime() + 24 * 60 * 60 * 1000),
        allDay: true,
        backgroundColor: bg,
        borderColor: bg,
        textColor: fg,
        extendedProps: { type, state, hasStart: !!start, hasTarget: !!target }
      })
    }
    return out
  }, [items, colorMode])

  async function handleEventDrop(arg: EventDropArg): Promise<void> {
    const id = Number(arg.event.id)
    if (!Number.isFinite(id)) {
      arg.revert()
      return
    }
    const start = arg.event.start
    const endExclusive = arg.event.end ?? new Date((start?.getTime() ?? 0) + 86400000)
    if (!start) {
      arg.revert()
      return
    }
    const newTarget = new Date(endExclusive.getTime() - 86400000)
    try {
      await patch({
        projectId: projectId ?? undefined,
        id,
        patch: [
          {
            op: 'add',
            path: '/fields/Microsoft.VSTS.Scheduling.StartDate',
            value: start.toISOString()
          },
          {
            op: 'add',
            path: '/fields/Microsoft.VSTS.Scheduling.TargetDate',
            value: newTarget.toISOString()
          }
        ]
      }).unwrap()
    } catch {
      arg.revert()
    }
  }

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        sx={{ p: 1.5, borderBottom: '1px solid rgba(0,0,0,0.08)', flexWrap: 'wrap', rowGap: 1 }}
      >
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="calendar-color">Color by</InputLabel>
          <Select
            labelId="calendar-color"
            label="Color by"
            value={colorMode}
            onChange={(e) => setColorMode(e.target.value as ColorMode)}
          >
            <MenuItem value="type">Work item type</MenuItem>
            <MenuItem value="state">State</MenuItem>
          </Select>
        </FormControl>
        <TypeFilter items={raw.items} compact />
        <Typography variant="body2" color="text.secondary" sx={{ ml: 'auto' }}>
          {events.length}/{items.length} items have schedule dates · drag to reschedule
        </Typography>
      </Stack>
      <Box sx={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'auto' }}>
        <EmptyState
          hasSource={!!source}
          isLoading={isLoading}
          isFetching={isFetching}
          error={error}
          count={items.length}
          emptyHint="Add Start/Target dates on items in Azure DevOps to see them here."
        />
        <Box sx={{ p: 2, height: '100%' }}>
          <FullCalendar
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView="dayGridMonth"
            headerToolbar={{
              start: 'prev,next today',
              center: 'title',
              end: 'dayGridMonth,timeGridWeek'
            }}
            height="100%"
            events={events}
            editable
            eventDrop={handleEventDrop}
            eventClick={(info) => {
              const id = Number(info.event.id)
              if (Number.isFinite(id)) dispatch(selectWorkItem(id))
            }}
            displayEventTime={false}
          />
        </Box>
      </Box>
    </Box>
  )
}
