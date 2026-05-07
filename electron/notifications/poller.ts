import { BrowserWindow, Notification } from 'electron'
import { RENDERER_EVENT, type NotificationOpenTarget } from '@shared/contract'
import { getConnectionInfo } from '../auth/tokenStore'
import { listPullRequests } from '../ado/pullRequests'
import { listComments, runWiql } from '../ado/workItems'
import { read, writeSlice } from '../persistence/preferencesStore'

/**
 * Background poller that fires native desktop notifications for two
 * interruptions a user actually wants to know about while away from
 * the app:
 *
 *   1. Pull requests where they're a reviewer and haven't voted yet.
 *   2. New @-mentions on work items.
 *
 * Polls every 60 s on a `setInterval`. Each tick:
 *   - Reads the current connection + the user's pinned default project
 *     (lifted from the disk-backed `preferences.json` slice that the
 *     renderer also writes through). No pinned default → skip the
 *     PR poll (we don't want to randomly poll every project for a
 *     user who hasn't told us which one matters).
 *   - Fans out PR-list and mention-list fetches in parallel.
 *   - Diffs the result against an in-memory + disk-persisted "already
 *     notified" set so a single PR / mention only ever notifies once,
 *     even across app restarts.
 *
 * State is keyed by simple primitives:
 *   - `notifiedPrIds`: set of PR numeric ids we've already notified on.
 *   - `notifiedMentionKeys`: set of `{workItemId}:{commentId}` strings.
 *
 * The first poll after a fresh install (no on-disk state at all)
 * silently primes the sets without firing notifications — otherwise
 * users would get a flood of "you have N unreviewed PRs!" toasts the
 * first time they launch v0.3.1. After that, every poll only
 * notifies on diffs.
 *
 * The poller also provides a count snapshot to the tray via
 * `onCountsChanged` so the menu-bar badge stays in sync. Counts are
 * a *snapshot of the current poll*, not a running tally of unseen
 * items — we surface "PRs awaiting your review" (a stable count
 * derived from ADO state) plus "new mentions in this tick" (a delta
 * that resets each minute as the user is given a chance to look).
 */

const POLL_INTERVAL_MS = 60_000
const MAX_TRACKED_PR_IDS = 500
const MAX_TRACKED_MENTION_KEYS = 500
const STATE_SLICE = 'notificationsState'
/**
 * Per-item comment fan-out concurrency for the mention scan. Matches
 * the limit `getLatestMentions` already uses against ADO so we don't
 * stack two parallel batches that together breach the org's request
 * budget.
 */
const COMMENT_SCAN_CONCURRENCY = 6
/**
 * Cap on how many of the most-recently-changed mention candidates we
 * actually drill into per tick. The WIQL is sorted ChangedDate DESC,
 * so older mentions naturally fall off the bottom — they were already
 * seen on a previous poll anyway, the disk-persisted set stops them
 * re-notifying.
 */
const MENTION_SCAN_LIMIT = 30

interface NotificationsStateShape {
  /** ISO timestamp of the first successful poll. Acts as the
   *  "we've primed; future polls notify normally" flag. */
  primedAt?: string
  notifiedPrIds: number[]
  notifiedMentionKeys: string[]
}

interface CountsSnapshot {
  prs: number
  mentions: number
}

let intervalId: ReturnType<typeof setInterval> | null = null
let mainWindow: BrowserWindow | null = null
let onCountsChanged: ((counts: CountsSnapshot) => void) | null = null
let pollInFlight = false

let notifiedPrIds = new Set<number>()
let notifiedMentionKeys = new Set<string>()
let primed = false

function loadPersistedState(): void {
  try {
    const blob = read()
    const raw = blob[STATE_SLICE] as Partial<NotificationsStateShape> | undefined
    if (!raw || typeof raw !== 'object') return
    primed = typeof raw.primedAt === 'string' && raw.primedAt.length > 0
    if (Array.isArray(raw.notifiedPrIds)) {
      notifiedPrIds = new Set(
        raw.notifiedPrIds.filter((n): n is number => Number.isInteger(n))
      )
    }
    if (Array.isArray(raw.notifiedMentionKeys)) {
      notifiedMentionKeys = new Set(
        raw.notifiedMentionKeys.filter((s): s is string => typeof s === 'string')
      )
    }
  } catch (err) {
    console.warn('[notifications/poller] failed to load persisted state', err)
  }
}

function persistState(): void {
  // Keep the most-recent N entries so the file doesn't grow forever.
  // Sets preserve insertion order in JS, so trimming from the front
  // drops the oldest, which is exactly what we want.
  const prIds = [...notifiedPrIds].slice(-MAX_TRACKED_PR_IDS)
  const mentionKeys = [...notifiedMentionKeys].slice(-MAX_TRACKED_MENTION_KEYS)
  notifiedPrIds = new Set(prIds)
  notifiedMentionKeys = new Set(mentionKeys)
  const next: NotificationsStateShape = {
    primedAt: primed ? new Date().toISOString() : undefined,
    notifiedPrIds: prIds,
    notifiedMentionKeys: mentionKeys
  }
  writeSlice(STATE_SLICE, next)
}

function normalizeOrgKey(orgUrl: string): string {
  return orgUrl.replace(/\/+$/, '').toLowerCase()
}

/**
 * Look up the user's pinned default project for the current org out
 * of the same `preferences.json` blob the renderer writes through.
 * Reading the disk store directly is documented as supported (see
 * `preferencesStore.ts`) — every store function is a plain Node call.
 */
function readPinnedProjectId(orgUrl: string): string | null {
  try {
    const blob = read()
    const prefs = blob['preferences'] as
      | { defaultProjectByOrg?: Record<string, string> }
      | undefined
    return prefs?.defaultProjectByOrg?.[normalizeOrgKey(orgUrl)] ?? null
  } catch {
    return null
  }
}

/**
 * Strip a trailing parenthetical (e.g. `(Acme)`) from an ADO display
 * name so substring matches against comment text behave the same way
 * as the renderer's `normalizeMentionName` does for the Mentions tab.
 * Duplicated here (rather than importing from `src/utils/wiql.ts`) so
 * the main process doesn't reach across the renderer boundary.
 */
function normalizeMentionName(displayName: string): string {
  return displayName.replace(/\s*\(.*?\)\s*$/, '').trim()
}

function buildMentionsWiql(displayName: string): string {
  const trimmed = normalizeMentionName(displayName).replace(/'/g, "''")
  if (!trimmed) {
    return 'SELECT [System.Id] FROM WorkItems WHERE [System.Id] = -1'
  }
  return [
    'SELECT [System.Id]',
    'FROM WorkItems',
    'WHERE [System.TeamProject] = @project',
    "  AND [System.State] <> 'Removed'",
    `  AND [System.History] CONTAINS '${trimmed}'`,
    'ORDER BY [System.ChangedDate] DESC'
  ].join('\n')
}

interface NewMention {
  workItemId: number
  commentId: number
  /** Plain-text snippet of the comment body for the OS notification. */
  snippet: string
  author?: string
  projectId: string
}

function htmlToPreview(html: string, maxChars = 140): string {
  // Mirrors the htmlToSnippet in workItems.ts but trimmed for the
  // narrower body of an OS notification banner.
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped.length <= maxChars) return stripped
  const cut = stripped.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut) + '…'
}

/** Concurrency-limited fan-out over the candidate work-item ids. */
async function scanWorkItemMentions(args: {
  projectId: string
  ids: number[]
  needle: string
}): Promise<{ allKeys: Set<string>; perItemNewest: Map<number, { commentId: number; snippet: string; author?: string; createdMs: number }> }> {
  const allKeys = new Set<string>()
  const perItemNewest = new Map<
    number,
    { commentId: number; snippet: string; author?: string; createdMs: number }
  >()
  let cursor = 0
  const workers: Promise<void>[] = []
  const workerCount = Math.min(COMMENT_SCAN_CONCURRENCY, args.ids.length)
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++
          if (idx >= args.ids.length) return
          const id = args.ids[idx]
          try {
            const { comments } = await listComments({
              projectId: args.projectId,
              id
            })
            for (const c of comments) {
              if (typeof c.id !== 'number') continue
              if (!c.text) continue
              if (!c.text.toLowerCase().includes(args.needle)) continue
              const key = `${id}:${c.id}`
              allKeys.add(key)
              const ts = c.createdDate ? Date.parse(c.createdDate) : NaN
              const existing = perItemNewest.get(id)
              if (!existing || (Number.isFinite(ts) && ts > existing.createdMs)) {
                perItemNewest.set(id, {
                  commentId: c.id,
                  snippet: htmlToPreview(c.text),
                  author: c.createdBy?.displayName,
                  createdMs: Number.isFinite(ts) ? ts : 0
                })
              }
            }
          } catch {
            // Per-item failures (404, permission) shouldn't sink the
            // whole tick — we just won't notify for that item this round.
          }
        }
      })()
    )
  }
  await Promise.all(workers)
  return { allKeys, perItemNewest }
}

interface NewPr {
  pullRequestId: number
  title: string
  projectId: string
  repositoryId?: string
  /** Display name of whoever opened the PR — anchors the notification body. */
  authorName?: string
}

/**
 * Construct + show a desktop notification, honouring the
 * "mute when focused" rule. Returns true when the notification was
 * actually fired so the caller can decide whether to bump the
 * "shown count" or persist the dedup key (we always persist the dedup
 * key — see callsites — so the user isn't re-pinged later when they
 * happen to be looking).
 */
function emitNotification(args: {
  title: string
  body: string
  target: NotificationOpenTarget
}): void {
  if (isMainWindowFocused()) {
    // The user is actively looking at the app. Skip the toast — the
    // tray badge / in-app counters carry the signal instead.
    return
  }
  if (!Notification.isSupported()) return
  try {
    const n = new Notification({
      title: args.title,
      body: args.body,
      silent: false
    })
    n.on('click', () => {
      focusMainWindow()
      sendOpenTarget(args.target)
    })
    n.show()
  } catch (err) {
    console.warn('[notifications/poller] failed to show notification', err)
  }
}

function isMainWindowFocused(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  return mainWindow.isVisible() && mainWindow.isFocused()
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function sendOpenTarget(target: NotificationOpenTarget): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(RENDERER_EVENT.NotificationOpenTarget, target)
}

async function pollOnce(): Promise<void> {
  if (pollInFlight) return
  pollInFlight = true
  try {
    const conn = await getConnectionInfo()
    if (!conn.hasToken || !conn.organizationUrl) return
    const userId = conn.authenticatedUser?.id
    const displayName = conn.authenticatedUser?.displayName
    const projectId = readPinnedProjectId(conn.organizationUrl)
    // No pinned default project: the brief explicitly says skip the
    // PR poll in that case (we'd otherwise need to fan out across
    // every project the user can see, which is wasteful and noisy).
    // The mention scan is also project-scoped through the same WIQL,
    // so we skip it too.
    if (!projectId) {
      reportCounts({ prs: 0, mentions: 0 })
      return
    }

    const [prResult, mentionResult] = await Promise.allSettled([
      pollPullRequests({ projectId, userId }),
      pollMentions({ projectId, displayName })
    ])

    const prInfo = prResult.status === 'fulfilled'
      ? prResult.value
      : { awaitingCount: 0, newPrs: [] as NewPr[] }
    if (prResult.status === 'rejected') {
      console.warn('[notifications/poller] PR poll failed', prResult.reason)
    }
    const mentionInfo = mentionResult.status === 'fulfilled'
      ? mentionResult.value
      : { newMentions: [] as NewMention[] }
    if (mentionResult.status === 'rejected') {
      console.warn('[notifications/poller] mention poll failed', mentionResult.reason)
    }

    if (!primed) {
      // First successful poll on a fresh install — record everything we
      // saw as "already notified" without actually firing toasts. Future
      // polls then notify only on diffs.
      for (const pr of prInfo.newPrs) notifiedPrIds.add(pr.pullRequestId)
      for (const m of mentionInfo.newMentions) {
        notifiedMentionKeys.add(`${m.workItemId}:${m.commentId}`)
      }
      primed = true
      persistState()
      reportCounts({ prs: prInfo.awaitingCount, mentions: 0 })
      return
    }

    let stateDirty = false
    for (const pr of prInfo.newPrs) {
      const id = pr.pullRequestId
      if (notifiedPrIds.has(id)) continue
      const target: NotificationOpenTarget = {
        kind: 'pr',
        id,
        projectId: pr.projectId,
        repositoryId: pr.repositoryId
      }
      emitNotification({
        title: 'PR awaiting your review',
        body: pr.authorName
          ? `${pr.authorName}: ${pr.title}`
          : pr.title,
        target
      })
      notifiedPrIds.add(id)
      stateDirty = true
    }
    let newMentionCount = 0
    for (const m of mentionInfo.newMentions) {
      const key = `${m.workItemId}:${m.commentId}`
      if (notifiedMentionKeys.has(key)) continue
      const target: NotificationOpenTarget = {
        kind: 'workItem',
        id: m.workItemId,
        projectId: m.projectId
      }
      emitNotification({
        title: m.author ? `New mention from ${m.author}` : 'New mention',
        body: m.snippet || `Someone mentioned you on work item #${m.workItemId}`,
        target
      })
      notifiedMentionKeys.add(key)
      stateDirty = true
      newMentionCount += 1
    }
    if (stateDirty) persistState()
    reportCounts({ prs: prInfo.awaitingCount, mentions: newMentionCount })
  } catch (err) {
    console.warn('[notifications/poller] tick failed', err)
  } finally {
    pollInFlight = false
  }
}

async function pollPullRequests(args: {
  projectId: string
  userId?: string
}): Promise<{ awaitingCount: number; newPrs: NewPr[] }> {
  if (!args.userId) {
    // No resolved identity → ADO would 4xx on `searchCriteria.reviewerId`,
    // and there's no useful way to filter "awaiting MY review" anyway.
    return { awaitingCount: 0, newPrs: [] }
  }
  const { pullRequests } = await listPullRequests({
    projectId: args.projectId,
    status: 'active',
    reviewerId: args.userId,
    top: 100
  })
  const awaiting = pullRequests.filter((pr) => {
    if (pr.status !== 'active') return false
    const me = pr.reviewers?.find((r) => r.id === args.userId)
    if (!me) return false
    return me.vote === 0
  })
  const newPrs: NewPr[] = awaiting.map((pr) => ({
    pullRequestId: pr.pullRequestId,
    title: pr.title,
    projectId: args.projectId,
    repositoryId: pr.repository?.id,
    authorName: pr.createdBy?.displayName
  }))
  return { awaitingCount: awaiting.length, newPrs }
}

async function pollMentions(args: {
  projectId: string
  displayName?: string
}): Promise<{ newMentions: NewMention[] }> {
  if (!args.displayName) return { newMentions: [] }
  const wiql = buildMentionsWiql(args.displayName)
  const wiqlResult = await runWiql({
    projectId: args.projectId,
    wiql,
    top: MENTION_SCAN_LIMIT
  })
  const ids = (wiqlResult.workItems ?? [])
    .map((w) => w.id)
    .slice(0, MENTION_SCAN_LIMIT)
  if (ids.length === 0) return { newMentions: [] }
  const needle = normalizeMentionName(args.displayName).toLowerCase()
  if (!needle) return { newMentions: [] }
  const { perItemNewest } = await scanWorkItemMentions({
    projectId: args.projectId,
    ids,
    needle
  })
  const newMentions: NewMention[] = []
  for (const [workItemId, info] of perItemNewest) {
    newMentions.push({
      workItemId,
      commentId: info.commentId,
      snippet: info.snippet,
      author: info.author,
      projectId: args.projectId
    })
  }
  return { newMentions }
}

function reportCounts(counts: CountsSnapshot): void {
  if (!onCountsChanged) return
  try {
    onCountsChanged(counts)
  } catch (err) {
    console.warn('[notifications/poller] counts callback threw', err)
  }
}

/**
 * Begin the 60-s poll loop. Idempotent — repeated calls are no-ops
 * (the existing interval is preserved). Performs an immediate
 * `triggerOnce` so the tray surface reflects current state without
 * a one-minute warm-up.
 */
export function startPoller(
  window: BrowserWindow,
  opts: { onCountsChanged: (counts: CountsSnapshot) => void }
): void {
  mainWindow = window
  onCountsChanged = opts.onCountsChanged
  loadPersistedState()
  if (intervalId) return
  intervalId = setInterval(() => {
    void pollOnce()
  }, POLL_INTERVAL_MS)
  void pollOnce()
}

export function stopPoller(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
  mainWindow = null
  onCountsChanged = null
}

/**
 * Manual force-poll. Exported so a future "Refresh now" tray menu
 * item / IPC trigger can hit it; not wired into a UI in v0.3.1
 * but already exercised by `startPoller`'s warm-up call so this is
 * tested by the same code path.
 */
export function triggerOnce(): Promise<void> {
  return pollOnce()
}
