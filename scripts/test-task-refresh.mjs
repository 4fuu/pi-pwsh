import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { PwshTaskRuntime } from "../src/task-runtime.ts";
import { mutateMetadataSnapshots, readLatestMetadataSnapshot } from "../src/task-metadata-store.mjs";

async function fixture(t) {
	const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-refresh-"));
	t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
	const runtime = new PwshTaskRuntime({ executable: process.execPath, args: [], loadProfile: false, executionPolicy: null, stopOnError: false, pythonUtf8: false, pythonUnbuffered: false }, { taskDir: dir, sessionId: "refresh" });
	const id = "ps_1234abcd";
	const task = runtime.taskDirectoryPath(id);
	const metadataDir = join(task, "metadata");
	const old = new Date(Date.now() - 60_000).toISOString();
	await mkdir(task);
	const metadata = {
		version: 1, id, instanceId: "a".repeat(32), sessionId: "refresh", supervisorPid: 0,
		cwd: dir, commandSummary: "test task", createdAt: old, updatedAt: old, status: "starting",
	};
	await mutateMetadataSnapshots(metadataDir, () => metadata, { allowCreate: true });
	await writeFile(join(task, "output.log"), "task output");
	return { runtime, id, metadata, metadataDir };
}

// Hold a real writer transaction at a barrier, rather than guessing when a
// timer will interleave with the refresh's read and lock acquisition.
async function holdWriter(metadataDir, update) {
	const entered = Promise.withResolvers();
	const released = Promise.withResolvers();
	const completed = mutateMetadataSnapshots(metadataDir, async (current) => {
		entered.resolve();
		await released.promise;
		return update(current);
	});
	completed.catch(() => {});
	await Promise.race([entered.promise, completed]);
	return { release: () => released.resolve(), completed };
}

async function waitForQueuedRefresh(metadataDir) {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const tickets = (await readdir(metadataDir)).filter((name) => name.startsWith(".writer-ticket."));
		if (tickets.length >= 2) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("refresh did not queue behind the held writer");
}

async function snapshotAfterQueuedWriter(runtime, id, metadataDir, update) {
	const writer = await holdWriter(metadataDir, update);
	const pending = runtime.snapshot(id, 0, undefined, { claimTerminal: false });
	pending.catch(() => {});
	try {
		await waitForQueuedRefresh(metadataDir);
	} finally {
		writer.release();
		await writer.completed;
	}
	return pending;
}

test("snapshot does not fail a launcher that became live while refresh waited for the writer", { timeout: 15_000 }, async (t) => {
	const { runtime, id, metadataDir } = await fixture(t);
	const snapshot = await snapshotAfterQueuedWriter(runtime, id, metadataDir,
		(current) => ({ ...current, status: "running", supervisorPid: process.pid }));
	assert.equal(snapshot.metadata.status, "running");
	assert.equal(snapshot.metadata.supervisorPid, process.pid);
	assert.equal(snapshot.metadata.error, undefined);
	assert.equal((await readLatestMetadataSnapshot(metadataDir)).revision, 1, "refresh must not publish a false failure");
});

test("snapshot and list tolerate a busy writer and reconcile the stale launcher on a later poll", { timeout: 20_000 }, async (t) => {
	const { runtime, id, metadata, metadataDir } = await fixture(t);
	const writer = await holdWriter(metadataDir, () => undefined);
	try {
		const results = await Promise.allSettled([
			runtime.snapshot(id),
			runtime.list(),
		]);
		for (const result of results) assert.equal(result.status, "fulfilled", String(result.reason));
		assert.equal(results[0].value.metadata.status, "starting");
		assert.equal(results[0].value.output, "task output");
		assert.equal(results[1].value[0].status, "starting");
		assert.equal((await readdir(runtime.taskDirectoryPath(id))).includes(`${metadata.instanceId}.exit.presented`), false);
	} finally {
		writer.release();
		await writer.completed;
	}
	const reconciled = await runtime.snapshot(id, 0, undefined, { claimTerminal: false });
	assert.equal(reconciled.metadata.status, "failed");
	assert.equal(reconciled.metadata.error, "Task launcher did not become ready");
	assert.equal(reconciled.metadata.failureKind, "infrastructure");
});

for (const scenario of [
	{ name: "a starting launcher with a live supervisor", patch: () => ({ supervisorPid: process.pid }), status: "starting" },
	{ name: "a fresh starting record", patch: () => ({ createdAt: new Date().toISOString() }), status: "starting" },
	{ name: "a completed command", patch: () => ({ status: "completed", exitCode: 0 }), status: "completed" },
	{ name: "a failed command", patch: () => ({ status: "failed", exitCode: 42, error: "command failed" }), status: "failed", error: "command failed" },
	{ name: "a cancelled command", patch: () => ({ status: "cancelled", exitCode: null }), status: "cancelled" },
	{ name: "a replacement task instance", patch: () => ({ instanceId: "b".repeat(32) }), status: "starting" },
	{ name: "a now-dead supervisor", patch: () => ({ status: "running", supervisorPid: 99_999_999 }), status: "failed", error: "Task supervisor exited without final status" },
]) {
	test(`queued refresh respects ${scenario.name}`, { timeout: 15_000 }, async (t) => {
		const { runtime, id, metadataDir } = await fixture(t);
		const snapshot = await snapshotAfterQueuedWriter(runtime, id, metadataDir,
			(current) => ({ ...current, ...scenario.patch() }));
		assert.equal(snapshot.metadata.status, scenario.status);
		assert.equal(snapshot.metadata.error, scenario.error);
		assert.equal((await readLatestMetadataSnapshot(metadataDir)).revision, scenario.error === "Task supervisor exited without final status" ? 2 : 1);
	});
}

test("reconciliation does not hide filesystem errors other than writer contention", async (t) => {
	const { runtime, id } = await fixture(t);
	const denied = Object.assign(new Error("metadata publication denied"), { code: "EACCES" });
	const original = fs.writeFile;
	t.mock.method(fs, "writeFile", async (path, ...args) => {
		if (basename(String(path)).startsWith(".writer-choosing.")) throw denied;
		return original(path, ...args);
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	await assert.rejects(() => runtime.snapshot(id), (error) => error === denied);
	await assert.rejects(() => runtime.list(), (error) => error === denied);
});

test("reconciliation does not hide EBUSY from snapshot publication", { timeout: 15_000 }, async (t) => {
	const { runtime, id, metadataDir } = await fixture(t);
	const busy = Object.assign(new Error("snapshot publication stayed busy"), { code: "EBUSY" });
	const original = fs.rename;
	t.mock.method(fs, "rename", async (from, to) => {
		if (dirname(String(to)) === metadataDir && String(to).endsWith(".json")) throw busy;
		return original(from, to);
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	await assert.rejects(() => runtime.snapshot(id), (error) => error === busy);
});
