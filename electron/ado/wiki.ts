import {
  adoFetch,
  adoFetchRaw,
  AdoApiError,
  invalidateCacheForPathPrefix
} from './client'
import { getStoredOrganizationUrl } from '../auth/tokenStore'
import type {
  AdoWiki,
  AdoWikiPage,
  AdoWikiSearchHit
} from '@shared/adoTypes'
import type { UpdateWikiPageResult } from '@shared/contract'

interface AdoListResponse<T> {
  count: number
  value: T[]
}

const WIKI_API_VERSION = '7.1'
const WIKI_LIST_TTL_MS = 60_000
const WIKI_TREE_TTL_MS = 60_000
const WIKI_PAGE_TTL_MS = 60_000
const WIKI_SEARCH_TTL_MS = 30_000

export async function listWikis(projectId: string): Promise<AdoWiki[]> {
  const res = await adoFetch<AdoListResponse<AdoWiki>>({
    method: 'GET',
    path: `/${encodeURIComponent(projectId)}/_apis/wiki/wikis`,
    apiVersion: WIKI_API_VERSION,
    cacheTtlMs: WIKI_LIST_TTL_MS
  })
  return res.value
}

/**
 * Recursive page tree for a wiki. We omit `includeContent` (and pass
 * `recursionLevel=Full`) so the renderer can build the sidebar cheaply
 * without pulling every page body — bodies fetch on demand via
 * `getWikiPage`.
 */
export async function getPageTree(
  projectId: string,
  wikiId: string
): Promise<AdoWikiPage> {
  return adoFetch<AdoWikiPage>({
    method: 'GET',
    path: `/${encodeURIComponent(projectId)}/_apis/wiki/wikis/${encodeURIComponent(wikiId)}/pages`,
    query: {
      path: '/',
      recursionLevel: 'Full',
      includeContent: false
    },
    apiVersion: WIKI_API_VERSION,
    cacheTtlMs: WIKI_TREE_TTL_MS,
    cacheKey: `wiki:tree:${projectId}:${wikiId}`
  })
}

export async function getWikiPage(args: {
  projectId: string
  wikiId: string
  path: string
  includeContent?: boolean
}): Promise<AdoWikiPage> {
  // ADO insists on a leading slash on the path query param. Normalise so
  // callers can pass either form without thinking about it.
  const normalisedPath = args.path.startsWith('/') ? args.path : `/${args.path}`
  const includeContent = args.includeContent ?? true
  // Use the raw fetch so we can pull the page version off the `ETag`
  // response header. The renderer needs that for `If-Match` on a
  // subsequent update; without it, every save would race the conflict
  // path. The cache stores the full envelope, so a hit still gives us
  // the eTag without a network round-trip.
  const raw = await adoFetchRaw<AdoWikiPage>({
    method: 'GET',
    path: `/${encodeURIComponent(args.projectId)}/_apis/wiki/wikis/${encodeURIComponent(args.wikiId)}/pages`,
    query: {
      path: normalisedPath,
      includeContent
    },
    apiVersion: WIKI_API_VERSION,
    cacheTtlMs: WIKI_PAGE_TTL_MS,
    cacheKey: `wiki:page:${args.projectId}:${args.wikiId}:${normalisedPath}:${includeContent}`
  })
  return attachETag(raw.data, raw.headers)
}

/**
 * Replace the markdown body of a single wiki page. Requires the page's
 * current `eTag` (received from {@link getWikiPage} or a prior call to
 * this function) for optimistic concurrency control via `If-Match` —
 * ADO will reject with 412 when the eTag is stale, which we surface as
 * `AdoApiError` with `code: 'CONFLICT'` so the renderer can prompt the
 * user to reload or force-overwrite.
 *
 * On success the page cache is invalidated and the returned envelope
 * carries the freshly-issued eTag, letting the renderer chain
 * sequential edits without a follow-up GET.
 */
export async function updatePage(args: {
  projectId: string
  wikiId: string
  path: string
  content: string
  /** Most recent eTag for this page. Omit to force-overwrite (`If-Match: *`). */
  eTag?: string
}): Promise<UpdateWikiPageResult> {
  const normalisedPath = args.path.startsWith('/') ? args.path : `/${args.path}`
  const headers: Record<string, string> = {
    // Some ADO clusters store the eTag with surrounding double-quotes
    // and others without. We pass it through verbatim — `getWikiPage`
    // captured exactly what the server sent — so the round-trip
    // matches whatever the server expects on read-back.
    'If-Match': args.eTag && args.eTag.length > 0 ? args.eTag : '*'
  }
  const raw = await adoFetchRaw<AdoWikiPage>({
    method: 'PUT',
    path: `/${encodeURIComponent(args.projectId)}/_apis/wiki/wikis/${encodeURIComponent(args.wikiId)}/pages`,
    query: { path: normalisedPath },
    apiVersion: WIKI_API_VERSION,
    body: { content: args.content },
    headers,
    // PUTs aren't cached by adoFetchRaw, but PUTs DO go through the
    // cache invalidator. The default invalidation is by path-prefix
    // and only sees the request path (no query). Belt-and-braces a
    // matching invalidation here so an immediately-subsequent GET on
    // the same wiki path can never serve a stale value.
    cacheTtlMs: 0
  })
  invalidateCacheForPathPrefix(
    `wiki:page:${args.projectId}:${args.wikiId}:${normalisedPath}:`
  )
  const page = attachETag(raw.data, raw.headers)
  // ADO's PUT response body usually echoes the page record without the
  // `content` field populated; carry the new content through ourselves
  // so the renderer can keep its local view in sync without a refetch.
  return {
    page: { ...page, content: args.content },
    content: args.content
  }
}

/**
 * Pull the `ETag` header off a raw ADO response and attach it to the
 * typed page record. ADO's wiki API uses the standard `ETag` header
 * (lower-cased once it reaches `adoFetchRaw`'s headers map) and the
 * value is what `If-Match` expects on the matching PUT. We fall back
 * to `undefined` if the server omits the header — older on-prem
 * deployments occasionally do.
 */
function attachETag(
  page: AdoWikiPage,
  headers: Record<string, string>
): AdoWikiPage {
  const eTag = headers['etag']
  if (!eTag) return page
  return { ...page, eTag }
}

interface SearchResponse {
  count: number
  results: AdoWikiSearchHit[]
  /** Some responses use `infoCode` to communicate index health. */
  infoCode?: number
}

/**
 * Resolve the alm-search host that serves wiki/code/work-item search.
 *
 *   - Cloud DevOps:    dev.azure.com/{org}      → almsearch.dev.azure.com/{org}
 *   - Legacy host:     {org}.visualstudio.com   → {org}.almsearch.visualstudio.com
 *   - On-prem Server:  best-effort fallback to the same host (most installs
 *                      route /search/... on the main collection URL).
 */
function almSearchUrl(orgUrl: string): string {
  const u = new URL(orgUrl)
  const path = u.pathname.replace(/\/$/, '')
  if (u.host === 'dev.azure.com') {
    return `${u.protocol}//almsearch.dev.azure.com${path}`
  }
  if (u.host.endsWith('.visualstudio.com')) {
    const sub = u.host.replace(/\.visualstudio\.com$/, '')
    return `${u.protocol}//${sub}.almsearch.visualstudio.com${path}`
  }
  return `${u.protocol}//${u.host}${path}`
}

/**
 * POST to the ADO Search extension's wiki search endpoint. The endpoint
 * lives on a separate `almsearch.*` host and isn't installed on every
 * org — when it 404s/410s/401s we surface a structured `NOT_FOUND` so
 * the renderer can fall back to client-side filtering instead of
 * blanking the search panel.
 */
export async function searchWiki(args: {
  projectId: string
  term: string
  top?: number
  skip?: number
}): Promise<{ count: number; results: AdoWikiSearchHit[] }> {
  const orgUrl = await getStoredOrganizationUrl()
  if (!orgUrl) {
    throw new AdoApiError(
      'NOT_AUTHENTICATED',
      'No Azure DevOps organization configured.'
    )
  }
  const baseUrl = almSearchUrl(orgUrl)
  const top = args.top ?? 50
  const skip = args.skip ?? 0
  try {
    const res = await adoFetch<SearchResponse>({
      method: 'POST',
      baseUrl,
      path: `/${encodeURIComponent(args.projectId)}/_apis/search/wikisearchresults`,
      apiVersion: WIKI_API_VERSION,
      // No `filters.Project` — the URL is already project-scoped, and the
      // Project filter expects project NAMES (not GUIDs); sending an ID
      // here triggers "Wrong project filter applied at project context."
      body: {
        searchText: args.term,
        $top: top,
        $skip: skip
      },
      cacheTtlMs: WIKI_SEARCH_TTL_MS,
      cacheKey: `wiki:search:${args.projectId}:${args.term}:${top}:${skip}`
    })
    return { count: res.count ?? res.results?.length ?? 0, results: res.results ?? [] }
  } catch (err) {
    // Search extension unavailable / unlicensed → bubble up as NOT_FOUND
    // so the renderer can render a friendly fallback. We treat 401 the
    // same way because the alm-search host returns 401 for orgs where
    // the calling PAT lacks the `vso.search` scope, and degrading to
    // local filtering is preferable to forcing the user to widen scope.
    // We also fold 400 into NOT_FOUND so a malformed query (e.g. older
    // search index that rejects our body) degrades gracefully instead of
    // surfacing a raw error in the sidebar.
    if (err instanceof AdoApiError) {
      if (
        err.status === 404 ||
        err.status === 410 ||
        err.status === 401 ||
        err.status === 400
      ) {
        throw new AdoApiError(
          'NOT_FOUND',
          'Server-side wiki search isn\'t available on this organization (Search extension not installed, PAT lacks the search scope, or the org rejected the search payload).',
          err.status,
          err.details
        )
      }
    }
    throw err
  }
}
