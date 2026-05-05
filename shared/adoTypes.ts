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
