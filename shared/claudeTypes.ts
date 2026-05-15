/**
 * Types shared between the Electron main process and the React renderer
 * for the Claude Session Tracker module. Reads local Claude Code
 * `~/.claude/projects/*.jsonl` files; talks to the `claude -p` CLI for
 * on-demand summaries and daily-journal generation.
 */

export type UsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  apiEquivalentUsd: number
}

export type SessionMeta = {
  id: string
  cwd: string
  projectKey: string
  filePath: string
  startedAt: string
  endedAt: string
  turnCount: number
  firstUserPrompt: string
  models: string[]
  usage: UsageTotals
  gitBranch?: string
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown; id: string }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error?: boolean
    }

export type SessionTurn = {
  role: 'user' | 'assistant'
  timestamp: string
  content: ContentBlock[]
  model?: string
  usage?: UsageTotals
}

export type SessionDetail = {
  meta: SessionMeta
  turns: SessionTurn[]
}

export type StatsBucket = {
  date: string
  projectKey: string
  model: string
  sessions: number
  turns: number
  usage: UsageTotals
}

export type AdoItemRef = {
  id: number
  title: string
  workItemType: string
  state: string
  lastUpdated: string
}

export type ListSessionsArgs = { date?: string; projectKey?: string }
export type GetSessionArgs = { id: string }
export type GetStatsArgs = { rangeStart: string; rangeEnd: string }
export type SummarizeSessionArgs = { id: string; force?: boolean }
export type GenerateJournalArgs = {
  date: string
  adoItems: AdoItemRef[]
  force?: boolean
}

export type SummarizeSessionResult = { markdown: string; cached: boolean }
export type GenerateJournalResult = { markdown: string; cached: boolean }
export type RescanIndexResult = { count: number; durationMs: number }
export type ClaudeCliAvailableResult = { available: boolean; version?: string }

export type TerminalShell =
  | 'wt'
  | 'powershell'
  | 'macos-terminal'
  | 'iterm2'
export type OpenInTerminalArgs = { sessionId: string; shell: TerminalShell }
export type OpenInTerminalResult =
  | { ok: true }
  | { ok: false; error: string }

export type StartInTerminalArgs = {
  cwd: string
  prompt: string
  shell: TerminalShell
}
export type StartInTerminalResult =
  | { ok: true }
  | { ok: false; error: string }

export type PickDirectoryArgs = { defaultPath?: string; title?: string }
export type PickDirectoryResult = { path: string | null }
