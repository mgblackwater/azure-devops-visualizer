import { getTeamProject } from '@/utils/workItemFields'
import type { AdoWorkItem } from '@shared/adoTypes'

/**
 * Build the canonical Azure DevOps web URL for a work item.
 *
 * Prefers the work item's own TeamProject so cross-project items opened
 * via global search still land in the right place; if we don't know the
 * project we fall back to the org-level path. ADO redirects
 * `/{org}/_workitems/edit/{id}` to the correct project so this is safe.
 *
 * Returns null when we don't yet have an org URL (e.g. while the
 * connection is loading).
 */
export function buildWorkItemUrl(
  item: AdoWorkItem | undefined | null,
  orgUrl: string | undefined | null
): string | null {
  if (!item || !orgUrl) return null
  const base = orgUrl.replace(/\/+$/, '')
  const ownProject = getTeamProject(item)
  const project = ownProject ? `/${encodeURIComponent(ownProject)}` : ''
  return `${base}${project}/_workitems/edit/${item.id}`
}
