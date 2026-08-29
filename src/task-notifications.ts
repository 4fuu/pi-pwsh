import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskCoordinator, TaskNotificationKind, TaskWithdrawalReason } from "@4fu/pi-task-coordinator";
import type { PresentedTask, TaskReporter } from "@4fu/pi-tasks";
import { PwshTaskRuntime, renameWithRetry, type TaskMetadata, type TaskSnapshot } from "./task-runtime.ts";

const DEFAULT_POLL_MS = 400;
const MAX_NOTIFICATION_LINES = 20;
const MAX_NOTIFICATION_CHARS = 4_000;
const CLAIM_LEASE_MS = 30_000;

type ClaimState = "claimed" | "busy" | "settled" | "retry";

function isTerminal(metadata: TaskMetadata): boolean {
	return metadata.status !== "starting" && metadata.status !== "running";
}

function taskPhase(metadata: TaskMetadata): PresentedTask["phase"] {
	if (metadata.status === "starting" || metadata.status === "running") return "active";
	return metadata.status;
}

function boundedOutput(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1bP[\s\S]*?\x1b\\/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
		.trimEnd().split("\n").slice(-MAX_NOTIFICATION_LINES).join("\n").slice(-MAX_NOTIFICATION_CHARS);
}

export class TaskNotificationManager {
	private timer?: NodeJS.Timeout;
	private closed = true;
	private scanPromise: Promise<void> | undefined;
	private lastScanError?: string;

	constructor(
		private readonly coordinator: TaskCoordinator,
		private readonly reporter: TaskReporter,
		private readonly ctx: ExtensionContext,
		private readonly runtime: PwshTaskRuntime,
		private readonly sessionId: string,
		private readonly pollIntervalMs = DEFAULT_POLL_MS,
	) {}

	async start(): Promise<void> {
		if (!this.closed) return;
		this.closed = false;
		if (this.pollIntervalMs > 0) {
			this.timer = setInterval(() => void this.scanSafely().catch(() => {}), this.pollIntervalMs);
			this.timer.unref?.();
		}
		await this.scanSafely();
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.scanPromise?.catch(() => {});
		this.lastScanError = undefined;
		this.reporter.publishCatalog(this.sessionId, []);
	}

	async scanNow(): Promise<void> {
		if (this.closed) return;
		if (this.scanPromise) return this.scanPromise;
		const scan = this.performScan();
		this.scanPromise = scan;
		try {
			await scan;
		} finally {
			if (this.scanPromise === scan) this.scanPromise = undefined;
		}
	}

	private async performScan(): Promise<void> {
		const tasks = (await this.runtime.list(this.sessionId)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
		if (this.closed) return;
		const snapshots: TaskSnapshot[] = [];
		for (const metadata of tasks) {
			if (this.closed) return;
			const snapshot = await this.runtime.snapshot(metadata.id, 0, undefined, { claimTerminal: false });
			if (this.closed) return;
			snapshots.push(snapshot);
		}
		const catalog: PresentedTask[] = snapshots.map(({ metadata, ready }) => {
			const active = !isTerminal(metadata);
			const createdAt = Date.parse(metadata.createdAt);
			const updatedAt = Date.parse(metadata.updatedAt);
			return {
				taskKey: `pwsh:${metadata.id}`,
				source: "pwsh",
				taskId: metadata.id,
				phase: taskPhase(metadata),
				statusLabel: active && ready ? "ready" : metadata.status,
				createdAt,
				updatedAt,
				startedAt: createdAt,
				...(active ? {} : { endedAt: updatedAt }),
				summary: metadata.commandSummary,
			};
		});
		this.reporter.publishCatalog(this.sessionId, catalog);
		for (const snapshot of snapshots) {
			if (this.closed) return;
			if (isTerminal(snapshot.metadata)) {
				if (snapshot.ready) {
					this.coordinator.withdrawTask(`pwsh:${snapshot.metadata.id}`, ["ready"], "superseded");
					await this.settleNotified(snapshot.metadata, "ready");
				}
				await this.offer(snapshot.metadata, "terminal", snapshot.output);
			} else if (snapshot.ready) await this.offer(snapshot.metadata, "ready", snapshot.output);
		}
	}

	private async offer(metadata: TaskMetadata, kind: TaskNotificationKind, output: string): Promise<void> {
		if (!await this.isCurrent(metadata) || existsSync(this.presentedPath(metadata, kind))) return;
		if (this.closed) return;
		const state = await this.claim(metadata, kind);
		if (state !== "claimed") return;
		if (this.closed) {
			await rm(this.claimPath(metadata, kind), { force: true });
			return;
		}
		const eventId = `pwsh:${metadata.instanceId}:${kind}`;
		this.coordinator.offer({
			eventId, taskKey: `pwsh:${metadata.id}`, source: "pwsh", taskId: metadata.id, event: kind,
			status: kind === "ready" ? "ready" : metadata.status,
			durationMs: Math.max(0, Date.now() - Date.parse(metadata.createdAt)),
			summary: metadata.commandSummary, output: boundedOutput(output),
			ok: kind === "ready" || metadata.status === "completed", occurredAt: Date.parse(metadata.updatedAt),
		}, {
			onSubmitted: async () => this.moveToSubmitted(metadata, kind),
			onDelivered: async () => this.settleNotified(metadata, kind),
			onWithdrawn: async reason => this.withdraw(metadata, kind, reason),
		});
	}

	private async moveToSubmitted(metadata: TaskMetadata, kind: TaskNotificationKind): Promise<void> {
		if (existsSync(this.notifiedPath(metadata, kind))) return;
		const submitted = this.submittedPath(metadata, kind);
		if (existsSync(submitted)) {
			try {
				const now = new Date();
				await utimes(submitted, now, now);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		try {
			await renameWithRetry(this.claimPath(metadata, kind), submitted);
			const now = new Date();
			await utimes(submitted, now, now);
		}
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}

	private async settleNotified(metadata: TaskMetadata, kind: TaskNotificationKind): Promise<void> {
		const handle = await open(this.notifiedPath(metadata, kind), "a", 0o600);
		await handle.close();
		await Promise.all([this.claimPath(metadata, kind), this.submittedPath(metadata, kind)].map(path => rm(path, { force: true })));
	}

	private async withdraw(metadata: TaskMetadata, kind: TaskNotificationKind, reason: TaskWithdrawalReason): Promise<void> {
		if (reason === "superseded") {
			await this.settleNotified(metadata, kind);
			return;
		}
		if (reason === "retry-exhausted") {
			const claim = this.claimPath(metadata, kind);
			const submitted = this.submittedPath(metadata, kind);
			if (existsSync(submitted)) {
				try {
					await renameWithRetry(submitted, claim);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					await rm(submitted, { force: true });
				}
			}
			if (!existsSync(claim)) {
				const handle = await open(claim, "a", 0o600);
				await handle.close();
			}
			const now = new Date();
			await utimes(claim, now, now);
			return;
		}
		await Promise.all([this.claimPath(metadata, kind), this.submittedPath(metadata, kind)].map(path => rm(path, { force: true })));
	}

	private async isCurrent(metadata: TaskMetadata): Promise<boolean> {
		try {
			const current = await this.runtime.readMetadata(metadata.id);
			return current.instanceId === metadata.instanceId && current.sessionId === this.sessionId;
		} catch { return false; }
	}

	private async scanSafely(): Promise<void> {
		try { await this.scanNow(); this.lastScanError = undefined; }
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === this.lastScanError) return;
			this.lastScanError = message;
			this.notifyScanError(message);
		}
	}

	/**
	 * Reports a scan error through the UI. Never throws: this is the observer's last
	 * error handler, and it runs from a timer callback whose rejection would surface as
	 * an uncaught exception.
	 *
	 * Every property of a captured extension context asserts that the context is still
	 * active, so `ctx.hasUI` throws once pi replaces or reloads the session. The context
	 * is invalidated before `session_start` fires, so the timer can still be armed while
	 * the context is already stale. Stop the observer in that case; index.ts constructs a
	 * new manager with the fresh context on `session_start`.
	 */
	private notifyScanError(message: string): void {
		if (this.closed) return;
		try {
			if (this.ctx.hasUI) this.ctx.ui.notify(`pi-pwsh: task observer error: ${message}`, "error");
		} catch {
			void this.close().catch(() => {});
		}
	}

	private base(metadata: TaskMetadata, kind: TaskNotificationKind): string {
		return join(this.runtime.taskDirectoryPath(metadata.id), `${metadata.instanceId}.${kind === "terminal" ? "exit" : kind}`);
	}
	private claimPath(metadata: TaskMetadata, kind: TaskNotificationKind): string { return `${this.base(metadata, kind)}.notifying`; }
	private submittedPath(metadata: TaskMetadata, kind: TaskNotificationKind): string { return `${this.base(metadata, kind)}.submitted`; }
	private notifiedPath(metadata: TaskMetadata, kind: TaskNotificationKind): string { return `${this.base(metadata, kind)}.notified`; }
	private presentedPath(metadata: TaskMetadata, kind: TaskNotificationKind): string {
		return join(this.runtime.taskDirectoryPath(metadata.id), `${metadata.instanceId}.${kind === "terminal" ? "exit" : "ready"}.presented`);
	}

	private async claim(metadata: TaskMetadata, kind: TaskNotificationKind): Promise<ClaimState> {
		if (existsSync(this.notifiedPath(metadata, kind)) || existsSync(this.presentedPath(metadata, kind))) return "settled";
		const submitted = this.submittedPath(metadata, kind);
		if (existsSync(submitted)) {
			try {
				if (Date.now() - (await stat(submitted)).mtimeMs <= CLAIM_LEASE_MS) return "busy";
				const stale = `${submitted}.${randomUUID()}.stale`;
				await renameWithRetry(submitted, stale);
				await rm(stale, { force: true });
				return this.claim(metadata, kind);
			} catch {
				return existsSync(this.notifiedPath(metadata, kind)) ? "settled" : "busy";
			}
		}
		const claim = this.claimPath(metadata, kind);
		try { const handle = await open(claim, "wx", 0o600); await handle.close(); return "claimed"; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "retry"; }
		try {
			if (Date.now() - (await stat(claim)).mtimeMs <= CLAIM_LEASE_MS) return "busy";
			const stale = `${claim}.${randomUUID()}.stale`; await renameWithRetry(claim, stale); await rm(stale, { force: true });
			return this.claim(metadata, kind);
		} catch { return existsSync(this.notifiedPath(metadata, kind)) || existsSync(this.submittedPath(metadata, kind)) ? "settled" : "busy"; }
	}
}
