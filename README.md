# pi-pwsh

Route pi's shell, directory listing, and search tasks through PowerShell 7 (`pwsh`) on Windows.

## Why

- Windows has no reliable bash implementation (Git Bash hangs on background processes, path translation is flaky).
- A tool named `bash` primes the model to emit POSIX syntax (`&&`, `grep`, `$VAR`), which fails under PowerShell.

This extension disables `bash`, `ls`, `find`, and `grep`, then registers a `pwsh` tool instead.

## What it does

- Registers a `pwsh` tool that **reuses pi's built-in bash tool definition** — tail truncation (last 2000 lines / 50KB), full output saved to a temp file, non-zero exit codes surfaced as tool errors, streaming preview, and the built-in renderer all come for free. Only the spawn layer is replaced.
- Disables pi's built-in `ls`, `find`, and `grep` tools so filesystem discovery and search are routed through `pwsh`; prompt guidance prefers available cross-platform tools such as `rg` and `fd` and bounds native recursive cmdlets.
- Spawns `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <cmd>`.
- Forces plain UTF-8 output without a BOM (non-ASCII output is not mangled, PowerShell formatting does not leak ANSI escapes, and piped native-command input is not prefixed with `EF BB BF`).
- Defaults Python subprocesses to `PYTHONIOENCODING=utf-8`, `PYTHONUTF8=1`, and `PYTHONUNBUFFERED=1` so stdio and implicit text-file reads use UTF-8 and long-running logs stream promptly. Existing environment values are respected, and the defaults are scoped to processes launched by the tool.
- Preserves real native exit codes: `pwsh -Command` would otherwise flatten them to 0/1, which breaks `rg` (1 = no match vs 2 = error) and `git diff --quiet`-style semantics. An exit-code epilogue restores them — identically for foreground commands and background jobs.
- Auto-retries with `cmd /c` when a command fails with "not a valid Win32 application" (npm/yarn/pnpm are `.cmd` batch files on Windows). Skipped for commands rewritten to background jobs, where cmd's `&` semantics would be wrong.
- Kills the whole process tree (`taskkill /T /F`) on timeout or abort — no orphaned `npm run dev` processes.
- No default timeout; the model can pass `timeout` (seconds) per call.
- Probes [Windows Sudo](https://learn.microsoft.com/windows/advanced-settings/sudo/) once per session; when available in inline mode, the tool description tells the model it can prefix a command with `sudo` to run it as administrator (each call still requires the user to approve the UAC prompt).

## Background jobs

Every `pwsh` tool call spawns a fresh pwsh process, so native PowerShell jobs (`Start-Job`, the `&` background operator) **die when the tool call ends**. This extension fixes that from inside the shell — no extra tools:

- Every call dot-sources `src/prelude.ps1`, which **overrides the job cmdlets** (`Start-Job`, `Get-Job`, `Receive-Job`, `Stop-Job`, `Remove-Job`, `Wait-Job`) with implementations backed by real detached OS processes. Pipeline forms work: `Get-Job | Stop-Job`, `Start-Job { npm run build } -Name build | Wait-Job | Receive-Job`.
- Jobs are launched **detached via double-spawn**: a short-lived launcher process starts the job and exits immediately, breaking the parent chain that `taskkill /T` walks — aborting or timing out the tool call that started a job does **not** kill it. Jobs **inherit the calling session's full environment** (PATH, proxies, `VIRTUAL_ENV`, ...) through the launcher; `Start-Job -Environment @{ NAME = 'value' }` overrides or adds variables (stored in the job's wrap script under `%TEMP%\pi-pwsh-jobs` until `Remove-Job`).
- A trailing ` &` (`npm run dev &`) is rewritten to `Start-Job` before execution, using PowerShell's own parser (`src/background.ts`) — strings, comments, the `& { }` call operator and `&&` are never mistaken for it. Only single-pipeline commands are rewritten; anything else runs as-is.
- Job state lives in `%TEMP%\pi-pwsh-jobs\` (one `.meta.json` + log/exit/script files per job), so it **survives `/reload` and pi restarts** and is inspectable by hand.
- `Receive-Job` consumes output like the native cmdlet (each read returns what arrived since the last one; `-Keep` re-reads, `-Tail N` peeks). Exit codes are captured (`Get-Job` shows `Completed`/`Failed` + `ExitCode`); `Stop-Job` kills the **whole process tree** (`taskkill /T /F`).
- `Suspend-Job`/`Resume-Job`/`Debug-Job` throw actionable guidance. `Get-JobHelp` prints the full reference in the shell.

## Requirements

- PowerShell 7+ (`pwsh` on `PATH`). There is **no fallback**: if `pwsh` is not found, the extension shows an error notification and leaves the built-in `bash` tool active.

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
```

## License

MIT
