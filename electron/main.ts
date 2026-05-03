import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpcHandlers, broadcast } from './ipc/register'
import { onConnectionChanged } from './auth/tokenStore'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const isDev = !!process.env.ELECTRON_RENDERER_URL

let mainWindow: BrowserWindow | null = null

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
