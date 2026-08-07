import { spawnSync } from "node:child_process";
import { SOURCE_BOOTSTRAP, UTF8_PREFIX, wrapPowerShellCommand } from "../src/spawn.ts";

const longValue = "x".repeat(45_000);
const cases = [
	["unicode-multiline", `$value = '中文 ✓'\nWrite-Output $value`, (output) => output.trim() === "中文 ✓"],
	["quotes-and-comment", `Write-Output 'single '' quote' # trailing comment`, (output) => output.trim() === "single ' quote"],
	["long-source", `$value = '${longValue}'\nWrite-Output $value.Length`, (output) => output.trim() === "45000"],
	[
		"selected-object-is-formatted",
		`[pscustomobject]@{Name='x';State='y'} | Select-Object Name, State`,
		(output) => /Name\s+State[\s\S]*x\s+y/.test(output),
	],
	[
		"mixed-text-and-object-output",
		`Write-Output 'before'; [pscustomobject]@{Name='x';State='y'} | Select-Object Name, State; Write-Output 'after'`,
		(output) => output.includes("before") && /x\s+y/.test(output) && output.includes("after"),
	],
	[
		"return-keeps-prior-output",
		`Write-Output 'before-return'; return; Write-Output 'after-return'`,
		(output) => output.includes("before-return") && !output.includes("after-return"),
	],
];

let passed = 0;
let failed = 0;
for (const [name, command, validate] of cases) {
	const source = `${UTF8_PREFIX}$global:LASTEXITCODE = $null; ${wrapPowerShellCommand(command)}`;
	const result = spawnSync(
		"pwsh",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SOURCE_BOOTSTRAP],
		{ input: Buffer.from(source, "utf8").toString("base64"), encoding: "utf8", maxBuffer: 1024 * 1024 },
	);
	const ok = result.status === 0 && validate(result.stdout);
	console.log(`${ok ? "PASS" : "FAIL"} [${name}]`);
	if (ok) passed++;
	else {
		failed++;
		console.log(`  exit=${result.status} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
	}
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
