import {
  createApi,
  type BaseQueryFn,
  type FetchBaseQueryError
} from '@reduxjs/toolkit/query/react'
import { IPC, type IpcArgs, type IpcChannel } from '@shared/contract'
import type {
  AdoConnectionInfo,
  AdoIteration,
  AdoJsonPatch,
  AdoProject,
  AdoSavedQuery,
  AdoTeam,
  AdoTeamMember,
  AdoWiqlResult,
  AdoWorkItem,
  IpcError
} from '@shared/adoTypes'

export interface IpcInvokeArgs<C extends IpcChannel> {
  channel: C
  args?: IpcArgs<C>
}

/**
 * Force the rejected value into a plain serializable shape. The preload
 * bridge already rejects with a structured `IpcError` for everything that
 * went through `wrap()` in the main process, but we still defend against
 * Error instances or other oddities sneaking through (e.g. an exception
 * thrown by `window.ado.invoke` itself before the IPC call left the
 * renderer). Anything stored in Redux state must be JSON-serializable.
 */
function normalizeIpcError(raw: unknown): IpcError {
  if (raw && typeof raw === 'object' && 'code' in raw && 'message' in raw) {
    const r = raw as Partial<IpcError>
    let details: unknown
    try {
      details = r.details === undefined ? undefined : JSON.parse(JSON.stringify(r.details))
    } catch {
      details = undefined
    }
    return {
      code: (r.code as IpcError['code']) ?? 'INTERNAL',
      message: String(r.message ?? 'Unknown error'),
      status: typeof r.status === 'number' ? r.status : undefined,
      details
    }
  }
  if (raw instanceof Error) {
    return { code: 'INTERNAL', message: raw.message }
  }
  return {
    code: 'INTERNAL',
    message: typeof raw === 'string' ? raw : 'Unknown error'
  }
}

const ipcBaseQuery: BaseQueryFn<
  IpcInvokeArgs<IpcChannel>,
  unknown,
  FetchBaseQueryError
> = async ({ channel, args }) => {
  try {
    const data = await window.ado.invoke(channel, args as IpcArgs<typeof channel>)
    return { data }
  } catch (raw) {
    const err = normalizeIpcError(raw)
    return {
      error: {
        status: err.status ?? 'CUSTOM_ERROR',
        data: err
      } as FetchBaseQueryError
    }
  }
}

export const adoApi = createApi({
  reducerPath: 'adoApi',
  baseQuery: ipcBaseQuery,
  tagTypes: ['Connection', 'Projects', 'Teams', 'Iterations', 'SavedQueries', 'WorkItems', 'WorkItem'],
  endpoints: (build) => ({
    getConnection: build.query<AdoConnectionInfo, void>({
      query: () => ({ channel: IPC.ConnectionGet }),
      providesTags: ['Connection']
    }),

    setConnection: build.mutation<
      AdoConnectionInfo,
      { organizationUrl: string; personalAccessToken: string }
    >({
      query: (args) => ({ channel: IPC.ConnectionSet, args }),
      invalidatesTags: ['Connection', 'Projects', 'Teams', 'Iterations', 'SavedQueries', 'WorkItems']
    }),

    clearConnection: build.mutation<{ ok: true }, void>({
      query: () => ({ channel: IPC.ConnectionClear }),
      invalidatesTags: ['Connection', 'Projects', 'Teams', 'Iterations', 'SavedQueries', 'WorkItems']
    }),

    testConnection: build.mutation<
      AdoConnectionInfo,
      { organizationUrl: string; personalAccessToken: string }
    >({
      query: (args) => ({ channel: IPC.ConnectionTest, args })
    }),

    listProjects: build.query<AdoProject[], void>({
      query: () => ({ channel: IPC.ProjectsList }),
      providesTags: ['Projects']
    }),

    listTeams: build.query<AdoTeam[], { projectId: string }>({
      query: (args) => ({ channel: IPC.TeamsList, args }),
      providesTags: ['Teams']
    }),

    listTeamMembers: build.query<AdoTeamMember[], { projectId: string; teamId: string }>({
      query: (args) => ({ channel: IPC.TeamMembersList, args })
    }),

    listIterations: build.query<
      AdoIteration[],
      { projectId: string; teamId?: string; timeframe?: 'current' }
    >({
      query: (args) => ({ channel: IPC.IterationsList, args }),
      providesTags: ['Iterations']
    }),

    listSavedQueries: build.query<AdoSavedQuery[], { projectId: string; depth?: number }>({
      query: (args) => ({ channel: IPC.SavedQueriesList, args }),
      providesTags: ['SavedQueries']
    }),

    runWiql: build.query<
      AdoWiqlResult,
      { projectId: string; teamId?: string; wiql: string; top?: number }
    >({
      query: (args) => ({ channel: IPC.WorkItemsRunWiql, args }),
      providesTags: ['WorkItems']
    }),

    runSavedQuery: build.query<
      AdoWiqlResult,
      { projectId: string; queryId: string; teamId?: string; top?: number }
    >({
      query: (args) => ({ channel: IPC.WorkItemsRunSavedQuery, args }),
      providesTags: ['WorkItems']
    }),

    batchGetWorkItems: build.query<
      AdoWorkItem[],
      {
        projectId?: string
        ids: number[]
        fields?: string[]
        $expand?: 'none' | 'relations' | 'fields' | 'links' | 'all'
        asOf?: string
      }
    >({
      query: (args) => ({ channel: IPC.WorkItemsBatchGet, args }),
      providesTags: (result) =>
        result
          ? [
              'WorkItems',
              ...result.map((w) => ({ type: 'WorkItem' as const, id: w.id }))
            ]
          : ['WorkItems']
    }),

    getWorkItemWithRelations: build.query<
      AdoWorkItem,
      { projectId?: string; id: number }
    >({
      query: (args) => ({ channel: IPC.WorkItemsGetWithRelations, args }),
      providesTags: (_r, _e, arg) => [{ type: 'WorkItem' as const, id: arg.id }]
    }),

    patchWorkItem: build.mutation<
      AdoWorkItem,
      { projectId?: string; id: number; patch: AdoJsonPatch[]; bypassRules?: boolean }
    >({
      query: (args) => ({ channel: IPC.WorkItemsPatch, args }),
      async onQueryStarted(arg, { dispatch, queryFulfilled, getState }) {
        const updates: Array<() => void> = []
        const state = getState() as { adoApi: { queries: Record<string, { endpointName?: string; originalArgs?: unknown }> } }
        const queries = state.adoApi.queries
        for (const [, entry] of Object.entries(queries)) {
          if (entry.endpointName !== 'batchGetWorkItems') continue
          const args = entry.originalArgs as
            | { projectId?: string; ids: number[]; fields?: string[]; $expand?: 'none' | 'relations' | 'fields' | 'links' | 'all' }
            | undefined
          if (!args || !args.ids.includes(arg.id)) continue
          const patchResult = dispatch(
            adoApi.util.updateQueryData('batchGetWorkItems', args, (draft) => {
              const item = draft.find((w) => w.id === arg.id)
              if (!item) return
              for (const op of arg.patch) {
                if (op.op !== 'add' && op.op !== 'replace') continue
                if (!op.path.startsWith('/fields/')) continue
                const field = op.path.replace('/fields/', '')
                item.fields[field] = op.value as never
              }
            })
          )
          updates.push(() => patchResult.undo())
        }
        try {
          await queryFulfilled
        } catch {
          for (const undo of updates) undo()
        }
      },
      invalidatesTags: (_r, _e, arg) => [{ type: 'WorkItem' as const, id: arg.id }]
    }),

    fetchAttachment: build.query<
      { dataBase64: string; contentType: string },
      { url: string }
    >({
      query: (args) => ({ channel: IPC.AttachmentFetch, args }),
      // Attachment bytes don't change once published; let RTK Query keep
      // them around indefinitely so re-rendering the same description
      // doesn't re-fetch every image.
      keepUnusedDataFor: 24 * 60 * 60
    })
  })
})

export const {
  useGetConnectionQuery,
  useSetConnectionMutation,
  useClearConnectionMutation,
  useTestConnectionMutation,
  useListProjectsQuery,
  useListTeamsQuery,
  useListTeamMembersQuery,
  useListIterationsQuery,
  useListSavedQueriesQuery,
  useRunWiqlQuery,
  useRunSavedQueryQuery,
  useBatchGetWorkItemsQuery,
  useGetWorkItemWithRelationsQuery,
  usePatchWorkItemMutation,
  useFetchAttachmentQuery
} = adoApi
