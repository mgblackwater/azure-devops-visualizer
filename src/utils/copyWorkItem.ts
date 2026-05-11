import TurndownService from 'turndown'
import { IPC } from '@shared/contract'
import {
  getAreaPath,
  getAssigneeName,
  getChangedDate,
  getCreatedDate,
  getDescription,
  getIterationPath,
  getPriority,
  getState,
  getTags,
  getTitle,
  getType,
  relationTargetId
} from '@/utils/workItemFields'
import { buildWorkItemUrl } from '@/utils/workItemLinks'
import type { AdoComment, AdoWorkItem } from '@shared/adoTypes'

/**
 * Public scope levels for the "copy for Gen AI" feature. Each level is a
 * superset of the lighter ones so the resulting blob has a predictable
 * top-down structure (header → description → metadata → comments).
 */
export type CopyScope = 'description' | 'descriptionMeta' | 'descriptionMetaComments'

/**
 * Stable host suffixes we treat as ADO. Mirrors the list in
 * RichDescription so both the renderer and the copy pipeline agree on
 * which `<img>` tags need the auth proxy.
 */
const ADO_HOST_FALLBACKS = ['dev.azure.com', 'visualstudio.com']

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
  linkStyle: 'inlined'
})

// Tables: turndown core doesn't handle <table>. We register a minimal GFM
// table converter so ADO tables (used heavily in design-spec PBIs) come
// out as readable Markdown pipe-tables instead of being concatenated into
// one wall of text.
turndown.addRule('table', {
  filter: 'table',
  replacement: (_content, node) => {
    const table = node as HTMLTableElement
    const rows: string[][] = []
    const trList = table.querySelectorAll('tr')
    trList.forEach((tr) => {
      const cells: string[] = []
      tr.querySelectorAll('th,td').forEach((cell) => {
        const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim()
        cells.push(text.replace(/\|/g, '\\|'))
      })
      if (cells.length > 0) rows.push(cells)
    })
    if (rows.length === 0) return ''
    const colCount = Math.max(...rows.map((r) => r.length))
    const padded = rows.map((r) => {
      const out = [...r]
      while (out.length < colCount) out.push('')
      return out
    })
    const header = padded[0]
    const body = padded.slice(1)
    const headerLine = `| ${header.join(' | ')} |`
    const separatorLine = `| ${header.map(() => '---').join(' | ')} |`
    const bodyLines = body.map((r) => `| ${r.join(' | ')} |`)
    return ['', headerLine, separatorLine, ...bodyLines, ''].join('\n')
  }
})

// ADO's rich-text editor wraps everything in <div class="document"> with
// nested <div> blocks per paragraph. Treating a top-level <div> as a
// block-level boundary keeps paragraph spacing intact.
turndown.addRule('divAsParagraph', {
  filter: (node) => node.nodeName === 'DIV',
  replacement: (content) => `\n\n${content}\n\n`
})

interface ImageDescriptor {
  /** Original (auth-required) URL pulled from the description HTML. */
  originalUrl: string
  /** Sentinel URL we substitute into the DOM before turndown runs. */
  placeholderUrl: string
}

interface PreparedHtml {
  /** HTML with ADO image src attributes replaced by sentinel URLs. */
  html: string
  /** Sentinel → original URL map for post-turndown substitution. */
  images: ImageDescriptor[]
}

interface BuildCopyArgs {
  item: AdoWorkItem
  orgUrl: string
  scope: CopyScope
  comments?: AdoComment[]
  /**
   * IPC-backed fetcher for ADO attachments. Defaults to the renderer's
   * `window.ado.invoke(IPC.AttachmentFetch, ...)` channel; pass a stub
   * for tests.
   */
  fetchAttachment?: (url: string) => Promise<{ dataBase64: string; contentType: string }>
  /** Called for progress updates so the UI can show "fetching 2/5…". */
  onProgress?: (info: CopyProgress) => void
}

export interface CopyProgress {
  phase: 'preparing' | 'fetchingImages' | 'assembling' | 'done'
  imagesTotal: number
  imagesDone: number
  imagesFailed: number
}

export interface CopyResult {
  /** The final markdown payload ready for `clipboard.writeText`. */
  markdown: string
  /** Total bytes (UTF-8) of the markdown payload. */
  bytes: number
  /** Number of images we successfully embedded as data URIs. */
  imagesEmbedded: number
  /** Number of images we tried but failed to embed (left as URL). */
  imagesFailed: number
}

/**
 * Build a markdown blob describing a work item, ready to paste into a
 * Gen AI chat. Images in the description are fetched via the ADO
 * attachment proxy and inlined as base64 data URIs so the AI receives
 * the actual image content rather than an auth-gated URL.
 */
export async function buildCopyBlob(args: BuildCopyArgs): Promise<CopyResult> {
  const { item, orgUrl, scope, comments, onProgress } = args
  const fetcher = args.fetchAttachment ?? defaultFetcher
  const orgHost = safeHost(orgUrl)

  onProgress?.({ phase: 'preparing', imagesTotal: 0, imagesDone: 0, imagesFailed: 0 })

  const sections: string[] = []
  sections.push(buildHeaderSection(item, orgUrl))

  // ----- Description -----
  const rawHtml = getDescription(item) ?? ''
  const prepared = prepareHtmlForTurndown(rawHtml, orgHost)
  let descriptionMd = rawHtml ? turndown.turndown(prepared.html) : ''
  descriptionMd = descriptionMd.replace(/\n{3,}/g, '\n\n').trim()

  let imagesEmbedded = 0
  let imagesFailed = 0
  if (prepared.images.length > 0) {
    onProgress?.({
      phase: 'fetchingImages',
      imagesTotal: prepared.images.length,
      imagesDone: 0,
      imagesFailed: 0
    })

    // Concurrency 4: keeps the IPC channel responsive without serialising
    // an entire description's worth of attachments behind a single fetch.
    const concurrency = 4
    const queue = [...prepared.images]
    let done = 0
    async function worker(): Promise<void> {
      while (queue.length > 0) {
        const desc = queue.shift()
        if (!desc) return
        try {
          const { dataBase64, contentType } = await fetcher(desc.originalUrl)
          const dataUri = `data:${contentType};base64,${dataBase64}`
          // Replace every occurrence — the same image may appear multiple
          // times when an ADO comment quotes a description image.
          descriptionMd = descriptionMd.split(desc.placeholderUrl).join(dataUri)
          imagesEmbedded++
        } catch {
          // Leave the placeholder pointing at the original URL so the AI
          // at least sees the reference; mark as failed for the toast.
          descriptionMd = descriptionMd.split(desc.placeholderUrl).join(desc.originalUrl)
          imagesFailed++
        }
        done++
        onProgress?.({
          phase: 'fetchingImages',
          imagesTotal: prepared.images.length,
          imagesDone: done,
          imagesFailed
        })
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, prepared.images.length) }, () => worker())
    )
  }

  if (descriptionMd) {
    sections.push(`## Description\n\n${descriptionMd}`)
  } else {
    sections.push(`## Description\n\n_(empty)_`)
  }

  // ----- Metadata -----
  if (scope === 'descriptionMeta' || scope === 'descriptionMetaComments') {
    const meta = buildMetadataSection(item)
    if (meta) sections.push(meta)
  }

  // ----- Comments -----
  if (scope === 'descriptionMetaComments') {
    const commentsBlob = await buildCommentsSection(comments ?? [], orgHost, fetcher)
    if (commentsBlob) {
      sections.push(commentsBlob.markdown)
      imagesEmbedded += commentsBlob.imagesEmbedded
      imagesFailed += commentsBlob.imagesFailed
    }
  }

  onProgress?.({
    phase: 'assembling',
    imagesTotal: prepared.images.length,
    imagesDone: prepared.images.length,
    imagesFailed
  })

  const markdown = sections.join('\n\n').trim() + '\n'
  const bytes = new Blob([markdown]).size

  onProgress?.({
    phase: 'done',
    imagesTotal: prepared.images.length,
    imagesDone: prepared.images.length,
    imagesFailed
  })

  return { markdown, bytes, imagesEmbedded, imagesFailed }
}

// ---------- Section builders ----------

function buildHeaderSection(item: AdoWorkItem, orgUrl: string): string {
  const id = item.id
  const title = getTitle(item) || '(no title)'
  const type = getType(item)
  const state = getState(item)
  const url = buildWorkItemUrl(item, orgUrl)
  const lines: string[] = [`# #${id} — ${title}`]
  const meta: string[] = []
  if (type) meta.push(`**Type:** ${type}`)
  if (state) meta.push(`**State:** ${state}`)
  if (meta.length > 0) lines.push(meta.join('  ·  '))
  if (url) lines.push(`<${url}>`)
  return lines.join('\n')
}

function buildMetadataSection(item: AdoWorkItem): string {
  const rows: Array<[string, string]> = []
  const assignee = getAssigneeName(item)
  if (assignee && assignee !== 'Unassigned') rows.push(['Assignee', assignee])
  else rows.push(['Assignee', 'Unassigned'])
  const area = getAreaPath(item)
  if (area) rows.push(['Area path', area])
  const iteration = getIterationPath(item)
  if (iteration) rows.push(['Iteration', iteration])
  const priority = getPriority(item)
  if (priority != null) rows.push(['Priority', String(priority)])
  const tags = getTags(item)
  if (tags.length > 0) rows.push(['Tags', tags.join(', ')])
  const parentId = findParentId(item)
  if (parentId != null) rows.push(['Parent', `#${parentId}`])
  const created = getCreatedDate(item)
  if (created) rows.push(['Created', created.toISOString()])
  const changed = getChangedDate(item)
  if (changed) rows.push(['Last changed', changed.toISOString()])
  if (rows.length === 0) return ''
  // Render as a key/value markdown list — pipe tables would force the
  // pasted blob into a tabular layout the AI tends to wrap in a code
  // block, which hurts readability for prompt context.
  const body = rows.map(([k, v]) => `- **${k}:** ${v}`).join('\n')
  return `## Metadata\n\n${body}`
}

async function buildCommentsSection(
  comments: AdoComment[],
  orgHost: string,
  fetcher: NonNullable<BuildCopyArgs['fetchAttachment']>
): Promise<{ markdown: string; imagesEmbedded: number; imagesFailed: number } | null> {
  if (comments.length === 0) {
    return { markdown: '## Comments\n\n_(none)_', imagesEmbedded: 0, imagesFailed: 0 }
  }
  // ADO returns comments newest-first by default; reverse so the AI reads
  // a natural top-to-bottom thread chronology.
  const ordered = [...comments].sort((a, b) => {
    const da = a.createdDate ?? ''
    const db = b.createdDate ?? ''
    return da.localeCompare(db)
  })
  const lines: string[] = ['## Comments', '']
  let imagesEmbedded = 0
  let imagesFailed = 0
  for (const c of ordered) {
    const author = c.createdBy?.displayName ?? 'Unknown'
    const date = c.createdDate ? new Date(c.createdDate).toISOString().slice(0, 19) + 'Z' : ''
    lines.push(`### ${author}${date ? ` · ${date}` : ''}`)
    const prepared = prepareHtmlForTurndown(c.text ?? '', orgHost)
    let body = c.text ? turndown.turndown(prepared.html) : ''
    body = body.replace(/\n{3,}/g, '\n\n').trim() || '_(empty)_'
    if (prepared.images.length > 0) {
      // Reuse the same concurrency-4 pattern used for description images.
      for (const desc of prepared.images) {
        try {
          const { dataBase64, contentType } = await fetcher(desc.originalUrl)
          body = body.split(desc.placeholderUrl).join(`data:${contentType};base64,${dataBase64}`)
          imagesEmbedded++
        } catch {
          body = body.split(desc.placeholderUrl).join(desc.originalUrl)
          imagesFailed++
        }
      }
    }
    lines.push(body)
    lines.push('')
  }
  return { markdown: lines.join('\n').trim(), imagesEmbedded, imagesFailed }
}

// ---------- HTML helpers ----------

function prepareHtmlForTurndown(html: string, orgHost: string): PreparedHtml {
  if (!html) return { html: '', images: [] }
  if (typeof window === 'undefined') return { html, images: [] }
  const doc = new window.DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const wrapper = doc.body.firstElementChild as HTMLElement | null
  if (!wrapper) return { html, images: [] }

  const images: ImageDescriptor[] = []
  let counter = 0
  wrapper.querySelectorAll('img').forEach((img) => {
    const original = img.getAttribute('src') ?? img.getAttribute('data-ado-src') ?? ''
    if (!original) return
    if (!isAdoImageUrl(original, orgHost)) return
    counter++
    const placeholder = `https://__ado_copy_image__/${counter}`
    img.setAttribute('src', placeholder)
    if (!img.hasAttribute('alt')) img.setAttribute('alt', `attachment-${counter}`)
    images.push({ originalUrl: original, placeholderUrl: placeholder })
  })

  return { html: wrapper.innerHTML, images }
}

function isAdoImageUrl(src: string, orgHost: string): boolean {
  try {
    const u = new URL(src, 'https://placeholder.invalid')
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    const host = u.host.toLowerCase()
    if (orgHost && host === orgHost) return true
    return ADO_HOST_FALLBACKS.some((h) => host.endsWith(h))
  } catch {
    return false
  }
}

function safeHost(orgUrl: string): string {
  try {
    return orgUrl ? new URL(orgUrl).host.toLowerCase() : ''
  } catch {
    return ''
  }
}

function findParentId(item: AdoWorkItem): number | null {
  const rels = item.relations ?? []
  for (const r of rels) {
    if (r.rel === 'System.LinkTypes.Hierarchy-Reverse') {
      const id = relationTargetId(r.url)
      if (id != null) return id
    }
  }
  return null
}

async function defaultFetcher(url: string): Promise<{ dataBase64: string; contentType: string }> {
  return window.ado.invoke(IPC.AttachmentFetch, { url })
}

/**
 * Pretty-print a byte count for snackbar feedback (e.g. "182 KB").
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
