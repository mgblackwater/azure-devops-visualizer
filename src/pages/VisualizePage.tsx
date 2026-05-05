import { useEffect, useMemo } from 'react'
import {
  Alert,
  Box,
  Paper,
  Stack,
  Tab,
  Tabs,
  Typography
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
import QueryPicker from '@/components/query/QueryPicker'
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

  // If we don't even have a project yet, Home is the only place to pick
  // one — bounce there. When a project is set but the user hasn't chosen
  // a query/wiql yet, we render the inline picker below instead of
  // redirecting; the query picker now lives on this page so Home can
  // stay focused on "find work".
  useEffect(() => {
    if (!projectId) {
      navigate('/home', { replace: true })
    }
  }, [projectId, navigate])

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
          borderBottom: '1px solid',
          borderColor: 'divider',
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
        {!source ? (
          <PickQueryEmptyState />
        ) : (
          <>
            {view === 'timeline' && <TimelineView />}
            {view === 'hierarchy' && <HierarchyView />}
            {view === 'tree' && <TreeView />}
            {view === 'graph' && <GraphView direction="LR" />}
            {view === 'calendar' && <CalendarView />}
          </>
        )}
      </Box>
    </Box>
  )
}

/**
 * Empty-state shown when a project is selected but no source has been
 * loaded yet. Hosts the QueryPicker inline so users can still pick a
 * saved ADO query or paste WIQL without leaving this page — the
 * visualisations then render directly into the same tab strip above.
 *
 * This replaces the old workflow where Workspace owned the query picker
 * and a launcher; the search box (header) and "View in tree view"
 * (drawer) now cover most cases, and this picker handles the rest.
 */
function PickQueryEmptyState(): JSX.Element {
  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 3 }}>
      <Stack spacing={2} sx={{ maxWidth: 720, mx: 'auto' }}>
        <Box>
          <Typography variant="h6" gutterBottom>
            Pick what to visualize
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Load a saved Azure DevOps query or paste your own WIQL — the
            same data feeds every tab above. You can also use the search
            box in the header to load specific work items by id, or open
            an item and click "View in tree view".
          </Typography>
        </Box>
        <Paper sx={{ p: 2 }}>
          <QueryPicker />
        </Paper>
        <Alert severity="info" variant="outlined">
          Tip: Sprint view runs independently — go straight to it from the
          sidebar without picking a query here.
        </Alert>
      </Stack>
    </Box>
  )
}
