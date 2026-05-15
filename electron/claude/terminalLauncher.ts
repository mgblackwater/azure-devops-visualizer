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

function launchWindows(
  sessionId: string,
  cwd: string,
  shell: TerminalShell
): OpenInTerminalResult {
  if (shell === 'wt') {
    // Windows Terminal — bundled on Win11, available via Microsoft Store
    // on Win10. Routed through `cmd /c start` because `wt.exe` lives under
    // WindowsApps (Store-installed) and isn't always on PATH for GUI-app
    // children.
    const psCommand = `claude --resume ${sessionId}`
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
        '-Command',
        psCommand
      ],
      { detached: true, stdio: 'ignore', shell: false }
    )
    child.unref()
    return { ok: true }
  }

  if (shell === 'powershell') {
    // `cmd /c start "" /D <cwd> powershell -NoExit -Command ...` opens a
    // fresh console window with PowerShell rooted in the session's cwd.
    const psCommand = `claude --resume ${sessionId}`
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
        '-Command',
        psCommand
      ],
      { detached: true, stdio: 'ignore', shell: false }
    )
    child.unref()
    return { ok: true }
  }

  return { ok: false, error: `Shell "${shell}" is not available on Windows.` }
}

function launchMacOS(
  sessionId: string,
  cwd: string,
  shell: TerminalShell
): OpenInTerminalResult {
  // Single command run inside whichever terminal app we pick.
  const command = `cd ${JSON.stringify(cwd)} && claude --resume ${sessionId}`

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
