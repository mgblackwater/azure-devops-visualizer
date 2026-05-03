import { useEffect } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import Grid from '@mui/material/Grid2'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import { useNavigate } from 'react-router-dom'
import {
  useGetConnectionQuery,
  useListProjectsQuery,
  useListTeamsQuery
} from '@/store/api/adoApi'
import { useAppDispatch, useAppSelector } from '@/store'
import { setGroupBy, setProject, setTeam } from '@/store/workspaceSlice'
import {
  clearDefaultProject,
  selectDefaultProjectId,
  setDefaultProject
} from '@/store/preferencesSlice'
import QueryPicker from '@/components/query/QueryPicker'

export default function WorkspacePage(): JSX.Element {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const { projectId, projectName, teamId, source, groupBy } = useAppSelector(
    (s) => s.workspace
  )
  const { data: connection } = useGetConnectionQuery()
  const orgUrl = connection?.organizationUrl
  const defaultProjectId = useAppSelector((s) =>
    selectDefaultProjectId(s, orgUrl)
  )

  const projectsQ = useListProjectsQuery()
  const teamsQ = useListTeamsQuery(
    projectId ? { projectId } : (undefined as never),
    { skip: !projectId }
  )

  // First-launch fallback: if there's no pinned default and nothing is
  // selected yet, drop into the first project so the rest of the page works.
  // App.tsx already handles the default-project case earlier in the boot.
  useEffect(() => {
    if (projectId || defaultProjectId) return
    if (!projectsQ.data || projectsQ.data.length === 0) return
    const first = projectsQ.data[0]
    dispatch(setProject({ id: first.id, name: first.name }))
  }, [projectsQ.data, projectId, defaultProjectId, dispatch])

  const isDefault = !!projectId && projectId === defaultProjectId

  function togglePin(): void {
    if (!orgUrl || !projectId) return
    if (isDefault) {
      dispatch(clearDefaultProject({ organizationUrl: orgUrl }))
    } else {
      dispatch(setDefaultProject({ organizationUrl: orgUrl, projectId }))
    }
  }

  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 3 }}>
      <Typography variant="h6" sx={{ mb: 2 }}>
        Workspace
      </Typography>

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Paper sx={{ p: 3 }}>
            <Stack spacing={2}>
              <Typography variant="subtitle1">1. Choose project &amp; team</Typography>

              {projectsQ.isLoading && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <CircularProgress size={16} />
                  <Typography variant="body2">Loading projects…</Typography>
                </Box>
              )}
              {projectsQ.error != null && (
                <Alert severity="error">Failed to load projects.</Alert>
              )}

              <Stack direction="row" spacing={1} alignItems="center">
                <Autocomplete
                  fullWidth
                  options={projectsQ.data ?? []}
                  getOptionLabel={(opt) => opt.name}
                  value={
                    projectsQ.data?.find((p) => p.id === projectId) ?? null
                  }
                  onChange={(_e, value) =>
                    dispatch(
                      setProject(value ? { id: value.id, name: value.name } : null)
                    )
                  }
                  renderOption={(liProps, option) => {
                    const { key, ...rest } = liProps as typeof liProps & {
                      key?: React.Key
                    }
                    const pinned = option.id === defaultProjectId
                    return (
                      <li
                        key={key ?? option.id}
                        {...rest}
                        style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                      >
                        {pinned ? (
                          <StarIcon sx={{ fontSize: 16, color: 'warning.main' }} />
                        ) : (
                          <Box sx={{ width: 16 }} />
                        )}
                        <span>{option.name}</span>
                      </li>
                    )
                  }}
                  renderInput={(params) => (
                    <TextField {...params} label="Project" size="small" />
                  )}
                />
                <Tooltip
                  title={
                    !projectId
                      ? 'Pick a project first'
                      : isDefault
                        ? 'Default for this organization — click to unpin'
                        : 'Pin as default for this organization'
                  }
                >
                  <span>
                    <IconButton
                      size="small"
                      onClick={togglePin}
                      disabled={!projectId || !orgUrl}
                      color={isDefault ? 'warning' : 'default'}
                    >
                      {isDefault ? <StarIcon /> : <StarBorderIcon />}
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>

              <Autocomplete
                options={teamsQ.data ?? []}
                getOptionLabel={(opt) => opt.name}
                value={teamsQ.data?.find((t) => t.id === teamId) ?? null}
                onChange={(_e, value) =>
                  dispatch(
                    setTeam(value ? { id: value.id, name: value.name } : null)
                  )
                }
                disabled={!projectId || teamsQ.isLoading}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={teamsQ.isLoading ? 'Loading teams…' : 'Team (optional)'}
                    size="small"
                  />
                )}
              />

              <FormControl size="small" fullWidth>
                <InputLabel id="groupby-label">Default grouping</InputLabel>
                <Select
                  labelId="groupby-label"
                  label="Default grouping"
                  value={groupBy}
                  onChange={(e) => dispatch(setGroupBy(e.target.value as typeof groupBy))}
                >
                  <MenuItem value="iteration">Iteration</MenuItem>
                  <MenuItem value="assignee">Assignee</MenuItem>
                  <MenuItem value="state">State</MenuItem>
                  <MenuItem value="type">Type</MenuItem>
                  <MenuItem value="none">None</MenuItem>
                </Select>
              </FormControl>
            </Stack>
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <Paper sx={{ p: 3 }}>
            <Stack spacing={2}>
              <Typography variant="subtitle1">
                2. Choose query source{' '}
                <Typography component="span" variant="caption" color="text.secondary">
                  (used by Visualize · Sprint runs independently)
                </Typography>
              </Typography>
              <QueryPicker />
            </Stack>
          </Paper>
        </Grid>

        <Grid size={{ xs: 12 }}>
          <Paper sx={{ p: 3 }}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              alignItems="center"
              justifyContent="space-between"
            >
              <Box>
                <Typography variant="subtitle1">3. Open a visualization</Typography>
                <Typography variant="body2" color="text.secondary">
                  {projectName ? `Project: ${projectName}` : 'No project selected.'}{' '}
                  {source
                    ? source.kind === 'savedQuery'
                      ? `· Saved query: ${source.queryName ?? source.queryId}`
                      : `· Custom WIQL`
                    : '· No query selected.'}
                </Typography>
              </Box>
              <Stack direction="row" spacing={1} flexWrap="wrap">
                <Button
                  variant="contained"
                  disabled={!projectId || !source}
                  onClick={() => navigate('/visualize?view=timeline')}
                >
                  Timeline
                </Button>
                <Button
                  variant="contained"
                  disabled={!projectId || !source}
                  onClick={() => navigate('/visualize?view=hierarchy')}
                >
                  Hierarchy
                </Button>
                <Button
                  variant="contained"
                  disabled={!projectId || !source}
                  onClick={() => navigate('/visualize?view=graph')}
                >
                  Graph
                </Button>
                <Button
                  variant="contained"
                  disabled={!projectId || !source}
                  onClick={() => navigate('/visualize?view=calendar')}
                >
                  Calendar
                </Button>
                <Button
                  variant="outlined"
                  disabled={!projectId}
                  onClick={() => navigate('/sprint')}
                >
                  Sprint
                </Button>
              </Stack>
            </Stack>
          </Paper>
        </Grid>
      </Grid>
    </Box>
  )
}
