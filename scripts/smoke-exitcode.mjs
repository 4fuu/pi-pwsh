// Smoke test for the foreground exit-code epilogue (src/spawn.ts).
// `pwsh -Command` flattens native exit codes to 0/1 unless the script ends
// with an explicit `exit`; the wrapper must restore the real codes after
// draining PowerShell's object formatter.
// Run: npx tsx scripts/smoke-exitcode.mjs
import { spawnSync } from "node:child_process";
import { UTF8_PREFIX, wrapPowerShellCommand } from "../src/spawn.ts";

if (spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"]).error?.code === "ENOENT") {
	console.log("SKIP [PowerShell exit-code e2e] pwsh is not installed"); process.exit(0);
}

const cases = [
	// [command, expectedExit]
	["cmd /c exit 3", 3], // real native exit code survives
	["exit 7", 7], // explicit exit bypasses the epilogue entirely
	["Get-Date | Out-Null", 0], // cmdlet success
	["Write-Output 'x'", 0], // cmdlet success with output
	["Get-Item C:\\definitely-missing-pipwsh", 1], // cmdlet failure, no native call
	["cmd /c exit 0", 0], // native success
	["cmd /c exit 9; Get-Date | Out-Null", 0], // final success beats stale native failure
	["cmd /c exit 0; Get-Item C:\\definitely-missing-pipwsh", 1], // final cmdlet failure beats native success
	["Get-ChildItem `", 0], // trailing backtick (line continuation): epilogue must not glue into the command
];

let pass = 0,
	fail = 0;
for (const [cmd, expected] of cases) {
	const r = spawnSync(
		"pwsh",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `${UTF8_PREFIX}${wrapPowerShellCommand(cmd)}`],
		{ stdio: "ignore" },
	);
	const ok = r.status === expected;
	if (ok) pass++;
	else fail++;
	console.log(`${ok ? "PASS" : "FAIL"} [${cmd}] -> ${r.status} (expected ${expected})`);
}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
