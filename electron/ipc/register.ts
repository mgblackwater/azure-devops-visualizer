import type { BrowserWindow, IpcMain } from 'electron'
import { shell } from 'electron'
import { IPC, IPC_ERROR_PREFIX, type IpcChannel } from '@shared/contract'
import type { AdoConnectionInfo, IpcError } from '@shared/adoTypes'
import {
  clearConnection,
  getConnectionInfo,
  needsIdentityBackfill,
  persistAuthenticatedUser,
  setConnection
} from '../auth/tokenStore'
import {
  AdoApiError,
  clearCache,
  getAuthenticatedIdentity
} from '../ado/client'
import {
  listIterations,
  listProjectMemberIdentities,
  listProjects,
  listSavedQueries,
  listTeamMembers,
  listTeams
} from '../ado/projects'
import {
  addComment,
  batchGetWorkItems,
  getLatestMentions,
  getWorkItemWithRelations,
  listComments,
  patchWorkItem,
  runSavedQuery,
  runWiql
} from '../ado/workItems'
import { fetchAttachmentAsBase64 } from '../ado/attachments'
import {
  getPageTree,
  getWikiPage,
  listWikis,
  searchWiki,
  updatePage as updateWikiPage
} from '../ado/wiki'

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
    [IPC.ConnectionGet]: () =>
      wrap(async () => {
        // Lazy identity backfill: vaults written before identity was
        // persisted simply don't have it on disk, and re-typing the PAT
        // would be annoying. If the connection is healthy but identity
        // is missing, resolve it once and write it back so subsequent
        // calls are instant. Doing this in the IPC layer (instead of
        // tokenStore) keeps tokenStore free of the cycle that would
        // exist if it imported `ado/client`.
        if (needsIdentityBackfill()) {
          const identity = await getAuthenticatedIdentity()
          if (identity) await persistAuthenticatedUser(identity)
        }
        return getConnectionInfo()
      }),

    [IPC.ConnectionSet]: (_e, args) =>
      wrap(async () => {
        const { organizationUrl, personalAccessToken } = args as {
          organizationUrl: string
          personalAccessToken: string
        }
        // Validate the PAT by listing projects up-front, then resolve the
        // user identity in parallel so the persisted connection record
        // includes the user's display name. The identity probe is best-
        // effort; a null result just leaves the workspace's "Mentions me"
        // tab unable to filter, but the rest of the app keeps working.
        const [projects, identity] = await Promise.all([
          listProjects({ organizationUrl, token: personalAccessToken }),
          getAuthenticatedIdentity({
            organizationUrl,
            token: personalAccessToken
          })
        ])
        const info = await setConnection(
          organizationUrl,
          personalAccessToken,
          identity ?? undefined
        )
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

    [IPC.WorkItemsLatestMentions]: (_e, args) =>
      wrap(() =>
        getLatestMentions(args as Parameters<typeof getLatestMentions>[0])
      ),

    [IPC.WorkItemsListComments]: (_e, args) =>
      wrap(() =>
        listComments(args as Parameters<typeof listComments>[0])
      ),

    [IPC.AttachmentFetch]: (_e, args) =>
      wrap(() => fetchAttachmentAsBase64((args as { url: string }).url)),

    [IPC.WikiList]: (_e, args) => {
      const a = args as { projectId: string }
      return wrap(() => listWikis(a.projectId))
    },

    [IPC.WikiPageTree]: (_e, args) => {
      const a = args as { projectId: string; wikiId: string }
      return wrap(() => getPageTree(a.projectId, a.wikiId))
    },

    [IPC.WikiGetPage]: (_e, args) =>
      wrap(() => getWikiPage(args as Parameters<typeof getWikiPage>[0])),

    [IPC.WikiSearch]: (_e, args) =>
      wrap(() => searchWiki(args as Parameters<typeof searchWiki>[0])),

    [IPC.WikiUpdatePage]: (_e, args) =>
      wrap(() => updateWikiPage(args as Parameters<typeof updateWikiPage>[0])),

    [IPC.WorkItemAddComment]: (_e, args) =>
      wrap(() => addComment(args as Parameters<typeof addComment>[0])),

    [IPC.IdentitySearch]: (_e, args) => {
      const a = args as { projectId: string }
      return wrap(async () => ({
        identities: await listProjectMemberIdentities(a.projectId)
      }))
    },

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
