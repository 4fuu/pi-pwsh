// E2E smoke test for the persistent task output contract (real pwsh):
// - host and error streams (Write-Host / Write-Error / throw) arrive as plain
//   UTF-8 text, never CLIXML-serialized. `-EncodedCommand` serializes them;
//   the task launcher must use the stdin SOURCE_BOOTSTRAP instead.
// - Chinese output from PowerShell and console-codepage-aware native commands
//   round-trips as UTF-8.
// Run: node --experimental-transform-types scripts/smoke-output.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PwshTaskRuntime } from "../src/task-runtime.ts";

if (spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"]).error?.code === "ENOENT") {
	console.log("SKIP [task output e2e] pwsh is not installed");
	process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-output-test-"));
try {
	const pwsh = {
		executable: "pwsh",
		loadProfile: false,
		executionPolicy: "Bypass",
		stopOnError: false,
		pythonUtf8: true,
		pythonUnbuffered: true,
	};
	const runtime = new PwshTaskRuntime(pwsh, { taskDir: dir, sessionId: "output-test" });

	// Host/error streams must be plain text. Write-Error is non-terminating and
	// the final success statement settles the exit code at 0.
	const meta = await runtime.start("Write-Host '中文WriteHost'; Write-Error '中文WriteError'; 'plain成功输出'", dir);
	const done = await runtime.snapshot(meta.id, 30);
	assert.equal(done.metadata.status, "completed", `unexpected status: ${done.metadata.error ?? done.metadata.status}`);
	assert.ok(
		!done.output.includes("CLIXML") && !done.output.includes("<Objs"),
		`CLIXML leaked into task output:\n${done.output}`,
	);
	assert.ok(done.output.includes("中文WriteHost"), `Write-Host text missing or garbled:\n${done.output}`);
	assert.ok(done.output.includes("Write-Error: 中文WriteError"), `Write-Error text missing or garbled:\n${done.output}`);
	assert.ok(done.output.includes("plain成功输出"), `success output missing or garbled:\n${done.output}`);
	console.log("PASS [task output e2e] host/error streams are plain UTF-8 text");

	// Console-codepage-aware native commands follow the UTF-8 console set by the task prefix.
	const nativeMeta = await runtime.start('cmd /c "echo 中文cmd"', dir);
	const nativeDone = await runtime.snapshot(nativeMeta.id, 30);
	assert.equal(nativeDone.metadata.status, "completed", `unexpected status: ${nativeDone.metadata.error ?? nativeDone.metadata.status}`);
	assert.ok(nativeDone.output.includes("中文cmd"), `native output missing or garbled:\n${nativeDone.output}`);
	console.log("PASS [task output e2e] native command output is UTF-8");

	// Native exit codes survive the task wrapper.
	const exitMeta = await runtime.start("cmd /c exit 3", dir);
	const exitDone = await runtime.snapshot(exitMeta.id, 30);
	assert.equal(exitDone.metadata.status, "failed");
	assert.equal(exitDone.metadata.exitCode, 3);
	console.log("PASS [task output e2e] native exit code 3 is preserved");
} finally {
	await rm(dir, { recursive: true, force: true });
}
