import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { QuerySource, WorkspaceState } from './workspaceSlice'
import { persistSlice, readPersistedSlice } from './persistenceBridge'

/**
 * Per-user preferences persisted via the main-process disk-backed store
 * (`{userData}/preferences.json`). Keep this slice strictly "user-pinned"
 * choices — runtime selection state belongs to workspaceSlice, but a
 * snapshot of the workspace is mirrored here so the user doesn't have to
 * re-pick project / team / query / grouping on every reload.
 *
 * Both maps are keyed by organization URL so a user with multiple ADO
 * organizations gets sensible per-org values.
 *
 * Persistence used to live in `localStorage` under `STORAGE_KEY`, but
 * Chromium's lazy flush dropped writes on a quick restart. The legacy
 * `localStorage` read is kept *only* as the source for the one-shot
 * migration in `persistenceBridge.readPersistedSlice` — the slice itself
 * never reads or writes it directly anymore. Safe to remove the legacy
 * key after a release or two.
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

export type ThemeMode = 'light' | 'dark' | 'system'

const VALID_THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

export interface PreferencesState {
  defaultProjectByOrg: Record<string, string>
  workspaceByOrg: Record<string, WorkspaceSnapshot>
  themeMode: ThemeMode
  sidebarCollapsed: boolean
  /**
   * Per-ADO-project repository folder that "Start with Claude" uses as
   * the cwd for the spawned terminal. Keyed by ADO project id. Stored
   * here (not under workspaceByOrg) so a user with multiple projects in
   * one org can map each to its own local repo.
   */
  claudeRepoByProject: Record<string, string>
}

/**
 * Legacy `localStorage` key; kept only so the one-shot migration in
 * `persistenceBridge.readPersistedSlice` can pick up data from previous
 * builds. Nothing in this slice reads or writes localStorage directly.
 */
const LEGACY_STORAGE_KEY = 'ado-viz:preferences:v1'
const SLICE_NAME = 'preferences'

function emptyState(): PreferencesState {
  return {
    defaultProjectByOrg: {},
    workspaceByOrg: {},
    themeMode: 'system',
    sidebarCollapsed: false,
    claudeRepoByProject: {}
  }
}

function sanitizeThemeMode(value: unknown): ThemeMode {
  // Tolerate older payloads that predate the themeMode field, as well as
  // anything hand-edited in devtools — fall back to 'system' instead of
  // crashing the slice on load.
  return typeof value === 'string' && (VALID_THEME_MODES as readonly string[]).includes(value)
    ? (value as ThemeMode)
    : 'system'
}

function sanitizeState(parsed: unknown): PreferencesState {
  if (!parsed || typeof parsed !== 'object') return emptyState()
  const p = parsed as Partial<PreferencesState>
  const out = emptyState()
  if (p.defaultProjectByOrg && typeof p.defaultProjectByOrg === 'object') {
    for (const [k, v] of Object.entries(p.defaultProjectByOrg)) {
      if (typeof k === 'string' && typeof v === 'string') {
        out.defaultProjectByOrg[k] = v
      }
    }
  }
  if (p.workspaceByOrg && typeof p.workspaceByOrg === 'object') {
    for (const [k, v] of Object.entries(p.workspaceByOrg)) {
      if (typeof k !== 'string' || !v || typeof v !== 'object') continue
      out.workspaceByOrg[k] = sanitizeSnapshot(v as Partial<WorkspaceSnapshot>)
    }
  }
  out.themeMode = sanitizeThemeMode(p.themeMode)
  out.sidebarCollapsed = typeof p.sidebarCollapsed === 'boolean' ? p.sidebarCollapsed : false
  if (p.claudeRepoByProject && typeof p.claudeRepoByProject === 'object') {
    for (const [k, v] of Object.entries(p.claudeRepoByProject)) {
      if (typeof k === 'string' && typeof v === 'string') {
        out.claudeRepoByProject[k] = v
      }
    }
  }
  return out
}

function load(): PreferencesState {
  try {
    return sanitizeState(readPersistedSlice(SLICE_NAME, LEGACY_STORAGE_KEY))
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
  // Routes through the main process — disk write is atomic and
  // happens before the IPC ack, so the user can quit immediately
  // after a change without losing it.
  persistSlice(SLICE_NAME, state)
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
    },
    setThemeMode(state, action: PayloadAction<ThemeMode>) {
      state.themeMode = sanitizeThemeMode(action.payload)
      persist(state)
    },
    setSidebarCollapsed(state, action: PayloadAction<boolean>) {
      state.sidebarCollapsed = !!action.payload
      persist(state)
    },
    toggleSidebarCollapsed(state) {
      state.sidebarCollapsed = !state.sidebarCollapsed
      persist(state)
    },
    setClaudeRepoPath(
      state,
      action: PayloadAction<{ projectId: string; path: string }>
    ) {
      const { projectId, path } = action.payload
      if (!projectId || !path) return
      state.claudeRepoByProject[projectId] = path
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

export function selectThemeMode(state: {
  preferences: PreferencesState
}): ThemeMode {
  return state.preferences.themeMode
}

export function selectSidebarCollapsed(state: {
  preferences: PreferencesState
}): boolean {
  return state.preferences.sidebarCollapsed
}

export function selectClaudeRepoPath(
  state: { preferences: PreferencesState },
  projectId: string | null | undefined
): string | null {
  if (!projectId) return null
  return state.preferences.claudeRepoByProject[projectId] ?? null
}

export const EMPTY_WORKSPACE_SNAPSHOT = EMPTY_SNAPSHOT

export const {
  setDefaultProject,
  clearDefaultProject,
  saveWorkspaceSnapshot,
  clearWorkspaceSnapshot,
  setThemeMode,
  setSidebarCollapsed,
  toggleSidebarCollapsed,
  setClaudeRepoPath
} = slice.actions

export default slice.reducer
