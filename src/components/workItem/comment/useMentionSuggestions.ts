import { useMemo } from 'react'
import { useGetProjectMembersQuery } from '@/store/api/adoApi'
import type { AdoComment, AdoIdentity, AdoWorkItem } from '@shared/adoTypes'
import type { MentionItem } from './MentionList'

/**
 * Build the candidate list for a comment composer's `@`-mention picker.
 *
 * The list has two halves:
 *
 *   1. **Recent contributors on this work item.** Authors of the
 *      existing comment thread plus the work item's
 *      `System.AssignedTo` / `System.CreatedBy` / `System.ChangedBy`.
 *      These are the people the user is most likely to want to tag,
 *      and they're free to compute — we already have the comments
 *      and the work item record on hand.
 *   2. **Project members.** Sourced from a single IPC call to the
 *      project's default-team roster. Cached aggressively, so the
 *      picker is instant on second open.
 *
 * Both halves are combined here so the composer has a single source of
 * truth. Filtering by query is left to the caller (typically the
 * Mention extension's `items` callback) because TipTap's suggestion
 * plugin needs a synchronous result against the current keystroke;
 * doing the filter at the call site keeps that path tight.
 */

export interface UseMentionSuggestionsArgs {
  projectId: string | undefined
  workItem: AdoWorkItem | undefined
  comments: AdoComment[] | undefined
}

export interface UseMentionSuggestionsResult {
  /**
   * Recent contributors first, then project members, deduped by
   * descriptor (or id, falling back to display name + uniqueName).
   */
  allItems: MentionItem[]
  /**
   * True while the project-members IPC call is in flight and we have
   * no project members cached yet. Useful for the picker to render a
   * "Searching…" hint instead of a misleading empty state on first
   * open.
   */
  loading: boolean
  /**
   * Pure filter helper. Filters by case-insensitive substring on
   * display name + uniqueName, capped at 25 results so the popup
   * doesn't try to render a huge tenant.
   */
  filterItems: (query: string) => MentionItem[]
}

const MAX_VISIBLE = 25

export function useMentionSuggestions({
  projectId,
  workItem,
  comments
}: UseMentionSuggestionsArgs): UseMentionSuggestionsResult {
  const membersQ = useGetProjectMembersQuery(
    projectId ? { projectId } : (undefined as never),
    { skip: !projectId }
  )

  const recentContributors = useMemo(
    () => collectRecentContributors(workItem, comments),
    [workItem, comments]
  )

  const projectMembers = useMemo<MentionItem[]>(
    () =>
      (membersQ.data?.identities ?? []).map((identity) =>
        identityToMentionItem(identity, false)
      ),
    [membersQ.data]
  )

  // Merge: recent first, then everyone else, deduped.
  const allItems = useMemo<MentionItem[]>(() => {
    const seen = new Set<string>()
    const out: MentionItem[] = []
    for (const r of recentContributors) {
      const key = dedupeKey(r)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(r)
    }
    for (const m of projectMembers) {
      const key = dedupeKey(m)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(m)
    }
    return out
  }, [recentContributors, projectMembers])

  // Stable filter helper. We keep it inside `useMemo` so its identity
  // is stable across renders that don't change the underlying data —
  // the Mention extension's `items` config captures it once at editor
  // construction time.
  const filterItems = useMemo<(query: string) => MentionItem[]>(() => {
    return (query: string) => {
      if (!query) return allItems.slice(0, MAX_VISIBLE)
      const needle = query.toLowerCase()
      const matches: MentionItem[] = []
      for (const item of allItems) {
        const name = item.label.toLowerCase()
        const email = (item.uniqueName ?? '').toLowerCase()
        if (name.includes(needle) || email.includes(needle)) {
          matches.push(item)
          if (matches.length >= MAX_VISIBLE) break
        }
      }
      return matches
    }
  }, [allItems])

  return {
    allItems,
    loading: membersQ.isLoading && projectMembers.length === 0,
    filterItems
  }
}

function dedupeKey(item: MentionItem): string {
  if (item.id) return `id:${item.id}`
  return `nm:${item.label}|${item.uniqueName ?? ''}`.toLowerCase()
}

function identityToMentionItem(
  identity: AdoIdentity,
  recent: boolean
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
    recent
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
    out.push(identityToMentionItem(identity, true))
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
