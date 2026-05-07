import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ClipboardEvent
} from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import FormatAlignLeftIcon from '@mui/icons-material/FormatAlignLeft'
import FormatAlignCenterIcon from '@mui/icons-material/FormatAlignCenter'
import FormatAlignRightIcon from '@mui/icons-material/FormatAlignRight'

/**
 * "Build/Edit table" utility — opens a small grid editor that emits a
 * clean markdown table. The dialog is action-agnostic: the caller
 * decides what happens on Save by passing an `onSave(markdown)`
 * callback. The same component services three flows:
 *
 *  1. View-mode "Add table"  — caller appends to wiki and writes back.
 *  2. View-mode "Edit table" — caller splices over the original block
 *     and writes back.
 *  3. Edit-mode "Add table"  — caller inserts at the CodeMirror cursor
 *     without writing back; the user commits via the editor toolbar.
 *
 * The dialog deliberately does not call any IPC itself — keeping the
 * write path with the page orchestrator means we only have one place
 * where conflict handling, optimistic concurrency, and dirty tracking
 * live.
 */

export type Alignment = 'left' | 'center' | 'right'

const DEFAULT_ROWS = 3
const DEFAULT_COLS = 3
const MIN_DIM = 1
// Sanity cap so a runaway paste can't render thousands of TextFields.
// Real tables larger than this should be authored programmatically;
// users can paste a TSV up to this size and trim afterwards.
const MAX_DIM = 20

/**
 * Optional pre-fill payload — set when the dialog is opened to edit an
 * existing wiki table rather than build one from scratch.
 */
export interface TableBuilderInitialData {
  cells: string[][]
  alignments: Alignment[]
  headerRow: boolean
}

interface TableBuilderDialogProps {
  open: boolean
  onClose: () => void
  /** When present, the dialog opens with this table populated and the
   *  title shifts to "Edit table". Null/undefined preserves the
   *  build-from-scratch behaviour. */
  initialData?: TableBuilderInitialData | null
  /**
   * Called with the emitted markdown when the user confirms the dialog.
   * Returning a Promise puts the Save button into a pending state and
   * disables it until the Promise settles. On success, the dialog
   * closes; on rejection, the error message is surfaced inline so the
   * user can fix the underlying issue (e.g. retry on a transient
   * network failure) without losing their grid edits.
   *
   * Synchronous callers (e.g. edit-mode "Insert at cursor", which only
   * mutates a CodeMirror buffer) can return void — the dialog still
   * closes immediately.
   */
  onSave?: (markdown: string) => Promise<void> | void
  /** Save button label. Defaults to "Save". The caller picks a verb
   *  that matches the action (e.g. "Add to page", "Insert at cursor",
   *  "Save to wiki"). */
  saveLabel?: string
}

export default function TableBuilderDialog({
  open,
  onClose,
  initialData,
  onSave,
  saveLabel = 'Save'
}: TableBuilderDialogProps): JSX.Element {
  // Cells is row-major. Alignments is per-column. Header-row toggle
  // controls whether row 0 is treated as the header (and styled as
  // such in the editor) or as a regular body row with a synthetic
  // empty header emitted in the markdown.
  const [cells, setCells] = useState<string[][]>(() =>
    makeEmptyGrid(DEFAULT_ROWS, DEFAULT_COLS)
  )
  const [alignments, setAlignments] = useState<Alignment[]>(() =>
    Array.from({ length: DEFAULT_COLS }, () => 'left' as Alignment)
  )
  const [headerRow, setHeaderRow] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const isEditing = !!initialData

  const rows = cells.length
  const cols = cells[0]?.length ?? 0

  // Initialise on open. When opening with `initialData` we prefill the
  // grid from the existing wiki table; otherwise the dialog opens
  // empty so the user starts from a fresh 3x3. We deliberately key
  // the effect on `open` (and `initialData`) so reopening with a
  // different table replaces the previous content cleanly without
  // any "is the dialog mounted?" gymnastics at the call-site.
  useEffect(() => {
    if (!open) return
    setSaveError(null)
    setSaving(false)
    if (initialData) {
      setCells(cloneGrid(initialData.cells))
      setAlignments([...initialData.alignments])
      setHeaderRow(initialData.headerRow)
    } else {
      setCells(makeEmptyGrid(DEFAULT_ROWS, DEFAULT_COLS))
      setAlignments(Array.from({ length: DEFAULT_COLS }, () => 'left'))
      setHeaderRow(true)
    }
  }, [open, initialData])

  function setCell(r: number, c: number, value: string): void {
    setCells((prev) =>
      prev.map((row, ri) =>
        ri === r
          ? row.map((cell, ci) => (ci === c ? value : cell))
          : row
      )
    )
  }

  function setAlignment(c: number, value: Alignment): void {
    setAlignments((prev) =>
      prev.map((a, i) => (i === c ? value : a))
    )
  }

  function addRow(): void {
    if (rows >= MAX_DIM) return
    setCells((prev) => [...prev, Array.from({ length: cols }, () => '')])
  }

  function removeRow(): void {
    if (rows <= MIN_DIM) return
    setCells((prev) => prev.slice(0, -1))
  }

  function addCol(): void {
    if (cols >= MAX_DIM) return
    setCells((prev) => prev.map((row) => [...row, '']))
    setAlignments((prev) => [...prev, 'left'])
  }

  function removeCol(): void {
    if (cols <= MIN_DIM) return
    setCells((prev) => prev.map((row) => row.slice(0, -1)))
    setAlignments((prev) => prev.slice(0, -1))
  }

  /**
   * Excel/Sheets-style paste: tab-separated text becomes a 2D fill
   * starting at the focused cell, growing the grid if necessary.
   * Single-cell or plain-text pastes fall through to the browser's
   * default behavior so users keep their muscle memory for that case.
   */
  function handlePaste(
    e: ClipboardEvent<HTMLInputElement>,
    r: number,
    c: number
  ): void {
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    const looksLikeTabular = text.includes('\t') || /\r?\n.+/.test(text)
    if (!looksLikeTabular) return
    const pasteRows = text
      .replace(/\r\n/g, '\n')
      .split('\n')
      // Trailing newline from copy is normal — trim it but keep blank
      // rows in the middle (those represent intentional empty rows).
      .filter((line, idx, arr) => idx < arr.length - 1 || line.length > 0)
      .map((line) => line.split('\t'))
    if (pasteRows.length === 0) return
    e.preventDefault()
    const wantRows = Math.min(MAX_DIM, Math.max(rows, r + pasteRows.length))
    const wantCols = Math.min(
      MAX_DIM,
      Math.max(
        cols,
        c + pasteRows.reduce((m, row) => Math.max(m, row.length), 0)
      )
    )
    setCells((prev) => {
      const grid = makeEmptyGrid(wantRows, wantCols)
      for (let i = 0; i < prev.length && i < wantRows; i += 1) {
        for (let j = 0; j < prev[i].length && j < wantCols; j += 1) {
          grid[i][j] = prev[i][j]
        }
      }
      for (let i = 0; i < pasteRows.length; i += 1) {
        const targetRow = r + i
        if (targetRow >= wantRows) break
        for (let j = 0; j < pasteRows[i].length; j += 1) {
          const targetCol = c + j
          if (targetCol >= wantCols) break
          grid[targetRow][targetCol] = pasteRows[i][j]
        }
      }
      return grid
    })
    if (wantCols > cols) {
      setAlignments((prev) => [
        ...prev,
        ...Array.from(
          { length: wantCols - prev.length },
          () => 'left' as Alignment
        )
      ])
    }
  }

  const markdown = useMemo(
    () => buildMarkdownTable(cells, alignments, headerRow),
    [cells, alignments, headerRow]
  )

  const handleSave = useCallback(async () => {
    if (!onSave || !markdown) return
    setSaveError(null)
    let result: Promise<void> | void
    try {
      result = onSave(markdown)
    } catch (err) {
      // Synchronous throw before the promise is even produced — usually
      // a programmer error, but treat it the same as an async failure
      // so the user gets feedback rather than a silent close.
      setSaveError(messageFromError(err))
      return
    }
    if (result && typeof (result as Promise<void>).then === 'function') {
      setSaving(true)
      try {
        await result
        onClose()
      } catch (err) {
        setSaveError(messageFromError(err))
      } finally {
        setSaving(false)
      }
    } else {
      onClose()
    }
  }, [onSave, markdown, onClose])

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{ sx: { maxHeight: '90vh' } }}
    >
      <DialogTitle sx={{ pr: 6 }}>
        {isEditing ? 'Edit table' : 'Build markdown table'}
        <Tooltip title="Close">
          <span>
            <IconButton
              onClick={onClose}
              size="small"
              sx={{ position: 'absolute', right: 12, top: 12 }}
              aria-label="Close"
              disabled={saving}
            >
              <CloseIcon />
            </IconButton>
          </span>
        </Tooltip>
      </DialogTitle>
      <DialogContent dividers>
        {saveError && (
          <Alert
            severity="error"
            sx={{ mb: 2 }}
            onClose={() => setSaveError(null)}
          >
            {saveError}
          </Alert>
        )}
        <Stack
          direction="row"
          spacing={2}
          sx={{
            mb: 2,
            alignItems: 'center',
            flexWrap: 'wrap',
            rowGap: 1
          }}
        >
          <NumberStepper
            label="Rows"
            value={rows}
            min={MIN_DIM}
            max={MAX_DIM}
            onAdd={addRow}
            onRemove={removeRow}
          />
          <NumberStepper
            label="Columns"
            value={cols}
            min={MIN_DIM}
            max={MAX_DIM}
            onAdd={addCol}
            onRemove={removeCol}
          />
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={headerRow}
                onChange={(e) => setHeaderRow(e.target.checked)}
              />
            }
            label="Header row"
          />
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            Tip: paste tab-separated text (e.g. from Excel) to fill cells in
            bulk
          </Typography>
        </Stack>

        <Box sx={{ overflow: 'auto', pb: 1 }}>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, minmax(120px, 1fr))`,
              gap: 1,
              mb: 1,
              minWidth: cols * 120
            }}
          >
            {alignments.map((a, c) => (
              <ToggleButtonGroup
                key={`align-${c}`}
                size="small"
                value={a}
                exclusive
                onChange={(_e, value) => {
                  if (value) setAlignment(c, value as Alignment)
                }}
                fullWidth
                sx={{ '& .MuiToggleButton-root': { py: 0.25 } }}
              >
                <ToggleButton value="left" aria-label="Align left">
                  <FormatAlignLeftIcon fontSize="small" />
                </ToggleButton>
                <ToggleButton value="center" aria-label="Align center">
                  <FormatAlignCenterIcon fontSize="small" />
                </ToggleButton>
                <ToggleButton value="right" aria-label="Align right">
                  <FormatAlignRightIcon fontSize="small" />
                </ToggleButton>
              </ToggleButtonGroup>
            ))}
          </Box>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, minmax(120px, 1fr))`,
              gap: 1,
              minWidth: cols * 120
            }}
          >
            {cells.map((row, r) =>
              row.map((cell, c) => {
                const isHeaderCell = headerRow && r === 0
                return (
                  <TextField
                    key={`${r}-${c}`}
                    size="small"
                    value={cell}
                    onChange={(e) => setCell(r, c, e.target.value)}
                    onPaste={(e) =>
                      handlePaste(
                        e as unknown as ClipboardEvent<HTMLInputElement>,
                        r,
                        c
                      )
                    }
                    placeholder={
                      isHeaderCell ? `Header ${c + 1}` : `Cell ${r + 1},${c + 1}`
                    }
                    inputProps={{
                      style: {
                        fontWeight: isHeaderCell ? 600 : 400,
                        textAlign: alignments[c],
                        fontSize: 13
                      }
                    }}
                  />
                )
              })
            )}
          </Box>
        </Box>

        <Box sx={{ mt: 2 }}>
          <Typography
            variant="overline"
            sx={{
              color: 'text.secondary',
              fontWeight: 700,
              letterSpacing: 0.6,
              fontSize: 10.5
            }}
          >
            Markdown preview
          </Typography>
          <Box
            component="pre"
            sx={(theme) => ({
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 12.5,
              lineHeight: 1.5,
              bgcolor:
                theme.palette.mode === 'dark'
                  ? 'rgba(255,255,255,0.06)'
                  : 'rgba(0,0,0,0.04)',
              p: 1.5,
              borderRadius: 1,
              m: 0,
              whiteSpace: 'pre',
              overflow: 'auto',
              maxHeight: 220,
              border: `1px solid ${theme.palette.divider}`
            })}
          >
            {markdown || '(empty)'}
          </Box>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        {onSave && (
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!markdown || saving}
            startIcon={
              saving ? (
                <CircularProgress
                  size={16}
                  thickness={5}
                  sx={{ color: 'inherit' }}
                />
              ) : undefined
            }
          >
            {saveLabel}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

function NumberStepper({
  label,
  value,
  min,
  max,
  onAdd,
  onRemove
}: {
  label: string
  value: number
  min: number
  max: number
  onAdd: () => void
  onRemove: () => void
}): JSX.Element {
  return (
    <Stack direction="row" alignItems="center" spacing={0.5}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ minWidth: 64 }}
      >
        {label}: <strong>{value}</strong>
      </Typography>
      <Tooltip title={`Remove ${label.toLowerCase()}`}>
        <span>
          <IconButton
            size="small"
            onClick={onRemove}
            disabled={value <= min}
            aria-label={`Remove ${label.toLowerCase()}`}
          >
            <RemoveIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={`Add ${label.toLowerCase()}`}>
        <span>
          <IconButton
            size="small"
            onClick={onAdd}
            disabled={value >= max}
            aria-label={`Add ${label.toLowerCase()}`}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  )
}

function makeEmptyGrid(rows: number, cols: number): string[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => '')
  )
}

function cloneGrid(grid: string[][]): string[][] {
  return grid.map((row) => [...row])
}

/**
 * Escape any pipe characters inside a cell so the table still parses
 * after concatenation, and collapse newlines to spaces because the
 * common markdown flavors (CommonMark, GFM, ADO) don't support multi-
 * line table cells without explicit `<br>` markup. Users who want a
 * real line break can type `<br>` themselves.
 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * Emit a GFM-compatible markdown table. When `headerRow` is false a
 * synthetic blank header row is emitted before the alignment row,
 * because GFM (and ADO) require the alignment row to immediately
 * follow a header. Both renderers display an empty header cleanly.
 *
 * The output is intentionally NOT padded to column width — keeping
 * lines compact mirrors what the ADO web editor itself emits and
 * stops the diff from ballooning when users round-trip a table.
 */
function buildMarkdownTable(
  cells: string[][],
  alignments: Alignment[],
  headerRow: boolean
): string {
  if (cells.length === 0) return ''
  const cols = cells[0]?.length ?? 0
  if (cols === 0) return ''
  const escaped = cells.map((row) => row.map(escapeCell))
  const dashes = alignments.map((a) => {
    if (a === 'center') return ':---:'
    if (a === 'right') return '---:'
    return ':---'
  })
  const lines: string[] = []
  const dataRow = (row: string[]): string => `| ${row.join(' | ')} |`
  if (headerRow) {
    lines.push(dataRow(escaped[0]))
    lines.push(dataRow(dashes))
    for (let r = 1; r < escaped.length; r += 1) lines.push(dataRow(escaped[r]))
  } else {
    lines.push(dataRow(Array.from({ length: cols }, () => '')))
    lines.push(dataRow(dashes))
    for (const row of escaped) lines.push(dataRow(row))
  }
  return lines.join('\n')
}

/**
 * Pull a user-presentable message off whatever the caller's onSave
 * promise rejected with. We accept the typical shapes — RTK Query's
 * `{ data: IpcError }`, plain `Error`, and bare strings — without
 * forcing the caller to normalise. Anything we don't recognise falls
 * through to a generic message rather than dumping an object literal
 * the user can't parse.
 */
function messageFromError(err: unknown): string {
  if (!err) return 'Unknown error'
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (typeof err === 'object') {
    const e = err as { data?: { message?: string }; message?: string }
    if (e.data && typeof e.data.message === 'string') return e.data.message
    if (typeof e.message === 'string') return e.message
  }
  return 'Unknown error'
}
