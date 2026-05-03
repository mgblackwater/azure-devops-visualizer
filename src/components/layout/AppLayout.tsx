import { useMemo } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  AppBar,
  Box,
  Chip,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Tooltip,
  Typography
} from '@mui/material'
import LogoutIcon from '@mui/icons-material/Logout'
import RefreshIcon from '@mui/icons-material/Refresh'
import InsightsIcon from '@mui/icons-material/Insights'
import DirectionsRunIcon from '@mui/icons-material/DirectionsRun'
import TuneIcon from '@mui/icons-material/Tune'
import styled from 'styled-components'
import {
  useClearConnectionMutation,
  useGetConnectionQuery
} from '@/store/api/adoApi'
import { useAppSelector } from '@/store'
import WorkItemDrawer from '@/components/workItem/WorkItemDrawer'
import WorkItemSearchBox from '@/components/layout/WorkItemSearchBox'

const Shell = styled.div`
  display: grid;
  grid-template-columns: 240px 1fr;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
`

const Sidebar = styled.aside`
  border-right: 1px solid rgba(0, 0, 0, 0.08);
  background: ${({ theme }) => theme?.palette?.background?.paper ?? '#ffffff'};
  display: flex;
  flex-direction: column;
`

const Content = styled.main`
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
`

const ViewArea = styled.div`
  flex: 1;
  overflow: hidden;
  display: flex;
  min-height: 0;
`

interface NavEntry {
  to: string
  label: string
  icon: JSX.Element
}

const NAV: NavEntry[] = [
  { to: '/workspace', label: 'Workspace', icon: <TuneIcon /> },
  { to: '/visualize', label: 'Visualize', icon: <InsightsIcon /> },
  { to: '/sprint', label: 'Sprint', icon: <DirectionsRunIcon /> }
]

export default function AppLayout(): JSX.Element {
  const { data: connection } = useGetConnectionQuery()
  const [clearConnection] = useClearConnectionMutation()
  const navigate = useNavigate()
  const location = useLocation()
  const workspace = useAppSelector((s) => s.workspace)

  // Sprint reads only project + team — the workspace query source is
  // irrelevant there, so don't show the source chip or the "pick a query"
  // hint on that route. Workspace page has its own pickers.
  const showQueryContext =
    !location.pathname.startsWith('/sprint') &&
    !location.pathname.startsWith('/workspace')

  const orgLabel = useMemo(() => {
    if (!connection?.organizationUrl) return ''
    try {
      const u = new URL(connection.organizationUrl)
      const parts = u.pathname.split('/').filter(Boolean)
      return parts[parts.length - 1] || u.host
    } catch {
      return connection.organizationUrl
    }
  }, [connection?.organizationUrl])

  return (
    <Shell>
      <Sidebar>
        <Box sx={{ px: 2, py: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            ADO Visualizer
          </Typography>
          {orgLabel && (
            <Typography variant="caption" color="text.secondary">
              {orgLabel}
            </Typography>
          )}
        </Box>
        <Divider />
        <List sx={{ flex: 1 }}>
          {NAV.map((entry) => (
            <ListItemButton
              key={entry.to}
              component={NavLink}
              to={entry.to}
              sx={{
                '&.active': {
                  bgcolor: 'action.selected',
                  borderLeft: '3px solid',
                  borderColor: 'primary.main'
                }
              }}
            >
              <ListItemIcon sx={{ minWidth: 36 }}>{entry.icon}</ListItemIcon>
              <ListItemText primary={entry.label} />
            </ListItemButton>
          ))}
        </List>
        <Divider />
        <Box sx={{ p: 2, display: 'flex', gap: 1, alignItems: 'center' }}>
          <Tooltip title="Sign out (clear PAT)">
            <IconButton
              onClick={async () => {
                await clearConnection().unwrap()
                navigate('/connect', { replace: true })
              }}
            >
              <LogoutIcon />
            </IconButton>
          </Tooltip>
          <Typography variant="caption" color="text.secondary">
            {connection?.hasToken ? 'Connected' : 'Not connected'}
          </Typography>
        </Box>
      </Sidebar>
      <Content>
        <AppBar position="static">
          <Toolbar
            variant="dense"
            sx={{
              gap: 1,
              // Let the toolbar grow when the chips wrap on narrow windows;
              // otherwise wrapped chips end up hidden under the toolbar
              // bottom because Toolbar.minHeight is fixed.
              minHeight: 'unset !important',
              flexWrap: 'wrap',
              rowGap: 1,
              py: 0.5
            }}
          >
            <Box
              sx={{
                flex: 1,
                display: 'flex',
                gap: 1,
                alignItems: 'center',
                minWidth: 0,
                flexWrap: 'wrap'
              }}
            >
              {workspace.projectName && (
                <Tooltip title={workspace.projectName}>
                  <Chip
                    label={workspace.projectName}
                    color="primary"
                    variant="outlined"
                    sx={{ maxWidth: 220 }}
                  />
                </Tooltip>
              )}
              {workspace.teamName && (
                <Tooltip title={workspace.teamName}>
                  <Chip
                    label={workspace.teamName}
                    variant="outlined"
                    sx={{ maxWidth: 200 }}
                  />
                </Tooltip>
              )}
              {showQueryContext && workspace.source && (
                <Tooltip
                  title={
                    workspace.source.kind === 'savedQuery'
                      ? workspace.source.queryName ?? 'Saved query'
                      : workspace.source.label ?? 'WIQL'
                  }
                >
                  <Chip
                    label={
                      workspace.source.kind === 'savedQuery'
                        ? workspace.source.queryName ?? 'Saved query'
                        : workspace.source.label ?? 'WIQL'
                    }
                    variant="outlined"
                    sx={{ maxWidth: 220 }}
                  />
                </Tooltip>
              )}
              {showQueryContext && !workspace.source && (
                <Typography variant="body2" color="text.secondary">
                  Pick a query in the Workspace tab to start visualizing.
                </Typography>
              )}
            </Box>
            <WorkItemSearchBox />
            <Tooltip title="Refresh data">
              <IconButton onClick={() => window.location.reload()}>
                <RefreshIcon />
              </IconButton>
            </Tooltip>
          </Toolbar>
        </AppBar>
        <ViewArea>
          <Outlet />
        </ViewArea>
        <WorkItemDrawer />
      </Content>
    </Shell>
  )
}
