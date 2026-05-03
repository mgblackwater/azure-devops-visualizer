import { useEffect, useMemo } from 'react'
import {
  Box,
  Tab,
  Tabs
} from '@mui/material'
import { useNavigate, useSearchParams } from 'react-router-dom'
import TimelineIcon from '@mui/icons-material/Timeline'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted'
import HubIcon from '@mui/icons-material/Hub'
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth'
import TimelineView from '@/components/visualizations/TimelineView'
import GraphView from '@/components/visualizations/GraphView'
import HierarchyView from '@/components/visualizations/HierarchyView'
import TreeView from '@/components/visualizations/TreeView'
import CalendarView from '@/components/visualizations/CalendarView'
import { useAppSelector } from '@/store'

type ViewKey = 'tree' | 'hierarchy' | 'timeline' | 'graph' | 'calendar'

const VIEWS: ReadonlyArray<{
  key: ViewKey
  label: string
  icon: JSX.Element
}> = [
  { key: 'tree', label: 'Tree', icon: <FormatListBulletedIcon fontSize="small" /> },
  { key: 'hierarchy', label: 'Hierarchy', icon: <AccountTreeIcon fontSize="small" /> },
  { key: 'timeline', label: 'Timeline', icon: <TimelineIcon fontSize="small" /> },
  { key: 'graph', label: 'Dependency', icon: <HubIcon fontSize="small" /> },
  { key: 'calendar', label: 'Calendar', icon: <CalendarMonthIcon fontSize="small" /> }
]

function isViewKey(value: string | null): value is ViewKey {
  return !!value && VIEWS.some((v) => v.key === value)
}

/**
 * Single page that hosts all four visualizations behind a tab strip. The
 * active view is reflected in the `?view=` query param so refresh / deep
 * links land on the right tab. Workspace state (project / team / source)
 * is shared across tabs because every view reads from the same Redux slice.
 */
export default function VisualizePage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const projectId = useAppSelector((s) => s.workspace.projectId)
  const source = useAppSelector((s) => s.workspace.source)

  const view: ViewKey = useMemo(() => {
    const candidate = searchParams.get('view')
    return isViewKey(candidate) ? candidate : 'tree'
  }, [searchParams])

  // If someone hits this page without picking a workspace yet, push them to
  // the workspace setup page so the view doesn't render an empty state forever.
  useEffect(() => {
    if (!projectId || !source) {
      navigate('/workspace', { replace: true })
    }
  }, [projectId, source, navigate])

  function handleChange(_: unknown, next: ViewKey): void {
    const params = new URLSearchParams(searchParams)
    params.set('view', next)
    setSearchParams(params, { replace: true })
  }

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Tabs
        value={view}
        onChange={handleChange}
        variant="scrollable"
        scrollButtons="auto"
        sx={{
          minHeight: 40,
          borderBottom: '1px solid rgba(0,0,0,0.08)',
          '& .MuiTab-root': { minHeight: 40, py: 0.5, textTransform: 'none' }
        }}
      >
        {VIEWS.map((v) => (
          <Tab
            key={v.key}
            value={v.key}
            label={v.label}
            icon={v.icon}
            iconPosition="start"
          />
        ))}
      </Tabs>
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {view === 'timeline' && <TimelineView />}
        {view === 'hierarchy' && <HierarchyView />}
        {view === 'tree' && <TreeView />}
        {view === 'graph' && <GraphView direction="LR" />}
        {view === 'calendar' && <CalendarView />}
      </Box>
    </Box>
  )
}
