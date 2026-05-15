import { spawn } from 'node:child_process'
import fs from 'node:fs'
import type { ClaudeCliAvailableResult } from '@shared/claudeTypes'

// shell:true on Windows joins args with spaces into a cmd.exe command
// line WITHOUT quoting them, so any arg containing a space (paths under
// "Personal Projects", multi-word values like "Edit Write Bash") gets
// split and corrupts the command. Quote those manually.
function quoteForWindowsShell(arg: string): string {
  if (process.platform !== 'win32') return arg
  if (!/\s/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}

export type ClaudeResult =
  | { ok: true; markdown: string; costUsd: number; durationMs: number }
  | { ok: false; error: string }

export async function checkClaudeCliAvailable(): Promise<ClaudeCliAvailableResult> {
  return new Promise((resolve) => {
    const p = spawn('claude', ['--version'], {
      shell: process.platform === 'win32'
    })
    let out = ''
    p.stdout.on('data', (d) => {
      out += d.toString()
    })
    p.on('error', () => resolve({ available: false }))
    p.on('close', (code) => {
      if (code === 0) resolve({ available: true, version: out.trim() })
      else resolve({ available: false })
    })
  })
}

export async function runClaude(args: {
  systemPromptPath: string
  userInput: string
  model?: string
}): Promise<ClaudeResult> {
  const { systemPromptPath, userInput, model = 'haiku' } = args
  if (!fs.existsSync(systemPromptPath)) {
    return { ok: false, error: `Prompt file missing: ${systemPromptPath}` }
  }

  const rawArgs = [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--no-session-persistence',
    '--permission-mode',
    'bypassPermissions',
    '--disallowed-tools',
    'Edit Write Bash',
    // Skip user-level skills (coaching framework, etc.) so they
    // can't inject banners into our output.
    '--disable-slash-commands',
    // Exclude `user` from settings sources — that's what was loading
    // global ~/.claude/CLAUDE.md and pulling in the coaching framework
    // instructions even after --disable-slash-commands.
    '--setting-sources',
    'project',
    // Use the file variant — passing multi-line system prompts as
    // command-line args breaks on Windows when shell:true splits at
    // newlines.
    '--system-prompt-file',
    systemPromptPath
  ]

  return new Promise<ClaudeResult>((resolve) => {
    const t0 = Date.now()
    const proc = spawn('claude', rawArgs.map(quoteForWindowsShell), {
      shell: process.platform === 'win32'
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    proc.on('error', (err) => resolve({ ok: false, error: err.message }))
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `exit ${code}` })
        return
      }
      try {
        const parsed = JSON.parse(stdout) as {
          result?: string
          total_cost_usd?: number
          is_error?: boolean
        }
        if (parsed.is_error) {
          resolve({ ok: false, error: parsed.result ?? 'unknown error' })
          return
        }
        resolve({
          ok: true,
          markdown: (parsed.result ?? '').trim(),
          costUsd: Number(parsed.total_cost_usd ?? 0),
          durationMs: Date.now() - t0
        })
      } catch (err) {
        resolve({
          ok: false,
          error: `Failed to parse claude -p output: ${(err as Error).message}`
        })
      }
    })

    proc.stdin.write(userInput)
    proc.stdin.end()
  })
}
