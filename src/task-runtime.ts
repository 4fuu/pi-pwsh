import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	open,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimeEnv, SOURCE_BOOTSTRAP, UTF8_PREFIX, wrapPowerShellCommand } from "./spawn.ts";
import { userPowerShellArguments, type ResolvedPwshRuntime } from "./runtime.ts";
import { mutateMetadataSnapshots, readLatestMetadataSnapshot, renameWithRetry } from "./task-metadata-store.mjs";

export { renameWithRetry };

export type TaskStatus = "starting" | "running" | "completed" | "failed" | "cancelled";

export interface TaskMetadata {
	version: 1;
	id: string;
	instanceId: string;
	sessionId: string;
	supervisorPid: number;
	pid?: number;
	cwd: string;
	commandSummary: string;
	notifyOn?: string;
	createdAt: string;
	updatedAt: string;
	status: TaskStatus;
	exitCode?: number | null;
	error?: string;
	failureKind?: "infrastructure";
}

export interface TaskSnapshot {
	metadata: TaskMetadata;
	output: string;
	omittedBytes: number;
	ready: boolean;
}

interface SnapshotOptions {
	claimTerminal?: boolean;
}

const TASK_ID = /^ps_[0-9a-f]{8}$/;
const STATUSES = new Set<TaskStatus>(["starting", "running", "completed", "failed", "cancelled"]);
const TERMINAL = new Set<TaskStatus>(["completed", "failed", "cancelled"]);
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_NOTIFY_BYTES = 256;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const START_GRACE_MS = 10_000;
const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), "task-launcher.mjs");

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		try {
			await renameWithRetry(temporary, path);
		} catch (error) {
			// Last resort once the backoff ladder is exhausted: overwrite in
			// place. Atomicity degrades to best-effort, but readers already
			// tolerate transient parse failures, so a torn read costs one poll
			// cycle while a failed write costs the whole task.
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw error;
			await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		}
	} finally {
		await rm(temporary, { force: true });
	}
}

function isAlive(pid?: number): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isProcessGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		throw error;
	}
}

async function killProcessTree(pid?: number): Promise<void> {
	if (!pid) return;
	if (process.platform === "win32") {
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.once("error", reject);
			killer.once("close", resolve);
		});
		if (exitCode !== 0 && isAlive(pid)) throw new Error(`pwsh: failed to terminate process tree ${pid}`);
		return;
	}

	try {
		process.kill(-pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
		throw error;
	}
	await new Promise((resolve) => setTimeout(resolve, 300));
	if (isProcessGroupAlive(pid)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	const deadline = Date.now() + 2_000;
	while (isProcessGroupAlive(pid) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	if (isProcessGroupAlive(pid)) throw new Error(`pwsh: process tree ${pid} did not terminate`);
}

function waitDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const finish = (error?: unknown) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const onAbort = () => finish(signal?.reason ?? new DOMException("This operation was aborted", "AbortError"));
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

function commandSummary(command: string): string {
	return command
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
		.replace(/\n/g, " ↵ ")
		.slice(0, 2_000);
}

function parseMetadata(value: unknown, id: string): TaskMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid metadata");
	const input = value as Record<string, unknown>;
	if (input.version !== 1 || input.id !== id) throw new Error("invalid metadata identity");
	if (typeof input.instanceId !== "string" || !/^[0-9a-f]{32}$/i.test(input.instanceId)) throw new Error("invalid instance ID");
	if (typeof input.sessionId !== "string") throw new Error("invalid session ID");
	if (!Number.isInteger(input.supervisorPid) || (input.supervisorPid as number) < 0) throw new Error("invalid supervisor PID");
	if (input.pid !== undefined && (!Number.isInteger(input.pid) || (input.pid as number) <= 0)) throw new Error("invalid process PID");
	if (typeof input.cwd !== "string") throw new Error("invalid working directory");
	if (typeof input.commandSummary !== "string" || input.commandSummary.length > 2_000) throw new Error("invalid command summary");
	if (
		input.notifyOn !== undefined
		&& (typeof input.notifyOn !== "string" || input.notifyOn.length === 0 || Buffer.byteLength(input.notifyOn, "utf8") > MAX_NOTIFY_BYTES)
	) throw new Error("invalid readiness pattern");
	if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) throw new Error("invalid creation time");
	if (typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt))) throw new Error("invalid update time");
	if (typeof input.status !== "string" || !STATUSES.has(input.status as TaskStatus)) throw new Error("invalid status");
	if (input.exitCode !== undefined && input.exitCode !== null && !Number.isInteger(input.exitCode)) throw new Error("invalid exit code");
	if (input.error !== undefined && typeof input.error !== "string") throw new Error("invalid error");
	if (input.failureKind !== undefined && input.failureKind !== "infrastructure") throw new Error("invalid failure kind");
	return input as unknown as TaskMetadata;
}

export class PwshTaskRuntime {
	readonly taskDir: string;
	private sessionId: string;
	/**
	 * Task ids known to belong to a different session.
	 *
	 * The task directory is shared by every pi session on the host and is only
	 * pruned by retention, so it accumulates hundreds of entries. The observer
	 * polls `list()` several times a second, and without this set every poll read
	 * the metadata of every task just to discard the ones it does not own: with
	 * 655 task directories that was thousands of filesystem operations per second
	 * per session, enough to keep a core busy while the session sat idle.
	 *
	 * A task directory is created once with a fixed `sessionId`, so the decision
	 * never changes and a foreign task never has to be read twice.
	 */
	private foreignTasks = new Set<string>();

	constructor(
		readonly pwsh: ResolvedPwshRuntime,
		options: { taskDir?: string; sessionId?: string } = {},
	) {
		this.taskDir = options.taskDir ?? join(tmpdir(), "pi-pwsh-tasks");
		this.sessionId = options.sessionId ?? "";
	}

	setSessionId(id: string): void {
		if (id !== this.sessionId) this.foreignTasks.clear();
		this.sessionId = id;
	}

	taskDirectoryPath(id: string): string {
		if (!TASK_ID.test(id)) throw new Error(`pwsh: invalid taskId ${JSON.stringify(id)}`);
		return join(this.taskDir, id);
	}

	async start(
		command: string,
		cwd: string,
		notifyOn?: string,
		executionPrefix = "",
		extraEnv: Readonly<Record<string, string>> = {},
	): Promise<TaskMetadata> {
		if (!command) throw new Error("pwsh: command must not be empty");
		if (notifyOn !== undefined && (notifyOn.length === 0 || Buffer.byteLength(notifyOn, "utf8") > MAX_NOTIFY_BYTES)) {
			throw new Error("pwsh: notifyOn must contain 1 to 256 UTF-8 bytes");
		}
		await this.cleanupExpired();
		await mkdir(this.taskDir, { recursive: true, mode: 0o700 });
		await chmod(this.taskDir, 0o700);

		let id = "";
		let directory = "";
		for (let attempt = 0; attempt < 5; attempt++) {
			id = `ps_${randomUUID().slice(0, 8)}`;
			directory = join(this.taskDir, id);
			try {
				await mkdir(directory, { mode: 0o700 });
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 4) throw error;
			}
		}

		const instanceId = randomUUID().replaceAll("-", "");
		const now = new Date().toISOString();
		const metadata: TaskMetadata = {
			version: 1,
			id,
			instanceId,
			sessionId: this.sessionId,
			supervisorPid: 0,
			cwd,
			commandSummary: commandSummary(command),
			...(notifyOn ? { notifyOn } : {}),
			createdAt: now,
			updatedAt: now,
			status: "starting",
		};
		const logPath = join(directory, "output.log");
		const metadataDir = join(directory, "metadata");
		const configPath = join(directory, "config.json");
		const cancelMarkerPath = join(directory, `${instanceId}.cancelled`);
		let launcherPid = 0;

		try {
			await Promise.all([
				writeFile(logPath, "", { encoding: "utf8", mode: 0o600 }),
				this.updateMetadata(id, (current) => {
					if (current) throw new Error("pwsh: task metadata already exists");
					return metadata;
				}, true),
			]);
			const strict = this.pwsh.stopOnError ? "$ErrorActionPreference = 'Stop'; " : "";
			const source = `${UTF8_PREFIX}${executionPrefix}${strict}$global:LASTEXITCODE = $null; ${wrapPowerShellCommand(command)}`;
			// -Command with the stdin bootstrap, never -EncodedCommand: the latter
			// makes PowerShell CLIXML-serialize host and error streams (Write-Host,
			// Write-Error, throw) instead of emitting plain text.
			await writeJsonAtomic(configPath, {
				id,
				instanceId,
				executable: this.pwsh.executable,
				args: [
					...userPowerShellArguments(this.pwsh, { nonInteractive: true }),
					"-Command",
					SOURCE_BOOTSTRAP,
				],
				stdin: Buffer.from(source, "utf8").toString("base64"),
				cwd,
				logPath,
				metadataDir,
				notifyOn,
				readyMarkerPath: join(directory, `${instanceId}.ready.detected`),
				cancelMarkerPath,
			});

			const launcherEnv = createRuntimeEnv(extraEnv, process.env, this.pwsh);
			// A Bun-compiled standalone otherwise re-enters its bundled application
			// instead of executing the external launcher module.
			if (process.versions.bun) launcherEnv.BUN_BE_BUN = "1";
			const launcher = spawn(process.execPath, [LAUNCHER, configPath], {
				cwd,
				detached: true,
				env: launcherEnv,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				windowsHide: true,
			});
			launcherPid = launcher.pid ?? 0;
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const finish = (error?: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					launcher.removeListener("error", onError);
					launcher.removeListener("exit", onExit);
					launcher.removeListener("disconnect", onDisconnect);
					launcher.removeListener("message", onMessage);
					if (error) reject(error);
					else resolve();
				};
				const onError = (error: Error) => finish(error);
				const onExit = (code: number | null) => finish(new Error(`pwsh: task launcher exited during startup (${code})`));
				const onDisconnect = () => finish(new Error("pwsh: task launcher disconnected during startup"));
				const onMessage = (message: unknown) => {
					if (!message || typeof message !== "object") return;
					const value = message as { type?: unknown; error?: unknown };
					if (value.type === "ready") finish();
					else if (value.type === "error") finish(new Error(`pwsh: ${String(value.error)}`));
				};
				const timer = setTimeout(() => finish(new Error("pwsh: task launcher did not start within 5 seconds")), 5_000);
				launcher.once("error", onError);
				launcher.once("exit", onExit);
				launcher.once("disconnect", onDisconnect);
				launcher.on("message", onMessage);
			});
			if (launcher.connected) launcher.disconnect();
			launcher.unref();
			return await this.refreshOwned(id);
		} catch (error) {
			const startupMessage = error instanceof Error ? error.message : String(error);
			const cleanupErrors: string[] = [];
			try {
				await writeFile(cancelMarkerPath, "", { flag: "a", mode: 0o600 });
			} catch (cleanupError) {
				cleanupErrors.push(`cancel marker: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			}
			try {
				await killProcessTree(launcherPid);
			} catch (cleanupError) {
				cleanupErrors.push(`process cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			}
			const message = cleanupErrors.length > 0
				? `${startupMessage}; cleanup failed (${cleanupErrors.join("; ")})`
				: startupMessage;
			// Allocation succeeded, so retain the task artifacts and make startup
			// failures inspectable just like asynchronous infrastructure failures.
			const failed = {
				...metadata,
				status: "failed" as const,
				exitCode: null,
				error: message,
				failureKind: "infrastructure" as const,
				updatedAt: new Date().toISOString(),
			};
			await Promise.allSettled([
				writeFile(logPath, `[pi-pwsh startup failure] ${message}\n`, { encoding: "utf8", mode: 0o600, flag: "a" }),
				this.updateMetadata(id, () => failed, true),
				writeFile(join(directory, `${instanceId}.exit.presented`), "", { flag: "a", mode: 0o600 }),
			]);
			if (directory && existsSync(directory)) {
				throw new Error(`${message}\ndiagnosticsPath: ${directory}`);
			}
			throw error;
		}
	}

	async snapshot(
		id: string,
		waitSeconds = 0,
		signal?: AbortSignal,
		options: SnapshotOptions = {},
	): Promise<TaskSnapshot> {
		signal?.throwIfAborted();
		const deadline = Date.now() + waitSeconds * 1_000;
		let metadata = await this.refreshOwned(id);
		let ready = this.isReady(metadata);
		while (!TERMINAL.has(metadata.status) && !(metadata.notifyOn && ready) && Date.now() < deadline) {
			await waitDelay(Math.min(50, deadline - Date.now()), signal);
			metadata = await this.refreshOwned(id);
			ready = this.isReady(metadata);
		}
		const output = await this.tail(id);
		if ((options.claimTerminal ?? true) && TERMINAL.has(metadata.status)) await this.markPresented(metadata);
		return { metadata, ...output, ready };
	}

	async markReadyPresented(metadata: TaskMetadata): Promise<void> {
		await this.markPresented(metadata, "ready");
	}

	async stop(id: string): Promise<TaskSnapshot> {
		let metadata = await this.refreshOwned(id);
		if (!TERMINAL.has(metadata.status)) {
			const instanceId = metadata.instanceId;
			await writeFile(join(this.taskDirectoryPath(id), `${instanceId}.cancelled`), "", { flag: "a", mode: 0o600 });
			await killProcessTree(metadata.supervisorPid || metadata.pid);
			metadata = await this.updateMetadata(id, (current) => {
				if (!current || current.sessionId !== this.sessionId || current.instanceId !== instanceId) {
					throw new Error(`pwsh: task ${JSON.stringify(id)} changed while stopping`);
				}
				return {
					...current,
					status: "cancelled",
					exitCode: null,
					error: undefined,
					failureKind: undefined,
					updatedAt: new Date().toISOString(),
				};
			});
		}
		return this.snapshot(id);
	}

	async list(sessionId = this.sessionId): Promise<TaskMetadata[]> {
		// Only the owning session's view can skip foreign tasks; a caller asking
		// about someone else's session still needs the full read.
		const ownView = sessionId !== "" && sessionId === this.sessionId;
		const tasks = (await this.readAll({ skipForeign: ownView })).filter((metadata) => !sessionId || metadata.sessionId === sessionId);
		return Promise.all(tasks.map((metadata) =>
			metadata.sessionId === this.sessionId ? this.refreshOwned(metadata.id) : metadata
		));
	}

	async readMetadata(id: string): Promise<TaskMetadata> {
		const directory = this.taskDirectoryPath(id);
		if (!existsSync(directory)) throw new Error(`pwsh: task ${JSON.stringify(id)} was not found`);
		try {
			if (existsSync(this.metadataDirectoryPath(id))) {
				return (await readLatestMetadataSnapshot<TaskMetadata>(
					this.metadataDirectoryPath(id),
					(value) => parseMetadata(value, id),
				)).metadata;
			}
			return await this.readLegacyMetadata(id);
		} catch (error) {
			throw new Error(`pwsh: could not read task ${JSON.stringify(id)}: ${error instanceof Error ? error.message : String(error)}\ndiagnosticsPath: ${directory}`);
		}
	}

	async cleanupExpired(): Promise<void> {
		await mkdir(this.taskDir, { recursive: true, mode: 0o700 });
		await chmod(this.taskDir, 0o700);
		for (const metadata of await this.readAll()) {
			if (TERMINAL.has(metadata.status) && Date.now() - Date.parse(metadata.updatedAt) > RETENTION_MS) {
				await rm(this.taskDirectoryPath(metadata.id), { recursive: true, force: true });
			}
		}
	}

	private metaPath(id: string): string {
		return join(this.taskDirectoryPath(id), "meta.json");
	}

	private metadataDirectoryPath(id: string): string {
		return join(this.taskDirectoryPath(id), "metadata");
	}

	private async readLegacyMetadata(id: string): Promise<TaskMetadata> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			const raw = await readFile(this.metaPath(id), "utf8");
			try {
				return parseMetadata(JSON.parse(raw), id);
			} catch (error) {
				lastError = error;
				if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		throw lastError;
	}

	private async updateMetadata(
		id: string,
		update: (current: TaskMetadata | undefined) => TaskMetadata | undefined,
		allowCreate = false,
	): Promise<TaskMetadata> {
		const snapshots = this.metadataDirectoryPath(id);
		if (allowCreate || existsSync(snapshots)) {
			return (await mutateMetadataSnapshots<TaskMetadata>(snapshots, update, {
				allowCreate,
				validate: (value) => parseMetadata(value, id),
			})).metadata;
		}
		const current = await this.readMetadata(id);
		const next = update(current);
		if (!next) return current;
		const validated = parseMetadata(next, id);
		await writeJsonAtomic(this.metaPath(id), validated);
		return validated;
	}

	private async refreshOwned(id: string): Promise<TaskMetadata> {
		const initial = await this.readMetadata(id);
		if (initial.sessionId !== this.sessionId) {
			throw new Error(`pwsh: task ${JSON.stringify(id)} belongs to a different session`);
		}
		const metadata = await this.refresh(id);
		if (metadata.sessionId !== this.sessionId) {
			throw new Error(`pwsh: task ${JSON.stringify(id)} belongs to a different session`);
		}
		return metadata;
	}

	private async refresh(id: string): Promise<TaskMetadata> {
		let metadata = await this.readMetadata(id);
		const staleStart = metadata.status === "starting"
			&& metadata.supervisorPid === 0
			&& Date.now() - Date.parse(metadata.createdAt) > START_GRACE_MS;
		const dead = !TERMINAL.has(metadata.status)
			&& metadata.supervisorPid > 0
			&& !isAlive(metadata.supervisorPid);
		if (!staleStart && !dead) return metadata;
		if (dead) await new Promise((resolve) => setTimeout(resolve, 50));

		return this.updateMetadata(id, (current) => {
			if (!current) throw new Error(`pwsh: task ${JSON.stringify(id)} has no metadata`);
			const stillDead = current.supervisorPid > 0 && !isAlive(current.supervisorPid);
			if (current.instanceId !== metadata.instanceId || TERMINAL.has(current.status) || (!staleStart && !stillDead)) return undefined;
			metadata = {
				...current,
				status: "failed",
				exitCode: null,
				error: staleStart ? "Task launcher did not become ready" : "Task supervisor exited without final status",
				failureKind: "infrastructure",
				updatedAt: new Date().toISOString(),
			};
			return metadata;
		});
	}

	/**
	 * `skipForeign` omits tasks already known to belong to another session and is
	 * only safe for the owning session's own view. `cleanupExpired` must see every
	 * task regardless of owner, so it reads without it.
	 */
	private async readAll(options: { skipForeign?: boolean } = {}): Promise<TaskMetadata[]> {
		await mkdir(this.taskDir, { recursive: true, mode: 0o700 });
		const entries = await readdir(this.taskDir, { withFileTypes: true });
		const ids = entries
			.filter((entry) => entry.isDirectory() && TASK_ID.test(entry.name))
			.map((entry) => entry.name);
		if (this.foreignTasks.size > 0) {
			// Retention deletes task directories; drop their ids so the set cannot
			// grow without bound across a long-lived session.
			const present = new Set(ids);
			for (const id of this.foreignTasks) {
				if (!present.has(id)) this.foreignTasks.delete(id);
			}
		}
		const values = await Promise.all(ids.map(async (id) => {
			if (options.skipForeign && this.foreignTasks.has(id)) return undefined;
			try {
				const metadata = await this.readMetadata(id);
				if (metadata.sessionId !== this.sessionId) this.foreignTasks.add(id);
				return metadata;
			} catch {
				return undefined;
			}
		}));
		return values.filter((value): value is TaskMetadata => value !== undefined);
	}

	private async tail(id: string): Promise<{ output: string; omittedBytes: number }> {
		const path = join(this.taskDirectoryPath(id), "output.log");
		const size = (await stat(path)).size;
		let omittedBytes = Math.max(0, size - MAX_OUTPUT_BYTES);
		if (size === 0) return { output: "", omittedBytes: 0 };
		const handle = await open(path, "r");
		try {
			if (omittedBytes > 0) {
				// Snap the window start past any UTF-8 continuation bytes so the kept
				// text does not begin mid-sequence with a replacement character.
				const probe = Buffer.alloc(4);
				const { bytesRead: probeBytes } = await handle.read(probe, 0, 4, omittedBytes);
				let advance = 0;
				while (advance < probeBytes && (probe[advance] & 0xc0) === 0x80) advance++;
				omittedBytes += advance;
			}
			const length = size - omittedBytes;
			const buffer = Buffer.alloc(length);
			let bytesRead = 0;
			while (bytesRead < length) {
				const read = await handle.read(buffer, bytesRead, length - bytesRead, omittedBytes + bytesRead);
				if (read.bytesRead === 0) break;
				bytesRead += read.bytesRead;
			}
			return { output: buffer.subarray(0, bytesRead).toString("utf8"), omittedBytes };
		} finally {
			await handle.close();
		}
	}

	private isReady(metadata: TaskMetadata): boolean {
		return !!metadata.notifyOn
			&& existsSync(join(this.taskDirectoryPath(metadata.id), `${metadata.instanceId}.ready.detected`));
	}

	private async markPresented(metadata: TaskMetadata, kind: "ready" | "exit" = "exit"): Promise<void> {
		const path = join(this.taskDirectoryPath(metadata.id), `${metadata.instanceId}.${kind}.presented`);
		try {
			const handle = await open(path, "wx", 0o600);
			await handle.close();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}
