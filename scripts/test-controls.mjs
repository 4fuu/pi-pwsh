import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm, access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWaits } from "../src/task-waits.ts";
import { PwshTaskRuntime } from "../src/task-runtime.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { resolvePowerShellRuntime } from "../src/runtime.ts";
import { TaskNotificationManager } from "../src/task-notifications.ts";

const sample = { metadata: { id: "ps_1234abcd", status: "running" }, output: "working", ready: false, omittedBytes: 0 };
function fakeRuntime() {
	const calls = [];
	return { calls, snapshot(id, seconds, signal) {
		calls.push({ id, seconds });
		if (!seconds) return Promise.resolve(sample);
		return new Promise((_resolve, reject) => {
			if (signal.aborted) reject(signal.reason);
			else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	} };
}

test("background releases a wait with a normal snapshot, without aborting the agent", async () => {
	const waits = new TaskWaits(), runtime = fakeRuntime(), agent = new AbortController();
	const result = waits.snapshot(runtime, sample.metadata.id, 60, agent.signal);
	assert.equal(waits.background(), 1);
	assert.deepEqual(await result, { snapshot: sample, backgrounded: true });
	assert.equal(agent.signal.aborted, false);
	assert.deepEqual(runtime.calls.map(c => c.seconds), [60, 0]);
	assert.equal(waits.background(), 0);
});

test("immediate snapshots do not register a foreground wait", async () => {
	const waits = new TaskWaits(), runtime = fakeRuntime();
	assert.equal(waits.background(), 0);
	assert.deepEqual(await waits.snapshot(runtime, sample.metadata.id, 0), { snapshot: sample, backgrounded: false });
	assert.equal(waits.background(), 0);
});

test("agent abort remains an abort and removes its pending wait", async () => {
	const waits = new TaskWaits(), runtime = fakeRuntime(), agent = new AbortController();
	const result = waits.snapshot(runtime, sample.metadata.id, 60, agent.signal);
	const error = new Error("agent aborted");
	agent.abort(error);
	await assert.rejects(result, e => e === error);
	assert.equal(waits.background(), 0);
	assert.equal(runtime.calls.length, 1);
});

test("an abort racing with background does not return a successful snapshot", async () => {
	const waits = new TaskWaits(), runtime = fakeRuntime(), agent = new AbortController();
	const result = waits.snapshot(runtime, sample.metadata.id, 60, agent.signal);
	waits.background();
	agent.abort(new Error("agent aborted"));
	await assert.rejects(result);
	assert.equal(runtime.calls.length, 1);
});

test("background releases all concurrent pwsh waits once", async () => {
	const waits = new TaskWaits(), runtime = fakeRuntime();
	const results = ["ps_11111111", "ps_22222222"].map(id => waits.snapshot(runtime, id, 60));
	assert.equal(waits.background(), 2);
	assert.equal(waits.background(), 0);
	assert.ok((await Promise.all(results)).every(result => result.backgrounded));
});

test("background does not mask unrelated runtime failures", async () => {
	const waits = new TaskWaits(), error = new Error("disk read failed");
	const result = waits.snapshot({ snapshot: async () => { throw error; } }, sample.metadata.id, 60);
	waits.background();
	await assert.rejects(result, e => e === error);
	assert.equal(waits.background(), 0);
});

test("real PowerShell task survives detach, then completes with its output", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-controls-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "controls" });
	let id;
	try {
		id = (await runtime.start("Write-Output started; Start-Sleep -Seconds 3; Write-Output finished", dir)).id;
		const waits = new TaskWaits(), agent = new AbortController();
		const pending = waits.snapshot(runtime, id, 60, agent.signal);
		const start = Date.now();
		assert.equal(waits.background(), 1);
		const result = await pending;
		assert.ok(Date.now() - start < 2000);
		assert.equal(result.backgrounded, true);
		assert.ok(["starting", "running"].includes(result.snapshot.metadata.status));
		assert.equal(agent.signal.aborted, false);
		const done = await runtime.snapshot(id, 15);
		assert.equal(done.metadata.status, "completed");
		assert.match(done.output, /finished/);
	} finally {
		if (id) await runtime.stop(id);
		await rm(dir, { recursive: true, force: true });
	}
});

test("user stop kills the Windows process tree without consuming the agent notification", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-controls-stop-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "controls" });
	let id;
	try {
		id = (await runtime.start("$child = Start-Process pwsh -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; Write-Output \"child=$($child.Id)\"; Start-Sleep -Seconds 60", dir, "child=")).id;
		const started = await runtime.snapshot(id, 10, undefined, { claimTerminal: false });
		const child = Number(started.output.match(/child=(\d+)/)?.[1]);
		assert.ok(child > 0, started.output);
		process.kill(child, 0);
		const stopped = await runtime.stop(id, { claimTerminal: false });
		assert.equal(stopped.metadata.status, "cancelled");
		assert.throws(() => process.kill(child, 0));
		await assert.rejects(access(join(runtime.taskDirectoryPath(id), `${stopped.metadata.instanceId}.exit.presented`)));
		await runtime.snapshot(id);
		await access(join(runtime.taskDirectoryPath(id), `${stopped.metadata.instanceId}.exit.presented`));
	} finally {
		if (id) await runtime.stop(id);
		await rm(dir, { recursive: true, force: true });
	}
});

async function deletionFixture() {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-delete-"));
	const runtime = new PwshTaskRuntime({ ...DEFAULT_CONFIG, executable: process.execPath, args: [] }, { taskDir: dir, sessionId: "owner" });
	const add = async (id, status = "completed", sessionId = "owner") => {
		const directory = runtime.taskDirectoryPath(id), now = new Date().toISOString();
		const metadata = { version: 1, id, instanceId: id.slice(3).repeat(4), sessionId, supervisorPid: process.pid,
			cwd: dir, command: "fixture", commandSummary: "fixture", createdAt: now, updatedAt: now, status, exitCode: status === "completed" ? 0 : null };
		await mkdir(directory);
		await writeFile(join(directory, "meta.json"), JSON.stringify(metadata));
		await writeFile(join(directory, "output.log"), "retained log");
		return metadata;
	};
	return { dir, runtime, add };
}

test("delete removes owned inactive records and logs but rejects active, foreign and invalid IDs", async () => {
	const { dir, runtime, add } = await deletionFixture();
	try {
		for (const [id, phase] of [["ps_11111111", "completed"], ["ps_22222222", "failed"], ["ps_33333333", "cancelled"]]) {
			await add(id, phase);
			assert.equal((await runtime.list()).length, 1); // Populate the terminal cache before deletion.
			assert.equal((await runtime.deleteInactive(id)).id, id);
			await assert.rejects(access(runtime.taskDirectoryPath(id)), { code: "ENOENT" });
			assert.deepEqual(await runtime.list(), []);
		}
		await add("ps_44444444", "running");
		await add("ps_55555555", "completed", "foreign");
		await assert.rejects(runtime.deleteInactive("ps_44444444"), /active tasks cannot be deleted/);
		await assert.rejects(runtime.deleteInactive("ps_55555555"), /different session/);
		await assert.rejects(runtime.deleteInactive("../outside"));
		await access(join(runtime.taskDirectoryPath("ps_44444444"), "output.log"));
		await access(join(runtime.taskDirectoryPath("ps_55555555"), "output.log"));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("observer deletion updates the catalog and late notification callbacks tolerate removed logs", async () => {
	const { dir, runtime, add } = await deletionFixture();
	let callbacks, catalog;
	const observer = new TaskNotificationManager({ offer(_event, value) { callbacks = value; }, withdrawTask() {} },
		{ publishCatalog(_session, tasks) { catalog = tasks; } }, { hasUI: false }, runtime, "owner", 0);
	try {
		const task = await add("ps_66666666");
		await observer.start();
		assert.equal(catalog.length, 1); assert.ok(callbacks);
		await observer.deleteInactive(task.id);
		assert.deepEqual(catalog, []);
		await callbacks.onSubmitted();
		await callbacks.onDelivered();
		await callbacks.onWithdrawn("retry-exhausted");
		await assert.rejects(access(runtime.taskDirectoryPath(task.id)), { code: "ENOENT" });
	} finally { await observer.close(); await rm(dir, { recursive: true, force: true }); }
});

test("deletion waits for an in-flight scan and concurrent deletions remain serialized", async () => {
	const { dir, runtime, add } = await deletionFixture();
	let release, entered, catalog;
	const gate = new Promise(resolve => { release = resolve; });
	const scanning = new Promise(resolve => { entered = resolve; });
	const originalList = runtime.list.bind(runtime);
	let blocked = true;
	runtime.list = async (...args) => { if (blocked) { blocked = false; entered(); await gate; } return originalList(...args); };
	const observer = new TaskNotificationManager({ offer() {}, withdrawTask() {} },
		{ publishCatalog(_session, tasks) { catalog = tasks; } }, { hasUI: false }, runtime, "owner", 0);
	try {
		await add("ps_77777777"); await add("ps_88888888");
		const started = observer.start(); await scanning;
		const one = observer.deleteInactive("ps_77777777"), two = observer.deleteInactive("ps_88888888");
		await access(runtime.taskDirectoryPath("ps_77777777"));
		release(); await Promise.all([started, one, two]);
		assert.deepEqual(catalog, []); assert.deepEqual(await runtime.list(), []);
	} finally { release(); await observer.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an already aborted start does not launch", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-foreground-preabort-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	try {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(runtime.start("Start-Sleep -Seconds 30", dir, undefined, "", {}, controller.signal), /aborted/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("abort during start presents the cancellation before it is observable", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-foreground-present-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	try {
		const controller = new AbortController();
		const pending = runtime.start("Start-Sleep -Seconds 30", dir, undefined, "", {}, controller.signal);
		controller.abort();
		await assert.rejects(pending, /aborted/);
		const tasks = (await readdir(dir)).filter((name) => name.startsWith("ps_"));
		assert.equal(tasks.length, 1);
		const markers = await readdir(join(dir, tasks[0]));
		assert.ok(markers.some((name) => name.endsWith(".exit.presented")), markers.join(","));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("waitUntilExit returns only after the command exits", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-foreground-exit-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	let id;
	try {
		const started = Date.now();
		id = (await runtime.start("Start-Sleep -Seconds 2; Write-Output done", dir)).id;
		const snapshot = await runtime.waitUntilExit(id);
		assert.ok(Date.now() - started >= 1500, `returned too early after ${Date.now() - started}ms`);
		assert.equal(snapshot.metadata.status, "completed");
		assert.match(snapshot.output, /done/);
	} finally {
		if (id) await runtime.stop(id);
		await rm(dir, { recursive: true, force: true });
	}
});

test("aborting a foreground wait kills the Windows process tree", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-foreground-kill-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	let id;
	try {
		id = (await runtime.start("$child = Start-Process pwsh -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; Write-Output \"child=$($child.Id)\"; Start-Sleep -Seconds 60", dir, "child=")).id;
		const controller = new AbortController();
		const pending = runtime.waitUntilExit(id, controller.signal);
		const started = await runtime.snapshot(id, 10, undefined, { claimTerminal: false });
		const child = Number(started.output.match(/child=(\d+)/)?.[1]);
		assert.ok(child > 0, started.output);
		assert.ok((started.metadata.supervisorPid ?? 0) > 0);
		process.kill(child, 0);
		controller.abort();
		await assert.rejects(pending, /aborted/);
		assert.throws(() => process.kill(child, 0));
		const markers = await readdir(runtime.taskDirectoryPath(id));
		assert.ok(markers.some((name) => name.endsWith(".exit.presented")), markers.join(","));
		const stopped = await runtime.snapshot(id, 0, undefined, { claimTerminal: false });
		assert.equal(stopped.metadata.status, "cancelled");
	} finally {
		if (id) await runtime.stop(id);
		await rm(dir, { recursive: true, force: true });
	}
});

function detachedSleeper() {
	return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
}

function deadSupervisorPid() {
	const ghost = 2_147_483_647;
	let alive = false;
	try {
		process.kill(ghost, 0);
		alive = true;
	} catch (error) {
		alive = error?.code === "EPERM";
	}
	assert.equal(alive, false);
	return ghost;
}

async function parkedTask(runtime, id, fields) {
	const directory = runtime.taskDirectoryPath(id);
	const now = new Date().toISOString();
	const instanceId = id.slice(3).repeat(4);
	const metadata = {
		version: 1, id, instanceId, sessionId: "foreground", supervisorPid: 0, cwd: directory,
		command: "fixture", commandSummary: "fixture", createdAt: now, updatedAt: now,
		status: "running", exitCode: null, ...fields,
	};
	await mkdir(directory);
	await writeFile(join(directory, "meta.json"), JSON.stringify(metadata));
	await writeFile(join(directory, "output.log"), "");
	return { directory, metadata, instanceId };
}

test("aborting a foreground wait still kills when the presented marker fails", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-marker-fail-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	const child = detachedSleeper();
	try {
		await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
		const id = "ps_a11a11a1";
		await parkedTask(runtime, id, { pid: child.pid });
		runtime.markPresented = async () => { throw new Error("disk full"); };
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			runtime.waitUntilExit(id, controller.signal),
			/aborted; cleanup failed \(presented marker: disk full\)/,
		);
		assert.throws(() => process.kill(child.pid, 0));
		assert.equal((await runtime.readMetadata(id)).status, "cancelled");
	} finally {
		if (child.exitCode === null) child.kill();
		await rm(dir, { recursive: true, force: true });
	}
});

test("stop keeps a completion that lands while the tree is being killed", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-stop-completed-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	const child = detachedSleeper();
	try {
		await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
		const id = "ps_b22b22b2";
		const parked = await parkedTask(runtime, id, { pid: child.pid });
		const pending = runtime.stop(id);
		const cancelPath = join(parked.directory, `${parked.instanceId}.cancelled`);
		const deadline = Date.now() + 3_000;
		while (!existsSync(cancelPath)) {
			if (Date.now() > deadline) throw new Error("cancel marker did not appear");
			await new Promise((resolve) => setImmediate(resolve));
		}
		writeFileSync(join(parked.directory, "meta.json"), JSON.stringify({
			...parked.metadata, status: "completed", exitCode: 7, updatedAt: new Date().toISOString(),
		}));
		const stopped = await pending;
		assert.equal(stopped.metadata.status, "completed");
		assert.equal(stopped.metadata.exitCode, 7);
	} finally {
		if (child.exitCode === null) child.kill();
		await rm(dir, { recursive: true, force: true });
	}
});

test("stop keeps a command failure that lands while the tree is being killed", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-stop-failed-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	const child = detachedSleeper();
	try {
		await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
		const id = "ps_f66f66f6";
		const parked = await parkedTask(runtime, id, { pid: child.pid });
		const pending = runtime.stop(id);
		const cancelPath = join(parked.directory, `${parked.instanceId}.cancelled`);
		const deadline = Date.now() + 3_000;
		while (!existsSync(cancelPath)) {
			if (Date.now() > deadline) throw new Error("cancel marker did not appear");
			await new Promise((resolve) => setImmediate(resolve));
		}
		writeFileSync(join(parked.directory, "meta.json"), JSON.stringify({
			...parked.metadata, status: "failed", exitCode: 3, error: "command failed", updatedAt: new Date().toISOString(),
		}));
		const stopped = await pending;
		assert.equal(stopped.metadata.status, "failed");
		assert.equal(stopped.metadata.exitCode, 3);
		assert.equal(stopped.metadata.failureKind, undefined);
	} finally {
		if (child.exitCode === null) child.kill();
		await rm(dir, { recursive: true, force: true });
	}
});

test("stop kills a reparented child after refresh already recorded a dead supervisor", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-stop-orphan-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	const child = detachedSleeper();
	const ghost = 2_147_483_647;
	try {
		let ghostAlive = false;
		try {
			process.kill(ghost, 0);
			ghostAlive = true;
		} catch (error) {
			ghostAlive = error?.code === "EPERM";
		}
		assert.equal(ghostAlive, false);
		await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
		const id = "ps_c33c33c3";
		const parked = await parkedTask(runtime, id, { supervisorPid: ghost, pid: child.pid });
		const stopped = await runtime.stop(id);
		assert.equal(stopped.metadata.status, "cancelled");
		assert.equal(stopped.metadata.failureKind, undefined);
		assert.throws(() => process.kill(child.pid, 0));
		await access(join(parked.directory, `${parked.instanceId}.exit.presented`));
	} finally {
		if (child.exitCode === null) child.kill();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a foreground wait kills a reparented child when the supervisor is already dead", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-wait-orphan-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	const child = detachedSleeper();
	const ghost = 2_147_483_647;
	try {
		let ghostAlive = false;
		try {
			process.kill(ghost, 0);
			ghostAlive = true;
		} catch (error) {
			ghostAlive = error?.code === "EPERM";
		}
		assert.equal(ghostAlive, false);
		await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
		const id = "ps_d44d44d4";
		await parkedTask(runtime, id, { supervisorPid: ghost, pid: child.pid });
		const snapshot = await runtime.waitUntilExit(id);
		assert.equal(snapshot.metadata.status, "cancelled");
		assert.throws(() => process.kill(child.pid, 0));
	} finally {
		if (child.exitCode === null) child.kill();
		await rm(dir, { recursive: true, force: true });
	}
});

test("stop does not kill a recorded child while its supervisor is still alive", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-stop-live-supervisor-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	const supervisor = detachedSleeper();
	const child = detachedSleeper();
	try {
		await Promise.all([supervisor, child].map((proc) => new Promise((resolve, reject) => {
			proc.once("spawn", resolve);
			proc.once("error", reject);
		})));
		const id = "ps_a77a77a7";
		await parkedTask(runtime, id, { supervisorPid: supervisor.pid, pid: child.pid });
		const stopped = await runtime.stop(id);
		assert.equal(stopped.metadata.status, "cancelled");
		assert.throws(() => process.kill(supervisor.pid, 0));
		process.kill(child.pid, 0);
	} finally {
		if (supervisor.exitCode === null) supervisor.kill();
		if (child.exitCode === null) child.kill();
		await rm(dir, { recursive: true, force: true });
	}
});

test("an abort during a supervisor-loss stop keeps the cleanup error", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-stop-abort-cleanup-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	const child = detachedSleeper();
	const ghost = 2_147_483_647;
	try {
		let ghostAlive = false;
		try {
			process.kill(ghost, 0);
			ghostAlive = true;
		} catch (error) {
			ghostAlive = error?.code === "EPERM";
		}
		assert.equal(ghostAlive, false);
		await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
		const id = "ps_b88b88b8";
		await parkedTask(runtime, id, { supervisorPid: ghost, pid: child.pid });
		const controller = new AbortController();
		runtime.markPresented = async () => {
			controller.abort();
			throw new Error("disk full");
		};
		await assert.rejects(
			runtime.waitUntilExit(id, controller.signal),
			/aborted; cleanup failed \(presented marker: disk full\)/,
		);
		assert.throws(() => process.kill(child.pid, 0));
		assert.equal((await runtime.readMetadata(id)).status, "cancelled");
	} finally {
		if (child.exitCode === null) child.kill();
		await rm(dir, { recursive: true, force: true });
	}
});

test("list does not keep a supervisor-loss failure after stop", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-stop-cache-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	const ghost = 2_147_483_647;
	try {
		let ghostAlive = false;
		try {
			process.kill(ghost, 0);
			ghostAlive = true;
		} catch (error) {
			ghostAlive = error?.code === "EPERM";
		}
		assert.equal(ghostAlive, false);
		const id = "ps_e55e55e5";
		await parkedTask(runtime, id, { supervisorPid: ghost });
		assert.equal((await runtime.list()).find((task) => task.id === id)?.status, "failed");
		assert.equal((await runtime.stop(id)).metadata.status, "cancelled");
		assert.equal((await runtime.list()).find((task) => task.id === id)?.status, "cancelled");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a cancel marker is announced as cancelled while the record is still supervisor loss", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-announce-cancel-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	const child = detachedSleeper();
	const ghost = deadSupervisorPid();
	let offered;
	let catalog = [];
	const observer = new TaskNotificationManager(
		{ offer(event) { offered = event; }, withdrawTask() {} },
		{ publishCatalog(_session, tasks) { catalog = tasks; } },
		{ hasUI: false }, runtime, "foreground", 0,
	);
	try {
		await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
		const id = "ps_c99c99c9";
		const parked = await parkedTask(runtime, id, { supervisorPid: ghost, pid: child.pid });
		await writeFile(join(parked.directory, `${parked.instanceId}.cancelled`), "");
		await observer.start();
		assert.equal(offered?.status, "cancelled");
		assert.equal(catalog.find((task) => task.taskId === id)?.phase, "cancelled");
		process.kill(child.pid, 0);
		const disk = await runtime.readMetadata(id);
		assert.equal(disk.status, "failed");
		assert.equal(disk.error, "Task supervisor exited without final status");
		const stopped = await runtime.stop(id);
		assert.equal(stopped.metadata.status, "cancelled");
		assert.throws(() => process.kill(child.pid, 0));
	} finally {
		await observer.close();
		if (child.exitCode === null) child.kill();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a presented startup failure is not announced as a user cancellation", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-announce-startup-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	const child = detachedSleeper();
	const ghost = deadSupervisorPid();
	let offered;
	let catalog = [];
	const observer = new TaskNotificationManager(
		{ offer(event) { offered = event; }, withdrawTask() {} },
		{ publishCatalog(_session, tasks) { catalog = tasks; } },
		{ hasUI: false }, runtime, "foreground", 0,
	);
	try {
		await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
		const id = "ps_d00d00d0";
		const parked = await parkedTask(runtime, id, { supervisorPid: ghost, pid: child.pid });
		await writeFile(join(parked.directory, `${parked.instanceId}.cancelled`), "");
		await writeFile(join(parked.directory, `${parked.instanceId}.exit.presented`), "");
		await observer.start();
		assert.equal(offered, undefined);
		assert.equal(catalog.find((task) => task.taskId === id)?.statusLabel, "failed");
		process.kill(child.pid, 0);
	} finally {
		await observer.close();
		if (child.exitCode === null) child.kill();
		await rm(dir, { recursive: true, force: true });
	}
});

test("deleting supervisor loss kills the recorded child and keeps an exited command", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-delete-orphan-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	const orphan = detachedSleeper();
	const exited = detachedSleeper();
	const ghost = deadSupervisorPid();
	const loss = {
		status: "failed", failureKind: "infrastructure", exitCode: null,
		error: "Task supervisor exited without final status",
	};
	try {
		await Promise.all([orphan, exited].map((proc) => new Promise((resolve, reject) => {
			proc.once("spawn", resolve);
			proc.once("error", reject);
		})));
		await parkedTask(runtime, "ps_e11e11e1", { supervisorPid: ghost, pid: orphan.pid, ...loss });
		await parkedTask(runtime, "ps_e22e22e2", { supervisorPid: ghost, pid: exited.pid, status: "failed", exitCode: 3, error: "command failed" });
		await runtime.deleteInactive("ps_e11e11e1");
		await runtime.deleteInactive("ps_e22e22e2");
		assert.throws(() => process.kill(orphan.pid, 0));
		process.kill(exited.pid, 0);
		await assert.rejects(access(runtime.taskDirectoryPath("ps_e11e11e1")), { code: "ENOENT" });
		await assert.rejects(access(runtime.taskDirectoryPath("ps_e22e22e2")), { code: "ENOENT" });
	} finally {
		if (orphan.exitCode === null) orphan.kill();
		if (exited.exitCode === null) exited.kill();
		await rm(dir, { recursive: true, force: true });
	}
});

test("retention kills an expired supervisor-loss child and keeps an exited command", { timeout: 30000, skip: process.platform !== "win32" }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-retain-orphan-"));
	const runtime = new PwshTaskRuntime(await resolvePowerShellRuntime(DEFAULT_CONFIG), { taskDir: dir, sessionId: "foreground" });
	const orphan = detachedSleeper();
	const exited = detachedSleeper();
	const ghost = deadSupervisorPid();
	const expired = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
	try {
		await Promise.all([orphan, exited].map((proc) => new Promise((resolve, reject) => {
			proc.once("spawn", resolve);
			proc.once("error", reject);
		})));
		await parkedTask(runtime, "ps_f11f11f1", {
			supervisorPid: ghost, pid: orphan.pid, updatedAt: expired,
			status: "failed", failureKind: "infrastructure", exitCode: null,
			error: "Task supervisor exited without final status",
		});
		await parkedTask(runtime, "ps_f22f22f2", {
			supervisorPid: ghost, pid: exited.pid, updatedAt: expired,
			status: "failed", exitCode: 3, error: "command failed",
		});
		await runtime.cleanupExpired();
		assert.throws(() => process.kill(orphan.pid, 0));
		process.kill(exited.pid, 0);
		await assert.rejects(access(runtime.taskDirectoryPath("ps_f11f11f1")), { code: "ENOENT" });
		await assert.rejects(access(runtime.taskDirectoryPath("ps_f22f22f2")), { code: "ENOENT" });
	} finally {
		if (orphan.exitCode === null) orphan.kill();
		if (exited.exitCode === null) exited.kill();
		await rm(dir, { recursive: true, force: true });
	}
});
