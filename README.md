<p align="center">
  <img src="https://raw.githubusercontent.com/4fuu/pi-pwsh/master/docs/logo.svg" alt="pi-pwsh" width="658">
</p>

<h1 align="center">pi-pwsh</h1>

<p align="center">
  <a href="https://github.com/4fuu/pi-pwsh/releases/latest"><img src="https://img.shields.io/github/v/release/4fuu/pi-pwsh" alt="Latest release"></a>
</p>

A PowerShell-native shell tool for [pi](https://github.com/earendil-works/pi) on Windows, with persistent jobs, ConPTY sessions, and user requests.

## Why pi-pwsh

Windows shell work is more reliable when the tool name, syntax, process model, and paths all agree. `pi-pwsh` gives the model a real `pwsh` tool instead of asking it to translate bash assumptions at runtime.

- **PowerShell-native** — commands use PowerShell 7 syntax and Windows paths from the start.
- **One tool, all capabilities** — jobs, interactive terminals, and user requests are exposed as PowerShell functions from `.ps1` scripts inside the same `pwsh` tool, rather than as additional model-facing tools.
- **Progressive loading, low prompt overhead** — ordinary commands carry only compact guidance. Each helper script is loaded only when one of its functions is used, and the full reference is returned only when the model explicitly calls `Get-JobHelp`, `Get-PtyHelp`, or `Get-PiRequestHelp`.
- **Truly detached background jobs** — familiar commands such as `Start-Job`, `Get-Job`, and `Receive-Job` are overridden with process-backed implementations. Jobs are independent of the launching PowerShell process and survive later tool calls, `/reload`, pi restarts, timeouts, and aborts.
- **Quiet job notifications** — pi reports job completion and optional readiness matches without adding another model-facing tool or prompting the model to poll.
- **Real interactive sessions** — Windows ConPTY sessions persist across independent tool calls.
- **Correct Windows behavior** — UTF-8 source and output, final-command exit codes, `.cmd` fallback, process-tree cleanup, and streaming output are handled for you.
- **Strict, optional configuration** — select a PowerShell executable and control profiles, execution policy, `!`/`!!`, stop-on-error, and Python's UTF-8 defaults without expanding the base prompt.
- **Optional elevation** — automatically injects a [Windows Sudo](https://learn.microsoft.com/windows/advanced-settings/sudo/) hint when available.

This keeps the base tool schema and system prompt small: pi sees one `pwsh` tool plus concise usage guidance, while implementation scripts and detailed help are introduced progressively only when a task needs them.

## Features

### Background jobs

Long-running commands run as detached processes and remain manageable from later `pwsh` calls:

```powershell
Start-Job { npm run dev } -Name dev -NotifyOn 'Local:'

Get-Job
Receive-Job -Name dev -Tail 20
Wait-Job -Name dev -Pattern 'ready|listening' -Timeout 30
Stop-Job -Name dev | Remove-Job
Get-JobHelp
```

The familiar job commands (`Start-Job`, `Get-Job`, `Receive-Job`, `Wait-Job`, `Stop-Job`, and `Remove-Job`) launch detached OS processes, support pipelines, and record state under `%TEMP%\pi-pwsh-jobs`. Work remains discoverable and controllable after the original `pwsh` invocation exits, after `/reload`, and after pi restarts.

Completion notifications are automatic, while `-NotifyOn` optionally reports a one-time readiness match. If `Receive-Job` returns final output first, the pending completion notification is reduced to a status summary; notifications never consume output. The complete merged log remains available through `LogFile` until `Remove-Job`.

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

### Shell shortcuts

Pi's `!` and `!!` shell shortcuts use the same PowerShell runtime and execution behavior as the `pwsh` tool. Set `replaceUserBash` to `false` if those shortcuts should retain pi's default shell behavior.

### User requests

PowerShell commands can ask through pi's UI for text, confirmation, selection, or masked input:

```powershell
$name = Request-PiInput -Title 'Setup' -Prompt 'Display name'
$ok = Request-PiConfirmation -Title 'Deploy' -Message 'Continue?'
$region = Request-PiSelection -Title 'Region' -Options @('cn', 'us', 'eu')

Get-PiRequestHelp
```

For terminal logins, `Request-PiPtyInput -Secret` sends input directly from the UI to a PTY without returning the secret to PowerShell or the model.

![Example of user requests in the pi TUI](https://raw.githubusercontent.com/4fuu/pi-pwsh/master/docs/request_tui.png)

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
| `executable` | `"auto"` | Probes PowerShell 7 and pins its absolute executable path for the session. Set an absolute path to select a specific `pwsh.exe`. |
| `loadProfile` | `false` | Loads the user's PowerShell profile for foreground commands, detached job commands, and PTYs. |
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

Boolean environment values accept `true`/`false`, `1`/`0`, `yes`/`no`, and `on`/`off`. Configuration is strict: unknown fields, invalid values, or an unavailable configured executable produce an error and leave pi's built-in `bash` tool active instead of creating a session without a shell.

## Recommended Windows setup

Pair this extension with [pi-bin-hints](https://github.com/4fuu/pi-bin-hints). It detects which commonly used modern command-line programs are installed and tells pi through one small, stable prompt line.

Install the tools you commonly need to make the Windows terminal environment more complete. A useful baseline is:

- [PowerShell 7](https://github.com/PowerShell/PowerShell)
- [Git for Windows](https://gitforwindows.org/)
- `rg` (ripgrep), `fd`, `jq`, `fzf`, `bat`, and more (optional, but greatly improves the agent's Windows terminal experience; see [pi-bin-hints](https://github.com/4fuu/pi-bin-hints) for the full list)

`winget` or [Scoop](https://scoop.sh/) can install most of these tools. `pi-bin-hints` detects them at the next pi session start, so the model can prefer them without probing `PATH` on every turn.

## Requirements

- Node.js 22.19 or newer.
- PowerShell 7+, discoverable through `PATH`, the standard installation location, or an absolute `executable` path in `pwsh.json`. If it is unavailable, pi reports an error and keeps its existing shell tool active.
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
npm test
```

The test suite covers configuration and runtime resolution, UTF-8 source transport, exit codes, background parsing, durable jobs, notifications, timeouts, and PTYs.

## License

MIT
