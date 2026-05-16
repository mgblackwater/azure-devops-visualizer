import { spawn } from 'node:child_process'
import fs from 'node:fs'
import type {
  OpenInTerminalResult,
  TerminalShell
} from '@shared/claudeTypes'

function escapeAppleScriptString(s: string): string {
  // AppleScript string literals: backslash and double-quote need escaping.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Build the inner claude command line. When `prompt` is provided we start
 * a fresh interactive session with that prompt as the first user message;
 * otherwise we resume an existing session by id. The prompt is expected
 * to be SHORT (the caller is responsible for spilling long content to a
 * file and asking Claude to read it as a first action) — Windows
 * CreateProcess caps total argv at ~32 KB, so anything bigger gets
 * silently truncated.
 */
function buildClaudeCommandPs(opts: {
  sessionId?: string
  prompt?: string
}): string {
  if (opts.prompt !== undefined) {
    const escaped = opts.prompt.replace(/'/g, "''")
    return `claude '${escaped}'`
  }
  return `claude --resume ${opts.sessionId}`
}

/**
 * PowerShell `-EncodedCommand` expects a base64 UTF-16LE string. Using
 * this instead of `-Command "..."` sidesteps cmd.exe's line-terminator
 * and quote-handling quirks entirely, so the inner PowerShell snippet
 * (with its file-path single-quotes) survives the `cmd /c start` hop.
 */
function encodePowerShell(command: string): string {
  return Buffer.from(command, 'utf16le').toString('base64')
}

/** POSIX (bash / zsh) variant — same single-quoted-arg approach. */
function buildClaudeCommandPosix(opts: {
  sessionId?: string
  prompt?: string
}): string {
  if (opts.prompt !== undefined) {
    const escaped = opts.prompt.replace(/'/g, `'\\''`)
    return `claude '${escaped}'`
  }
  return `claude --resume ${opts.sessionId}`
}

function launchWindows(
  sessionId: string | undefined,
  cwd: string,
  shell: TerminalShell,
  prompt?: string
): OpenInTerminalResult {
  if (shell === 'wt') {
    // Windows Terminal — bundled on Win11, available via Microsoft Store
    // on Win10. Routed through `cmd /c start` because `wt.exe` lives under
    // WindowsApps (Store-installed) and isn't always on PATH for GUI-app
    // children.
    const psCommand = buildClaudeCommandPs({ sessionId, prompt })
    const encoded = encodePowerShell(psCommand)
    const child = spawn(
      'cmd.exe',
      [
        '/c',
        'start',
        '',
        'wt.exe',
        '-d',
        cwd,
        'powershell.exe',
        '-NoExit',
        '-EncodedCommand',
        encoded
      ],
      { detached: true, stdio: 'ignore', shell: false }
    )
    child.unref()
    return { ok: true }
  }

  if (shell === 'powershell') {
    // `cmd /c start "" /D <cwd> powershell -NoExit -EncodedCommand ...`
    // opens a fresh console window with PowerShell rooted in the session's
    // cwd. We pass the command base64-encoded so cmd never has to parse
    // the inner quotes / newlines.
    const psCommand = buildClaudeCommandPs({ sessionId, prompt })
    const encoded = encodePowerShell(psCommand)
    const child = spawn(
      'cmd.exe',
      [
        '/c',
        'start',
        '',
        '/D',
        cwd,
        'powershell.exe',
        '-NoExit',
        '-EncodedCommand',
        encoded
      ],
      { detached: true, stdio: 'ignore', shell: false }
    )
    child.unref()
    return { ok: true }
  }

  return { ok: false, error: `Shell "${shell}" is not available on Windows.` }
}

function launchMacOS(
  sessionId: string | undefined,
  cwd: string,
  shell: TerminalShell,
  prompt?: string
): OpenInTerminalResult {
  // Single command run inside whichever terminal app we pick.
  const claudePart = buildClaudeCommandPosix({ sessionId, prompt })
  const command = `cd ${JSON.stringify(cwd)} && ${claudePart}`

  if (shell === 'macos-terminal') {
    // Open a new Terminal.app window running the command.
    const script = `tell application "Terminal"
  activate
  do script "${escapeAppleScriptString(command)}"
end tell`
    const child = spawn('osascript', ['-e', script], {
      detached: true,
      stdio: 'ignore',
      shell: false
    })
    child.unref()
    return { ok: true }
  }

  if (shell === 'iterm2') {
    if (!fs.existsSync('/Applications/iTerm.app')) {
      return {
        ok: false,
        error: 'iTerm.app not found in /Applications. Install iTerm2 first.'
      }
    }
    // Open a new iTerm2 window using its default profile and run the command.
    const script = `tell application "iTerm"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow
    write text "${escapeAppleScriptString(command)}"
  end tell
end tell`
    const child = spawn('osascript', ['-e', script], {
      detached: true,
      stdio: 'ignore',
      shell: false
    })
    child.unref()
    return { ok: true }
  }

  return { ok: false, error: `Shell "${shell}" is not available on macOS.` }
}

export function openSessionInTerminal(args: {
  sessionId: string
  cwd: string
  shell: TerminalShell
}): OpenInTerminalResult {
  if (!args.sessionId) return { ok: false, error: 'Missing sessionId' }
  if (!args.cwd) return { ok: false, error: 'Missing cwd' }

  try {
    if (process.platform === 'win32') {
      return launchWindows(args.sessionId, args.cwd, args.shell)
    }
    if (process.platform === 'darwin') {
      return launchMacOS(args.sessionId, args.cwd, args.shell)
    }
    return {
      ok: false,
      error: `Terminal launcher is not supported on ${process.platform} yet.`
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Start a fresh interactive Claude session pre-seeded with `prompt`. The
 * prompt is sent as Claude's first user message via the positional argv,
 * so it must stay SHORT — Windows CreateProcess caps total argv at
 * ~32 KB. Callers with long content should spill it to a file and pass
 * a tiny instruction that asks Claude to read the file.
 */
export function startSessionInTerminal(args: {
  cwd: string
  prompt: string
  shell: TerminalShell
}): OpenInTerminalResult {
  if (!args.cwd) return { ok: false, error: 'Missing cwd' }
  if (!args.prompt) return { ok: false, error: 'Missing prompt' }

  try {
    if (process.platform === 'win32') {
      return launchWindows(undefined, args.cwd, args.shell, args.prompt)
    }
    if (process.platform === 'darwin') {
      return launchMacOS(undefined, args.cwd, args.shell, args.prompt)
    }
    return {
      ok: false,
      error: `Terminal launcher is not supported on ${process.platform} yet.`
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
