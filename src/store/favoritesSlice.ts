import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

/**
 * Per-user favorites: pinned references to work items, wiki pages, and
 * saved queries the user wants quick access to. Persisted to localStorage
 * so they survive reloads, scoped per ADO organization so one user with
 * multiple orgs sees the right set in each.
 *
 * Items intentionally carry their own navigation metadata (`meta`) so the
 * app can route back to them without needing to re-fetch the parent
 * object — a wiki page stays openable even after the underlying wiki id
 * changes elsewhere in the UI.
 */

export type FavoriteKind = 'workItem' | 'wikiPage' | 'savedQuery'

export interface FavoriteItem {
  kind: FavoriteKind
  /**
   * Stable identity within the kind.
   *   - workItem:   `${id}` (e.g. "12345")
   *   - wikiPage:   `${wikiId}:${path}`
   *   - savedQuery: queryId (the ADO guid)
   */
  id: string
  label: string
  projectId?: string
  /** Per-kind navigation metadata so we can route back without re-resolving. */
  meta?: Record<string, string | number>
  /** ISO timestamp added — used to sort newest first. */
  addedAt: string
}

export interface FavoritesState {
  byOrg: Record<string, FavoriteItem[]>
}

const STORAGE_KEY = 'ado-viz:favorites:v1'
const VALID_KINDS: readonly FavoriteKind[] = ['workItem', 'wikiPage', 'savedQuery']

function emptyState(): FavoritesState {
  return { byOrg: {} }
}

/** Mirror `preferencesSlice.normalizeOrg` so both slices key off the same
 *  canonical form; otherwise an org URL with a trailing slash would split
 *  favorites and preferences across two buckets. */
function normalizeOrg(orgUrl: string): string {
  return orgUrl.replace(/\/+$/, '').toLowerCase()
}

function sanitizeMeta(
  raw: unknown
): Record<string, string | number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== 'string') continue
    if (typeof v === 'string' || typeof v === 'number') {
      out[k] = v
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeItem(raw: unknown): FavoriteItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<FavoriteItem>
  if (typeof r.kind !== 'string' || !VALID_KINDS.includes(r.kind as FavoriteKind)) {
    return null
  }
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.label !== 'string') return null
  const addedAt =
    typeof r.addedAt === 'string' && !Number.isNaN(Date.parse(r.addedAt))
      ? r.addedAt
      : new Date().toISOString()
  return {
    kind: r.kind as FavoriteKind,
    id: r.id,
    label: r.label,
    projectId: typeof r.projectId === 'string' ? r.projectId : undefined,
    meta: sanitizeMeta(r.meta),
    addedAt
  }
}

function load(): FavoritesState {
  if (typeof localStorage === 'undefined') return emptyState()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw) as Partial<FavoritesState> | null
    if (!parsed || typeof parsed !== 'object') return emptyState()
    const out = emptyState()
    if (parsed.byOrg && typeof parsed.byOrg === 'object') {
      for (const [k, v] of Object.entries(parsed.byOrg)) {
        if (typeof k !== 'string' || !Array.isArray(v)) continue
        const cleaned = v
          .map((entry) => sanitizeItem(entry))
          .filter((entry): entry is FavoriteItem => entry !== null)
        if (cleaned.length > 0) out.byOrg[k] = cleaned
      }
    }
    return out
  } catch {
    return emptyState()
  }
}

function persist(state: FavoritesState): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Ignore quota / privacy mode failures — favorites are best-effort.
  }
}

const initialState: FavoritesState = load()

interface AddPayload {
  organizationUrl: string
  item: Omit<FavoriteItem, 'addedAt'>
}

interface RemovePayload {
  organizationUrl: string
  kind: FavoriteKind
  id: string
}

const slice = createSlice({
  name: 'favorites',
  initialState,
  reducers: {
    /**
     * Idempotent: re-adding an existing favorite refreshes its label /
     * meta / timestamp instead of creating a duplicate. Callers don't
     * need to check "is it already a favorite" before dispatching.
     */
    addFavorite(state, action: PayloadAction<AddPayload>) {
      const key = normalizeOrg(action.payload.organizationUrl)
      if (!key) return
      const list = (state.byOrg[key] ??= [])
      const incoming = action.payload.item
      const existing = list.find(
        (f) => f.kind === incoming.kind && f.id === incoming.id
      )
      const stamp = new Date().toISOString()
      if (existing) {
        existing.label = incoming.label
        existing.projectId = incoming.projectId
        existing.meta = incoming.meta
        existing.addedAt = stamp
      } else {
        list.push({ ...incoming, addedAt: stamp })
      }
      persist(state)
    },
    removeFavorite(state, action: PayloadAction<RemovePayload>) {
      const key = normalizeOrg(action.payload.organizationUrl)
      if (!key) return
      const list = state.byOrg[key]
      if (!list) return
      const next = list.filter(
        (f) => !(f.kind === action.payload.kind && f.id === action.payload.id)
      )
      if (next.length === 0) {
        delete state.byOrg[key]
      } else {
        state.byOrg[key] = next
      }
      persist(state)
    },
    /**
     * Convenience action that's `addFavorite` if not present and
     * `removeFavorite` if it is — paired with the FavoriteButton's
     * star-flip UX so callers don't need to read state to decide.
     */
    toggleFavorite(state, action: PayloadAction<AddPayload>) {
      const key = normalizeOrg(action.payload.organizationUrl)
      if (!key) return
      const list = (state.byOrg[key] ??= [])
      const incoming = action.payload.item
      const idx = list.findIndex(
        (f) => f.kind === incoming.kind && f.id === incoming.id
      )
      if (idx >= 0) {
        list.splice(idx, 1)
        if (list.length === 0) delete state.byOrg[key]
      } else {
        list.push({ ...incoming, addedAt: new Date().toISOString() })
      }
      persist(state)
    }
  }
})

export const { addFavorite, removeFavorite, toggleFavorite } = slice.actions

/**
 * Returns favorites for the supplied org sorted newest-first. When
 * `kindFilter` is supplied, only entries of that kind survive.
 */
export function selectFavorites(
  state: { favorites: FavoritesState },
  organizationUrl: string | undefined,
  kindFilter?: FavoriteKind
): FavoriteItem[] {
  if (!organizationUrl) return []
  const list = state.favorites.byOrg[normalizeOrg(organizationUrl)] ?? []
  const filtered = kindFilter ? list.filter((f) => f.kind === kindFilter) : list
  // Sort copies the array so we don't mutate the slice's reducer state.
  return [...filtered].sort(
    (a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt)
  )
}

export function selectIsFavorite(
  state: { favorites: FavoritesState },
  organizationUrl: string | undefined,
  kind: FavoriteKind,
  id: string
): boolean {
  if (!organizationUrl) return false
  const list = state.favorites.byOrg[normalizeOrg(organizationUrl)] ?? []
  return list.some((f) => f.kind === kind && f.id === id)
}

export default slice.reducer
