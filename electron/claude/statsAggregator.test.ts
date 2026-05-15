import { describe, it, expect } from 'vitest'
import { aggregateStats } from './statsAggregator'
import type { SessionMeta } from '@shared/claudeTypes'

const baseUsage = {
  inputTokens: 100,
  outputTokens: 200,
  cacheReadTokens: 1000,
  cacheCreateTokens: 50,
  apiEquivalentUsd: 1.5
}

const meta = (over: Partial<SessionMeta>): SessionMeta => ({
  id: 'x',
  cwd: 'D:/p/A',
  projectKey: 'A',
  filePath: 'x.jsonl',
  startedAt: '2026-05-15T08:00:00.000Z',
  endedAt: '2026-05-15T09:00:00.000Z',
  turnCount: 3,
  firstUserPrompt: '',
  models: ['claude-opus-4-7'],
  usage: { ...baseUsage },
  ...over
})

describe('aggregateStats', () => {
  it('groups by date / project / model and sums usage', () => {
    const sessions = [
      meta({ id: 's1' }),
      meta({ id: 's2', projectKey: 'A' }),
      meta({
        id: 's3',
        projectKey: 'B',
        startedAt: '2026-05-16T10:00:00.000Z',
        endedAt: '2026-05-16T11:00:00.000Z'
      })
    ]
    const buckets = aggregateStats(sessions, '2026-05-15', '2026-05-16')
    const a = buckets.find(
      (b) => b.date === '2026-05-15' && b.projectKey === 'A'
    )
    expect(a?.sessions).toBe(2)
    expect(a?.usage.outputTokens).toBe(400)
    const b = buckets.find(
      (bx) => bx.date === '2026-05-16' && bx.projectKey === 'B'
    )
    expect(b?.sessions).toBe(1)
  })

  it('filters sessions outside the range', () => {
    const sessions = [meta({ id: 's1', startedAt: '2026-04-30T00:00:00.000Z' })]
    expect(aggregateStats(sessions, '2026-05-01', '2026-05-31')).toHaveLength(0)
  })
})
