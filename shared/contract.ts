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
  AdoGitRepository,
  AdoIdentity,
  AdoIteration,
  AdoJsonPatch,
  AdoProject,
  AdoPullRequest,
  AdoSavedQuery,
  AdoTeam,
  AdoTeamMember,
  AdoWiki,
  AdoWikiPage,
  AdoWikiSearchHit,
  AdoWiqlResult,
  AdoWorkItem,
  AdoWorkItemTypeState,
  PullRequestChangesSummary
} from './adoTypes'
import type {
  ClaudeCliAvailableResult,
  GenerateJournalArgs,
  GenerateJournalResult,
  GetSessionArgs,
  GetStatsArgs,
  ListSessionsArgs,
  OpenInTerminalArgs,
  OpenInTerminalResult,
  PickDirectoryArgs,
  PickDirectoryResult,
  RescanIndexResult,
  SessionDetail,
  SessionMeta,
  StartInTerminalArgs,
  StartInTerminalResult,
  StatsBucket,
  SummarizeSessionArgs,
  SummarizeSessionResult
} from './claudeTypes'

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
   * Valid `System.State` values for a given work-item type within a
   * project. Backed by `_apis/wit/workitemtypes/{type}/states`. Used
   * by the drawer's clickable state pill to populate its popover so
   * the user can pick from real, process-customised next states (not
   * a hard-coded list) — and so we can colour each option by its
   * stable ADO category. Cached 1 hour in main per (project,type)
   * because the state list rarely changes mid-session.
   */
  WorkItemTypeStates: 'workitems.typeStates',
  /**
   * Project-wide tag suggestions for the work-item drawer's tag
   * editor. ADO maintains a single tags collection per project (every
   * tag ever applied to any work item shows up); we surface those
   * names alphabetised and de-duped so the multi-select Autocomplete
   * can suggest existing tags before letting the user free-type a
   * brand-new one. Cached 5 minutes in main — fresh enough to pick
   * up tags created elsewhere in a session, slow enough to avoid
   * round-tripping every time a drawer opens.
   */
  ProjectTagsList: 'project.tags.list',
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
   * rather than per-work-item participants. Used to seed the picker
   * before the user has typed anything.
   */
  IdentitySearch: 'identity.search',

  /**
   * Live identity search across the org, scoped by the project. Backed
   * by ADO's `IdentityPicker/Identities` endpoint — the same one
   * ADO web uses for its own `@`-mention popups. The picker calls this
   * (debounced) every time the user types after `@`, so the result
   * set isn't limited to the default team's roster.
   */
  IdentitySearchByQuery: 'identity.searchByQuery',

  /**
   * List git repositories in a project. Used by the PR list's repo
   * filter. ADO also exposes per-repo branch / refs endpoints under
   * the same `_apis/git/repositories/...` prefix; we deliberately
   * stop at the project-level list here — additional surface lands
   * with phase-2 features.
   */
  GitRepositoriesList: 'git.repositories.list',

  /**
   * List pull requests in a project, with optional status / creator /
   * reviewer / repository filters. Backed by ADO's
   * `_apis/git/pullrequests` (project-wide) or
   * `_apis/git/repositories/{repo}/pullrequests` (repo-scoped) — see
   * `ListPullRequestsArgs.repositoryId` for the toggle.
   */
  PullRequestsList: 'pullRequests.list',

  /**
   * Async read of the entire preferences blob — kept for symmetry /
   * future use, but the slice init path actually uses
   * `PreferencesReadSync` (see below) so the renderer can hydrate
   * synchronously at module-load time. The async variant is the one
   * registered via `ipcMain.handle`.
   */
  PreferencesRead: 'preferences.read',
  /**
   * Synchronous read of the entire preferences blob. Registered with
   * `ipcMain.on` (NOT `ipcMain.handle`) so the renderer's slice
   * initializers can call it via `ipcRenderer.sendSync` and stay
   * synchronous — the only place in this app where sync IPC is
   * appropriate. See `electron/preload.ts` for the rationale.
   */
  PreferencesReadSync: 'preferences.read.sync',
  /**
   * Per-slice preferences write. The main process replaces only the
   * named slice key in the on-disk JSON blob and atomically rewrites
   * the file, so a write to one slice never rolls back another's
   * concurrent change. Fire-and-forget from the renderer's POV.
   */
  PreferencesWrite: 'preferences.write',

  ShellOpenExternal: 'shell.openExternal',

  /* ---------- v0.3.1 additions (WhatsApp share on PR rows) ---------- */
  // Appended at the bottom so a parallel branch (system tray + 1-min
  // poll notifications) can add `NotificationOpenTarget` here without
  // colliding line-by-line. Keep new v0.3.1 channels in this delimited
  // block until the merge settles.
  /**
   * Per-PR file-change summary used by the WhatsApp-share dialog to
   * compose a "Please review when free" message with a quick rundown
   * of the diff. Backed by ADO's pull-request iteration-changes
   * endpoint; cached on the same key the existing `PullRequestsList`
   * cache uses so toggling the dialog open / shut for the same PR
   * doesn't re-hit the network.
   */
  GitPullRequestChanges: 'git.pr.changes',

  /* ---------- Claude session tracker ---------- */
  ClaudeListSessions: 'claude.listSessions',
  ClaudeGetSession: 'claude.getSession',
  ClaudeGetStats: 'claude.getStats',
  ClaudeSummarizeSession: 'claude.summarizeSession',
  ClaudeGenerateJournal: 'claude.generateJournal',
  ClaudeRescanIndex: 'claude.rescanIndex',
  ClaudeCliAvailable: 'claude.cliAvailable',
  ClaudeOpenInTerminal: 'claude.openInTerminal',
  ClaudeStartInTerminal: 'claude.startInTerminal',
  ClaudePickDirectory: 'claude.pickDirectory'
} as const

/**
 * Union of every async-invoke channel name. Derived from `IpcSignatures`
 * (NOT from `typeof IPC` directly) so any sync-only channels like
 * `IPC.PreferencesReadSync` — which travel via `ipcRenderer.sendSync`
 * and intentionally aren't part of the typed `invoke` map — are
 * excluded. This keeps `bridge.invoke(channel, args)` from compiling
 * for channels that wouldn't actually work over `invoke`.
 */
export type IpcChannel = keyof IpcSignatures

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

export interface GetWorkItemTypeStatesArgs {
  projectId: string
  /** e.g. `Bug`, `Task`, `Product Backlog Item`. */
  workItemType: string
}

export interface GetWorkItemTypeStatesResult {
  states: AdoWorkItemTypeState[]
}

export interface ListProjectTagsArgs {
  projectId: string
}

export interface ListProjectTagsResult {
  /** Just the tag names, sorted alphabetically (case-insensitive), deduped. */
  tags: string[]
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

export interface IdentitySearchByQueryArgs {
  /** Org-wide search; project context only used for cache scoping. */
  projectId: string
  /** Free-text query the user typed after `@`. */
  query: string
  /** Hard cap on results returned (default 25). */
  top?: number
}

export interface ListPullRequestsArgs {
  projectId: string
  /**
   * Defaults to `'active'` server-side. `'all'` returns active +
   * completed + abandoned; useful for the "All" status segment in the
   * UI without three separate fetches.
   */
  status?: 'active' | 'completed' | 'abandoned' | 'all'
  /** ADO identity id (GUID) — server-side `searchCriteria.creatorId`. */
  creatorId?: string
  /** ADO identity id (GUID) — server-side `searchCriteria.reviewerId`. */
  reviewerId?: string
  /**
   * When set, the main process hits the *repo-scoped* endpoint
   * (`/_apis/git/repositories/{id}/pullrequests`) instead of the
   * project-wide one. ADO's project-wide endpoint does not accept
   * `searchCriteria.repositoryId`, so this toggle is the right way
   * to filter by a single repository.
   */
  repositoryId?: string
  /** Cap returned rows. Default 100. */
  top?: number
}

export interface ListPullRequestsResult {
  pullRequests: AdoPullRequest[]
}

export interface ListRepositoriesArgs {
  projectId: string
}

export interface ListRepositoriesResult {
  repositories: AdoGitRepository[]
}

/**
 * Empty args for the preferences read channels. The store returns the
 * entire blob in one shot — slices pick out their own key.
 */
export type ReadPreferencesArgs = void

export interface ReadPreferencesResult {
  /**
   * Top-level keys are slice names (e.g. `preferences`,
   * `recentSearches`, `favorites`); values are whatever each slice
   * persisted. Renderers must treat unknown shapes defensively.
   */
  data: Record<string, unknown>
}

export interface WritePreferencesArgs {
  sliceName: string
  sliceState: unknown
}

export interface WritePreferencesResult {
  ok: true
}

export interface IdentitySearchByQueryResult {
  /** Raw identities as returned by ADO's IdentityPicker, mapped onto
   *  `AdoIdentity`. The renderer is responsible for sorting / merging
   *  with recent contributors and de-duping. */
  identities: AdoIdentity[]
  /** The query echo from ADO; useful for ignoring stale responses if
   *  the user has typed past this query by the time it returns. */
  queryEcho: string
}

/* ---------- v0.3.1 additions (WhatsApp share on PR rows) ---------- */
// Appended at the bottom so the parallel tray-notifications branch can
// add its own payload types here without three-way merge pain.

export interface GetPullRequestChangesArgs {
  projectId: string
  repositoryId: string
  pullRequestId: number
}

export interface GetPullRequestChangesResult {
  summary: PullRequestChangesSummary
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
  [IPC.WorkItemTypeStates]: {
    args: GetWorkItemTypeStatesArgs
    result: GetWorkItemTypeStatesResult
  }
  [IPC.ProjectTagsList]: {
    args: ListProjectTagsArgs
    result: ListProjectTagsResult
  }
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
  [IPC.IdentitySearchByQuery]: {
    args: IdentitySearchByQueryArgs
    result: IdentitySearchByQueryResult
  }

  [IPC.GitRepositoriesList]: {
    args: ListRepositoriesArgs
    result: ListRepositoriesResult
  }

  [IPC.PullRequestsList]: {
    args: ListPullRequestsArgs
    result: ListPullRequestsResult
  }

  [IPC.PreferencesRead]: { args: ReadPreferencesArgs; result: ReadPreferencesResult }
  [IPC.PreferencesWrite]: { args: WritePreferencesArgs; result: WritePreferencesResult }

  [IPC.ShellOpenExternal]: { args: ShellOpenExternalArgs; result: { ok: true } }

  /* ---- v0.3.1 additions (WhatsApp share on PR rows) ---- */
  [IPC.GitPullRequestChanges]: {
    args: GetPullRequestChangesArgs
    result: GetPullRequestChangesResult
  }

  /* ---- Claude session tracker ---- */
  [IPC.ClaudeListSessions]: { args: ListSessionsArgs; result: SessionMeta[] }
  [IPC.ClaudeGetSession]: { args: GetSessionArgs; result: SessionDetail }
  [IPC.ClaudeGetStats]: { args: GetStatsArgs; result: StatsBucket[] }
  [IPC.ClaudeSummarizeSession]: {
    args: SummarizeSessionArgs
    result: SummarizeSessionResult
  }
  [IPC.ClaudeGenerateJournal]: {
    args: GenerateJournalArgs
    result: GenerateJournalResult
  }
  [IPC.ClaudeRescanIndex]: {
    args: Record<string, never>
    result: RescanIndexResult
  }
  [IPC.ClaudeCliAvailable]: {
    args: Record<string, never>
    result: ClaudeCliAvailableResult
  }
  [IPC.ClaudeOpenInTerminal]: {
    args: OpenInTerminalArgs
    result: OpenInTerminalResult
  }
  [IPC.ClaudeStartInTerminal]: {
    args: StartInTerminalArgs
    result: StartInTerminalResult
  }
  [IPC.ClaudePickDirectory]: {
    args: PickDirectoryArgs
    result: PickDirectoryResult
  }
}

export type IpcArgs<C extends IpcChannel> = IpcSignatures[C]['args']
export type IpcResult<C extends IpcChannel> = IpcSignatures[C]['result']

/* ---------- bridge surface exposed on window ---------- */

/**
 * Synchronous-read + async-write surface over the disk-backed
 * preferences store. The synchronous read is intentional and lets
 * Redux slice initializers stay synchronous (matching the prior
 * `localStorage`-based behaviour) — see `electron/preload.ts`.
 */
export interface PreferencesBridge {
  /**
   * Returns the entire preferences blob as a plain object. Callers
   * pluck out their own slice key. Synchronous because slice
   * `createSlice({ initialState: load() })` calls run at module import
   * time and going async there would require restructuring every
   * slice.
   */
  readSync(): ReadPreferencesResult
  /** Persist a single slice's state. Fire-and-forget. */
  write(sliceName: string, sliceState: unknown): Promise<WritePreferencesResult>
}

export interface AdoBridge {
  invoke<C extends IpcChannel>(channel: C, args?: IpcArgs<C>): Promise<IpcResult<C>>
  /** Listen for unsolicited events from main (e.g. token cleared). */
  on(event: 'connection-changed', handler: (info: AdoConnectionInfo) => void): () => void
  /**
   * Listen for a "deep-link" push from main when the user clicks a
   * native notification, picks a tray menu item, etc. The renderer
   * should focus the right page and (where possible) drill into the
   * targeted PR or work item. This event is renderer-bound (main →
   * renderer) and intentionally lives outside `IpcSignatures` so it
   * doesn't leak into the typed `invoke` map.
   */
  on(event: 'open-target', handler: (target: NotificationOpenTarget) => void): () => void
  /** Disk-backed preferences store; replaces localStorage for persisted state. */
  preferences: PreferencesBridge
  /**
   * Operating system reported by the Electron main process. Exposed so
   * the renderer can show platform-appropriate options (e.g. PowerShell on
   * Windows vs Terminal.app on macOS) without round-tripping an IPC.
   * Type matches Node's `NodeJS.Platform` but inlined here so the renderer
   * tsconfig doesn't need @types/node in scope.
   */
  platform:
    | 'aix'
    | 'android'
    | 'darwin'
    | 'freebsd'
    | 'haiku'
    | 'linux'
    | 'openbsd'
    | 'sunos'
    | 'win32'
    | 'cygwin'
    | 'netbsd'
}

declare global {
  interface Window {
    ado: AdoBridge
  }
}

/* ==========================================================================
 *  v0.3.1 — tray + 1-min poll notifications
 *  --------------------------------------------------------------------------
 *  Additions live in their own block at the bottom of the file so they
 *  cleanly merge with parallel work that is also appending to this file
 *  (notably the WhatsApp-share branch's `IPC.GitPullRequestChanges`
 *  channel). Both blocks are append-only — keep your additions inside
 *  the marker comments so a three-way merge resolves automatically.
 * ========================================================================== */

/**
 * Renderer-bound IPC event names for v0.3.1. These travel as one-way
 * `webContents.send` pushes — they are NOT registered with
 * `ipcMain.handle` and intentionally don't appear in `IpcSignatures`
 * (which only types `invoke`-style request/response channels).
 *
 * Kept as standalone exports rather than added to the `IPC` object
 * above so this whole v0.3.1 block stays append-only and merges cleanly
 * with the parallel `IPC.GitPullRequestChanges` addition.
 */
export const RENDERER_EVENT = {
  /** Main → renderer: open a specific PR / work item / Home tab. */
  NotificationOpenTarget: 'open-target'
} as const

/**
 * Renderer-bound deep-link push from the main process. Sent when:
 *   - The user clicks a native desktop notification fired by the
 *     background poller (PR awaiting review / new @-mention).
 *   - The user picks an "Open Pull Requests" / "Open Mentions" item
 *     from the tray menu.
 *
 * The payload describes *what* to open; the renderer is responsible
 * for routing + selecting + opening drawers as best-effort. If the
 * project isn't currently selected, the renderer should still navigate
 * to /home and let the user pick — the open is never blocked on
 * reconciling project state.
 */
export type NotificationOpenTarget =
  | {
      kind: 'pr'
      /** ADO numeric PR id. */
      id: number
      projectId: string
      repositoryId?: string
    }
  | {
      kind: 'workItem'
      /** ADO numeric work-item id. */
      id: number
      projectId: string
    }
  | {
      /** Tray-menu jump that doesn't carry a single record id. */
      kind: 'tab'
      /** Which Home tab to surface. */
      tab: 'pullRequests' | 'mentions'
    }

