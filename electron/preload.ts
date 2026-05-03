import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_ERROR_PREFIX,
  type AdoBridge,
  type IpcChannel,
  type IpcArgs,
  type IpcResult
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
  }
}

contextBridge.exposeInMainWorld('ado', bridge)
