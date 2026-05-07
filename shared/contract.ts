/**
 * IPC contract between the Electron main process and the React renderer.
 *
 * Channels are namespaced as `<area>.<action>`. The renderer talks to the
 * main process exclusively through a single typed `invoke` function so the
 * preload bridge stays small and the contract stays in one file.
 */
import type {
  AdoComment,
  AdoConnectionInfo,
  AdoConnectionInput,
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
  AdoWorkItem
} from './adoTypes'

/**
 * Marker prefix used to smuggle structured `IpcError` payloads through
 * Electron's IPC error channel. Electron only preserves `Error` instances
 * across the main↔renderer boundary, so the main process throws an Error
 * whose `.message` is `IPC_ERROR_PREFIX + JSON.stringify(payload)`, and
 * the preload bridge parses it back into a plain object before rejecting
 * the renderer-side promise.
 */
export const IPC_ERROR_PREFIX = '__ADO_IPC_ERROR__:'

/* ---------- channel names ---------- */

export const IPC = {
  ConnectionGet: 'connection.get',
  ConnectionSet: 'connection.set',
  ConnectionClear: 'connection.clear',
  ConnectionTest: 'connection.test',

  ProjectsList: 'projects.list',
  TeamsList: 'teams.list',
  TeamMembersList: 'teams.members',
  IterationsList: 'iterations.list',
  SavedQueriesList: 'queries.list',

  WorkItemsRunWiql: 'workitems.runWiql',
  WorkItemsRunSavedQuery: 'workitems.runSavedQuery',
  WorkItemsBatchGet: 'workitems.batchGet',
  WorkItemsGetWithRelations: 'workitems.getWithRelations',
  WorkItemsPatch: 'workitems.patch',
  /**
   * For each work item id, return a small summary (timestamp, plain-text
   * snippet, author) of the latest comment whose text contains the
   * supplied search term — typically the signed-in user's display name.
   * Powers the Workspace's "Mentions me" tab so each row can show a
   * preview *and* sort by latest mention without a second round-trip.
   */
  WorkItemsLatestMentions: 'workitems.latestMentions',

  /**
   * Fetch every comment / discussion entry on a single work item, newest
   * first. Used by the right-pane drawer to surface the conversation
   * thread alongside the description.
   */
  WorkItemsListComments: 'workitems.listComments',

  /**
   * Fetch a binary asset (typically an inline image embedded in a work-item
   * description or comment) from the configured ADO organisation, using the
   * stored PAT for auth. Returned as a base64 string + mime type so the
   * renderer can swap it into an `<img src="data:...">` without exposing
   * credentials to the page or running into Chromium CORS.
   */
  AttachmentFetch: 'attachments.fetch',

  /** List the wikis registered against a given project. */
  WikiList: 'wiki.list',
  /**
   * Recursive page tree for one wiki — content is omitted to keep the
   * payload small; the renderer fetches body text on demand via WikiGetPage.
   */
  WikiPageTree: 'wiki.pageTree',
  /** Fetch a single wiki page (with content unless explicitly excluded). */
  WikiGetPage: 'wiki.getPage',
  /**
   * Server-side wiki search via ADO's Search extension. May 404 / 410 /
   * 401 against orgs without the extension installed; the renderer
   * detects that and falls back to client-side filtering.
   */
  WikiSearch: 'wiki.search',
  /**
   * Update a single wiki page's markdown body. Requires the most recent
   * page eTag (from a prior `WikiGetPage` or `WikiUpdatePage`) for
   * optimistic concurrency — ADO returns 412 if the eTag is stale, and
   * we surface that as `IpcError.code === 'CONFLICT'` so the renderer
   * can prompt the user to reload or overwrite.
   */
  WikiUpdatePage: 'wiki.updatePage',

  /**
   * Append a new comment / discussion entry to a single work item. The
   * payload is HTML (TipTap output, post-`serializeForAdo`) — ADO
   * accepts standard rich-text markup, including `@`-mention anchors of
   * the form `<a data-vss-mention="version:2.0,{descriptor}">@Name</a>`.
   */
  WorkItemAddComment: 'workitems.addComment',

  /**
   * Resolve a project's member identities for the comment composer's
   * `@`-mention picker. Server-side picks the project's *default team*
   * and lifts its members; the renderer merges in recent contributors
   * from the work item's existing comment history client-side, so this
   * channel intentionally returns just the project's broad member list
   * rather than per-work-item participants.
   */
  IdentitySearch: 'identity.search',

  ShellOpenExternal: 'shell.openExternal'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/* ---------- request payload types ---------- */

export interface ConnectionTestArgs {
  organizationUrl: string
  personalAccessToken: string
}

export interface ListProjectsArgs {
  /** Override stored organizationUrl, e.g. when probing during connect flow. */
  organizationUrl?: string
}

export interface ListTeamsArgs {
  projectId: string
}

export interface ListTeamMembersArgs {
  projectId: string
  teamId: string
}

export interface ListIterationsArgs {
  projectId: string
  teamId?: string
  /** 'current' filters to current iteration; omit for all. */
  timeframe?: 'current'
}

export interface ListSavedQueriesArgs {
  projectId: string
  /** Folder depth to expand. Default 2. */
  depth?: number
}

export interface RunWiqlArgs {
  projectId: string
  teamId?: string
  wiql: string
  /** Cap returned ids (ADO returns up to 20000). Default 1000. */
  top?: number
}

export interface RunSavedQueryArgs {
  projectId: string
  queryId: string
  teamId?: string
  top?: number
}

export interface BatchGetWorkItemsArgs {
  projectId?: string
  ids: number[]
  /** Fields to retrieve. If omitted, a sensible default field set is used. */
  fields?: string[]
  /** Pass 'relations' to also pull link relations (slower, omit for big lists). */
  $expand?: 'none' | 'relations' | 'fields' | 'links' | 'all'
  asOf?: string
}

export interface GetWorkItemWithRelationsArgs {
  projectId?: string
  id: number
}

export interface PatchWorkItemArgs {
  projectId?: string
  id: number
  patch: AdoJsonPatch[]
  /** Bypass server validation rules. */
  bypassRules?: boolean
}

export interface ShellOpenExternalArgs {
  url: string
}

export interface LatestMentionsArgs {
  projectId: string
  ids: number[]
  /** Substring to look for in each comment's text. Case-insensitive. */
  searchText: string
}

export interface MentionSummary {
  /** ISO timestamp of the matching comment. */
  date: string
  /**
   * Plain-text excerpt of the matching comment (HTML stripped, whitespace
   * collapsed, truncated). Suitable for inline preview in lists.
   */
  snippet: string
  /** Display name of whoever posted the comment, when available. */
  author?: string
}

export interface LatestMentionsResult {
  /** Map keyed by work-item id → summary of the latest matching comment. */
  byId: Record<number, MentionSummary | null>
}

export interface ListCommentsArgs {
  projectId: string
  id: number
}

export interface ListCommentsResult {
  /** Newest-first. Empty when the item has no discussion yet. */
  comments: AdoComment[]
}

export interface AttachmentFetchArgs {
  /** Absolute URL pointing at the configured ADO organisation host. */
  url: string
}

export interface AttachmentFetchResult {
  /** Base64-encoded binary contents (no `data:` prefix). */
  dataBase64: string
  /** Response MIME type, e.g. `image/png`. Defaults to `application/octet-stream`. */
  contentType: string
}

export interface ListWikisArgs {
  projectId: string
}

export interface GetWikiPageTreeArgs {
  projectId: string
  wikiId: string
}

export interface GetWikiPageArgs {
  projectId: string
  wikiId: string
  /** Page path, e.g. `/Architecture/Overview`. Should start with '/'. */
  path: string
  /** Default true — set false for a metadata-only page lookup. */
  includeContent?: boolean
}

export interface SearchWikiArgs {
  projectId: string
  /** Free-text search term. ADO will tokenise. */
  term: string
  /** Page size, default 50. */
  top?: number
  /** Pagination offset, default 0. */
  skip?: number
}

export interface SearchWikiResult {
  count: number
  results: AdoWikiSearchHit[]
}

export interface UpdateWikiPageArgs {
  projectId: string
  wikiId: string
  /** Page path, e.g. `/Architecture/Overview`. Should start with '/'. */
  path: string
  /** Full new markdown body. Replaces the page content wholesale. */
  content: string
  /**
   * Most recent eTag for this page, returned by `WikiGetPage` or a prior
   * `WikiUpdatePage`. Sent as `If-Match` so ADO can reject the write
   * with 412 when someone else updated the page in the meantime. When
   * omitted, the request is sent with `If-Match: *` (force-overwrite) —
   * use only after a deliberate conflict-resolution flow.
   */
  eTag?: string
}

export interface UpdateWikiPageResult {
  /**
   * The updated page metadata (path, id, eTag etc). The fresh eTag is
   * the important bit — the renderer stashes it for the next save so
   * sequential edits don't trigger the conflict dialog every time.
   */
  page: AdoWikiPage
  /**
   * Echo of the content that was committed. Useful for reconciling
   * client state after a successful overwrite without a follow-up GET.
   */
  content: string
}

export interface AddWorkItemCommentArgs {
  projectId: string
  /** Numeric work-item id the comment is being attached to. */
  workItemId: number
  /**
   * HTML body. The renderer is expected to have already rewritten any
   * mention markup into ADO's `data-vss-mention` anchor form and
   * sanitised the output before invocation; we don't re-sanitise here.
   */
  htmlText: string
}

export interface AddWorkItemCommentResult {
  /** The newly-persisted comment as ADO returned it (with id, dates). */
  comment: AdoComment
}

export interface IdentitySearchArgs {
  projectId: string
}

export interface IdentitySearchResult {
  /**
   * Project-team members whose identities can be `@`-mentioned. Sourced
   * from the project's default team for breadth — the renderer dedupes
   * and merges in recent contributors from the open work item locally.
   */
  identities: AdoIdentity[]
}

/* ---------- channel signature map (request -> response) ---------- */

export interface IpcSignatures {
  [IPC.ConnectionGet]: { args: void; result: AdoConnectionInfo }
  [IPC.ConnectionSet]: { args: AdoConnectionInput; result: AdoConnectionInfo }
  [IPC.ConnectionClear]: { args: void; result: { ok: true } }
  [IPC.ConnectionTest]: { args: ConnectionTestArgs; result: AdoConnectionInfo }

  [IPC.ProjectsList]: { args: ListProjectsArgs | void; result: AdoProject[] }
  [IPC.TeamsList]: { args: ListTeamsArgs; result: AdoTeam[] }
  [IPC.TeamMembersList]: { args: ListTeamMembersArgs; result: AdoTeamMember[] }
  [IPC.IterationsList]: { args: ListIterationsArgs; result: AdoIteration[] }
  [IPC.SavedQueriesList]: { args: ListSavedQueriesArgs; result: AdoSavedQuery[] }

  [IPC.WorkItemsRunWiql]: { args: RunWiqlArgs; result: AdoWiqlResult }
  [IPC.WorkItemsRunSavedQuery]: { args: RunSavedQueryArgs; result: AdoWiqlResult }
  [IPC.WorkItemsBatchGet]: { args: BatchGetWorkItemsArgs; result: AdoWorkItem[] }
  [IPC.WorkItemsGetWithRelations]: {
    args: GetWorkItemWithRelationsArgs
    result: AdoWorkItem
  }
  [IPC.WorkItemsPatch]: { args: PatchWorkItemArgs; result: AdoWorkItem }
  [IPC.WorkItemsLatestMentions]: {
    args: LatestMentionsArgs
    result: LatestMentionsResult
  }
  [IPC.WorkItemsListComments]: {
    args: ListCommentsArgs
    result: ListCommentsResult
  }

  [IPC.AttachmentFetch]: { args: AttachmentFetchArgs; result: AttachmentFetchResult }

  [IPC.WikiList]: { args: ListWikisArgs; result: AdoWiki[] }
  [IPC.WikiPageTree]: { args: GetWikiPageTreeArgs; result: AdoWikiPage }
  [IPC.WikiGetPage]: { args: GetWikiPageArgs; result: AdoWikiPage }
  [IPC.WikiSearch]: { args: SearchWikiArgs; result: SearchWikiResult }
  [IPC.WikiUpdatePage]: {
    args: UpdateWikiPageArgs
    result: UpdateWikiPageResult
  }

  [IPC.WorkItemAddComment]: {
    args: AddWorkItemCommentArgs
    result: AddWorkItemCommentResult
  }
  [IPC.IdentitySearch]: {
    args: IdentitySearchArgs
    result: IdentitySearchResult
  }

  [IPC.ShellOpenExternal]: { args: ShellOpenExternalArgs; result: { ok: true } }
}

export type IpcArgs<C extends IpcChannel> = IpcSignatures[C]['args']
export type IpcResult<C extends IpcChannel> = IpcSignatures[C]['result']

/* ---------- bridge surface exposed on window ---------- */

export interface AdoBridge {
  invoke<C extends IpcChannel>(channel: C, args?: IpcArgs<C>): Promise<IpcResult<C>>
  /** Listen for unsolicited events from main (e.g. token cleared). */
  on(event: 'connection-changed', handler: (info: AdoConnectionInfo) => void): () => void
}

declare global {
  interface Window {
    ado: AdoBridge
  }
}
