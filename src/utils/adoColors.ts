/**
 * Color mapping for Azure DevOps work item types and states.
 * The defaults follow the colors used in the ADO web UI.
 */

const TYPE_COLORS: Record<string, string> = {
  Epic: '#FF7B00',
  Feature: '#773B93',
  'User Story': '#009CCC',
  'Product Backlog Item': '#009CCC',
  Task: '#F2CB1D',
  Bug: '#CC293D',
  Defect: '#CC293D',
  Issue: '#B4009E',
  Impediment: '#B4009E',
  'Test Case': '#004B50',
  Requirement: '#009CCC'
}

const STATE_COLORS: Record<string, string> = {
  New: '#B2B2B2',
  Approved: '#007ACC',
  Committed: '#007ACC',
  Active: '#007ACC',
  Open: '#007ACC',
  Doing: '#F2CB1D',
  'In Progress': '#F2CB1D',
  Resolved: '#FF9D00',
  Done: '#339933',
  Closed: '#339933',
  Removed: '#5D5D5D',
  Cut: '#5D5D5D'
}

const FALLBACK_PALETTE = [
  '#1F77B4',
  '#FF7F0E',
  '#2CA02C',
  '#D62728',
  '#9467BD',
  '#8C564B',
  '#E377C2',
  '#7F7F7F',
  '#BCBD22',
  '#17BECF'
]

function fallbackColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length]
}

export function colorForType(type: string | undefined): string {
  if (!type) return '#888'
  return TYPE_COLORS[type] ?? fallbackColor(`type:${type}`)
}

export function colorForState(state: string | undefined): string {
  if (!state) return '#888'
  return STATE_COLORS[state] ?? fallbackColor(`state:${state}`)
}

export function readableTextColor(hex: string): string {
  const color = hex.replace('#', '')
  if (color.length !== 6) return '#000'
  const r = parseInt(color.slice(0, 2), 16)
  const g = parseInt(color.slice(2, 4), 16)
  const b = parseInt(color.slice(4, 6), 16)
  // Relative luminance per WCAG.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? '#1A1A1A' : '#FFFFFF'
}
