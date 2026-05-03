import { useEffect, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/store'
import {
  saveWorkspaceSnapshot,
  selectWorkspaceSnapshot,
  type WorkspaceSnapshot
} from '@/store/preferencesSlice'
import {
  setGroupBy,
  setProject,
  setSource,
  setTeam
} from '@/store/workspaceSlice'

/**
 * Two-way binding between `workspaceSlice` (transient runtime state) and the
 * persisted `preferencesSlice.workspaceByOrg` map.
 *
 * - On first run for a given organisation it hydrates project / team / query
 *   source / grouping from the last snapshot the user worked with, so they
 *   land back in the same workspace they left in.
 * - After hydration (or whenever the user makes changes), every relevant
 *   workspace field is mirrored back into the snapshot so the next reload
 *   sees the latest pick.
 *
 * Hydration is a one-shot per `organizationUrl` to avoid an infinite loop
 * with the persistence write below.
 */
export function useWorkspacePersistence(
  organizationUrl: string | undefined
): void {
  const dispatch = useAppDispatch()
  const workspace = useAppSelector((s) => s.workspace)
  const snapshot = useAppSelector((s) =>
    selectWorkspaceSnapshot(s, organizationUrl)
  )
  const hydratedFor = useRef<string | null>(null)

  // ---- Hydration ----
  useEffect(() => {
    if (!organizationUrl) return
    if (hydratedFor.current === organizationUrl) return

    hydratedFor.current = organizationUrl
    if (!snapshot) return

    // Don't overwrite a project the user already chose this session — they
    // may have navigated through the workspace page before this effect ran.
    if (!workspace.projectId && snapshot.projectId && snapshot.projectName) {
      dispatch(
        setProject({ id: snapshot.projectId, name: snapshot.projectName })
      )
    }
    if (!workspace.teamId && snapshot.teamId) {
      dispatch(
        setTeam({ id: snapshot.teamId, name: snapshot.teamName ?? '' })
      )
    }
    if (!workspace.source && snapshot.source) {
      dispatch(setSource(snapshot.source))
    }
    if (snapshot.groupBy && snapshot.groupBy !== workspace.groupBy) {
      dispatch(setGroupBy(snapshot.groupBy))
    }
    // We deliberately ignore the workspace deps here — hydration runs once
    // per org. Subsequent edits flow back through the persistence effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationUrl, snapshot, dispatch])

  // ---- Persistence ----
  useEffect(() => {
    if (!organizationUrl) return
    // Skip until the first hydrate-pass has happened for this org so we
    // don't overwrite a saved snapshot with empty initial state on boot.
    if (hydratedFor.current !== organizationUrl) return

    const next: WorkspaceSnapshot = {
      projectId: workspace.projectId,
      projectName: workspace.projectName,
      teamId: workspace.teamId,
      teamName: workspace.teamName,
      source: workspace.source,
      groupBy: workspace.groupBy
    }

    if (snapshotsEqual(snapshot, next)) return

    dispatch(
      saveWorkspaceSnapshot({ organizationUrl, snapshot: next })
    )
  }, [
    organizationUrl,
    workspace.projectId,
    workspace.projectName,
    workspace.teamId,
    workspace.teamName,
    workspace.source,
    workspace.groupBy,
    snapshot,
    dispatch
  ])
}

function snapshotsEqual(
  a: WorkspaceSnapshot | null,
  b: WorkspaceSnapshot
): boolean {
  if (!a) return false
  return (
    a.projectId === b.projectId &&
    a.projectName === b.projectName &&
    a.teamId === b.teamId &&
    a.teamName === b.teamName &&
    a.groupBy === b.groupBy &&
    sourceEqual(a.source, b.source)
  )
}

function sourceEqual(
  a: WorkspaceSnapshot['source'],
  b: WorkspaceSnapshot['source']
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.kind !== b.kind) return false
  if (a.kind === 'savedQuery' && b.kind === 'savedQuery') {
    return a.queryId === b.queryId
  }
  if (a.kind === 'wiql' && b.kind === 'wiql') {
    return a.wiql === b.wiql && (a.label ?? null) === (b.label ?? null)
  }
  return false
}
