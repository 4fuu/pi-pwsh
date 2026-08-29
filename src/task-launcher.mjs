import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { open, readFile, rm, writeFile } from "node:fs/promises";
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

let readinessOffset = 0;
let readinessCarry = Buffer.alloc(0);
let readinessScanning = false;
async function scanReadiness() {
	if (!config.notifyOn || readinessScanning || existsSync(config.readyMarkerPath)) return;
	readinessScanning = true;
	let handle;
	try {
		handle = await open(config.logPath, "r");
		const size = (await handle.stat()).size;
		const needle = Buffer.from(config.notifyOn, "utf8");
		while (readinessOffset < size) {
			const chunk = Buffer.alloc(Math.min(64 * 1024, size - readinessOffset));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, readinessOffset);
			if (bytesRead === 0) break;
			readinessOffset += bytesRead;
			const data = Buffer.concat([readinessCarry, chunk.subarray(0, bytesRead)]);
			readinessCarry = data.subarray(Math.max(0, data.length - Math.max(0, needle.length - 1)));
			if (data.indexOf(needle) !== -1) {
				await writeFile(config.readyMarkerPath, "", { flag: "wx", mode: 0o600 }).catch((error) => {
					if (error.code !== "EEXIST") throw error;
				});
				break;
			}
		}
	} finally {
		await handle?.close().catch(() => {});
		readinessScanning = false;
	}
}

const readinessTimer = config.notifyOn
	? setInterval(() => void scanReadiness().catch(() => {}), 25)
	: undefined;
readinessTimer?.unref();

let child;
let logFd;
try {
	logFd = openSync(config.logPath, "a");
	// This flag makes a Bun standalone execute this launcher, but it must not
	// alter Bun standalone executables started by the user's PowerShell command.
	if (process.versions.bun) delete process.env.BUN_BE_BUN;
	child = spawn(config.executable, config.args, {
		cwd: config.cwd,
		env: process.env,
		stdio: [config.stdin === undefined ? "ignore" : "pipe", logFd, logFd],
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
		child.once("error", reject);
		child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
	});
	// Avoid an unhandled rejection if startup itself fails before completion is awaited.
	void completion.catch(() => {});
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
	if (readinessTimer) clearInterval(readinessTimer);
	while (readinessScanning) await new Promise((resolve) => setTimeout(resolve, 5));
	await scanReadiness();
	await writeMetadata({
		status: exitCode === 0 ? "completed" : "failed",
		exitCode,
		...(signal ? { error: `PowerShell exited after signal ${signal}` } : {}),
	});
} catch (error) {
	if (readinessTimer) clearInterval(readinessTimer);
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
