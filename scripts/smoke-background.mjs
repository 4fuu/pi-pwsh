// Smoke test for src/background.ts — the trailing-& interception.
// Run: node scripts/smoke-background.mjs   (Node >= 22.6, type stripping)
import { rewriteBackgroundOperator } from "../src/background.ts";

const cases = [
	// [input, expectRewrite]
	["npm run dev &", true],
	["npm run dev &   # background it", true],
	["1..3 | ForEach-Object { Start-Sleep 1; $_ } &", true],
	['Write-Output "a & b"', false],           // & inside a string
	["Write-Output 'x' # note &", false],      // & inside a comment
	["Get-Date & Get-Process", false],         // multi-statement: not intercepted (v1)
	["& { Get-Process }", false],              // call operator
	["cmd1 && cmd2", false],                   // && is not the background operator
	["npm run dev && npm test &", false],      // pipeline chain: not intercepted (v1)
	["Get-Process", false],                    // no & at all
	["&", false],                              // nothing before &
];

let pass = 0, fail = 0;
for (const [input, expectRewrite] of cases) {
	const out = await rewriteBackgroundOperator(input, process.cwd());
	const wasRewritten = out !== input;
	const ok = wasRewritten === expectRewrite && (!wasRewritten || /^Start-Job -ScriptBlock \{ .+ \}$/.test(out));
	if (ok) { pass++; console.log(`PASS [${input}]${wasRewritten ? ` -> ${out}` : ""}`); }
	else { fail++; console.log(`FAIL [${input}] expectRewrite=${expectRewrite} got: ${out}`); }
}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
