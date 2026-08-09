![pi-pwsh](https://raw.githubusercontent.com/4fuu/pi-pwsh/master/docs/logo.svg)

# pi-pwsh

A PowerShell-native persistent task tool for [pi](https://github.com/earendil-works/pi), focused on Windows while retaining cross-platform PowerShell support.

## Usage

Talk to pi normally—the `pwsh` tool is for the model. A typical interaction looks like this:

> **You:** Run the Windows build and continue reviewing the packaging changes while it runs.
>
> **pi:** starts `pwsh({"command":"npm run build"})`, receives `ps_…`, and continues independent work instead of polling.
>
> **Notification:** `ps_… completed`
>
> **pi:** checks the build output before reporting the result.

When the current turn depends on a command, the model can wait on that same persistent task. A service can instead use literal readiness:

```json
{"command":"npm run build","wait":30}
{"command":"npm run dev","notifyOn":"Local:","wait":20}
{"taskId":"ps_12ab34cd"}
{"taskId":"ps_12ab34cd","wait":10}
{"taskId":"ps_12ab34cd","stop":true}
```

- Exactly one of `command` or `taskId` is required.
- A command without `wait` returns its `taskId` immediately.
- `wait` (`0..300` seconds) has the same meaning on start and `taskId` calls: it waits for termination, or for the case-sensitive literal `notifyOn` readiness text when the task has one. Timeout and abort end only the wait; the task keeps running.
- A `taskId` is restricted to the parent session that launched it. Its calls return idempotent status snapshots and bounded latest output. `stop: true` is the only operation that kills the complete process tree.
- Completion, failure, cancellation, and optional readiness are reported automatically. State and notification markers survive `/reload` and pi restarts. Finished task data is retained for 24 hours.

The TUI provides a dedicated **Pwsh Tasks** widget and compact task notifications. At most three active tasks are shown, followed by `+N more`.

## Migration from 0.7

The custom PowerShell Job layer has been removed. `Start-Job`, `Get-Job`, `Receive-Job`, `Wait-Job`, `Stop-Job`, and `Remove-Job` are no longer overridden, `Get-JobHelp` no longer exists, and `%TEMP%\pi-pwsh-jobs` is no longer the task registry.

Do not wrap commands in `Start-Job` or append PowerShell's background `&`: the `pwsh` tool command itself is already persistent. Replace:

```powershell
Start-Job { npm run dev } -Name dev -NotifyOn 'Local:'
Receive-Job -Name dev -Tail 20
Stop-Job -Name dev
```

with model calls using `{"command":"npm run dev","notifyOn":"Local:"}`, followed by `{"taskId":"..."}` or `{"taskId":"...","stop":true}`.

## PTY sessions and user requests

The non-Job PowerShell helpers remain available. Commands referencing these functions load their helper lazily:

```powershell
Start-Pty -Command 'python' -Name py
Get-PtyScreen -Name py
Send-PtyInput -Name py -Text 'print(6 * 7)' -Enter
Request-PiInput -Title 'Setup' -Prompt 'Display name'
```

PTYs and the private RPC bridge remain session-scoped. Use `Get-PtyHelp` and `Get-PiRequestHelp` for details.

## Configuration

Optional `~/.pi/agent/pwsh.json` settings are unchanged: `executable`, `loadProfile`, `executionPolicy`, `replaceUserBash`, `stopOnError`, `pythonUtf8`, and `pythonUnbuffered`. PowerShell 7+ and Node.js 22.19+ are required; ConPTY requires Windows 10 1809+.

Install with `pi install npm:@4fu/pi-pwsh`. For development run `npm install`, `npm test`, and `npm pack --dry-run`.

## License

MIT
