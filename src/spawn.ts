/** Shared PowerShell command encoding, environment, and user-shell spawn helpers. */

import { spawn } from "child_process";
import { waitForChildProcess } from "./child-process-wait.mjs";

export interface RuntimeEnvironmentConfig {
	pythonUtf8: boolean;
	pythonUnbuffered: boolean;
}

const DEFAULT_RUNTIME_ENVIRONMENT_CONFIG: Readonly<RuntimeEnvironmentConfig> = {
	pythonUtf8: true,
	pythonUnbuffered: true,
};

function findEnvKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
	if (process.platform !== "win32") {
		return Object.prototype.hasOwnProperty.call(env, name) ? name : undefined;
	}
	const normalized = name.toUpperCase();
	return Object.keys(env).find((key) => key.toUpperCase() === normalized);
}

/**
 * Build the environment inherited by user commands. Python defaults make its
 * stdio/file defaults match the tool's UTF-8 transport and keep logs streaming;
 * caller-defined values are preserved. Explicit extras always win.
 */
export function createRuntimeEnv(
	extra: Readonly<Record<string, string>> = {},
	baseEnv: NodeJS.ProcessEnv = process.env,
	config: RuntimeEnvironmentConfig = DEFAULT_RUNTIME_ENVIRONMENT_CONFIG,
): NodeJS.ProcessEnv {
	const env = { ...baseEnv };
	const defaults: Record<string, string> = {};
	if (config.pythonUtf8) {
		defaults.PYTHONIOENCODING = "utf-8";
		defaults.PYTHONUTF8 = "1";
	}
	if (config.pythonUnbuffered) defaults.PYTHONUNBUFFERED = "1";
	for (const [name, value] of Object.entries(defaults)) {
		const existing = findEnvKey(env, name);
		if (existing === undefined || env[existing] === undefined) env[name] = value;
	}
	for (const [name, value] of Object.entries(extra)) {
		const existing = findEnvKey(env, name);
		if (existing !== undefined && existing !== name) delete env[existing];
		env[name] = value;
	}
	return env;
}

/** Force plain UTF-8 output without adding a BOM to native-command stdin. */
export const UTF8_PREFIX =
	"$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $PSStyle.OutputRendering = 'PlainText'; ";

/** Fixed ASCII bootstrap; the complete UTF-8 source is base64-encoded on stdin. */
export const SOURCE_BOOTSTRAP =
	"$__pipwsh_source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([Console]::In.ReadToEnd())); & ([ScriptBlock]::Create($__pipwsh_source))";

/**
 * `pwsh -Command` flattens native exit codes to 0/1 unless the script ends
 * with an explicit `exit` (e.g. `cmd /c exit 3` makes the process exit 1).
 * This epilogue captures the final command's status without exiting yet. A
 * successful final command wins over a stale LASTEXITCODE; on failure, a
 * nonzero native code is retained when present, and failures without one map
 * to 1. wrapPowerShellCommand drains PowerShell's object formatter before it
 * exits with the captured code. The persistent task launcher uses this wrapper too.
 *
 * Starts with "\n; " — the newline detaches from a trailing line comment,
 * and the `;` neutralizes a trailing backtick (line continuation would
 * otherwise glue the epilogue into the last command's arguments).
 */
export const EXIT_EPILOGUE =
	"\n; $__pipwsh_ok = $?; $__pipwsh_native = $global:LASTEXITCODE; if ($__pipwsh_ok) { $global:__pipwsh_exit_code = 0 } elseif ($null -ne $__pipwsh_native -and $__pipwsh_native -ne 0) { $global:__pipwsh_exit_code = $__pipwsh_native } else { $global:__pipwsh_exit_code = 1 }";

/** Format all success output before the explicit exit needed for exact native codes. */
export function wrapPowerShellCommand(source: string): string {
	return `$global:__pipwsh_exit_code = 0; . {\n${source}${EXIT_EPILOGUE}\n} | Out-Default\nexit $global:__pipwsh_exit_code`;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

/** Best-effort synchronous process-tree termination for abort and timeout callbacks. */
export function killTree(pid: number | undefined): void {
	if (!pid) return;
	if (process.platform === "win32") {
		try {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			killer.once("error", () => {});
		} catch {
			// Best effort.
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

export interface ExecOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
	stdin?: string;
}

function timeoutMilliseconds(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds greater than zero");
	}
	if (timeout > MAX_TIMEOUT_MS / 1000) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
	}
	return timeout * 1000;
}

/** Spawn a process and stream combined stdout/stderr into onData, following bash.ts error conventions. */
export async function spawnAndStream(
	exe: string,
	args: string[],
	cwd: string,
	{ onData, signal, timeout, env, stdin }: ExecOptions,
): Promise<{ exitCode: number | null; stderrText: string }> {
	if (signal?.aborted) throw new Error("aborted");
	const timeoutMs = timeoutMilliseconds(timeout);

	const child = spawn(exe, args, {
		cwd,
		env: env ?? process.env,
		stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		windowsHide: true,
		detached: process.platform !== "win32",
	});
	if (stdin !== undefined) {
		child.stdin?.on("error", () => {
			// Startup/termination failures are reported through child events.
		});
		child.stdin?.end(stdin, "utf8");
	}

	let stderrText = "";
	let timedOut = false;
	let timeoutHandle: NodeJS.Timeout | undefined;
	const onStdoutData = (data: Buffer) => onData(data);
	const onStderrData = (data: Buffer) => {
		stderrText += data.toString("utf-8");
		onData(data);
	};
	const onAbort = () => killTree(child.pid);

	try {
		child.stdout?.on("data", onStdoutData);
		child.stderr?.on("data", onStderrData);
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

		const { exitCode } = await waitForChildProcess(child);
		if (signal?.aborted) throw new Error("aborted");
		if (timedOut) throw new Error(`timeout:${timeout}`);
		return { exitCode, stderrText };
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		signal?.removeEventListener("abort", onAbort);
		child.stdout?.removeListener("data", onStdoutData);
		child.stderr?.removeListener("data", onStderrData);
	}
}
