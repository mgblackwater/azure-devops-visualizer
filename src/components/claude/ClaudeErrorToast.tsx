import { Alert, Snackbar } from '@mui/material'
import { useAppDispatch, useAppSelector } from '../../store'
import { claudeActions } from '../../store/claudeSlice'

export default function ClaudeErrorToast(): JSX.Element {
  const error = useAppSelector((s) => s.claude.error)
  const dispatch = useAppDispatch()
  const dismiss = (): void => {
    dispatch(claudeActions.setError(null))
  }
  return (
    <Snackbar open={!!error} autoHideDuration={6000} onClose={dismiss}>
      <Alert severity="error" onClose={dismiss} sx={{ maxWidth: 600 }}>
        {error}
      </Alert>
    </Snackbar>
  )
}
