import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField
} from '@mui/material'
import { useListProjectTagsQuery } from '@/store/api/adoApi'
import type { IpcError } from '@shared/adoTypes'

interface TagEditorDialogProps {
  open: boolean
  onClose: () => void
  /** Initial tags shown when the dialog opens. Re-applied each time
   *  `open` flips to true so re-opening after a Cancel doesn't keep
   *  stale free-typed values around. */
  initialTags: string[]
  projectId: string
  /** Resolves on success. Reject with an IpcError-shaped object so the
   *  dialog can surface the verbatim ADO message inline. */
  onSave: (tags: string[]) => Promise<void>
}

/**
 * Compact dialog for the work-item drawer's tag editor.
 *
 * - Multi-select Autocomplete with `freeSolo` so users can type a tag
 *   that doesn't yet exist in the project's tag catalogue.
 * - Suggestions come from `listProjectTags`; the dialog filters out
 *   already-selected ones to keep the dropdown focused.
 * - On Save, the dialog calls back into the parent's mutation. Errors
 *   surface inline as an `<Alert severity="error">` and the dialog
 *   stays open with the user's edits intact so they can retry or
 *   change values without re-typing.
 *
 * Keeps zero IPC of its own — the mutation is wholly the parent's
 * concern, so the dialog stays trivially mockable and the optimistic-
 * cache logic lives next to where the patch is built.
 */
export default function TagEditorDialog({
  open,
  onClose,
  initialTags,
  projectId,
  onSave
}: TagEditorDialogProps): JSX.Element {
  const [value, setValue] = useState<string[]>(initialTags)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-seed the value each time the dialog re-opens so a Cancel + open
  // on a different work item doesn't carry over the previous draft.
  useEffect(() => {
    if (open) {
      setValue(initialTags)
      setError(null)
      setSaving(false)
    }
  }, [open, initialTags])

  const tagsQ = useListProjectTagsQuery(
    { projectId },
    // Don't kick off the suggestion fetch until the user actually
    // opens the dialog. `keepUnusedDataFor: 300` on the endpoint means
    // re-opening within five minutes is free.
    { skip: !open || !projectId }
  )

  const options = useMemo(() => tagsQ.data?.tags ?? [], [tagsQ.data])

  async function handleSave(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await onSave(value)
      // On success the parent closes us; we don't call onClose() here
      // so the parent can keep the dialog open through the optimistic
      // window if it ever wants to. Today the parent closes
      // immediately, so this is just a contract preserve.
    } catch (err) {
      const message = readErrorMessage(err)
      setError(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (saving) return
        onClose()
      }}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle sx={{ pb: 1 }}>Edit tags</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <Autocomplete<string, true, false, true>
            multiple
            freeSolo
            options={options}
            value={value}
            onChange={(_e, next) => {
              setValue(normaliseDraftTags(next))
            }}
            // Keep the dropdown focused on tags we haven't already
            // applied — the user is far more likely to want to add a
            // *new* tag than re-pick one already on the chip strip.
            filterSelectedOptions
            // Don't blow away the user's half-typed text on every
            // blur — it makes the freeSolo flow feel hostile.
            clearOnBlur={false}
            selectOnFocus
            handleHomeEndKeys
            disabled={saving}
            loading={tagsQ.isFetching}
            renderTags={(tagValues, getTagProps) =>
              tagValues.map((option, index) => {
                const { key, ...tagProps } = getTagProps({ index })
                return (
                  <Chip
                    key={key}
                    label={option}
                    size="small"
                    variant="outlined"
                    {...tagProps}
                  />
                )
              })
            }
            renderInput={(params) => (
              <TextField
                {...params}
                autoFocus
                placeholder={value.length === 0 ? 'Add a tag…' : ''}
                helperText="Type to filter or add a new tag. Press Enter to commit a new tag."
                slotProps={{
                  input: {
                    ...params.InputProps,
                    endAdornment: (
                      <>
                        {tagsQ.isFetching ? (
                          <CircularProgress
                            color="inherit"
                            size={16}
                            sx={{ mr: 1 }}
                          />
                        ) : null}
                        {params.InputProps.endAdornment}
                      </>
                    )
                  }
                }}
              />
            )}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          variant="contained"
          disabled={saving}
          startIcon={
            saving ? <CircularProgress size={14} color="inherit" /> : undefined
          }
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/**
 * Trim whitespace, drop empties, dedupe case-insensitively.
 *
 * Same algorithm as `normaliseTagsForPatch` in `adoApi.ts` but kept
 * separate here because the dialog's `value` state is `string[]`
 * (Autocomplete's natural shape) while the patch path joins. Keeping
 * the two normalisations textually identical means the user sees the
 * same chip-strip post-Save as the wire payload encodes.
 */
function normaliseDraftTags(raw: ReadonlyArray<string>): string[] {
  const seen = new Map<string, string>()
  for (const t of raw) {
    if (typeof t !== 'string') continue
    const trimmed = t.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (!seen.has(key)) seen.set(key, trimmed)
  }
  return [...seen.values()]
}

/**
 * The dialog's `onSave` rejection lands here as one of:
 *
 *  - A structured `IpcError` (the preload bridge's normal shape).
 *  - A `FetchBaseQueryError`-wrapped IpcError, where RTK Query has
 *    parked the IpcError under `.data`.
 *  - An Error or string from somewhere unexpected.
 *
 * We pull a human-readable message out of whichever shape arrived so
 * the inline `<Alert>` shows ADO's verbatim explanation (e.g. "TF26198:
 * The work item could not be found") rather than "[object Object]".
 */
function readErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as Partial<IpcError> & {
      data?: Partial<IpcError>
      message?: string
    }
    if (e.data && typeof e.data === 'object' && typeof e.data.message === 'string') {
      return enrichForAuthErrors(e.data.message, e.data.status, e.data.code)
    }
    if (typeof e.message === 'string' && e.message.length > 0) {
      return enrichForAuthErrors(e.message, e.status, e.code)
    }
  }
  if (typeof err === 'string') return err
  return 'Failed to update tags.'
}

/**
 * 401/403 from ADO's work-item PATCH endpoint nearly always means the
 * PAT is missing the `vso.work_write` scope. The raw ADO message in
 * that case is generic ("VS800075: ...") — replace it with concrete
 * remediation copy so the user knows exactly what to do.
 */
function enrichForAuthErrors(
  message: string,
  status: number | undefined,
  code: string | undefined
): string {
  if (status === 401 || status === 403 || code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
    return "Your token doesn't have permission to edit work items. Update the PAT scope to include 'Work items (read & write)'."
  }
  return message
}
