/**
 * Renderer-side adapter over `window.ado.preferences` — the disk-backed
 * JSON store the main process owns (see
 * `electron/persistence/preferencesStore.ts`).
 *
 * Wraps three concerns each Redux slice would otherwise duplicate:
 *   1. Pulling the full preferences blob via the synchronous IPC bridge
 *      so slice initializers can stay synchronous.
 *   2. Caching that blob in the renderer so multiple slices reading
 *      at module-import time don't each round-trip the bridge.
 *   3. A one-shot migration from the legacy `localStorage` keys used
 *      before the disk-backed store existed — protects users with
 *      data already in `localStorage` from losing it on the upgrade.
 *
 * Slices stay responsible for their own defensive parsing; this module
 * just hands them an `unknown` and lets them coerce.
 */

let cachedBlob: Record<string, unknown> | null = null

function getBridge() {
  if (typeof window === 'undefined') return null
  const ado = (window as Window & { ado?: unknown }).ado as
    | { preferences?: { readSync: () => { data: Record<string, unknown> }; write: (n: string, s: unknown) => Promise<{ ok: true }> } }
    | undefined
  return ado?.preferences ?? null
}

function readBlob(): Record<string, unknown> {
  if (cachedBlob !== null) return cachedBlob
  const bridge = getBridge()
  if (!bridge) {
    cachedBlob = {}
    return cachedBlob
  }
  try {
    const result = bridge.readSync()
    cachedBlob =
      result && typeof result === 'object' && result.data && typeof result.data === 'object'
        ? result.data
        : {}
  } catch {
    cachedBlob = {}
  }
  return cachedBlob
}

function readLegacyLocalStorage(key: string): unknown {
  if (typeof localStorage === 'undefined') return undefined
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return undefined
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/**
 * Read one slice's persisted state, with one-shot migration from a
 * legacy `localStorage` key when the disk-backed store has no entry
 * yet for this slice. Returns `undefined` when neither source has
 * data; the slice's own initializer should produce its empty state
 * in that case.
 *
 * The migration is idempotent: once the slice writes to the JSON
 * store (which happens immediately in this function on a successful
 * migration), subsequent boots find the data on disk and skip the
 * legacy path. We intentionally leave the `localStorage` key in place
 * — see the comment at the top of each slice for the deprecation
 * timeline.
 */
export function readPersistedSlice(
  sliceName: string,
  legacyLocalStorageKey: string
): unknown {
  const blob = readBlob()
  if (Object.prototype.hasOwnProperty.call(blob, sliceName)) {
    return blob[sliceName]
  }
  const legacy = readLegacyLocalStorage(legacyLocalStorageKey)
  if (legacy !== undefined) {
    // Seed both the in-memory cache and the on-disk file in one go so
    // the next slice that reads doesn't think the legacy data is
    // missing, and so a crash before the next reducer run still ends
    // up with the migrated data on disk.
    blob[sliceName] = legacy
    persistSlice(sliceName, legacy)
    return legacy
  }
  return undefined
}

/**
 * Fire-and-forget persistence of one slice's state. The main process
 * writes synchronously to disk (atomic temp-rename), so by the time
 * this promise resolves the data is durable; we don't await it
 * because the reducer can't be async anyway and a queued write is
 * good enough.
 *
 * IMPORTANT: slices typically call this from *inside* an Immer reducer,
 * where `state` is still a draft Proxy. Electron's structured-clone
 * algorithm rejects Proxies with "An object could not be cloned", so we
 * materialise a plain JSON snapshot before handing it across the IPC
 * boundary. JSON.parse(JSON.stringify(...)) is the cheapest way to do
 * this and matches what the disk file will hold anyway.
 */
export function persistSlice(sliceName: string, state: unknown): void {
  const bridge = getBridge()
  if (!bridge) return
  let snapshot: unknown
  try {
    snapshot = state === undefined ? null : JSON.parse(JSON.stringify(state))
  } catch (err) {
    console.warn(
      `[persistence] could not serialise slice "${sliceName}" for write`,
      err
    )
    return
  }
  if (cachedBlob) {
    cachedBlob[sliceName] = snapshot
  }
  void bridge.write(sliceName, snapshot).catch((err) => {
    console.warn(`[persistence] write failed for slice "${sliceName}"`, err)
  })
}
