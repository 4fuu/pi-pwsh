import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs, { existsSync } from "node:fs";
import { mkdtemp, mkdir, open, writeFile, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PwshTaskRuntime, renameWithRetry } from "../src/task-runtime.ts";
import { mutateMetadataSnapshots, readLatestMetadataSnapshot } from "../src/task-metadata-store.mjs";
import { validate, DESCRIPTION, PROMPT_GUIDELINE, PwshParams, taskDetails, taskText } from "../src/index.ts";
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
assert.equal((await import("node:fs")).existsSync(join(task, `${meta.instanceId}.exit.presented`)), false);

// The Windows in-place write fallback can briefly expose torn JSON. Metadata
// reads recover from that parse failure without retrying filesystem failures.
const tornId = "ps_fadedcab", tornTask = runtime.taskDirectoryPath(tornId);
await mkdir(tornTask);
await writeFile(join(tornTask, "meta.json"), '{"version":1');
const repairTornMetadata = new Promise((resolve, reject) => setTimeout(() => {
	void writeFile(join(tornTask, "meta.json"), JSON.stringify({ ...meta, id: tornId })).then(resolve, reject);
}, 10));
try {
	assert.equal((await runtime.readMetadata(tornId)).status, "completed");
} finally {
	await repairTornMetadata;
}
const missingMetaId = "ps_dec0ded0";
const missingMetaTask = runtime.taskDirectoryPath(missingMetaId);
await mkdir(missingMetaTask);
const createMissingMetadata = new Promise((resolve, reject) => setTimeout(() => {
	void writeFile(join(missingMetaTask, "meta.json"), JSON.stringify({ ...meta, id: missingMetaId })).then(resolve, reject);
}, 10));
try {
	await assert.rejects(() => runtime.readMetadata(missingMetaId), /ENOENT/);
} finally {
	await createMissingMetadata;
}

// Snapshot writers serialize without involving readers, retain a bounded
// history, and readers fall back if the newest immutable snapshot is corrupt.
const snapshotId = "ps_5a7e0001", snapshotTask = runtime.taskDirectoryPath(snapshotId);
const snapshotMetadataDir = join(snapshotTask, "metadata");
await mkdir(snapshotTask);
await mutateMetadataSnapshots(snapshotMetadataDir, () => ({ ...meta, id: snapshotId, counter: 0 }), { allowCreate: true });

// Independent processes cross a barrier and simultaneously recover the same
// abandoned claims. A reclaimer may delete only that immutable owner claim,
// never a replacement writer's ticket.
const abandonedPid = 99_999_999;
const abandonedWriterLock = join(snapshotMetadataDir, ".writer-lock");
await mkdir(abandonedWriterLock);
await writeFile(join(abandonedWriterLock, "owner.json"), JSON.stringify({ pid: abandonedPid, token: "abandoned" }));
await writeFile(join(snapshotMetadataDir, `.writer-choosing.${abandonedPid}.${"a".repeat(32)}`), "");
await writeFile(join(snapshotMetadataDir, `.writer-ticket.000000000000.${abandonedPid}.${"b".repeat(32)}`), "");
const metadataStoreUrl = new URL("../src/task-metadata-store.mjs", import.meta.url).href;
const writerSource = `
	import { mutateMetadataSnapshots } from ${JSON.stringify(metadataStoreUrl)};
	const directory = process.argv.at(-1);
	process.send({ type: "ready" });
	await new Promise(resolve => process.once("message", message => message?.type === "go" && resolve()));
	await mutateMetadataSnapshots(directory, async current => {
		await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 10)));
		return { ...current, counter: current.counter + 1, updatedAt: new Date().toISOString() };
	});
`;
function spawnBarrierWriter() {
	const child = spawn(process.execPath, ["--input-type=module", "-e", writerSource, snapshotMetadataDir], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	let stderr = "", ready = false;
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", chunk => { stderr += chunk; });
	let resolveReady, rejectReady;
	const becameReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
	const completed = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill();
			reject(new Error("metadata barrier writer timed out"));
		}, 10_000);
		child.on("message", message => {
			if (message?.type !== "ready" || ready) return;
			ready = true;
			resolveReady();
		});
		child.once("error", error => {
			clearTimeout(timeout);
			rejectReady(error);
			reject(error);
		});
		child.once("exit", code => {
			clearTimeout(timeout);
			if (!ready) rejectReady(new Error(`metadata barrier writer exited before ready (${code}): ${stderr}`));
			if (code === 0) resolve();
			else reject(new Error(`metadata barrier writer exited with ${code}: ${stderr}`));
		});
	});
	completed.catch(() => {});
	return { child, becameReady, completed };
}
const barrierWriters = Array.from({ length: 8 }, spawnBarrierWriter);
await Promise.all(barrierWriters.map(worker => worker.becameReady));
for (const worker of barrierWriters) worker.child.send({ type: "go" });
await Promise.all(barrierWriters.map(worker => worker.completed));
const latestSnapshot = await readLatestMetadataSnapshot(snapshotMetadataDir);
assert.equal(latestSnapshot.revision, 8);
assert.equal(latestSnapshot.metadata.counter, 8);
assert.equal((await readdir(snapshotMetadataDir)).filter(name => name.endsWith(".json")).length, 3);
await assert.rejects(() => mutateMetadataSnapshots(snapshotMetadataDir, current => ({ ...current, counter: 10 }), {
	beforePublish: () => { throw new Error("cancel snapshot publication"); },
}), /cancel snapshot publication/);
assert.equal((await readLatestMetadataSnapshot(snapshotMetadataDir)).revision, 8);
assert.equal((await readdir(snapshotMetadataDir)).some(name => name.startsWith(".writer-choosing.")
	|| name.startsWith(".writer-ticket.") || name.endsWith(".tmp")), false);
await writeFile(latestSnapshot.path, '{"storageVersion":2');
const recoveredSnapshot = await readLatestMetadataSnapshot(snapshotMetadataDir);
assert.equal(recoveredSnapshot.revision, 7);
assert.equal((await runtime.readMetadata(snapshotId)).counter, 7);
const resumedSnapshot = await mutateMetadataSnapshots(snapshotMetadataDir, current => ({ ...current, counter: current.counter + 1 }));
assert.equal(resumedSnapshot.revision, 9);
assert.equal(resumedSnapshot.metadata.counter, 8);

// Force a reader to enumerate revision 0, then delay its open until three
// serial publications have pruned that path. The bounded relist must find the
// newer snapshots instead of reporting that every snapshot disappeared.
const relistMetadataDir = join(runtime.taskDirectoryPath("ps_2e115700"), "metadata");
await mutateMetadataSnapshots(relistMetadataDir, () => ({ counter: 0 }), { allowCreate: true });
const originalReadFile = fs.promises.readFile;
let releaseEnumeratedRead, resolveEnumeratedRead;
const enumeratedRead = new Promise(resolve => { resolveEnumeratedRead = resolve; });
const enumeratedReadRelease = new Promise(resolve => { releaseEnumeratedRead = resolve; });
let intercepted = false;
let racedRead;
try {
	fs.promises.readFile = async (path, ...args) => {
		if (!intercepted && typeof path === "string" && path.startsWith(relistMetadataDir) && path.endsWith(".json")) {
			intercepted = true;
			resolveEnumeratedRead();
			await enumeratedReadRelease;
		}
		return originalReadFile(path, ...args);
	};
	syncBuiltinESMExports();
	racedRead = readLatestMetadataSnapshot(relistMetadataDir);
	await enumeratedRead;
	fs.promises.readFile = originalReadFile;
	syncBuiltinESMExports();
	for (let counter = 1; counter <= 3; counter++) {
		await mutateMetadataSnapshots(relistMetadataDir, () => ({ counter }));
	}
	releaseEnumeratedRead();
	const relisted = await racedRead;
	assert.equal(relisted.revision, 3);
	assert.equal(relisted.metadata.counter, 3);
} finally {
	fs.promises.readFile = originalReadFile;
	syncBuiltinESMExports();
	releaseEnumeratedRead();
	await racedRead?.catch(() => {});
}
let permanentValidationAttempts = 0;
await assert.rejects(() => readLatestMetadataSnapshot(relistMetadataDir, () => {
	permanentValidationAttempts++;
	throw new Error("permanent metadata validation failure");
}), /permanent metadata validation failure/);
assert.equal(permanentValidationAttempts, 3, "validation failures must not trigger a relist");

const expiredSnapshotId = "ps_e7e1ed00", expiredSnapshotTask = runtime.taskDirectoryPath(expiredSnapshotId);
await mkdir(expiredSnapshotTask);
const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString();
await mutateMetadataSnapshots(join(expiredSnapshotTask, "metadata"), () => ({
	...meta, id: expiredSnapshotId, createdAt: expiredAt, updatedAt: expiredAt,
}), { allowCreate: true });
await runtime.cleanupExpired();
assert.equal(existsSync(expiredSnapshotTask), false);

assert.throws(() => validate({}), /exactly one/);
assert.throws(() => validate({ command: "x", taskId: id }), /exactly one/);
assert.throws(() => validate({ taskId: id, notifyOn: "x" }), /command/);
assert.throws(() => validate({ taskId: id, stop: true, wait: 1 }), /wait is not accepted/);
assert.throws(() => validate({ command: "x", notifyOn: "😀".repeat(65) }), /UTF-8 bytes/);
assert.doesNotThrow(() => validate({ command: "Get-ChildItem", notifyOn: "ready", wait: 1 }));
assert.match(DESCRIPTION, /PowerShell 7/); assert.match(DESCRIPTION, /\$env:NAME/); assert.match(DESCRIPTION, /bound paths/); assert.match(PROMPT_GUIDELINE, /persistent background task/);
assert.ok(PwshParams);

// Model text stays lean while structured details retain everything needed by
// the collapsed and expanded TUI renderers.
const modelMeta = { ...meta, sessionId: "one", pid: 4321 };
const successful = { metadata: modelMeta, ready: true, output: "", omittedBytes: 0 };
assert.equal(taskText(successful), `taskId: ${id}\nstatus: completed`);
assert.deepEqual(taskDetails(successful), {
	version: 1, taskId: id, status: "completed", ready: true, exitCode: 0, pid: 4321,
	createdAt: now, omittedBytes: 0, output: "", error: undefined, diagnosticsPath: undefined,
});
const running = { metadata: { ...modelMeta, status: "running", exitCode: undefined }, ready: true, output: "hello\n", omittedBytes: 12 };
assert.equal(taskText(running), `taskId: ${id}\nstatus: running\nready: true\noutput: [12 earlier bytes omitted]\nhello`);
const commandFailure = { metadata: { ...modelMeta, status: "failed", exitCode: 7 }, ready: false, output: "", omittedBytes: 0 };
assert.equal(taskText(commandFailure), `taskId: ${id}\nstatus: failed\nexitCode: 7`);
const cancelled = { metadata: { ...modelMeta, status: "cancelled", exitCode: null }, ready: false, output: "", omittedBytes: 0 };
assert.doesNotMatch(taskText(cancelled), /exitCode|unknown|output:|pid/);
const infraPath = task;
const infrastructureFailure = { metadata: { ...modelMeta, status: "failed", exitCode: null, error: "launcher broke", failureKind: "infrastructure" }, ready: true, output: "", omittedBytes: 0 };
assert.match(taskText(infrastructureFailure, infraPath), new RegExp(`error: launcher broke\\ndiagnosticsPath: ${infraPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
assert.equal(taskDetails(infrastructureFailure, infraPath).diagnosticsPath, infraPath);
assert.doesNotMatch(taskText(commandFailure, infraPath), /diagnosticsPath/);
const signalFailure = { metadata: { ...modelMeta, status: "failed", exitCode: null, error: "PowerShell exited after signal SIGTERM" }, ready: false, output: "", omittedBytes: 0 };
assert.match(taskText(signalFailure, infraPath), /error: PowerShell exited after signal SIGTERM/);
assert.doesNotMatch(taskText(signalFailure, infraPath), /diagnosticsPath/);

// A launcher failure after task-directory allocation leaves real, useful
// diagnostics behind and names that existing location in the thrown error.
const startupDir = await mkdtemp(join(tmpdir(), "pi-pwsh-startup-test-"));
const brokenRuntime = new PwshTaskRuntime({ executable: join(startupDir, "missing-pwsh"), args: [], loadProfile: false, executionPolicy: null, stopOnError: false, pythonUtf8: false, pythonUnbuffered: false }, { taskDir: startupDir, sessionId: "one" });
let startupError;
try { await brokenRuntime.start("x", startupDir); } catch (error) { startupError = error; }
assert.match(String(startupError), /diagnosticsPath:/);
const startupPath = String(startupError).match(/diagnosticsPath: (.+)$/m)?.[1];
assert.ok(startupPath && existsSync(startupPath));
assert.deepEqual((await readdir(startupPath)).filter(name => ["config.json", "metadata", "output.log"].includes(name)).sort(), ["config.json", "metadata", "output.log"]);
assert.equal(existsSync(join(startupPath, "meta.json")), false);
const startupConfig = JSON.parse(await readFile(join(startupPath, "config.json"), "utf8"));
const startupMetadata = await brokenRuntime.readMetadata(startupConfig.id);
assert.equal(startupMetadata.status, "failed");
assert.equal(startupMetadata.failureKind, "infrastructure");
assert.equal((await readdir(join(startupPath, "metadata"))).filter(name => name.endsWith(".json")).length, 3);
assert.match(await readFile(join(startupPath, "output.log"), "utf8"), /startup failure/);
assert.equal(existsSync(join(startupPath, `${startupMetadata.instanceId}.exit.presented`)), true);
await rm(startupDir, { recursive: true, force: true });

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

const snapshotStopId = "ps_570c0001", snapshotStopTask = runtime.taskDirectoryPath(snapshotStopId);
const snapshotStopInstance = "5".repeat(32), snapshotStopMetadataDir = join(snapshotStopTask, "metadata");
await mkdir(snapshotStopTask);
await mutateMetadataSnapshots(snapshotStopMetadataDir, () => ({
	...meta, id: snapshotStopId, instanceId: snapshotStopInstance, sessionId: "one", status: "running", exitCode: undefined,
}), { allowCreate: true });
await writeFile(join(snapshotStopTask, "output.log"), "");
assert.equal((await runtime.stop(snapshotStopId)).metadata.status, "cancelled");
assert.equal((await readdir(snapshotStopMetadataDir)).filter(name => name.endsWith(".json")).length, 2);

// The detached launcher owns readiness scanning so long-lived task queries stay
// O(new output), including a multi-byte literal split at a 64 KiB boundary.
const launchId = "ps_feedface", launchTask = runtime.taskDirectoryPath(launchId), launchInstance = "c".repeat(32);
await mkdir(launchTask);
const launchMeta = { ...meta, id: launchId, instanceId: launchInstance, sessionId: "one", status: "starting", notifyOn: "😀ready", exitCode: undefined };
const launchLog = join(launchTask, "output.log"), launchMetadataDir = join(launchTask, "metadata");
const readyMarker = join(launchTask, `${launchInstance}.ready.detected`);
const cancelMarker = join(launchTask, `${launchInstance}.cancelled`);
await mutateMetadataSnapshots(launchMetadataDir, () => launchMeta, { allowCreate: true });
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
	metadataDir: launchMetadataDir,
	notifyOn: "😀ready",
	readyMarkerPath: readyMarker,
	cancelMarkerPath: cancelMarker,
}));
const initialLaunchSnapshot = await readLatestMetadataSnapshot(launchMetadataDir);
const initialLaunchHandle = await open(initialLaunchSnapshot.path, "r");
const launcher = spawn(process.execPath, [launcherPath, launchConfig], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
let ready;
try {
	await new Promise((resolve, reject) => {
		launcher.once("error", reject);
		launcher.on("message", message => message?.type === "ready" && resolve());
	});
	const publicationDeadline = Date.now() + 1_500;
	let metadataWhileOpen = await runtime.readMetadata(launchId);
	while (metadataWhileOpen.status === "starting" && Date.now() < publicationDeadline) {
		await new Promise(resolve => setTimeout(resolve, 25));
		metadataWhileOpen = await runtime.readMetadata(launchId);
	}
	assert.notEqual(metadataWhileOpen.status, "starting", "an open old snapshot must not block publication");
	ready = await runtime.snapshot(launchId, 2, undefined, { claimTerminal: false });
	if (launcher.exitCode === null) await new Promise(resolve => launcher.once("exit", resolve));
} finally {
	await initialLaunchHandle.close();
}
assert.equal(ready.ready, true);
assert.ok(ready.omittedBytes > 50000);
assert.equal((await runtime.readMetadata(launchId)).status, "completed");
assert.equal(existsSync(join(launchTask, "meta.json")), false);
assert.equal((await readdir(launchMetadataDir)).filter(name => name.endsWith(".json")).length, 3);

// Windows refuses rename-over while any reader holds the destination open.
// The retry budget must outlive a contention window longer than the old
// linear schedule, and the launcher must acknowledge startup before waiting
// on that metadata write. Holding the handle through the complete retry ladder
// also exercises the last-resort in-place overwrite.
if (process.platform === "win32") {
	const retryDestination = join(dir, "retry-destination.json");
	const retrySource = join(dir, "retry-source.json");
	await writeFile(retryDestination, "old");
	await writeFile(retrySource, "new");
	const retryHandle = await open(retryDestination, "r");
	const releaseRetryHandle = setTimeout(() => void retryHandle.close().catch(() => {}), 750);
	try {
		await renameWithRetry(retrySource, retryDestination);
	} finally {
		clearTimeout(releaseRetryHandle);
		await retryHandle.close().catch(() => {});
	}
	assert.equal(await readFile(retryDestination, "utf8"), "new");

	const lockedId = "ps_e1e2e3e4";
	const lockedTask = runtime.taskDirectoryPath(lockedId);
	const lockedInstance = "7".repeat(32);
	const lockedMetaPath = join(lockedTask, "meta.json");
	const lockedLogPath = join(lockedTask, "output.log");
	const lockedConfigPath = join(lockedTask, "config.json");
	await mkdir(lockedTask);
	await writeFile(lockedMetaPath, JSON.stringify({
		...meta,
		id: lockedId,
		instanceId: lockedInstance,
		sessionId: "one",
		status: "starting",
		exitCode: undefined,
	}));
	await writeFile(lockedLogPath, "");
	await writeFile(lockedConfigPath, JSON.stringify({
		id: lockedId,
		instanceId: lockedInstance,
		executable: process.execPath,
		args: ["-e", "setTimeout(()=>{},250)"],
		cwd: dir,
		logPath: lockedLogPath,
		metaPath: lockedMetaPath,
		cancelMarkerPath: join(lockedTask, `${lockedInstance}.cancelled`),
	}));

	const lockedHandle = await open(lockedMetaPath, "r");
	const lockedLauncher = spawn(process.execPath, [launcherPath, lockedConfigPath], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
	let statusAtReady;
	let statusWhileLocked;
	try {
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("locked launcher did not send ready within 5 seconds")), 5_000);
			const onError = (error) => { clearTimeout(timeout); reject(error); };
			const onExit = (code) => { clearTimeout(timeout); reject(new Error(`locked launcher exited before ready (${code})`)); };
			const onMessage = (message) => {
				if (message?.type !== "ready") return;
				clearTimeout(timeout);
				lockedLauncher.off("error", onError);
				lockedLauncher.off("exit", onExit);
				lockedLauncher.off("message", onMessage);
				resolve();
			};
			lockedLauncher.once("error", onError);
			lockedLauncher.once("exit", onExit);
			lockedLauncher.on("message", onMessage);
		});
		statusAtReady = JSON.parse(await readFile(lockedMetaPath, "utf8")).status;
		const fallbackDeadline = Date.now() + 6_000;
		while (Date.now() < fallbackDeadline && statusWhileLocked !== "running") {
			try { statusWhileLocked = JSON.parse(await readFile(lockedMetaPath, "utf8")).status; }
			catch { /* An in-place overwrite may expose one transient torn read. */ }
			if (statusWhileLocked !== "running") await new Promise(resolve => setTimeout(resolve, 25));
		}
	} finally {
		await lockedHandle.close().catch(() => {});
		if (lockedLauncher.exitCode === null) await new Promise(resolve => lockedLauncher.once("exit", resolve));
	}
	assert.equal(statusAtReady, "starting");
	assert.equal(statusWhileLocked, "running");
	assert.equal((await runtime.readMetadata(lockedId)).status, "completed");
}

// Bun standalone launchers require BUN_BE_BUN, but user commands must not
// inherit it. Simulate Bun in a Node bootstrap so this is covered in CI.
const bunId = "ps_b16be000", bunTask = runtime.taskDirectoryPath(bunId), bunInstance = "6".repeat(32);
await mkdir(bunTask);
const bunMeta = { ...meta, id: bunId, instanceId: bunInstance, sessionId: "one", status: "starting", exitCode: undefined };
const bunLog = join(bunTask, "output.log"), bunMetadataDir = join(bunTask, "metadata");
const bunConfig = join(bunTask, "config.json");
await mutateMetadataSnapshots(bunMetadataDir, () => bunMeta, { allowCreate: true });
await writeFile(bunLog, "");
await writeFile(bunConfig, JSON.stringify({
	id: bunId,
	instanceId: bunInstance,
	executable: process.execPath,
	args: ["-e", "process.stdout.write(process.env.BUN_BE_BUN ?? '<unset>')"],
	cwd: dir,
	logPath: bunLog,
	metadataDir: bunMetadataDir,
	cancelMarkerPath: join(bunTask, `${bunInstance}.cancelled`),
}));
const bunBootstrap = `Object.defineProperty(process.versions, "bun", { value: "test" }); await import(${JSON.stringify(pathToFileURL(launcherPath).href)})`;
const bunLauncher = spawn(process.execPath, ["--input-type=module", "-e", bunBootstrap, "launcher", bunConfig], {
	env: { ...process.env, BUN_BE_BUN: "1" },
	stdio: ["ignore", "ignore", "ignore", "ipc"],
});
await new Promise((resolve, reject) => {
	bunLauncher.once("error", reject);
	bunLauncher.on("message", message => message?.type === "ready" && resolve());
});
if (bunLauncher.exitCode === null) await new Promise(resolve => bunLauncher.once("exit", resolve));
const bunDone = await runtime.snapshot(bunId, 1, undefined, { claimTerminal: false });
assert.equal(bunDone.metadata.status, "completed");
assert.equal(bunDone.output, "<unset>");

// Offers use the shared aggregation schema. Submission and delivery have
// distinct durable markers, and either one prevents a repeated offer.
const offers = [], catalogs = [];
const coordinator = {
	offer(update, callbacks) { offers.push({ update, callbacks }); },
	withdrawTask() {},
};
const reporter = {
	publishCatalog(sessionId, catalog) { catalogs.push({ sessionId, catalog }); },
	close() {},
};
const ctx = {
	hasUI: true,
	mode: "print",
	ui: { notify() {} },
};
const manager = new TaskNotificationManager(coordinator, reporter, ctx, runtime, "one", 0);
await manager.start();
const initialCatalog = catalogs.at(-1);
assert.equal(initialCatalog.sessionId, "one");
const terminalPresented = initialCatalog.catalog.find(task => task.taskId === launchId);
assert.deepEqual(terminalPresented, {
	taskKey: `pwsh:${launchId}`, source: "pwsh", taskId: launchId,
	phase: "completed", statusLabel: "completed",
	createdAt: Date.parse(launchMeta.createdAt), updatedAt: Date.parse((await runtime.readMetadata(launchId)).updatedAt),
	startedAt: Date.parse(launchMeta.createdAt), endedAt: Date.parse((await runtime.readMetadata(launchId)).updatedAt), summary: "x",
});
assert.ok(!offers.some(({ update }) => update.taskId === ownId), "presented terminal events must be skipped entirely");
const terminalOffer = offers.find(({ update }) => update.taskId === launchId);
assert.deepEqual({
	eventId: terminalOffer.update.eventId,
	taskKey: terminalOffer.update.taskKey,
	source: terminalOffer.update.source,
	event: terminalOffer.update.event,
	status: terminalOffer.update.status,
	ok: terminalOffer.update.ok,
}, { eventId: `pwsh:${launchInstance}:terminal`, taskKey: `pwsh:${launchId}`, source: "pwsh", event: "terminal", status: "completed", ok: true });
assert.equal(terminalOffer.update.output.length, 4000);
assert.equal(terminalOffer.update.summary, "x");
assert.ok(terminalOffer.update.durationMs >= 0);
await terminalOffer.callbacks.onSubmitted("delivery-1");
const launchSubmitted = join(launchTask, `${launchInstance}.exit.submitted`);
assert.equal(await readFile(launchSubmitted, "utf8"), "");
const oldSubmission = new Date(Date.now() - 60_000);
await utimes(launchSubmitted, oldSubmission, oldSubmission);
await terminalOffer.callbacks.onSubmitted("delivery-2");
assert.ok(Date.now() - (await stat(launchSubmitted)).mtimeMs < 1000);
await manager.scanNow();
assert.equal(offers.filter(({ update }) => update.taskId === launchId).length, 1);
await terminalOffer.callbacks.onDelivered("delivery-1");
assert.equal(await readFile(join(launchTask, `${launchInstance}.exit.notified`), "utf8"), "");

// A stale pre-submission lease is recoverable. Readiness is then superseded by
// terminal state, whose coordinator withdrawal callback settles the ready event.
const retryId = "ps_cafebabe", retryTask = runtime.taskDirectoryPath(retryId), retryInstance = "d".repeat(32);
await mkdir(retryTask);
const retryMeta = { ...meta, id: retryId, instanceId: retryInstance, sessionId: "one", status: "running", exitCode: undefined, notifyOn: "ready" };
await writeFile(join(retryTask, "meta.json"), JSON.stringify(retryMeta));
await writeFile(join(retryTask, "output.log"), "retry me");
await writeFile(join(retryTask, `${retryInstance}.ready.detected`), "");
const retryLease = join(retryTask, `${retryInstance}.ready.notifying`);
await writeFile(retryLease, "");
const stale = new Date(Date.now() - 60_000);
await utimes(retryLease, stale, stale);
await manager.scanNow();
const readyOffer = offers.find(({ update }) => update.taskId === retryId && update.event === "ready");
assert.ok(readyOffer);
assert.deepEqual(catalogs.at(-1).catalog.find(task => task.taskId === retryId), {
	taskKey: `pwsh:${retryId}`, source: "pwsh", taskId: retryId,
	phase: "active", statusLabel: "ready",
	createdAt: Date.parse(retryMeta.createdAt), updatedAt: Date.parse(retryMeta.updatedAt),
	startedAt: Date.parse(retryMeta.createdAt), summary: "x",
});
await writeFile(join(retryTask, "meta.json"), JSON.stringify({ ...retryMeta, status: "completed", exitCode: 0, updatedAt: new Date().toISOString() }));
await manager.scanNow();
assert.ok(offers.some(({ update }) => update.taskId === retryId && update.event === "terminal"));
await readyOffer.callbacks.onWithdrawn("superseded");
assert.equal(await readFile(join(retryTask, `${retryInstance}.ready.notified`), "utf8"), "");

// Shutdown waits for an in-flight filesystem scan, so it cannot resume into a
// coordinator that has already started the next parent session.
let releaseList;
const delayedOffers = [];
const delayed = new TaskNotificationManager({
	offer(update) { delayedOffers.push(update); },
	withdrawTask() {},
}, reporter, ctx, {
	list: () => new Promise(resolve => { releaseList = resolve; }),
}, "old-session", 0);
const startingDelayed = delayed.start();
const closingDelayed = delayed.close();
releaseList([]);
await Promise.all([startingDelayed, closingDelayed]);
assert.equal(delayedOffers.length, 0);

// A scan error still reaches the UI on a live context.
const notified = [];
const liveObserver = new TaskNotificationManager({
	offer() {},
	withdrawTask() {},
}, reporter, {
	hasUI: true,
	mode: "print",
	ui: { notify(message, level) { notified.push({ message, level }); } },
}, {
	list: () => Promise.reject(new Error("scan failed")),
}, "live-session", 0);
await assert.doesNotReject(() => liveObserver.start());
assert.deepEqual(notified, [{ message: "pi-pwsh: task observer error: scan failed", level: "error" }]);
await liveObserver.close();

// A stale context cannot take the process down. Start with a successful scan,
// then invalidate the context before the next timer tick fails. Every property
// of a captured context asserts liveness, so `hasUI` throws once pi replaces or
// reloads the session. The observer stops after that failed tick instead of
// surfacing an unhandled rejection or continuing to poll.
let contextInvalidated = false;
let staleScans = 0;
let resolveFailedTick;
const failedTick = new Promise(resolve => { resolveFailedTick = resolve; });
const staleCtx = {
	get hasUI() {
		if (contextInvalidated) throw new Error("This extension ctx is stale after session replacement or reload.");
		return true;
	},
	mode: "print",
	ui: { notify() { assert.fail("a stale context must not reach ui.notify"); } },
};
const staleObserver = new TaskNotificationManager({
	offer() {},
	withdrawTask() {},
}, reporter, staleCtx, {
	list: () => {
		staleScans++;
		if (staleScans === 1) return Promise.resolve([]);
		resolveFailedTick();
		return Promise.reject(new Error("scan failed during session replacement"));
	},
}, "stale-session", 10);
await assert.doesNotReject(() => staleObserver.start());
assert.equal(staleScans, 1);
contextInvalidated = true;
const failedTickTimeout = setTimeout(() => resolveFailedTick(), 1_000);
await failedTick;
clearTimeout(failedTickTimeout);
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(staleScans, 2);
assert.deepEqual(catalogs.at(-1), { sessionId: "stale-session", catalog: [] });
await assert.doesNotReject(() => staleObserver.scanNow());
assert.equal(staleScans, 2);
await staleObserver.close();

await manager.close();
assert.deepEqual(catalogs.at(-1), { sessionId: "one", catalog: [] });

// A fresh observer respects a submitted lease, then recovers it after expiry
// if no matching message acknowledgement ever arrived.
const submittedId = "ps_0badc0de", submittedTask = runtime.taskDirectoryPath(submittedId), submittedInstance = "e".repeat(32);
await mkdir(submittedTask);
await writeFile(join(submittedTask, "meta.json"), JSON.stringify({
	...meta, id: submittedId, instanceId: submittedInstance, sessionId: "one", status: "completed", updatedAt: new Date().toISOString(),
}));
await writeFile(join(submittedTask, "output.log"), "recover submitted");
const submittedMarker = join(submittedTask, `${submittedInstance}.exit.submitted`);
await writeFile(submittedMarker, "");
const resumedOffers = [];
const resumed = new TaskNotificationManager({
	offer(update, callbacks) { resumedOffers.push({ update, callbacks }); },
	withdrawTask() {},
}, reporter, ctx, runtime, "one", 0);
await resumed.start();
assert.equal(resumedOffers.some(({ update }) => update.taskId === submittedId), false);
await utimes(submittedMarker, stale, stale);
await resumed.scanNow();
assert.equal(resumedOffers.some(({ update }) => update.taskId === submittedId), true);
await resumed.close();

await rm(dir, { recursive: true, force: true });
console.log("task runtime/schema tests passed (PowerShell process e2e skipped: pwsh is not installed)");
