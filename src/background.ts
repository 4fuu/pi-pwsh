/**
 * Detect PowerShell's background operator so the one-shot pwsh tool can reject
 * it with guidance to use the durable Start-Job override. It is intentionally
 * never rewritten: background work must be explicit.
 *
 * Detection uses PowerShell's own parser so strings, comments, the call
 * operator `& { }`, and `&&` are never mistaken for background execution.
 * A cheap JS pre-filter skips the parser round-trip for commands without `&`.
 */

import { spawnAndStream } from "./spawn.ts";

/** A standalone ampersand candidate, excluding `&&`; the parser decides its role. */
function isCandidate(command: string): boolean {
	return /(?<!&)&(?!&)/.test(command);
}

/**
 * PowerShell probe: parse the base64 UTF-8 command received on stdin and report
 * whether it contains a background pipeline.
 */
const PROBE = `
$code = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$tokens, [ref]$errors)
if ($errors.Count -eq 0) {
	$background = $ast.FindAll({
		param($node)
		$node -is [System.Management.Automation.Language.PipelineBaseAst] -and $node.Background
	}, $true)
	if ($background.Count -gt 0) { [Console]::WriteLine('background'); exit 0 }
}
[Console]::WriteLine('normal')
`;

/**
 * Return whether the command uses PowerShell background execution. Detection
 * failures are treated as unsupported for ampersand candidates so they cannot
 * silently fall back to short-lived native jobs.
 */
export async function hasUnsupportedBackgroundOperator(command: string, cwd: string, signal?: AbortSignal): Promise<boolean> {
	return hasUnsupportedBackgroundOperatorWithRuntime(command, cwd, "pwsh", signal);
}

/** Same detection using an already validated absolute PowerShell executable. */
export async function hasUnsupportedBackgroundOperatorWithRuntime(
	command: string,
	cwd: string,
	pwshExecutable: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!isCandidate(command)) return false;

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
				stdin: Buffer.from(command, "utf-8").toString("base64"),
			},
		);
		if (r.exitCode !== 0) return !signal?.aborted;
	} catch {
		return !signal?.aborted;
	}

	return /^background\s*$/m.test(out);
}
