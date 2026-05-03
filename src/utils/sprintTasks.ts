/**
 * Sprint-view task taxonomy. Most teams in this codebase create a fixed set
 * of standard child tasks under every PBI:
 *
 *   - Frontend Development
 *   - Backend Development
 *   - Testing
 *   - FE Code Review
 *   - BE Code Review
 *
 * Title naming varies a bit (FE / Frontend, CR / Code Review, etc.), so we
 * match each kind with a handful of regexes against the task title. Anything
 * we don't recognise lands in the "Other" bucket so it's still surfaced.
 */

import { getState, getTitle, getType } from './workItemFields'
import type { AdoWorkItem } from '@shared/adoTypes'

export type StandardTaskKind =
  | 'feDev'
  | 'beDev'
  | 'testing'
  | 'feReview'
  | 'beReview'

export type TaskBucket = StandardTaskKind | 'other'

export interface TaskColumnDef {
  key: TaskBucket
  label: string
  /** Short label used inside compact cells. */
  short: string
  /** Tone color used for the column header tab. */
  tone: 'fe' | 'be' | 'qa' | 'review-fe' | 'review-be' | 'neutral'
}

export const TASK_COLUMNS: ReadonlyArray<TaskColumnDef> = [
  { key: 'feDev', label: 'Frontend Dev', short: 'FE Dev', tone: 'fe' },
  { key: 'beDev', label: 'Backend Dev', short: 'BE Dev', tone: 'be' },
  { key: 'testing', label: 'Testing', short: 'Test', tone: 'qa' },
  { key: 'feReview', label: 'FE Code Review', short: 'FE CR', tone: 'review-fe' },
  { key: 'beReview', label: 'BE Code Review', short: 'BE CR', tone: 'review-be' },
  { key: 'other', label: 'Other', short: 'Other', tone: 'neutral' }
]

/** Background color for the column header tone. */
export const TASK_COLUMN_TONE: Record<TaskColumnDef['tone'], string> = {
  fe: '#1A73E8',
  be: '#0F9D58',
  qa: '#F9AB00',
  'review-fe': '#7B61FF',
  'review-be': '#00A39E',
  neutral: '#9AA0A6'
}

// Order matters: more-specific patterns are tested first so e.g.
// "FE Code Review" doesn't get caught by the FE-Dev matcher.
const KIND_MATCHERS: Array<{ kind: StandardTaskKind; regex: RegExp }> = [
  // Reviews — must come before "dev" so "FE Code Review" wins.
  {
    kind: 'feReview',
    regex: /(?:\bfe\b|frontend|front[-\s]?end).{0,20}\b(?:code\s*review|cr)\b/i
  },
  {
    kind: 'beReview',
    regex: /(?:\bbe\b|backend|back[-\s]?end).{0,20}\b(?:code\s*review|cr)\b/i
  },
  // Generic "Code Review" without an FE/BE prefix — best-effort fallback.
  { kind: 'feReview', regex: /^code\s*review\s*[-:]\s*(?:fe|frontend)/i },
  { kind: 'beReview', regex: /^code\s*review\s*[-:]\s*(?:be|backend)/i },

  {
    kind: 'feDev',
    regex: /(?:\bfe\b|frontend|front[-\s]?end).{0,20}\b(?:dev(?:elopment)?|implementation)\b/i
  },
  {
    kind: 'beDev',
    regex: /(?:\bbe\b|backend|back[-\s]?end).{0,20}\b(?:dev(?:elopment)?|implementation)\b/i
  },
  // Bare "FE Dev" / "BE Dev" with no qualifier word.
  { kind: 'feDev', regex: /^\s*(?:fe|frontend)\s*[-:\s]\s*dev/i },
  { kind: 'beDev', regex: /^\s*(?:be|backend)\s*[-:\s]\s*dev/i },

  {
    kind: 'testing',
    regex: /\b(?:testing|qa|quality\s*assurance|test\s*case[s]?|tester)\b/i
  },
  { kind: 'testing', regex: /^\s*test\s*$/i }
]

export function classifyTask(title: string): TaskBucket {
  const t = title.trim()
  if (!t) return 'other'
  for (const { kind, regex } of KIND_MATCHERS) {
    if (regex.test(t)) return kind
  }
  return 'other'
}

const TASK_TYPES = new Set(['Task', 'Bug', 'Defect'])

/**
 * Types that are eligible to appear as a top-level *row* in the Sprint view.
 *
 * Bug / Defect are intentionally included even though they're sometimes
 * configured under the Task category — we let SprintPage de-dup any bug
 * that turns out to be nested under another row, so a Bug in the
 * Requirement category becomes its own row while a Bug nested under a PBI
 * is shown as that PBI's child.
 */
export const SPRINT_ROW_TYPES: ReadonlySet<string> = new Set([
  'Product Backlog Item',
  'User Story',
  'Requirement',
  'Bug',
  'Defect'
])

export function isSprintRowKind(w: AdoWorkItem): boolean {
  return SPRINT_ROW_TYPES.has(getType(w))
}

/** Kept for backwards compatibility; same set as `isSprintRowKind`. */
export function isPbiLike(w: AdoWorkItem): boolean {
  return isSprintRowKind(w)
}

export function isTaskLike(w: AdoWorkItem): boolean {
  return TASK_TYPES.has(getType(w))
}

/**
 * Buckets a list of child work items into the 5 standard task columns plus
 * an "other" column.
 */
export function bucketTasks(tasks: AdoWorkItem[]): Record<TaskBucket, AdoWorkItem[]> {
  const out: Record<TaskBucket, AdoWorkItem[]> = {
    feDev: [],
    beDev: [],
    testing: [],
    feReview: [],
    beReview: [],
    other: []
  }
  for (const t of tasks) {
    out[classifyTask(getTitle(t))].push(t)
  }
  return out
}

const DONE_STATES = new Set([
  'Done',
  'Closed',
  'Resolved',
  'Completed',
  'Removed'
])

export function isDoneState(state: string): boolean {
  return DONE_STATES.has(state)
}

/**
 * Three-lane Kanban mapping. ADO ships many process templates with different
 * state names — the most common are listed below. Anything we don't know is
 * defaulted to 'todo' so it stays visible rather than silently dropping out.
 */
export type KanbanLane = 'todo' | 'inProgress' | 'done'

export interface KanbanLaneDef {
  key: KanbanLane
  label: string
  tone: string
}

export const KANBAN_LANES: ReadonlyArray<KanbanLaneDef> = [
  { key: 'todo', label: 'To Do', tone: '#5F6368' },
  { key: 'inProgress', label: 'In Progress', tone: '#1A73E8' },
  { key: 'done', label: 'Done', tone: '#188038' }
]

const STATE_LANE: Record<string, KanbanLane> = {
  // To Do
  New: 'todo',
  'To Do': 'todo',
  Approved: 'todo',
  Open: 'todo',
  Proposed: 'todo',
  // In Progress (anything in-flight, including resolved/awaiting-review)
  Active: 'inProgress',
  Doing: 'inProgress',
  'In Progress': 'inProgress',
  Committed: 'inProgress',
  'Pending Review': 'inProgress',
  Resolved: 'inProgress',
  // Done
  Done: 'done',
  Closed: 'done',
  Completed: 'done',
  Removed: 'done',
  Cut: 'done'
}

export function laneOf(state: string): KanbanLane {
  return STATE_LANE[state] ?? 'todo'
}

/**
 * Pick the best ADO `System.State` name for a card dropped into a lane.
 *
 * ADO process templates differ ("To Do" vs "New" vs "Approved", "Active"
 * vs "In Progress", "Done" vs "Closed" vs "Resolved"…), so instead of
 * hard-coding one mapping per lane we look at what other items of the
 * same type already use in that lane and pick the most common one. This
 * makes the patch round-trip safely against any custom process the team
 * has configured.
 *
 * Fallbacks: same-type → any-type in the lane → conventional default.
 */
export function inferLaneState(
  itemType: string,
  targetLane: KanbanLane,
  allItems: AdoWorkItem[]
): string {
  function mostCommon(states: string[]): string | undefined {
    if (states.length === 0) return undefined
    const counts = new Map<string, number>()
    for (const s of states) counts.set(s, (counts.get(s) ?? 0) + 1)
    let best = states[0]
    let bestCount = 0
    for (const [s, c] of counts) {
      if (c > bestCount) {
        best = s
        bestCount = c
      }
    }
    return best
  }

  const sameType = allItems
    .filter(
      (w) => getType(w) === itemType && laneOf(getState(w)) === targetLane
    )
    .map((w) => getState(w))
  const sameTypePick = mostCommon(sameType)
  if (sameTypePick) return sameTypePick

  const anyInLane = allItems
    .filter((w) => laneOf(getState(w)) === targetLane)
    .map((w) => getState(w))
  const anyPick = mostCommon(anyInLane)
  if (anyPick) return anyPick

  if (targetLane === 'todo') return 'To Do'
  if (targetLane === 'done') return 'Done'
  return 'Active'
}

/**
 * WIQL that returns every backlog row (PBI / User Story / Requirement /
 * Bug / Defect) in a given iteration together with their direct hierarchy
 * children.
 *
 * Notes:
 * - The Source filter is built from `SPRINT_ROW_TYPES` so the WIQL stays
 *   in sync with the row-eligibility check on the client.
 * - We deliberately don't filter `[Target].[System.WorkItemType]` here.
 *   Any non-standard child (Issue, Test Case, ad-hoc Task naming, etc.)
 *   should still surface; we bucket types client-side.
 * - `MODE (MayContain)` keeps rows that have no children at all visible
 *   in the result, so the matrix can still draw an empty row.
 * - Backslashes in iteration paths don't need escaping inside WIQL string
 *   literals — only single quotes do.
 */
export function buildSprintWiql(iterationPath: string): string {
  const escaped = iterationPath.replace(/'/g, "''")
  const sourceTypes = [...SPRINT_ROW_TYPES]
    .map((t) => `'${t}'`)
    .join(', ')
  return [
    'SELECT [System.Id]',
    'FROM WorkItemLinks',
    `WHERE [Source].[System.IterationPath] = '${escaped}'`,
    `  AND [Source].[System.WorkItemType] IN (${sourceTypes})`,
    "  AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'",
    'ORDER BY [System.Id]',
    'MODE (MayContain)'
  ].join('\n')
}
