import DOMPurify from 'dompurify'

/**
 * Pure helpers for converting TipTap editor output into the HTML shape
 * that Azure DevOps expects in a work-item comment body.
 *
 * Two transformations matter:
 *
 * 1. **Mentions.** TipTap's `Mention` extension defaults to
 *    `<span class="mention" data-id="…" data-label="…">@Name</span>`,
 *    which ADO renders as plain text (the `@` and the name show, but
 *    the user is not actually notified). ADO instead expects an
 *    anchor of the form
 *    `<a href="#" data-vss-mention="version:2.0,{descriptor}">@DisplayName</a>`.
 *    We rewrite each mention span into that anchor form so the server
 *    fans out a real notification.
 *
 * 2. **Empty trailing paragraphs.** TipTap commits an empty `<p></p>`
 *    at the end of an empty editor and another after the user finishes
 *    a list. Strip them so a "blank" submission round-trips as zero
 *    bytes and a real submission doesn't carry trailing whitespace.
 *
 * The function also runs DOMPurify over the editor output before any
 * rewrite so any pasted HTML the user smuggled through is neutralised
 * before it reaches ADO. ADO sanitises server-side anyway, but
 * defence-in-depth is cheap.
 */

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del',
  'code', 'pre', 'blockquote',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'span',
  'hr'
]

const ALLOWED_ATTR = [
  'href', 'target', 'rel',
  // Mention markup carries metadata on both span (TipTap form) and
  // anchor (ADO form); allow the relevant data attributes through the
  // sanitiser so we still have something to rewrite afterwards.
  'class',
  'data-type',
  'data-id',
  'data-label',
  'data-vss-mention'
]

/**
 * Convert TipTap HTML to ADO-compatible HTML.
 *
 * Pure-ish: when `domParser` isn't supplied the function falls back to
 * the global `DOMParser`. In a Node test environment without a DOM you
 * can pass a polyfill (e.g. jsdom) — but the renderer always runs in a
 * browser context so this path is exercised against the real one in
 * production.
 */
export function serializeForAdo(html: string, domParser?: DOMParser): string {
  if (!html) return ''
  const sanitised = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR
  })
  if (!sanitised) return ''
  const parser = domParser ?? (typeof window !== 'undefined' ? new window.DOMParser() : null)
  if (!parser) {
    // No DOMParser available — return the raw sanitised string. ADO
    // will still accept it (mentions just won't fan out). Better than
    // throwing on a code path that should never run in production.
    return stripTrailingEmptyParagraphsRegex(sanitised)
  }
  const doc = parser.parseFromString(`<div>${sanitised}</div>`, 'text/html')
  const wrapper = doc.body.firstElementChild as HTMLElement | null
  if (!wrapper) return ''

  rewriteMentions(wrapper)
  stripTrailingEmptyBlocks(wrapper)

  return wrapper.innerHTML.trim()
}

/**
 * True when the editor's HTML has no user-visible content. Used by the
 * composer to disable the Submit button — we look at the rendered text
 * rather than `html === ''` because TipTap always emits at least an
 * empty `<p>`.
 */
export function isEditorEmpty(html: string, domParser?: DOMParser): boolean {
  if (!html) return true
  const parser = domParser ?? (typeof window !== 'undefined' ? new window.DOMParser() : null)
  if (!parser) {
    // Conservative fallback: if we strip tags and get nothing, treat as empty.
    return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim().length === 0
  }
  const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html')
  const wrapper = doc.body.firstElementChild as HTMLElement | null
  if (!wrapper) return true
  // Mention nodes count as content even when their text content is just
  // "@Name" — but the default text walker sees them. We only need to
  // also catch "code-only" content (an empty inline code span) which
  // browsers render as zero-width.
  const text = (wrapper.textContent ?? '').replace(/\u00a0/g, ' ').trim()
  if (text.length > 0) return false
  // No text — but a code block / horizontal rule / bare image still
  // counts. The composer doesn't currently support inline images, so
  // the only meaningful "non-text" node is `<hr>`.
  return wrapper.querySelector('hr') == null
}

/**
 * Walk every `<span class="mention">` inside `root` and replace it
 * with the ADO anchor form. The mention's `data-id` is the user's
 * descriptor (or, if descriptors weren't available at suggestion time,
 * the GUID id — ADO falls back to plain text rendering in that case
 * but the comment still posts cleanly).
 */
function rewriteMentions(root: HTMLElement): void {
  const mentions = root.querySelectorAll<HTMLElement>(
    'span[data-type="mention"], span.mention'
  )
  mentions.forEach((span) => {
    const id = span.getAttribute('data-id') ?? ''
    const label = span.getAttribute('data-label') ?? span.textContent ?? ''
    const display = label.replace(/^@/, '')
    const anchor = root.ownerDocument.createElement('a')
    anchor.setAttribute('href', '#')
    anchor.setAttribute(
      'data-vss-mention',
      `version:2.0,${id}`
    )
    anchor.textContent = `@${display}`
    span.replaceWith(anchor)
  })
}

/**
 * Walk from the end of `root` and drop trailing block elements that
 * have no user-visible content. TipTap emits an empty `<p></p>` at the
 * very end of the document, and adds another after a list/blockquote
 * if the user pressed Enter to leave the structure. We don't want
 * either of those committed to ADO — they show up as visible blank
 * lines under the comment.
 */
function stripTrailingEmptyBlocks(root: HTMLElement): void {
  while (root.lastElementChild) {
    const last = root.lastElementChild
    const tag = last.tagName.toLowerCase()
    if (tag !== 'p' && tag !== 'div') break
    const text = (last.textContent ?? '').replace(/\u00a0/g, ' ').trim()
    if (text.length > 0) break
    if (last.querySelector('img, hr, br + br') != null) break
    last.remove()
  }
}

/**
 * Regex-only fallback for environments without a DOM parser. Strips
 * trailing `<p></p>` / `<p><br></p>` blocks. Not as thorough as the
 * DOM-based pass — only used in tests / SSR.
 */
function stripTrailingEmptyParagraphsRegex(html: string): string {
  return html
    .replace(/(?:<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>)+\s*$/i, '')
    .trim()
}
