import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import WhatsAppIcon from '@mui/icons-material/WhatsApp'
import { IPC } from '@shared/contract'
import type {
  AdoPullRequest,
  AdoPullRequestChange,
  PullRequestChangesSummary
} from '@shared/adoTypes'
import { useGetPullRequestChangesSummaryQuery } from '@/store/api/adoApi'

/**
 * Soft warning threshold for the character counter. WhatsApp itself
 * has no hard cap on web messages, but very long URLs / blocks make
 * the chat preview render awkwardly across mobile clients. Above this
 * the counter switches to the warning colour with an explanatory
 * tooltip, but the "Open in WhatsApp" button stays enabled — we don't
 * want to second-guess users who deliberately want to send a long
 * note.
 */
const SOFT_LIMIT = 1000

/**
 * Maximum number of files we list inline in the detailed template.
 * Anything beyond this collapses into a `…and N more files` line
 * appended at the end. The renderer caps at 5 even when the IPC
 * surface returns up to 200 — the share message gets unwieldy past
 * that and the link itself takes the user to the full diff.
 */
const MAX_FILES_IN_MESSAGE = 5

interface WhatsAppShareDialogProps {
  open: boolean
  onClose: () => void
  pr: AdoPullRequest
  /**
   * ADO web URL of the PR — pre-built by the caller so we don't
   * duplicate the same `${orgUrl}/${project}/_git/${repo}/pullrequest/${id}`
   * concatenation that already lives in `PullRequestsList`. When
   * absent (e.g. caller couldn't determine `orgUrl` yet) the dialog
   * still opens but omits the link line; the user can paste it
   * manually.
   */
  azureDevOpsUrl?: string
  /**
   * Project id used to fetch the change summary. Required for the
   * "Include details" toggle to work — when absent the toggle is
   * disabled with a tooltip.
   */
  projectId?: string
}

/**
 * Modal that lets the user compose a WhatsApp message asking a
 * teammate to review the given pull request. The body is
 * pre-populated with a minimal template (review prompt + PR link) and
 * stays editable; flipping the "Include PR details" switch fetches
 * the file-change summary lazily and either overwrites or appends to
 * the body (depending on whether the user has touched it yet — see
 * `userEdited`).
 *
 * "Open in WhatsApp" hands off to `https://wa.me/?text=...` via the
 * same `IPC.ShellOpenExternal` channel the PR row uses to open ADO
 * in the system browser; WhatsApp Web/Desktop then opens with the
 * pre-composed message and the user picks the recipient there.
 *
 * Privacy: the detailed template intentionally excludes the PR
 * description and any comments — those can carry sensitive context
 * (customer names, internal hostnames, ticket numbers) that
 * shouldn't flow into a chat app without explicit opt-in. Title +
 * repo + branches + author + file list is the agreed upper bound for
 * v0.3.1.
 */
export default function WhatsAppShareDialog({
  open,
  onClose,
  pr,
  azureDevOpsUrl,
  projectId
}: WhatsAppShareDialogProps): JSX.Element {
  const [body, setBody] = useState<string>(() => buildMinimalMessage(pr, azureDevOpsUrl))
  const [showDetails, setShowDetails] = useState(false)
  // Tracks whether the user has typed into the TextField since the
  // dialog opened. Once true, we stop wholesale-overwriting the body
  // when the details switch flips — appending instead so we don't
  // trash a hand-crafted note.
  const [userEdited, setUserEdited] = useState(false)

  const repositoryId = pr.repository?.id

  // Reset all dialog state when (re)opened so a previous edit on a
  // different PR doesn't leak through. Keying by `pullRequestId`
  // means re-opening the same PR keeps state across renders within
  // the same open session, but switching PRs always resets.
  useEffect(() => {
    if (!open) return
    setBody(buildMinimalMessage(pr, azureDevOpsUrl))
    setShowDetails(false)
    setUserEdited(false)
  }, [open, pr, azureDevOpsUrl])

  const canFetchDetails = !!projectId && !!repositoryId

  const detailsQ = useGetPullRequestChangesSummaryQuery(
    canFetchDetails && projectId && repositoryId
      ? {
          projectId,
          repositoryId,
          pullRequestId: pr.pullRequestId
        }
      : // Cast safely — RTK Query never reads `args` while `skip` is true.
        ({ projectId: '', repositoryId: '', pullRequestId: 0 }),
    { skip: !showDetails || !canFetchDetails }
  )

  const detailsLoading = showDetails && canFetchDetails && detailsQ.isFetching
  const detailsError =
    showDetails && canFetchDetails
      ? (detailsQ.error as { data?: { message?: string } } | undefined)?.data?.message
      : undefined

  // Splice the detailed template / file list into the body whenever
  // the change summary lands. Two paths:
  //   - User hasn't edited → wholesale overwrite to the detailed
  //     template (matches the spec's "regenerates the message body").
  //   - User edited → append a file-list block so we don't trample
  //     their tweaks. Less disruptive than the alternative
  //     (skip-on-edit), and the spec explicitly allows it.
  useEffect(() => {
    if (!showDetails) return
    const summary = detailsQ.data?.summary
    if (!summary) return
    setBody((prev) => {
      if (!userEdited) {
        return buildDetailedMessage(pr, azureDevOpsUrl, summary)
      }
      // Appending — guard against double-append if the query refetches.
      const filesBlock = renderFilesBlock(summary)
      if (!filesBlock) return prev
      if (prev.includes(filesBlock)) return prev
      const trimmed = prev.replace(/\s+$/, '')
      return `${trimmed}\n\n${filesBlock}`
    })
  }, [showDetails, detailsQ.data, pr, azureDevOpsUrl, userEdited])

  // Toggling the switch off doesn't re-fetch (RTK Query just stops
  // subscribing); revert the body to the minimal template only when
  // the user hasn't touched it manually, to mirror the toggle-on
  // overwrite behaviour symmetrically.
  function handleToggleDetails(checked: boolean): void {
    setShowDetails(checked)
    if (!checked && !userEdited) {
      setBody(buildMinimalMessage(pr, azureDevOpsUrl))
    }
  }

  function handleBodyChange(next: string): void {
    setBody(next)
    if (!userEdited) setUserEdited(true)
  }

  function handleOpenWhatsApp(): void {
    const trimmed = body.trim()
    if (!trimmed) return
    const url = `https://wa.me/?text=${encodeURIComponent(trimmed)}`
    void window.ado.invoke(IPC.ShellOpenExternal, { url })
    onClose()
  }

  const charCount = body.length
  const isLong = charCount > SOFT_LIMIT

  const counterEl = useMemo(
    () => (
      <Tooltip
        title={
          isLong
            ? 'Long messages may not preview well in WhatsApp'
            : ''
        }
        disableHoverListener={!isLong}
      >
        <Typography
          variant="caption"
          sx={{
            fontVariantNumeric: 'tabular-nums',
            color: isLong ? 'warning.main' : 'text.secondary'
          }}
        >
          {charCount}
        </Typography>
      </Tooltip>
    ),
    [charCount, isLong]
  )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      // Stop click events on the dialog from bubbling up to the PR
      // row's click handler (which would re-open the PR in ADO and
      // immediately steal focus).
      onClick={(e) => e.stopPropagation()}
    >
      <DialogTitle sx={{ pr: 6 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <WhatsAppIcon sx={{ color: '#25D366' }} fontSize="small" />
          <span>Share PR #{pr.pullRequestId} via WhatsApp</span>
        </Stack>
        <IconButton
          aria-label="Close"
          onClick={onClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
          size="small"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <TextField
            value={body}
            onChange={(e) => handleBodyChange(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter as a power-user shortcut for "Open in WhatsApp".
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                handleOpenWhatsApp()
              }
            }}
            multiline
            minRows={6}
            maxRows={16}
            fullWidth
            autoFocus
            placeholder="Message preview"
            slotProps={{
              htmlInput: {
                'aria-label': 'WhatsApp message preview',
                style: { fontFamily: 'inherit', lineHeight: 1.45 }
              }
            }}
          />
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ minHeight: 28 }}
          >
            <Stack direction="row" alignItems="center" spacing={1}>
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={showDetails}
                    disabled={!canFetchDetails}
                    onChange={(_e, checked) => handleToggleDetails(checked)}
                  />
                }
                label={
                  <Typography variant="body2">
                    Include PR details (file changes summary)
                  </Typography>
                }
                sx={{ mr: 0.5 }}
              />
              {detailsLoading && <CircularProgress size={14} />}
              {!canFetchDetails && (
                <Tooltip title="Repository or project id missing — the detail summary can't be fetched.">
                  <Typography variant="caption" color="text.disabled">
                    (unavailable)
                  </Typography>
                </Tooltip>
              )}
            </Stack>
            {counterEl}
          </Stack>
          {detailsError && (
            <Typography variant="caption" color="error">
              Couldn&rsquo;t load PR details: {detailsError}
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={handleOpenWhatsApp}
          variant="contained"
          startIcon={<WhatsAppIcon />}
          disabled={body.trim().length === 0}
          sx={{
            bgcolor: '#25D366',
            '&:hover': { bgcolor: '#1DAA52' }
          }}
        >
          Open in WhatsApp
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/* ---------- message templates ---------- */

/**
 * Minimal template — review prompt + bracketed id/title + ADO link.
 * Three lines on purpose: the recipient gets the ask, the context,
 * and the link in one glance without having to scroll on a phone.
 */
function buildMinimalMessage(pr: AdoPullRequest, url?: string): string {
  const lines = [
    'Please review when free:',
    `[#${pr.pullRequestId}] ${pr.title ?? ''}`.trimEnd()
  ]
  if (url) lines.push(url)
  return lines.join('\n')
}

/**
 * Detailed template — adds repo / branch / author and the file-list
 * block between the title and the link. Skips fields that aren't
 * available on the PR record so the message doesn't leak literal
 * `undefined`s when ADO returns a sparse payload.
 */
function buildDetailedMessage(
  pr: AdoPullRequest,
  url: string | undefined,
  summary: PullRequestChangesSummary
): string {
  const lines: string[] = [
    'Please review when free:',
    `[#${pr.pullRequestId}] ${pr.title ?? ''}`.trimEnd()
  ]
  if (pr.repository?.name) {
    lines.push(`Repo: ${pr.repository.name}`)
  }
  const src = stripRefHeads(pr.sourceRefName)
  const tgt = stripRefHeads(pr.targetRefName)
  if (src || tgt) {
    lines.push(`Branch: ${src} → ${tgt}`)
  }
  const authorName = pr.createdBy?.displayName
  if (authorName) {
    lines.push(`Author: ${authorName}`)
  }
  const files = renderFilesBlock(summary)
  if (files) {
    lines.push('') // blank line before the files block
    lines.push(files)
  }
  if (url) {
    lines.push('') // blank line before the link
    lines.push(url)
  }
  return lines.join('\n')
}

/**
 * Render the file-change summary as the multiline block that gets
 * inlined into the detailed template (or appended when the user has
 * already edited the body).
 *
 * Two formats depending on whether line counts are available:
 *
 *   - With line counts (future):
 *       3 files changed: +120 / -45 lines
 *       - src/foo.ts (+98 / -12)
 *
 *   - Without (v0.3.1 default — the iteration-changes endpoint
 *     doesn't return them):
 *       3 files changed
 *       - M src/foo.ts
 *       - A src/bar.ts
 *       - D src/baz.ts
 *
 * Returns an empty string when the summary contains no files so the
 * caller can skip the section entirely.
 */
function renderFilesBlock(summary: PullRequestChangesSummary): string {
  if (!summary || summary.totalFiles === 0 || summary.files.length === 0) {
    return ''
  }
  const hasLineCounts =
    typeof summary.totalAdded === 'number' && typeof summary.totalDeleted === 'number'

  const header = hasLineCounts
    ? `${summary.totalFiles} file${summary.totalFiles === 1 ? '' : 's'} changed: +${summary.totalAdded} / -${summary.totalDeleted} lines`
    : `${summary.totalFiles} file${summary.totalFiles === 1 ? '' : 's'} changed`

  const shown = summary.files.slice(0, MAX_FILES_IN_MESSAGE)
  const remaining = Math.max(0, summary.totalFiles - shown.length)

  const lines: string[] = [header]
  for (const f of shown) {
    lines.push(formatFileLine(f, hasLineCounts))
  }
  if (remaining > 0) {
    lines.push(`…and ${remaining} more file${remaining === 1 ? '' : 's'}`)
  }
  return lines.join('\n')
}

function formatFileLine(file: AdoPullRequestChange, hasLineCounts: boolean): string {
  if (
    hasLineCounts &&
    typeof file.addedLines === 'number' &&
    typeof file.deletedLines === 'number'
  ) {
    return `- ${file.path} (+${file.addedLines} / -${file.deletedLines})`
  }
  return `- ${changeTypeMarker(file.changeType)} ${file.path}`
}

function changeTypeMarker(kind: AdoPullRequestChange['changeType']): string {
  switch (kind) {
    case 'add':
      return 'A'
    case 'delete':
      return 'D'
    case 'rename':
      return 'R'
    case 'edit':
      return 'M'
    default:
      return '·'
  }
}

function stripRefHeads(refName: string | undefined): string {
  if (!refName) return ''
  return refName.replace(/^refs\/heads\//, '')
}
