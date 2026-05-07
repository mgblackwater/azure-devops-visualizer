import type { MentionItem } from './MentionList'

/**
 * Tiny dependency-free fuzzy scorer for the comment composer's
 * `@`-mention picker.
 *
 * The candidate set is small (≤ a few hundred merged identities), so
 * this runs in O(n) per keystroke without breaking a sweat. Pulling in
 * fuse.js or fzf-style trigram matchers would be overkill here.
 *
 * Scoring tiers (highest → lowest, all case-insensitive):
 *
 *   1000  exact match against the full label *or* uniqueName
 *    800  label starts with the full query
 *    700  uniqueName starts with the full query
 *    600  any single tokenised piece of the candidate starts with the
 *         full query (e.g. `do` matches "Jane **Do**e")
 *    500  every query token is a prefix of some candidate token, in any
 *         order ("ja do" matches "Jane Doe" and "Doe Jane")
 *    300  every query token is a substring of some candidate token
 *    200  the full query is a skip-character subsequence of the hay
 *         (this is what surfaces "jdoe" → "jane.doe@example.com")
 *    100  the full query is a contiguous substring of the hay (last-
 *         resort fallback for queries that don't satisfy any of the
 *         stronger heuristics)
 *      0  no match — caller should drop the row
 *
 * Tokenisation splits on whitespace, dots, dashes, underscores, and
 * `@`, which covers the realistic shapes of an ADO display name (e.g.
 * "Jane Doe") and a unique-name (e.g. "jane.doe@example.com" or
 * "DOMAIN\jane_doe").
 */
const SPLIT_RE = /[\s.\-_@\\/]+/

function tokens(s: string): string[] {
  return s.toLowerCase().split(SPLIT_RE).filter(Boolean)
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i += 1
  }
  return i === needle.length
}

export function scoreMention(query: string, item: MentionItem): number {
  const q = query.trim().toLowerCase()
  // No query = match everything; caller usually short-circuits before
  // calling us, but returning 1 here keeps the sort deterministic when
  // someone *does* feed us an empty query.
  if (!q) return 1
  const label = item.label.toLowerCase()
  const email = (item.uniqueName ?? '').toLowerCase()
  const hay = `${label} ${email}`.trim()
  if (!hay) return 0

  if (label === q || email === q) return 1000
  if (label.startsWith(q)) return 800
  if (email && email.startsWith(q)) return 700

  const candTokens = tokens(`${item.label} ${item.uniqueName ?? ''}`)
  if (candTokens.some((t) => t.startsWith(q))) return 600

  const queryTokens = q.split(SPLIT_RE).filter(Boolean)
  if (queryTokens.length > 1) {
    if (queryTokens.every((qt) => candTokens.some((ct) => ct.startsWith(qt)))) {
      return 500
    }
    if (queryTokens.every((qt) => candTokens.some((ct) => ct.includes(qt)))) {
      return 300
    }
  }

  if (isSubsequence(q, hay)) return 200
  if (hay.includes(q)) return 100
  return 0
}
