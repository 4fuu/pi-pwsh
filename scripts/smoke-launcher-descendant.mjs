// The launcher must finish when its direct child exits even if a detached
// descendant keeps inherited stdout/stderr handles open.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "pi-pwsh-launcher-test-"));
const id = "ps_1234abcd";
const instanceId = "d".repeat(32);
const metaPath = join(dir, "meta.json");
const logPath = join(dir, "output.log");
const configPath = join(dir, "config.json");
const now = new Date().toISOString();
let descendantPid;

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function terminate(pid) {
	if (!pid || !isAlive(pid)) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// The descendant already exited.
	}
}

try {
	await writeFile(logPath, "");
	await writeFile(metaPath, JSON.stringify({
		version: 1,
		id,
		instanceId,
		sessionId: "launcher-test",
		supervisorPid: 0,
		cwd: dir,
		commandSummary: "descendant inherits stdio",
		createdAt: now,
		updatedAt: now,
		status: "starting",
	}));
	const directChildSource = `
		import { spawn } from "node:child_process";
		const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
			detached: true,
			stdio: ["ignore", "inherit", "inherit"],
			windowsHide: true,
		});
		descendant.unref();
		console.log("DESCENDANT_PID=" + descendant.pid);
		console.log("DIRECT_CHILD_EXITING");
	`;
	await writeFile(configPath, JSON.stringify({
		id,
		instanceId,
		executable: process.execPath,
		args: ["--input-type=module", "-e", directChildSource],
		cwd: dir,
		logPath,
		metaPath,
		cancelMarkerPath: join(dir, `${instanceId}.cancelled`),
		readyMarkerPath: join(dir, `${instanceId}.ready.detected`),
	}));

	const started = performance.now();
	const launcher = spawn(process.execPath, [join(import.meta.dirname, "../src/task-launcher.mjs"), configPath], {
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let diagnostics = "";
	launcher.stdout.on("data", (chunk) => { diagnostics += chunk; });
	launcher.stderr.on("data", (chunk) => { diagnostics += chunk; });
	const exitCode = await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("launcher timed out")), 15_000);
		launcher.once("error", reject);
		launcher.once("close", (code) => {
			clearTimeout(timeout);
			resolve(code);
		});
	});
	const elapsedMs = Math.round(performance.now() - started);
	const output = await readFile(logPath, "utf8");
	descendantPid = Number.parseInt(/DESCENDANT_PID=(\d+)/.exec(output)?.[1] ?? "", 10);
	const metadata = JSON.parse(await readFile(metaPath, "utf8"));

	assert.equal(exitCode, 0, diagnostics);
	assert.equal(metadata.status, "completed");
	assert.match(output, /DIRECT_CHILD_EXITING/);
	assert.ok(Number.isInteger(descendantPid), `descendant pid missing:\n${output}`);
	assert.equal(isAlive(descendantPid), true, "launcher waited for the detached descendant to exit");
	console.log(`PASS [task launcher descendant] completed in ${elapsedMs} ms while descendant ${descendantPid} was still alive`);
} finally {
	terminate(descendantPid);
	await rm(dir, { recursive: true, force: true });
}
