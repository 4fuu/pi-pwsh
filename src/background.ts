/**
 * Intercept the PowerShell background operator: `some-command &`.
 *
 * In PowerShell 7, a trailing `&` creates a ThreadJob inside the current pwsh
 * process — which dies when the one-shot tool call ends, so it is useless
 * here. Models also type `&` out of bash habit, where it means "run detached".
 * Both intents are served by rewriting a trailing background `&` to a call to
 * the prelude's Start-Job override (real detached OS process).
 *
 * Detection uses PowerShell's own parser
 * ([System.Management.Automation.Language.Parser]) so strings, comments, the
 * call operator `& { }`, and `&&` are never mistaken for the background
 * operator. Only a single top-level pipeline ending with `&` is rewritten;
 * anything else runs as-is (fail-open).
 *
 * Cost: a cheap JS pre-filter skips the parser round-trip for ~all commands.
 */

import { spawnAndStream } from "./spawn.ts";

/** Trailing `&` (optionally followed by whitespace/one line comment), but not `&&`. */
function isCandidate(command: string): boolean {
	return /&(\s|#[^\r\n]*)*$/.test(command) && !/&&(\s|#[^\r\n]*)*$/.test(command);
}

/**
 * PowerShell probe: parse the command passed via the PIPWSH_PROBE env var
 * (base64 UTF-8) and report whether it is a single background pipeline.
 * Prints `background:<offset>` (start offset of the `&` token) or `normal`.
 */
const PROBE = `
$code = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PIPWSH_PROBE))
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$tokens, [ref]$errors)
$s = $ast.EndBlock.Statements
if ($errors.Count -eq 0 -and $s.Count -eq 1 -and $s[0] -is [System.Management.Automation.Language.PipelineAst] -and $s[0].Background) {
	$amp = $tokens | Where-Object { $_.Kind -eq [System.Management.Automation.Language.TokenKind]::Ampersand } | Select-Object -Last 1
	if ($amp) { [Console]::WriteLine("background:" + $amp.Extent.StartOffset); exit 0 }
}
[Console]::WriteLine('normal')
`;

/**
 * Rewrite `cmd &` to `Start-Job -ScriptBlock { cmd }` when the whole command is
 * a single pipeline with the background operator. Returns the input unchanged
 * otherwise (and on any detection failure).
 */
export async function rewriteBackgroundOperator(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
	return rewriteBackgroundOperatorWithRuntime(command, cwd, "pwsh", signal);
}

/** Same rewrite using an already validated absolute PowerShell executable. */
export async function rewriteBackgroundOperatorWithRuntime(
	command: string,
	cwd: string,
	pwshExecutable: string,
	signal?: AbortSignal,
): Promise<string> {
	if (!isCandidate(command)) return command;

	let out = "";
	try {
		const r = await spawnAndStream(
			pwshExecutable,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PROBE],
			cwd,
			{
				onData: (d) => (out += d.toString("utf-8")),
				signal,
				timeout: 15,
				env: { ...process.env, PIPWSH_PROBE: Buffer.from(command, "utf-8").toString("base64") },
			},
		);
		if (r.exitCode !== 0) return command;
	} catch {
		return command; // fail-open: run as-is
	}

	const m = out.match(/background:(\d+)/);
	if (!m) return command;
	const head = command.slice(0, Number(m[1])).trim();
	if (!head) return command;
	return `Start-Job -ScriptBlock { ${head} }`;
}
