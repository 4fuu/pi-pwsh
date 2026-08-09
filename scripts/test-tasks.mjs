import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PwshTaskRuntime } from "../src/task-runtime.ts";
import { validate, DESCRIPTION, PROMPT_GUIDELINE, PwshParams } from "../src/index.ts";
import { TaskNotificationManager } from "../src/task-notifications.ts";

const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-test-"));
const runtime = new PwshTaskRuntime({ executable: process.execPath, args: [], loadProfile: false, executionPolicy: null, stopOnError: false, pythonUtf8: false, pythonUnbuffered: false }, { taskDir: dir, sessionId: "one" });
const id = "ps_1234abcd", task = runtime.taskDirectoryPath(id), now = new Date().toISOString();
await mkdir(task);
const meta = { version: 1, id, instanceId: "a".repeat(32), sessionId: "two", supervisorPid: 0, cwd: dir, command: "x", commandSummary: "x", createdAt: now, updatedAt: now, status: "completed", exitCode: 0 };
await writeFile(join(task, "meta.json"), JSON.stringify(meta)); await writeFile(join(task, "output.log"), "ok");
for (const operation of [() => runtime.snapshot(id), () => runtime.snapshot(id, 1), () => runtime.stop(id)]) await assert.rejects(operation, /different session/);

runtime.setSessionId("two");
const controller = new AbortController(); controller.abort(new Error("cancel wait"));
await assert.rejects(() => runtime.snapshot(id, 1, controller.signal), /cancel wait/);
assert.equal((await runtime.readMetadata(id)).status, "completed");

assert.throws(() => validate({}), /exactly one/);
assert.throws(() => validate({ command: "x", taskId: id }), /exactly one/);
assert.throws(() => validate({ taskId: id, notifyOn: "x" }), /command/);
assert.throws(() => validate({ taskId: id, stop: true, wait: 1 }), /wait is not accepted/);
assert.throws(() => validate({ command: "x", notifyOn: "😀".repeat(65) }), /UTF-8 bytes/);
assert.doesNotThrow(() => validate({ command: "Get-ChildItem", notifyOn: "ready", wait: 1 }));
assert.match(DESCRIPTION, /PowerShell 7/); assert.match(DESCRIPTION, /\$env:NAME/); assert.match(DESCRIPTION, /bound paths/); assert.match(PROMPT_GUIDELINE, /persistent background task/);
assert.ok(PwshParams);

// Listing must filter ownership before refresh, so stale foreign metadata is
// neither returned nor rewritten by this session.
runtime.setSessionId("one");
assert.deepEqual(await runtime.list(), []);
assert.deepEqual(JSON.parse(await readFile(join(task, "meta.json"), "utf8")), meta);
const foreignStaleId = "ps_badf00d0", foreignStaleTask = runtime.taskDirectoryPath(foreignStaleId);
await mkdir(foreignStaleTask);
const foreignStale = { ...meta, id: foreignStaleId, instanceId: "f".repeat(32), status: "running", supervisorPid: 99999999, exitCode: undefined };
await writeFile(join(foreignStaleTask, "meta.json"), JSON.stringify(foreignStale));
await writeFile(join(foreignStaleTask, "output.log"), "");
await assert.rejects(() => runtime.snapshot(foreignStaleId), /different session/);
assert.deepEqual(await runtime.list(), []);
assert.deepEqual(JSON.parse(await readFile(join(foreignStaleTask, "meta.json"), "utf8")), JSON.parse(JSON.stringify(foreignStale)));

// Literal readiness is UTF-8 byte based and works across the scanner's 64 KiB
// chunk boundary. A stop decision leaves a durable marker and terminal state.
const ownId = "ps_deadbeef", ownTask = runtime.taskDirectoryPath(ownId), ownInstance = "b".repeat(32);
await mkdir(ownTask);
const ownMeta = { ...meta, id: ownId, instanceId: ownInstance, sessionId: "one", status: "running", notifyOn: "😀ready", exitCode: undefined };
await writeFile(join(ownTask, "meta.json"), JSON.stringify(ownMeta));
await writeFile(join(ownTask, "output.log"), `${"x".repeat(65534)}😀ready`);
await writeFile(join(ownTask, `${ownInstance}.ready.detected`), "");
assert.equal((await runtime.snapshot(ownId, 0, undefined, { claimTerminal: false })).ready, true);
assert.equal((await runtime.stop(ownId)).metadata.status, "cancelled");
assert.equal(await readFile(join(ownTask, `${ownInstance}.cancelled`), "utf8"), "");

// The detached launcher owns readiness scanning so long-lived task queries stay
// O(new output), including a multi-byte literal split at a 64 KiB boundary.
const launchId = "ps_feedface", launchTask = runtime.taskDirectoryPath(launchId), launchInstance = "c".repeat(32);
await mkdir(launchTask);
const launchMeta = { ...meta, id: launchId, instanceId: launchInstance, sessionId: "one", status: "starting", notifyOn: "😀ready", exitCode: undefined };
const launchLog = join(launchTask, "output.log"), launchMetaPath = join(launchTask, "meta.json");
const readyMarker = join(launchTask, `${launchInstance}.ready.detected`);
const cancelMarker = join(launchTask, `${launchInstance}.cancelled`);
await writeFile(launchMetaPath, JSON.stringify(launchMeta));
await writeFile(launchLog, "");
const launcherPath = fileURLToPath(new URL("../src/task-launcher.mjs", import.meta.url));
const source = "const b=Buffer.concat([Buffer.alloc(65534,120),Buffer.from('😀ready'),Buffer.alloc(60000,122)]);process.stdout.write(b);setTimeout(()=>{},250)";
const launchConfig = join(launchTask, "config.json");
await writeFile(launchConfig, JSON.stringify({
	id: launchId,
	instanceId: launchInstance,
	executable: process.execPath,
	args: ["-e", source],
	cwd: dir,
	logPath: launchLog,
	metaPath: launchMetaPath,
	notifyOn: "😀ready",
	readyMarkerPath: readyMarker,
	cancelMarkerPath: cancelMarker,
}));
const launcher = spawn(process.execPath, [launcherPath, launchConfig], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
await new Promise((resolve, reject) => {
	launcher.once("error", reject);
	launcher.on("message", message => message?.type === "ready" && resolve());
});
const ready = await runtime.snapshot(launchId, 2, undefined, { claimTerminal: false });
assert.equal(ready.ready, true);
assert.ok(ready.omittedBytes > 50000);
if (launcher.exitCode === null) await new Promise(resolve => launcher.once("exit", resolve));
assert.equal((await runtime.readMetadata(launchId)).status, "completed");

// Terminal delivery is session-scoped and durable. A task already returned by
// the tool still gets compact status, but its full output is not injected twice.
const messages = [], widgets = [];
const pi = { sendMessage: (message, options) => messages.push({ message, options }) };
const ctx = {
	hasUI: true,
	mode: "print",
	ui: { setWidget: (...args) => widgets.push(args), notify() {} },
};
const manager = new TaskNotificationManager(pi, ctx, runtime, "one", 0);
await manager.start();
assert.equal(messages.length, 1);
assert.deepEqual(messages[0].options, { deliverAs: "steer", triggerTurn: true });
const delivered = messages[0].message.details.tasks;
assert.ok(delivered.some(task => task.taskId === launchId && task.status === "completed" && task.output.length === 4000));
assert.ok(delivered.some(task => task.taskId === ownId && task.outputAlreadyReceived && task.output === ""));
assert.ok(!JSON.stringify(messages).includes("secret"));
await manager.close();
const resumed = new TaskNotificationManager(pi, ctx, runtime, "one", 0);
await resumed.start();
assert.equal(messages.length, 1);
await resumed.close();
assert.ok(widgets.length > 0);

// A process crash after claiming must not permanently suppress delivery. An
// expired lease is recoverable, and a synchronous send failure releases it.
const retryId = "ps_cafebabe", retryTask = runtime.taskDirectoryPath(retryId), retryInstance = "d".repeat(32);
await mkdir(retryTask);
await writeFile(join(retryTask, "meta.json"), JSON.stringify({ ...meta, id: retryId, instanceId: retryInstance, sessionId: "one" }));
await writeFile(join(retryTask, "output.log"), "retry me");
const retryLease = join(retryTask, `${retryInstance}.exit.notifying`);
await writeFile(retryLease, "");
const stale = new Date(Date.now() - 60_000);
await utimes(retryLease, stale, stale);
const retriedMessages = [];
let retryAttempts = 0;
const retrying = new TaskNotificationManager({ sendMessage: (message) => {
	retryAttempts++;
	if (retryAttempts === 1) throw new Error("injected send failure");
	retriedMessages.push(message);
} }, ctx, runtime, "one", 0);
await retrying.start();
assert.equal(retryAttempts, 1);
await retrying.scanNow();
assert.equal(retryAttempts, 2);
assert.equal(retriedMessages.length, 1);
assert.equal(retriedMessages[0].details.tasks[0].taskId, retryId);
await retrying.close();

await rm(dir, { recursive: true, force: true });
console.log("task runtime/schema tests passed (PowerShell process e2e skipped: pwsh is not installed)");
