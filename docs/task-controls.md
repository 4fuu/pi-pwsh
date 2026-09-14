# Task controls

Use task controls to release foreground waits, inspect output, stop running
tasks, and delete inactive tasks.

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
an empty active view stays open so **Tab** can reach history. Logs remain
available until manual deletion or automatic retention cleanup.

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
