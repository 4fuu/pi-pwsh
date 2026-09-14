import type { PwshTaskRuntime, TaskSnapshot } from "./task-runtime.ts";

/** Releases only tool waits; the durable task and the agent turn keep running. */
export class TaskWaits {
	private readonly pending = new Set<AbortController>();

	background(): number {
		const pending = [...this.pending].filter(wait => !wait.signal.aborted);
		for (const wait of pending) wait.abort(new Error("Task moved to background"));
		return pending.length;
	}

	async snapshot(runtime: Pick<PwshTaskRuntime, "snapshot">, id: string, seconds: number, signal?: AbortSignal): Promise<{ snapshot: TaskSnapshot; backgrounded: boolean }> {
		if (seconds <= 0) return { snapshot: await runtime.snapshot(id, seconds, signal), backgrounded: false };
		const wait = new AbortController();
		const combined = signal ? AbortSignal.any([signal, wait.signal]) : wait.signal;
		this.pending.add(wait);
		try {
			return { snapshot: await runtime.snapshot(id, seconds, combined), backgrounded: false };
		} catch (error) {
			// Esc remains an abort, even if it races with the background shortcut.
			if (!wait.signal.aborted || error !== wait.signal.reason || signal?.aborted) throw error;
			return { snapshot: await runtime.snapshot(id, 0, signal), backgrounded: true };
		} finally {
			this.pending.delete(wait);
		}
	}
}
