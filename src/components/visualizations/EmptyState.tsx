import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material'
import { useNavigate } from 'react-router-dom'

interface Props {
  isLoading?: boolean
  isFetching?: boolean
  error?: unknown
  count?: number
  hasSource?: boolean
  emptyHint?: string
}

export default function EmptyState({
  isLoading,
  isFetching,
  error,
  count,
  hasSource,
  emptyHint
}: Props): JSX.Element | null {
  const navigate = useNavigate()

  if (!hasSource) {
    return (
      <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', p: 4 }}>
        <Stack alignItems="center" spacing={2}>
          <Typography variant="h6">No data source selected</Typography>
          <Typography variant="body2" color="text.secondary">
            Pick a project and a query in the Workspace tab.
          </Typography>
          <Button variant="contained" onClick={() => navigate('/workspace')}>
            Open Workspace
          </Button>
        </Stack>
      </Box>
    )
  }

  if (isLoading) {
    return (
      <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
        <Stack alignItems="center" spacing={1}>
          <CircularProgress />
          <Typography variant="body2" color="text.secondary">
            Loading work items…
          </Typography>
        </Stack>
      </Box>
    )
  }

  if (error != null) {
    const message =
      (error as { data?: { message?: string } }).data?.message ?? 'Failed to load data.'
    return (
      <Box sx={{ flex: 1, p: 4 }}>
        <Alert severity="error">{message}</Alert>
      </Box>
    )
  }

  if (count === 0) {
    return (
      <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', p: 4 }}>
        <Stack alignItems="center" spacing={1}>
          <Typography variant="h6">No work items</Typography>
          <Typography variant="body2" color="text.secondary">
            {emptyHint ?? 'The query returned no results.'}
          </Typography>
        </Stack>
      </Box>
    )
  }

  if (isFetching) {
    return (
      <Box sx={{ position: 'absolute', top: 8, right: 8 }}>
        <CircularProgress size={20} />
      </Box>
    )
  }

  return null
}
