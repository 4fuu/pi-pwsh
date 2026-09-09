# Local task controls

This experimental build pairs with the `feat/task-controls-soak` branch of
`@4fu/pi-tasks`. The published `pi-tasks` 0.1.2 does not expose these controls.
Keep both local builds together during the soak period.

## Release a foreground wait

Press **Ctrl+Alt+B** while the agent waits for a `pwsh` task. The task keeps
running, and the tool returns its current snapshot instead of an abort error.
The agent can continue the conversation and receives completion automatically.
Use `/pwsh-background` if the terminal does not report that key combination. The
command releases all current `pwsh` tool waits in this session.

**Esc** interrupts the agent turn. It does not stop persistent `pwsh` tasks. The
background control does not interrupt the agent turn.

The shortcut applies to waits after a task starts. It does not detach `!` or
`!!` commands, PTY attachment, Python tasks, MCP calls, or other tools.

## Inspect and stop tasks

Open `/tasks` or press **Ctrl+Alt+T** to select an active task. Press **Tab** to
switch between active and inactive tasks. Press **Enter** to inspect output, or
**r** to refresh the view. For a running PowerShell task, press **k**, then
confirm with **y** to stop its process tree. **Esc** cancels confirmation or
returns from the output view without stopping anything.

After a successful stop, the task moves to inactive history. The viewer returns
to the active list, or closes to the prompt if no active tasks remain. A failed
stop keeps the error visible. Natural completion does not close the viewer, and
an empty active view stays open so **Tab** can reach history. Logs remain until
you delete the task.

The PowerShell output view includes the latest bounded snapshot and the full log
path. A UI inspection does not consume the agent's completion notification. A UI
stop leaves cancellation notification delivery to the existing observer.

Other reporters remain visible. Reporters without control handlers remain
read-only. Task ownership stays in the source extension; the shared UI does not
terminate arbitrary PIDs or adopt tasks from another session.

## Delete inactive tasks

In inactive history, press **d** to delete the selected PowerShell task without
confirmation. This removes its record and log files, not just its row in the
viewer. Active tasks cannot be deleted.

Press **x**, then **y**, to delete all listed inactive tasks that support
deletion. **Esc** or **n** cancels before deletion starts. Read-only tasks and
history omitted from the source catalog are kept. If you leave while deletion is
running, the current request can finish, but no more deletions are queued.
Errors remain visible. An empty inactive view stays open.

## Local development

In the sibling `pi-tasks` checkout, run `npm ci`, then `npm run build`. In this
checkout, install its normal dependencies, then install that local build:

```powershell
npm ci
Remove-Item -Recurse -Force node_modules/@4fu/pi-tasks
npm install --no-save --package-lock=false --install-links ../pi-tasks-research-current
npm test
bun test ./scripts/test-controls.mjs
```

The local package is a development override, not a published dependency change.
`--install-links` installs a copy instead of a symlink, so both packages resolve
the same Pi peer types. After rebuilding the shared package, remove the
installed copy and repeat the local install command. Without removal, npm can
reuse an older copy with the same package version. Before upstream submission,
agree on the shared package release and update the PowerShell dependency
accordingly.

On Windows, `npm run test:controls-ui` tests the actual Pi TUI in ConPTY with a
local scripted provider. It makes no paid model calls. `PI_TEST_CLI` can select
a different CLI, and `PI_TEST_RUNTIME` selects its executable (Node by default,
or an absolute Bun path). `PI_TEST_PWSH_ENTRY` and `PI_TEST_TASKS_ENTRY` can
select installed entries to verify the deployed build.
