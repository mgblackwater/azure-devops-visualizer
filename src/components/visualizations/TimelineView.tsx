import { useEffect, useMemo, useRef, useState } from 'react'
import { DataSet } from 'vis-data'
import {
  Timeline,
  type DataGroupCollectionType,
  type DataItemCollectionType,
  type TimelineOptions
} from 'vis-timeline/standalone'
import type { TimelineItem as VisItem, TimelineGroup as VisGroup } from 'vis-timeline'
import {
  Box,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import { applyTypeFilter, useWorkItems } from '@/hooks/useWorkItems'
import { useAppDispatch, useAppSelector } from '@/store'
import { selectWorkItem, setGroupBy } from '@/store/workspaceSlice'
import {
  useListIterationsQuery,
  usePatchWorkItemMutation
} from '@/store/api/adoApi'
import TypeFilter from './TypeFilter'
import {
  getAssigneeName,
  getIterationPath,
  getStartDate,
  getState,
  getTargetDate,
  getTitle,
  getType
} from '@/utils/workItemFields'
import { colorForType, readableTextColor } from '@/utils/adoColors'
import EmptyState from './EmptyState'
import type { AdoWorkItem } from '@shared/adoTypes'

function groupKeyFor(
  w: AdoWorkItem,
  group: 'iteration' | 'assignee' | 'state' | 'type' | 'none'
): string {
  switch (group) {
    case 'iteration':
      return getIterationPath(w) || 'No iteration'
    case 'assignee':
      return getAssigneeName(w)
    case 'state':
      return getState(w)
    case 'type':
      return getType(w)
    default:
      return 'All'
  }
}

type DateSource = 'auto' | 'schedule' | 'iteration'

interface IterationRange {
  start: Date
  end: Date
}

function scheduleDates(w: AdoWorkItem): IterationRange | null {
  const start = getStartDate(w)
  const end = getTargetDate(w)
  if (start && end) return { start, end }
  if (end) {
    const s = new Date(end.getTime() - 24 * 60 * 60 * 1000)
    return { start: s, end }
  }
  if (start) {
    const e = new Date(start.getTime() + 24 * 60 * 60 * 1000)
    return { start, end: e }
  }
  return null
}

function iterationDates(
  w: AdoWorkItem,
  byPath: Map<string, IterationRange>
): IterationRange | null {
  const path = getIterationPath(w)
  if (!path) return null
  return byPath.get(path) ?? null
}

const VIS_OPTIONS: TimelineOptions = {
  stack: true,
  editable: { add: false, updateTime: true, updateGroup: false, remove: false, overrideItems: true },
  zoomMin: 1000 * 60 * 60 * 24,
  zoomMax: 1000 * 60 * 60 * 24 * 365 * 3,
  margin: { item: 6 },
  orientation: { axis: 'top', item: 'top' },
  height: '100%',
  selectable: true,
  multiselect: false,
  tooltip: { followMouse: true }
}

export default function TimelineView(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const timelineRef = useRef<Timeline | null>(null)
  const itemsDsRef = useRef<DataSet<VisItem> | null>(null)
  const groupsDsRef = useRef<DataSet<VisGroup> | null>(null)

  const raw = useWorkItems()
  const { source, projectId, teamId, groupBy, hiddenTypes } = useAppSelector(
    (s) => s.workspace
  )
  const filtered = useMemo(() => applyTypeFilter(raw, hiddenTypes), [raw, hiddenTypes])
  const { items, isLoading, isFetching, error } = filtered
  const dispatch = useAppDispatch()
  const [patch] = usePatchWorkItemMutation()
  const [dateSource, setDateSource] = useState<DateSource>('auto')

  // Pull iterations so we can plot items that don't have explicit
  // Start/Target dates (the common case).
  const iterationsQ = useListIterationsQuery(
    projectId ? { projectId, teamId: teamId ?? undefined } : (undefined as never),
    { skip: !projectId }
  )

  /** Lookup table: full iteration path → {start, end}. */
  const iterByPath = useMemo<Map<string, IterationRange>>(() => {
    const out = new Map<string, IterationRange>()
    for (const it of iterationsQ.data ?? []) {
      const s = it.attributes?.startDate
      const e = it.attributes?.finishDate
      if (!s || !e) continue
      out.set(it.path, { start: new Date(s), end: new Date(e) })
    }
    return out
  }, [iterationsQ.data])

  const { visItems, visGroups, datedCount, scheduleCount, iterationCount } =
    useMemo(() => {
      const visItems: VisItem[] = []
      const groupSet = new Map<string, VisGroup>()
      let datedCount = 0
      let scheduleCount = 0
      let iterationCount = 0

      for (const w of items) {
        // Track the source we ended up using (just for the toolbar
        // breakdown chip — helps the user diagnose why their item is
        // missing if neither source resolves).
        const sched = scheduleDates(w)
        const iter = iterationDates(w, iterByPath)
        let dates: IterationRange | null = null
        if (dateSource === 'schedule') dates = sched
        else if (dateSource === 'iteration') dates = iter
        else dates = sched ?? iter
        if (!dates) continue
        datedCount += 1
        if (sched && (dateSource !== 'iteration')) scheduleCount += 1
        else if (iter) iterationCount += 1

        const groupKey = groupKeyFor(w, groupBy)
        if (!groupSet.has(groupKey)) {
          groupSet.set(groupKey, { id: groupKey, content: groupKey })
        }
        const bg = colorForType(getType(w))
        const fg = readableTextColor(bg)
        // Indicate items that fell back to iteration dates with a dashed
        // border so the user can tell at a glance which bars are real
        // schedule dates vs derived from sprint dates.
        const fellBackToIteration =
          dateSource !== 'schedule' && !sched && !!iter
        const borderStyle = fellBackToIteration ? 'dashed' : 'solid'
        visItems.push({
          id: w.id,
          group: groupBy === 'none' ? undefined : groupKey,
          start: dates.start,
          end: dates.end,
          content: `<strong>#${w.id}</strong> ${escapeHtml(getTitle(w))}`,
          title: `${getType(w)} · ${getState(w)} · ${getAssigneeName(w)}${
            fellBackToIteration ? ' · iteration dates' : ''
          }`,
          style: `background-color: ${bg}; color: ${fg}; border-color: ${bg}; border-style: ${borderStyle};`
        })
      }

      return {
        visItems,
        visGroups: groupBy === 'none' ? [] : Array.from(groupSet.values()),
        datedCount,
        scheduleCount,
        iterationCount
      }
    }, [items, groupBy, dateSource, iterByPath])

  useEffect(() => {
    if (!containerRef.current || timelineRef.current) return
    itemsDsRef.current = new DataSet<VisItem>([])
    groupsDsRef.current = new DataSet<VisGroup>([])
    timelineRef.current = new Timeline(
      containerRef.current,
      // vis-data and vis-timeline ship slightly different DataSet generics; the
      // runtime is identical so we cast through unknown.
      itemsDsRef.current as unknown as DataItemCollectionType,
      groupsDsRef.current as unknown as DataGroupCollectionType,
      VIS_OPTIONS
    )
    timelineRef.current.on('select', (props: { items: Array<string | number> }) => {
      const id = Number(props.items[0])
      if (Number.isFinite(id)) dispatch(selectWorkItem(id))
    })

    return () => {
      timelineRef.current?.destroy()
      timelineRef.current = null
    }
  }, [dispatch])

  useEffect(() => {
    if (!timelineRef.current || !itemsDsRef.current || !groupsDsRef.current) return
    groupsDsRef.current.clear()
    if (visGroups.length > 0) groupsDsRef.current.add(visGroups)
    itemsDsRef.current.clear()
    if (visItems.length > 0) itemsDsRef.current.add(visItems)
    if (visItems.length > 0) timelineRef.current.fit()
  }, [visItems, visGroups])

  // Drag-to-reschedule handler. We attach via the `onMove` option whenever the
  // patch mutation reference changes so the closure stays current.
  useEffect(() => {
    if (!timelineRef.current) return
    timelineRef.current.setOptions({
      onMove: (item, callback) => {
        const id = Number(item.id)
        if (!Number.isFinite(id) || !item.start || !item.end) {
          callback(null)
          return
        }
        const startIso = new Date(item.start).toISOString()
        const endIso = new Date(item.end as Date).toISOString()
        patch({
          projectId: projectId ?? undefined,
          id,
          patch: [
            { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StartDate', value: startIso },
            { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.TargetDate', value: endIso }
          ]
        })
          .unwrap()
          .then(() => callback(item))
          .catch(() => callback(null))
      }
    } as Partial<TimelineOptions>)
  }, [patch, projectId])

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        sx={{ p: 1.5, borderBottom: '1px solid rgba(0,0,0,0.08)', flexWrap: 'wrap', rowGap: 1 }}
      >
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="timeline-datesource">Dates from</InputLabel>
          <Select
            labelId="timeline-datesource"
            label="Dates from"
            value={dateSource}
            onChange={(e) => setDateSource(e.target.value as DateSource)}
          >
            <MenuItem value="auto">Auto (schedule, then sprint)</MenuItem>
            <MenuItem value="schedule">Schedule dates only</MenuItem>
            <MenuItem value="iteration">Iteration / sprint dates</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="timeline-groupby">Group by</InputLabel>
          <Select
            labelId="timeline-groupby"
            label="Group by"
            value={groupBy}
            onChange={(e) => dispatch(setGroupBy(e.target.value as typeof groupBy))}
          >
            <MenuItem value="iteration">Iteration</MenuItem>
            <MenuItem value="assignee">Assignee</MenuItem>
            <MenuItem value="state">State</MenuItem>
            <MenuItem value="type">Type</MenuItem>
            <MenuItem value="none">None (single lane)</MenuItem>
          </Select>
        </FormControl>
        <TypeFilter items={raw.items} compact />
        <Stack direction="row" spacing={1} alignItems="center" sx={{ ml: 'auto' }}>
          <Tooltip
            title={
              dateSource === 'iteration'
                ? `${iterationCount} item(s) placed on sprint dates.`
                : dateSource === 'schedule'
                  ? `${scheduleCount} item(s) have explicit Start/Target dates.`
                  : `${scheduleCount} on schedule dates · ${iterationCount} on sprint dates (dashed border).`
            }
          >
            <Chip
              size="small"
              variant="outlined"
              label={`${datedCount}/${items.length} placed`}
              color={datedCount > 0 ? 'primary' : 'default'}
            />
          </Tooltip>
          <Typography variant="caption" color="text.secondary">
            drag bar to reschedule
          </Typography>
        </Stack>
      </Stack>
      <Box sx={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <EmptyState
          hasSource={!!source}
          isLoading={isLoading}
          isFetching={isFetching}
          error={error}
          count={items.length}
          emptyHint={
            dateSource === 'schedule'
              ? 'Add Start/Target dates on items in Azure DevOps, or switch "Dates from" to use sprint dates.'
              : 'No items have Start/Target dates and none are assigned to a sprint with start/finish dates configured.'
          }
        />
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      </Box>
    </Box>
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
