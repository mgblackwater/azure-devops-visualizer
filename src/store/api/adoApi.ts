import {
  createApi,
  type BaseQueryFn,
  type FetchBaseQueryError
} from '@reduxjs/toolkit/query/react'
import {
  IPC,
  type GetPullRequestChangesArgs,
  type GetPullRequestChangesResult,
  type IpcArgs,
  type IpcChannel,
  type ListPullRequestsArgs,
  type ListPullRequestsResult,
  type ListRepositoriesArgs,
  type ListRepositoriesResult,
  type UpdateWikiPageResult
} from '@shared/contract'
import type {
  AdoComment,
  AdoConnectionInfo,
  AdoIdentity,
  AdoIteration,
  AdoJsonPatch,
  AdoProject,
  AdoSavedQuery,
  AdoTeam,
  AdoTeamMember,
  AdoWiki,
  AdoWikiPage,
  AdoWikiSearchHit,
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
  tagTypes: [
    'Connection',
    'Projects',
    'Teams',
    'Iterations',
    'SavedQueries',
    'WorkItems',
    'WorkItem',
    'Wikis',
    'WikiPage',
    'PullRequest',
    'GitRepository',
    'PullRequestChanges'
  ],
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
    }),

    /**
     * For a list of work-item ids, return a small summary (timestamp,
     * snippet, author) of the latest comment whose text contains
     * `searchText` — typically the user's display name. Used by the
     * Workspace "Mentions me" tab to both sort by latest mention and
     * preview the matching comment inline without a follow-up fetch.
     */
    getLatestMentions: build.query<
      {
        byId: Record<
          number,
          { date: string; snippet: string; author?: string } | null
        >
      },
      { projectId: string; ids: number[]; searchText: string }
    >({
      query: (args) => ({ channel: IPC.WorkItemsLatestMentions, args }),
      // Comments don't churn at sub-minute granularity; a short cache
      // window keeps the UI snappy when the user toggles tabs.
      keepUnusedDataFor: 60
    }),

    /**
     * All comments on a single work item, newest first. Used by the
     * drawer's Discussion section. Cached briefly so flipping between
     * Details/Edit tabs in the drawer doesn't re-hit the network.
     */
    listWorkItemComments: build.query<
      { comments: AdoComment[] },
      { projectId: string; id: number }
    >({
      query: (args) => ({ channel: IPC.WorkItemsListComments, args }),
      keepUnusedDataFor: 60,
      providesTags: (_r, _e, arg) => [{ type: 'WorkItem' as const, id: arg.id }]
    }),

    /**
     * Wikis registered against the project. ADO returns project wikis and
     * any code wikis that share the project. Cached briefly via the main
     * process — re-listing on every page nav would be wasteful.
     */
    listWikis: build.query<AdoWiki[], { projectId: string }>({
      query: (args) => ({ channel: IPC.WikiList, args }),
      providesTags: ['Wikis']
    }),

    /**
     * Recursive page tree for one wiki, content omitted. Drives the
     * sidebar expander.
     */
    getWikiPageTree: build.query<
      AdoWikiPage,
      { projectId: string; wikiId: string }
    >({
      query: (args) => ({ channel: IPC.WikiPageTree, args }),
      keepUnusedDataFor: 60
    }),

    /** Body of a single wiki page (markdown). Cached so back/forward in
     *  the tree doesn't hit the network. The page is also tagged with
     *  a `WikiPage` id keyed by `wikiId:path` so that the update
     *  mutation can invalidate exactly this entry — invalidating only
     *  by string tag would refetch every wiki page the renderer has
     *  ever loaded, which is wasteful when the user only edited one. */
    getWikiPage: build.query<
      AdoWikiPage,
      { projectId: string; wikiId: string; path: string }
    >({
      query: (args) => ({ channel: IPC.WikiGetPage, args }),
      keepUnusedDataFor: 60,
      providesTags: (_result, _err, arg) => [
        { type: 'WikiPage' as const, id: `${arg.wikiId}:${arg.path}` }
      ]
    }),

    /**
     * Replace the markdown body of a wiki page. Requires the most
     * recent eTag (lifted off the GET response by the main process)
     * for optimistic concurrency — a stale eTag surfaces as a
     * `CONFLICT` IpcError so the WikiPage view can prompt for reload-
     * or-overwrite. On success the matching `WikiPage` tag is
     * invalidated so any subscribed `getWikiPage` query refetches the
     * fresh content automatically.
     */
    updateWikiPage: build.mutation<
      UpdateWikiPageResult,
      {
        projectId: string
        wikiId: string
        path: string
        content: string
        eTag?: string
      }
    >({
      query: (args) => ({ channel: IPC.WikiUpdatePage, args }),
      invalidatesTags: (_result, _err, arg) => [
        { type: 'WikiPage' as const, id: `${arg.wikiId}:${arg.path}` }
      ]
    }),

    /**
     * Server-side wiki search. May reject with `NOT_FOUND` when the org
     * doesn't have the Search extension installed — UI handles that
     * gracefully by falling back to client-side substring filter.
     */
    searchWiki: build.query<
      { count: number; results: AdoWikiSearchHit[] },
      { projectId: string; term: string; top?: number }
    >({
      query: (args) => ({ channel: IPC.WikiSearch, args }),
      keepUnusedDataFor: 30
    }),

    /**
     * Append a new comment to a work item. Invalidates the matching
     * `WorkItem` tag so a subscribed `listWorkItemComments` query
     * refetches and the drawer's discussion list shows the new entry
     * without the user manually refreshing.
     */
    addWorkItemComment: build.mutation<
      { comment: AdoComment },
      { projectId: string; workItemId: number; htmlText: string }
    >({
      query: (args) => ({ channel: IPC.WorkItemAddComment, args }),
      invalidatesTags: (_r, _e, arg) => [
        { type: 'WorkItem' as const, id: arg.workItemId }
      ]
    }),

    /**
     * Project member identities for the comment composer's `@`-mention
     * picker. Members rarely change, so we let RTK Query keep the
     * payload around generously — the main process also caches the
     * underlying ADO calls aggressively.
     */
    getProjectMembers: build.query<
      { identities: AdoIdentity[] },
      { projectId: string }
    >({
      query: (args) => ({ channel: IPC.IdentitySearch, args }),
      keepUnusedDataFor: 60 * 60
    }),

    /**
     * Live identity search across the org for the comment composer's
     * `@`-mention picker. Results are de-duped and merged with recent
     * contributors / project-members on the renderer side; this query
     * deliberately doesn't sort or filter so the merge there is free
     * to apply its own ordering.
     */
    searchIdentitiesByQuery: build.query<
      { identities: AdoIdentity[]; queryEcho: string },
      { projectId: string; query: string; top?: number }
    >({
      query: (args) => ({ channel: IPC.IdentitySearchByQuery, args }),
      keepUnusedDataFor: 60
    }),

    /**
     * Pull requests in a project, with optional status / Mine /
     * Reviewer / repository filters applied server-side. The main
     * process caches each unique filter combination briefly; the
     * renderer cache adds an extra layer so toggling filter chips
     * back-and-forth doesn't round-trip after the first hit.
     */
    listPullRequests: build.query<ListPullRequestsResult, ListPullRequestsArgs>({
      query: (args) => ({ channel: IPC.PullRequestsList, args }),
      providesTags: ['PullRequest'],
      keepUnusedDataFor: 30
    }),

    /**
     * Git repositories in a project. Powers the PR list's repo
     * filter; cached aggressively (5 min) since repos change rarely
     * and the dropdown wants to feel instant. Main-process cache
     * matches the same TTL so a project switch + return is free.
     */
    listRepositories: build.query<ListRepositoriesResult, ListRepositoriesArgs>({
      query: (args) => ({ channel: IPC.GitRepositoriesList, args }),
      providesTags: ['GitRepository'],
      keepUnusedDataFor: 300
    }),

    /**
     * File-change summary for a single PR's latest iteration. Backs
     * the WhatsApp-share dialog's "Include details" toggle — fired
     * lazily (`skip: !showDetails`) so opening the dialog doesn't
     * round-trip until the user actually asks for the file list.
     *
     * Cached for five minutes to match the main-process cache: the
     * iteration id is stable until a new push lands, and the dialog's
     * close-and-reopen flow shouldn't re-hit the network in that
     * window. Tagged so a future "refresh PR" mutation can invalidate
     * just this slice.
     */
    getPullRequestChangesSummary: build.query<
      GetPullRequestChangesResult,
      GetPullRequestChangesArgs
    >({
      query: (args) => ({ channel: IPC.GitPullRequestChanges, args }),
      providesTags: ['PullRequestChanges'],
      keepUnusedDataFor: 300
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
  useFetchAttachmentQuery,
  useGetLatestMentionsQuery,
  useListWorkItemCommentsQuery,
  useListWikisQuery,
  useGetWikiPageTreeQuery,
  useGetWikiPageQuery,
  useSearchWikiQuery,
  useUpdateWikiPageMutation,
  useAddWorkItemCommentMutation,
  useGetProjectMembersQuery,
  useSearchIdentitiesByQueryQuery,
  useListPullRequestsQuery,
  useListRepositoriesQuery,
  useGetPullRequestChangesSummaryQuery
} = adoApi
