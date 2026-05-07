import { adoFetch, invalidateCacheForPathPrefix } from './client'
import type {
  AdoComment,
  AdoJsonPatch,
  AdoWiqlResult,
  AdoWorkItem,
  AdoWorkItemTypeState
} from '@shared/adoTypes'

const DEFAULT_FIELDS: readonly string[] = [
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.AssignedTo',
  'System.TeamProject',
  'System.IterationPath',
  'System.AreaPath',
  'System.Tags',
  'System.CreatedDate',
  'System.ChangedDate',
  'Microsoft.VSTS.Scheduling.StartDate',
  'Microsoft.VSTS.Scheduling.TargetDate',
  'Microsoft.VSTS.Scheduling.DueDate',
  'Microsoft.VSTS.Scheduling.RemainingWork',
  'Microsoft.VSTS.Scheduling.CompletedWork',
  'Microsoft.VSTS.Common.Priority',
  'Microsoft.VSTS.Common.StackRank',
  'Microsoft.VSTS.Common.BacklogPriority'
]

const BATCH_SIZE = 200

export async function runWiql(args: {
  projectId: string
  teamId?: string
  wiql: string
  top?: number
}): Promise<AdoWiqlResult> {
  const teamSegment = args.teamId ? `/${encodeURIComponent(args.teamId)}` : ''
  return adoFetch<AdoWiqlResult>({
    method: 'POST',
    path: `/${encodeURIComponent(args.projectId)}${teamSegment}/_apis/wit/wiql`,
    query: args.top ? { $top: args.top } : { $top: 1000 },
    body: { query: args.wiql },
    cacheTtlMs: 15_000
  })
}

export async function runSavedQuery(args: {
  projectId: string
  queryId: string
  teamId?: string
  top?: number
}): Promise<AdoWiqlResult> {
  const teamSegment = args.teamId ? `/${encodeURIComponent(args.teamId)}` : ''
  return adoFetch<AdoWiqlResult>({
    method: 'GET',
    path: `/${encodeURIComponent(args.projectId)}${teamSegment}/_apis/wit/wiql/${encodeURIComponent(args.queryId)}`,
    query: args.top ? { $top: args.top } : { $top: 1000 },
    cacheTtlMs: 15_000
  })
}

interface BatchRequestBody {
  ids: number[]
  fields?: string[]
  $expand?: 'none' | 'relations' | 'fields' | 'links' | 'all'
  asOf?: string
  errorPolicy?: 'omit' | 'fail'
}

interface BatchResponse {
  count: number
  value: AdoWorkItem[]
}

export async function batchGetWorkItems(args: {
  projectId?: string
  ids: number[]
  fields?: string[]
  $expand?: BatchRequestBody['$expand']
  asOf?: string
}): Promise<AdoWorkItem[]> {
  if (args.ids.length === 0) return []
  const projectSegment = args.projectId ? `/${encodeURIComponent(args.projectId)}` : ''
  const useFields = !args.$expand || args.$expand === 'none' || args.$expand === 'fields'

  const chunks: number[][] = []
  for (let i = 0; i < args.ids.length; i += BATCH_SIZE) {
    chunks.push(args.ids.slice(i, i + BATCH_SIZE))
  }

  const responses = await Promise.all(
    chunks.map((chunk) => {
      const body: BatchRequestBody = {
        ids: chunk,
        $expand: args.$expand,
        asOf: args.asOf,
        errorPolicy: 'omit'
      }
      if (useFields) {
        body.fields = args.fields ?? [...DEFAULT_FIELDS]
        delete body.$expand
      }
      return adoFetch<BatchResponse>({
        method: 'POST',
        path: `${projectSegment}/_apis/wit/workitemsbatch`,
        body,
        cacheTtlMs: 15_000,
        cacheKey: `batch:${projectSegment}:${chunk.join(',')}:${useFields ? (body.fields ?? []).join(',') : args.$expand}`
      })
    })
  )

  const seen = new Map<number, AdoWorkItem>()
  for (const r of responses) {
    for (const item of r.value) {
      seen.set(item.id, item)
    }
  }
  return args.ids.map((id) => seen.get(id)).filter((x): x is AdoWorkItem => !!x)
}

export async function getWorkItemWithRelations(args: {
  projectId?: string
  id: number
}): Promise<AdoWorkItem> {
  const projectSegment = args.projectId ? `/${encodeURIComponent(args.projectId)}` : ''
  return adoFetch<AdoWorkItem>({
    method: 'GET',
    path: `${projectSegment}/_apis/wit/workitems/${args.id}`,
    query: { $expand: 'relations' },
    cacheTtlMs: 5_000
  })
}

export async function patchWorkItem(args: {
  projectId?: string
  id: number
  patch: AdoJsonPatch[]
  bypassRules?: boolean
}): Promise<AdoWorkItem> {
  const projectSegment = args.projectId ? `/${encodeURIComponent(args.projectId)}` : ''
  return adoFetch<AdoWorkItem>({
    method: 'PATCH',
    path: `${projectSegment}/_apis/wit/workitems/${args.id}`,
    body: args.patch,
    contentType: 'application/json-patch+json',
    query: args.bypassRules ? { bypassRules: true } : undefined,
    cacheTtlMs: 0
  })
}

/**
 * In-memory cache for `getWorkItemTypeStates`. ADO's state catalogue
 * for a given (project, work-item-type) only changes when an admin
 * customises the process — never within a normal session — so a
 * 1-hour TTL is comfortably safe. Keyed on `${projectId}::${type}`
 * because the same type name can resolve to different state lists
 * across projects on customised orgs.
 *
 * Lives at module scope rather than going through `adoFetch`'s shared
 * cache because the latter is keyed on full URL — fine, but this
 * smaller dedicated map keeps the hot path zero-allocation and makes
 * the TTL choice explicit at the call site.
 */
const TYPE_STATES_TTL_MS = 60 * 60 * 1000
interface TypeStatesCacheEntry {
  expiresAt: number
  states: AdoWorkItemTypeState[]
}
const typeStatesCache = new Map<string, TypeStatesCacheEntry>()

interface RawWorkItemTypeStatesResponse {
  count?: number
  value?: Array<{
    name?: string
    color?: string
    category?: string
  }>
}

/**
 * Fetch the valid `System.State` values for a given work-item type
 * inside a project. Used by the drawer's clickable state pill so the
 * popover lists the *actually customisable* set of next states (e.g.
 * a process that adds a "Triage" state shows up here even though it's
 * not in any of our hard-coded fallbacks).
 *
 * Cached 1 hour per (project, type) — see `TYPE_STATES_TTL_MS`. The
 * cache is intentionally not keyed off the work-item id; two items of
 * the same type in the same project share the lookup.
 */
export async function getWorkItemTypeStates(args: {
  projectId: string
  workItemType: string
}): Promise<{ states: AdoWorkItemTypeState[] }> {
  const cacheKey = `${args.projectId}::${args.workItemType}`
  const hit = typeStatesCache.get(cacheKey)
  if (hit && hit.expiresAt > Date.now()) {
    return { states: hit.states }
  }
  const data = await adoFetch<RawWorkItemTypeStatesResponse>({
    method: 'GET',
    path: `/${encodeURIComponent(args.projectId)}/_apis/wit/workitemtypes/${encodeURIComponent(
      args.workItemType
    )}/states`,
    cacheTtlMs: 0 // we own the TTL via `typeStatesCache`
  })
  const states: AdoWorkItemTypeState[] = (data.value ?? [])
    .filter((s) => typeof s.name === 'string' && s.name.length > 0)
    .map((s) => ({
      name: s.name as string,
      color: s.color,
      category: s.category as AdoWorkItemTypeState['category']
    }))
  typeStatesCache.set(cacheKey, {
    expiresAt: Date.now() + TYPE_STATES_TTL_MS,
    states
  })
  return { states }
}

interface CommentsResponse {
  totalCount?: number
  count?: number
  comments?: AdoComment[]
}

const COMMENTS_API_VERSION = '7.1-preview.4'
const COMMENTS_CACHE_TTL_MS = 60_000

/** Lower-cased substring match — ADO's @-mention HTML still embeds the
 *  visible display name as plain text inside `<span>` tags, so a simple
 *  contains check works without parsing the markup. */
function commentMatches(text: string | undefined, needle: string): boolean {
  if (!text) return false
  return text.toLowerCase().includes(needle)
}

/**
 * Convert HTML to a compact plain-text excerpt suitable for one- or
 * two-line preview in a list row. Mirrors what the renderer would do
 * after sanitising, but pre-flattens here so the IPC payload stays
 * small and the client doesn't need to parse HTML twice.
 */
function htmlToSnippet(html: string, maxChars = 200): string {
  if (!html) return ''
  // Strip script/style first so their textContent doesn't leak in.
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // Decode the handful of entities that show up in real ADO comments.
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped.length <= maxChars) return stripped
  // Try to break on a word boundary so the ellipsis doesn't fall in the
  // middle of a long mention/word.
  const cut = stripped.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut) + '…'
}

/**
 * For a list of work item ids, return a small summary of the most recent
 * comment whose text contains `searchText` (case-insensitive). Used by
 * the renderer's "Mentions me" tab so each row can sort by latest
 * mention *and* show an inline preview without a second round-trip.
 *
 * Implementation notes:
 * - Comments live on a per-item endpoint; we fan out one HTTP call per
 *   id, throttled to a small concurrency window so we don't blow past
 *   ADO's rate limit (~200 req/5s for most tenants).
 * - Each call is cheap and the response is small. We cache per-id for a
 *   minute since mentions don't churn at sub-minute granularity.
 * - Items with no matching comment get `null` so the renderer can rank
 *   them below items with a real mention timestamp instead of dropping
 *   them — they did still match the WIQL.
 */
export async function getLatestMentions(args: {
  projectId: string
  ids: number[]
  searchText: string
}): Promise<{
  byId: Record<number, { date: string; snippet: string; author?: string } | null>
}> {
  const out: Record<
    number,
    { date: string; snippet: string; author?: string } | null
  > = {}
  if (args.ids.length === 0 || !args.searchText.trim()) {
    for (const id of args.ids) out[id] = null
    return { byId: out }
  }

  const needle = args.searchText.toLowerCase()
  const projectSegment = `/${encodeURIComponent(args.projectId)}`
  const CONCURRENCY = 8

  async function processOne(id: number): Promise<void> {
    try {
      const data = await adoFetch<CommentsResponse>({
        method: 'GET',
        path: `${projectSegment}/_apis/wit/workItems/${id}/comments`,
        apiVersion: COMMENTS_API_VERSION,
        cacheTtlMs: COMMENTS_CACHE_TTL_MS,
        cacheKey: `comments:${projectSegment}:${id}`
      })
      let bestTs = -1
      let bestComment: AdoComment | null = null
      for (const c of data.comments ?? []) {
        if (!commentMatches(c.text, needle)) continue
        const ts = c.createdDate ? Date.parse(c.createdDate) : NaN
        if (!Number.isFinite(ts)) continue
        if (ts > bestTs) {
          bestTs = ts
          bestComment = c
        }
      }
      if (bestComment && bestTs >= 0) {
        out[id] = {
          date: new Date(bestTs).toISOString(),
          snippet: htmlToSnippet(bestComment.text ?? ''),
          author: bestComment.createdBy?.displayName
        }
      } else {
        out[id] = null
      }
    } catch {
      // Single 404/permission failure shouldn't sink the whole batch.
      out[id] = null
    }
  }

  // Hand-rolled fixed-concurrency worker pool. ids ≤ 100 in practice so
  // we don't reach for an external queue lib.
  let cursor = 0
  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(CONCURRENCY, args.ids.length); i += 1) {
    workers.push(
      (async () => {
        while (true) {
          const next = cursor++
          if (next >= args.ids.length) return
          await processOne(args.ids[next])
        }
      })()
    )
  }
  await Promise.all(workers)
  return { byId: out }
}

/**
 * Fetch every comment on a single work item, newest first. Backs the
 * Discussion section in the work-item drawer.
 *
 * Cached briefly so flipping between Details/Edit tabs doesn't re-hit
 * the network, but short enough that fresh comments show up on a manual
 * refresh of the drawer.
 */
export async function listComments(args: {
  projectId: string
  id: number
}): Promise<{ comments: AdoComment[] }> {
  const projectSegment = `/${encodeURIComponent(args.projectId)}`
  const data = await adoFetch<CommentsResponse>({
    method: 'GET',
    path: `${projectSegment}/_apis/wit/workItems/${args.id}/comments`,
    apiVersion: COMMENTS_API_VERSION,
    cacheTtlMs: COMMENTS_CACHE_TTL_MS,
    cacheKey: `comments:${projectSegment}:${args.id}`
  })
  const comments = [...(data.comments ?? [])].sort((a, b) => {
    const ta = a.createdDate ? Date.parse(a.createdDate) : 0
    const tb = b.createdDate ? Date.parse(b.createdDate) : 0
    return tb - ta
  })
  return { comments }
}

/**
 * Append a new comment to a work item. The body is HTML — TipTap output
 * post-`serializeForAdo`. ADO accepts standard rich-text markup
 * (paragraphs, lists, links, code blocks) plus its own mention anchor
 * form `<a data-vss-mention="version:2.0,{descriptor}">@Name</a>`; the
 * renderer is expected to produce that markup before invoking us, so
 * this function is a thin POST.
 *
 * On success we invalidate the comments cache for this work item so a
 * follow-up `listComments` (triggered by RTK Query tag invalidation
 * downstream) goes back to the network and picks up the new entry.
 */
export async function addComment(args: {
  projectId: string
  workItemId: number
  htmlText: string
}): Promise<{ comment: AdoComment }> {
  const projectSegment = `/${encodeURIComponent(args.projectId)}`
  const data = await adoFetch<AdoComment>({
    method: 'POST',
    path: `${projectSegment}/_apis/wit/workItems/${args.workItemId}/comments`,
    apiVersion: COMMENTS_API_VERSION,
    body: { text: args.htmlText },
    cacheTtlMs: 0
  })
  // The path-prefix invalidator drops every cached GET that includes the
  // comments path; the cache key for `listComments` is custom-shaped so
  // we also explicitly nuke it to belt-and-braces the freshness.
  invalidateCacheForPathPrefix(
    `${projectSegment}/_apis/wit/workItems/${args.workItemId}/comments`
  )
  invalidateCacheForPathPrefix(`comments:${projectSegment}:${args.workItemId}`)
  return { comment: data }
}

/**
 * Convenience: run a WIQL and hydrate the resulting items in one call.
 * If the query returns work item links (tree / one-hop), we union all referenced ids.
 */
export async function runQueryAndHydrate(args: {
  projectId: string
  wiql: string
  teamId?: string
  fields?: string[]
  top?: number
}): Promise<{ result: AdoWiqlResult; items: AdoWorkItem[] }> {
  const result = await runWiql({
    projectId: args.projectId,
    teamId: args.teamId,
    wiql: args.wiql,
    top: args.top
  })
  const ids = new Set<number>()
  for (const w of result.workItems ?? []) ids.add(w.id)
  for (const link of result.workItemRelations ?? []) {
    if (link.source) ids.add(link.source.id)
    if (link.target) ids.add(link.target.id)
  }
  const items = await batchGetWorkItems({
    projectId: args.projectId,
    ids: [...ids],
    fields: args.fields ?? [...DEFAULT_FIELDS]
  })
  return { result, items }
}
