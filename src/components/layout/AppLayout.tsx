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
import HomeIcon from '@mui/icons-material/Home'
import MenuBookIcon from '@mui/icons-material/MenuBook'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import LightModeIcon from '@mui/icons-material/LightMode'
import DarkModeIcon from '@mui/icons-material/DarkMode'
import SettingsBrightnessIcon from '@mui/icons-material/SettingsBrightness'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import styled from 'styled-components'
import {
  useClearConnectionMutation,
  useGetConnectionQuery
} from '@/store/api/adoApi'
import { useAppDispatch, useAppSelector } from '@/store'
import {
  selectSidebarCollapsed,
  selectThemeMode,
  setThemeMode,
  toggleSidebarCollapsed,
  type ThemeMode
} from '@/store/preferencesSlice'
import WorkItemDrawer from '@/components/workItem/WorkItemDrawer'
import WorkItemSearchBox from '@/components/layout/WorkItemSearchBox'

const SIDEBAR_WIDTH_EXPANDED = 240
const SIDEBAR_WIDTH_COLLAPSED = 64

interface CollapsibleProps {
  $collapsed: boolean
}

const Shell = styled.div<CollapsibleProps>`
  display: grid;
  grid-template-columns: ${({ $collapsed }) =>
      $collapsed ? `${SIDEBAR_WIDTH_COLLAPSED}px` : `${SIDEBAR_WIDTH_EXPANDED}px`} 1fr;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  transition: grid-template-columns 180ms ease;
`

const Sidebar = styled.aside`
  border-right: 1px solid ${({ theme }) => theme?.palette?.divider ?? 'rgba(0, 0, 0, 0.08)'};
  background: ${({ theme }) => theme?.palette?.background?.paper ?? '#ffffff'};
  display: flex;
  flex-direction: column;
  overflow: hidden;
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
  { to: '/home', label: 'Home', icon: <HomeIcon /> },
  { to: '/visualize', label: 'Visualize', icon: <InsightsIcon /> },
  { to: '/sprint', label: 'Sprint', icon: <DirectionsRunIcon /> },
  { to: '/wiki', label: 'Wiki', icon: <MenuBookIcon /> },
  { to: '/claude/sessions', label: 'Claude', icon: <AutoAwesomeIcon /> }
]

const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System'
}

/** Cycle order surfaces all three options without needing a menu. */
const NEXT_THEME_MODE: Record<ThemeMode, ThemeMode> = {
  light: 'dark',
  dark: 'system',
  system: 'light'
}

function themeModeIcon(mode: ThemeMode): JSX.Element {
  if (mode === 'light') return <LightModeIcon fontSize="small" />
  if (mode === 'dark') return <DarkModeIcon fontSize="small" />
  return <SettingsBrightnessIcon fontSize="small" />
}

export default function AppLayout(): JSX.Element {
  const { data: connection } = useGetConnectionQuery()
  const [clearConnection] = useClearConnectionMutation()
  const navigate = useNavigate()
  const location = useLocation()
  const dispatch = useAppDispatch()
  const workspace = useAppSelector((s) => s.workspace)
  const themeMode = useAppSelector(selectThemeMode)
  const nextThemeMode = NEXT_THEME_MODE[themeMode]
  const sidebarCollapsed = useAppSelector(selectSidebarCollapsed)

  // Sprint reads only project + team — the workspace query source is
  // irrelevant there, so don't show the source chip or the "pick a query"
  // hint on that route. Home and Wiki have their own pickers / scope.
  const showQueryContext =
    !location.pathname.startsWith('/sprint') &&
    !location.pathname.startsWith('/home') &&
    !location.pathname.startsWith('/wiki')

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
    <Shell $collapsed={sidebarCollapsed}>
      <Sidebar>
        <Box
          sx={{
            px: sidebarCollapsed ? 1 : 2,
            py: 1.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: sidebarCollapsed ? 'center' : 'space-between',
            gap: 1,
            minHeight: 56
          }}
        >
          {!sidebarCollapsed && (
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h6" sx={{ fontWeight: 600, lineHeight: 1.2 }} noWrap>
                Workthread
              </Typography>
              {orgLabel && (
                <Typography variant="caption" color="text.secondary" noWrap component="div">
                  {orgLabel}
                </Typography>
              )}
            </Box>
          )}
          <Tooltip
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            placement="right"
          >
            <IconButton
              size="small"
              onClick={() => dispatch(toggleSidebarCollapsed())}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {sidebarCollapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
            </IconButton>
          </Tooltip>
        </Box>
        <Divider />
        <List sx={{ flex: 1, py: 1 }}>
          {NAV.map((entry) => {
            const button = (
              <ListItemButton
                key={entry.to}
                component={NavLink}
                to={entry.to}
                sx={{
                  mx: sidebarCollapsed ? 0.5 : 1,
                  px: sidebarCollapsed ? 0 : 1.5,
                  minHeight: 44,
                  borderRadius: 1,
                  justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                  '&.active': {
                    bgcolor: 'action.selected',
                    borderLeft: sidebarCollapsed ? 'none' : '3px solid',
                    borderColor: 'primary.main'
                  }
                }}
              >
                <ListItemIcon
                  sx={{
                    minWidth: 0,
                    mr: sidebarCollapsed ? 0 : 1.5,
                    justifyContent: 'center'
                  }}
                >
                  {entry.icon}
                </ListItemIcon>
                {!sidebarCollapsed && <ListItemText primary={entry.label} />}
              </ListItemButton>
            )
            return sidebarCollapsed ? (
              <Tooltip key={entry.to} title={entry.label} placement="right">
                {button}
              </Tooltip>
            ) : (
              button
            )
          })}
        </List>
        <Divider />
        <Box
          sx={{
            p: sidebarCollapsed ? 1 : 2,
            display: 'flex',
            gap: 1,
            alignItems: 'center',
            justifyContent: sidebarCollapsed ? 'center' : 'flex-start'
          }}
        >
          <Tooltip
            title="Sign out (clear PAT)"
            placement={sidebarCollapsed ? 'right' : 'top'}
          >
            <IconButton
              onClick={async () => {
                await clearConnection().unwrap()
                navigate('/connect', { replace: true })
              }}
            >
              <LogoutIcon />
            </IconButton>
          </Tooltip>
          {!sidebarCollapsed && (
            <Typography variant="caption" color="text.secondary" noWrap>
              {connection?.hasToken ? 'Connected' : 'Not connected'}
            </Typography>
          )}
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
                  Pick a query in Home to start visualizing.
                </Typography>
              )}
            </Box>
            <WorkItemSearchBox />
            <Tooltip
              title={`Theme: ${THEME_MODE_LABEL[themeMode]} · Click for ${THEME_MODE_LABEL[nextThemeMode]}`}
            >
              <IconButton
                onClick={() => dispatch(setThemeMode(nextThemeMode))}
                aria-label={`Theme: ${THEME_MODE_LABEL[themeMode]}. Click to switch to ${THEME_MODE_LABEL[nextThemeMode]}.`}
              >
                {themeModeIcon(themeMode)}
              </IconButton>
            </Tooltip>
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
