import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  Box,
  Divider,
  ListSubheader,
  Menu,
  MenuItem,
  Snackbar,
  Tooltip,
  Typography
} from '@mui/material'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import CheckIcon from '@mui/icons-material/Check'
import ImageIcon from '@mui/icons-material/Image'
import DescriptionIcon from '@mui/icons-material/Description'
import {
  buildCopyBlob,
  formatBytes,
  type CopyProgress,
  type CopyScope
} from '@/utils/copyWorkItem'
import type { AdoComment, AdoWorkItem } from '@shared/adoTypes'

interface Props {
  /** The work item id (the number itself; rendering adds the leading `#`). */
  id: number
  /** Optional title — enables the "id + title" copy variant. */
  title?: string
  /** Optional work item type (e.g. "User Story") — used in the full-context format. */
  type?: string
  /** Optional state (e.g. "Active") — used in the full-context format. */
  state?: string
  /** Optional ADO web URL — enables the "full context" copy variant. */
  webUrl?: string | null
  /**
   * Full work item, with description + relations hydrated. Required to
   * unlock the "Copy with description" family of options. Pass undefined
   * (e.g. from tree-view rows where description isn't loaded) and those
   * menu items are simply hidden.
   */
  item?: AdoWorkItem
  /** Org URL — needed alongside `item` to build the embedded URL header. */
  orgUrl?: string
  /** Hydrated comments for this item — required for the comments-included variant. */
  comments?: AdoComment[]
  /** Visual size; mirrors MUI Typography variants we use elsewhere. */
  variant?: 'caption' | 'overline' | 'body2'
  /** Override font size in px. Defaults to a sensible value per variant. */
  fontSize?: number
  /** Extra style for the text element. */
  className?: string
}

/**
 * Click-to-copy work item id, designed for "paste into Gen AI" workflows.
 *
 * The trigger renders as `#NNNNNN` styled to look subtly interactive
 * (hover background, copy icon, copy-cursor). Clicking opens a menu of
 * copy formats, ranging from the bare id to a full markdown blob with
 * the description (images embedded as base64 data URIs), key metadata,
 * and the comment thread — all suitable for pasting straight into a
 * chat prompt.
 *
 * Menu items are conditionally rendered: callers that only know the id
 * see the bare-id variants, callers that supply `item + orgUrl` also see
 * the description-embedding variants, and callers that supply comments
 * additionally see the full-thread variant.
 *
 * The component owns its own Snackbar for "Copied!" / progress feedback.
 * When the trigger lives inside a clickable parent (table row, card),
 * callers should let click events bubble normally — the trigger calls
 * `stopPropagation` itself so the row's onClick doesn't also fire.
 */
export default function WorkItemIdCopy({
  id,
  title,
  type,
  state,
  webUrl,
  item,
  orgUrl,
  comments,
  variant = 'caption',
  fontSize,
  className
}: Props): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const quickFormats = useMemo(() => {
    const out: { key: string; label: string; value: string }[] = []
    out.push({ key: 'id', label: `Copy ${id}`, value: String(id) })
    out.push({ key: 'hash', label: `Copy #${id}`, value: `#${id}` })
    if (title) {
      const compact = `#${id} — ${title}`
      out.push({ key: 'idTitle', label: `Copy #${id} — title`, value: compact })
    }
    if (title && webUrl) {
      const segments: string[] = [`#${id}`]
      if (type) segments.push(type)
      if (state) segments.push(state)
      segments.push(title)
      segments.push(webUrl)
      out.push({
        key: 'full',
        label: 'Copy with full context (type, state, title, url)',
        value: segments.join(' — ')
      })
    }
    return out
  }, [id, title, type, state, webUrl])

  // The description-aware variants depend on item + orgUrl being present
  // (we need the raw HTML body and a host to recognise ADO image URLs).
  const richScopes = useMemo<{ scope: CopyScope; label: string }[]>(() => {
    if (!item || !orgUrl) return []
    const out: { scope: CopyScope; label: string }[] = [
      { scope: 'description', label: 'Copy header + description' },
      { scope: 'descriptionMeta', label: 'Copy header + description + metadata' }
    ]
    if (comments) {
      out.push({
        scope: 'descriptionMetaComments',
        label: `Copy header + description + metadata + comments (${comments.length})`
      })
    }
    return out
  }, [item, orgUrl, comments])

  function openMenu(e: ReactMouseEvent<HTMLElement>): void {
    e.stopPropagation()
    e.preventDefault()
    setAnchor(e.currentTarget)
  }

  async function copyQuick(value: string, label: string): Promise<void> {
    setAnchor(null)
    try {
      await navigator.clipboard.writeText(value)
      const preview = label.length > 60 ? label.slice(0, 57) + '…' : label
      setToast(`Copied ${preview}`)
    } catch (err) {
      console.error('Clipboard write failed', err)
      setToast('Copy failed — clipboard permission denied?')
    }
  }

  async function copyRich(scope: CopyScope): Promise<void> {
    if (!item || !orgUrl) return
    setAnchor(null)
    setBusy(true)
    setToast('Preparing copy…')
    try {
      const result = await buildCopyBlob({
        item,
        orgUrl,
        scope,
        comments,
        onProgress: (p) => onCopyProgress(p)
      })
      await navigator.clipboard.writeText(result.markdown)
      const sizeLabel = formatBytes(result.bytes)
      const imgPart =
        result.imagesEmbedded === 0 && result.imagesFailed === 0
          ? ''
          : ` · ${result.imagesEmbedded} image${result.imagesEmbedded === 1 ? '' : 's'}` +
            (result.imagesFailed > 0 ? ` (${result.imagesFailed} failed)` : '')
      setToast(`Copied #${id} (${sizeLabel}${imgPart})`)
    } catch (err) {
      console.error('Rich copy failed', err)
      setToast('Copy failed — see console for details')
    } finally {
      setBusy(false)
    }
  }

  function onCopyProgress(p: CopyProgress): void {
    if (p.phase === 'fetchingImages' && p.imagesTotal > 0) {
      setToast(`Fetching images… ${p.imagesDone}/${p.imagesTotal}`)
    } else if (p.phase === 'assembling') {
      setToast('Assembling markdown…')
    }
  }

  const resolvedFontSize =
    fontSize ?? (variant === 'overline' ? 11 : variant === 'body2' ? 13 : 11)

  return (
    <>
      <Tooltip title="Click to copy id" enterDelay={500}>
        <Box
          component="span"
          onClick={openMenu}
          className={className}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.25,
            px: 0.5,
            py: 0,
            mx: -0.5,
            borderRadius: 0.75,
            cursor: 'copy',
            color: 'text.secondary',
            transition: 'background-color 120ms',
            '&:hover': {
              bgcolor: 'action.hover',
              color: 'text.primary'
            },
            '&:hover .work-item-id-copy-icon': {
              opacity: 1
            }
          }}
          aria-label={`Copy work item ${id}`}
          role="button"
        >
          <Typography
            variant={variant}
            component="span"
            sx={{
              fontVariantNumeric: 'tabular-nums',
              fontSize: resolvedFontSize,
              fontWeight: variant === 'overline' ? 600 : 500,
              lineHeight: 1
            }}
          >
            #{id}
          </Typography>
          <ContentCopyIcon
            className="work-item-id-copy-icon"
            sx={{
              fontSize: Math.max(resolvedFontSize - 1, 10),
              opacity: 0,
              transition: 'opacity 120ms'
            }}
          />
        </Box>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        onClick={(e) => e.stopPropagation()}
        slotProps={{
          paper: { sx: { minWidth: 280 } }
        }}
      >
        <ListSubheader sx={{ lineHeight: 1.6, py: 0.5 }}>Quick copy</ListSubheader>
        {quickFormats.map((f) => (
          <MenuItem
            key={f.key}
            onClick={(e) => {
              e.stopPropagation()
              void copyQuick(f.value, f.label.replace(/^Copy\s+/, ''))
            }}
            sx={{ fontSize: 13 }}
          >
            <ContentCopyIcon sx={{ fontSize: 14, mr: 1, color: 'text.secondary' }} />
            {f.label}
          </MenuItem>
        ))}
        {richScopes.length > 0 && [
          <Divider key="d" sx={{ my: 0.5 }} />,
          <ListSubheader key="h" sx={{ lineHeight: 1.6, py: 0.5 }}>
            Copy as Markdown (with embedded images)
          </ListSubheader>,
          ...richScopes.map((s) => (
            <MenuItem
              key={s.scope}
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                void copyRich(s.scope)
              }}
              sx={{ fontSize: 13 }}
            >
              {s.scope === 'description' ? (
                <DescriptionIcon sx={{ fontSize: 14, mr: 1, color: 'text.secondary' }} />
              ) : (
                <ImageIcon sx={{ fontSize: 14, mr: 1, color: 'text.secondary' }} />
              )}
              {s.label}
            </MenuItem>
          ))
        ]}
      </Menu>
      <Snackbar
        open={toast !== null}
        autoHideDuration={busy ? null : 2600}
        onClose={() => {
          if (!busy) setToast(null)
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        message={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {!busy && <CheckIcon sx={{ fontSize: 16 }} />}
            <Box component="span">{toast}</Box>
          </Box>
        }
      />
    </>
  )
}
