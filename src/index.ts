/**
 * pi-pwsh — Route pi's shell, directory listing, and search tasks through
 * PowerShell 7 (`pwsh`), including background jobs that survive tool calls.
 *
 * Why: Windows has no reliable bash. A tool named "bash" also primes the model
 * to emit POSIX syntax. This extension disables `bash`, `ls`, `find`, and `grep`,
 * then registers a `pwsh` tool that reuses pi's built-in bash tool definition
 * (tail truncation, temp files for full output, non-zero exit codes as tool errors, streaming preview,
 * built-in renderer) with only the spawn layer swapped to pwsh.
 *
 * Background jobs: every pwsh call is a fresh pwsh process, so native
 * PowerShell jobs (Start-Job, trailing `&`) die when the call ends. Commands
 * that reference job helpers lazily load jobs.ps1, which overrides the job
 * cmdlets with implementations backed by real detached OS processes
 * (file-based registry in %TEMP%\pi-pwsh-jobs). A trailing ` &` is rewritten
 * to Start-Job via PowerShell's own parser (background.ts), so bash-style
 * `npm run dev &` works as expected.
 *
 * Interactive processes: session-scoped node-pty/ConPTY sessions and user UI
 * requests are exposed as lazily loaded PowerShell functions over a private
 * named-pipe RPC bridge, keeping `pwsh` as the extension's only model tool.
 *
 * Requires PowerShell 7+ (`pwsh` on PATH). No fallback: if pwsh is missing the
 * extension reports an error and leaves the built-in bash tool untouched.
 */

import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
	createBashToolDefinition,
	type BashOperations,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createRuntimeEnv, spawnAndStream, EXIT_EPILOGUE, UTF8_PREFIX } from "./spawn.ts";
import { rewriteBackgroundOperator } from "./background.ts";
import { PwshSessionRuntime } from "./session-runtime.ts";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const JOBS_PATH = join(SOURCE_DIR, "jobs.ps1");
const PTY_PATH = join(SOURCE_DIR, "powershell", "pty.ps1");
const USER_REQUEST_PATH = join(SOURCE_DIR, "powershell", "user-request.ps1");

const JOB_HELPER_PATTERN = /\b(?:Start-Job|Get-Job|Receive-Job|Wait-Job|Stop-Job|Remove-Job|Suspend-Job|Resume-Job|Debug-Job|Get-JobHelp)\b/i;
const PTY_HELPER_PATTERN = /\b(?:Start-Pty|Get-Pty(?:Screen|Help)?|Receive-Pty|Send-PtyInput|Wait-Pty|Resize-Pty|Stop-Pty|Remove-Pty)\b/i;
const USER_REQUEST_PATTERN = /\b(?:Request-Pi(?:Input|Confirmation|Selection|PtyInput)|Get-PiRequestHelp)\b/i;

/** Single-quote a string for embedding in PowerShell source. */
function psQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** npm/yarn/pnpm etc. are .cmd batch files on Windows; pwsh cannot spawn them directly. */
function isBatchFileSpawnError(stderrText: string): boolean {
	return (
		stderrText.includes("is not a valid Win32 application") ||
		stderrText.includes("no es una aplicación Win32 válida") ||
		stderrText.includes("cannot run due to the error")
	);
}

function helperPrelude(command: string, backgroundRewritten: boolean): { source: string; needsRpc: boolean } {
	const paths: string[] = [];
	if (backgroundRewritten || JOB_HELPER_PATTERN.test(command)) paths.push(JOBS_PATH);
	if (PTY_HELPER_PATTERN.test(command)) paths.push(PTY_PATH);
	if (USER_REQUEST_PATTERN.test(command)) paths.push(USER_REQUEST_PATH);
	return {
		source: paths.map((path) => `. ${psQuote(path)}; `).join(""),
		needsRpc: paths.includes(PTY_PATH) || paths.includes(USER_REQUEST_PATH),
	};
}

function createPwshOperations(runtime: PwshSessionRuntime): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			// bash-style `cmd &` → Start-Job (detached), via the PowerShell parser.
			const rewritten = await rewriteBackgroundOperator(command, cwd, options.signal);
			// Helper families are loaded only when their literal command names are
			// referenced. Ordinary commands therefore avoid parsing and initializing
			// the large job/PTY prelude on every fresh pwsh process.
			const helper = helperPrelude(rewritten, rewritten !== command);
			const injected = `${UTF8_PREFIX}${helper.source}${rewritten}${EXIT_EPILOGUE}`;
			const pwshArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", injected];
			// PIPWSH_NODE lets the job prelude launch via a fast Node helper. RPC
			// credentials are exposed only to calls that load an interactive helper;
			// rpc.ps1 captures and removes them before the user command runs.
			const env = createRuntimeEnv({
				PIPWSH_NODE: process.execPath,
				...(helper.needsRpc ? runtime.env : {}),
			});
			const first = await spawnAndStream("pwsh", pwshArgs, cwd, { ...options, env });

			// Fallback for "not a valid Win32 application" (npm/yarn/pnpm are .cmd
			// batch files on Windows). Skipped for rewritten background commands and
			// helper calls, whose semantics cannot be reproduced by cmd.exe.
			if (
				first.exitCode !== 0 &&
				rewritten === command &&
				!helper.source &&
				isBatchFileSpawnError(first.stderrText) &&
				!options.signal?.aborted
			) {
				options.onData(Buffer.from("\n[pi-pwsh] direct spawn failed; retrying via cmd /c.\n"));
				const retry = await spawnAndStream(
					"cmd",
					["/d", "/s", "/c", `chcp 65001>nul & ${command}`],
					cwd,
					{ ...options, env },
				);
				return { exitCode: retry.exitCode };
			}
			return { exitCode: first.exitCode };
		},
	};
}

/** Check that pwsh (PowerShell 7+) is available. */
function detectPwsh(): Promise<{ ok: boolean; version?: string; executable?: string }> {
	return new Promise((resolve) => {
		let out = "";
		const child = spawn(
			"pwsh",
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::WriteLine($PSVersionTable.PSVersion.ToString()); [Console]::WriteLine((Join-Path $PSHOME 'pwsh.exe'))"],
			{ stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
		);
		child.stdout?.on("data", (d: Buffer) => {
			out += d.toString("utf-8");
		});
		child.on("error", () => resolve({ ok: false }));
		child.on("close", (code) => {
			const [version = "", executable = ""] = out.trim().split(/\r?\n/, 2);
			const major = Number.parseInt(version.split(".")[0] ?? "", 10);
			resolve(code === 0 && major >= 7 && executable ? { ok: true, version, executable } : { ok: false });
		});
	});
}

/** Check that Windows Sudo is available and runs inline (stdio comes back to us). */
function detectSudo(): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("sudo", ["config"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		let out = "";
		child.stdout?.on("data", (d: Buffer) => {
			out += d.toString("utf-8");
		});
		child.on("error", () => resolve(false));
		child.on("close", (code) => {
			resolve(code === 0 && /inline|内联/i.test(out));
		});
	});
}

const DESCRIPTION = `Execute a PowerShell 7 (pwsh) command on Windows in the current working directory. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB (whichever is hit first); if truncated, full output is saved to a temp file. For completeness and accuracy, prefer filtering and truncating the output yourself. Optionally provide a timeout in seconds (no default timeout).

QUOTING: PowerShell quoting differs from bash. Single quotes are literal strings (escape with ''). Double quotes allow variable expansion. Backtick (\`) is the escape character, not backslash.

ENVIRONMENT VARIABLES: Use PowerShell syntax: $env:NODE_ENV = 'production'; npm start (NOT bash-style NODE_ENV=production npm start).

GET-CHILDITEM / SELECT-STRING: Recursive searches built from these cmdlets do not honor .gitignore or automatically prune heavy directories. Keep the path, depth, and output limits tight; never recursively scan any location that should not be searched.

BACKGROUND JOBS: Never run long-lived commands (dev servers, watchers, builds) in the foreground — they block your work. Run them as detached background jobs instead: append \` &\` (\`npm run dev &\`) or use Start-Job (\`Start-Job -ScriptBlock { npm run dev } -Name dev\`). Note: the standard PowerShell job cmdlets (Start-Job, Get-Job, etc.) are overridden — jobs run as detached processes that survive across pwsh calls (and /reload); do not assume native PowerShell job semantics. Manage them with Get-Job / Receive-Job / Stop-Job / Remove-Job / Wait-Job (pipeline support, e.g. \`Get-Job | Stop-Job\`). Jobs don't share variables with your pwsh call. Run Get-JobHelp for usage and examples.

PTY SESSIONS: PowerShell helper functions manage persistent interactive processes across pwsh calls; invoke them through pwsh and run Get-PtyHelp for commands, lifecycle, and examples. USER REQUESTS: PowerShell helper functions can request input, confirmation, selection, or secret PTY input from the user; invoke them through pwsh and run Get-PiRequestHelp for details.`;

const ELEVATION_SECTION = `\n\nELEVATION: \`sudo\` is available. Prefix a command with \`sudo\` to run it as administrator (e.g. \`sudo <command>\`); a UAC prompt will appear and wait for the user to approve.`;

export default function (pi: ExtensionAPI) {
	let runtime: PwshSessionRuntime | undefined;

	pi.on("session_shutdown", async () => {
		const current = runtime;
		runtime = undefined;
		await current?.close();
	});

	pi.on("session_start", async (_event, ctx) => {
		// Probe pwsh and sudo concurrently once per session; the tool description
		// is then stable for the rest of that session.
		const [detection, sudoAvailable] = await Promise.all([detectPwsh(), detectSudo()]);
		if (!detection.ok || !detection.executable) {
			ctx.ui.notify(
				"pi-pwsh: `pwsh` (PowerShell 7+) was not found on PATH. Install PowerShell 7 (https://github.com/PowerShell/PowerShell) or disable this extension. The built-in bash tool was left active.",
				"error",
			);
			return;
		}

		await runtime?.close();
		const nextRuntime = new PwshSessionRuntime(ctx, detection.executable);
		try {
			await nextRuntime.start();
		} catch (error) {
			ctx.ui.notify(`pi-pwsh: interactive service startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		runtime = nextRuntime;

		// Reuse the built-in bash tool definition (truncation, temp files, exit-code
		// errors, streaming, renderer) with only the spawn layer swapped to pwsh.
		const bashDef = createBashToolDefinition(ctx.cwd, { operations: createPwshOperations(nextRuntime) });
		pi.registerTool({
			...bashDef,
			name: "pwsh",
			label: "pwsh",
			description: DESCRIPTION + (sudoAvailable ? ELEVATION_SECTION : ""),
			promptSnippet: "Execute PowerShell 7 (pwsh) commands",
			promptGuidelines: [
				"Use pwsh for shell tasks, both foreground and background; write PowerShell syntax; prefer modern cross-platform tools (rg, fd, etc.) when available, otherwise use native PowerShell cmdlets with tightly bounded scope, and avoid Unix-only commands.",
			],
		});

		const active = pi.getActiveTools();
		const disabled = new Set(["bash", "ls", "find", "grep", "pwsh"]);
		pi.setActiveTools([...active.filter((name) => !disabled.has(name)), "pwsh"]);
	});
}
