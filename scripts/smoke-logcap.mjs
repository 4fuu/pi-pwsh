// E2E smoke test for the task log size bound (real pwsh).
//
// The dangerous case is a task that is still RUNNING: a verbose loop can fill
// the disk long before it becomes terminal, and retention cannot help because it
// only sweeps terminal tasks and only runs when a session or a task starts. So
// the bound has to hold while the task is live, which is what this asserts.
//
// Run: npx tsx scripts/smoke-logcap.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"]).error?.code === "ENOENT") {
	console.log("SKIP [task log cap e2e] pwsh is not installed");
	process.exit(0);
}

// Set before importing the runtime: the launcher reads it from the inherited env.
const MAX_LOG_BYTES = 128 * 1024;
process.env.PI_PWSH_MAX_LOG_BYTES = String(MAX_LOG_BYTES);
const { PwshTaskRuntime } = await import("../src/task-runtime.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-logcap-test-"));
const runtime = new PwshTaskRuntime(
	{ executable: "pwsh", loadProfile: false, executionPolicy: "Bypass", stopOnError: false, pythonUtf8: true, pythonUnbuffered: true },
	{ taskDir: dir, sessionId: "logcap-test" },
);
const status = async (id) => (await runtime.snapshot(id, 0, undefined, { claimTerminal: false })).metadata.status;

let taskId;
try {
	// Emits far more than the cap, then idles, so the assertions land while the
	// task is still live.
	const meta = await runtime.start(
		"$line = 'x' * 512; for ($i = 0; $i -lt 4000; $i++) { Write-Output \"$i $line\" }; Write-Output 'MARKER_TAIL'; Start-Sleep -Seconds 30",
		dir,
	);
	taskId = meta.id;
	const logPath = join(runtime.taskDirectoryPath(taskId), "output.log");

	// 4000 * ~520 B is about 2 MB, i.e. 16x the cap.
	let peak = 0;
	let exercised = false;
	for (let i = 0; i < 120 && !exercised; i++) {
		await sleep(250);
		peak = Math.max(peak, (await stat(logPath)).size);
		const current = await status(taskId);
		if (TERMINAL.has(current)) break;
		// The whole loop's output has been produced once the marker is on disk.
		exercised = current === "running" && (await readFile(logPath, "utf8")).includes("MARKER_TAIL");
	}

	assert.ok(exercised, "the task never emitted its full output while running, so the bound was not exercised");
	// A chunk can land between a write and the rewrite that follows it.
	assert.ok(
		peak <= MAX_LOG_BYTES * 2,
		`log grew to ${peak} bytes while running, past the ${MAX_LOG_BYTES}-byte bound`,
	);
	assert.equal(await status(taskId), "running", "the task must still be running when the bound is asserted");

	// The notice sits at the head of the rewritten file. `tail()` only ever
	// surfaces the last 50 KiB, so assert against the file a human would open.
	const onDisk = await readFile(logPath, "utf8");
	assert.ok(onDisk.startsWith("[pi-pwsh] earlier output discarded"), `truncation notice missing:\n${onDisk.slice(0, 200)}`);
	assert.ok(!onDisk.includes("\n0 xxx"), "the oldest output should have been discarded");

	// The tail is what the task API returns, and it must hold the newest output.
	const live = await runtime.snapshot(taskId, 0, undefined, { claimTerminal: false });
	assert.ok(live.output.includes("MARKER_TAIL"), "the newest output must survive: the tail is what is kept");
	assert.ok(live.omittedBytes >= 0, "omittedBytes must stay well-formed after a rewrite");

	console.log(`PASS [task log cap e2e] bounded a running task at ${peak} bytes with a ${MAX_LOG_BYTES}-byte cap; tail preserved`);
} finally {
	// Stop unconditionally: a failed assertion must not leave a live PowerShell
	// process and a locked directory behind.
	if (taskId) {
		await runtime.stop(taskId).catch(() => {});
		for (let i = 0; i < 40; i++) {
			const current = await status(taskId).catch(() => "cancelled");
			if (TERMINAL.has(current)) break;
			await sleep(250);
		}
	}
	let removed = false;
	for (let attempt = 0; attempt < 40 && !removed; attempt++) {
		try {
			await rm(dir, { recursive: true, force: true });
			removed = true;
		} catch (error) {
			if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
			await sleep(250);
		}
	}
	// Silence here would leave the temp directory growing run after run.
	assert.ok(removed, `could not remove ${dir}: the launcher never released it`);
}
