import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { mutateMetadataSnapshots, readLatestMetadataSnapshot, renameWithRetry } from "./task-metadata-store.mjs";

const configPath = process.argv[2];
if (!configPath) throw new Error("Missing persistent task configuration path");
const config = JSON.parse(await readFile(configPath, "utf8"));

function validateMetadata(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid task metadata");
	if (value.id !== config.id || value.instanceId !== config.instanceId) throw new Error("stale task instance");
	return value;
}

async function readCurrentMetadata() {
	if (config.metadataDir) {
		return (await readLatestMetadataSnapshot(config.metadataDir, validateMetadata)).metadata;
	}
	return validateMetadata(JSON.parse(await readFile(config.metaPath, "utf8")));
}

async function writeLegacyMetadata(next) {
	const temporary = `${config.metaPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		if (existsSync(config.cancelMarkerPath)) throw new Error("cancelled");
		try {
			await renameWithRetry(temporary, config.metaPath);
		} catch (error) {
			// Compatibility for launchers created before snapshot metadata: once
			// rename-over retries are exhausted, preserve the old in-place fallback.
			if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
			await writeFile(config.metaPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		}
	} finally {
		await rm(temporary, { force: true });
	}
}

async function writeMetadata(change) {
	if (config.metadataDir) {
		await mutateMetadataSnapshots(config.metadataDir, (current) => {
			validateMetadata(current);
			if (existsSync(config.cancelMarkerPath)) throw new Error("cancelled");
			if (!["starting", "running"].includes(current.status)) throw new Error("task is already terminal");
			return { ...current, ...change, updatedAt: new Date().toISOString() };
		}, {
			validate: validateMetadata,
			beforePublish: () => {
				if (existsSync(config.cancelMarkerPath)) throw new Error("cancelled");
			},
		});
		return;
	}
	const current = await readCurrentMetadata();
	if (existsSync(config.cancelMarkerPath)) throw new Error("cancelled");
	if (!["starting", "running"].includes(current.status)) throw new Error("task is already terminal");
	const next = { ...current, ...change, updatedAt: new Date().toISOString() };
	await writeLegacyMetadata(next);
}

function notify(message) {
	if (!process.connected || !process.send) return;
	try {
		process.send(message, () => {});
	} catch {
		// The parent may reload or exit after the task has started.
	}
}

// The child's output is piped through this process rather than written straight
// to the log file descriptor, so that its size can be bounded. A runaway task -
// a build loop, a retry storm, anything verbose - would otherwise fill the disk
// while it ran, and no retention sweep can help: the task is not terminal yet,
// and cleanup only runs when a session or a task starts.
//
// The tail is what is kept, because the tail is what a reader wants and all the
// task API can ever surface (PwshTaskRuntime.tail reads the last 50 KiB).
// The override is clamped rather than trusted: a negative or tiny value would
// otherwise make KEEP_LOG_BYTES exceed the cap and rotation read from a negative
// offset. KEEP is always strictly below MAX, so the log cannot outgrow its cap.
const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;
const MIN_MAX_LOG_BYTES = 64 * 1024;
const requestedMaxLogBytes = Number.parseInt(process.env.PI_PWSH_MAX_LOG_BYTES ?? "", 10);
const MAX_LOG_BYTES = Number.isFinite(requestedMaxLogBytes) && requestedMaxLogBytes > 0
	? Math.max(MIN_MAX_LOG_BYTES, requestedMaxLogBytes)
	: DEFAULT_MAX_LOG_BYTES;
const KEEP_LOG_BYTES = Math.floor(MAX_LOG_BYTES / 2);

let logBytes = 0;
let truncations = 0;

function truncationNotice() {
	return Buffer.from(
		`[pi-pwsh] earlier output discarded to keep this log under ${MAX_LOG_BYTES} bytes (truncation ${truncations})\n`,
		"utf8",
	);
}

/** Append to the log, discarding the oldest bytes once the budget is exceeded. */
function appendToLog(chunk) {
	writeSync(logFd, chunk, 0, chunk.length, logBytes);
	logBytes += chunk.length;
	if (logBytes <= MAX_LOG_BYTES) return;
	truncations++;
	const keepBytes = Math.min(KEEP_LOG_BYTES, logBytes);
	const keep = Buffer.allocUnsafe(keepBytes);
	const kept = readSync(logFd, keep, 0, keepBytes, logBytes - keepBytes);
	const notice = truncationNotice();
	ftruncateSync(logFd, 0);
	writeSync(logFd, notice, 0, notice.length, 0);
	writeSync(logFd, keep, 0, kept, notice.length);
	logBytes = notice.length + kept;
}

// Readiness is matched on the stream itself. The previous implementation re-read
// the file from a saved absolute offset every 25 ms, which cannot survive the
// log being rewritten, and cost a poll per task even when nothing was writing.
const readinessNeedle = config.notifyOn ? Buffer.from(config.notifyOn, "utf8") : undefined;
let readinessCarry = Buffer.alloc(0);
let readinessSettled = false;

function scanReadiness(chunk) {
	if (!readinessNeedle || readinessSettled) return;
	const data = readinessCarry.length === 0 ? chunk : Buffer.concat([readinessCarry, chunk]);
	if (data.indexOf(readinessNeedle) !== -1) {
		readinessSettled = true;
		readinessCarry = Buffer.alloc(0);
		try {
			closeSync(openSync(config.readyMarkerPath, "wx", 0o600));
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		return;
	}
	// Keep just enough trailing bytes for a needle split across two chunks.
	readinessCarry = data.subarray(Math.max(0, data.length - (readinessNeedle.length - 1)));
}

// Set once the completion promise exists, so a failure on the output path can
// reach the handler that kills the child and records the task as failed.
let failCompletion;
let outputFailure;

// A stream callback is outside the surrounding try/catch: an uncaught throw here
// would kill the launcher without that cleanup, leaving the task looking alive.
// Disk-full is exactly the condition this bound exists for, so the write path
// has to fail into the normal termination handling rather than past it.
function onOutput(chunk) {
	try {
		appendToLog(chunk);
		scanReadiness(chunk);
	} catch (error) {
		if (outputFailure) return;
		outputFailure = error;
		child?.stdout?.off("data", onOutput);
		child?.stderr?.off("data", onOutput);
		failCompletion?.(error);
	}
}

let child;
let logFd;
try {
	// "r+" rather than "a": append mode ignores the explicit write positions that
	// rewriting the log to keep only its tail depends on. The runtime creates this
	// file before starting the launcher.
	logFd = openSync(config.logPath, existsSync(config.logPath) ? "r+" : "w+");
	// This flag makes a Bun standalone execute this launcher, but it must not
	// alter Bun standalone executables started by the user's PowerShell command.
	if (process.versions.bun) delete process.env.BUN_BE_BUN;
	child = spawn(config.executable, config.args, {
		cwd: config.cwd,
		env: process.env,
		stdio: [config.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		windowsHide: true,
		// The detached launcher owns the Unix process group; PowerShell and all
		// descendants inherit it so stop=true reaches the complete tree.
		detached: false,
	});
	if (config.stdin !== undefined) {
		// Startup/termination failures are reported through child events.
		child.stdin.on("error", () => {});
		child.stdin.end(config.stdin, "utf8");
	}

	const completion = new Promise((resolve, reject) => {
		failCompletion = reject;
		child.once("error", reject);
		// "close", not "exit": the piped streams can still hold buffered output when
		// the process itself exits, and the parent reads the log as soon as it sees a
		// terminal status. Waiting for close is what makes the log complete by then.
		child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
	});
	// Avoid an unhandled rejection if startup itself fails before completion is awaited.
	void completion.catch(() => {});
	// Attached after the completion promise exists, so a write failure on the very
	// first chunk still has somewhere to be reported. Both streams land in the one
	// log, as they did when both inherited its descriptor; draining them is also
	// what keeps a noisy child from blocking on a full pipe once its output stops
	// being retained.
	child.stdout.on("data", onOutput);
	child.stderr.on("data", onOutput);
	child.stdout.on("error", () => {});
	child.stderr.on("error", () => {});
	await new Promise((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
	// Keep the parent's 5-second launcher-ready bridge independent of metadata
	// storage latency. The parent tolerates status "starting" immediately after
	// this handshake, including for legacy meta.json tasks under contention.
	notify({ type: "ready" });
	if (process.connected) process.disconnect();
	await writeMetadata({ supervisorPid: process.pid, pid: child.pid, status: "running" });

	const { exitCode, signal } = await completion;
	await writeMetadata({
		status: exitCode === 0 ? "completed" : "failed",
		exitCode,
		...(signal ? { error: `PowerShell exited after signal ${signal}` } : {}),
	});
} catch (error) {
	if (child?.pid && child.exitCode === null) {
		if (process.platform === "win32") {
			await new Promise((resolve) => {
				const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
				killer.once("error", resolve);
				killer.once("close", resolve);
			});
		} else {
			try {
				process.kill(child.pid, "SIGKILL");
			} catch {
				// The child already exited.
			}
		}
	}
	try {
		const metadata = await readCurrentMetadata();
		if (
			metadata.id === config.id
			&& metadata.instanceId === config.instanceId
			&& ["starting", "running"].includes(metadata.status)
			&& !existsSync(config.cancelMarkerPath)
		) {
			await writeMetadata({
				status: "failed",
				exitCode: null,
				error: error instanceof Error ? error.message : String(error),
				failureKind: "infrastructure",
			});
		}
	} catch {
		// Cancellation and replaced metadata are already authoritative.
	}
	notify({ type: "error", error: error instanceof Error ? error.message : String(error) });
	if (process.connected) process.disconnect();
} finally {
	if (logFd !== undefined) closeSync(logFd);
}
