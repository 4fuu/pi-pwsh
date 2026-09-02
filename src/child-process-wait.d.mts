import type { ChildProcess } from "node:child_process";

export interface ChildProcessResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

export function waitForChildProcess(child: ChildProcess): Promise<ChildProcessResult>;
