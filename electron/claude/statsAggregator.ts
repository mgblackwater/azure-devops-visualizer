import type { SessionMeta, StatsBucket, UsageTotals } from '@shared/claudeTypes'

function localDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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

function addUsage(a: UsageTotals, b: UsageTotals): void {
  a.inputTokens += b.inputTokens
  a.outputTokens += b.outputTokens
  a.cacheReadTokens += b.cacheReadTokens
  a.cacheCreateTokens += b.cacheCreateTokens
  a.apiEquivalentUsd += b.apiEquivalentUsd
}

export function aggregateStats(
  sessions: SessionMeta[],
  rangeStart: string,
  rangeEnd: string
): StatsBucket[] {
  const buckets = new Map<string, StatsBucket>()
  for (const s of sessions) {
    const d = localDate(s.startedAt)
    if (d < rangeStart || d > rangeEnd) continue
    const model = s.models[0] ?? 'unknown'
    const key = `${d}|${s.projectKey}|${model}`
    let b = buckets.get(key)
    if (!b) {
      b = {
        date: d,
        projectKey: s.projectKey,
        model,
        sessions: 0,
        turns: 0,
        usage: emptyUsage()
      }
      buckets.set(key, b)
    }
    b.sessions += 1
    b.turns += s.turnCount
    addUsage(b.usage, s.usage)
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date))
}
