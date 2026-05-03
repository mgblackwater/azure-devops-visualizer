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
