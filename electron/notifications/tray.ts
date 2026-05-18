import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  type NativeImage
} from 'electron'
import path from 'node:path'
import { RENDERER_EVENT, type NotificationOpenTarget } from '@shared/contract'

/**
 * System tray surface for v0.3.1.
 *
 * Owns:
 *   - The `Tray` instance (singleton).
 *   - The badge / tooltip update path keyed off the poller's count
 *     callback.
 *   - The right-click menu, which deep-links into the app via
 *     renderer-bound `'open-target'` events (same channel the
 *     notification click handler uses).
 *
 * Icon strategy:
 *   - PNG assets live under `electron/assets/` and are committed in
 *     repo. macOS gets a `*Template.png` pair (16 + @2x) so the icon
 *     auto-inverts against the menu-bar background; Windows / Linux
 *     get the plain `tray-icon.png` pair (Windows ignores @2x but
 *     Electron just uses the base image).
 *   - At runtime we resolve `app.getAppPath()` → `electron/assets/...`,
 *     which works in dev (project root) and in prod once the assets
 *     are listed in `electron-builder.yml`'s `files`.
 *
 * Badge strategy:
 *   - macOS: `tray.setTitle('● 3')` is the supported way to surface
 *     a count next to the menu-bar icon. We hide the dot when the
 *     count is zero so the menu bar isn't littered with noise.
 *   - Windows / Linux: no equivalent for menu-bar text. We update the
 *     tooltip with the same summary so a hover still reveals it.
 *     The brief explicitly accepts dropping the inline badge here.
 */

let tray: Tray | null = null
let mainWindow: BrowserWindow | null = null

interface CountsSnapshot {
  prs: number
  mentions: number
}

let lastCounts: CountsSnapshot = { prs: 0, mentions: 0 }

function resolveTrayIconPath(): string {
  // macOS template images get magic dark/light treatment when the
  // filename ends in `Template.png`. Other platforms get the plain
  // PNG — Electron will pick @2x on hi-DPI Windows automatically.
  const fileName =
    process.platform === 'darwin' ? 'tray-iconTemplate.png' : 'tray-icon.png'
  return path.join(app.getAppPath(), 'electron', 'assets', fileName)
}

function loadTrayIcon(): NativeImage {
  const iconPath = resolveTrayIconPath()
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    // Fall back to an empty 16x16 image so Tray() doesn't crash on a
    // mis-packaged build. The user gets a blank tray slot but the
    // menu still works — much better than the whole feature failing.
    console.warn(
      `[notifications/tray] tray icon at ${iconPath} could not be loaded; using a blank fallback`
    )
    return nativeImage.createEmpty()
  }
  if (process.platform === 'darwin') {
    image.setTemplateImage(true)
  }
  return image
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function toggleMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide()
    return
  }
  focusMainWindow()
}

function sendOpenTarget(target: NotificationOpenTarget): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(RENDERER_EVENT.NotificationOpenTarget, target)
}

function buildContextMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Show Workthread',
      click: () => focusMainWindow()
    },
    { type: 'separator' },
    {
      label: 'Open Pull Requests',
      click: () => {
        focusMainWindow()
        sendOpenTarget({ kind: 'tab', tab: 'pullRequests' })
      }
    },
    {
      label: 'Open Mentions',
      click: () => {
        focusMainWindow()
        sendOpenTarget({ kind: 'tab', tab: 'mentions' })
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      // app.quit() flips the `isQuitting` flag (set in
      // electron/main.ts via 'before-quit') so the close-to-tray
      // override lets the window destroy normally. Without that
      // flag, app.quit() would race with the close handler that
      // hides instead of closes the window.
      click: () => app.quit()
    }
  ])
}

function formatTooltip(counts: CountsSnapshot): string {
  const segments: string[] = []
  if (counts.prs > 0) {
    segments.push(
      `${counts.prs} PR${counts.prs === 1 ? '' : 's'} awaiting your review`
    )
  }
  if (counts.mentions > 0) {
    segments.push(
      `${counts.mentions} new mention${counts.mentions === 1 ? '' : 's'}`
    )
  }
  if (segments.length === 0) return 'Workthread'
  return `Workthread — ${segments.join(' · ')}`
}

function applyCounts(counts: CountsSnapshot): void {
  if (!tray || tray.isDestroyed()) return
  lastCounts = counts
  tray.setToolTip(formatTooltip(counts))
  if (process.platform === 'darwin') {
    // setTitle is macOS-only; on other platforms Electron returns
    // silently but it's clearer to gate on platform here.
    const total = counts.prs + counts.mentions
    tray.setTitle(total > 0 ? `● ${total}` : '')
  }
}

/**
 * Construct the tray and wire up its left-click + menu behaviour.
 * Idempotent — repeated calls reuse the existing tray instance and
 * just refresh the bound window reference.
 */
export function createTray(window: BrowserWindow): void {
  mainWindow = window
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(buildContextMenu())
    return
  }
  const icon = loadTrayIcon()
  tray = new Tray(icon)
  tray.setToolTip('Workthread')
  tray.setContextMenu(buildContextMenu())
  // Single-click on Windows / Linux toggles visibility; on macOS the
  // menu opens on click already and toggling on top of that would be
  // surprising.
  if (process.platform !== 'darwin') {
    tray.on('click', () => toggleMainWindow())
  }
  applyCounts(lastCounts)
}

/**
 * Push fresh counts in from the poller. Safe to call before
 * `createTray` — the counts are stored and re-applied on the next
 * `createTray` invocation.
 */
export function updateTrayCounts(counts: CountsSnapshot): void {
  applyCounts(counts)
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
  }
  tray = null
  mainWindow = null
}
