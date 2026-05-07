import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpcHandlers, broadcast } from './ipc/register'
import { onConnectionChanged } from './auth/tokenStore'
import { createTray, destroyTray, updateTrayCounts } from './notifications/tray'
import { startPoller, stopPoller } from './notifications/poller'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const isDev = !!process.env.ELECTRON_RENDERER_URL

let mainWindow: BrowserWindow | null = null
/**
 * Distinguishes a true app-quit (tray menu → Quit, Cmd+Q on macOS,
 * `app.quit()` programmatically) from a window-close that should
 * minimise to the tray. Set in the `before-quit` handler so any
 * code path that ends in `app.quit()` flows through here without
 * the close handler trapping it.
 */
let isQuitting = false

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    title: 'Azure DevOps Visualizer',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // Minimize-to-tray: clicking the window's close button hides the
  // window instead of destroying it, so the tray icon + 60-s poller
  // keep running in the background. The window only really closes
  // when `isQuitting` is set — which happens on `app.quit()` (tray
  // menu Quit, Cmd+Q on macOS, programmatic quit).
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    if (!mainWindow || mainWindow.isDestroyed()) return
    event.preventDefault()
    mainWindow.hide()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    registerIpcHandlers(ipcMain)

    onConnectionChanged((info) => {
      broadcast(BrowserWindow.getAllWindows(), 'connection-changed', info)
    })

    createMainWindow()

    // Tray + 60-s poll loop. Both depend on the main window being
    // alive (tray for menu→show, poller for sending 'open-target' on
    // notification click) — wire them up after the window exists.
    if (mainWindow) {
      createTray(mainWindow)
      startPoller(mainWindow, {
        onCountsChanged: (counts) => updateTrayCounts(counts)
      })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Belt-and-suspenders flush of any renderer-side storage (Chromium
// localStorage, IndexedDB, RTK Query persisted cache, etc.) before the
// app exits. Chromium buffers these writes in memory and only flushes
// lazily — without this, a quick quit-after-change can drop the most
// recent edits. The bulk of our persisted state moved to a JSON file
// owned by the main process (see `electron/persistence/preferencesStore.ts`)
// which doesn't need this; the flush here protects any future renderer-
// resident storage and any edge cases left over from the migration.
//
// Also flips the `isQuitting` flag that the window 'close' handler
// reads to decide whether to actually destroy the window or just hide
// it. Without this, calling `app.quit()` from the tray menu would
// race the close-to-tray handler and leave the app running headless.
app.on('before-quit', () => {
  isQuitting = true
  try {
    stopPoller()
    destroyTray()
  } catch (err) {
    console.warn('[main] failed to tear down tray/poller cleanly', err)
  }
  try {
    void session.defaultSession.flushStorageData()
  } catch {
    // Best-effort — never block quit on a flush failure.
  }
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const target = new URL(navigationUrl)
    const allowed = process.env.ELECTRON_RENDERER_URL
      ? new URL(process.env.ELECTRON_RENDERER_URL).origin
      : null
    if (allowed && target.origin !== allowed) {
      event.preventDefault()
      void shell.openExternal(navigationUrl)
    } else if (!allowed && target.protocol !== 'file:') {
      event.preventDefault()
      void shell.openExternal(navigationUrl)
    }
  })
})
