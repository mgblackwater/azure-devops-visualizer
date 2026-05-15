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

export interface StartClaudeDialogProps {
  open: boolean
  onClose: () => void
  item: AdoWorkItem
  orgUrl: string
  projectId: string | null
  comments: AdoComment[]
}

//* Styled ---

const PromptArea = styled(TextField)`
  & textarea {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    line-height: 1.5;
  }
`

const PathRow = styled(Stack)`
  align-items: stretch;
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

function buildDefaultIntroBlock(item: AdoWorkItem): string {
  const id = item.id
  const type =
    (item.fields['System.WorkItemType'] as string | undefined) ?? 'Work Item'
  const title =
    (item.fields['System.Title'] as string | undefined) ?? '(no title)'
  return `Please implement the following Azure DevOps ${type} (#${id}).

Read the title, description, and any comments below. Plan the change, ask for clarification only on genuine blockers, then make the edits.

# ${type} #${id}: ${title}
`
}

//* FC ---

export default function StartClaudeDialog({
  open,
  onClose,
  item,
  orgUrl,
  projectId,
  comments
}: StartClaudeDialogProps): JSX.Element {
  const dispatch = useAppDispatch()
  const persistedPath = useAppSelector((s) =>
    selectClaudeRepoPath(s, projectId)
  )

  const [prompt, setPrompt] = useState('')
  const [path, setPath] = useState(persistedPath ?? '')
  const [shell, setShell] = useState<TerminalShell>(
    window.ado.platform === 'win32' ? 'wt' : 'macos-terminal'
  )
  const [buildError, setBuildError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
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

  // Build the default prompt when the dialog opens. We rebuild on every
  // open in case the item or comments have moved on since the user last
  // saw it. Editable in the textarea afterwards.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setBuildError(null)
    setLaunchError(null)
    setBuilding(true)
    void (async () => {
      try {
        const result = await buildCopyBlob({
          item,
          orgUrl,
          comments,
          scope: 'descriptionMetaComments'
        })
        if (cancelled) return
        const intro = buildDefaultIntroBlock(item)
        setPrompt(`${intro}\n${result.markdown}`)
      } catch (err) {
        if (cancelled) return
        setBuildError((err as Error).message)
      } finally {
        if (!cancelled) setBuilding(false)
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
      // Persist before launching so the next open remembers, even if
      // launch itself fails (helps when the user is iterating).
      if (projectId) {
        dispatch(setClaudeRepoPath({ projectId, path }))
      }
      await window.ado.invoke(IPC.ClaudeStartInTerminal, {
        cwd: path,
        prompt,
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
    !!path && !!prompt.trim() && !launching && !building && shellOptions.length > 0

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Start Claude on this work item</DialogTitle>
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

          {buildError && <Alert severity="warning">{buildError}</Alert>}
          {launchError && <Alert severity="error">{launchError}</Alert>}
          {shellOptions.length === 0 && (
            <Alert severity="warning">
              No supported terminal on this platform ({window.ado.platform}). Currently Windows and macOS only.
            </Alert>
          )}

          <PromptArea
            label="Initial prompt (editable)"
            multiline
            minRows={12}
            maxRows={24}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            fullWidth
            size="small"
            disabled={building}
            placeholder={building ? 'Building prompt from work item…' : ''}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={start} disabled={!canStart}>
          {launching ? 'Starting…' : 'Start Claude'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

//* Export ---
