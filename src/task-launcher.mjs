import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";

const configPath = process.argv[2];
if (!configPath) throw new Error("Missing persistent task configuration path");
const config = JSON.parse(await readFile(configPath, "utf8"));

/**
 * Rename over an existing file, tolerating the transient lock errors Windows
 * raises when a concurrent reader or antivirus scanner holds the destination.
 */
async function renameWithRetry(from, to) {
	let lastError;
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
		}
	}
	throw lastError;
}

async function writeMetadata(change) {
	const current = JSON.parse(await readFile(config.metaPath, "utf8"));
	if (existsSync(config.cancelMarkerPath)) throw new Error("cancelled");
	if (current.id !== config.id || current.instanceId !== config.instanceId) throw new Error("stale task instance");
	if (!current || !["starting", "running"].includes(current.status)) throw new Error("task is already terminal");
	const next = { ...current, ...change, updatedAt: new Date().toISOString() };
	const temporary = `${config.metaPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		if (existsSync(config.cancelMarkerPath)) throw new Error("cancelled");
		await renameWithRetry(temporary, config.metaPath);
	} finally {
		await rm(temporary, { force: true });
	}
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
	await writeMetadata({ supervisorPid: process.pid, pid: child.pid, status: "running" });
	notify({ type: "ready" });
	if (process.connected) process.disconnect();

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
		const metadata = JSON.parse(await readFile(config.metaPath, "utf8"));
		if (
			metadata.id === config.id
			&& metadata.instanceId === config.instanceId
			&& ["starting", "running"].includes(metadata.status)
			&& !existsSync(config.cancelMarkerPath)
		) {
			await writeMetadata({ status: "failed", exitCode: null, error: error instanceof Error ? error.message : String(error) });
		}
	} catch {
		// Cancellation and replaced metadata are already authoritative.
	}
	notify({ type: "error", error: error instanceof Error ? error.message : String(error) });
	if (process.connected) process.disconnect();
} finally {
	if (logFd !== undefined) closeSync(logFd);
}
