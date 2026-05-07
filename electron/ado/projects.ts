import { adoFetch, AdoApiError } from './client'
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
 * Live identity search via ADO's `IdentityPicker` endpoint — the same
 * one that powers `@`-mention popups in ADO web. Returns identities
 * matching `query` from the entire org (subject to PAT visibility),
 * not just the default team's roster.
 *
 * Cached briefly per-(project,query,top): rapid keystrokes like
 * `a` → `al` → `ali` → `al` should be served from cache on the
 * back-step. We skip caching for an empty query — ADO returns nothing
 * for that case anyway.
 *
 * On any non-network error we surface as an empty list rather than
 * throw, so the composer falls back to its static project-members
 * list and the user still sees suggestions.
 */
const IDENTITY_PICKER_TTL_MS = 60_000
// IdentityPicker is one of the few ADO endpoints that never moved past
// the 5.0 preview line — `7.x` returns 404 on cloud orgs, which used
// to surface here as a silent empty result and made the `@`-mention
// popup look like it was ignoring everyone outside the default team.
// Pin the version explicitly; do not bump without re-verifying against
// dev.azure.com.
const IDENTITY_PICKER_API_VERSION = '5.0-preview.1'

interface IdentityPickerIdentity {
  displayName?: string
  /** GUID — present on most identity types. */
  entityId?: string
  /** Per-collection local id; populated on cloud orgs that mirror the
   *  AAD principal into the org's identity store. */
  localId?: string
  /** Origin (AAD) id — useful as a last-resort stable key for guest
   *  identities the org has never materialised locally. */
  originId?: string
  /** ADO subject descriptor, e.g. `aad.NjUxOjk1ZjI...`. Required for
   *  proper @mention notifications; falls back to entityId otherwise. */
  subjectDescriptor?: string
  mail?: string
  signInAddress?: string
  samAccountName?: string
  image_url?: string
  active?: boolean
  /** Some org configurations return image url under `imageUrl` instead. */
  imageUrl?: string
}

interface IdentityPickerResultGroup {
  queryToken?: string
  identities?: IdentityPickerIdentity[]
}

interface IdentityPickerResponse {
  results?: IdentityPickerResultGroup[]
}

export async function searchIdentitiesByQuery(args: {
  projectId: string
  query: string
  top?: number
}): Promise<{ identities: AdoIdentity[]; queryEcho: string }> {
  const trimmed = args.query.trim()
  if (!trimmed) {
    // ADO IdentityPicker rejects empty queries. The composer should
    // be using `listProjectMemberIdentities` for the no-query state
    // anyway; this guard just keeps the IPC contract honest.
    return { identities: [], queryEcho: '' }
  }
  const top = Math.min(Math.max(args.top ?? 25, 1), 100)
  try {
    const res = await adoFetch<IdentityPickerResponse>({
      method: 'POST',
      // Org-scoped endpoint. ADO accepts a project segment for some
      // identity APIs but IdentityPicker only resolves at the
      // collection (org) level — adding a project prefix here causes
      // a 404 on most cloud orgs.
      path: '/_apis/IdentityPicker/Identities',
      apiVersion: IDENTITY_PICKER_API_VERSION,
      body: {
        query: trimmed,
        // Lowercase string literals are required — IdentityPicker's
        // input validator is case-sensitive and silently treats
        // `'User'` as a typo, returning an empty result group with
        // HTTP 200.
        identityTypes: ['user'],
        // `ims` searches the org's identity store; `source` searches
        // the directory backing the org (e.g. AAD). Both together
        // matches what ADO web requests in the browser.
        operationScopes: ['ims', 'source'],
        options: {
          // Some tenants return [] when `MinResults` exceeds the
          // available match count, so we deliberately keep this at 1.
          MinResults: 1,
          MaxResults: top
        },
        properties: [
          'DisplayName',
          'SignInAddress',
          'Mail',
          'MailNickname',
          'SamAccountName',
          'SubjectDescriptor',
          'Department',
          'JobTitle',
          'Active'
        ]
      },
      cacheTtlMs: IDENTITY_PICKER_TTL_MS,
      cacheKey: `identityPicker:${args.projectId}:${trimmed.toLowerCase()}:${top}`
    })
    const identities = (res.results ?? [])
      .flatMap((g) => g.identities ?? [])
      // Treat *missing* `active` as active. The filter is only there
      // to drop deactivated/disabled accounts; identities returned
      // without an `active` field at all are the common case for
      // many tenants and must not be excluded.
      .filter((i) => i.active !== false && !!i.displayName)
      .map((i) => identityFromPicker(i))
    return { identities, queryEcho: trimmed }
  } catch (err) {
    // Swallow so the composer still shows the static project-members
    // list, but leave one quiet warning so a misconfigured PAT or a
    // future API-version regression doesn't go completely dark.
    console.warn(
      '[ado/identityPicker] search failed:',
      err instanceof Error ? err.message : String(err),
      err instanceof AdoApiError
        ? { status: err.status, code: err.code, details: err.details }
        : undefined
    )
    return { identities: [], queryEcho: trimmed }
  }
}

function identityFromPicker(p: IdentityPickerIdentity): AdoIdentity {
  // Fall back through every plausible stable id the picker may have
  // populated. On certain tenants (notably guest users that haven't
  // been materialised into the org's identity store), `entityId` is
  // missing and only `localId` / `originId` are set — dropping those
  // rows would silently cut the search down to next-to-nothing.
  const stableId =
    p.entityId || p.localId || p.originId || p.subjectDescriptor || ''
  return {
    displayName: p.displayName ?? '',
    uniqueName: p.mail || p.signInAddress || p.samAccountName,
    id: stableId,
    descriptor: p.subjectDescriptor,
    imageUrl: p.image_url ?? p.imageUrl
  }
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
