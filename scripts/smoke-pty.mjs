import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import extension from "../src/index.ts";

const handlers = new Map();
let tool;
let activeTools = ["bash", "read", "ls", "find", "grep"];
const pi = {
	on(event, handler) {
		const values = handlers.get(event) ?? [];
		values.push(handler);
		handlers.set(event, values);
	},
	registerTool(definition) { tool = definition; },
	registerMessageRenderer() {},
	sendMessage() {},
	getActiveTools() { return [...activeTools]; },
	setActiveTools(names) { activeTools = [...names]; },
};

const notifications = [];
const dialogs = [];
const ctx = {
	cwd: process.cwd(),
	mode: "tui",
	hasUI: true,
	sessionManager: {
		getSessionId() { return "pty-smoke-session"; },
		getSessionFile() { return undefined; },
	},
	ui: {
		notify(message, type) { notifications.push({ message, type }); },
		setStatus() {},
		async input() { return "Ada"; },
		async confirm() { return true; },
		async select(_title, options) { return options[0]; },
		custom(factory) {
			return new Promise(async (resolve, reject) => {
				let component;
				const done = (value) => {
					component?.dispose?.();
					resolve(value);
				};
				try {
					component = await factory({ requestRender() {}, terminal: { rows: 30, columns: 100 } }, {}, {}, done);
					const initial = component.render(100);
					const dialog = { initial: [...initial], afterInput: [] };
					dialogs.push(dialog);
					const promptLine = initial[1] ?? "";
					component.focused = true;
					component.handleInput(/password|secret/i.test(promptLine) ? "s3cr3t" : "Ada");
					dialog.afterInput = component.render(100);
					component.handleInput("\n");
				} catch (error) { reject(error); }
			});
		},
	},
};

const previousConfigPath = process.env.PI_PWSH_CONFIG;
process.env.PI_PWSH_CONFIG = "C:\\definitely-missing-pi-pwsh-config.json";
const fallbackHandlers = new Map();
let fallbackTools = ["pwsh", "read"];
extension({
	on(event, handler) { fallbackHandlers.set(event, [...(fallbackHandlers.get(event) ?? []), handler]); },
	registerMessageRenderer() {},
	getActiveTools() { return [...fallbackTools]; },
	setActiveTools(names) { fallbackTools = [...names]; },
});
if (previousConfigPath === undefined) delete process.env.PI_PWSH_CONFIG;
else process.env.PI_PWSH_CONFIG = previousConfigPath;
for (const handler of fallbackHandlers.get("session_start") ?? []) {
	await handler({ type: "session_start", reason: "startup" }, ctx);
}
assert.ok(fallbackTools.includes("bash"));
assert.ok(!fallbackTools.includes("pwsh"));

extension(pi);
for (const handler of handlers.get("session_start") ?? []) {
	await handler({ type: "session_start", reason: "startup" }, ctx);
}
assert.ok(tool, `pwsh tool was not registered: ${JSON.stringify(notifications)}`);
assert.ok(activeTools.includes("pwsh"));
assert.ok(!activeTools.includes("bash"));
assert.ok(activeTools.includes("ls"));
assert.ok(activeTools.includes("find"));
assert.ok(activeTools.includes("grep"));
assert.match(tool.description, /\n\nUSER REQUESTS:/);
const userBash = await (handlers.get("user_bash")?.[0]?.());
assert.equal(typeof userBash?.operations?.exec, "function");

let call = 0;
async function run(command, timeout) {
	call++;
	const result = await tool.execute(`pty-smoke-${call}`, { command, timeout }, undefined, undefined, ctx);
	return result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
}

function lastDialog() {
	const dialog = dialogs.at(-1);
	assert.ok(dialog, "expected a custom input dialog");
	return dialog;
}

try {
	const jobHelp = await run("Get-JobHelp");
	assert.match(jobHelp, /pi-pwsh background jobs/);
	const help = await run("Get-PtyHelp");
	assert.match(help, /Persistent interactive processes backed by Windows ConPTY/);

	const childCommand = "$name = Read-Host 'Name'; Write-Output ('Hello ' + $name)";
	const escaped = childCommand.replaceAll("'", "''");
	const started = await run(`Start-Pty -Command '${escaped}' -Name smoke | Select-Object Name, State | ConvertTo-Json -Compress`);
	assert.match(started, /"Name":"smoke"/);
	assert.match(started, /"State":"Running"/);

	await run("Resize-Pty -Name smoke -Columns 90 -Rows 24 | Out-Null");
	await run("Wait-Pty -Name smoke -IdleMilliseconds 200 | Out-Null");
	const screen = await run("Get-PtyScreen -Name smoke");
	assert.match(screen, /Name:/);

	await run("Request-PiPtyInput -Name smoke -Prompt 'Name' -Enter | Out-Null");
	assert.deepEqual(lastDialog().initial.slice(0, 2), ["PTY input requested", "Name"]);
	const ended = await run("Wait-Pty -Name smoke -Exit -Timeout 5 | Select-Object Name, State, ExitCode | ConvertTo-Json -Compress");
	assert.match(ended, /"State":"Completed"/);
	assert.match(ended, /"ExitCode":0/);

	const output = await run("Receive-Pty -Name smoke");
	assert.match(output, /Hello Ada/);
	await run("Remove-Pty -Name smoke | Out-Null");

	const livePty = await run("$pty = Start-Pty -Command 'Start-Sleep -Milliseconds 400; Write-Output live-output' -Name livepty; $before = [string]$pty.State; Resize-Pty $pty -Columns 88 -Rows 22 | Out-Null; $same = [object]::ReferenceEquals($pty, (Get-Pty -Id $pty.Id)); Wait-Pty $pty -Exit -Timeout 10 | Out-Null; $hasDataBefore = $pty.HasMoreData; Receive-Pty $pty | Out-Null; [pscustomobject]@{ Before = $before; After = [string]$pty.State; ExitCode = $pty.ExitCode; Same = $same; HasDataBefore = $hasDataBefore; HasDataAfter = $pty.HasMoreData; Columns = $pty.Columns; Rows = $pty.Rows } | ConvertTo-Json -Compress");
	assert.match(livePty, /"Before":"Running"/);
	assert.match(livePty, /"After":"Completed"/);
	assert.match(livePty, /"ExitCode":0/);
	assert.match(livePty, /"Same":true/);
	assert.match(livePty, /"HasDataBefore":true/);
	assert.match(livePty, /"HasDataAfter":false/);
	assert.match(livePty, /"Columns":88/);
	assert.match(livePty, /"Rows":22/);
	const removedLivePty = await run("$pty = Get-Pty -Name livepty; $removed = Remove-Pty $pty; [pscustomobject]@{ Same = [object]::ReferenceEquals($pty, $removed); State = [string]$pty.State; ExitCode = $pty.ExitCode } | ConvertTo-Json -Compress");
	assert.match(removedLivePty, /"Same":true/);
	assert.match(removedLivePty, /"State":"Completed"/);
	assert.match(removedLivePty, /"ExitCode":0/);
	const missingPtyFailure = await run("$pty = Start-Pty -Command 'Start-Sleep 60' -Name missingpty; $null = Invoke-PiPwshRpc -Method 'pty.remove' -Parameters @{ id = $pty.Id; force = $true }; $Error.Clear(); $state = $pty.State; [pscustomobject]@{ ReturnedStaleState = $null -ne $state; ErrorCount = $Error.Count } | ConvertTo-Json -Compress");
	assert.match(missingPtyFailure, /"ReturnedStaleState":false/);
	assert.match(missingPtyFailure, /"ErrorCount":[1-9][0-9]*/);

	const requestHelp = await run("Get-PiRequestHelp");
	assert.match(requestHelp, /Ask the user for input, confirmation, or selection/);
	assert.equal((await run("Request-PiInput -Title Test -Prompt Name")).trim(), "Ada");
	assert.deepEqual(lastDialog().initial.slice(0, 2), ["Test", "Name"]);
	assert.match(lastDialog().afterInput[2] ?? "", /Ada/);
	assert.equal((await run("Request-PiInput -Title Test -Prompt Password -Secret")).trim(), "s3cr3t");
	assert.deepEqual(lastDialog().initial.slice(0, 2), ["Test", "Password"]);
	assert.doesNotMatch(lastDialog().afterInput.join("\n"), /s3cr3t/);
	assert.match(lastDialog().afterInput[2] ?? "", /••••••/);
	assert.equal((await run("Request-PiConfirmation -Title Test -Message Continue")).trim(), "True");
	assert.equal((await run("Request-PiSelection -Title Test -Options one,two")).trim(), "one");

	await run("Start-Pty -Command 'Read-Host ''wait''' -Name survives | Out-Null");
	await assert.rejects(run("Wait-Pty -Name survives -Exit -Timeout 60 | Out-Null", 0.2), /timed out/i);
	const survives = await run("Get-Pty -Name survives | Select-Object State | ConvertTo-Json -Compress");
	assert.match(survives, /\"State\":\"Running\"/);
	await run("Remove-Pty -Name survives -Force | Out-Null");

	const treeCommand = "$p = Start-Process pwsh -ArgumentList '-NoProfile','-Command','Start-Sleep 60' -PassThru; Write-Output ('CHILD=' + $p.Id); Read-Host 'wait'";
	await run(`Start-Pty -Command '${treeCommand.replaceAll("'", "''")}' -Name tree | Out-Null`);
	await run("Wait-Pty -Name tree -IdleMilliseconds 200 | Out-Null");
	const treeOutput = await run("Receive-Pty -Name tree -Keep");
	const childPid = Number(/CHILD=(\d+)/.exec(treeOutput)?.[1]);
	assert.ok(childPid > 0);
	await run("Stop-Pty -Name tree | Remove-Pty | Out-Null");
	const taskList = execFileSync("tasklist", ["/fi", `PID eq ${childPid}`], { encoding: "utf8" });
	assert.ok(!taskList.includes(String(childPid)), "Stop-Pty left a descendant running");
	console.log("pty and user-request helpers: ok");
} finally {
	for (const handler of handlers.get("session_shutdown") ?? []) {
		await handler({ type: "session_shutdown", reason: "quit" }, ctx);
	}
}
