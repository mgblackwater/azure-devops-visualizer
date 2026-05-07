import { adoFetch } from './client'
import type {
  AdoIdentity,
  AdoIteration,
  AdoProject,
  AdoSavedQuery,
  AdoTeam,
  AdoTeamMember
} from '@shared/adoTypes'

interface AdoListResponse<T> {
  count: number
  value: T[]
}

/**
 * Members rarely change at the cadence of a comment-composer session.
 * Cache for an hour so opening the picker repeatedly within a session
 * never round-trips the network after the first hit.
 */
const PROJECT_MEMBERS_TTL_MS = 60 * 60 * 1000
const PROJECT_DEFAULT_TEAM_TTL_MS = 60 * 60 * 1000

export async function listProjects(opts?: {
  organizationUrl?: string
  token?: string
}): Promise<AdoProject[]> {
  const res = await adoFetch<AdoListResponse<AdoProject>>({
    path: '/_apis/projects',
    query: { $top: 1000, stateFilter: 'wellFormed' },
    baseUrl: opts?.organizationUrl,
    token: opts?.token,
    cacheTtlMs: 60_000
  })
  return res.value
}

export async function listTeams(projectId: string): Promise<AdoTeam[]> {
  const res = await adoFetch<AdoListResponse<AdoTeam>>({
    path: `/_apis/projects/${encodeURIComponent(projectId)}/teams`,
    query: { $top: 500, $expandIdentity: false },
    cacheTtlMs: 60_000
  })
  return res.value
}

export async function listTeamMembers(
  projectId: string,
  teamId: string
): Promise<AdoTeamMember[]> {
  const res = await adoFetch<AdoListResponse<AdoTeamMember>>({
    path: `/_apis/projects/${encodeURIComponent(projectId)}/teams/${encodeURIComponent(teamId)}/members`,
    query: { $top: 500 },
    cacheTtlMs: 60_000
  })
  return res.value
}

export async function listIterations(
  projectId: string,
  teamId?: string,
  timeframe?: 'current'
): Promise<AdoIteration[]> {
  const teamSegment = teamId ? `/${encodeURIComponent(teamId)}` : ''
  const res = await adoFetch<AdoListResponse<AdoIteration>>({
    path: `/${encodeURIComponent(projectId)}${teamSegment}/_apis/work/teamsettings/iterations`,
    query: timeframe ? { $timeframe: timeframe } : undefined,
    cacheTtlMs: 30_000
  })
  return res.value
}

export async function listSavedQueries(
  projectId: string,
  depth = 2
): Promise<AdoSavedQuery[]> {
  const res = await adoFetch<AdoListResponse<AdoSavedQuery>>({
    path: `/${encodeURIComponent(projectId)}/_apis/wit/queries`,
    query: { $depth: depth, $expand: 'all' },
    cacheTtlMs: 60_000
  })
  return res.value
}

interface ProjectWithCapabilities {
  id: string
  name: string
  defaultTeam?: { id: string; name: string }
}

/**
 * Resolve the project's *default team* id. Used by the comment composer
 * to pick a sensible "all members of the project" approximation for the
 * `@`-mention picker without needing the user to first pick a team.
 *
 * `includeCapabilities=true` is what surfaces `defaultTeam` in the
 * project payload; without that flag the response only carries the
 * basic project record. Cached aggressively — default-team assignment
 * changes are rare admin actions.
 */
async function getProjectDefaultTeamId(
  projectId: string
): Promise<string | undefined> {
  const project = await adoFetch<ProjectWithCapabilities>({
    method: 'GET',
    path: `/_apis/projects/${encodeURIComponent(projectId)}`,
    query: { includeCapabilities: true },
    cacheTtlMs: PROJECT_DEFAULT_TEAM_TTL_MS,
    cacheKey: `project:${projectId}:withCapabilities`
  })
  return project.defaultTeam?.id
}

/**
 * Resolve the identities of the project's default-team members so the
 * comment composer can offer them in the `@`-mention picker.
 *
 * "Project members" in ADO is a fuzzy concept — the closest stable
 * primitive is the default team's roster, which most orgs treat as the
 * project-wide member list. Falls back to the first team in the
 * project when no default is configured (rare, and only on legacy
 * on-prem installs). On any failure resolving membership we return an
 * empty list rather than throw — the composer degrades to recent-
 * contributor-only suggestions, which is still useful.
 */
export async function listProjectMemberIdentities(
  projectId: string
): Promise<AdoIdentity[]> {
  let teamId: string | undefined
  try {
    teamId = await getProjectDefaultTeamId(projectId)
  } catch {
    teamId = undefined
  }
  if (!teamId) {
    try {
      const teams = await listTeams(projectId)
      teamId = teams[0]?.id
    } catch {
      return []
    }
  }
  if (!teamId) return []
  const members = await adoFetch<AdoListResponse<AdoTeamMember>>({
    method: 'GET',
    path: `/_apis/projects/${encodeURIComponent(projectId)}/teams/${encodeURIComponent(teamId)}/members`,
    query: { $top: 500 },
    cacheTtlMs: PROJECT_MEMBERS_TTL_MS,
    cacheKey: `project:${projectId}:members:${teamId}`
  })
  // Surface the bare identity for the composer — callers don't need
  // the `isTeamAdmin` envelope and a flat `AdoIdentity[]` keeps the IPC
  // payload small.
  return members.value
    .map((m) => m.identity)
    .filter((id): id is AdoIdentity => !!id && !!id.displayName)
}
