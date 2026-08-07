// Smoke test for src/background.ts — reject native background execution.
// Run: node scripts/smoke-background.mjs   (Node >= 22.6, type stripping)
import { hasUnsupportedBackgroundOperator } from "../src/background.ts";

const longHarmlessAmpersand = `Write-Output '${"x".repeat(45_000)} & text'`;
const cases = [
	// [input, expectUnsupported, optional display name]
	["npm run dev &", true],
	["npm run dev &   # background it", true],
	["1..3 | ForEach-Object { Start-Sleep 1; $_ } &", true],
	['Write-Output "a & b"', false],           // & inside a string
	["Write-Output 'x' # note &", false],      // & inside a comment
	["Get-Date & Get-Process", true],          // background pipeline in a statement list
	["& { Get-Process }", false],              // call operator
	["cmd1 && cmd2", false],                   // && is not the background operator
	["npm run dev && npm test &", true],       // background pipeline chain
	["Get-Process", false],                    // no & at all
	["&", false],                              // invalid syntax, but not background execution
	[longHarmlessAmpersand, false, "long harmless ampersand in a string"],
];

let pass = 0, fail = 0;
for (const [input, expectUnsupported, display = input] of cases) {
	const unsupported = await hasUnsupportedBackgroundOperator(input, process.cwd());
	if (unsupported === expectUnsupported) { pass++; console.log(`PASS [${display}] unsupported=${unsupported}`); }
	else { fail++; console.log(`FAIL [${display}] expectUnsupported=${expectUnsupported} got: ${unsupported}`); }
}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
