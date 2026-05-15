import { describe, it, expect } from 'vitest'
import { buildJournalPayload } from './adoCorrelator'
import type { SessionMeta, AdoItemRef } from '@shared/claudeTypes'

describe('buildJournalPayload', () => {
  it('includes session summaries and ADO items in a single string', () => {
    const sessions: SessionMeta[] = [
      {
        id: 's1',
        cwd: 'D:/x/GPConnect',
        projectKey: 'GPConnect',
        filePath: 'x',
        startedAt: '2026-05-15T08:00:00Z',
        endedAt: '2026-05-15T09:00:00Z',
        turnCount: 2,
        firstUserPrompt: 'fix invoice',
        models: ['claude-opus-4-7'],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          apiEquivalentUsd: 0
        }
      }
    ]
    const summaries = ['Worked on patient invoice fix.']
    const ado: AdoItemRef[] = [
      {
        id: 231441,
        title: 'Patient Invoice Details',
        workItemType: 'PBI',
        state: 'Active',
        lastUpdated: '2026-05-15T07:00:00Z'
      }
    ]
    const out = buildJournalPayload(sessions, summaries, ado)
    expect(out).toContain('# Sessions')
    expect(out).toContain('Worked on patient invoice fix.')
    expect(out).toContain('# ADO Items')
    expect(out).toContain('#231441')
    expect(out).toContain('Patient Invoice Details')
  })

  it('handles empty ADO list', () => {
    const out = buildJournalPayload([], [], [])
    expect(out).toContain('# Sessions')
    expect(out).toContain('# ADO Items')
    expect(out).toMatch(/no ado items/i)
  })
})
