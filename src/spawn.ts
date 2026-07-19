/**
 * Shared spawn layer for the pwsh tool and the background job tools.
 */

import { spawn } from "child_process";

/** Force UTF-8 so non-ASCII output (e.g. CJK) is not mangled by the legacy OEM codepage. */
export const UTF8_PREFIX =
	"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ";

/**
 * `pwsh -Command` flattens native exit codes to 0/1 unless the script ends
 * with an explicit `exit` (e.g. `cmd /c exit 3` makes the process exit 1).
 * Appending this epilogue preserves the real code: $LASTEXITCODE when a
 * native command ran, otherwise 0/1 derived from $? (cmdlet failures).
 * Mirrors the epilogue in the job wrapper (prelude.ps1) so foreground and
 * background execution report exit codes identically.
 *
 * Starts with "\n; " — the newline detaches from a trailing line comment,
 * and the `;` neutralizes a trailing backtick (line continuation would
 * otherwise glue the epilogue into the last command's arguments).
 */
export const EXIT_EPILOGUE =
	"\n; $__pipwsh_ok = $?; if ($null -ne $global:LASTEXITCODE) { exit $global:LASTEXITCODE } else { exit ($__pipwsh_ok ? 0 : 1) }";

const MAX_TIMEOUT_MS = 2_147_483_647;

/** Kill the whole process tree on Windows (child.kill() alone orphans children like npm). */
export function killTree(pid: number | undefined): void {
	if (!pid) return;
	try {
		spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
	} catch {
		// Best effort.
	}
}

export interface ExecOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
}

/** Spawn a process and stream combined stdout/stderr into onData, following bash.ts error conventions. */
export function spawnAndStream(
	exe: string,
	args: string[],
	cwd: string,
	{ onData, signal, timeout, env }: ExecOptions,
): Promise<{ exitCode: number | null; stderrText: string }> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const timeoutMs =
			timeout === undefined ? undefined : Math.min(Math.max(timeout, 0.001), MAX_TIMEOUT_MS / 1000) * 1000;

		const child = spawn(exe, args, {
			cwd,
			env: env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stderrText = "";
		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		const onAbort = () => killTree(child.pid);
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs !== undefined) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				killTree(child.pid);
			}, timeoutMs);
		}

		child.stdout?.on("data", onData);
		child.stderr?.on("data", (data: Buffer) => {
			stderrText += data.toString("utf-8");
			onData(data);
		});

		child.on("error", (err) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});

		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) {
				reject(new Error("aborted"));
			} else if (timedOut) {
				reject(new Error(`timeout:${timeout}`));
			} else {
				resolve({ exitCode: code, stderrText });
			}
		});
	});
}
