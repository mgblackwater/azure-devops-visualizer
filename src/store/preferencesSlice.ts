import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { QuerySource, WorkspaceState } from './workspaceSlice'

/**
 * Per-user preferences persisted to localStorage. Keep this slice strictly
 * "user-pinned" choices — runtime selection state belongs to workspaceSlice,
 * but a snapshot of the workspace is mirrored here so the user doesn't have
 * to re-pick project / team / query / grouping on every reload.
 *
 * Both maps are keyed by organization URL so a user with multiple ADO
 * organizations gets sensible per-org values.
 */

export interface WorkspaceSnapshot {
  projectId: string | null
  projectName: string | null
  teamId: string | null
  teamName: string | null
  source: QuerySource | null
  groupBy: WorkspaceState['groupBy']
}

const EMPTY_SNAPSHOT: WorkspaceSnapshot = {
  projectId: null,
  projectName: null,
  teamId: null,
  teamName: null,
  source: null,
  groupBy: 'iteration'
}

export interface PreferencesState {
  defaultProjectByOrg: Record<string, string>
  workspaceByOrg: Record<string, WorkspaceSnapshot>
}

const STORAGE_KEY = 'ado-viz:preferences:v1'

function emptyState(): PreferencesState {
  return { defaultProjectByOrg: {}, workspaceByOrg: {} }
}

function load(): PreferencesState {
  if (typeof localStorage === 'undefined') return emptyState()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw) as Partial<PreferencesState> | null
    if (!parsed || typeof parsed !== 'object') return emptyState()
    const out = emptyState()
    if (
      parsed.defaultProjectByOrg &&
      typeof parsed.defaultProjectByOrg === 'object'
    ) {
      for (const [k, v] of Object.entries(parsed.defaultProjectByOrg)) {
        if (typeof k === 'string' && typeof v === 'string') {
          out.defaultProjectByOrg[k] = v
        }
      }
    }
    if (parsed.workspaceByOrg && typeof parsed.workspaceByOrg === 'object') {
      for (const [k, v] of Object.entries(parsed.workspaceByOrg)) {
        if (typeof k !== 'string' || !v || typeof v !== 'object') continue
        out.workspaceByOrg[k] = sanitizeSnapshot(v as Partial<WorkspaceSnapshot>)
      }
    }
    return out
  } catch {
    return emptyState()
  }
}

/**
 * Defensive coercion — anything stored from a prior schema or hand-edited in
 * devtools should not throw at load time. Unknown fields collapse to their
 * empty defaults so the UI degrades gracefully rather than rendering garbage.
 */
function sanitizeSnapshot(raw: Partial<WorkspaceSnapshot>): WorkspaceSnapshot {
  const allowedGroupBy: WorkspaceState['groupBy'][] = [
    'iteration',
    'assignee',
    'state',
    'type',
    'none'
  ]
  return {
    projectId: typeof raw.projectId === 'string' ? raw.projectId : null,
    projectName: typeof raw.projectName === 'string' ? raw.projectName : null,
    teamId: typeof raw.teamId === 'string' ? raw.teamId : null,
    teamName: typeof raw.teamName === 'string' ? raw.teamName : null,
    source: isValidSource(raw.source) ? raw.source : null,
    groupBy:
      raw.groupBy && allowedGroupBy.includes(raw.groupBy)
        ? raw.groupBy
        : 'iteration'
  }
}

function isValidSource(s: unknown): s is QuerySource {
  if (!s || typeof s !== 'object') return false
  const obj = s as { kind?: unknown }
  if (obj.kind === 'savedQuery') {
    return typeof (s as { queryId?: unknown }).queryId === 'string'
  }
  if (obj.kind === 'wiql') {
    return typeof (s as { wiql?: unknown }).wiql === 'string'
  }
  return false
}

function persist(state: PreferencesState): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Ignore quota / privacy mode failures.
  }
}

const initialState: PreferencesState = load()

function normalizeOrg(orgUrl: string): string {
  return orgUrl.replace(/\/+$/, '').toLowerCase()
}

const slice = createSlice({
  name: 'preferences',
  initialState,
  reducers: {
    setDefaultProject(
      state,
      action: PayloadAction<{ organizationUrl: string; projectId: string }>
    ) {
      const key = normalizeOrg(action.payload.organizationUrl)
      if (!key) return
      state.defaultProjectByOrg[key] = action.payload.projectId
      persist(state)
    },
    clearDefaultProject(
      state,
      action: PayloadAction<{ organizationUrl: string }>
    ) {
      const key = normalizeOrg(action.payload.organizationUrl)
      if (!key) return
      delete state.defaultProjectByOrg[key]
      persist(state)
    },
    saveWorkspaceSnapshot(
      state,
      action: PayloadAction<{
        organizationUrl: string
        snapshot: WorkspaceSnapshot
      }>
    ) {
      const key = normalizeOrg(action.payload.organizationUrl)
      if (!key) return
      state.workspaceByOrg[key] = action.payload.snapshot
      persist(state)
    },
    clearWorkspaceSnapshot(
      state,
      action: PayloadAction<{ organizationUrl: string }>
    ) {
      const key = normalizeOrg(action.payload.organizationUrl)
      if (!key) return
      delete state.workspaceByOrg[key]
      persist(state)
    }
  }
})

export function selectDefaultProjectId(
  state: { preferences: PreferencesState },
  organizationUrl: string | undefined
): string | null {
  if (!organizationUrl) return null
  return (
    state.preferences.defaultProjectByOrg[normalizeOrg(organizationUrl)] ?? null
  )
}

export function selectWorkspaceSnapshot(
  state: { preferences: PreferencesState },
  organizationUrl: string | undefined
): WorkspaceSnapshot | null {
  if (!organizationUrl) return null
  return (
    state.preferences.workspaceByOrg[normalizeOrg(organizationUrl)] ?? null
  )
}

export const EMPTY_WORKSPACE_SNAPSHOT = EMPTY_SNAPSHOT

export const {
  setDefaultProject,
  clearDefaultProject,
  saveWorkspaceSnapshot,
  clearWorkspaceSnapshot
} = slice.actions

export default slice.reducer
