import { adoFetch } from './client'
import type {
  AdoJsonPatch,
  AdoWiqlResult,
  AdoWorkItem
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
