import { useEffect, useMemo, useState } from 'react'
import {
  useGetProjectMembersQuery,
  useSearchIdentitiesByQueryQuery
} from '@/store/api/adoApi'
import type { AdoComment, AdoIdentity, AdoWorkItem } from '@shared/adoTypes'
import type { MentionItem, MentionSource } from './MentionList'
import { scoreMention } from './mentionScore'

/**
 * Build the candidate list for a comment composer's `@`-mention picker.
 *
 * The list is layered in priority order:
 *
 *   1. **Recent contributors on this work item.** Authors of the
 *      existing comment thread plus the work item's
 *      `System.AssignedTo` / `System.CreatedBy` / `System.ChangedBy`.
 *      These are the people the user is most likely to want to tag,
 *      and they're free to compute — we already have the comments
 *      and the work item record on hand.
 *   2. **Project default-team members.** Sourced from a single IPC
 *      call to the project's default-team roster. Cached aggressively,
 *      so the picker is instant on second open. Used to seed the
 *      picker before the user has typed anything.
 *   3. **Live identity search.** Once the user types something after
 *      `@`, we debounce-fire `IdentitySearchByQuery` against ADO's
 *      `IdentityPicker` endpoint (the same one ADO web uses), which
 *      returns identities from the entire org — not just one team.
 *      Without this layer the picker would be limited to whoever
 *      happens to be in the project's default team, which routinely
 *      excludes the people the user actually wants to tag.
 *
 * All three layers are combined here so the composer has a single
 * source of truth. Filtering by query is *also* applied client-side
 * (against the static layers) so TipTap's synchronous `items()`
 * callback keeps working between debounced server hits — the user
 * sees something immediately, then the server's richer matches fold
 * in as they arrive.
 */

export interface UseMentionSuggestionsArgs {
  projectId: string | undefined
  workItem: AdoWorkItem | undefined
  comments: AdoComment[] | undefined
}

export interface UseMentionSuggestionsResult {
  /**
   * Combined snapshot: recent contributors → project members → live
   * search results, deduped by descriptor (or id, falling back to
   * display name + uniqueName). Server-side matches that already
   * appear in the static layers don't get duplicated.
   */
  allItems: MentionItem[]
  /**
   * True while either the static-members IPC call or a live identity
   * search is in flight and we have no relevant items yet. Drives
   * the picker's "Searching…" hint instead of a misleading "No
   * matches" on first open.
   */
  loading: boolean
  /**
   * Pure synchronous filter. Returns the union of:
   *   - static items (recent + project members) matching the query
   *   - live server results merged into `allItems` for the current
   *     debounced query
   *
   * No side effects — TipTap's `items({ query })` callback runs from
   * inside ProseMirror's plugin update path and a state update there
   * would be a React anti-pattern. The composer pumps the query back
   * into the hook via `setQuery` (below) instead.
   */
  filterItems: (query: string) => MentionItem[]
  /**
   * Push the current `@`-trigger query so the debounced server search
   * re-fires. Stable identity across renders — safe to call directly
   * from TipTap's `items({ query })` callback.
   */
  setQuery: (query: string) => void
}

const MAX_VISIBLE = 25
const SEARCH_DEBOUNCE_MS = 220
const SEARCH_MIN_CHARS = 1

export function useMentionSuggestions({
  projectId,
  workItem,
  comments
}: UseMentionSuggestionsArgs): UseMentionSuggestionsResult {
  // Static "no query yet" suggestions — project's default-team
  // members. Cheap once cached, populated on first composer mount.
  const membersQ = useGetProjectMembersQuery(
    projectId ? { projectId } : (undefined as never),
    { skip: !projectId }
  )

  // Live search query state. Driven by `filterItems` being called
  // from TipTap's `items({ query })`. We keep both the immediate
  // value (`liveQuery`) and a debounced mirror (`debouncedQuery`)
  // so we can fire RTK on the debounced one but still display
  // client-side filtered static items synchronously against the
  // immediate one.
  const [liveQuery, setLiveQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  useEffect(() => {
    const t = window.setTimeout(
      () => setDebouncedQuery(liveQuery),
      SEARCH_DEBOUNCE_MS
    )
    return () => window.clearTimeout(t)
  }, [liveQuery])

  const trimmedDebouncedQuery = debouncedQuery.trim()
  const enableSearch =
    !!projectId && trimmedDebouncedQuery.length >= SEARCH_MIN_CHARS
  const searchQ = useSearchIdentitiesByQueryQuery(
    enableSearch
      ? {
          projectId: projectId as string,
          query: trimmedDebouncedQuery,
          top: 25
        }
      : (undefined as never),
    { skip: !enableSearch }
  )

  const recentContributors = useMemo(
    () => collectRecentContributors(workItem, comments),
    [workItem, comments]
  )

  const projectMembers = useMemo<MentionItem[]>(
    () =>
      (membersQ.data?.identities ?? []).map((identity) =>
        identityToMentionItem(identity, 'projectMember')
      ),
    [membersQ.data]
  )

  const liveSearchResults = useMemo<MentionItem[]>(() => {
    // Stale-response guard: only treat the cached results as live
    // matches when their query echo still matches what the user
    // is searching for. ADO can return slightly out-of-order
    // responses when keystrokes are fast.
    if (!searchQ.data) return []
    if (
      searchQ.data.queryEcho.toLowerCase() !==
      trimmedDebouncedQuery.toLowerCase()
    ) {
      return []
    }
    return searchQ.data.identities.map((identity) =>
      identityToMentionItem(identity, 'live')
    )
  }, [searchQ.data, trimmedDebouncedQuery])

  // Merge: recent → project members → live search, deduped.
  //
  // Order matters here. Dedup is "first-seen wins" via the `seen` set,
  // so processing the buckets in priority order guarantees that an
  // identity who appears in multiple layers (e.g. the assignee is
  // also a project-team member who also turns up in IdentityPicker)
  // keeps the entry from the highest-priority layer — which carries
  // the right `source` tag for the bucket sort downstream.
  const allItems = useMemo<MentionItem[]>(() => {
    const seen = new Set<string>()
    const out: MentionItem[] = []
    function pushAll(items: MentionItem[]): void {
      for (const item of items) {
        const key = dedupeKey(item)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(item)
      }
    }
    pushAll(recentContributors)
    pushAll(projectMembers)
    pushAll(liveSearchResults)
    return out
  }, [recentContributors, projectMembers, liveSearchResults])

  // Pure synchronous filter + ranker — no state mutation. The Mention
  // extension captures this via ref, so the identity changing across
  // renders (when allItems updates) is fine; the ref is reread on
  // every keystroke.
  //
  // Sort precedence:
  //   1. bucket priority (recent < projectMember < live) — familiar
  //      faces always pin above org-wide IdentityPicker hits, even
  //      when a stranger fuzzy-matches the query slightly better.
  //   2. fuzzy score within the bucket, descending.
  //   3. alphabetical by display name for deterministic ordering on
  //      score ties (otherwise `Array.prototype.sort` is unstable
  //      across V8 versions for equal-key elements).
  const filterItems = useMemo<(query: string) => MentionItem[]>(() => {
    return (query: string) => {
      if (!query) {
        const sorted = [...allItems].sort(compareForPicker)
        return sorted.slice(0, MAX_VISIBLE)
      }
      const scored: Array<{ item: MentionItem; score: number }> = []
      for (const item of allItems) {
        const score = scoreMention(query, item)
        if (score > 0) scored.push({ item, score })
      }
      scored.sort((a, b) => {
        const ba = BUCKET_PRIORITY[a.item.source]
        const bb = BUCKET_PRIORITY[b.item.source]
        if (ba !== bb) return ba - bb
        if (a.score !== b.score) return b.score - a.score
        return a.item.label.localeCompare(b.item.label)
      })
      return scored.slice(0, MAX_VISIBLE).map((x) => x.item)
    }
  }, [allItems])

  return {
    allItems,
    loading:
      (membersQ.isLoading && projectMembers.length === 0) ||
      (enableSearch && searchQ.isFetching && liveSearchResults.length === 0),
    filterItems,
    setQuery: setLiveQuery
  }
}

const BUCKET_PRIORITY: Record<MentionSource, number> = {
  recent: 0,
  projectMember: 1,
  live: 2
}

function compareForPicker(a: MentionItem, b: MentionItem): number {
  const ba = BUCKET_PRIORITY[a.source]
  const bb = BUCKET_PRIORITY[b.source]
  if (ba !== bb) return ba - bb
  return a.label.localeCompare(b.label)
}

function dedupeKey(item: MentionItem): string {
  if (item.id) return `id:${item.id}`
  return `nm:${item.label}|${item.uniqueName ?? ''}`.toLowerCase()
}

function identityToMentionItem(
  identity: AdoIdentity,
  source: MentionSource
): MentionItem {
  // Prefer `descriptor` because that's what ADO's mention markup
  // expects; fall back to `id` (the GUID) when the identity payload
  // doesn't include one. The serializer rewrites either form into the
  // anchor — only the descriptor produces a real notification, but
  // the comment posts cleanly regardless.
  const stableId = identity.descriptor || identity.id || ''
  return {
    id: stableId,
    label: identity.displayName,
    uniqueName: identity.uniqueName,
    imageUrl: identity.imageUrl,
    source
  }
}

/**
 * Collect identities likely to be relevant to *this* work item:
 *   - Comment authors (in original chronological order so the most
 *     recent commenter ends up nearest the top after we reverse).
 *   - Assignee / CreatedBy / ChangedBy on the work item itself.
 */
function collectRecentContributors(
  workItem: AdoWorkItem | undefined,
  comments: AdoComment[] | undefined
): MentionItem[] {
  const out: MentionItem[] = []
  const seen = new Set<string>()
  function push(identity: AdoIdentity | undefined): void {
    if (!identity || !identity.displayName) return
    const stable = identity.descriptor || identity.id || identity.displayName
    if (seen.has(stable)) return
    seen.add(stable)
    out.push(identityToMentionItem(identity, 'recent'))
  }

  // Comments arrive newest-first from the server; iterate in order so
  // the most recent commenter ends up first in `out`.
  for (const c of comments ?? []) {
    push(c.createdBy)
    push(c.modifiedBy)
  }
  if (workItem) {
    push(workItem.fields['System.AssignedTo'] as AdoIdentity | undefined)
    push(workItem.fields['System.CreatedBy'] as AdoIdentity | undefined)
    push(workItem.fields['System.ChangedBy'] as AdoIdentity | undefined)
  }
  return out
}
