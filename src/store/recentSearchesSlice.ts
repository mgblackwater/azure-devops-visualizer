import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { persistSlice, readPersistedSlice } from './persistenceBridge'

/**
 * Persisted "recent work item searches", scoped per ADO project so that
 * switching projects doesn't pollute the dropdown with cross-project IDs.
 *
 * State is rehydrated from the disk-backed preferences store
 * (`{userData}/preferences.json`) on first load and written back on every
 * reducer mutation. Cap is per-project so users with multiple projects
 * keep meaningful history in each one.
 *
 * The legacy `localStorage` key is still consulted exactly once via
 * `persistenceBridge.readPersistedSlice` to migrate prior installs onto
 * the new file. Nothing else here touches localStorage.
 */

export interface RecentSearch {
  id: number
  title?: string
  type?: string
  /** Last touched (epoch ms). Newest entries appear first. */
  ts: number
}

export interface RecentSearchesState {
  byProject: Record<string, RecentSearch[]>
}

const MAX_PER_PROJECT = 10
const LEGACY_STORAGE_KEY = 'ado-viz:recentSearches:v1'
const SLICE_NAME = 'recentSearches'

function sanitizeState(parsed: unknown): RecentSearchesState {
  if (!parsed || typeof parsed !== 'object') return { byProject: {} }
  const p = parsed as Partial<RecentSearchesState>
  if (!p.byProject || typeof p.byProject !== 'object') return { byProject: {} }
  const out: RecentSearchesState = { byProject: {} }
  for (const [projectId, list] of Object.entries(p.byProject)) {
    if (!Array.isArray(list)) continue
    out.byProject[projectId] = list
      .filter((e): e is RecentSearch => !!e && typeof e.id === 'number')
      .map((e) => ({
        id: e.id,
        title: typeof e.title === 'string' ? e.title : undefined,
        type: typeof e.type === 'string' ? e.type : undefined,
        ts: typeof e.ts === 'number' ? e.ts : Date.now()
      }))
      .slice(0, MAX_PER_PROJECT)
  }
  return out
}

function load(): RecentSearchesState {
  try {
    return sanitizeState(readPersistedSlice(SLICE_NAME, LEGACY_STORAGE_KEY))
  } catch {
    return { byProject: {} }
  }
}

function persist(state: RecentSearchesState): void {
  persistSlice(SLICE_NAME, state)
}

const initialState: RecentSearchesState = load()

const slice = createSlice({
  name: 'recentSearches',
  initialState,
  reducers: {
    pushRecent(
      state,
      action: PayloadAction<{
        projectId: string
        id: number
        title?: string
        type?: string
      }>
    ) {
      const { projectId, id, title, type } = action.payload
      const list = state.byProject[projectId] ?? []
      const existing = list.find((i) => i.id === id)
      const merged: RecentSearch = {
        id,
        title: title ?? existing?.title,
        type: type ?? existing?.type,
        ts: Date.now()
      }
      const next = [merged, ...list.filter((i) => i.id !== id)].slice(
        0,
        MAX_PER_PROJECT
      )
      state.byProject[projectId] = next
      persist(state)
    },
    enrichRecent(
      state,
      action: PayloadAction<{
        projectId: string
        id: number
        title?: string
        type?: string
      }>
    ) {
      const { projectId, id, title, type } = action.payload
      const list = state.byProject[projectId]
      if (!list) return
      const item = list.find((i) => i.id === id)
      if (!item) return
      let changed = false
      if (title && item.title !== title) {
        item.title = title
        changed = true
      }
      if (type && item.type !== type) {
        item.type = type
        changed = true
      }
      if (changed) persist(state)
    },
    removeRecent(
      state,
      action: PayloadAction<{ projectId: string; id: number }>
    ) {
      const { projectId, id } = action.payload
      const list = state.byProject[projectId]
      if (!list) return
      state.byProject[projectId] = list.filter((i) => i.id !== id)
      persist(state)
    },
    clearRecent(state, action: PayloadAction<{ projectId: string }>) {
      delete state.byProject[action.payload.projectId]
      persist(state)
    }
  }
})

export const { pushRecent, enrichRecent, removeRecent, clearRecent } =
  slice.actions

export default slice.reducer
