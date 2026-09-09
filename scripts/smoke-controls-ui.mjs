// Real ConPTY smoke test. Uses a local scripted provider, never a paid model.
// PI_TEST_CLI selects the Pi CLI; PI_TEST_RUNTIME selects node or bun.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import pty from "node-pty";

assert.equal(process.platform, "win32", "This smoke test requires Windows ConPTY");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = process.env.PI_TEST_CLI ?? join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const runtime = process.env.PI_TEST_RUNTIME ?? process.execPath;
const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-controls-ui-"));
const readyPath = join(dir, "ready.txt");
const quote = value => `'${value.replaceAll("'", "''")}'`;
const command = `Write-Output SOAK_STARTED; Set-Content -LiteralPath ${quote(readyPath)} -Value $PID; Start-Sleep -Seconds 120`;
let requests = 0, taskId, processPid, terminal, exited = false, output = "", transcript = "";
const text = () => output.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
const server = createServer(async (req, res) => {
	try {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		for (const m of body.messages ?? []) {
			if (m.role === "tool") taskId ??= String(m.content).match(/taskId: (ps_[0-9a-f]{8})/)?.[1];
		}
		const first = requests++ === 0;
		const delta = first
			? { role: "assistant", tool_calls: [{ index: 0, id: "soak_call", type: "function", function: { name: "pwsh", arguments: JSON.stringify({ command, wait: 120 }) } }] }
			: { role: "assistant", content: "SOAK_DIALOG_AVAILABLE" };
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const event = (delta, finish_reason) => `data: ${JSON.stringify({ id: "soak", object: "chat.completion.chunk", created: 1, model: "soak", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
		res.end(event(delta, null) + event({}, first ? "tool_calls" : "stop") + "data: [DONE]\n\n");
	} catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const fixture = join(dir, "fixture.ts");
await writeFile(fixture, `
import pwsh from ${JSON.stringify((process.env.PI_TEST_PWSH_ENTRY ?? join(root, "src/index.ts")).replaceAll("\\", "/"))};
import { registerTaskReporter } from ${JSON.stringify((process.env.PI_TEST_TASKS_ENTRY ?? fileURLToPath(import.meta.resolve("@4fu/pi-tasks"))).replaceAll("\\", "/"))};
export default function(pi) {
  const registerCommand = pi.registerCommand.bind(pi);
  pi.registerCommand = (name, options) => registerCommand(name, name === "tasks" ? {
    ...options, handler: async (...args) => {
      await options.handler(...args);
      args[1].ui.notify("SOAK_TASKS_CLOSED", "info");
    }
  } : options);
  pi.registerCommand("soak-prompt-ready", { handler: async (_args, ctx) => ctx.ui.notify("SOAK_PROMPT_READY", "info") });
  // Elect a read-only reporter first to exercise routing to the pwsh owner.
  const reporter = registerTaskReporter(pi, "python");
  let catalogTimer;
  pi.on("session_start", (_e, ctx) => {
    const publish = () => reporter.publishCatalog(ctx.sessionManager.getSessionId(), [{
      taskKey: "python:py_test", taskId: "py_test", source: "python", phase: "completed",
      statusLabel: "completed", createdAt: 1, updatedAt: 1, summary: "READ_ONLY_REPORTER"
    }]);
    publish(); catalogTimer = setInterval(publish, 1000);
  });
  pi.on("session_shutdown", () => clearInterval(catalogTimer));
  pwsh(pi);
  pi.on("session_start", (_e, ctx) => { setTimeout(() => ctx.ui.notify("SOAK_SESSION_READY", "info"), 1000); });
  pi.registerProvider("soak-local", {
    baseUrl: "http://127.0.0.1:${port}/v1", apiKey: "local-test-only", api: "openai-completions",
    models: [{ id: "soak", name: "Soak test", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }]
  });
}
`);
async function until(predicate, label, ms = 20000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await predicate()) return;
		assert.equal(exited, false, `Pi exited while waiting for ${label}`);
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out: ${label}\n${text().slice(-5000)}`);
}
function send(value) { terminal.write(value); }
try {
	// The fixture uses defaults, not the caller's executable, profile or config file.
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("PI_PWSH_")));
	terminal = pty.spawn(runtime, [cli, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", fixture, "--provider", "soak-local", "--model", "soak", "--thinking", "off"], {
		cwd: dir, name: "xterm-256color", cols: 110, rows: 38,
		env: { ...env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_SKIP_VERSION_CHECK: "1", PI_PWSH_REPLACE_USER_BASH: "false", BUN_BE_BUN: "1" },
	});
	terminal.onData(data => { output += data; transcript += data; });
	terminal.onExit(() => { exited = true; });
	await until(() => text().includes("SOAK_SESSION_READY"), "Pi startup", 60000);
	send("Start the soak task\r");
	await until(async () => { try { processPid = Number((await readFile(readyPath, "utf8")).trim()); return processPid > 0; } catch { return false; } }, "PowerShell readiness");
	await until(() => text().includes("Ctrl+Alt+B background"), "wait hint");
	send("\x1b\x02"); // Ctrl+Alt+B in legacy terminal encoding.
	await until(() => text().includes("SOAK_DIALOG_AVAILABLE") && !!taskId, "foreground detach and model continuation");
	process.kill(processPid, 0);
	console.log(`PASS foreground detach: ${taskId}, child ${processPid} still alive`);
	output = "";
	send("/tasks\r");
	await until(() => text().includes("Enter inspect") && text().includes(`#${taskId}`), "active task manager");
	assert.ok(!text().includes("READ_ONLY_REPORTER"), "inactive task leaked into default active view");
	output = "";
	send("\t");
	// This is a render stream, not a screen: a late Active frame can precede the Inactive frame.
	await until(() => text().includes("Tasks · Inactive") && text().includes("READ_ONLY_REPORTER"), "inactive history");
	output = "";
	send("\t");
	await until(() => text().includes(`#${taskId}`) && text().includes("Enter inspect"), "return to active tasks");
	console.log("PASS active default and Tab history toggle");
	output = "";
	send("\r");
	await until(() => text().includes("log:") && text().includes("SOAK_STARTED"), "task output inspection");
	console.log("PASS inspect through read-only presentation owner");
	output = "";
	send("\x1b"); // Wait for Escape, otherwise the following k becomes Alt+k.
	await until(() => text().includes("Enter inspect"), "return to task list");
	output = "";
	send("k");
	await until(() => /confirm|stop.*\?|y.*confirm/i.test(text()), "stop confirmation");
	process.kill(processPid, 0);
	send("\x1b"); // Cancel must not kill.
	await until(() => text().includes("Enter inspect"), "cancel stop confirmation");
	process.kill(processPid, 0);
	output = "";
	send("k");
	await until(() => /confirm|stop.*\?|y.*confirm/i.test(text()), "second stop confirmation");
	send("y");
	await until(() => { try { process.kill(processPid, 0); return false; } catch { return true; } }, "confirmed process termination");
	console.log("PASS cancel confirmation preserves process; confirmed stop terminates it");
	await until(() => text().includes("SOAK_TASKS_CLOSED"), "last active stop closes viewer");
	output = "";
	send("/soak-prompt-ready\r");
	await until(() => text().includes("SOAK_PROMPT_READY"), "prompt editor accepts commands after stop");
	output = "";
	send("/tasks\r");
	await until(() => /No active tasks/i.test(text()), "empty active view remains accessible");
	output = "";
	send("\t");
	await until(() => text().includes(`#${taskId}`) && text().includes("READ_ONLY_REPORTER"), "stopped task retained in inactive history");
	console.log("PASS last-active stop returns to prompt; inactive history retains stopped task");
	await writeFile(join(dir, "terminal.log"), transcript);
	console.log(`PASS real ConPTY controls using ${runtime}\nArtifacts: ${dir}`);
} finally {
	await writeFile(join(dir, "terminal.log"), transcript);
	if (terminal && !exited) {
		for (const key of ["\x1b", "\x1b", "\x03", "\x03"]) {
			if (exited) break;
			terminal.write(key);
			await new Promise(resolve => setTimeout(resolve, 150));
		}
		const deadline = Date.now() + 5000;
		while (!exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
		if (!exited) spawnSync("taskkill", ["/PID", String(terminal.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
	}
	if (processPid) {
		try { process.kill(processPid, 0); spawnSync("taskkill", ["/PID", String(processPid), "/T", "/F"], { stdio: "ignore" }); } catch {}
	}
	if (terminal) assert.throws(() => process.kill(terminal.pid, 0), "Pi remained alive after smoke-test cleanup");
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
}
// node-pty 1.1 can retain ConPTY pipe handles after the child exits on Windows.
// This standalone harness owns no remaining processes or server connections.
await new Promise(resolve => process.stdout.write("", resolve));
process.exit(0);
