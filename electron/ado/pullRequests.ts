import { adoFetch, AdoApiError } from './client'
import type {
  AdoGitRepository,
  AdoPullRequest,
  AdoPullRequestChange,
  AdoPullRequestChangeKind,
  AdoPullRequestIteration,
  PullRequestChangesSummary
} from '@shared/adoTypes'
import type {
  GetPullRequestChangesArgs,
  ListPullRequestsArgs
} from '@shared/contract'

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
 * Five minutes — same TTL as the renderer's RTK-Query cache so the
 * "open dialog → flip details switch → close" trip-loop only ever
 * round-trips on the very first open. PR diffs are immutable for any
 * given iteration, but a new iteration appears whenever the source
 * branch is force-pushed; the iterations endpoint we hit first will
 * pick up that new id, which becomes part of the cache key for the
 * follow-up changes call, so this is safe to cache aggressively.
 */
const PR_CHANGES_TTL_MS = 5 * 60 * 1000

/**
 * Hard cap on the number of file changes we ask ADO for in a single
 * call. The renderer currently only renders the first 5 in the share
 * dialog, but we keep the upstream cap at 200 so that `totalFiles`
 * stays accurate for big PRs and a future polish (paged file list)
 * doesn't have to widen the contract.
 */
const PR_CHANGES_TOP = 200

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

/* ---------- pull-request changes summary (v0.3.1: WhatsApp share) ---------- */

/**
 * Raw shape of one entry in the iteration-changes response. ADO calls
 * the array `changeEntries` (not `value` like most list endpoints) and
 * expresses the change kind as a comma-separated string so it can mark
 * a single file as e.g. `'delete,sourceRename'`. We narrow the
 * contract surface to the bits the share dialog actually needs and
 * normalise the kind via `mapChangeType` below.
 */
interface RawIterationChange {
  changeId?: number
  changeType?: string
  item?: { path?: string }
}

interface IterationChangesResponse {
  changeEntries?: RawIterationChange[]
  /** Some api-versions / on-prem builds use `value`; tolerate both. */
  value?: RawIterationChange[]
}

/**
 * Map ADO's comma-separated `changeType` string to the small enum the
 * UI renders. `sourceRename` / `targetRename` collapse to `'rename'`
 * because the share dialog doesn't need to distinguish the two
 * directions; everything else lands on the most "destructive"
 * applicable category in roughly the order the user cares about
 * (delete > add > rename > edit).
 */
function mapChangeType(raw: string | undefined): AdoPullRequestChangeKind {
  if (!raw) return 'other'
  const tokens = raw
    .toLowerCase()
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  if (tokens.includes('delete')) return 'delete'
  if (tokens.includes('add')) return 'add'
  if (tokens.includes('sourcerename') || tokens.includes('targetrename') || tokens.includes('rename')) {
    return 'rename'
  }
  if (tokens.includes('edit')) return 'edit'
  return 'other'
}

/**
 * Build a summary of every file touched by the PR's *latest*
 * iteration. Two ADO calls in sequence:
 *
 *   1. List iterations → take the highest `id`. ADO numbers them from
 *      1 in chronological order; we don't reorder, the server already
 *      does, but we still pick the max defensively in case a future
 *      api-version starts paginating.
 *   2. List changes for that iteration. Returns up to `PR_CHANGES_TOP`
 *      file entries; the renderer caps the rendered list to 5 and
 *      shows "…and N more" beyond that.
 *
 * The iteration-changes endpoint does NOT include per-file line
 * counts. Those live on the heavier `commits/{id}/changes` and diff
 * endpoints and would multiply round-trips by the number of changed
 * files. For v0.3.1 we ship without line counts and let the share
 * dialog fall back to the simpler `M/A/D path` rendering.
 *
 * TODO(v0.3.2+): once we add a per-file `addedLines` / `deletedLines`
 * source, populate `summary.totalAdded` / `totalDeleted` and the
 * per-file `addedLines` / `deletedLines` here. The shared types are
 * already shaped to accept them, so the renderer will start showing
 * the richer format automatically.
 *
 * One quiet `console.warn` on failure — the share dialog handles a
 * thrown error by leaving the user with the minimal template.
 */
export async function getPullRequestChangesSummary(
  args: GetPullRequestChangesArgs
): Promise<{ summary: PullRequestChangesSummary }> {
  const projectSeg = encodeURIComponent(args.projectId)
  const repoSeg = encodeURIComponent(args.repositoryId)
  const prSeg = encodeURIComponent(String(args.pullRequestId))

  try {
    // 1) iterations
    const iterationsPath = `/${projectSeg}/_apis/git/repositories/${repoSeg}/pullRequests/${prSeg}/iterations`
    const iterationsRes = await adoFetch<AdoListResponse<AdoPullRequestIteration>>({
      method: 'GET',
      path: iterationsPath,
      apiVersion: PR_LIST_API_VERSION,
      cacheTtlMs: PR_CHANGES_TTL_MS,
      cacheKey: `pullRequests:iterations:${args.projectId}:${args.repositoryId}:${args.pullRequestId}`
    })
    const iterations = iterationsRes.value ?? []
    if (iterations.length === 0) {
      return {
        summary: { totalFiles: 0, files: [] }
      }
    }
    const latestIterationId = iterations.reduce(
      (max, it) => (typeof it.id === 'number' && it.id > max ? it.id : max),
      0
    )
    if (latestIterationId <= 0) {
      return {
        summary: { totalFiles: 0, files: [] }
      }
    }

    // 2) changes for the latest iteration
    const changesPath = `/${projectSeg}/_apis/git/repositories/${repoSeg}/pullRequests/${prSeg}/iterations/${latestIterationId}/changes`
    const changesRes = await adoFetch<IterationChangesResponse>({
      method: 'GET',
      path: changesPath,
      apiVersion: PR_LIST_API_VERSION,
      query: { $top: PR_CHANGES_TOP },
      cacheTtlMs: PR_CHANGES_TTL_MS,
      cacheKey: `pullRequests:changes:${args.projectId}:${args.repositoryId}:${args.pullRequestId}:it=${latestIterationId}`
    })
    const rawEntries = changesRes.changeEntries ?? changesRes.value ?? []
    const files: AdoPullRequestChange[] = []
    for (const entry of rawEntries) {
      const path = entry.item?.path
      if (!path) continue
      // ADO surfaces the PR's virtual `/` root directory as its own
      // entry on the very first iteration; skip pure-folder rows so
      // the file list reads as actual file changes.
      if (path === '/' || path.endsWith('/')) continue
      files.push({
        path,
        changeType: mapChangeType(entry.changeType)
      })
    }
    return {
      summary: {
        totalFiles: files.length,
        files
      }
    }
  } catch (err) {
    // One quiet warn; the renderer falls back to the minimal template
    // and the user can still send the PR link without details.
    if (err instanceof AdoApiError) {
      console.warn(
        '[ado/pullRequests] getPullRequestChangesSummary failed:',
        err.message,
        { status: err.status, code: err.code }
      )
    } else {
      console.warn(
        '[ado/pullRequests] getPullRequestChangesSummary failed:',
        err instanceof Error ? err.message : String(err)
      )
    }
    throw err
  }
}
