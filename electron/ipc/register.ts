import type { BrowserWindow, IpcMain } from 'electron'
import { shell } from 'electron'
import { IPC, IPC_ERROR_PREFIX, type IpcChannel } from '@shared/contract'
import type { AdoConnectionInfo, IpcError } from '@shared/adoTypes'
import {
  clearConnection,
  getConnectionInfo,
  setConnection
} from '../auth/tokenStore'
import { AdoApiError, clearCache } from '../ado/client'
import {
  listIterations,
  listProjects,
  listSavedQueries,
  listTeamMembers,
  listTeams
} from '../ado/projects'
import {
  batchGetWorkItems,
  getWorkItemWithRelations,
  patchWorkItem,
  runSavedQuery,
  runWiql
} from '../ado/workItems'
import { fetchAttachmentAsBase64 } from '../ado/attachments'

type Handler = (...args: unknown[]) => Promise<unknown> | unknown

function wrap<T>(fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve()
    .then(fn)
    .catch((err: unknown) => {
      const payload: IpcError =
        err instanceof AdoApiError
          ? err.toIpc()
          : err instanceof Error
            ? { code: 'INTERNAL', message: err.message }
            : { code: 'INTERNAL', message: 'Unknown error' }
      // Electron's `ipcMain.handle` only serializes `Error` instances over
      // the bridge — throwing a plain object stringifies it via String(obj)
      // and surfaces "[object Object]" on the renderer. Wrap the structured
      // payload in an Error whose .message is JSON-encoded, then have the
      // preload bridge unwrap it before the renderer ever sees it.
      const wrapped = new Error(IPC_ERROR_PREFIX + JSON.stringify(payload))
      wrapped.name = 'IpcError'
      throw wrapped
    }) as Promise<T>
}

export function registerIpcHandlers(ipcMain: IpcMain): void {
  const handlers: Partial<Record<IpcChannel, Handler>> = {
    [IPC.ConnectionGet]: () => wrap(() => getConnectionInfo()),

    [IPC.ConnectionSet]: (_e, args) =>
      wrap(async () => {
        const { organizationUrl, personalAccessToken } = args as {
          organizationUrl: string
          personalAccessToken: string
        }
        const projects = await listProjects({ organizationUrl, token: personalAccessToken })
        const info = await setConnection(organizationUrl, personalAccessToken)
        clearCache()
        // Touch the cached projects list so the renderer's first call is fast.
        void projects
        return info
      }),

    [IPC.ConnectionClear]: () =>
      wrap(async () => {
        await clearConnection()
        clearCache()
        return { ok: true as const }
      }),

    [IPC.ConnectionTest]: (_e, args) =>
      wrap(async () => {
        const { organizationUrl, personalAccessToken } = args as {
          organizationUrl: string
          personalAccessToken: string
        }
        const projects = await listProjects({ organizationUrl, token: personalAccessToken })
        const info: AdoConnectionInfo = {
          organizationUrl: organizationUrl.replace(/\/+$/, ''),
          hasToken: true
        }
        // Surface project count to keep the test endpoint useful.
        info.authenticatedUser = info.authenticatedUser ?? {
          displayName: `${projects.length} project${projects.length === 1 ? '' : 's'} visible`
        }
        return info
      }),

    [IPC.ProjectsList]: (_e, args) =>
      wrap(() => listProjects((args ?? undefined) as { organizationUrl?: string } | undefined)),

    [IPC.TeamsList]: (_e, args) =>
      wrap(() => listTeams((args as { projectId: string }).projectId)),

    [IPC.TeamMembersList]: (_e, args) => {
      const a = args as { projectId: string; teamId: string }
      return wrap(() => listTeamMembers(a.projectId, a.teamId))
    },

    [IPC.IterationsList]: (_e, args) => {
      const a = args as { projectId: string; teamId?: string; timeframe?: 'current' }
      return wrap(() => listIterations(a.projectId, a.teamId, a.timeframe))
    },

    [IPC.SavedQueriesList]: (_e, args) => {
      const a = args as { projectId: string; depth?: number }
      return wrap(() => listSavedQueries(a.projectId, a.depth))
    },

    [IPC.WorkItemsRunWiql]: (_e, args) =>
      wrap(() =>
        runWiql(
          args as { projectId: string; teamId?: string; wiql: string; top?: number }
        )
      ),

    [IPC.WorkItemsRunSavedQuery]: (_e, args) =>
      wrap(() =>
        runSavedQuery(
          args as { projectId: string; queryId: string; teamId?: string; top?: number }
        )
      ),

    [IPC.WorkItemsBatchGet]: (_e, args) =>
      wrap(() =>
        batchGetWorkItems(
          args as Parameters<typeof batchGetWorkItems>[0]
        )
      ),

    [IPC.WorkItemsGetWithRelations]: (_e, args) =>
      wrap(() =>
        getWorkItemWithRelations(
          args as Parameters<typeof getWorkItemWithRelations>[0]
        )
      ),

    [IPC.WorkItemsPatch]: (_e, args) =>
      wrap(() => patchWorkItem(args as Parameters<typeof patchWorkItem>[0])),

    [IPC.AttachmentFetch]: (_e, args) =>
      wrap(() => fetchAttachmentAsBase64((args as { url: string }).url)),

    [IPC.ShellOpenExternal]: (_e, args) =>
      wrap(async () => {
        const { url } = args as { url: string }
        if (typeof url !== 'string' || !url.trim()) {
          throw new Error('Missing url')
        }
        // Restrict to safe schemes so a hostile renderer cannot launch arbitrary handlers.
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`Refused to open non-web URL: ${parsed.protocol}`)
        }
        await shell.openExternal(url)
        return { ok: true as const }
      })
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    if (!handler) continue
    ipcMain.handle(channel, handler as Handler)
  }
}

export function broadcast(
  windows: BrowserWindow[],
  event: 'connection-changed',
  payload: AdoConnectionInfo
): void {
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(event, payload)
    }
  }
}
