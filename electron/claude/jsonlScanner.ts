import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { SessionMeta, UsageTotals } from '@shared/claudeTypes'
import * as cache from './cache'

type ModelPrice = { in: number; out: number; cacheR: number; cacheW: number }

const PRICE_DEFAULT: ModelPrice = { in: 3, out: 15, cacheR: 0.3, cacheW: 3.75 }

function priceForModel(model: string | undefined): ModelPrice {
  if (!model) return PRICE_DEFAULT
  if (model.includes('haiku')) return { in: 0.8, out: 4, cacheR: 0.08, cacheW: 1 }
  if (model.includes('sonnet')) return { in: 3, out: 15, cacheR: 0.3, cacheW: 3.75 }
  if (model.includes('opus')) return { in: 15, out: 75, cacheR: 1.5, cacheW: 18.75 }
  return PRICE_DEFAULT
}

function deriveProjectKey(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    apiEquivalentUsd: 0
  }
}

export async function parseSessionFile(
  filePath: string
): Promise<SessionMeta | null> {
  let id = ''
  let cwd = ''
  let gitBranch: string | undefined
  let firstUserPrompt = ''
  let startedAt = ''
  let endedAt = ''
  let turnCount = 0
  const models = new Set<string>()
  const usage = emptyUsage()

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    let evt: any
    try {
      evt = JSON.parse(line)
    } catch {
      continue
    }

    const ts = evt.timestamp as string | undefined
    if (ts) {
      if (!startedAt) startedAt = ts
      endedAt = ts
    }

    if (!id && typeof evt.sessionId === 'string') id = evt.sessionId
    if (!cwd && typeof evt.cwd === 'string') cwd = evt.cwd
    if (!gitBranch && typeof evt.gitBranch === 'string') gitBranch = evt.gitBranch

    if (evt.type === 'user' && !firstUserPrompt && evt.message?.role === 'user') {
      const c = evt.message.content
      const text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c
                .filter((b: any) => b?.type === 'text')
                .map((b: any) => b.text)
                .join(' ')
            : ''
      if (text.trim()) firstUserPrompt = text.slice(0, 200)
    }

    if (evt.type === 'assistant') {
      turnCount += 1
      const msg = evt.message ?? {}
      if (typeof msg.model === 'string') models.add(msg.model)
      const u = msg.usage
      if (u) {
        const inT = Number(u.input_tokens ?? 0)
        const outT = Number(u.output_tokens ?? 0)
        const cR = Number(u.cache_read_input_tokens ?? 0)
        const cW = Number(u.cache_creation_input_tokens ?? 0)
        usage.inputTokens += inT
        usage.outputTokens += outT
        usage.cacheReadTokens += cR
        usage.cacheCreateTokens += cW
        const rate = priceForModel(msg.model)
        const turnCost =
          (inT * rate.in + outT * rate.out + cR * rate.cacheR + cW * rate.cacheW) /
          1_000_000
        usage.apiEquivalentUsd += turnCost
      }
    }
  }

  if (!id) return null

  return {
    id,
    cwd,
    projectKey: deriveProjectKey(cwd),
    filePath,
    startedAt: startedAt || '',
    endedAt: endedAt || startedAt || '',
    turnCount,
    firstUserPrompt,
    models: [...models],
    usage,
    gitBranch
  }
}

export async function scanAllSessions(rootDir: string): Promise<SessionMeta[]> {
  const sessions: SessionMeta[] = []
  if (!fs.existsSync(rootDir)) return sessions
  const projectDirs = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(rootDir, d.name))
  for (const dir of projectDirs) {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
    for (const e of entries) {
      const filePath = path.join(dir, e.name)
      try {
        const meta = await parseSessionFile(filePath)
        if (meta) sessions.push(meta)
      } catch (err) {
        console.warn('[claude] failed to parse session', filePath, err)
      }
    }
  }
  return sessions
}

export function defaultClaudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

export async function rescanIncremental(
  rootDir: string
): Promise<{ count: number; durationMs: number }> {
  const t0 = Date.now()
  const existing = new Map(cache.readIndex().map((m) => [m.filePath, m]))
  const fresh: SessionMeta[] = []

  if (!fs.existsSync(rootDir)) {
    cache.writeIndex([])
    return { count: 0, durationMs: Date.now() - t0 }
  }

  const projectDirs = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(rootDir, d.name))

  for (const dir of projectDirs) {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
    for (const e of entries) {
      const filePath = path.join(dir, e.name)
      const stat = fs.statSync(filePath)
      const cached = existing.get(filePath)
      // Cached endedAt at-or-after file mtime means nothing new to read.
      // 1-second tolerance for clock skew on FAT/NTFS.
      if (
        cached &&
        cached.endedAt &&
        new Date(cached.endedAt).getTime() >= stat.mtimeMs - 1000
      ) {
        fresh.push(cached)
        continue
      }
      try {
        const meta = await parseSessionFile(filePath)
        if (meta) fresh.push(meta)
        else if (cached) fresh.push(cached)
      } catch (err) {
        console.warn('[claude] reparse failed', filePath, err)
        if (cached) fresh.push(cached)
      }
    }
  }

  cache.writeIndex(fresh)
  return { count: fresh.length, durationMs: Date.now() - t0 }
}
