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
 * dropdown, not a full result page. Recently-changed items rank first.
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
    const t = escapeWiql(parsed.text)
    conditions.push(
      `([System.Title] CONTAINS '${t}'` +
        ` OR [System.Tags] CONTAINS '${t}'` +
        ` OR [System.AssignedTo] CONTAINS '${t}')`
    )
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

function escapeWiql(s: string): string {
  return s.replace(/'/g, "''")
}
