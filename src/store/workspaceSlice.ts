import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export type QuerySource =
  | { kind: 'savedQuery'; queryId: string; queryName?: string }
  | { kind: 'wiql'; wiql: string; label?: string }

export interface WorkspaceState {
  projectId: string | null
  projectName: string | null
  teamId: string | null
  teamName: string | null
  source: QuerySource | null
  selectedWorkItemId: number | null
  groupBy: 'iteration' | 'assignee' | 'state' | 'type' | 'none'
  /** Work-item types currently hidden across all visualizations. */
  hiddenTypes: string[]
}

const initialState: WorkspaceState = {
  projectId: null,
  projectName: null,
  teamId: null,
  teamName: null,
  source: null,
  selectedWorkItemId: null,
  groupBy: 'iteration',
  // Tasks are hidden by default in the visualisations — most users want
  // to see the backlog (Features / PBIs / Bugs) and pull tasks in only
  // when they need to. Tasks remain available everywhere via the type
  // filter chip strip in each view's toolbar.
  hiddenTypes: ['Task']
}

const workspaceSlice = createSlice({
  name: 'workspace',
  initialState,
  reducers: {
    setProject(state, action: PayloadAction<{ id: string; name: string } | null>) {
      if (!action.payload) {
        state.projectId = null
        state.projectName = null
        state.teamId = null
        state.teamName = null
        state.source = null
        return
      }
      if (state.projectId !== action.payload.id) {
        state.teamId = null
        state.teamName = null
        state.source = null
      }
      state.projectId = action.payload.id
      state.projectName = action.payload.name
    },
    setTeam(state, action: PayloadAction<{ id: string; name: string } | null>) {
      state.teamId = action.payload?.id ?? null
      state.teamName = action.payload?.name ?? null
    },
    setSource(state, action: PayloadAction<QuerySource | null>) {
      state.source = action.payload
    },
    selectWorkItem(state, action: PayloadAction<number | null>) {
      state.selectedWorkItemId = action.payload
    },
    setGroupBy(state, action: PayloadAction<WorkspaceState['groupBy']>) {
      state.groupBy = action.payload
    },
    toggleType(state, action: PayloadAction<string>) {
      const t = action.payload
      const idx = state.hiddenTypes.indexOf(t)
      if (idx >= 0) state.hiddenTypes.splice(idx, 1)
      else state.hiddenTypes.push(t)
    },
    setHiddenTypes(state, action: PayloadAction<string[]>) {
      state.hiddenTypes = [...new Set(action.payload)]
    },
    resetTypeFilter(state) {
      state.hiddenTypes = []
    },
    resetWorkspace() {
      return initialState
    }
  }
})

export const {
  setProject,
  setTeam,
  setSource,
  selectWorkItem,
  setGroupBy,
  toggleType,
  setHiddenTypes,
  resetTypeFilter,
  resetWorkspace
} = workspaceSlice.actions

export default workspaceSlice.reducer
