// Smoke test for the runtime baseline in src/spawn.ts.
// Run: node scripts/smoke-runtime.mjs   (Node >= 22.6, type stripping)
import { spawnSync } from "node:child_process";
import { createRuntimeEnv, EXIT_EPILOGUE, UTF8_PREFIX } from "../src/spawn.ts";

const PYTHON_DEFAULTS = {
	PYTHONIOENCODING: "utf-8",
	PYTHONUTF8: "1",
	PYTHONUNBUFFERED: "1",
};

function withoutEnvKeys(env, names) {
	const blocked = new Set(names.map((name) => name.toUpperCase()));
	return Object.fromEntries(Object.entries(env).filter(([name]) => !blocked.has(name.toUpperCase())));
}

function getEnv(env, name) {
	const match = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
	return match === undefined ? undefined : env[match];
}

function run(command, env) {
	return spawnSync(
		"pwsh",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `${UTF8_PREFIX}${command}${EXIT_EPILOGUE}`],
		{ encoding: "utf8", env },
	);
}

let pass = 0;
let fail = 0;
function check(label, condition, detail = "") {
	if (condition) {
		pass++;
		console.log(`PASS [${label}]`);
	} else {
		fail++;
		console.log(`FAIL [${label}] ${detail}`);
	}
}

const cleanBase = withoutEnvKeys(process.env, Object.keys(PYTHON_DEFAULTS));
const runtimeEnv = createRuntimeEnv({}, cleanBase);
for (const [name, expected] of Object.entries(PYTHON_DEFAULTS)) {
	check(`default-${name.toLowerCase()}`, getEnv(runtimeEnv, name) === expected, `got ${getEnv(runtimeEnv, name)}`);
}

const explicitEnv = createRuntimeEnv({}, { ...cleanBase, PYTHONUTF8: "0" });
check("preserve-explicit-python-env", getEnv(explicitEnv, "PYTHONUTF8") === "0");

const envResult = run(
	`node -e "console.log([process.env.PYTHONIOENCODING, process.env.PYTHONUTF8, process.env.PYTHONUNBUFFERED].join('|'))"`,
	runtimeEnv,
);
check(
	"runtime-env-reaches-native-child",
	envResult.status === 0 && envResult.stdout.trim() === "utf-8|1|1",
	`${envResult.stdout}${envResult.stderr}`.trim(),
);

const stdinResult = run(
	`'中文' | node -e "const chunks=[]; process.stdin.on('data',d=>chunks.push(d)); process.stdin.on('end',()=>console.log(Buffer.concat(chunks).toString('hex')))"`,
	runtimeEnv,
);
const stdinHex = stdinResult.stdout.trim();
check(
	"native-stdin-utf8-without-bom",
	stdinResult.status === 0 && stdinHex.startsWith("e4b8ad") && !stdinHex.startsWith("efbbbf"),
	stdinHex || stdinResult.stderr.trim(),
);

const errorResult = run("Write-Error 'plain-error'", runtimeEnv);
const errorOutput = `${errorResult.stdout}${errorResult.stderr}`;
check(
	"powershell-errors-are-plain-text",
	errorResult.status === 1 && errorOutput.includes("plain-error") && !errorOutput.includes("\u001b["),
	JSON.stringify(errorOutput),
);

const pythonProbe = spawnSync("python", ["--version"], { encoding: "utf8", env: runtimeEnv });
if (!pythonProbe.error && pythonProbe.status === 0) {
	const pythonResult = run(
		`python -c "import sys; print(sys.stdout.encoding); print(sys.flags.utf8_mode); print(int(sys.stdout.write_through)); print('中文 ✓')"`,
		runtimeEnv,
	);
	const output = pythonResult.stdout.trim();
	check(
		"python-utf8-and-unbuffered",
		pythonResult.status === 0 && /^utf-8\r?\n1\r?\n1\r?\n中文 ✓$/i.test(output),
		`${pythonResult.stdout}${pythonResult.stderr}`.trim(),
	);
} else {
	console.log("SKIP [python-utf8-and-unbuffered] python not available");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
