import { adoFetch } from './client'
import type {
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
