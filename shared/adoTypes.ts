/**
 * Shared Azure DevOps domain types used by both the Electron main process
 * and the React renderer. These intentionally model only the slice of the
 * ADO REST surface this app needs.
 */

export type AdoFieldValue = string | number | boolean | null | AdoIdentity | undefined

export interface AdoIdentity {
  displayName: string
  uniqueName?: string
  id?: string
  imageUrl?: string
  descriptor?: string
}

export interface AdoProject {
  id: string
  name: string
  description?: string
  url: string
  state?: string
  visibility?: string
}

export interface AdoTeam {
  id: string
  name: string
  description?: string
  projectId?: string
  projectName?: string
}

export interface AdoTeamMember {
  identity: AdoIdentity
  isTeamAdmin?: boolean
}

export interface AdoIteration {
  id: string
  name: string
  path: string
  attributes?: {
    startDate?: string
    finishDate?: string
    timeFrame?: 'past' | 'current' | 'future'
  }
}

export interface AdoSavedQuery {
  id: string
  name: string
  path: string
  isFolder?: boolean
  hasChildren?: boolean
  children?: AdoSavedQuery[]
  queryType?: 'flat' | 'tree' | 'oneHop'
}

export type AdoRelationType =
  | 'System.LinkTypes.Hierarchy-Forward'
  | 'System.LinkTypes.Hierarchy-Reverse'
  | 'System.LinkTypes.Dependency-Forward'
  | 'System.LinkTypes.Dependency-Reverse'
  | 'System.LinkTypes.Related'
  | string

export interface AdoRelation {
  rel: AdoRelationType
  url: string
  attributes?: Record<string, AdoFieldValue>
  /** Populated when we resolve url -> id locally */
  targetId?: number
}

export interface AdoWorkItemFields {
  'System.Id'?: number
  'System.Title'?: string
  'System.WorkItemType'?: string
  'System.State'?: string
  'System.AssignedTo'?: AdoIdentity
  'System.IterationPath'?: string
  'System.AreaPath'?: string
  'System.Tags'?: string
  'System.CreatedDate'?: string
  'System.ChangedDate'?: string
  'System.Description'?: string
  'Microsoft.VSTS.Scheduling.StartDate'?: string
  'Microsoft.VSTS.Scheduling.TargetDate'?: string
  'Microsoft.VSTS.Scheduling.DueDate'?: string
  'Microsoft.VSTS.Scheduling.RemainingWork'?: number
  'Microsoft.VSTS.Scheduling.CompletedWork'?: number
  'Microsoft.VSTS.Common.Priority'?: number
  [key: string]: AdoFieldValue
}

export interface AdoWorkItem {
  id: number
  rev?: number
  url?: string
  fields: AdoWorkItemFields
  relations?: AdoRelation[]
}

export interface AdoWiqlLinkResult {
  rel: AdoRelationType | null
  source: { id: number } | null
  target: { id: number } | null
}

export interface AdoWiqlResult {
  queryType: 'flat' | 'tree' | 'oneHop'
  workItems?: { id: number; url?: string }[]
  workItemRelations?: AdoWiqlLinkResult[]
  asOf?: string
}

/**
 * A single comment / discussion entry on a work item. Mirrors the subset
 * of fields exposed by `_apis/wit/workItems/{id}/comments` that this app
 * actually renders. `text` is HTML — sanitize before injecting.
 */
export interface AdoComment {
  id: number
  workItemId?: number
  /** HTML body. Includes @-mention markup and inline images. */
  text: string
  createdDate?: string
  modifiedDate?: string
  createdBy?: AdoIdentity
  modifiedBy?: AdoIdentity
  /** Monotonic version that increments on edit; undefined for older comments. */
  version?: number
}

export type AdoJsonPatchOp = 'add' | 'replace' | 'remove' | 'test'

export interface AdoJsonPatch {
  op: AdoJsonPatchOp
  path: string
  value?: unknown
  from?: string
}

export interface AdoConnectionInfo {
  organizationUrl: string
  /** True if a PAT is currently stored in the encrypted vault. */
  hasToken: boolean
  /** Authenticated identity, populated after a successful probe. */
  authenticatedUser?: AdoIdentity
}

export interface AdoConnectionInput {
  organizationUrl: string
  personalAccessToken: string
}

/**
 * A single wiki registered against a project. Project wikis are auto-
 * provisioned by ADO; code wikis are git-backed and have a
 * `repositoryId` + `mappedPath` pointing at the repo root.
 */
export interface AdoWiki {
  id: string
  name: string
  type: 'projectWiki' | 'codeWiki' | string
  projectId: string
  repositoryId?: string
  mappedPath?: string
  url?: string
}

/**
 * A page in a wiki. The same shape is used both for a single-page fetch
 * (with `content` populated) and for the recursive page tree (where
 * `subPages` is filled by the server).
 */
export interface AdoWikiPage {
  id?: number
  path: string
  order?: number
  isParentPage?: boolean
  gitItemPath?: string
  content?: string
  url?: string
  /** Recursive child pages when fetched with recursionLevel=Full. */
  subPages?: AdoWikiPage[]
  /**
   * Server-supplied version tag for this page, used to drive the
   * `If-Match` header on subsequent `PUT` updates. ADO returns the
   * eTag in the `ETag` response header on both GET and PUT for wiki
   * pages — the main process pulls it off the raw response and
   * propagates it on the typed page object. Undefined when the page
   * was loaded via a path-tree call (which doesn't expose it).
   */
  eTag?: string
}

/**
 * A single hit returned by the ADO wiki search service. `highlights` are
 * server-supplied HTML fragments containing `<em>…</em>` markers around
 * the matched terms; the renderer sanitises before injecting.
 */
export interface AdoWikiSearchHit {
  fileName: string
  path: string
  hits: { fieldReferenceName: string; highlights: string[] }[]
  project: { id: string; name: string }
  wiki: { id: string; name: string }
  contentId?: string
}

/* ---------- git repositories ---------- */

/**
 * A single git repository inside a project. We keep the field set
 * deliberately small — the PR list only needs id + name to filter,
 * with `webUrl` and `defaultBranch` carried along for future UI bits.
 * `isDisabled` is included so the UI can grey-out repos that ADO has
 * marked as disabled (deleted-but-recoverable) without dropping them.
 */
export interface AdoGitRepository {
  id: string
  name: string
  defaultBranch?: string
  project: { id: string; name: string }
  webUrl?: string
  isDisabled?: boolean
}

/* ---------- pull requests ---------- */

/**
 * ADO REST exposes a richer PR identity record than the bare
 * `AdoIdentity` we use for work items. Reviewers carry a vote and a
 * couple of flags that drive the row's reviewer chip.
 */
export interface AdoPullRequestRef {
  id?: string
  displayName?: string
  uniqueName?: string
  imageUrl?: string
  descriptor?: string
}

/**
 * Vote semantics straight from ADO. Pinned to the literal numbers ADO
 * returns so the UI doesn't have to translate between names — the
 * reviewer-vote chip renders directly off these.
 *
 *  - `10`  → approved
 *  - `5`   → approved with suggestions
 *  - `0`   → no vote
 *  - `-5`  → waiting for author
 *  - `-10` → rejected
 */
export type AdoPullRequestVote = 10 | 5 | 0 | -5 | -10 | number

export interface AdoPullRequestReviewer extends AdoPullRequestRef {
  vote: AdoPullRequestVote
  isRequired?: boolean
  isFlagged?: boolean
  hasDeclined?: boolean
}

export interface AdoPullRequestRepository {
  id: string
  name: string
  /** Project the repo belongs to; needed to build the ADO web URL. */
  project: { id: string; name: string }
  url?: string
}

export type AdoPullRequestStatus =
  | 'active'
  | 'completed'
  | 'abandoned'
  | 'notSet'
  | 'all'
  | string

export type AdoPullRequestMergeStatus =
  | 'succeeded'
  | 'conflicts'
  | 'queued'
  | 'rejectedByPolicy'
  | 'failure'
  | 'notSet'
  | string

/**
 * Slice of the ADO pull-request payload this app actually consumes.
 * Mirrors `_apis/git/pullrequests` — fields the renderer doesn't read
 * (commits, completion options, labels, etc.) are intentionally
 * omitted to keep the IPC payload small.
 */
export interface AdoPullRequest {
  pullRequestId: number
  title: string
  description?: string
  status: AdoPullRequestStatus
  isDraft?: boolean
  createdBy: AdoPullRequestRef
  creationDate: string
  closedDate?: string
  /** e.g. `refs/heads/feature/foo`. */
  sourceRefName: string
  /** e.g. `refs/heads/main`. */
  targetRefName: string
  mergeStatus?: AdoPullRequestMergeStatus
  repository: AdoPullRequestRepository
  reviewers: AdoPullRequestReviewer[]
  /** Raw API URL of the PR — handy for debugging, not used by the UI. */
  url?: string
  _links?: Record<string, { href?: string }>
}

/**
 * One valid state for a given work-item type, as returned by ADO's
 * `_apis/wit/workitemtypes/{type}/states` endpoint.
 *
 * `category` is the most useful field for UX — it groups states into
 * coarse buckets (`Proposed` / `InProgress` / `Resolved` / `Completed`
 * / `Removed`) that survive process customisation, so the UI can
 * colour-code the popover entries even when an org has renamed the
 * underlying state names. `color` is ADO's own per-state hex (no `#`
 * prefix in the response) — currently unused by the renderer because
 * the category-based palette gives a more consistent look across
 * processes, but kept here for forward-compat.
 */
export interface AdoWorkItemTypeState {
  name: string
  color?: string
  category?:
    | 'Proposed'
    | 'InProgress'
    | 'Resolved'
    | 'Completed'
    | 'Removed'
    | string
}

export interface IpcError {
  code:
    | 'NOT_AUTHENTICATED'
    | 'BAD_REQUEST'
    | 'NETWORK'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'INTERNAL'
  message: string
  status?: number
  details?: unknown
}

/* ---------- pull request changes (v0.3.1: WhatsApp share) ---------- */

/**
 * One iteration of a pull request — ADO numbers iterations from 1 and
 * adds a new one each time the source branch is force-pushed or merged
 * into. We pull the *latest* iteration when summarising changes so the
 * file list reflects the PR's current diff rather than its first push.
 *
 * Mirrors `_apis/git/repositories/{repo}/pullRequests/{prId}/iterations`.
 * Only the bits the changes-summary feature actually consumes are
 * modelled here.
 */
export interface AdoPullRequestIteration {
  id: number
  description?: string
  createdDate?: string
  updatedDate?: string
}

/**
 * Normalised change-type for a single file in a pull request. ADO
 * returns this as a comma-separated string (`'edit'`,
 * `'delete,sourceRename'`, etc.); we collapse the variants the UI
 * cares about into a small enum and lump everything unrecognised under
 * `'other'` so a future ADO addition doesn't crash the row.
 *
 * `'sourceRename'` and `'targetRename'` both map to `'rename'`.
 */
export type AdoPullRequestChangeKind =
  | 'add'
  | 'edit'
  | 'delete'
  | 'rename'
  | 'other'

/**
 * One file's change record inside a PR iteration. The iteration-changes
 * REST endpoint does NOT include line counts (those live on the
 * heavier per-commit / diff endpoints) — `addedLines` / `deletedLines`
 * are therefore optional and currently always `undefined` in v0.3.1.
 * Marked here so the UI can already render line counts when a future
 * version starts populating them without another contract change.
 */
export interface AdoPullRequestChange {
  path: string
  changeType: AdoPullRequestChangeKind
  /** Reserved for a future polish — see `pullRequests.ts` TODO. */
  addedLines?: number
  /** Reserved for a future polish — see `pullRequests.ts` TODO. */
  deletedLines?: number
}

/**
 * Compact summary of every file touched by a PR's latest iteration.
 * Built in the main process so the renderer can format the share
 * message without a second round-trip. `totalAdded` / `totalDeleted`
 * are optional for the same reason `addedLines` is on the per-file
 * shape — they'll only land once line counts are wired in.
 */
export interface PullRequestChangesSummary {
  totalFiles: number
  totalAdded?: number
  totalDeleted?: number
  files: AdoPullRequestChange[]
}
