/**
 * Pure helpers for splicing markdown table blocks in and out of a wiki
 * page's source text. Live in their own module (vs. inside MarkdownView
 * or WikiPage) so the consumers — the builder dialog's save handlers —
 * can stay free of React imports and so they're trivially unit-testable
 * by any future test harness without dragging in DOM globals.
 *
 * All functions here are deterministic, side-effect-free, and operate
 * purely on string inputs — no IPC, no DOM, no React.
 *
 * Line indexing rules used everywhere:
 *  - Lines are split on `\r?\n` so CRLF and LF wikis behave the same.
 *  - The result is rejoined on `\n` (the canonical wire format ADO
 *    accepts). Mixed line endings collapse to LF — that's intentional;
 *    chaining splices on a CRLF source previously produced visually-
 *    identical output that some markdown parsers (notably markdown-it
 *    on certain ADO mermaid fences) tokenised differently.
 *  - Half-open `[startLine, endLine)`. `endLine` is the index just past
 *    the last body row, exclusive — same convention `parseMarkdownTables`
 *    uses when it tracks block ranges.
 */

/**
 * Append a freshly-built markdown table to the end of the page source,
 * separated from any existing content by a blank line. Idempotent in
 * the sense that calling it twice with the same table appends two
 * tables — it does NOT detect duplicates. The result always ends with
 * exactly one trailing newline so subsequent saves don't accumulate
 * blank lines.
 */
export function appendTableToPage(
  source: string,
  tableMarkdown: string,
): string {
  const newTable = tableMarkdown.replace(/\s+$/, '')
  if (!newTable) return source
  if (!source) return `${newTable}\n`
  // Strip trailing whitespace once so we don't pile up blank lines on
  // repeated appends to the same page; we re-add the exact spacing we
  // want below.
  const trimmed = source.replace(/\s+$/, '')
  if (!trimmed) return `${newTable}\n`
  return `${trimmed}\n\n${newTable}\n`
}

/**
 * Replace the lines `[startLine, endLine)` in `source` with the
 * provided table markdown. Used by the "Edit table" hover affordance
 * to splice a freshly-edited table back over its original source
 * range. Surrounding blank lines are preserved verbatim — we only
 * touch the table's own line range.
 *
 * If `endLine <= startLine` the function inserts at `startLine`
 * without removing anything (defensive — should never happen with the
 * current parser, but better to noop than corrupt).
 *
 * If `startLine` is past the end of the source, the table is
 * appended; this matches the user's intuition for "edit a table that
 * was the last thing on the page" without special-casing trailing
 * newline accounting.
 */
export function replaceTableInPage(
  source: string,
  startLine: number,
  endLine: number,
  tableMarkdown: string,
): string {
  const lines = source.split(/\r?\n/)
  const safeStart = Math.max(0, Math.min(startLine, lines.length))
  const safeEnd = Math.max(safeStart, Math.min(endLine, lines.length))
  // Trim trailing blank lines off the new table so the splice doesn't
  // accidentally inject extra blank lines mid-document; the original
  // table's neighbouring lines (kept by the slice) already carry
  // whatever spacing the user intended.
  const newLines = tableMarkdown.replace(/\s+$/, '').split('\n')
  const next = [
    ...lines.slice(0, safeStart),
    ...newLines,
    ...lines.slice(safeEnd),
  ]
  return next.join('\n')
}

/**
 * Insert a table at a CodeMirror character offset, padding with blank
 * lines on either side if the cursor isn't already on a blank line.
 * Mirrors how a developer would naturally type a new table block:
 * never directly adjacent to a paragraph or another block element.
 *
 * Edge cases:
 *  - Offset at start-of-file: no leading blank line needed; the file
 *    starts where it starts.
 *  - Offset at end-of-file: ensure there's a blank line before the
 *    new table only when the existing file isn't already blank-
 *    terminated. The trailing newline is always added so the result
 *    ends cleanly.
 *  - Mid-line offset: split the line at the offset and insert the
 *    table on its own lines between the two halves, with blank
 *    separators on both sides.
 *
 * Returns the new source. Does not return a new offset — the caller
 * (the WikiPage edit-mode save handler) re-derives a sensible cursor
 * placement from the inserted markdown's length itself.
 */
export function insertAtCursor(
  source: string,
  offset: number,
  tableMarkdown: string,
): string {
  const newTable = tableMarkdown.replace(/\s+$/, '')
  if (!newTable) return source
  const safeOffset = Math.max(0, Math.min(offset, source.length))
  const before = source.slice(0, safeOffset)
  const after = source.slice(safeOffset)
  // We pad with `\n\n` on either side unless the surrounding text
  // already ends/starts with a blank line. `endsBlank` is true when the
  // text before our insertion already terminates a line with a blank
  // line behind it — i.e. the existing line is empty. `startsBlank` is
  // the symmetric condition on the trailing slice.
  const beforePad = before.length === 0 || /\n[ \t]*\n$/.test(before)
    ? ''
    : before.endsWith('\n')
      ? '\n'
      : '\n\n'
  const afterPad = after.length === 0 || /^[ \t]*\n/.test(after)
    ? after.length === 0 && !after.endsWith('\n')
      ? '\n'
      : ''
    : after.startsWith('\n')
      ? '\n'
      : '\n\n'
  return `${before}${beforePad}${newTable}${afterPad}${after}`
}
