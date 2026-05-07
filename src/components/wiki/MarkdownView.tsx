import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box } from '@mui/material'
import { useNavigate, type NavigateFunction } from 'react-router-dom'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import {
  useBatchGetWorkItemsQuery,
  useGetConnectionQuery
} from '@/store/api/adoApi'
import { selectThemeMode } from '@/store/preferencesSlice'
import { selectWorkItem } from '@/store/workspaceSlice'
import { useAppDispatch, useAppSelector } from '@/store'
import { colorForState, colorForType } from '@/utils/adoColors'
import { IPC } from '@shared/contract'
import type { AdoWorkItem } from '@shared/adoTypes'

/**
 * Lazy-loaded mermaid module. Imported on first use of a mermaid block
 * so the ~700 KB diagram lib doesn't bloat the renderer's initial JS
 * bundle. Initialised once per session, then re-themed when the user
 * flips light/dark mode.
 */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null
let mermaidInitTheme: 'dark' | 'default' | null = null

async function getMermaid(
  themeName: 'dark' | 'default'
): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  const mermaid = await mermaidPromise
  // mermaid.initialize merges its options on subsequent calls, so re-
  // initialising on theme change is cheap and idempotent.
  if (mermaidInitTheme !== themeName) {
    mermaid.initialize({
      startOnLoad: false,
      theme: themeName,
      // 'loose' (rather than 'strict') is required for some diagram
      // kinds — notably gantt — to render reliably. 'strict' was
      // observed to silently drop gantt diagrams from ADO wiki pages.
      // Click handlers and arbitrary HTML in labels are still gated
      // by the upstream DOMPurify pass, so widening here doesn't add
      // real attack surface inside our Electron renderer.
      securityLevel: 'loose'
    })
    mermaidInitTheme = themeName
  }
  return mermaid
}

interface MarkdownViewProps {
  markdown: string
  /** Wiki id used to resolve `[[Page Title]]` links and relative
   *  attachment URLs back into the same wiki. */
  wikiId: string
  /** Wiki name — preserved on the container as a data attribute for
   *  callers that need to recover it from event targets. */
  wikiName?: string
  /** Project id (or name — both work in ADO REST URLs) used when
   *  building the authenticated Git items URL for inline attachments. */
  projectId?: string
  /** Git repo id backing this wiki (the `repositoryId` field on the
   *  `AdoWiki` object). Required to resolve relative
   *  `/.attachments/...` paths to the authenticated items endpoint. If
   *  missing, image proxying is silently disabled and original `<img>`
   *  tags render (likely as broken icons). */
  wikiRepositoryId?: string
  /** Canonical wiki path of the page being rendered (e.g.
   *  `/GPC-BAU/04-Developer-Guide/Azure-DevOps-Deployment-Guide-and-Fixes`).
   *  Used to resolve relative image paths that aren't anchored at
   *  `/.attachments/` — those resolve inside the page's own folder in
   *  the wiki repo, not at wiki root. */
  currentPagePath?: string
  /** When provided, every rendered table gets a hover-revealed "Edit"
   *  button that calls this with the table's parsed shape. Lets the
   *  caller open the shared TableBuilderDialog populated with the
   *  existing table — we don't write back to the wiki, the user
   *  copies the new markdown and pastes it back into ADO. */
  onEditTable?: (table: WikiMarkdownTable) => void
}

/**
 * Parsed shape of a markdown table found in the wiki source. Mirrors
 * the dialog's edit model — `cells[0]` is the header row when
 * `headerRow` is true; otherwise `cells` is body-only and the table
 * was authored with the synthetic-empty-header form.
 */
export interface WikiMarkdownTable {
  cells: string[][]
  alignments: ('left' | 'center' | 'right')[]
  headerRow: boolean
  /** Verbatim source of the table block, used by the wiki page
   *  orchestrator to splice the new markdown over the original block
   *  on Save (paired with `startLine` / `endLine`). */
  rawMarkdown: string
  /**
   * 0-based line index of the table's first line (header row) in the
   * source document. Pairs with `endLine` to define a half-open
   * `[startLine, endLine)` slice that matches the table block exactly,
   * so callers can splice replacements without touching neighbours.
   */
  startLine: number
  /**
   * 0-based line index of the line just past the table's last body row
   * (exclusive). Use `source.split('\n').slice(startLine, endLine)` to
   * recover the table's lines verbatim.
   */
  endLine: number
}

const MAX_RENDERED_CONTENT_LENGTH = 1_000_000

/**
 * Renders a wiki page's markdown source into sanitised, themed HTML
 * with ADO-aware link rewriting, inline-image proxying, and lazy
 * mermaid diagrams.
 *
 * Why this is non-trivial:
 *  1. Wiki-style `[[Page Title]]` and `[[Page Title|alias]]` links are
 *     not standard markdown — pre-pass before tokenisation.
 *  2. Inline images live on the ADO host and require Authorization;
 *     same problem as work-item descriptions, same fix (proxy via main
 *     process to a `data:` URI). Mirrors `RichDescription`.
 *  3. Mermaid is heavy. We import it dynamically and only when at least
 *     one mermaid block is present.
 */
export default function MarkdownView({
  markdown,
  wikiId,
  wikiName,
  projectId,
  wikiRepositoryId,
  currentPagePath,
  onEditTable
}: MarkdownViewProps): JSX.Element {
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const orgUrl = useGetConnectionQuery().data?.organizationUrl ?? ''
  const themeMode = useAppSelector(selectThemeMode)
  // Resolve actual mermaid theme name from the stored preference.
  const mermaidTheme = useResolvedMermaidTheme(themeMode)

  const md = useMemo(() => buildMarkdownIt(), [])

  // The configured ADO host — used to decide which `<img src>`s to
  // proxy via `IPC.AttachmentFetch` for auth-bearing fetches.
  const orgHost = useMemo(() => {
    try {
      return orgUrl ? new URL(orgUrl).host.toLowerCase() : ''
    } catch {
      return ''
    }
  }, [orgUrl])

  const sanitizedHtml = useMemo(() => {
    if (!markdown) return ''
    // TEMP debug — remove after wiki mermaid fix is confirmed.
    // Stage-by-stage instrumentation. The user pastes back the
    // `[MarkdownView] stages` line when a diagram still fails so we can
    // pinpoint which stage drops the fence:
    //   hasFenceAfterPreprocess: false        → preprocess broken
    //   …true but codeBlocksInRaw: 0          → markdown-it doesn't see the fence
    //   …N but codeBlocksInSanitised: 0       → DOMPurify strips the class
    //   …N but mermaidDivsInSanitised: 0      → walker isn't running / not finding them
    const before = markdown
    const counts = {
      pandocFencedDiv: 0,
      backtickFence: (before.match(/^[ \t]{0,3}```\s*mermaid/gm) ?? []).length,
      tildeFence: (before.match(/^[ \t]{0,3}~~~\s*mermaid/gm) ?? []).length,
      htmlDiv: 0
    }
    // Pre-passes run before markdown-it sees the source: ADO Pandoc-style
    // `::: mermaid` blocks become standard ` ```mermaid ` fences (so the
    // existing mermaid post-render walker keeps working), then wiki-link
    // syntax is normalised to plain markdown links.
    const after = preprocessWikiLinks(preprocessAdoMermaid(before, counts))
    const rawHtml = md.render(after)
    const sanitised = DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target', 'rel', 'class'],
      FORBID_TAGS: [
        'style',
        'script',
        'iframe',
        'form',
        'input',
        'object',
        'embed'
      ],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover']
    })

    if (typeof console !== 'undefined') {
      const hasFenceAfterPreprocess = /```mermaid/.test(after)
      const codeBlocksInRaw = (
        rawHtml.match(/<code[^>]*class="[^"]*language-mermaid[^"]*"/gi) ?? []
      ).length
      const codeBlocksInSanitised = (
        sanitised.match(/<code[^>]*class="[^"]*language-mermaid[^"]*"/gi) ?? []
      ).length
      const mermaidDivsInSanitised = (
        sanitised.match(/<div[^>]*class="[^"]*ado-mermaid[^"]*"/gi) ?? []
      ).length
      console.log('[MarkdownView] stages', {
        totalChars: before.length,
        variantCounts: counts,
        hasFenceAfterPreprocess,
        codeBlocksInRaw,
        codeBlocksInSanitised,
        mermaidDivsInSanitised
      })
      const w = window as Window & {
        __lastWikiMarkdownAfter?: string
        __lastWikiRawHtml?: string
        __lastWikiSanitised?: string
      }
      w.__lastWikiMarkdownAfter = after
      w.__lastWikiRawHtml = rawHtml
      w.__lastWikiSanitised = sanitised
    }

    return sanitised
  }, [markdown, md])

  const containerRef = useRef<HTMLDivElement | null>(null)
  // Map of original ADO image URL → resolved data URI. `null` means
  // the fetch failed; missing entry means in-flight or never requested.
  const [imageMap, setImageMap] = useState<Record<string, string | null>>({})
  // Sorted list of work-item ids the walker discovered in the rendered
  // DOM. Drives a single batch fetch — see `useBatchGetWorkItemsQuery`
  // below. Stays stable across renders (same array identity for the
  // same id set) so the RTK cache key doesn't flap.
  const [pendingWorkItemIds, setPendingWorkItemIds] = useState<number[]>([])
  // Reset when the source markdown / wiki changes — otherwise stale
  // mermaid SVGs, image URLs and work-item-ref hydrations would bleed
  // across pages.
  useEffect(() => {
    setImageMap({})
    setPendingWorkItemIds([])
  }, [markdown, wikiId])

  // Parse the source for table blocks once per markdown change. The
  // result is paired index-by-index with rendered DOM tables (see
  // Effect A's table walker). We keep this off the imageMap path so a
  // pending image fetch doesn't re-parse every table on the page.
  const parsedTables = useMemo(
    () => parseMarkdownTables(markdown ?? ''),
    [markdown]
  )

  // Stable click handler — captures the current navigate / wikiId /
  // dispatch / onEditTable via refs so we don't need to detach/reattach
  // on every render. Dispatch is technically already stable from
  // `useAppDispatch`, but the ref keeps the click closure consistent
  // with the other handlers.
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  const wikiIdRef = useRef(wikiId)
  wikiIdRef.current = wikiId
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch
  const onEditTableRef = useRef(onEditTable)
  onEditTableRef.current = onEditTable
  const parsedTablesRef = useRef(parsedTables)
  parsedTablesRef.current = parsedTables

  const handleClick = useCallback((e: Event): void => {
    // Edit-table button takes priority because it's our injected
    // affordance — never let it bubble through to the generic anchor
    // handler. Look up the parsed table by index from the ref so we
    // always read the current parse, not the one captured when the
    // button was wired up.
    const editBtn = (e.target as HTMLElement | null)?.closest(
      '[data-md-table-edit]'
    )
    if (editBtn) {
      e.preventDefault()
      e.stopPropagation()
      const idxStr = editBtn.getAttribute('data-md-table-edit')
      const idx = idxStr ? parseInt(idxStr, 10) : NaN
      const tables = parsedTablesRef.current
      const cb = onEditTableRef.current
      if (Number.isFinite(idx) && idx >= 0 && idx < tables.length && cb) {
        cb(tables[idx])
      }
      return
    }

    // Work-item ref chips take precedence over generic anchor handling
    // because a chip lives inside flowing text and could otherwise be
    // mistaken for an in-page anchor with no href. We dispatch into
    // the workspace slice — same path the search box uses to open the
    // drawer — so opening a wiki ref behaves identically to clicking
    // a search hit.
    const wiTarget = (e.target as HTMLElement | null)?.closest(
      '[data-work-item-id]'
    )
    if (wiTarget) {
      e.preventDefault()
      const idStr = wiTarget.getAttribute('data-work-item-id')
      const id = idStr ? parseInt(idStr, 10) : NaN
      if (Number.isFinite(id) && id > 0) {
        dispatchRef.current(selectWorkItem(id))
      }
      return
    }
    handleAnchorClick(e, navigateRef.current, wikiIdRef.current)
  }, [])

  // Single batch fetch for every work-item id referenced anywhere on
  // the page. Skipped while the list is empty — RTK caches by the
  // serialised arg so revisiting a page that asks for the same id set
  // re-uses the same cache entry. We only request the four fields the
  // chip actually needs to keep payload small.
  const workItemRefsQ = useBatchGetWorkItemsQuery(
    pendingWorkItemIds.length > 0
      ? {
          projectId,
          ids: pendingWorkItemIds,
          fields: [
            'System.Id',
            'System.Title',
            'System.WorkItemType',
            'System.State'
          ]
        }
      : (undefined as never),
    { skip: pendingWorkItemIds.length === 0 }
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.addEventListener('click', handleClick)
    return () => container.removeEventListener('click', handleClick)
  }, [handleClick])

  // imageMap is mutated by Effect A (which initiates fetches and calls
  // setImageMap with `null` sentinels for in-flight requests). If we
  // depended on imageMap inside Effect A, every setImageMap call would
  // trip the effect, set `cancelled = true` on the prior run, and
  // silently swallow the eventual IPC response — leaving images stuck
  // forever with `data-ado-src` set but no `src`. We sidestep this by
  // having Effect A read the current map through a ref (no
  // subscription) and depend only on the content/context that should
  // legitimately re-trigger discovery + fetching.
  const imageMapRef = useRef(imageMap)
  useEffect(() => {
    imageMapRef.current = imageMap
  }, [imageMap])

  // Effect A: discover ADO image URLs in the rendered DOM, initiate
  // their fetches, kick off any mermaid renders, and convert plain-text
  // `#123` work-item references into clickable placeholder chips. Re-
  // runs only when the content or fetch context changes — never on
  // imageMap or workItemRefsQ.data updates (those have their own
  // dedicated effects below).
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (!sanitizedHtml) return

    const imgs = container.querySelectorAll('img')
    const adoImageUrls = collectAdoImageUrls(container, {
      orgUrl,
      orgHost,
      projectId: projectId ?? '',
      wikiRepositoryId: wikiRepositoryId ?? '',
      currentPagePath: currentPagePath ?? ''
    })
    // TEMP debug — remove after wiki image fix is confirmed.
    if (typeof console !== 'undefined') {
      const failedCount = imgs.length - adoImageUrls.length
      console.log('[MarkdownView] images', {
        found: imgs.length,
        resolved: adoImageUrls.length,
        failed: failedCount
      })
    }

    let cancelled = false
    fetchAdoImages(
      adoImageUrls,
      imageMapRef.current,
      setImageMap,
      () => cancelled
    )

    const mermaidNodes = collectMermaidNodes(container)
    if (mermaidNodes.length > 0) {
      void renderMermaid(mermaidNodes, mermaidTheme, () => cancelled)
    }

    // Walk the freshly-rendered DOM, replacing every standalone
    // `#NNNNN` text run with a chip placeholder. The walker is
    // idempotent — it skips elements that already carry the
    // `ado-workitem-ref` class — so re-running it here when sibling
    // deps change can't double-wrap an already-converted ref.
    const refIds = replaceWorkItemRefs(container)
    setPendingWorkItemIds((prev) => (sameNumberArrays(prev, refIds) ? prev : refIds))

    return () => {
      cancelled = true
    }
  }, [
    sanitizedHtml,
    mermaidTheme,
    orgUrl,
    orgHost,
    wikiId,
    projectId,
    wikiRepositoryId,
    currentPagePath
  ])

  // Effect B: apply resolved data URIs to the img elements. This is
  // the only place that touches `<img src>` — it runs on every
  // imageMap change (a fetch completing) and on every content change
  // (so newly-rendered images pick up cached data URIs immediately).
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    rewriteImages(container, imageMap)
  }, [sanitizedHtml, imageMap])

  // Effect C: when the work-item batch fetch resolves, populate every
  // pending chip with the proper type / id / title / state structure
  // and apply the type / state colors as inline CSS variables. Also
  // re-runs on content change so newly-rendered chips pick up cached
  // RTK data immediately without waiting for a new fetch.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    hydrateWorkItemRefs(
      container,
      workItemRefsQ.data ?? null,
      workItemRefsQ.isFetching
    )
  }, [sanitizedHtml, workItemRefsQ.data, workItemRefsQ.isFetching])

  // Effect D: wrap every rendered <table> with an "Edit" affordance,
  // keyed by the table's index in the source. The actual click is
  // handled by the container-level click listener (handleClick) which
  // reads back `parsedTablesRef` — keeping all event wiring on one
  // bubbling listener avoids re-attaching N handlers per re-render.
  // Skipped entirely when no `onEditTable` is provided so non-wiki
  // markdown views (if any are added later) don't get phantom
  // controls.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (!onEditTable) {
      // Caller opted out — strip any leftover wrappers from a previous
      // render so we don't show non-functional buttons.
      unwrapEditableTables(container)
      return
    }
    attachTableEditButtons(container, parsedTables.length)
  }, [sanitizedHtml, parsedTables, onEditTable])

  // Hard ceiling so a runaway page can't lock the renderer. Real wiki
  // pages stay well under this; bloated docs get truncated.
  const safeHtml =
    sanitizedHtml.length > MAX_RENDERED_CONTENT_LENGTH
      ? sanitizedHtml.slice(0, MAX_RENDERED_CONTENT_LENGTH)
      : sanitizedHtml

  return (
    <Box
      ref={containerRef}
      data-wiki-id={wikiId}
      data-wiki-name={wikiName ?? ''}
      sx={(theme) => {
        const codeBg =
          theme.palette.mode === 'dark'
            ? 'rgba(255,255,255,0.08)'
            : 'rgba(0,0,0,0.06)'
        const tableBorder = theme.palette.divider
        const heading = theme.palette.text.primary
        return {
          fontSize: 14,
          lineHeight: 1.6,
          color: theme.palette.text.primary,
          wordBreak: 'break-word',
          '& h1, & h2, & h3, & h4, & h5, & h6': {
            color: heading,
            fontWeight: 600,
            mt: 2.5,
            mb: 1
          },
          '& h1': {
            fontSize: 26,
            borderBottom: `1px solid ${tableBorder}`,
            pb: 0.75
          },
          '& h2': {
            fontSize: 22,
            borderBottom: `1px solid ${tableBorder}`,
            pb: 0.5
          },
          '& h3': { fontSize: 18 },
          '& h4': { fontSize: 16 },
          '& h5, & h6': { fontSize: 14 },
          '& p': { my: 1 },
          '& ul, & ol': { pl: 3, my: 0.75 },
          '& li': { my: 0.25 },
          '& blockquote': {
            borderLeft: `4px solid ${tableBorder}`,
            pl: 1.5,
            my: 1.25,
            color: 'text.secondary'
          },
          '& code': {
            fontFamily: 'monospace',
            fontSize: '0.92em',
            bgcolor: codeBg,
            px: 0.5,
            py: 0.125,
            borderRadius: 0.5
          },
          '& pre': {
            bgcolor: codeBg,
            p: 1.25,
            borderRadius: 1,
            overflow: 'auto',
            fontSize: 12.5,
            lineHeight: 1.5,
            '& code': {
              bgcolor: 'transparent',
              p: 0,
              fontSize: 'inherit'
            }
          },
          '& a': {
            color: 'primary.main',
            textDecoration: 'none',
            '&:hover': { textDecoration: 'underline' }
          },
          '& img': {
            maxWidth: '100%',
            height: 'auto',
            borderRadius: 0.5,
            my: 1,
            display: 'inline-block'
          },
          '& table': {
            borderCollapse: 'collapse',
            my: 1.25,
            width: '100%',
            fontSize: 13
          },
          '& th, & td': {
            border: `1px solid ${tableBorder}`,
            px: 1,
            py: 0.5,
            verticalAlign: 'top'
          },
          '& th': {
            bgcolor: codeBg,
            fontWeight: 600,
            textAlign: 'left'
          },
          // Edit-table affordance. The wrapper exists only when the
          // parent supplies an onEditTable handler (see Effect D).
          // Tables stay full-width; the button floats over the top-
          // right corner and is keyboard-focusable for accessibility.
          '& .md-table-wrap': {
            position: 'relative',
            // Pin tables to a non-zero height so the button doesn't
            // visually collide with surrounding paragraphs when the
            // table itself is tiny.
            '&:hover .md-table-edit-btn, &:focus-within .md-table-edit-btn': {
              opacity: 1,
              pointerEvents: 'auto'
            },
            '& > table': { my: 1.25 }
          },
          '& .md-table-edit-btn': {
            position: 'absolute',
            top: 6,
            right: 6,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            px: 0.75,
            py: 0.25,
            fontSize: 11,
            lineHeight: 1.3,
            fontFamily: 'inherit',
            fontWeight: 600,
            color: theme.palette.primary.main,
            bgcolor:
              theme.palette.mode === 'dark'
                ? 'rgba(255,255,255,0.08)'
                : 'rgba(255,255,255,0.92)',
            border: `1px solid ${theme.palette.primary.main}`,
            borderRadius: 1,
            cursor: 'pointer',
            opacity: 0,
            pointerEvents: 'none',
            transition: 'opacity 120ms ease, background-color 120ms ease',
            backdropFilter: 'saturate(140%) blur(2px)',
            '&:hover': {
              bgcolor: theme.palette.primary.main,
              color: theme.palette.primary.contrastText
            },
            '&:focus-visible': {
              outline: `2px solid ${theme.palette.primary.main}`,
              outlineOffset: 2,
              opacity: 1,
              pointerEvents: 'auto'
            }
          },
          '& hr': {
            border: 'none',
            borderTop: `1px solid ${tableBorder}`,
            my: 2
          },
          '& .ado-mermaid': {
            display: 'block',
            my: 1.5,
            textAlign: 'center',
            '& svg': { maxWidth: '100%', height: 'auto' }
          },
          '& .ado-mermaid-error': {
            display: 'flex',
            flexDirection: 'column',
            gap: 0.5,
            my: 1.5,
            p: 1,
            border: '1px dashed',
            borderColor: 'warning.main',
            borderRadius: 1,
            bgcolor: codeBg,
            '& pre': { my: 0.5 }
          },
          '& .ado-callout': {
            my: 1.5,
            px: 1.5,
            py: 1,
            borderLeft: '4px solid',
            borderRadius: '0 4px 4px 0',
            // Trim outer margins on first/last child so the callout has
            // tight internal padding without extra paragraph air.
            '& > :first-of-type': { mt: 0 },
            '& > :last-child': { mb: 0 }
          },
          '& .ado-callout-warning': {
            borderColor: theme.palette.warning.main,
            bgcolor:
              theme.palette.mode === 'dark'
                ? 'rgba(255, 167, 38, 0.10)'
                : 'rgba(255, 167, 38, 0.14)'
          },
          '& .ado-callout-info': {
            borderColor: theme.palette.info.main,
            bgcolor:
              theme.palette.mode === 'dark'
                ? 'rgba(41, 182, 246, 0.10)'
                : 'rgba(41, 182, 246, 0.12)'
          },
          '& .ado-callout-tip': {
            borderColor: theme.palette.success.main,
            bgcolor:
              theme.palette.mode === 'dark'
                ? 'rgba(102, 187, 106, 0.10)'
                : 'rgba(102, 187, 106, 0.14)'
          },
          // Inline work-item ref chip. The walker mints these around
          // every standalone `#123` run, then Effect C populates the
          // inner spans and sets `--wi-color` / `--wi-state-color` as
          // inline CSS vars from the work-item type / state palette.
          '& .ado-workitem-ref': {
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: 0.5,
            mx: 0.25,
            px: 0.75,
            py: '1px',
            verticalAlign: 'baseline',
            borderRadius: 1,
            fontSize: 12.5,
            lineHeight: 1.4,
            cursor: 'pointer',
            bgcolor: codeBg,
            border: `1px solid ${tableBorder}`,
            borderLeft: '3px solid',
            borderLeftColor: 'var(--wi-color, transparent)',
            textDecoration: 'none',
            transition:
              'background 120ms ease, border-color 120ms ease, transform 120ms ease',
            '&:hover': {
              bgcolor: 'action.hover',
              borderLeftColor: 'var(--wi-color, transparent)'
            },
            '&:focus-visible': {
              outline: `2px solid ${theme.palette.primary.main}`,
              outlineOffset: 2
            }
          },
          '& .ado-workitem-ref-type': {
            fontSize: 10.5,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            color: 'var(--wi-color)'
          },
          '& .ado-workitem-ref-id': {
            fontWeight: 600,
            color: 'text.primary',
            fontVariantNumeric: 'tabular-nums'
          },
          '& .ado-workitem-ref-title': {
            fontWeight: 400,
            color: 'text.primary',
            maxWidth: 360,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          },
          '& .ado-workitem-ref-state': {
            fontSize: 10.5,
            fontWeight: 600,
            color: 'var(--wi-state-color, currentColor)',
            px: 0.5,
            borderRadius: 0.5,
            border: '1px solid',
            borderColor: 'var(--wi-state-color, divider)'
          },
          '& .ado-workitem-ref-pending': {
            // Visual cue for "we know this is a ref but haven't loaded
            // it yet" — neutral border, slightly muted. Resolves into
            // the type-color border once Effect C runs.
            borderLeftColor: theme.palette.divider,
            opacity: 0.75
          },
          '& .ado-workitem-ref-error': {
            // Either the work item doesn't exist, or the user can't
            // see it. We keep the chip clickable so they can still try
            // to open it in case authorisation is the only blocker.
            borderLeftColor: theme.palette.error.main,
            opacity: 0.75,
            fontStyle: 'italic'
          }
        }
      }}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  )
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function buildMarkdownIt(): MarkdownIt {
  // html: false — DOMPurify handles arbitrary HTML defence-in-depth, but
  // disabling it in markdown-it means raw `<script>` etc. never reach
  // the rendered string in the first place.
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    typographer: true
  })
  // Block-rule plugin: chosen over the blockquote-with-bold-label
  // fallback because it keeps nested markdown rendering intact and
  // produces semantic <div> wrappers we can style by class.
  registerAdoCalloutPlugin(md)
  return md
}

/**
 * Rewrite every plausible ADO mermaid syntax to a canonical
 * ` ```mermaid ` fenced block, so the post-render walker has a single
 * shape to recognise.
 *
 * ADO wiki content is messy: the Pandoc fenced div may use `:::` or
 * longer colon runs, may say `mermaid` or `Mermaid`, may have CRLF line
 * endings, and may have body content starting on the same line as the
 * opener. Some wikis use the raw `<div class="mermaid">` HTML form. We
 * try them all in order; what survives is left alone (already a code
 * fence that markdown-it handles natively).
 *
 * After rewrites we ensure each canonical fence has a blank line both
 * above and below it — a few markdown-it edge cases require this for
 * the fence to be recognised as a block (vs. emitted as inline text).
 */
function preprocessAdoMermaid(
  source: string,
  counts?: { pandocFencedDiv: number; htmlDiv: number }
): string {
  let out = source

  // 1. ADO Pandoc fenced div, body on its own lines:
  //      ::: mermaid
  //      gantt
  //      …
  //      :::
  // `:{3,}` allows ::: or longer (some pages use ::::), `i` flag covers
  // Mermaid/MERMAID, `\r?$` covers CRLF endings, body match is
  // non-greedy so the next `:::` line closes the block without eating
  // unrelated ones.
  //
  // Replacement template hard-codes `\n\n` ABOVE and BELOW the canonical
  // fence and `body.trimEnd()`s any trailing whitespace so the closing
  // ``` always sits at column 0 on its own line — markdown-it requires
  // that for fence detection when adjacent to other block elements.
  out = out.replace(
    /^[ \t]*:{3,}[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*:{3,}[ \t]*\r?$/gim,
    (_m, body: string) => {
      if (counts) counts.pandocFencedDiv += 1
      return `\n\n\`\`\`mermaid\n${body.trimEnd()}\n\`\`\`\n\n`
    }
  )

  // 2. Same opener but body starts on the same line as `::: mermaid`.
  //    Rare, but seen in real ADO exports. The leading `[^\r\n]` guard
  //    prevents this from matching the well-formed shape (which has a
  //    newline immediately after `mermaid` and is handled by #1).
  out = out.replace(
    /^[ \t]*:{3,}[ \t]*mermaid[ \t]+([^\r\n][\s\S]*?)\r?\n[ \t]*:{3,}[ \t]*\r?$/gim,
    (_m, body: string) => {
      if (counts) counts.pandocFencedDiv += 1
      return `\n\n\`\`\`mermaid\n${body.trimEnd()}\n\`\`\`\n\n`
    }
  )

  // 3. HTML embed form ADO permits in wiki: `<div class="mermaid">…</div>`.
  //    markdown-it has `html: false` so a literal div would be escaped,
  //    but rewriting it here lets us treat all variants uniformly.
  out = out.replace(
    /<div\s+class\s*=\s*["']mermaid["']\s*>([\s\S]*?)<\/div>/gi,
    (_m, body: string) => {
      if (counts) counts.htmlDiv += 1
      return `\n\n\`\`\`mermaid\n${body.trim()}\n\`\`\`\n\n`
    }
  )

  // 4. Already a ` ```mermaid ` / `~~~mermaid` fence — leave intact;
  //    markdown-it handles those natively.
  //
  // Future consideration (intentionally NOT implemented — too risky for
  // false positives): rescue paragraphs whose text starts with `gantt`,
  // `flowchart`, `sequenceDiagram`, `graph TD/LR`, `pie`, `classDiagram`,
  // `stateDiagram` if everything above failed. Skipped for now.

  // Belt-and-braces normalisation. The replace templates above already
  // wrap fences in `\n\n`, but if the original source already contained
  // a raw ```mermaid fence (variant #4) we still want to ensure it's
  // separated from neighbouring block elements.
  out = out.replace(/([^\n])\n```mermaid/g, '$1\n\n```mermaid')
  out = out.replace(/```mermaid([^\n])/g, '```mermaid\n$1')
  out = out.replace(/```\n([^\n])/g, '```\n\n$1')
  // Collapse 3+ blank lines so we don't fight ourselves on subsequent
  // passes or produce odd spacing in the rendered output.
  out = out.replace(/\n{3,}/g, '\n\n')
  return out
}

/**
 * markdown-it plugin: recognise ADO callout fenced divs and emit
 * `<div class="ado-callout ado-callout-<variant>">` wrappers with the
 * inner block tokens parsed normally. Supported names map to three
 * visual variants:
 *
 *   ::: warning  → `ado-callout-warning`
 *   ::: info     → `ado-callout-info`
 *   ::: note     → `ado-callout-info`  (alias)
 *   ::: tip      → `ado-callout-tip`
 *
 * `::: mermaid` is intentionally NOT handled here — the pre-pass
 * rewrites those into standard fenced code blocks before tokenisation.
 *
 * Note on `html: false`: that flag only governs how the parser
 * interprets HTML appearing in source. Tokens of type `html_block`
 * pushed programmatically are rendered as-is, so wrapping div tags
 * survive the pipeline. DOMPurify is the actual safety net.
 */
function registerAdoCalloutPlugin(md: MarkdownIt): void {
  const variants: Record<string, string> = {
    warning: 'warning',
    info: 'info',
    note: 'info',
    tip: 'tip'
  }
  md.block.ruler.before(
    'fence',
    'ado_fenced_div',
    function adoFencedDiv(state, startLine, endLine, silent): boolean {
      const start = state.bMarks[startLine] + state.tShift[startLine]
      const max = state.eMarks[startLine]
      const open = state.src.slice(start, max)
      // Tolerate `:::` or longer (`::::`), mixed-case names
      // (`::: Warning`), trailing CR (CRLF wiki exports), and any run
      // of spaces/tabs around the variant name.
      const m = /^:{3,}[ \t]*([a-zA-Z]+)[ \t]*\r?$/i.exec(open)
      if (!m) return false
      const variant = variants[m[1].toLowerCase()]
      if (!variant) return false
      if (silent) return true

      // Find the closing fence line — same `:{3,}` tolerance, optional
      // trailing whitespace, optional carriage return.
      let closeLine = -1
      for (let line = startLine + 1; line < endLine; line++) {
        const ls = state.bMarks[line] + state.tShift[line]
        const le = state.eMarks[line]
        if (/^:{3,}[ \t]*\r?$/.test(state.src.slice(ls, le))) {
          closeLine = line
          break
        }
      }
      if (closeLine === -1) return false

      const oldParent = state.parentType
      const oldLineMax = state.lineMax
      // 'reference' is an existing parentType slot; using a recognised
      // value keeps third-party rules that branch on parentType from
      // misbehaving inside the callout body.
      state.parentType = 'reference'
      state.lineMax = closeLine

      let token = state.push('html_block', '', 0)
      token.markup = ':::'
      token.map = [startLine, startLine + 1]
      token.content = `<div class="ado-callout ado-callout-${variant}">\n`

      state.md.block.tokenize(state, startLine + 1, closeLine)

      token = state.push('html_block', '', 0)
      token.markup = ':::'
      token.map = [closeLine, closeLine + 1]
      token.content = `</div>\n`

      state.parentType = oldParent
      state.lineMax = oldLineMax
      state.line = closeLine + 1
      return true
    }
  )
}

/**
 * Convert wiki-link syntax to standard markdown links.
 *   [[Page Title]]            → [Page Title](?path=/Page-Title)
 *   [[Page Title|alias]]      → [alias](?path=/Page-Title)
 *
 * The href is intentionally a query-only string — the click interceptor
 * turns it into a full `/wiki?...` route on the same wiki. Spaces in
 * the title get kebab-cased to match how ADO encodes wiki page paths.
 */
function preprocessWikiLinks(source: string): string {
  return source.replace(/\[\[([^\]\n]+)\]\]/g, (match, body: string) => {
    const [target, label] = body.split('|').map((s: string) => s.trim())
    if (!target) return match
    const text = (label ?? target).replace(/[[\]]/g, '')
    const slug = target.replace(/\s+/g, '-')
    const href = `?path=/${encodeURIComponent(slug)}`
    return `[${text}](${href})`
  })
}

interface WikiImageContext {
  orgUrl: string
  orgHost: string
  projectId: string
  wikiRepositoryId: string
  /** The wiki path of the page being rendered, used to resolve image
   *  paths that aren't anchored at `/.attachments/`. May be empty,
   *  in which case those images can't be resolved. */
  currentPagePath: string
}

/**
 * Walk the rendered DOM, find every `<img>` whose src either lives on
 * the configured ADO host or is a relative wiki path, and tag it with
 * the absolute attachment URL we'll fetch via IPC.
 *
 * Relative paths (`/.attachments/foo.png`, `.attachments/foo.png`,
 * `./.attachments/foo.png`) are resolved against the wiki's Git repo
 * via the items endpoint — that's where ADO actually stores wiki
 * attachments. Absolute URLs already pointing at the ADO host are
 * proxied as-is.
 */
function collectAdoImageUrls(
  container: HTMLElement,
  ctx: WikiImageContext
): string[] {
  if (!ctx.orgUrl) return []
  const found = new Set<string>()
  const imgs = container.querySelectorAll('img')
  imgs.forEach((img) => {
    if (img.hasAttribute('data-ado-src')) {
      const existing = img.getAttribute('data-ado-src')
      if (existing) found.add(existing)
      return
    }
    const rawSrc = img.getAttribute('src') ?? ''
    if (!rawSrc) return
    const resolved = resolveWikiImageUrl(rawSrc, ctx)
    if (!resolved) return
    found.add(resolved)
    img.setAttribute('data-ado-src', resolved)
    img.removeAttribute('src')
    if (!img.hasAttribute('alt')) img.setAttribute('alt', 'attachment')
  })
  return [...found]
}

/**
 * Convert a wiki "display path" (page titles with spaces, e.g.
 * `/GPC Revamp/Technical Docs/Infrastructure`) into the path ADO
 * actually stores those pages at in the wiki's Git repo (e.g.
 * `/GPC-Revamp/Technical-Docs/Infrastructure`). ADO's slug rule per
 * page-segment is "spaces → hyphens"; hyphens already in titles are
 * preserved, so the operation is idempotent for already-slugged paths.
 *
 * We deliberately don't touch other special characters here — the
 * vast majority of wiki page names use only spaces + alphanumerics,
 * and over-aggressive slug rules (parens, colons, etc.) risk breaking
 * paths that already came in disk-form. If a wiki has stranger page
 * names, the upstream `gitItemPath` field is the correct source — but
 * for this pass, simple space→hyphen handles the IHIS-HIP shape and
 * everything similar.
 */
function wikiPagePathToGitPath(displayPath: string): string {
  return displayPath
    .split('/')
    .map((seg) => seg.replace(/ /g, '-'))
    .join('/')
}

/**
 * Decode percent-escapes once, defensively.
 *
 * markdown-it normalizes a markdown image src like `Foo Bar.png` to
 * `Foo%20Bar.png` before handing it to renderers. If we then pass that
 * pre-encoded value straight to `URLSearchParams.set('path', ...)`, the
 * `%` itself gets re-encoded as `%25`, producing `Foo%2520Bar.png` in
 * the final URL. ADO faithfully decodes that to a file literally named
 * `Foo%20Bar.png` (with the percent-2-zero text in its name) and 404s.
 *
 * A single decode here flattens that round-trip — and is idempotent for
 * srcs that arrived without any encoding to begin with.
 */
function decodeOnce(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * Encode a wiki repo path as the `path=` query value in a Git Items API
 * URL the same way the ADO web UI does: each segment is
 * percent-encoded, but the `/` separators are kept literal. This avoids
 * `URLSearchParams`'s defaults (`+` for space, `%2F` for `/`) which —
 * while technically RFC-compliant — don't match ADO's wire format and
 * make round-trip debugging much harder.
 */
function encodePathForAdoQuery(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * Resolve `.`/`..` segments inside a path the way a web browser does
 * for relative `<img src>` resolution.
 *
 * ADO's Git Items API treats paths literally — it won't follow a `..`
 * inside the `path=` query value. So if a wiki page at
 * `/Foo/Bar/Baz` references `![](../assets/x.png)`, the joined path
 * `/Foo/Bar/Baz/../assets/x.png` reaches ADO as a 404 unless we
 * collapse the `..` ourselves to `/Foo/Bar/assets/x.png` first.
 *
 * Pop semantics: a leading `..` past root is ignored (path stays at
 * root), matching how browsers handle `<a href="../foo">` from the
 * domain root. Empty segments and `.` are dropped. Trailing slashes
 * are not preserved — wiki image paths never end in `/` anyway.
 */
function normalizeWikiPath(path: string): string {
  const isAbsolute = path.startsWith('/')
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0) out.pop()
      continue
    }
    out.push(seg)
  }
  return (isAbsolute ? '/' : '') + out.join('/')
}

/**
 * Map a raw `<img src>` in wiki markdown to an absolute, authenticated
 * URL we can fetch through the main process.
 *
 * Patterns handled (all of these are common in ADO wiki content):
 *   - `/.attachments/foo.png`   — wiki-root attachments folder (the
 *     ADO editor's default upload destination).
 *   - `.attachments/foo.png`    — same, no leading slash.
 *   - `./.attachments/foo.png`  — same, with explicit current-dir prefix.
 *   - `image.png`, `assets/foo.png`, `./assets/foo.png` — page-relative
 *     paths. Resolved against the CURRENT PAGE'S folder in the wiki
 *     repo, not the wiki root. This matches how ADO actually stores
 *     non-`.attachments/` images alongside their pages.
 *   - `https://dev.azure.com/.../_apis/git/repositories/.../items?...`
 *     — already absolute Git items URL → returned as-is.
 *   - `https://dev.azure.com/.../_apis/wiki/wikis/.../attachments/...`
 *     — already absolute wiki attachments URL → returned as-is.
 *
 * Returns `null` for `data:` / `mailto:` / `javascript:` and similar —
 * leaves the original src alone so the renderer doesn't strip it.
 *
 * Path handling notes:
 *   - The markdown src is decoded once (see {@link decodeOnce}) so we
 *     never feed a `%`-bearing string to a second URL-encoder.
 *   - Page-derived directory segments are slug-converted (see
 *     {@link wikiPagePathToGitPath}) because ADO stores wiki pages with
 *     hyphens-for-spaces in folder names, even though the API exposes
 *     display titles with spaces.
 *   - Asset filenames are preserved verbatim — only the directory
 *     portion is slug-converted — because asset filenames keep their
 *     original spaces in the repo.
 *   - The final query string is hand-built so spaces emerge as `%20`
 *     and `/` stays literal, mirroring ADO's web UI byte-for-byte.
 */
function resolveWikiImageUrl(
  rawSrc: string,
  ctx: WikiImageContext
): string | null {
  if (!rawSrc) return null
  const trimmed = rawSrc.trim()
  if (!trimmed) return null
  if (/^(data:|mailto:|javascript:)/i.test(trimmed)) return null
  // Already absolute (http/https).
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed)
      const host = u.host.toLowerCase()
      if (ctx.orgHost && host === ctx.orgHost) return u.toString()
      if (
        host === 'dev.azure.com' ||
        host.endsWith('.dev.azure.com') ||
        host.endsWith('.visualstudio.com')
      ) {
        return u.toString()
      }
      return null
    } catch {
      return null
    }
  }
  if (!ctx.projectId || !ctx.wikiRepositoryId) return null

  // Decode once before any further processing — see decodeOnce JSDoc.
  const decoded = decodeOnce(trimmed)

  // Build a single joined path, then normalize. Three input shapes:
  //   1. `/.attachments/...` — wiki-root attachments folder. Bypass page
  //      resolution entirely; `.attachments` is a literal directory the
  //      ADO editor uses for paste-uploaded images.
  //   2. `/Some/Path/foo.png` — author-supplied absolute repo path.
  //      Anchored at wiki root, no `currentPagePath` involved.
  //   3. anything else        — relative to the current page's folder.
  //      Per ADO's wiki rules, "the current page's folder" means the
  //      slug-form folder named after the page (where its sub-pages
  //      and assets live), not the parent directory of the .md file.
  //
  // After joining, we normalize so any `.` and `..` segments collapse
  // before the path becomes a query value — ADO's Items API treats
  // paths literally and won't follow `..` itself.
  let joinedPath: string
  const decodedNoLeadingDot = decoded.replace(/^\.\/+/, '')
  if (/^\/?\.attachments\//i.test(decodedNoLeadingDot)) {
    joinedPath = decodedNoLeadingDot.startsWith('/')
      ? decodedNoLeadingDot
      : `/${decodedNoLeadingDot}`
  } else if (decoded.startsWith('/')) {
    // Slug-convert just the directory portion (idempotent for paths
    // that already arrive in hyphen form) and preserve the filename
    // verbatim — asset filenames keep their repo-stored spaces.
    const idxLastSlash = decoded.lastIndexOf('/')
    const dir = decoded.slice(0, idxLastSlash)
    const file = decoded.slice(idxLastSlash + 1)
    joinedPath = `${wikiPagePathToGitPath(dir)}/${file}`
  } else {
    if (!ctx.currentPagePath) return null
    // ADO's wiki renderer resolves relative paths against the PARENT
    // DIRECTORY of the page's .md file — not against a folder named
    // after the page (that folder is where sub-pages live, not where
    // assets are searched). E.g. for a page at /Foo/Bar/Baz, the .md
    // file is /Foo/Bar/Baz.md and `assets/x.png` resolves to
    // /Foo/Bar/assets/x.png — sibling of Baz.md, NOT under /Foo/Bar/Baz/.
    //
    // Strip the page name (the last segment of the slug-form path) to
    // get that parent. Top-level pages collapse to `''`, joining to
    // `/<src>` which is wiki-root-relative — also correct.
    const slugged = wikiPagePathToGitPath(ctx.currentPagePath).replace(
      /\/+$/,
      ''
    )
    const lastSlash = slugged.lastIndexOf('/')
    const pageParentDir = lastSlash >= 0 ? slugged.slice(0, lastSlash) : ''
    // Pass the raw decoded src — normalizeWikiPath below collapses any
    // `./` and `..` segments in a single pass.
    joinedPath = `${pageParentDir}/${decoded}`
  }

  const resolvedPath = normalizeWikiPath(joinedPath)
  if (!resolvedPath || resolvedPath === '/') return null

  // Build the URL manually so we match ADO's web UI byte-for-byte.
  // `URLSearchParams` would emit `+` for space and `%2F` for `/`, which
  // ADO's API tolerates but doesn't itself emit — and that mismatch
  // makes manual URL comparison during debugging much noisier.
  const base = ctx.orgUrl.replace(/\/+$/, '')
  const projectSeg = encodeURIComponent(ctx.projectId)
  const repoSeg = encodeURIComponent(ctx.wikiRepositoryId)
  const pathParam = encodePathForAdoQuery(resolvedPath)
  return (
    `${base}/${projectSeg}/_apis/git/repositories/${repoSeg}/items` +
    `?path=${pathParam}` +
    `&%24format=octetStream` +
    `&download=false` +
    `&resolveLfs=true` +
    `&sanitize=true` +
    `&versionDescriptor.version=wikiMaster` +
    `&api-version=7.1`
  )
}

function fetchAdoImages(
  urls: string[],
  current: Record<string, string | null>,
  setMap: React.Dispatch<React.SetStateAction<Record<string, string | null>>>,
  isCancelled: () => boolean
): void {
  for (const url of urls) {
    if (current[url] !== undefined) continue
    // Mark in-flight via a sentinel `null` immediately so a follow-up
    // effect run doesn't refetch. Replaced with the real data URI when
    // the IPC promise resolves.
    setMap((prev) => (prev[url] !== undefined ? prev : { ...prev, [url]: null }))
    window.ado
      .invoke(IPC.AttachmentFetch, { url })
      .then(({ dataBase64, contentType }) => {
        if (isCancelled()) return
        // TEMP debug — remove after wiki image fix is confirmed.
        console.log('[MarkdownView] image OK', {
          url,
          contentType,
          base64Length: dataBase64?.length ?? 0,
          looksLikeImage: typeof contentType === 'string' && contentType.startsWith('image/')
        })
        setMap((prev) => ({
          ...prev,
          [url]: `data:${contentType};base64,${dataBase64}`
        }))
      })
      .catch((err) => {
        // TEMP debug — remove after wiki image fix is confirmed.
        const e = err as { message?: string; data?: { message?: string; code?: string } }
        console.log('[MarkdownView] image FAIL', {
          url,
          message: e?.message ?? e?.data?.message ?? String(err),
          code: e?.data?.code
        })
        // Leave the null sentinel in place; rewriteImages knows to keep
        // a placeholder in that case rather than reverting to the broken
        // ADO URL (which would 401).
      })
  }
}

/* ------------------------------------------------------------------ */
/* work-item ref chips                                                  */
/* ------------------------------------------------------------------ */

const WORK_ITEM_REF_SKIP_TAGS = new Set([
  'A',
  'CODE',
  'PRE',
  'SCRIPT',
  'STYLE',
  'TEXTAREA'
])

const WORK_ITEM_REF_SKIP_CLASSES = ['ado-mermaid', 'ado-workitem-ref']

/**
 * Convert every standalone `#NNNNN` run in the rendered DOM to a
 * placeholder chip. Returns the unique, sorted set of work-item ids
 * the walker spotted so Effect A can drive a single batch fetch.
 *
 * Skip rules:
 *  - inside `<a>` / `<code>` / `<pre>` / `<script>` / `<style>` /
 *    `<textarea>` — those carry their own meaning and shouldn't be
 *    chipped (think: a sample snippet that mentions issue numbers).
 *  - inside any element that already carries `ado-mermaid` or
 *    `ado-workitem-ref` — keeps the walker idempotent so re-running
 *    it can never wrap an already-wrapped chip.
 *
 * Match rules:
 *  - `#` followed by 1..9 digits — anything longer is almost
 *    certainly not a work-item id (timestamps, hashes, etc.)
 *  - the character before `#` must NOT be an ASCII letter or `_`.
 *    This lets us pick up `Issue #123`, `Closed #123.`, even
 *    `#123#456` (chained refs), while ignoring `abc#123` (which is
 *    almost always part of a URL fragment, identifier or HTML id).
 */
function replaceWorkItemRefs(container: HTMLElement): number[] {
  const ids = new Set<number>()
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node: Node): number {
        let p = (node as Text).parentElement
        while (p && p !== container) {
          if (WORK_ITEM_REF_SKIP_TAGS.has(p.tagName)) {
            return NodeFilter.FILTER_REJECT
          }
          for (const cls of WORK_ITEM_REF_SKIP_CLASSES) {
            if (p.classList.contains(cls)) return NodeFilter.FILTER_REJECT
          }
          p = p.parentElement
        }
        return /#\d/.test(node.nodeValue ?? '')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP
      }
    }
  )
  const targets: Text[] = []
  let n: Node | null = walker.nextNode()
  while (n) {
    targets.push(n as Text)
    n = walker.nextNode()
  }
  for (const textNode of targets) {
    processWorkItemRefTextNode(textNode, ids)
  }
  return [...ids].sort((a, b) => a - b)
}

function processWorkItemRefTextNode(
  node: Text,
  foundIds: Set<number>
): void {
  const text = node.nodeValue ?? ''
  const re = /#(\d{1,9})/g
  const fragments: Node[] = []
  let lastIndex = 0
  let m: RegExpExecArray | null
  let matched = false
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const id = parseInt(m[1], 10)
    if (!Number.isFinite(id) || id <= 0) continue
    // Reject when the immediate previous character is a letter or
    // underscore — that means we're sitting inside a word or
    // identifier (e.g. `abc#123`, `id_#1`) rather than a real ref.
    const prev = start > 0 ? text[start - 1] : ''
    if (/[a-zA-Z_]/.test(prev)) continue
    if (start > lastIndex) {
      fragments.push(document.createTextNode(text.slice(lastIndex, start)))
    }
    fragments.push(makeWorkItemRefChip(id))
    foundIds.add(id)
    lastIndex = re.lastIndex
    matched = true
  }
  if (!matched) return
  if (lastIndex < text.length) {
    fragments.push(document.createTextNode(text.slice(lastIndex)))
  }
  const parent = node.parentNode
  if (!parent) return
  for (const f of fragments) parent.insertBefore(f, node)
  parent.removeChild(node)
}

/**
 * Mints the placeholder chip the walker drops into the DOM. The shape
 * mirrors the post-hydration chip (same wrapper class + id span) so
 * styling is consistent across states; the hydrator just appends the
 * remaining spans (type, title, state) once the batch fetch resolves.
 */
function makeWorkItemRefChip(id: number): HTMLSpanElement {
  const chip = document.createElement('span')
  chip.className = 'ado-workitem-ref ado-workitem-ref-pending'
  chip.setAttribute('data-work-item-id', String(id))
  chip.setAttribute('role', 'link')
  chip.setAttribute('tabindex', '0')
  chip.setAttribute('title', `Work item #${id} — loading…`)
  const idSpan = document.createElement('span')
  idSpan.className = 'ado-workitem-ref-id'
  idSpan.textContent = `#${id}`
  chip.appendChild(idSpan)
  return chip
}

/**
 * Populate every chip with type / title / state once the batch fetch
 * resolves. `data-hydrated` guards against re-running on an already-
 * hydrated chip (idempotent across Effect C re-runs). Failures (id
 * not in the response) get a softer "error" styling but stay
 * clickable — opening the drawer might surface an authorisation hint
 * the wiki view alone can't.
 */
function hydrateWorkItemRefs(
  container: HTMLElement,
  items: AdoWorkItem[] | null,
  fetching: boolean
): void {
  const byId = new Map<number, AdoWorkItem>()
  if (items) for (const w of items) byId.set(w.id, w)
  const chips = container.querySelectorAll<HTMLElement>('[data-work-item-id]')
  chips.forEach((chip) => {
    if (chip.getAttribute('data-hydrated') === 'true') return
    const idStr = chip.getAttribute('data-work-item-id')
    const id = idStr ? parseInt(idStr, 10) : NaN
    if (!Number.isFinite(id)) return
    const wi = byId.get(id)
    if (!wi) {
      // Either the fetch is still in flight or the id wasn't returned
      // (deleted / inaccessible). Only commit the error styling when
      // we know the fetch finished — otherwise the chip would flash
      // red for a frame between request and response.
      if (!fetching) {
        chip.classList.remove('ado-workitem-ref-pending')
        chip.classList.add('ado-workitem-ref-error')
        chip.setAttribute('title', `Work item #${id} — not accessible`)
      }
      return
    }
    const type =
      (wi.fields['System.WorkItemType'] as string | undefined) ?? 'Item'
    const state =
      (wi.fields['System.State'] as string | undefined) ?? ''
    const title = (wi.fields['System.Title'] as string | undefined) ?? ''
    const typeColor = colorForType(type)
    const stateColor = colorForState(state)
    chip.classList.remove(
      'ado-workitem-ref-pending',
      'ado-workitem-ref-error'
    )
    chip.setAttribute('data-hydrated', 'true')
    chip.setAttribute('data-work-item-type', type)
    chip.setAttribute('data-work-item-state', state)
    chip.style.setProperty('--wi-color', typeColor)
    chip.style.setProperty('--wi-state-color', stateColor)
    chip.setAttribute(
      'title',
      `${type} #${id} — ${title}${state ? ` (${state})` : ''}`
    )
    chip.replaceChildren()
    const typeBadge = document.createElement('span')
    typeBadge.className = 'ado-workitem-ref-type'
    typeBadge.textContent = type
    const idSpan = document.createElement('span')
    idSpan.className = 'ado-workitem-ref-id'
    idSpan.textContent = `#${id}`
    const titleSpan = document.createElement('span')
    titleSpan.className = 'ado-workitem-ref-title'
    titleSpan.textContent = title
    chip.append(typeBadge, idSpan, titleSpan)
    if (state) {
      const stateSpan = document.createElement('span')
      stateSpan.className = 'ado-workitem-ref-state'
      stateSpan.textContent = state
      chip.appendChild(stateSpan)
    }
  })
}

/**
 * Stable equality for the `pendingWorkItemIds` setter. Returning the
 * previous array when the new list is value-equal keeps React from
 * scheduling a no-op re-render and (more importantly) keeps the RTK
 * Query cache key for {@link useBatchGetWorkItemsQuery} stable across
 * benign re-walks of the same content.
 */
function sameNumberArrays(
  a: readonly number[],
  b: readonly number[]
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

function rewriteImages(
  container: HTMLElement,
  imageMap: Record<string, string | null>
): void {
  const imgs = container.querySelectorAll('img[data-ado-src]')
  imgs.forEach((img) => {
    const url = img.getAttribute('data-ado-src') ?? ''
    const resolved = imageMap[url]
    if (typeof resolved === 'string' && resolved.startsWith('data:')) {
      if (img.getAttribute('src') !== resolved) {
        img.setAttribute('src', resolved)
      }
    }
  })
}

function handleAnchorClick(
  e: Event,
  navigate: NavigateFunction,
  currentWikiId: string
): void {
  const target = (e.target as HTMLElement | null)?.closest('a')
  if (!target) return
  const href = target.getAttribute('href')
  if (!href) return
  // Empty / in-page anchors: leave to the browser.
  if (href.startsWith('#')) return
  // Wiki-link preprocessor leaves `?path=/...` hrefs that should stay
  // on the current wiki.
  if (href.startsWith('?')) {
    e.preventDefault()
    const params = new URLSearchParams(href.slice(1))
    if (currentWikiId && !params.has('wiki')) {
      params.set('wiki', currentWikiId)
    }
    navigate(`/wiki?${params.toString()}`)
    return
  }
  if (href.startsWith('/wiki')) {
    e.preventDefault()
    navigate(href)
    return
  }
  // Absolute URL → external. Always open in the OS default browser via
  // IPC so the renderer doesn't navigate itself away.
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault()
    void window.ado.invoke(IPC.ShellOpenExternal, { url: href })
    return
  }
  // Anything else (relative path) is a wiki page reference, e.g. a
  // markdown link like `(./Sibling-Page)` or `(/Some-Page)`.
  e.preventDefault()
  const path = href.startsWith('/') ? href : `/${href}`
  navigate(
    `/wiki?wiki=${encodeURIComponent(currentWikiId)}&path=${encodeURIComponent(path)}`
  )
}

interface MermaidNode {
  container: HTMLDivElement
  source: string
}

/**
 * Find every plausible mermaid block in the rendered DOM and replace
 * it with a `<div class="ado-mermaid">` whose textContent is the raw
 * diagram source. `mermaid.run` consumes that textContent and swaps it
 * for an SVG.
 *
 * Two shapes are accepted:
 *   1. `<pre><code class="...mermaid...">` — emitted by markdown-it for
 *      both backtick and tilde fenced blocks. The class fragment match
 *      catches non-canonical class names some renderers produce.
 *   2. `<div class="mermaid">` — the raw HTML embed form, in case it
 *      survived sanitisation (DOMPurify allows `div`/`class`). The
 *      pre-processor normally rewrites these, but we accept them here
 *      as a defensive fallback.
 */
function collectMermaidNodes(container: HTMLElement): MermaidNode[] {
  const out: MermaidNode[] = []
  const seen = new Set<Element>()

  // 1. Markdown-it fenced code blocks: replace the parent <pre> with a
  //    fresh <div class="ado-mermaid">. The class fragment match
  //    (`[class*="mermaid"]`) catches any class containing "mermaid"
  //    (e.g. `language-mermaid`, plain `mermaid`).
  const codeBlocks = container.querySelectorAll('pre code[class*="mermaid"]')
  codeBlocks.forEach((codeEl) => {
    const pre = codeEl.closest('pre')
    if (!pre) return
    const source = (codeEl.textContent ?? '').trim()
    if (!source) return
    const div = document.createElement('div')
    div.className = 'ado-mermaid'
    div.textContent = source
    pre.replaceWith(div)
    seen.add(div)
    out.push({ container: div, source })
  })

  // 2. Standalone `<div class="mermaid">` (rare — DOMPurify may pass it
  //    through if the source already had it). Just stamp the
  //    `ado-mermaid` class on so styles + mermaid run apply uniformly,
  //    rather than replacing the node (preserves any inline attrs).
  const divMermaids = container.querySelectorAll(
    'div.mermaid:not(.ado-mermaid)'
  )
  divMermaids.forEach((divEl) => {
    const source = (divEl.textContent ?? '').trim()
    if (!source) return
    divEl.classList.add('ado-mermaid')
    seen.add(divEl)
    out.push({ container: divEl as HTMLDivElement, source })
  })

  // 3. Pre-existing `<div class="ado-mermaid">` — defensive sweep so a
  //    third matching shape can't slip past unrendered. `seen` keeps us
  //    from double-counting nodes already collected via #1.
  const divAdoMermaids = container.querySelectorAll('div.ado-mermaid')
  divAdoMermaids.forEach((divEl) => {
    if (seen.has(divEl)) return
    const source = (divEl.textContent ?? '').trim()
    if (!source) return
    out.push({ container: divEl as HTMLDivElement, source })
  })

  return out
}

async function renderMermaid(
  nodes: MermaidNode[],
  themeName: 'dark' | 'default',
  isCancelled: () => boolean
): Promise<void> {
  let mermaid: typeof import('mermaid').default
  try {
    mermaid = await getMermaid(themeName)
  } catch (err) {
    if (isCancelled()) return
    for (const node of nodes) {
      replaceWithError(node.container, node.source, errMessage(err))
    }
    return
  }
  if (isCancelled()) return
  for (const node of nodes) {
    if (isCancelled()) return
    try {
      // mermaid leaves `data-processed="true"` on nodes it has handled
      // — skip them so we don't double-render.
      if (node.container.getAttribute('data-processed') === 'true') continue
      await mermaid.run({ nodes: [node.container] })
    } catch (err) {
      replaceWithError(node.container, node.source, errMessage(err))
    }
  }
}

function replaceWithError(
  node: HTMLElement,
  source: string,
  message: string
): void {
  const wrap = document.createElement('div')
  wrap.className = 'ado-mermaid-error'
  const pre = document.createElement('pre')
  pre.textContent = source
  const chip = document.createElement('div')
  chip.textContent = `Mermaid render failed: ${message}`
  chip.style.fontSize = '11px'
  chip.style.color = '#bf6c00'
  wrap.appendChild(chip)
  wrap.appendChild(pre)
  node.replaceWith(wrap)
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return 'unknown error'
}

// ---------------------------------------------------------------------------
// Markdown table extraction + edit-button injection
// ---------------------------------------------------------------------------

/**
 * Find every GFM-style pipe table in the markdown source and return a
 * structured representation that mirrors the TableBuilderDialog's edit
 * model. Indices are stable in source order, so the Nth result lines
 * up with the Nth `<table>` markdown-it renders.
 *
 * What counts as a table here: a header row (`| ... |`) followed by a
 * separator row whose every cell matches `:?-+:?`, optionally followed
 * by body rows. We deliberately stay strict — a sloppy alignment row
 * means the user probably meant something else (e.g. an ASCII art
 * frame), so we'd rather miss those than mis-detect.
 *
 * What we don't preserve: inline markdown formatting inside cells
 * (bold, italic, links). The dialog edits cells as plain text; round-
 * tripping inline markdown perfectly would require a full parser per
 * cell. The escape rule for `|` inside cells (`\|`) IS round-tripped.
 */
function parseMarkdownTables(source: string): WikiMarkdownTable[] {
  if (!source) return []
  const lines = source.split(/\r?\n/)
  const out: WikiMarkdownTable[] = []
  let i = 0
  while (i < lines.length) {
    if (!isTableLine(lines[i])) {
      i += 1
      continue
    }
    if (i + 1 >= lines.length || !isTableLine(lines[i + 1])) {
      i += 1
      continue
    }
    const headerCells = splitTableRow(lines[i])
    const sepCells = splitTableRow(lines[i + 1])
    if (!isSeparatorRow(sepCells) || headerCells.length !== sepCells.length) {
      i += 1
      continue
    }
    const colCount = sepCells.length
    const alignments = sepCells.map(parseAlignment)
    const startLine = i
    const bodyRows: string[][] = []
    let j = i + 2
    while (j < lines.length && isTableLine(lines[j])) {
      const cells = splitTableRow(lines[j])
      while (cells.length < colCount) cells.push('')
      bodyRows.push(cells.slice(0, colCount))
      j += 1
    }
    // The build-table dialog emits a synthetic empty header when the
    // user toggles "Header row" off. Detect that on parse so reopening
    // doesn't ghost-render an empty header row that the user never
    // actually authored.
    const isSyntheticHeader = headerCells.every((c) => c.trim() === '')
    const cells: string[][] = isSyntheticHeader
      ? bodyRows
      : [headerCells, ...bodyRows]
    if (cells.length === 0) {
      // Header-only with synthetic empty header collapses to zero
      // rows — skip rather than push an unusable empty edit.
      i = j
      continue
    }
    out.push({
      cells,
      alignments,
      headerRow: !isSyntheticHeader,
      rawMarkdown: lines.slice(startLine, j).join('\n'),
      startLine,
      endLine: j
    })
    i = j
  }
  return out
}

function isTableLine(line: string): boolean {
  const t = line.trim()
  return t.length >= 2 && t.startsWith('|') && t.endsWith('|')
}

function isSeparatorRow(cells: string[]): boolean {
  if (cells.length === 0) return false
  return cells.every((c) => /^:?-+:?$/.test(c.trim()))
}

function parseAlignment(cell: string): 'left' | 'center' | 'right' {
  const t = cell.trim()
  const left = t.startsWith(':')
  const right = t.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  return 'left'
}

/**
 * Split a `| a | b | c |` row into trimmed cell texts. Honours `\|`
 * escape so a literal pipe inside a cell survives the split. We also
 * undo the escape on output — the dialog edits plain text and re-
 * applies the escape when emitting markdown.
 */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    return [trimmed]
  }
  const inner = trimmed.slice(1, -1)
  const cells: string[] = []
  let cur = ''
  for (let k = 0; k < inner.length; k += 1) {
    const ch = inner[k]
    if (ch === '\\' && inner[k + 1] === '|') {
      cur += '|'
      k += 1
      continue
    }
    if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

/**
 * Wrap each rendered `<table>` (up to `count` of them — extras are
 * left untouched because we don't have parsed source for them) in a
 * positioned container and append a hover-revealed Edit button. The
 * actual click is dispatched by the parent's bubbling click handler
 * which reads the `data-md-table-edit` index back. Idempotent —
 * tables already wrapped on a previous pass are left as-is so this
 * effect is safe to re-run on every render.
 */
function attachTableEditButtons(container: HTMLElement, count: number): void {
  const tables = container.querySelectorAll('table')
  tables.forEach((table, idx) => {
    if (idx >= count) return
    const existingWrap = table.parentElement
    if (existingWrap?.classList.contains('md-table-wrap')) {
      // Re-stamp the index in case the source order shifted.
      existingWrap.setAttribute('data-md-table-index', String(idx))
      const existingBtn = existingWrap.querySelector('[data-md-table-edit]')
      if (existingBtn) {
        existingBtn.setAttribute('data-md-table-edit', String(idx))
      }
      return
    }
    const wrap = document.createElement('div')
    wrap.className = 'md-table-wrap'
    wrap.setAttribute('data-md-table-index', String(idx))
    table.parentNode?.insertBefore(wrap, table)
    wrap.appendChild(table)

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'md-table-edit-btn'
    btn.setAttribute('data-md-table-edit', String(idx))
    btn.setAttribute('aria-label', 'Edit table')
    btn.title = 'Edit table'
    btn.innerHTML =
      '<span aria-hidden="true" style="font-size:14px;line-height:1">\u270E</span>' +
      '<span>Edit</span>'
    wrap.appendChild(btn)
  })
}

/**
 * Inverse of `attachTableEditButtons` — used when the caller stops
 * supplying an `onEditTable` handler. Removes our injected buttons
 * and unwraps the tables so the markup matches what we'd emit from a
 * fresh render. Keeps the rendered DOM consistent with the prop
 * surface so downstream selectors keep working.
 */
function unwrapEditableTables(container: HTMLElement): void {
  const wraps = container.querySelectorAll('.md-table-wrap')
  wraps.forEach((wrap) => {
    const table = wrap.querySelector('table')
    if (!table) {
      wrap.remove()
      return
    }
    wrap.parentNode?.insertBefore(table, wrap)
    wrap.remove()
  })
}

/**
 * Resolve the user's themeMode preference into mermaid's `theme` value.
 * Tracks the OS color-scheme media query for `'system'` so diagrams
 * re-render when the user flips OS theme.
 */
function useResolvedMermaidTheme(
  mode: 'light' | 'dark' | 'system'
): 'dark' | 'default' {
  const [systemDark, setSystemDark] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent): void => {
      setSystemDark(e.matches)
    }
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])
  if (mode === 'dark') return 'dark'
  if (mode === 'light') return 'default'
  return systemDark ? 'dark' : 'default'
}

export type { MarkdownViewProps }
