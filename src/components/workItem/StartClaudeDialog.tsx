import { useEffect, useMemo, useState } from 'react'
import styled from '@emotion/styled'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField
} from '@mui/material'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import { IPC } from '@shared/contract'
import type { TerminalShell } from '@shared/claudeTypes'
import { buildCopyBlob } from '@/utils/copyWorkItem'
import {
  selectClaudeRepoPath,
  setClaudeRepoPath
} from '@/store/preferencesSlice'
import { useAppDispatch, useAppSelector } from '@/store'
import type { AdoComment, AdoWorkItem } from '@shared/adoTypes'

//* Props ---

export interface WorkWithClaudeDialogProps {
  open: boolean
  onClose: () => void
  item: AdoWorkItem
  orgUrl: string
  projectId: string | null
  comments: AdoComment[]
}

//* Styled ---

const Mono = styled(TextField)`
  & textarea {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    line-height: 1.5;
  }
`

const PathRow = styled(Stack)`
  align-items: stretch;
`

const SectionLabel = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: ${({ theme }) => theme.palette.text.secondary};
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
`

const SectionHint = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.palette.text.secondary};
  margin-top: 4px;
`

//* Helpers ---

const SHELL_OPTIONS_WIN: { value: TerminalShell; label: string }[] = [
  { value: 'wt', label: 'Windows Terminal' },
  { value: 'powershell', label: 'PowerShell' }
]

const SHELL_OPTIONS_MAC: { value: TerminalShell; label: string }[] = [
  { value: 'macos-terminal', label: 'Terminal.app' },
  { value: 'iterm2', label: 'iTerm2' }
]

/**
 * Default prompt delegates to the gpc-dev plugin's gpc-implementation-plan
 * skill. The skill fetches the work item from ADO, maps it to legacy code,
 * identifies the revamp target module, and produces a step-by-step plan.
 * Kept short so the user can edit / replace freely.
 */
function buildDefaultPrompt(item: AdoWorkItem): string {
  const id = item.id
  const type =
    (item.fields['System.WorkItemType'] as string | undefined) ?? 'Work Item'
  const title =
    (item.fields['System.Title'] as string | undefined) ?? '(no title)'

  return `Please invoke the \`gpc-dev:gpc-implementation-plan\` skill to plan implementation of Azure DevOps ${type} #${id} — "${title}".

After the plan is approved, dispatch to the right skill for each step:
- Frontend (React / GPConnect_Web) → \`gpc-dev:gpc-frontend-development\`
- Backend (.NET 8 / GPConnect_WebAPI) → \`gpc-dev:gpc-backend-development\`
- Database — tables, SPs, entities → \`gpc-data:gpc-database\`
- Background workers → \`gpc-dev:gpc-worker-service\`
- Code review when done → \`gpc-dev:gpc-code-review-frontend\` / \`gpc-dev:gpc-code-review-backend\`
- Git workflow (branch / commit / push / PR) → \`gpc-dev:gpc-git\``
}

//* FC ---

export default function WorkWithClaudeDialog({
  open,
  onClose,
  item,
  orgUrl,
  projectId,
  comments
}: WorkWithClaudeDialogProps): JSX.Element {
  const dispatch = useAppDispatch()
  const persistedPath = useAppSelector((s) =>
    selectClaudeRepoPath(s, projectId)
  )

  const [prompt, setPrompt] = useState('')
  const [context, setContext] = useState('')
  const [path, setPath] = useState(persistedPath ?? '')
  const [shell, setShell] = useState<TerminalShell>(
    window.ado.platform === 'win32' ? 'wt' : 'macos-terminal'
  )
  const [buildingContext, setBuildingContext] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)

  const shellOptions = useMemo(
    () =>
      window.ado.platform === 'win32'
        ? SHELL_OPTIONS_WIN
        : window.ado.platform === 'darwin'
          ? SHELL_OPTIONS_MAC
          : [],
    []
  )

  // Default the prompt and reset error state every time the dialog opens.
  useEffect(() => {
    if (!open) return
    setPrompt(buildDefaultPrompt(item))
    setLaunchError(null)
    setContextError(null)
  }, [open, item])

  // Build the work-item content block (description + metadata + comments
  // + ADO-image data URIs) in the background each time the dialog opens.
  // The user can wipe / edit / paste anything they want before sending.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setBuildingContext(true)
    setContext('')
    void (async () => {
      try {
        const result = await buildCopyBlob({
          item,
          orgUrl,
          comments,
          scope: 'descriptionMetaComments'
        })
        if (!cancelled) setContext(result.markdown)
      } catch (err) {
        if (!cancelled) setContextError((err as Error).message)
      } finally {
        if (!cancelled) setBuildingContext(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, item, orgUrl, comments])

  // Keep the path field in sync with the persisted preference if the
  // dialog is opened for a different project mid-session.
  useEffect(() => {
    if (open) setPath(persistedPath ?? '')
  }, [open, persistedPath])

  async function browseForPath(): Promise<void> {
    try {
      const result = await window.ado.invoke(IPC.ClaudePickDirectory, {
        defaultPath: path || undefined,
        title: 'Select the repository to start Claude in'
      })
      if (result.path) setPath(result.path)
    } catch (err) {
      setLaunchError((err as Error).message)
    }
  }

  async function start(): Promise<void> {
    if (!path) {
      setLaunchError('Pick a repository folder first.')
      return
    }
    setLaunching(true)
    setLaunchError(null)
    try {
      if (projectId) {
        dispatch(setClaudeRepoPath({ projectId, path }))
      }
      await window.ado.invoke(IPC.ClaudeStartInTerminal, {
        cwd: path,
        prompt,
        contextContent: context.trim() ? context : undefined,
        shell
      })
      onClose()
    } catch (err) {
      setLaunchError((err as Error).message)
    } finally {
      setLaunching(false)
    }
  }

  const canStart =
    !!path && !!prompt.trim() && !launching && shellOptions.length > 0

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Work with Claude</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <PathRow direction="row" spacing={1}>
            <TextField
              label="Repository folder"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              fullWidth
              size="small"
              placeholder="C:\\Me\\Source\\my-repo"
            />
            <Button
              variant="outlined"
              startIcon={<FolderOpenIcon />}
              onClick={browseForPath}
              sx={{ flexShrink: 0 }}
            >
              Browse…
            </Button>
          </PathRow>

          <FormControl size="small">
            <InputLabel id="shell-label">Terminal</InputLabel>
            <Select
              labelId="shell-label"
              label="Terminal"
              value={shell}
              onChange={(e) => setShell(e.target.value as TerminalShell)}
            >
              {shellOptions.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  {opt.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {launchError && <Alert severity="error">{launchError}</Alert>}
          {contextError && (
            <Alert severity="warning">
              Couldn't build work-item content: {contextError}. You can still send the prompt alone.
            </Alert>
          )}
          {shellOptions.length === 0 && (
            <Alert severity="warning">
              No supported terminal on this platform ({window.ado.platform}). Currently Windows and macOS only.
            </Alert>
          )}

          <div>
            <SectionLabel>Prompt — what to do</SectionLabel>
            <Mono
              multiline
              minRows={8}
              maxRows={14}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              fullWidth
              size="small"
            />
            <SectionHint>
              Sent as the first chat message. Edit freely — defaults to the GPConnect implementation-plan skill.
            </SectionHint>
          </div>

          <div>
            <SectionLabel>Work item content — reference for Claude</SectionLabel>
            <Mono
              multiline
              minRows={10}
              maxRows={20}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              fullWidth
              size="small"
              placeholder={
                buildingContext
                  ? 'Building from work item description + comments…'
                  : 'Description / metadata / comments. Wipe this if you want a prompt-only send.'
              }
              disabled={buildingContext}
            />
            <SectionHint>
              Written to a temp file at launch; the prompt above gets a "Full context file: …" line appended so Claude knows where to read from. Leave empty to skip.
            </SectionHint>
          </div>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={start} disabled={!canStart}>
          {launching ? 'Starting…' : 'Work with Claude'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

//* Export ---
