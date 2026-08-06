import { spawnSync } from "node:child_process";
import { EXIT_EPILOGUE, SOURCE_BOOTSTRAP, UTF8_PREFIX } from "../src/spawn.ts";

const longValue = "x".repeat(45_000);
const cases = [
	["unicode-multiline", `$value = '中文 ✓'\nWrite-Output $value`, "中文 ✓"],
	["quotes-and-comment", `Write-Output 'single '' quote' # trailing comment`, "single ' quote"],
	["long-source", `$value = '${longValue}'\nWrite-Output $value.Length`, "45000"],
];

let passed = 0;
let failed = 0;
for (const [name, command, expected] of cases) {
	const source = `${UTF8_PREFIX}$global:LASTEXITCODE = $null; ${command}${EXIT_EPILOGUE}`;
	const result = spawnSync(
		"pwsh",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SOURCE_BOOTSTRAP],
		{ input: Buffer.from(source, "utf8").toString("base64"), encoding: "utf8", maxBuffer: 1024 * 1024 },
	);
	const ok = result.status === 0 && result.stdout.trim() === expected;
	console.log(`${ok ? "PASS" : "FAIL"} [${name}]`);
	if (ok) passed++;
	else {
		failed++;
		console.log(`  exit=${result.status} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
	}
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
