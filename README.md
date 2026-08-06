# pi-pwsh

A PowerShell-native shell tool for [pi](https://github.com/badlogic/pi-mono) on Windows.

## Why pi-pwsh

Windows shell work is more reliable when the tool name, syntax, process model, and paths all agree. `pi-pwsh` gives the model a real `pwsh` tool instead of asking it to translate bash assumptions at runtime.

- **PowerShell-native** — commands use PowerShell 7 syntax and Windows paths from the start.
- **Small integration footprint** — one model tool reuses pi's built-in execution contract and renderer; only the process layer is PowerShell-specific.
- **Low prompt overhead** — the base prompt stays compact. Background jobs, interactive terminals, and user requests expose only a short entry point, then load detailed guidance progressively through `Get-JobHelp`, `Get-PtyHelp`, and `Get-PiRequestHelp`.
- **Reliable long-running work** — detached jobs survive tool calls, `/reload`, timeouts, and aborts.
- **Real interactive sessions** — Windows ConPTY sessions persist across independent tool calls.
- **Correct Windows behavior** — UTF-8 output, native exit codes, `.cmd` fallback, process-tree cleanup, and streaming output are handled for you.
- **Optional elevation** — automatically injects a [Windows Sudo](https://learn.microsoft.com/windows/advanced-settings/sudo/) hint when available.

The three optional helper families and their references are lazily loaded when their commands are used. They remain PowerShell functions, so no extra model tools are added.

## Features

### Background jobs

Long-running commands run as detached processes and remain manageable from later `pwsh` calls:

```powershell
npm run dev &

Get-Job
Receive-Job -Name dev
Stop-Job -Name dev | Remove-Job
Get-JobHelp
```

The familiar job commands (`Start-Job`, `Get-Job`, `Receive-Job`, `Wait-Job`, `Stop-Job`, and `Remove-Job`) support pipelines and record state under `%TEMP%\pi-pwsh-jobs`.

### Interactive terminals

ConPTY-backed sessions support REPLs, prompts, and full-screen terminal applications:

```powershell
Start-Pty -Command 'python' -Name py
Get-PtyScreen -Name py
Send-PtyInput -Name py -Text 'print(6 * 7)' -Enter
Wait-Pty -Name py | Receive-Pty
Stop-Pty -Name py | Remove-Pty

Get-PtyHelp
```

PTYs live for the current pi session. Aborting an ordinary `pwsh` call does not stop an existing PTY.

### User requests

PowerShell commands can ask through pi's UI for text, confirmation, selection, or masked input:

```powershell
$name = Request-PiInput -Title 'Setup' -Prompt 'Display name'
$ok = Request-PiConfirmation -Title 'Deploy' -Message 'Continue?'
$region = Request-PiSelection -Title 'Region' -Options @('cn', 'us', 'eu')

Get-PiRequestHelp
```

For terminal logins, `Request-PiPtyInput -Secret` sends input directly from the UI to a PTY without returning the secret to PowerShell or the model.

## Recommended Windows setup

Pair this extension with [pi-bin-hints](https://github.com/4fuu/pi-bin-hints). It detects which commonly used modern command-line programs are installed and tells pi through one small, stable prompt line.

Install the tools you commonly need to make the Windows terminal environment more complete. A useful baseline is:

- [PowerShell 7](https://github.com/PowerShell/PowerShell)
- [Git for Windows](https://gitforwindows.org/)
- `rg` (ripgrep), `fd`, `jq`, `fzf`, `bat`, and more (optional, but greatly improves the agent's Windows terminal experience; see [pi-bin-hints](https://github.com/4fuu/pi-bin-hints) for the full list)

`winget` or [Scoop](https://scoop.sh/) can install most of these tools. `pi-bin-hints` detects them at the next pi session start, so the model can prefer them without probing `PATH` on every turn.

## Requirements

- PowerShell 7+ (`pwsh` on `PATH`). If it is unavailable, pi reports an error and keeps its existing shell tool active.
- Windows 10 version 1809 or newer for ConPTY sessions.
- Permission for the trusted `node-pty` native install script when your package manager restricts dependency scripts.

## Installation

```powershell
pi install npm:@4fu/pi-pwsh
```

Try it for one run without installing:

```powershell
pi -e npm:@4fu/pi-pwsh
```

### From source

Run `npm install`, then add the repository path to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["C:/path/to/pi-pwsh"]
}
```

Run `/reload` in pi after changing the extension.

## Development

```powershell
npm install
npm run typecheck
npm run test:pty
npm run test:timeout
```

Additional smoke tests are available under `scripts/` for runtime encoding, background parsing, jobs, and exit-code behavior.

## License

MIT
