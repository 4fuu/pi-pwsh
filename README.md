![pi-pwsh](https://raw.githubusercontent.com/4fuu/pi-pwsh/master/docs/logo.svg)

# pi-pwsh

[![Latest release](https://img.shields.io/github/v/release/4fuu/pi-pwsh)](https://github.com/4fuu/pi-pwsh/releases/latest)

A PowerShell-native shell tool for [pi](https://github.com/earendil-works/pi), with persistent tasks, interactive terminal sessions, and user requests.

## Why pi-pwsh

Windows shell work is more reliable when the tool name, syntax, process model, and paths all agree. `pi-pwsh` gives the model a real `pwsh` tool instead of asking it to translate bash assumptions at runtime.

- **PowerShell-native** — commands use PowerShell 7 syntax and Windows paths from the start.
- **One narrow task interface** — a command starts durable work; the returned `taskId` is the only handle needed to inspect, wait for, or stop it.
- **Persistent by default** — every command is process-backed and survives later tool calls, `/reload`, pi restarts, wait timeouts, and tool aborts.
- **Quiet automatic notifications** — completion and optional literal readiness arrive without another model-facing tool or repeated polling.
- **Progressive helper loading** — PTY and user-request helpers are loaded only when their PowerShell functions are referenced; detailed help remains available through `Get-PtyHelp` and `Get-PiRequestHelp`.
- **Real interactive sessions** — persistent terminal sessions support REPLs, prompts, and full-screen applications.
- **Correct Windows behavior** — UTF-8 source and output, final-command exit codes, `.cmd` fallback, process-tree cleanup, and streaming output are handled for you.
- **Strict, optional configuration** — select the PowerShell executable and control profiles, execution policy, `!`/`!!`, stop-on-error, and Python UTF-8 defaults without expanding the base prompt.
- **Optional elevation guidance** — an available [Windows Sudo](https://learn.microsoft.com/windows/advanced-settings/sudo/) installation is surfaced to the model automatically.

This keeps the model-facing surface small: pi sees one `pwsh` tool plus concise current guidance, while task persistence, notifications, terminal sessions, and UI requests stay behind the extension.

## Features

### Persistent PowerShell tasks

Every command is already persistent, so the model does not need to wrap it in another background-job layer. A new task returns immediately unless the current turn explicitly needs to wait. Waiting can end at completion or at an optional case-sensitive readiness phrase; a timeout or cancelled wait never stops the command.

The returned task ID lets the model inspect the latest snapshot, wait again, or explicitly terminate the complete process tree. Snapshots are bounded and repeatable rather than consumable. Task IDs belong to the parent session that launched them, while state and notification markers survive `/reload` and pi restarts. Terminal records are retained for 24 hours.

### Interactive terminals

Persistent terminal sessions support REPLs, prompts, and full-screen terminal applications:

```powershell
Start-Pty -Command 'python' -Name py
Get-PtyScreen -Name py
Send-PtyInput -Name py -Text 'print(6 * 7)' -Enter
Wait-Pty -Name py | Receive-Pty
Stop-Pty -Name py | Remove-Pty

Get-PtyHelp
```

PTYs live for the current pi session. Aborting an ordinary `pwsh` task wait does not stop an existing PTY.

### Shell shortcuts

Pi's `!` and `!!` shell shortcuts use the same PowerShell runtime and execution behavior as the `pwsh` tool. Set `replaceUserBash` to `false` if those shortcuts should retain pi's default shell behavior.

### User requests

PowerShell commands can ask through pi's UI for text, confirmation, selection, or masked input:

```powershell
Request-PiInput -Title 'Setup' -Prompt 'Display name'
$ok = Request-PiConfirmation -Title 'Deploy' -Message 'Continue?'
$region = Request-PiSelection -Title 'Region' -Options @('cn', 'us', 'eu')

Get-PiRequestHelp
```

For terminal logins, `Request-PiPtyInput -Secret` sends input directly from the UI to a PTY without returning the secret to PowerShell or the model.

![Example of user requests in the pi TUI](https://raw.githubusercontent.com/4fuu/pi-pwsh/master/docs/request_tui.png)

### Task notifications and TUI

Readiness, completion, failure, and cancellation are reported automatically. If the model has already retrieved complete terminal output, a later notification is reduced to compact status instead of repeating the payload.

The dedicated **Pwsh Tasks** widget shows up to three active tasks with status, duration, and command preview, followed by `+N more`. Tool calls remain compact by default and expose task details and bounded output when expanded.

## Configuration

Configuration is optional. Create `~/.pi/agent/pwsh.json` and run `/reload` after changing it:

```json
{
  "executable": "auto",
  "loadProfile": false,
  "executionPolicy": "Bypass",
  "replaceUserBash": true,
  "stopOnError": false,
  "pythonUtf8": true,
  "pythonUnbuffered": true
}
```

| Setting | Default | Effect |
| --- | --- | --- |
| `executable` | `"auto"` | Probes PowerShell 7 and pins its executable path for the session. Set an absolute Windows path to select a specific `pwsh.exe`. |
| `loadProfile` | `false` | Loads the user's PowerShell profile for task commands and PTYs. |
| `executionPolicy` | `"Bypass"` | Execution policy passed to user PowerShell processes. Use `null` to omit the argument. |
| `replaceUserBash` | `true` | Routes pi's `!` and `!!` shortcuts through the same PowerShell operations. |
| `stopOnError` | `false` | Sets `$ErrorActionPreference = 'Stop'` before user commands. |
| `pythonUtf8` | `true` | Defaults `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1` unless already set. |
| `pythonUnbuffered` | `true` | Defaults `PYTHONUNBUFFERED=1` unless already set. |

Environment variables override the JSON file:

| Environment variable | Setting |
| --- | --- |
| `PI_PWSH_CONFIG` | Alternate configuration file path |
| `PI_PWSH_EXECUTABLE` | `executable` |
| `PI_PWSH_LOAD_PROFILE` | `loadProfile` |
| `PI_PWSH_EXECUTION_POLICY` | `executionPolicy` |
| `PI_PWSH_REPLACE_USER_BASH` | `replaceUserBash` |
| `PI_PWSH_STOP_ON_ERROR` | `stopOnError` |
| `PI_PWSH_PYTHON_UTF8` | `pythonUtf8` |
| `PI_PWSH_PYTHON_UNBUFFERED` | `pythonUnbuffered` |

Boolean environment values accept `true`/`false`, `1`/`0`, `yes`/`no`, and `on`/`off`. Configuration is strict: unknown fields, invalid values, or an unavailable configured executable produce an error instead of silently changing shell behavior.

## Recommended Windows setup

Pair this extension with [pi-bin-hints](https://github.com/4fuu/pi-bin-hints). It detects which commonly used modern command-line programs are installed and tells pi through one small, stable prompt line.

A useful Windows baseline is:

- [PowerShell 7](https://github.com/PowerShell/PowerShell)
- [Git for Windows](https://gitforwindows.org/)
- `rg` (ripgrep), `fd`, `jq`, `fzf`, and `bat` as useful optional additions

`winget` or [Scoop](https://scoop.sh/) can install most of these tools. `pi-bin-hints` detects them at the next pi session start, so the model can prefer them without probing `PATH` on every turn.

## Requirements

- Node.js 22.19 or newer.
- PowerShell 7+, discoverable through `PATH`, the standard installation location, or an absolute `executable` path in `pwsh.json`.
- Windows 10 version 1809 or newer for ConPTY sessions on Windows.
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
npm test
npm pack --dry-run
```

The test suite covers configuration and runtime resolution, UTF-8 source transport, exit codes, persistent tasks, notifications, timeouts, process-tree cleanup, PTYs, and UI requests.

## License

MIT
