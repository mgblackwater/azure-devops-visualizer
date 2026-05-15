import fs from 'node:fs'
import readline from 'node:readline'
import type {
  ContentBlock,
  SessionDetail,
  SessionTurn
} from '@shared/claudeTypes'
import { parseSessionFile } from './jsonlScanner'

function normalizeContent(raw: unknown): ContentBlock[] {
  if (typeof raw === 'string') return [{ type: 'text', text: raw }]
  if (!Array.isArray(raw)) return []
  return raw.map((b: any): ContentBlock => {
    if (b?.type === 'text') {
      return { type: 'text', text: String(b.text ?? '') }
    }
    if (b?.type === 'tool_use') {
      return {
        type: 'tool_use',
        name: String(b.name ?? ''),
        input: b.input,
        id: String(b.id ?? '')
      }
    }
    if (b?.type === 'tool_result') {
      return {
        type: 'tool_result',
        tool_use_id: String(b.tool_use_id ?? ''),
        content:
          typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
        is_error: !!b.is_error
      }
    }
    return { type: 'text', text: '' }
  })
}

export async function readSession(filePath: string): Promise<SessionDetail> {
  const meta = await parseSessionFile(filePath)
  if (!meta) throw new Error(`Could not parse session at ${filePath}`)

  const turns: SessionTurn[] = []
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
    if (evt.type !== 'user' && evt.type !== 'assistant') continue
    const msg = evt.message ?? {}
    const u = msg.usage
    turns.push({
      role: evt.type,
      timestamp: evt.timestamp ?? '',
      content: normalizeContent(msg.content),
      model: typeof msg.model === 'string' ? msg.model : undefined,
      usage: u
        ? {
            inputTokens: Number(u.input_tokens ?? 0),
            outputTokens: Number(u.output_tokens ?? 0),
            cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
            cacheCreateTokens: Number(u.cache_creation_input_tokens ?? 0),
            apiEquivalentUsd: 0
          }
        : undefined
    })
  }
  return { meta, turns }
}

export function transcriptForLLM(detail: SessionDetail, maxChars = 50_000): string {
  const lines: string[] = []
  for (const t of detail.turns) {
    const text = t.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) continue
    lines.push(`${t.role.toUpperCase()}: ${text}`)
  }
  const full = lines.join('\n\n')
  if (full.length <= maxChars) return full
  // Long sessions: keep first 20% + last 60%, tail bias because conclusions
  // tend to live near the end of a session.
  const head = full.slice(0, Math.floor(maxChars * 0.2))
  const tail = full.slice(-Math.floor(maxChars * 0.6))
  return `${head}\n\n[…truncated…]\n\n${tail}`
}
