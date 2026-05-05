import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Link,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { useNavigate } from 'react-router-dom'
import {
  useGetConnectionQuery,
  useSetConnectionMutation,
  useTestConnectionMutation
} from '@/store/api/adoApi'
import type { IpcError } from '@shared/adoTypes'
import { IPC } from '@shared/contract'

const ORG_HINT = 'e.g. https://dev.azure.com/your-org'

function isOrgUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.pathname.split('/').filter(Boolean).length >= 1
  } catch {
    return false
  }
}

export default function ConnectionPage(): JSX.Element {
  const { data: connection } = useGetConnectionQuery()
  const navigate = useNavigate()

  const [organizationUrl, setOrganizationUrl] = useState('')
  const [pat, setPat] = useState('')
  const [showSuccess, setShowSuccess] = useState<string | null>(null)

  useEffect(() => {
    if (connection?.organizationUrl) setOrganizationUrl(connection.organizationUrl)
  }, [connection?.organizationUrl])

  const [test, testState] = useTestConnectionMutation()
  const [save, saveState] = useSetConnectionMutation()

  const validUrl = isOrgUrl(organizationUrl)
  const validPat = pat.trim().length >= 20
  const canSubmit = validUrl && validPat && !saveState.isLoading

  async function handleTest(): Promise<void> {
    setShowSuccess(null)
    try {
      const info = await test({
        organizationUrl: organizationUrl.trim(),
        personalAccessToken: pat.trim()
      }).unwrap()
      setShowSuccess(
        `Connection OK. ${info.authenticatedUser?.displayName ?? 'Token verified.'}`
      )
    } catch {
      // RTK Query stores the error in testState.error.
    }
  }

  async function handleSave(): Promise<void> {
    setShowSuccess(null)
    try {
      await save({
        organizationUrl: organizationUrl.trim(),
        personalAccessToken: pat.trim()
      }).unwrap()
      navigate('/home', { replace: true })
    } catch {
      // RTK Query stores the error in saveState.error.
    }
  }

  const error = (saveState.error ?? testState.error) as
    | { data?: IpcError; status?: number | string }
    | undefined

  return (
    <Box sx={{ height: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Paper sx={{ width: 520, maxWidth: '100%', p: 4 }} elevation={2}>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h5" sx={{ fontWeight: 600 }}>
              Connect to Azure DevOps
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Paste your organization URL and a Personal Access Token. The PAT
              is encrypted with the OS keychain (Windows DPAPI / macOS Keychain
              / libsecret) and never leaves this machine.
            </Typography>
          </Box>

          <TextField
            label="Organization URL"
            placeholder={ORG_HINT}
            value={organizationUrl}
            onChange={(e) => setOrganizationUrl(e.target.value)}
            error={organizationUrl.length > 0 && !validUrl}
            helperText={
              organizationUrl.length > 0 && !validUrl
                ? 'Use the form https://dev.azure.com/<organization>'
                : ORG_HINT
            }
            fullWidth
            autoFocus
          />

          <TextField
            label="Personal Access Token"
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            error={pat.length > 0 && !validPat}
            helperText={
              <span>
                Needs <b>Work Items: Read &amp; Write</b>, <b>Project and Team: Read</b>, and{' '}
                <b>Identity: Read</b>.{' '}
                <Link
                  component="button"
                  type="button"
                  onClick={() =>
                    void window.ado.invoke(IPC.ShellOpenExternal, {
                      url: 'https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate'
                    })
                  }
                  sx={{ verticalAlign: 'baseline' }}
                >
                  How to create one
                </Link>
                .
              </span>
            }
            fullWidth
          />

          {showSuccess && <Alert severity="success">{showSuccess}</Alert>}

          {error && (
            <Alert severity="error">
              {error.data?.message ?? 'Connection failed.'} ({String(error.status)})
            </Alert>
          )}

          <Stack direction="row" spacing={2} justifyContent="flex-end">
            <Button
              variant="outlined"
              onClick={handleTest}
              disabled={!validUrl || !validPat || testState.isLoading}
              startIcon={testState.isLoading ? <CircularProgress size={16} /> : undefined}
            >
              Test connection
            </Button>
            <Button
              variant="contained"
              onClick={handleSave}
              disabled={!canSubmit}
              startIcon={saveState.isLoading ? <CircularProgress size={16} /> : undefined}
            >
              Save & continue
            </Button>
          </Stack>
        </Stack>
      </Paper>
    </Box>
  )
}
