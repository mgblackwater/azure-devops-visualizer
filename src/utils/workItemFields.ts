import type { AdoIdentity, AdoWorkItem } from '@shared/adoTypes'

export function getTitle(w: AdoWorkItem): string {
  return (w.fields['System.Title'] as string | undefined) ?? `Work item ${w.id}`
}

export function getType(w: AdoWorkItem): string {
  return (w.fields['System.WorkItemType'] as string | undefined) ?? 'Unknown'
}

/**
 * Compact 3–4 char abbreviation used inside chips and badges. Falls back
 * to the first 4 characters of unknown types.
 */
export function typeBadge(type: string | undefined): string {
  if (!type) return '?'
  switch (type) {
    case 'Product Backlog Item':
      return 'PBI'
    case 'User Story':
      return 'US'
    case 'Test Case':
      return 'TC'
    case 'Requirement':
      return 'REQ'
    case 'Defect':
      return 'DEF'
    case 'Feature':
      return 'FEAT'
    case 'Epic':
      return 'EPIC'
    case 'Task':
      return 'TASK'
    case 'Bug':
      return 'BUG'
    default:
      return type.length <= 4 ? type : type.slice(0, 4).toUpperCase()
  }
}

export function getState(w: AdoWorkItem): string {
  return (w.fields['System.State'] as string | undefined) ?? 'Unknown'
}

export function getAssignee(w: AdoWorkItem): AdoIdentity | undefined {
  return w.fields['System.AssignedTo'] as AdoIdentity | undefined
}

export function getAssigneeName(w: AdoWorkItem): string {
  return getAssignee(w)?.displayName ?? 'Unassigned'
}

export function getIterationPath(w: AdoWorkItem): string {
  return (w.fields['System.IterationPath'] as string | undefined) ?? ''
}

export function getAreaPath(w: AdoWorkItem): string {
  return (w.fields['System.AreaPath'] as string | undefined) ?? ''
}

export function getTeamProject(w: AdoWorkItem): string {
  return (w.fields['System.TeamProject'] as string | undefined) ?? ''
}

export function getTags(w: AdoWorkItem): string[] {
  const raw = w.fields['System.Tags'] as string | undefined
  if (!raw) return []
  return raw
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean)
}

export function getDescription(w: AdoWorkItem): string {
  return (w.fields['System.Description'] as string | undefined) ?? ''
}

export function getStartDate(w: AdoWorkItem): Date | null {
  const v = w.fields['Microsoft.VSTS.Scheduling.StartDate'] as string | undefined
  return v ? new Date(v) : null
}

export function getTargetDate(w: AdoWorkItem): Date | null {
  const v =
    (w.fields['Microsoft.VSTS.Scheduling.TargetDate'] as string | undefined) ??
    (w.fields['Microsoft.VSTS.Scheduling.DueDate'] as string | undefined)
  return v ? new Date(v) : null
}

export function getCreatedDate(w: AdoWorkItem): Date | null {
  const v = w.fields['System.CreatedDate'] as string | undefined
  return v ? new Date(v) : null
}

export function getChangedDate(w: AdoWorkItem): Date | null {
  const v = w.fields['System.ChangedDate'] as string | undefined
  return v ? new Date(v) : null
}

/**
 * Pull the integer id out of a relation URL like
 * https://dev.azure.com/org/_apis/wit/workItems/1234.
 */
export function relationTargetId(url: string): number | null {
  const m = url.match(/workItems\/(\d+)(?:\?|$)/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

export function getStackRank(w: AdoWorkItem): number | null {
  const v = w.fields['Microsoft.VSTS.Common.StackRank'] as number | undefined
  return typeof v === 'number' ? v : null
}

export function getBacklogPriority(w: AdoWorkItem): number | null {
  const v = w.fields['Microsoft.VSTS.Common.BacklogPriority'] as number | undefined
  return typeof v === 'number' ? v : null
}

export function getPriority(w: AdoWorkItem): number | null {
  const v = w.fields['Microsoft.VSTS.Common.Priority'] as number | undefined
  return typeof v === 'number' ? v : null
}

export type SiblingSortMode =
  | 'default'
  | 'stackRank'
  | 'priority'
  | 'title'
  | 'id'
  | 'startDate'
  | 'targetDate'

/**
 * Numeric sort key for sibling ordering. Lower = appears first in layout.
 *
 * - `stackRank` cascades StackRank -> BacklogPriority -> Priority * 1e9 -> id.
 *   This matches what the ADO backlog UI actually shows.
 * - `priority` only uses the 1-4 dropdown, with id as the tie breaker.
 * - String / date modes sort lexicographically with a deterministic id fallback.
 */
export function sortKey(w: AdoWorkItem, mode: SiblingSortMode): number {
  switch (mode) {
    case 'stackRank': {
      const stack = getStackRank(w)
      if (stack != null) return stack
      const backlog = getBacklogPriority(w)
      if (backlog != null) return backlog
      const pri = getPriority(w)
      if (pri != null) return pri * 1e9 + (w.id % 1e6)
      return Number.MAX_SAFE_INTEGER - (1e9 - (w.id % 1e9))
    }
    case 'priority': {
      const pri = getPriority(w)
      const base = pri != null ? pri : 99
      return base * 1e9 + (w.id % 1e9)
    }
    case 'title': {
      const t = (getTitle(w) || '').toLowerCase()
      // Pack the first 6 chars into a numeric key to avoid passing strings around.
      let key = 0
      for (let i = 0; i < Math.min(t.length, 6); i += 1) {
        key = key * 256 + (t.charCodeAt(i) & 0xff)
      }
      return key
    }
    case 'id':
      return w.id
    case 'startDate': {
      const d = getStartDate(w)
      return d ? d.getTime() : Number.MAX_SAFE_INTEGER
    }
    case 'targetDate': {
      const d = getTargetDate(w)
      return d ? d.getTime() : Number.MAX_SAFE_INTEGER
    }
    case 'default':
    default:
      return 0
  }
}
