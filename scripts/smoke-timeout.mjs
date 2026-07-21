// Smoke tests for timeout/abort settlement and inherited stdio handling in src/spawn.ts.
// Run: node scripts/smoke-timeout.mjs   (Node >= 22.6, type stripping)
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { spawnAndStream } from "../src/spawn.ts";

if (process.platform !== "win32") {
	console.log("SKIP [spawn-timeout] Windows-only process-tree semantics");
	process.exit(0);
}

const cwd = fileURLToPath(new URL("..", import.meta.url));
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

function extractPid(output, name) {
	const match = output.match(new RegExp(`${name}=(\\d+)`));
	return match ? Number(match[1]) : undefined;
}

function stopProcess(pid) {
	if (!pid) return;
	spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
		stdio: "ignore",
		windowsHide: true,
	});
}

async function runNode(code, timeout, signal) {
	let output = "";
	const startedAt = performance.now();
	try {
		const result = await spawnAndStream(process.execPath, ["-e", code], cwd, {
			onData: (data) => {
				output += data.toString("utf8");
			},
			signal,
			timeout,
		});
		return { result, output, elapsedMs: performance.now() - startedAt };
	} catch (error) {
		return { error, output, elapsedMs: performance.now() - startedAt };
	}
}

function inheritedChild(parentOutput, childCode) {
	return `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], {
	detached: true,
	stdio: ["ignore", "inherit", "inherit"],
	windowsHide: true,
});
console.log("DESCENDANT_PID=" + child.pid);
${parentOutput}
child.unref();
`;
}

// A short-lived parent can exit while a detached descendant keeps its stdout
// and stderr handles open. Waiting only for ChildProcess "close" mistakes the
// inherited handle for a still-running command and eventually false-times out.
{
	const childCode = "setTimeout(() => {}, 3000);";
	const run = await runNode(inheritedChild('console.log("parent-finished");', childCode), 0.75);
	stopProcess(extractPid(run.output, "DESCENDANT_PID"));
	check(
		"inherited-stdio-does-not-false-timeout",
		!run.error && run.result?.exitCode === 0 && run.output.includes("parent-finished") && run.elapsedMs < 1500,
		`${run.error ?? `exit=${run.result?.exitCode}`} elapsed=${Math.round(run.elapsedMs)}ms output=${JSON.stringify(run.output)}`,
	);
}

// Output that arrives just after the parent exits must still be collected. The
// post-exit idle grace is re-armed by data instead of cutting the stream at exit.
{
	const childCode = `
process.on("message", (message) => {
	if (message !== "go") return;
	process.disconnect();
	let count = 0;
	const timer = setInterval(() => {
		count++;
		process.stdout.write(count === 3 ? "tail-after-parent\\n" : "tail-chunk\\n");
		if (count === 8) {
			clearInterval(timer);
			setTimeout(() => {}, 3000);
		}
	}, 20);
});
process.send("ready");
`;
	const parentCode = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], {
	detached: true,
	stdio: ["ignore", "inherit", "inherit", "ipc"],
	windowsHide: true,
});
console.log("DESCENDANT_PID=" + child.pid);
child.unref();
child.on("message", (message) => {
	if (message === "ready") child.send("go");
});
`;
	const run = await runNode(parentCode, 2);
	stopProcess(extractPid(run.output, "DESCENDANT_PID"));
	check(
		"post-exit-tail-is-collected",
		!run.error && run.output.includes("tail-after-parent") && run.elapsedMs < 1500,
		`${run.error ?? `exit=${run.result?.exitCode}`} elapsed=${Math.round(run.elapsedMs)}ms output=${JSON.stringify(run.output)}`,
	);
}

// A genuinely running process must be killed and the timeout error surfaced
// promptly, independently of stdio "close" timing.
{
	const code = 'console.log("SELF_PID=" + process.pid); setInterval(() => {}, 1000);';
	const run = await runNode(code, 0.25);
	stopProcess(extractPid(run.output, "SELF_PID"));
	check(
		"timeout-settles-promptly",
		run.error instanceof Error && run.error.message === "timeout:0.25" && run.elapsedMs >= 150 && run.elapsedMs < 2500,
		`${run.error ?? `exit=${run.result?.exitCode}`} elapsed=${Math.round(run.elapsedMs)}ms output=${JSON.stringify(run.output)}`,
	);
}

// A timeout must also settle when an already-orphaned descendant keeps the
// killed parent's pipe open (the original close-only failure mode).
{
	const grandchildCode = "setTimeout(() => {}, 4000);";
	const launcherCode = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], {
	detached: true,
	stdio: ["ignore", "inherit", "inherit"],
	windowsHide: true,
});
process.send(grandchild.pid);
grandchild.unref();
`;
	const parentCode = `
const { spawn } = require("node:child_process");
const launcher = spawn(process.execPath, ["-e", ${JSON.stringify(launcherCode)}], {
	stdio: ["ignore", "inherit", "inherit", "ipc"],
	windowsHide: true,
});
launcher.on("message", (pid) => console.log("ORPHAN_PID=" + pid));
launcher.unref();
setInterval(() => {}, 1000);
`;
	const run = await runNode(parentCode, 1);
	stopProcess(extractPid(run.output, "ORPHAN_PID"));
	check(
		"timeout-ignores-orphaned-stdio-handle",
		run.error instanceof Error &&
			run.error.message === "timeout:1" &&
			run.output.includes("ORPHAN_PID=") &&
			run.elapsedMs >= 800 &&
			run.elapsedMs < 2500,
		`${run.error ?? `exit=${run.result?.exitCode}`} elapsed=${Math.round(run.elapsedMs)}ms output=${JSON.stringify(run.output)}`,
	);
}

// Abort follows the same tree-kill path but retains its distinct error contract.
{
	const controller = new AbortController();
	const abortHandle = setTimeout(() => controller.abort(), 250);
	const code = 'console.log("SELF_PID=" + process.pid); setInterval(() => {}, 1000);';
	const run = await runNode(code, undefined, controller.signal);
	clearTimeout(abortHandle);
	stopProcess(extractPid(run.output, "SELF_PID"));
	check(
		"abort-settles-promptly",
		run.error instanceof Error && run.error.message === "aborted" && run.elapsedMs >= 150 && run.elapsedMs < 2500,
		`${run.error ?? `exit=${run.result?.exitCode}`} elapsed=${Math.round(run.elapsedMs)}ms output=${JSON.stringify(run.output)}`,
	);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
