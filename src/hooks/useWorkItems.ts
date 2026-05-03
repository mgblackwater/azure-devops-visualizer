import { useMemo } from 'react'
import {
  useRunSavedQueryQuery,
  useRunWiqlQuery,
  useBatchGetWorkItemsQuery
} from '@/store/api/adoApi'
import { useAppSelector } from '@/store'
import { getType } from '@/utils/workItemFields'
import type { AdoWiqlLinkResult, AdoWiqlResult, AdoWorkItem } from '@shared/adoTypes'

export interface WorkItemsResult {
  items: AdoWorkItem[]
  links: AdoWiqlLinkResult[]
  byId: Map<number, AdoWorkItem>
  isLoading: boolean
  isFetching: boolean
  error: unknown
  refetch: () => void
}

/** Per-type counts of an unfiltered item list, sorted by count desc. */
export interface TypeStat {
  type: string
  count: number
}

export function typeStats(items: AdoWorkItem[]): TypeStat[] {
  const m = new Map<string, number>()
  for (const w of items) {
    const t = getType(w)
    m.set(t, (m.get(t) ?? 0) + 1)
  }
  return [...m.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
}

/**
 * Drop work items whose type is hidden. Links are kept only when both
 * endpoints survive — orphaned children just become roots in the layout.
 */
export function applyTypeFilter(
  raw: WorkItemsResult,
  hiddenTypes: readonly string[]
): WorkItemsResult {
  if (hiddenTypes.length === 0) return raw
  const hidden = new Set(hiddenTypes)
  const items = raw.items.filter((w) => !hidden.has(getType(w)))
  if (items.length === raw.items.length) return raw
  const byId = new Map<number, AdoWorkItem>()
  for (const w of items) byId.set(w.id, w)
  const links = raw.links.filter(
    (l) => l.source && l.target && byId.has(l.source.id) && byId.has(l.target.id)
  )
  return {
    ...raw,
    items,
    byId,
    links
  }
}

interface QueryShape {
  data?: AdoWiqlResult
  isLoading: boolean
  isFetching: boolean
  error?: unknown
  refetch: () => void
}

const EMPTY_RESULT: WorkItemsResult = {
  items: [],
  links: [],
  byId: new Map(),
  isLoading: false,
  isFetching: false,
  error: undefined,
  refetch: () => {}
}

/**
 * Single source of truth for any visualization. Reads the active workspace
 * (project/team/source) from Redux, runs the appropriate WIQL or saved query,
 * then hydrates all referenced ids via the batch endpoint.
 */
export function useWorkItems(): WorkItemsResult {
  const { projectId, teamId, source } = useAppSelector((s) => s.workspace)

  const wiqlQuery = useRunWiqlQuery(
    projectId && source?.kind === 'wiql'
      ? { projectId, teamId: teamId ?? undefined, wiql: source.wiql }
      : (undefined as never),
    { skip: !projectId || source?.kind !== 'wiql' }
  )

  const savedQuery = useRunSavedQueryQuery(
    projectId && source?.kind === 'savedQuery'
      ? { projectId, teamId: teamId ?? undefined, queryId: source.queryId }
      : (undefined as never),
    { skip: !projectId || source?.kind !== 'savedQuery' }
  )

  const active: QueryShape = source?.kind === 'wiql' ? wiqlQuery : savedQuery

  const ids = useMemo(() => {
    if (!active.data) return []
    const set = new Set<number>()
    for (const w of active.data.workItems ?? []) set.add(w.id)
    for (const l of active.data.workItemRelations ?? []) {
      if (l.source) set.add(l.source.id)
      if (l.target) set.add(l.target.id)
    }
    return [...set]
  }, [active.data])

  const batch = useBatchGetWorkItemsQuery(
    projectId && ids.length > 0
      ? { projectId, ids }
      : (undefined as never),
    { skip: !projectId || ids.length === 0 }
  )

  return useMemo<WorkItemsResult>(() => {
    if (!projectId || !source) return EMPTY_RESULT
    const items = batch.data ?? []
    const byId = new Map<number, AdoWorkItem>()
    for (const item of items) byId.set(item.id, item)
    return {
      items,
      links: active.data?.workItemRelations ?? [],
      byId,
      isLoading: active.isLoading || batch.isLoading,
      isFetching: active.isFetching || batch.isFetching,
      error: active.error ?? batch.error,
      refetch: () => {
        active.refetch()
        batch.refetch()
      }
    }
  }, [projectId, source, active, batch])
}
