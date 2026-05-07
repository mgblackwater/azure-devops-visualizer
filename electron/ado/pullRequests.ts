import { adoFetch, AdoApiError } from './client'
import type { AdoGitRepository, AdoPullRequest } from '@shared/adoTypes'
import type { ListPullRequestsArgs } from '@shared/contract'

interface AdoListResponse<T> {
  count: number
  value: T[]
}

/**
 * Pull requests churn faster than projects/teams but slower than work-
 * item discussions. 30s is enough to keep tab-switching snappy without
 * leaving the user staring at stale data after they hit "refresh" in
 * ADO web. The renderer's RTK-Query layer keeps an additional in-memory
 * cache on top of this for the same reason.
 */
const PR_LIST_TTL_MS = 30_000
const PR_LIST_API_VERSION = '7.1'
const DEFAULT_TOP = 100

/**
 * Repos churn far less than PRs — admins create / rename them
 * occasionally and otherwise the list is stable. Five minutes is the
 * sweet spot: short enough that a freshly-created repo shows up
 * within one tea break, long enough that the renderer's repo-filter
 * dropdown opens instantly on every project switch.
 */
const REPOS_TTL_MS = 5 * 60 * 1000

interface PullRequestsListResponse {
  pullRequests: AdoPullRequest[]
}

/**
 * List pull requests in a project. Filtering happens server-side via
 * `searchCriteria.*` query params so we don't pull the org's entire PR
 * history just to filter on the client.
 *
 * `status: 'all'` is the ADO sentinel for "every status" — passed as
 * the literal string. Omit `creatorId` / `reviewerId` to skip those
 * filters; ADO returns the full set when they're absent.
 *
 * Errors are surfaced as `AdoApiError` so the IPC wrapper can convert
 * them to a structured `IpcError`. We log a one-line `console.warn` on
 * unexpected failures (anything past the basic `NETWORK` /
 * `UNAUTHORIZED` cases) so misconfigured PATs or unexpected ADO 4xx
 * codes don't go silent.
 */
export async function listPullRequests(
  args: ListPullRequestsArgs
): Promise<PullRequestsListResponse> {
  const top = Math.max(1, Math.min(args.top ?? DEFAULT_TOP, 500))
  const query: Record<string, string | number | boolean | undefined> = {
    'searchCriteria.status': args.status ?? 'active',
    $top: top
  }
  if (args.creatorId) query['searchCriteria.creatorId'] = args.creatorId
  if (args.reviewerId) query['searchCriteria.reviewerId'] = args.reviewerId

  // Build a stable cache key from the full filter set. Without this,
  // toggling between "Mine" and "All" would either stomp the same key
  // (if we keyed only on projectId) or never hit cache (if we let the
  // URL builder produce a random ordering).
  const cacheKey = [
    'pullRequests:list',
    args.projectId,
    `repo=${args.repositoryId ?? ''}`,
    `status=${query['searchCriteria.status']}`,
    `creator=${args.creatorId ?? ''}`,
    `reviewer=${args.reviewerId ?? ''}`,
    `top=${top}`
  ].join(':')

  // ADO has *two* PR list endpoints and they're not interchangeable:
  //
  //   - Project-wide: `/{project}/_apis/git/pullrequests` — lists PRs
  //     across every repo in the project. It does NOT honour
  //     `searchCriteria.repositoryId`; passing one is silently
  //     ignored.
  //   - Repo-scoped: `/{project}/_apis/git/repositories/{repo}/pullrequests`
  //     — lists PRs in a single repo. Accepts the same `searchCriteria.*`
  //     filters as the project-wide endpoint.
  //
  // Pick the right one based on whether the renderer narrowed the
  // filter to a specific repo.
  const path = args.repositoryId
    ? `/${encodeURIComponent(args.projectId)}/_apis/git/repositories/${encodeURIComponent(args.repositoryId)}/pullrequests`
    : `/${encodeURIComponent(args.projectId)}/_apis/git/pullrequests`

  try {
    const res = await adoFetch<AdoListResponse<AdoPullRequest>>({
      method: 'GET',
      path,
      apiVersion: PR_LIST_API_VERSION,
      query,
      cacheTtlMs: PR_LIST_TTL_MS,
      cacheKey
    })
    return { pullRequests: res.value }
  } catch (err) {
    if (err instanceof AdoApiError) {
      console.warn(
        '[ado/pullRequests] list failed:',
        err.message,
        { status: err.status, code: err.code, details: err.details }
      )
    } else {
      console.warn(
        '[ado/pullRequests] list failed:',
        err instanceof Error ? err.message : String(err)
      )
    }
    throw err
  }
}

/**
 * List the repositories in a project. Used by the PR list's repo
 * filter dropdown — see `PullRequestsList.tsx`. Lives in this module
 * (rather than its own `git.ts`) because the repo list and PR list
 * are tightly coupled in the app's current mental model: every place
 * that asks "which PRs?" also asks "which repo?". If git surface
 * grows beyond PRs we can split this out then.
 *
 * Cached aggressively (5 min) — repos rarely change, and the dropdown
 * needs to feel instant when the user re-opens the tab.
 */
export async function listRepositories(args: {
  projectId: string
}): Promise<{ repositories: AdoGitRepository[] }> {
  try {
    const res = await adoFetch<AdoListResponse<AdoGitRepository>>({
      method: 'GET',
      path: `/${encodeURIComponent(args.projectId)}/_apis/git/repositories`,
      apiVersion: PR_LIST_API_VERSION,
      cacheTtlMs: REPOS_TTL_MS,
      cacheKey: `git:repositories:${args.projectId}`
    })
    return { repositories: res.value }
  } catch (err) {
    if (err instanceof AdoApiError) {
      console.warn(
        '[ado/pullRequests] listRepositories failed:',
        err.message,
        { status: err.status, code: err.code, details: err.details }
      )
    } else {
      console.warn(
        '[ado/pullRequests] listRepositories failed:',
        err instanceof Error ? err.message : String(err)
      )
    }
    throw err
  }
}
