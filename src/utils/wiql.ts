/**
 * Build a WIQL that returns a work item plus all of its hierarchy descendants.
 * Used by "Focus on this subtree" to re-root the workspace at any work item.
 */
export function buildSubtreeWiql(rootId: number): string {
  return [
    'SELECT',
    '    [System.Id],',
    '    [System.WorkItemType],',
    '    [System.Title],',
    '    [System.State],',
    '    [System.AssignedTo],',
    '    [System.IterationPath],',
    '    [Microsoft.VSTS.Scheduling.StartDate],',
    '    [Microsoft.VSTS.Scheduling.TargetDate],',
    '    [Microsoft.VSTS.Common.Priority],',
    '    [Microsoft.VSTS.Common.StackRank]',
    'FROM WorkItemLinks',
    'WHERE',
    `    [Source].[System.Id] = ${rootId}`,
    "    AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'",
    "    AND [Target].[System.State] <> 'Removed'",
    'MODE (Recursive)'
  ].join('\n')
}

export interface ParsedSearch {
  /** Tokens to OR together against title/tags/assignee. */
  text?: string
  /** If present, restrict to items containing this tag. */
  tag?: string
  /** If present, restrict to items assigned to a name containing this. */
  assignee?: string
  /** Optional list of work-item types parsed from `type:` tokens. */
  types?: string[]
}

/**
 * Parse a free-text search input.
 *
 * Supports four light filter prefixes, mirroring how ADO's own portal search
 * narrows results:
 *   - `tag:critical foo`  → tag must contain "critical", title contains "foo"
 *   - `@bob fix login`    → assignee contains "bob", title contains "fix login"
 *   - `type:bug login`    → only Bugs whose title contains "login"
 *   - `bug` (no prefix)   → searched against title/tags/assignee.
 *
 * Prefix tokens may appear anywhere in the string; the remaining text becomes
 * the freeform query. Quoted phrases are *not* parsed specially — ADO's
 * `CONTAINS` operator already does case-insensitive substring matches that
 * cover the common cases.
 *
 * `type:` accepts the canonical ADO type name (case-insensitive) or a few
 * common shorthands (`pbi`, `us`). The token is *not* used as a search-term
 * prefix; we expand it into the canonical type via {@link expandTypeAlias}
 * inside {@link buildSearchWiql}.
 */
export function parseSearchInput(raw: string): ParsedSearch {
  const out: ParsedSearch = {}
  const remaining: string[] = []
  const types: string[] = []
  for (const tok of raw.trim().split(/\s+/)) {
    if (!tok) continue
    if (tok.startsWith('tag:') && tok.length > 4) {
      out.tag = (out.tag ? `${out.tag} ` : '') + tok.slice(4)
    } else if (tok.toLowerCase().startsWith('type:') && tok.length > 5) {
      types.push(tok.slice(5))
    } else if (tok.startsWith('@') && tok.length > 1) {
      out.assignee = (out.assignee ? `${out.assignee} ` : '') + tok.slice(1)
    } else {
      remaining.push(tok)
    }
  }
  if (remaining.length > 0) out.text = remaining.join(' ')
  if (types.length > 0) out.types = types
  return out
}

const TYPE_ALIASES: Record<string, string> = {
  pbi: 'Product Backlog Item',
  us: 'User Story',
  story: 'User Story',
  tc: 'Test Case',
  bug: 'Bug',
  defect: 'Defect',
  task: 'Task',
  feature: 'Feature',
  epic: 'Epic',
  issue: 'Issue'
}

export function expandTypeAlias(raw: string): string {
  const t = raw.trim()
  if (!t) return t
  const lower = t.toLowerCase()
  return TYPE_ALIASES[lower] ?? t
}

export interface BuildSearchWiqlOptions {
  /** Cap on returned ids (autocomplete only needs ~30). */
  top?: number
  /**
   * Restrict the result to these work-item types. Values are run through
   * {@link expandTypeAlias} so the caller can pass either canonical names
   * (e.g. `Product Backlog Item`) or shorthands (e.g. `PBI`).
   */
  types?: string[]
}

/**
 * Build a WIQL that searches the configured project for work items matching a
 * free-text term against title, tags, or assignee.
 *
 * Strategy — token-based fuzzy match:
 *   - The free-text portion is tokenized on whitespace.
 *   - Each token must appear *somewhere* in the item's title, tags, or
 *     assignee (per-token OR over fields, AND across tokens).
 *   - This makes the search order- and spacing-independent: typing
 *     "login fix" matches "Fix login bug" the same as typing "fix login".
 *   - Tokens shorter than 2 characters are ignored to avoid pulling in
 *     huge result sets on noise like a stray "a".
 *
 * Notes on operator choice:
 *   - `CONTAINS` does a case-insensitive substring match and is supported on
 *     `String` fields including `System.Tags` and `System.AssignedTo`. We use
 *     it consistently rather than `CONTAINS WORDS` so the query works on
 *     organisations that haven't enabled the WIQL full-text indexer.
 *   - `@project` resolves to the project the WIQL is executed against; we
 *     include `[System.TeamProject] = @project` for clarity even though the
 *     project route already scopes the query.
 *   - Single quotes inside the search term are escaped by doubling them, the
 *     standard SQL-style escape that ADO's WIQL parser accepts.
 *
 * `top` is intentionally small (default 30) — this powers an autocomplete
 * dropdown, not a full result page. Recently-changed items rank first; the
 * caller should re-rank client-side via {@link scoreSearchMatch} for
 * relevance ordering.
 *
 * Type filters supplied via the explicit `types` option are *unioned* with
 * any `type:` tokens parsed from the input, so e.g. typing `type:bug login`
 * with `{types: ['Feature']}` yields `(Bug OR Feature)`.
 */
export function buildSearchWiql(
  input: string,
  topOrOpts: number | BuildSearchWiqlOptions = 30
): string {
  const opts: BuildSearchWiqlOptions =
    typeof topOrOpts === 'number' ? { top: topOrOpts } : topOrOpts
  void opts.top

  const parsed = parseSearchInput(input)
  const conditions: string[] = []
  if (parsed.text) {
    const tokens = tokenizeForSearch(parsed.text)
    for (const tok of tokens) {
      const t = escapeWiql(tok)
      conditions.push(
        `([System.Title] CONTAINS '${t}'` +
          ` OR [System.Tags] CONTAINS '${t}'` +
          ` OR [System.AssignedTo] CONTAINS '${t}')`
      )
    }
    // If every token was filtered out (all too short), fall back to the
    // raw text so the user still gets *something* — better than -1.
    if (tokens.length === 0) {
      const t = escapeWiql(parsed.text)
      conditions.push(
        `([System.Title] CONTAINS '${t}'` +
          ` OR [System.Tags] CONTAINS '${t}'` +
          ` OR [System.AssignedTo] CONTAINS '${t}')`
      )
    }
  }
  if (parsed.tag) {
    conditions.push(`[System.Tags] CONTAINS '${escapeWiql(parsed.tag)}'`)
  }
  if (parsed.assignee) {
    conditions.push(`[System.AssignedTo] CONTAINS '${escapeWiql(parsed.assignee)}'`)
  }

  // Combine inline `type:` tokens with explicit `types` option, deduping
  // case-insensitively after expanding aliases.
  const typeSet = new Set<string>()
  for (const t of [...(opts.types ?? []), ...(parsed.types ?? [])]) {
    const expanded = expandTypeAlias(t)
    if (expanded) typeSet.add(expanded)
  }
  if (typeSet.size > 0) {
    const list = [...typeSet].map((t) => `'${escapeWiql(t)}'`).join(', ')
    conditions.push(`[System.WorkItemType] IN (${list})`)
  }

  if (conditions.length === 0) {
    // No actionable input — produce a query that returns nothing rather than
    // tripping a WIQL parse error or pulling the full backlog.
    conditions.push('[System.Id] = -1')
  }
  return [
    'SELECT [System.Id]',
    'FROM WorkItems',
    'WHERE [System.TeamProject] = @project',
    "  AND [System.State] <> 'Removed'",
    `  AND ${conditions.join(' AND ')}`,
    'ORDER BY [System.ChangedDate] DESC'
  ].join('\n')
}

/**
 * Split a free-text search string into search tokens. Tokens shorter than
 * the minimum length are dropped (they typically just bloat the result set
 * with irrelevant hits when used in `CONTAINS`).
 */
export function tokenizeForSearch(input: string, minLength = 2): string[] {
  return input
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= minLength)
}

/**
 * Score how well a candidate item matches a tokenized query, for client-side
 * relevance ranking. Higher is better.
 *
 * Heuristics:
 *   - Title hits weigh more than tag hits, which weigh more than assignee.
 *   - A token that matches as a whole-word boundary is worth more than a
 *     mid-word substring (so "login" prefers "Fix login bug" over
 *     "Re-logging").
 *   - Title hits closer to the start of the title score slightly higher.
 *   - Items where every token matches get a hefty bonus; partial matches
 *     are still ranked but always below full matches.
 *   - Exact id match (when query is purely numeric) trumps everything.
 *
 * The function is deliberately allocation-light — it runs in `useMemo`
 * over the full result set on every keystroke after debounce.
 */
export function scoreSearchMatch(
  query: string,
  fields: { id: number; title: string; tags: string[]; assignee: string }
): number {
  const tokens = tokenizeForSearch(query, 1)
  if (tokens.length === 0) return 0

  const idStr = String(fields.id)
  const title = fields.title.toLowerCase()
  const tagsJoined = fields.tags.join(' ').toLowerCase()
  const assignee = fields.assignee.toLowerCase()

  let score = 0
  let matched = 0
  for (const raw of tokens) {
    const tok = raw.toLowerCase()
    let perToken = 0
    if (tok === idStr) perToken = Math.max(perToken, 1000)
    const titleIdx = title.indexOf(tok)
    if (titleIdx !== -1) {
      perToken = Math.max(perToken, 50 - Math.min(titleIdx, 40))
      if (isWordBoundaryHit(title, tok, titleIdx)) perToken += 20
    }
    if (tagsJoined.includes(tok)) perToken = Math.max(perToken, 20)
    if (assignee.includes(tok)) perToken = Math.max(perToken, 15)
    if (perToken > 0) matched += 1
    score += perToken
  }
  // Heavy bonus for matching every token — keeps "all-tokens-hit" results
  // above noisy partial matches even when individual scores are low.
  if (matched === tokens.length) score += 200
  return score
}

function isWordBoundaryHit(haystack: string, needle: string, idx: number): boolean {
  const left = idx === 0 || /[^a-z0-9]/i.test(haystack[idx - 1])
  const rightIdx = idx + needle.length
  const right =
    rightIdx >= haystack.length || /[^a-z0-9]/i.test(haystack[rightIdx])
  return left && right
}

function escapeWiql(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * Build a WIQL listing every active work item assigned to the authenticated
 * user. Uses the `@me` macro so the query is portable across users without
 * resolving the identity client-side. Removed items are filtered out so the
 * "My work" tab on the workspace page doesn't get cluttered with deleted
 * stories from years ago.
 *
 * `top` is a soft cap — the actual ADO API also enforces a 20k row hard
 * limit, but for an interactive list we typically want only the most
 * recently changed ~50–100 items.
 */
export function buildAssignedToMeWiql(top = 100): string {
  void top
  return [
    'SELECT [System.Id]',
    'FROM WorkItems',
    'WHERE [System.TeamProject] = @project',
    "  AND [System.State] <> 'Removed'",
    '  AND [System.AssignedTo] = @me',
    'ORDER BY [System.ChangedDate] DESC'
  ].join('\n')
}

/**
 * Build a WIQL listing items where the user appears in the discussion /
 * history (i.e. has been @-mentioned, was the changer, or had their name
 * typed in a comment). ADO doesn't expose a first-class "mentions" field
 * in WIQL, so we lean on `[System.History] CONTAINS '<name>'` — the
 * substring match is good enough in practice because the @-mention HTML
 * embeds the display name as visible text.
 *
 * The display name is trimmed of any trailing parenthetical (e.g. `Foo
 * Bar (Acme)`) so partial matches like `Foo Bar (External)` still hit
 * even when the user's tenant suffix differs across orgs.
 *
 * Self-edits are not excluded — a user is still considered "mentioned"
 * when they reply to their own comment, which matches how the ADO web UI
 * surfaces "follow"-style activity.
 */
/**
 * Strip a trailing parenthetical (e.g. `(Acme)`, `(External)`) and any
 * surrounding whitespace from a display name so it matches consistently
 * across orgs/tenants — both in WIQL `History CONTAINS` and in
 * comments-text substring searches. Returns an empty string if the
 * input collapses to nothing usable.
 */
export function normalizeMentionName(displayName: string): string {
  return displayName.replace(/\s*\(.*?\)\s*$/, '').trim()
}

export function buildMentionsMeWiql(displayName: string, top = 100): string {
  void top
  const trimmed = normalizeMentionName(displayName)
  if (!trimmed) {
    return [
      'SELECT [System.Id]',
      'FROM WorkItems',
      'WHERE [System.Id] = -1'
    ].join('\n')
  }
  return [
    'SELECT [System.Id]',
    'FROM WorkItems',
    'WHERE [System.TeamProject] = @project',
    "  AND [System.State] <> 'Removed'",
    `  AND [System.History] CONTAINS '${escapeWiql(trimmed)}'`,
    'ORDER BY [System.ChangedDate] DESC'
  ].join('\n')
}
