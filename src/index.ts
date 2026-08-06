/**
 * pi-pwsh — Route pi's shell tasks through PowerShell 7 (`pwsh`), including
 * background jobs that survive tool calls.
 *
 * Why: Windows has no reliable bash. A tool named "bash" also primes the model
 * to emit POSIX syntax. This extension replaces `bash` with a `pwsh` tool that
 * reuses pi's built-in bash tool definition
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
	getAgentDir,
	type BashOperations,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createRuntimeEnv, spawnAndStream, EXIT_EPILOGUE, SOURCE_BOOTSTRAP, UTF8_PREFIX } from "./spawn.ts";
import { rewriteBackgroundOperatorWithRuntime } from "./background.ts";
import { loadConfig, type PwshConfig } from "./config.ts";
import { registerJobNotificationRenderer } from "./job-notifications.ts";
import { resolvePowerShellRuntime, userPowerShellArguments } from "./runtime.ts";
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

function helperPrelude(command: string, backgroundRewritten: boolean): { source: string; needsJobs: boolean; needsRpc: boolean } {
	const paths: string[] = [];
	if (backgroundRewritten || JOB_HELPER_PATTERN.test(command)) paths.push(JOBS_PATH);
	if (PTY_HELPER_PATTERN.test(command)) paths.push(PTY_PATH);
	if (USER_REQUEST_PATTERN.test(command)) paths.push(USER_REQUEST_PATH);
	return {
		source: paths.map((path) => `. ${psQuote(path)}; `).join(""),
		needsJobs: paths.includes(JOBS_PATH),
		needsRpc: paths.includes(PTY_PATH) || paths.includes(USER_REQUEST_PATH),
	};
}

function createPwshOperations(runtime: PwshSessionRuntime): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			// bash-style `cmd &` → Start-Job (detached), via the PowerShell parser.
			const rewritten = await rewriteBackgroundOperatorWithRuntime(command, cwd, runtime.pwsh.executable, options.signal);
			// Helper families are loaded only when their literal command names are
			// referenced. Ordinary commands therefore avoid parsing and initializing
			// the large job/PTY prelude on every fresh pwsh process.
			const helper = helperPrelude(rewritten, rewritten !== command);
			const strict = runtime.pwsh.stopOnError ? "$ErrorActionPreference = 'Stop'; " : "";
			const injected = `${UTF8_PREFIX}${helper.source}${strict}$global:LASTEXITCODE = $null; ${rewritten}${EXIT_EPILOGUE}`;
			const pwshArgs = [
				...userPowerShellArguments(runtime.pwsh, { nonInteractive: true }),
				"-Command",
				SOURCE_BOOTSTRAP,
			];
			// PIPWSH_NODE lets the job prelude launch via a fast Node helper. RPC
			// credentials are exposed only to calls that load an interactive helper;
			// rpc.ps1 captures and removes them before the user command runs.
			const env = createRuntimeEnv({
				...(helper.needsJobs ? runtime.jobEnv : {}),
				...(helper.needsRpc ? runtime.env : {}),
			}, options.env ?? process.env, runtime.pwsh);
			const first = await spawnAndStream(runtime.pwsh.executable, pwshArgs, cwd, {
				...options,
				env,
				stdin: Buffer.from(injected, "utf8").toString("base64"),
			});

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

export const DESCRIPTION = `Execute a PowerShell 7 (pwsh) command on Windows in the current working directory. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB (whichever is hit first); if truncated, full output is saved to a temp file. For completeness and accuracy, prefer filtering and truncating the output yourself. Optionally provide a timeout in seconds (no default timeout).

QUOTING: PowerShell quoting differs from bash. Single quotes are literal strings (escape with ''). Double quotes allow variable expansion. Backtick (\`) is the escape character, not backslash.

ENVIRONMENT VARIABLES: Use PowerShell syntax: $env:NODE_ENV = 'production'; npm start (NOT bash-style NODE_ENV=production npm start).

GET-CHILDITEM / SELECT-STRING: Recursive searches built from these cmdlets do not honor .gitignore or automatically prune heavy directories. Keep the path, depth, and output limits tight; never recursively scan any location that should not be searched.

BACKGROUND JOBS: Run long-lived commands as detached jobs: append \` &\` (\`npm run dev &\`) or use \`Start-Job -ScriptBlock { npm run dev } -Name dev\`. Jobs survive later pwsh calls and /reload, and completion is reported automatically. For a long-running server, pass \`-NotifyOn '<ready text>'\` to report its first matching output. Continue other work while jobs run; use Wait-Job only when the next step requires a result. Manage jobs with Get-Job / Receive-Job / Stop-Job / Remove-Job / Wait-Job, and run Get-JobHelp for the full reference.

PTY SESSIONS: Use Start-Pty and the related PowerShell functions for interactive processes that must persist across pwsh calls. Run Get-PtyHelp for commands, lifecycle, and examples.

USER REQUESTS: Use Request-PiInput, Request-PiConfirmation, Request-PiSelection, or Request-PiPtyInput when a command needs user input. Run Get-PiRequestHelp for details.`;

const ELEVATION_SECTION = `\n\nELEVATION: \`sudo\` is available. Prefix a command with \`sudo\` to run it as administrator (e.g. \`sudo <command>\`); a UAC prompt will appear and wait for the user to approve.`;

export default function (pi: ExtensionAPI) {
	let runtime: PwshSessionRuntime | undefined;
	let operations: BashOperations | undefined;
	let config: PwshConfig | undefined;
	let setupError: string | undefined;
	try {
		config = loadConfig({ agentDir: getAgentDir() }).config;
	} catch (error) {
		setupError = error instanceof Error ? error.message : String(error);
	}

	registerJobNotificationRenderer(pi);
	if (config?.replaceUserBash) {
		pi.on("user_bash", () => operations ? { operations } : undefined);
	}

	pi.on("session_shutdown", async () => {
		const current = runtime;
		operations = undefined;
		runtime = undefined;
		await current?.close();
	});

	pi.on("session_start", async (_event, ctx) => {
		operations = undefined;
		const current = runtime;
		runtime = undefined;
		await current?.close();
		if (setupError || !config) {
			activateBuiltInBash(pi);
			ctx.ui.notify(`pi-pwsh: ${setupError ?? "configuration could not be loaded"} The built-in bash tool was left active.`, "error");
			return;
		}
		// Probe pwsh and sudo concurrently once per session; the tool description
		// is then stable for the rest of that session.
		let detection;
		let sudoAvailable: boolean;
		try {
			[detection, sudoAvailable] = await Promise.all([resolvePowerShellRuntime(config), detectSudo()]);
		} catch (error) {
			activateBuiltInBash(pi);
			ctx.ui.notify(
				`pi-pwsh: ${error instanceof Error ? error.message : String(error)} The built-in bash tool was left active.`,
				"error",
			);
			return;
		}

		const nextRuntime = new PwshSessionRuntime(pi, ctx, detection);
		try {
			await nextRuntime.notifications.start();
		} catch (error) {
			ctx.ui.notify(`pi-pwsh: job notification startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		try {
			await nextRuntime.rpc.start();
		} catch (error) {
			ctx.ui.notify(`pi-pwsh: interactive service startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		runtime = nextRuntime;
		operations = createPwshOperations(nextRuntime);

		// Reuse the built-in bash tool definition (truncation, temp files, exit-code
		// errors, streaming, renderer) with only the spawn layer swapped to pwsh.
		const bashDef = createBashToolDefinition(ctx.cwd, { operations });
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

		activatePwsh(pi);
	});
}

function activatePwsh(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	const replaced = new Set(["bash", "pwsh"]);
	pi.setActiveTools([...active.filter((name) => !replaced.has(name)), "pwsh"]);
}

function activateBuiltInBash(pi: ExtensionAPI): void {
	const active = pi.getActiveTools().filter((name) => name !== "pwsh");
	if (!active.includes("bash")) active.push("bash");
	pi.setActiveTools(active);
}
