/**
 * pi-pwsh — Replace pi's built-in `bash` tool with PowerShell 7 (`pwsh`),
 * including background jobs that actually survive across tool calls.
 *
 * Why: Windows has no reliable bash. A tool named "bash" also primes the model
 * to emit POSIX syntax. This extension disables `bash` and registers a `pwsh`
 * tool that reuses pi's built-in bash tool definition (tail truncation, temp
 * files for full output, non-zero exit codes as tool errors, streaming preview,
 * built-in renderer) with only the spawn layer swapped to pwsh.
 *
 * Background jobs: every pwsh call is a fresh pwsh process, so native
 * PowerShell jobs (Start-Job, trailing `&`) die when the call ends. Each call
 * dot-sources prelude.ps1, which overrides the job cmdlets (Start-Job, Get-Job,
 * Receive-Job, Stop-Job, Remove-Job, Wait-Job) with implementations backed by
 * real detached OS processes (file-based registry in %TEMP%\pi-pwsh-jobs).
 * A trailing ` &` is rewritten to Start-Job via PowerShell's own parser
 * (background.ts), so bash-style `npm run dev &` works as expected.
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
import { spawnAndStream, UTF8_PREFIX } from "./spawn.ts";
import { rewriteBackgroundOperator } from "./background.ts";

const PRELUDE_PATH = join(dirname(fileURLToPath(import.meta.url)), "prelude.ps1");

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

function createPwshOperations(): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			// bash-style `cmd &` → Start-Job (detached), via the PowerShell parser.
			const rewritten = await rewriteBackgroundOperator(command, cwd, options.signal);
			// Dot-source the prelude (job cmdlet overrides), then the command.
			const injected = `. ${psQuote(PRELUDE_PATH)}; ${UTF8_PREFIX}${rewritten}`;
			const pwshArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", injected];
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

BACKGROUND JOBS: Never run long-lived commands (dev servers, watchers, builds) in the foreground — they block your work. Run them as detached background jobs instead: append \` &\` (\`npm run dev &\`) or use Start-Job (\`Start-Job -ScriptBlock { npm run dev } -Name dev\`). Jobs are real OS processes that persist across pwsh calls. Manage them with Get-Job / Receive-Job / Stop-Job / Remove-Job / Wait-Job (pipeline support, e.g. \`Get-Job | Stop-Job\`). Jobs don't share variables with your pwsh call. Run Get-JobHelp for usage and examples.`;

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
			promptSnippet: "Execute PowerShell 7 (pwsh) commands; supports detached background jobs (Start-Job / trailing &)",
			promptGuidelines: [
				"For long-running commands (dev servers, watchers, builds), run them as pwsh background jobs — append ` &` or use Start-Job — instead of in the pwsh foreground; poll with Get-Job/Receive-Job and stop with Stop-Job.",
				"Use pwsh for file operations and shell tasks; write PowerShell syntax, not bash/POSIX syntax.",
				"Unix tools (grep, find, sed, awk, etc.) are not available on Windows. Prefer modern cross-platform alternatives when installed (e.g. rg instead of grep, fd instead of find); otherwise use native PowerShell cmdlets (e.g. Select-String, Get-ChildItem).",
			],
		});

		const active = pi.getActiveTools();
		pi.setActiveTools([...active.filter((name) => name !== "bash" && name !== "pwsh"), "pwsh"]);
	});
}
