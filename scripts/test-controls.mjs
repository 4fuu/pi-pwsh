import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskWaits } from "../src/task-waits.ts";
import { PwshTaskRuntime } from "../src/task-runtime.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { resolvePowerShellRuntime } from "../src/runtime.ts";

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

test("real PowerShell task survives detach, then completes with its output", { timeout: 30000 }, async () => {
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
