import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Box, CircularProgress } from '@mui/material'
import { useGetConnectionQuery, useListProjectsQuery } from './store/api/adoApi'
import { useAppDispatch, useAppSelector } from './store'
import { selectDefaultProjectId } from './store/preferencesSlice'
import { setProject } from './store/workspaceSlice'
import { useWorkspacePersistence } from './hooks/useWorkspacePersistence'
import AppLayout from './components/layout/AppLayout'
import ConnectionPage from './pages/ConnectionPage'
import HomePage from './pages/HomePage'
import VisualizePage from './pages/VisualizePage'
import SprintPage from './pages/SprintPage'
import WikiPage from './pages/WikiPage'

export default function App(): JSX.Element {
  const { data: connection, isLoading, refetch } = useGetConnectionQuery()
  const location = useLocation()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const selectedProjectId = useAppSelector((s) => s.workspace.projectId)

  // Mirror workspace state into / out of the persisted snapshot for this org.
  // Hydrates project / team / source / grouping on first run; persists any
  // subsequent edits so reloads don't reset the user's working setup.
  useWorkspacePersistence(connection?.organizationUrl)

  // Once we have a token and a project list, auto-apply the user's pinned
  // default project for this organization. Skipped if the user has already
  // picked something this session (including via the workspace snapshot).
  const projectsQ = useListProjectsQuery(undefined, { skip: !connection?.hasToken })
  const defaultProjectId = useAppSelector((s) =>
    selectDefaultProjectId(s, connection?.organizationUrl)
  )

  useEffect(() => {
    const off = window.ado.on('connection-changed', () => refetch())
    return off
  }, [refetch])

  useEffect(() => {
    if (isLoading) return
    if (!connection?.hasToken && location.pathname !== '/connect') {
      navigate('/connect', { replace: true })
    }
  }, [connection, isLoading, location.pathname, navigate])

  useEffect(() => {
    if (selectedProjectId) return
    if (!defaultProjectId) return
    if (!projectsQ.data) return
    const match = projectsQ.data.find((p) => p.id === defaultProjectId)
    if (!match) return
    dispatch(setProject({ id: match.id, name: match.name }))
  }, [defaultProjectId, projectsQ.data, selectedProjectId, dispatch])

  if (isLoading) {
    return (
      <Box sx={{ height: '100vh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress />
      </Box>
    )
  }

  return (
    <Routes>
      <Route path="/connect" element={<ConnectionPage />} />
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/home" replace />} />
        <Route path="/home" element={<HomePage />} />
        {/* Back-compat: the page used to be called Workspace. Keep the
            old URL working so existing bookmarks / deep-links don't 404. */}
        <Route path="/workspace" element={<Navigate to="/home" replace />} />
        <Route path="/visualize" element={<VisualizePage />} />
        <Route path="/sprint" element={<SprintPage />} />
        <Route path="/wiki" element={<WikiPage />} />
        {/* Back-compat: old per-view URLs redirect into the consolidated page. */}
        <Route path="/timeline" element={<Navigate to="/visualize?view=timeline" replace />} />
        <Route path="/hierarchy" element={<Navigate to="/visualize?view=hierarchy" replace />} />
        <Route path="/graph" element={<Navigate to="/visualize?view=graph" replace />} />
        <Route path="/calendar" element={<Navigate to="/visualize?view=calendar" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
  )
}
