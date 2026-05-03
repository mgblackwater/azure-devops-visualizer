/**
 * Strip a chunk of (potentially user-authored) HTML down to safe plain text.
 *
 * Uses DOMParser, which parses HTML without executing scripts or fetching
 * resources. Cheaper than pulling DOMPurify when all we want is the prose.
 */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return ''
  if (typeof window === 'undefined' || typeof window.DOMParser === 'undefined') {
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  }
  const doc = new window.DOMParser().parseFromString(html, 'text/html')
  // Treat each closing block-level tag as a newline before extracting text.
  doc.body.querySelectorAll('br').forEach((br) => br.replaceWith('\n'))
  doc.body.querySelectorAll('p, li, div, h1, h2, h3, h4, h5, h6, tr').forEach((el) => {
    el.append('\n')
  })
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

const RELATIVE_THRESHOLDS: Array<[number, string]> = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [7, 'day'],
  [4.34524, 'week'],
  [12, 'month'],
  [Number.POSITIVE_INFINITY, 'year']
]

/** "3 days ago", "in 2 hours", or empty if `value` cannot be parsed. */
export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const diffMs = date.getTime() - Date.now()
  let unitValue = Math.abs(diffMs) / 1000
  let label = 'second'
  for (const [factor, name] of RELATIVE_THRESHOLDS) {
    if (unitValue < factor) {
      label = name
      break
    }
    unitValue /= factor
    label = name
  }
  const rounded = Math.round(unitValue)
  const plural = rounded === 1 ? '' : 's'
  return diffMs < 0 ? `${rounded} ${label}${plural} ago` : `in ${rounded} ${label}${plural}`
}
