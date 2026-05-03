/**
 * IPC contract between the Electron main process and the React renderer.
 *
 * Channels are namespaced as `<area>.<action>`. The renderer talks to the
 * main process exclusively through a single typed `invoke` function so the
 * preload bridge stays small and the contract stays in one file.
 */
import type {
  AdoConnectionInfo,
  AdoConnectionInput,
  AdoIteration,
  AdoJsonPatch,
  AdoProject,
  AdoSavedQuery,
  AdoTeam,
  AdoTeamMember,
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
   * Fetch a binary asset (typically an inline image embedded in a work-item
   * description or comment) from the configured ADO organisation, using the
   * stored PAT for auth. Returned as a base64 string + mime type so the
   * renderer can swap it into an `<img src="data:...">` without exposing
   * credentials to the page or running into Chromium CORS.
   */
  AttachmentFetch: 'attachments.fetch',

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

  [IPC.AttachmentFetch]: { args: AttachmentFetchArgs; result: AttachmentFetchResult }

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
