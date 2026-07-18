/**
 * pi-pwsh — Replace pi's built-in `bash` tool with PowerShell 7 (`pwsh`).
 *
 * Why: Windows has no reliable bash. A tool named "bash" also primes the model
 * to emit POSIX syntax. This extension disables `bash` and registers a `pwsh`
 * tool that reuses pi's built-in bash tool definition (tail truncation, temp
 * files for full output, non-zero exit codes as tool errors, streaming preview,
 * built-in renderer) with only the spawn layer swapped to pwsh.
 *
 * Requires PowerShell 7+ (`pwsh` on PATH). No fallback: if pwsh is missing the
 * extension reports an error and leaves the built-in bash tool untouched.
 */

import { spawn } from "child_process";
import {
	createBashToolDefinition,
	type BashOperations,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

/** Force UTF-8 so non-ASCII output (e.g. CJK) is not mangled by the legacy OEM codepage. */
const UTF8_PREFIX =
	"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ";

const MAX_TIMEOUT_MS = 2_147_483_647;

/** Kill the whole process tree on Windows (child.kill() alone orphans children like npm). */
function killTree(pid: number | undefined): void {
	if (!pid) return;
	try {
		spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
	} catch {
		// Best effort.
	}
}

interface ExecOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
}

/** Spawn a process and stream combined stdout/stderr into onData, following bash.ts error conventions. */
function spawnAndStream(
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

/** npm/yarn/pnpm etc. are .cmd batch files on Windows; pwsh cannot spawn them directly. */
function isBatchFileSpawnError(stderrText: string): boolean {
	return (
		stderrText.includes("is not a valid Win32 application") ||
		stderrText.includes("no es una aplicación Win32 válida") ||
		stderrText.includes("cannot run due to the error")
	);
}

function createPwshOperations(): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			const pwshArgs = [
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				UTF8_PREFIX + command,
			];
			const first = await spawnAndStream("pwsh", pwshArgs, cwd, options);

			if (first.exitCode !== 0 && isBatchFileSpawnError(first.stderrText) && !options.signal?.aborted) {
				const retry = await spawnAndStream("cmd", ["/d", "/s", "/c", command], cwd, options);
				return { exitCode: retry.exitCode };
			}
			return { exitCode: first.exitCode };
		},
	};
}

/** Check that pwsh (PowerShell 7+) is available. */
function detectPwsh(): Promise<{ ok: boolean; version?: string }> {
	return new Promise((resolve) => {
		let out = "";
		const child = spawn(
			"pwsh",
			["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
			{ stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
		);
		child.stdout?.on("data", (d: Buffer) => {
			out += d.toString("utf-8");
		});
		child.on("error", () => resolve({ ok: false }));
		child.on("close", (code) => {
			const version = out.trim();
			const major = Number.parseInt(version.split(".")[0] ?? "", 10);
			resolve(code === 0 && major >= 7 ? { ok: true, version } : { ok: false });
		});
	});
}

const DESCRIPTION = `Execute a PowerShell 7 (pwsh) command on Windows in the current working directory. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB (whichever is hit first); if truncated, full output is saved to a temp file. Optionally provide a timeout in seconds (no default timeout).

QUOTING: PowerShell quoting differs from bash. Single quotes are literal strings (escape with ''). Double quotes allow variable expansion. Backtick (\`) is the escape character, not backslash.

ENVIRONMENT VARIABLES: Use PowerShell syntax: $env:NODE_ENV = 'production'; npm start (NOT bash-style NODE_ENV=production npm start).

BATCH FILES: npm, yarn, pnpm are .cmd batch files on Windows. If a command fails with "not a valid Win32 application", the tool automatically retries with cmd /c. You can also wrap explicitly: cmd /c "npm run dev".`;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const detection = await detectPwsh();
		if (!detection.ok) {
			ctx.ui.notify(
				"pi-pwsh: `pwsh` (PowerShell 7+) was not found on PATH. Install PowerShell 7 (https://github.com/PowerShell/PowerShell) or disable this extension. The built-in bash tool was left active.",
				"error",
			);
			return;
		}

		// Reuse the built-in bash tool definition (truncation, temp files, exit-code
		// errors, streaming, renderer) with only the spawn layer swapped to pwsh.
		const bashDef = createBashToolDefinition(ctx.cwd, { operations: createPwshOperations() });
		pi.registerTool({
			...bashDef,
			name: "pwsh",
			label: "pwsh",
			description: DESCRIPTION,
			promptSnippet: "Execute PowerShell 7 (pwsh) commands",
			promptGuidelines: [
				"Use pwsh for file operations and shell tasks; write PowerShell syntax, not bash/POSIX syntax.",
			],
		});

		const active = pi.getActiveTools();
		pi.setActiveTools([...active.filter((name) => name !== "bash" && name !== "pwsh"), "pwsh"]);
	});
}
