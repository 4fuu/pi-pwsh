# pi-pwsh

Replace pi's built-in `bash` tool with PowerShell 7 (`pwsh`) on Windows.

## Why

- Windows has no reliable bash implementation (Git Bash hangs on background processes, path translation is flaky).
- A tool named `bash` primes the model to emit POSIX syntax (`&&`, `grep`, `$VAR`), which fails under PowerShell.

This extension disables `bash` and registers a `pwsh` tool instead.

## What it does

- Registers a `pwsh` tool that **reuses pi's built-in bash tool definition** — tail truncation (last 2000 lines / 50KB), full output saved to a temp file, non-zero exit codes surfaced as tool errors, streaming preview, and the built-in renderer all come for free. Only the spawn layer is replaced.
- Spawns `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <cmd>`.
- Forces UTF-8 output encoding (non-ASCII output is not mangled by the legacy OEM codepage).
- Auto-retries with `cmd /c` when a command fails with "not a valid Win32 application" (npm/yarn/pnpm are `.cmd` batch files on Windows).
- Kills the whole process tree (`taskkill /T /F`) on timeout or abort — no orphaned `npm run dev` processes.
- No default timeout; the model can pass `timeout` (seconds) per call.

## Requirements

- PowerShell 7+ (`pwsh` on `PATH`). There is **no fallback**: if `pwsh` is not found, the extension shows an error notification and leaves the built-in `bash` tool active.

## Installation

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

## License

MIT
