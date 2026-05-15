import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSessionFile } from './jsonlScanner'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(__dirname, '__fixtures__', 'sample-session.jsonl')

describe('parseSessionFile', () => {
  it('extracts session metadata from a tiny session', async () => {
    const meta = await parseSessionFile(fixture)
    expect(meta).not.toBeNull()
    if (!meta) return
    expect(meta.id).toBe('sess-1')
    expect(meta.cwd).toBe('D:/iHis/Source/GPConnect')
    expect(meta.projectKey).toBe('GPConnect')
    expect(meta.turnCount).toBe(2)
    expect(meta.firstUserPrompt).toContain('refactor the patient invoice')
    expect(meta.models).toEqual(['claude-opus-4-7'])
    expect(meta.startedAt).toBe('2026-05-15T08:00:00.000Z')
    expect(meta.endedAt).toBe('2026-05-15T08:00:10.000Z')
    expect(meta.usage.inputTokens).toBe(12)
    expect(meta.usage.outputTokens).toBe(28)
    expect(meta.usage.cacheReadTokens).toBe(220)
    expect(meta.usage.cacheCreateTokens).toBe(5)
    expect(meta.gitBranch).toBe('feature/x')
  })
})
