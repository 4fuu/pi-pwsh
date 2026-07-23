# pi-pwsh

Route pi's shell, directory listing, and search tasks through PowerShell 7 (`pwsh`) on Windows.

## Why

- Windows has no reliable bash implementation (Git Bash hangs on background processes, path translation is flaky).
- A tool named `bash` primes the model to emit POSIX syntax (`&&`, `grep`, `$VAR`), which fails under PowerShell.

This extension disables `bash`, `ls`, `find`, and `grep`, then registers a `pwsh` tool instead.

## What it does

- Registers a `pwsh` tool that **reuses pi's built-in bash tool definition** — tail truncation (last 2000 lines / 50KB), full output saved to a temp file, non-zero exit codes surfaced as tool errors, streaming preview, and the built-in renderer all come for free. Only the spawn layer is replaced.
- Disables pi's built-in `ls`, `find`, and `grep` tools so filesystem discovery and search are routed through `pwsh`; prompt guidance prefers available cross-platform tools such as `rg` and `fd` and bounds native recursive cmdlets.
- Spawns `pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <cmd>`.
- Lazily loads the background-job, PTY, and user-request PowerShell helpers only when their command names are referenced. Ordinary commands avoid parsing and initializing the helper scripts, substantially reducing per-call startup overhead.
- Provides persistent ConPTY sessions through PowerShell functions (`Start-Pty`, `Get-PtyScreen`, `Send-PtyInput`, etc.) without adding another model tool; run `Get-PtyHelp` for the progressive reference.
- Provides TUI-backed user request functions for input, confirmation, selection, masked secrets, and direct secret injection into a PTY; run `Get-PiRequestHelp` for the progressive reference.
- Forces plain UTF-8 output without a BOM (non-ASCII output is not mangled, PowerShell formatting does not leak ANSI escapes, and piped native-command input is not prefixed with `EF BB BF`).
- Defaults Python subprocesses to `PYTHONIOENCODING=utf-8`, `PYTHONUTF8=1`, and `PYTHONUNBUFFERED=1` so stdio and implicit text-file reads use UTF-8 and long-running logs stream promptly. Existing environment values are respected, and the defaults are scoped to processes launched by the tool.
- Preserves real native exit codes: `pwsh -Command` would otherwise flatten them to 0/1, which breaks `rg` (1 = no match vs 2 = error) and `git diff --quiet`-style semantics. An exit-code epilogue restores them — identically for foreground commands and background jobs.
- Auto-retries with `cmd /c` when a command fails with "not a valid Win32 application" (npm/yarn/pnpm are `.cmd` batch files on Windows). Skipped for commands rewritten to background jobs, where cmd's `&` semantics would be wrong.
- Kills the whole process tree (`taskkill /T /F`) on timeout or abort — no orphaned `npm run dev` processes.
- Does not hang when a launched/detached descendant inherits stdout or stderr: after the shell exits, a short output-idle grace captures trailing data without waiting forever for inherited handles to close.
- No default timeout; the model can pass `timeout` (seconds) per call.
- Probes [Windows Sudo](https://learn.microsoft.com/windows/advanced-settings/sudo/) once per session; when available in inline mode, the tool description tells the model it can prefix a command with `sudo` to run it as administrator (each call still requires the user to approve the UAC prompt).

## Background jobs

Every `pwsh` tool call spawns a fresh pwsh process, so native PowerShell jobs (`Start-Job`, the `&` background operator) **die when the tool call ends**. This extension fixes that from inside the shell — no extra tools:

- Job-related commands lazily load `src/jobs.ps1`, which **overrides the job cmdlets** (`Start-Job`, `Get-Job`, `Receive-Job`, `Stop-Job`, `Remove-Job`, `Wait-Job`) with implementations backed by real detached OS processes. Pipeline forms work: `Get-Job | Stop-Job`, `Start-Job { npm run build } -Name build | Wait-Job | Receive-Job`.
- Jobs are launched **detached via double-spawn**: a short-lived launcher process starts the job and exits immediately, breaking the parent chain that `taskkill /T` walks — aborting or timing out the tool call that started a job does **not** kill it. Jobs **inherit the calling session's full environment** (PATH, proxies, `VIRTUAL_ENV`, ...) through the launcher; `Start-Job -Environment @{ NAME = 'value' }` overrides or adds variables (stored in the job's wrap script under `%TEMP%\pi-pwsh-jobs` until `Remove-Job`).
- A trailing ` &` (`npm run dev &`) is rewritten to `Start-Job` before execution, using PowerShell's own parser (`src/background.ts`) — strings, comments, the `& { }` call operator and `&&` are never mistaken for it. Only single-pipeline commands are rewritten; anything else runs as-is.
- Job state lives in `%TEMP%\pi-pwsh-jobs\` (one `.meta.json` + log/exit/script files per job), so it **survives `/reload` and pi restarts** and is inspectable by hand.
- `Receive-Job` consumes output like the native cmdlet (each read returns what arrived since the last one; `-Keep` re-reads, `-Tail N` peeks). Exit codes are captured (`Get-Job` shows `Completed`/`Failed` + `ExitCode`); `Stop-Job` kills the **whole process tree** (`taskkill /T /F`).
- `Suspend-Job`/`Resume-Job`/`Debug-Job` throw actionable guidance. `Get-JobHelp` prints the full reference in the shell.

## Interactive PTY sessions

PTY sessions are owned by the running extension and backed by `node-pty`/Windows ConPTY. They remain alive across independent `pwsh` calls, while the model continues to use the same single `pwsh` tool.

```powershell
Get-PtyHelp                         # short overview and topic list
Get-PtyHelp input                   # fetch one detailed topic

Start-Pty -Command 'python' -Name py
Get-PtyScreen -Name py
Send-PtyInput -Name py -Text 'print(6 * 7)' -Enter
Wait-Pty -Name py | Receive-Pty
Stop-Pty -Name py | Remove-Pty
```

The PTY function group is `Start-Pty`, `Get-Pty`, `Receive-Pty`, `Get-PtyScreen`, `Send-PtyInput`, `Wait-Pty`, `Resize-Pty`, `Stop-Pty`, `Remove-Pty`, and `Get-PtyHelp`. `Receive-Pty` provides cleaned incremental output; `Get-PtyScreen` provides the current emulated viewport for applications that move the cursor or redraw existing lines.

Unlike detached background jobs, PTYs are session-scoped: `/reload`, session replacement, and pi shutdown close them. Aborting or timing out an ordinary `pwsh` call does not stop an already-created PTY.

## User requests

User-request functions can block the current `pwsh` call while pi asks the user for information:

```powershell
Get-PiRequestHelp

$name = Request-PiInput -Title 'Setup' -Prompt 'Display name'
$ok = Request-PiConfirmation -Title 'Deploy' -Message 'Continue?'
$region = Request-PiSelection -Title 'Region' -Options @('cn', 'us', 'eu')
```

For terminal logins, input can go directly from the TUI to a PTY without being returned to PowerShell or the model:

```powershell
Request-PiPtyInput -Name login -Prompt 'Password' -Secret -Enter
```

`Request-PiInput -Secret` uses a masked editor but returns plaintext to the current PowerShell process, so assign it immediately and never print it. `Request-PiPtyInput -Secret` is safer for PTY logins because only a submission acknowledgement is returned. Secret entry requires TUI mode; normal input, confirmation, and selection also work through pi's RPC UI.

The helpers communicate with the extension over an authenticated, random, session-scoped named pipe. Pipe credentials are supplied only to helper calls and removed from the environment before the requested command runs.

## Requirements

- PowerShell 7+ (`pwsh` on `PATH`). There is **no fallback**: if `pwsh` is not found, the extension shows an error notification and leaves the built-in `bash` tool active.
- Windows 10 version 1809 or newer for ConPTY-backed interactive sessions. `node-pty` is installed as a runtime dependency; package managers that gate dependency install scripts must allow its trusted native install script.

## Installation

With pi:

```bash
pi install npm:@4fu/pi-pwsh
```

Or try it for a single run without installing:

```bash
pi -e npm:@4fu/pi-pwsh
```

### From source

Symlink or copy into pi's extensions directory:

```powershell
New-Item -ItemType Junction -Path "$HOME\.pi\agent\extensions\pi-pwsh" -Target "<this-repo>"
```

Or add the path to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["C:/path/to/pi-pwsh"]
}
```

Run `npm install` once in this directory, then `/reload` in pi.

## Development

```powershell
npm install
npm run typecheck
```

Tests:

```powershell
# Runtime defaults (UTF-8 without BOM, plain errors, Python environment)
node scripts/smoke-runtime.mjs
# Job prelude end-to-end (each case is a fresh pwsh process, like a real tool call)
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-jobs.ps1
# Trailing-& interception (PowerShell parser based)
node scripts/smoke-background.mjs
# Foreground exit-code fidelity (native codes survive the pwsh -Command flattening)
node scripts/smoke-exitcode.mjs
# PTY + named-pipe helpers (cross-call lifecycle, screen, input, TUI requests)
npm run test:pty
# Timeout/abort settlement and inherited-stdio descendants
npm run test:timeout
```

## License

MIT
