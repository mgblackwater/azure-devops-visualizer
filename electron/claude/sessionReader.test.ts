import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSession } from './sessionReader'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(__dirname, '__fixtures__', 'sample-session.jsonl')

describe('readSession', () => {
  it('reads turns in order with role/content/model/usage', async () => {
    const detail = await readSession(fixture)
    expect(detail.meta.id).toBe('sess-1')
    expect(detail.turns).toHaveLength(3) // 1 user + 2 assistant
    expect(detail.turns[0].role).toBe('user')
    expect(detail.turns[1].role).toBe('assistant')
    expect(detail.turns[1].model).toBe('claude-opus-4-7')
    expect(detail.turns[1].usage?.inputTokens).toBe(10)
  })
})
