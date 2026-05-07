import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  IPC_ERROR_PREFIX,
  type AdoBridge,
  type IpcChannel,
  type IpcArgs,
  type IpcResult,
  type ReadPreferencesResult,
  type WritePreferencesResult
} from '@shared/contract'
import type { AdoConnectionInfo, IpcError } from '@shared/adoTypes'

/**
 * Decode the structured `IpcError` payload that the main process smuggles
 * through `Error.message`. Falls back to a generic INTERNAL error if the
 * marker is missing or the JSON is malformed.
 */
function decodeIpcError(raw: unknown): IpcError {
  const message = raw instanceof Error ? raw.message : String(raw)
  const idx = message.indexOf(IPC_ERROR_PREFIX)
  if (idx >= 0) {
    try {
      return JSON.parse(message.slice(idx + IPC_ERROR_PREFIX.length)) as IpcError
    } catch {
      // fall through to fallback
    }
  }
  return { code: 'INTERNAL', message }
}

const bridge: AdoBridge = {
  invoke<C extends IpcChannel>(channel: C, args?: IpcArgs<C>): Promise<IpcResult<C>> {
    return ipcRenderer.invoke(channel, args).then(
      (data) => data as IpcResult<C>,
      (err: unknown) => {
        // Reject with a *plain* serializable object so RTK Query can store
        // it in Redux state without tripping the serializability check.
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw decodeIpcError(err)
      }
    )
  },
  on(event, handler) {
    if (event === 'connection-changed') {
      const listener = (_e: Electron.IpcRendererEvent, info: AdoConnectionInfo): void => {
        handler(info)
      }
      ipcRenderer.on('connection-changed', listener)
      return () => {
        ipcRenderer.removeListener('connection-changed', listener)
      }
    }
    return () => {}
  },
  preferences: {
    /**
     * Synchronous read of the disk-backed preferences blob.
     *
     * This is the ONE place in the app where we use synchronous IPC
     * (`ipcRenderer.sendSync`). The Redux slices that consume
     * preferences hydrate at module-import time via
     * `createSlice({ initialState: load() })`, which is synchronous —
     * matching the previous `localStorage.getItem` shape. Going async
     * here would require restructuring every slice to defer hydration
     * until after a `Provider` mount, which is a much larger change
     * for a thin wrapper around a small JSON file. Sync IPC is fast
     * enough for a one-shot read at boot; we never call this on a
     * hot path.
     */
    readSync(): ReadPreferencesResult {
      try {
        const result = ipcRenderer.sendSync(IPC.PreferencesReadSync) as ReadPreferencesResult
        if (result && typeof result === 'object' && result.data && typeof result.data === 'object') {
          return result
        }
      } catch {
        // fall through
      }
      // Defensive default — if the main handler is missing or
      // returned something unexpected, give the slices an empty
      // store and let them fall back to their initial state.
      return { data: {} }
    },
    write(sliceName, sliceState): Promise<WritePreferencesResult> {
      return ipcRenderer.invoke(IPC.PreferencesWrite, { sliceName, sliceState }).then(
        (data) => data as WritePreferencesResult,
        (err: unknown) => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw decodeIpcError(err)
        }
      )
    }
  }
}

contextBridge.exposeInMainWorld('ado', bridge)
