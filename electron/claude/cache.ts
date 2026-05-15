import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { SessionMeta } from '@shared/claudeTypes'

// Bump when summary/journal output semantics change so stale cached
// LLM outputs are auto-discarded. Session index is preserved across bumps.
const CURRENT_VERSION = 2

type CacheFile = {
  version: number
  index: SessionMeta[]
  summaries: Record<string, string>
  journals: Record<string, string>
}

let cache: CacheFile | null = null

function filePath(): string {
  return path.join(app.getPath('userData'), 'claude-cache.json')
}

function load(): CacheFile {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(filePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed?.version === CURRENT_VERSION) {
      cache = parsed as CacheFile
      return cache
    }
    // Older version on disk — keep the session index, drop generated text.
    if (parsed && Array.isArray(parsed.index)) {
      cache = {
        version: CURRENT_VERSION,
        index: parsed.index as SessionMeta[],
        summaries: {},
        journals: {}
      }
      try {
        const target = filePath()
        const tmp = `${target}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8')
        fs.renameSync(tmp, target)
      } catch (err) {
        console.warn('[claude] cache migration persist failed', err)
      }
      return cache
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[claude] cache read failed', err)
    }
  }
  cache = { version: CURRENT_VERSION, index: [], summaries: {}, journals: {} }
  return cache
}

function persist(): void {
  if (!cache) return
  const target = filePath()
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8')
  fs.renameSync(tmp, target)
}

export function readIndex(): SessionMeta[] {
  return load().index
}

export function writeIndex(sessions: SessionMeta[]): void {
  const c = load()
  c.index = sessions
  persist()
}

export function readSummary(sessionId: string): string | null {
  return load().summaries[sessionId] ?? null
}

export function writeSummary(sessionId: string, markdown: string): void {
  const c = load()
  c.summaries[sessionId] = markdown
  persist()
}

export function readJournal(date: string): string | null {
  return load().journals[date] ?? null
}

export function writeJournal(date: string, markdown: string): void {
  const c = load()
  c.journals[date] = markdown
  persist()
}
