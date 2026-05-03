import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

/**
 * Persisted "recent work item searches", scoped per ADO project so that
 * switching projects doesn't pollute the dropdown with cross-project IDs.
 *
 * State is rehydrated from localStorage on first load and written back on
 * every reducer mutation. Cap is per-project so users with multiple projects
 * keep meaningful history in each one.
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
const STORAGE_KEY = 'ado-viz:recentSearches:v1'

function load(): RecentSearchesState {
  if (typeof localStorage === 'undefined') return { byProject: {} }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { byProject: {} }
    const parsed = JSON.parse(raw) as RecentSearchesState | null
    if (!parsed || typeof parsed !== 'object' || !parsed.byProject) {
      return { byProject: {} }
    }
    const out: RecentSearchesState = { byProject: {} }
    for (const [projectId, list] of Object.entries(parsed.byProject)) {
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
  } catch {
    return { byProject: {} }
  }
}

function persist(state: RecentSearchesState): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Quota or privacy mode — recents stay in-memory for the session.
  }
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
