import { useEffect, useMemo, useState } from 'react'
import { Box, Skeleton } from '@mui/material'
import DOMPurify from 'dompurify'
import { useGetConnectionQuery } from '@/store/api/adoApi'
import { IPC } from '@shared/contract'

/**
 * Renders a sanitised HTML description (work-item Description field, ADO
 * comments, etc.) with inline images correctly displayed.
 *
 * Why this is non-trivial:
 *   - ADO inline images live at `/{org}/{project}/_apis/wit/attachments/{guid}`
 *     and require an `Authorization: Basic <pat>` header. Putting the URL
 *     directly into `<img src=>` returns 401 because the renderer has no
 *     credentials.
 *   - We can't proxy through `fetch()` either because Chromium's CORS
 *     policy blocks the cross-origin call.
 *
 * Strategy:
 *   1. Sanitise the HTML on the way in (defence-in-depth — ADO already
 *      strips scripts but users can paste arbitrary HTML/CSS into rich
 *      text fields).
 *   2. Walk the parsed DOM, find every `<img>` whose src points at the
 *      configured ADO host, and replace the src with a `data:` URI fed
 *      from the main process (which has the PAT).
 *   3. Render via `dangerouslySetInnerHTML` once all in-flight image
 *      fetches resolve. We render a placeholder `<img>` with width/height
 *      preserved while loading so the layout doesn't jump.
 */
export default function RichDescription({ html }: { html: string }): JSX.Element | null {
  const orgUrl = useGetConnectionQuery().data?.organizationUrl ?? ''
  const orgHost = useMemo(() => {
    try {
      return orgUrl ? new URL(orgUrl).host.toLowerCase() : ''
    } catch {
      return ''
    }
  }, [orgUrl])

  // Sanitised HTML + the list of ADO image URLs we need to fetch.
  const { sanitized, adoImageUrls } = useMemo(
    () => sanitizeAndCollectImages(html, orgHost),
    [html, orgHost]
  )

  // Map of original src → resolved data: URI. Populated as IPC responses
  // come back; missing entries fall back to a small "image unavailable"
  // placeholder so a single broken image doesn't blank the whole block.
  const [resolved, setResolved] = useState<Record<string, string | null>>({})
  // Reset resolved cache whenever the description (and hence URL list) changes.
  useEffect(() => {
    setResolved({})
  }, [html])

  useEffect(() => {
    if (adoImageUrls.length === 0) return
    let cancelled = false
    for (const url of adoImageUrls) {
      if (resolved[url] !== undefined) continue
      window.ado
        .invoke(IPC.AttachmentFetch, { url })
        .then(({ dataBase64, contentType }) => {
          if (cancelled) return
          setResolved((prev) =>
            prev[url] !== undefined
              ? prev
              : { ...prev, [url]: `data:${contentType};base64,${dataBase64}` }
          )
        })
        .catch(() => {
          if (cancelled) return
          setResolved((prev) =>
            prev[url] !== undefined ? prev : { ...prev, [url]: null }
          )
        })
    }
    return () => {
      cancelled = true
    }
    // We deliberately key only on the URL list so we don't re-trigger
    // on every successful fetch updating `resolved`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adoImageUrls.join('|')])

  const renderedHtml = useMemo(
    () => substituteImageSources(sanitized, resolved),
    [sanitized, resolved]
  )

  // Anything in flight? Show a small skeleton bar at the bottom to hint that
  // images are still loading.
  const stillLoading = adoImageUrls.some((u) => resolved[u] === undefined)

  if (!html) return null

  return (
    <Box>
      <Box
        sx={(theme) => {
          const codeBg =
            theme.palette.mode === 'dark'
              ? 'rgba(255,255,255,0.08)'
              : 'rgba(0,0,0,0.06)'
          const tableBorder = theme.palette.divider
          return {
            fontSize: 13,
            lineHeight: 1.55,
            wordBreak: 'break-word',
            color: theme.palette.text.primary,
            '& img': {
              maxWidth: '100%',
              height: 'auto',
              borderRadius: 0.5,
              my: 0.5,
              display: 'block'
            },
            '& p': { my: 0.75 },
            '& ul, & ol': { pl: 3, my: 0.5 },
            '& code': {
              fontFamily: 'monospace',
              bgcolor: codeBg,
              px: 0.5,
              borderRadius: 0.5
            },
            '& pre': {
              bgcolor: codeBg,
              p: 1,
              borderRadius: 1,
              overflow: 'auto'
            },
            '& a': { color: 'primary.main' },
            '& table': { borderCollapse: 'collapse', my: 1 },
            '& th, & td': { border: `1px solid ${tableBorder}`, px: 1, py: 0.5 },
            '& blockquote': {
              borderLeft: `3px solid ${tableBorder}`,
              pl: 1.5,
              my: 1,
              color: 'text.secondary'
            }
          }
        }}
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
      {stillLoading && (
        <Skeleton variant="rectangular" height={8} sx={{ mt: 0.5, borderRadius: 0.5 }} />
      )}
    </Box>
  )
}

interface SanitizeResult {
  sanitized: string
  adoImageUrls: string[]
}

const ADO_HOST_FALLBACKS = ['dev.azure.com', 'visualstudio.com']

/**
 * Sanitise via DOMPurify, then walk for `<img>` tags whose src is on the
 * ADO host. Replaces each matched src with a placeholder marker
 * (`data-ado-src`) the renderer can match on later.
 *
 * We tag every ADO image with a stable marker rather than mutating src
 * directly because we need to keep the original URL around to look up
 * the resolved data URI as fetches complete.
 */
function sanitizeAndCollectImages(html: string, orgHost: string): SanitizeResult {
  if (!html) return { sanitized: '', adoImageUrls: [] }

  const cleaned = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    // Strip targets that point at javascript:/data: by default; allow the
    // common rich-text bits ADO uses.
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input', 'object', 'embed'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover']
  })

  if (typeof window === 'undefined') {
    return { sanitized: cleaned, adoImageUrls: [] }
  }

  const doc = new window.DOMParser().parseFromString(`<div>${cleaned}</div>`, 'text/html')
  const wrapper = doc.body.firstElementChild as HTMLElement | null
  if (!wrapper) return { sanitized: cleaned, adoImageUrls: [] }

  const found = new Set<string>()
  const imgs = wrapper.querySelectorAll('img')
  imgs.forEach((img) => {
    const src = img.getAttribute('src') ?? ''
    if (!src) return
    if (!isAdoImageUrl(src, orgHost)) return
    found.add(src)
    img.setAttribute('data-ado-src', src)
    // Strip the original src so the browser doesn't fire a 401-ing request
    // before our IPC fetch completes.
    img.removeAttribute('src')
    if (!img.hasAttribute('alt')) img.setAttribute('alt', 'attachment')
  })
  // Open all links in the system browser, not in the Electron renderer.
  wrapper.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  })

  return {
    sanitized: wrapper.innerHTML,
    adoImageUrls: [...found]
  }
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

/**
 * Replace `data-ado-src` markers with the resolved data URI (or a tiny
 * inline SVG placeholder while the fetch is in flight / has failed).
 */
function substituteImageSources(
  sanitized: string,
  resolved: Record<string, string | null>
): string {
  if (!sanitized.includes('data-ado-src')) return sanitized
  if (typeof window === 'undefined') return sanitized
  const doc = new window.DOMParser().parseFromString(
    `<div>${sanitized}</div>`,
    'text/html'
  )
  const wrapper = doc.body.firstElementChild as HTMLElement | null
  if (!wrapper) return sanitized
  wrapper.querySelectorAll('img[data-ado-src]').forEach((img) => {
    const url = img.getAttribute('data-ado-src') ?? ''
    const r = resolved[url]
    if (r) {
      img.setAttribute('src', r)
    } else if (r === null) {
      img.setAttribute('src', BROKEN_IMAGE_PLACEHOLDER)
      img.setAttribute('title', 'Image could not be loaded from Azure DevOps')
    } else {
      img.setAttribute('src', LOADING_IMAGE_PLACEHOLDER)
    }
  })
  return wrapper.innerHTML
}

const LOADING_IMAGE_PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="100"><rect width="100%" height="100%" fill="#eceff1"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="11" fill="#90a4ae">Loading attachment…</text></svg>'
  )

const BROKEN_IMAGE_PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="100"><rect width="100%" height="100%" fill="#fff3e0"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="11" fill="#bf6c00">Image unavailable</text></svg>'
  )
