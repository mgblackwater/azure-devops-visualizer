/**
 * Token-aware fuzzy matcher used by list filters across the app.
 *
 * Mirrors the scoring approach used by `mentionScore.ts` (the `@`-mention
 * picker) so behaviour stays consistent: typing "do" matches "Jane **Do**e",
 * "ja do" matches "Doe Jane" and so on. Unlike the mention scorer, this
 * variant operates on a single haystack string — callers pre-build it by
 * joining the fields they want indexed (id, title, tags, etc.).
 *
 * Scoring tiers (highest → lowest, all case-insensitive):
 *
 *   1000  the haystack is exactly the query
 *    800  the haystack starts with the full query
 *    600  any tokenised piece of the haystack starts with the full query
 *         (e.g. `do` → "Jane **Do**e")
 *    500  every query token is a prefix of some haystack token, in any
 *         order (multi-token query only — "ja do" → "Jane Doe")
 *    300  every query token is a substring of some haystack token
 *         (multi-token query only)
 *    200  the full query is a skip-character subsequence of the haystack
 *         (this is what surfaces "jdoe" → "jane.doe@example.com")
 *    100  the full query is a contiguous substring of the haystack
 *         (last-resort fallback)
 *      0  no match — caller drops the row.
 *
 * Tokenisation splits on whitespace, dots, dashes, underscores, slashes,
 * backslashes, and `@`, which covers the realistic shapes of an ADO
 * display name, a unique-name (e.g. "jane.doe@example.com"), an iteration
 * path ("Project\Sprint 12"), and most tag conventions.
 *
 * Empty / whitespace-only queries always succeed — callers can rely on
 * `fuzzyMatches('', anything) === true` so they don't need to special-case
 * the "no filter active" path.
 *
 * No external dependencies; runs in O(haystack) per call. Suitable for
 * filtering lists of a few hundred rows on every keystroke without
 * memoisation.
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

export function fuzzyMatchScore(query: string, hay: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const h = hay.toLowerCase()
  if (!h) return 0

  if (h === q) return 1000
  if (h.startsWith(q)) return 800

  const candTokens = tokens(hay)
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

  if (isSubsequence(q, h)) return 200
  if (h.includes(q)) return 100
  return 0
}

/**
 * Convenience predicate: returns `true` when the query produces a non-zero
 * score against the haystack. Empty/whitespace-only queries always return
 * `true` so a caller can blindly pipe `list.filter(item => fuzzyMatches(q, ...))`
 * without checking whether a filter is active.
 */
export function fuzzyMatches(query: string, hay: string): boolean {
  if (!query.trim()) return true
  return fuzzyMatchScore(query, hay) > 0
}
