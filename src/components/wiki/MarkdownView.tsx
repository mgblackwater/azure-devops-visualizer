import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box } from '@mui/material'
import { useNavigate, type NavigateFunction } from 'react-router-dom'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { useGetConnectionQuery } from '@/store/api/adoApi'
import { selectThemeMode } from '@/store/preferencesSlice'
import { useAppSelector } from '@/store'
import { IPC } from '@shared/contract'

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
  currentPagePath
}: MarkdownViewProps): JSX.Element {
  const navigate = useNavigate()
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
  // Reset when the source markdown / wiki changes — otherwise stale
  // mermaid SVGs and image URLs would bleed across pages.
  useEffect(() => {
    setImageMap({})
  }, [markdown, wikiId])

  // Stable click handler — captures the current navigate / wikiId via
  // refs so we don't need to detach/reattach on every render.
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  const wikiIdRef = useRef(wikiId)
  wikiIdRef.current = wikiId

  const handleClick = useCallback((e: Event): void => {
    handleAnchorClick(e, navigateRef.current, wikiIdRef.current)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.addEventListener('click', handleClick)
    return () => container.removeEventListener('click', handleClick)
  }, [handleClick])

  // Walk the parsed DOM after each render: collect image URLs to fetch,
  // rewrite resolved ones, swap mermaid blocks for SVG.
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
    fetchAdoImages(adoImageUrls, imageMap, setImageMap, () => cancelled)
    rewriteImages(container, imageMap)

    const mermaidNodes = collectMermaidNodes(container)
    if (mermaidNodes.length > 0) {
      void renderMermaid(mermaidNodes, mermaidTheme, () => cancelled)
    }
    return () => {
      cancelled = true
    }
  }, [
    sanitizedHtml,
    imageMap,
    mermaidTheme,
    orgUrl,
    orgHost,
    wikiId,
    projectId,
    wikiRepositoryId,
    currentPagePath
  ])

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
 * For relative paths we hit the Git items endpoint with
 * `versionDescriptor.version=wikiMaster` (the implicit branch for
 * project wikis) and `download=false&resolveLfs=true&sanitize=true`.
 * That's the exact combination the ADO web UI uses for inline wiki
 * images and the only one that returns binary reliably for newer wiki
 * versions.
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

  // Resolve the path inside the wiki repo. Two distinct shapes:
  //   1. `/.attachments/...` — wiki-root attachments folder.
  //   2. anything else       — relative to the current page's folder.
  let resolvedPath: string | null = null
  const trimmedNoLeadingDot = trimmed.replace(/^\.\/+/, '')
  if (/^\/?\.attachments\//i.test(trimmedNoLeadingDot)) {
    // Always rooted at wiki root, regardless of the current page.
    resolvedPath = trimmedNoLeadingDot.startsWith('/')
      ? trimmedNoLeadingDot
      : `/${trimmedNoLeadingDot}`
  } else if (trimmedNoLeadingDot.startsWith('/')) {
    // An explicit absolute wiki path like `/Some-Folder/foo.png`.
    resolvedPath = trimmedNoLeadingDot
  } else {
    // Page-relative: resolve inside the page's folder. ADO stores wiki
    // pages such that any page (leaf or parent) lives at its own
    // `<page-path>` and sibling assets live in `<page-path>/...`.
    if (!ctx.currentPagePath) return null
    const pageDir = ctx.currentPagePath.replace(/\/+$/, '')
    resolvedPath = `${pageDir}/${trimmedNoLeadingDot}`
  }
  if (!resolvedPath) return null

  try {
    const u = new URL(
      `${ctx.orgUrl.replace(/\/+$/, '')}/${encodeURIComponent(ctx.projectId)}/_apis/git/repositories/${encodeURIComponent(ctx.wikiRepositoryId)}/items`
    )
    u.searchParams.set('path', resolvedPath)
    u.searchParams.set('$format', 'octetStream')
    // Match what the ADO web UI sends for inline wiki images. `download`
    // is intentionally false; `resolveLfs=true` follows Git LFS pointers
    // for orgs that store large binary assets in LFS; `sanitize=true`
    // strips active content from served files.
    u.searchParams.set('download', 'false')
    u.searchParams.set('resolveLfs', 'true')
    u.searchParams.set('sanitize', 'true')
    u.searchParams.set('versionDescriptor.version', 'wikiMaster')
    u.searchParams.set('api-version', '7.1')
    return u.toString()
  } catch {
    return null
  }
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
