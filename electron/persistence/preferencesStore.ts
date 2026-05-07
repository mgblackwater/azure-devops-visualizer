import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Disk-backed JSON store for renderer-driven preferences (theme, sidebar
 * collapsed state, per-org workspace snapshots, recent searches,
 * favorites, etc).
 *
 * Lives next to `pat.bin` / `connection.json` under `app.getPath('userData')`,
 * and uses the same write-and-rename pattern as `tokenStore.ts` so a crash
 * mid-write can never leave the file partially serialised.
 *
 * The store is a flat object keyed by slice name —
 *   {
 *     "preferences":     { ...preferencesSlice state... },
 *     "recentSearches":  { ...recentSearchesSlice state... },
 *     "favorites":       { ...favoritesSlice state... }
 *   }
 * — so multiple slices share one file, but writes are scoped to a single
 * top-level key (`writeSlice`) to keep round-trips small.
 *
 * All operations are synchronous so the renderer can drive them through
 * `ipcRenderer.sendSync` at slice initialization time without forcing a
 * React-level rearchitecture (see `electron/preload.ts`).
 */

type StoreShape = Record<string, unknown>

let cache: StoreShape | null = null

function filePath(): string {
  return path.join(app.getPath('userData'), 'preferences.json')
}

function loadFromDiskOnce(): StoreShape {
  if (cache) return cache
  const target = filePath()
  try {
    const raw = fs.readFileSync(target, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      cache = parsed as StoreShape
      return cache
    }
    // Anything other than a plain object (null, array, primitive) is
    // treated as corrupt — fall through to the empty-object branch.
    console.warn(
      `[persistence] preferences file at ${target} is not an object; resetting to {}`
    )
  } catch (err) {
    // Missing file is the common first-boot case and not noteworthy;
    // log only the unexpected errors (parse failure, permission denied).
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(
        `[persistence] failed to read ${target}; starting from empty store`,
        err
      )
    }
  }
  cache = {}
  return cache
}

/**
 * Read the full store as a single object. Returns `{}` if the file is
 * missing or corrupt — callers should default each slice's own state
 * from there. Synchronous so it can be invoked from `ipcMain.on` for
 * the renderer's `sendSync` boot path.
 */
export function read(): StoreShape {
  // Return a shallow copy so callers can't mutate the in-memory cache
  // by holding onto the reference. Each slice value is itself read-only
  // from the renderer's perspective (it's about to be JSON-cloned over
  // IPC anyway), so a deep copy would just burn cycles.
  return { ...loadFromDiskOnce() }
}

/**
 * Replace one slice's value in the store and atomically write the full
 * blob to disk. Errors are logged but swallowed — preferences are best-
 * effort and shouldn't crash the app.
 */
export function writeSlice(sliceName: string, sliceState: unknown): void {
  if (!sliceName) return
  const data = loadFromDiskOnce()
  data[sliceName] = sliceState
  const target = filePath()
  const tmp = `${target}.tmp`
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    // Write to a sibling tempfile then rename; on POSIX rename is
    // atomic, and on NTFS it's atomic-enough for our purposes (the
    // worst case is the temp file lingers, which is harmless).
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8' })
    fs.renameSync(tmp, target)
  } catch (err) {
    console.warn(
      `[persistence] failed to write ${target}`,
      err
    )
    // Best-effort cleanup of the temp file so we don't leak it on
    // repeated failures.
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
  }
}

/**
 * Test hook — drops the in-memory cache so the next `read()` re-loads
 * from disk. Not used in production code; exported so future tests
 * don't have to reach into module internals.
 */
export function _resetCacheForTests(): void {
  cache = null
}
