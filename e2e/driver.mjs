//
// End-to-end driver for the pi-pwsh tool wiring inside a real pi process
// (npm run test:e2e). Not part of `npm test`.
//
// Loads the local plugin plus a scripted fake provider into real pi runs and
// asserts the contract the model and the user actually observe:
//   s1 print (text):      foreground wait, clean exit, no taskId in output
//   s2 print (json):      completed result without taskId, FOREGROUND tool
//                         description and guideline, no wait guidance
//   s3 rejections:        taskId / taskId+stop / notifyOn rejected off-TUI
//   s4 abort (rpc):       aborting the call kills the whole process tree
//   s5 TUI:               background DESCRIPTION/guideline, taskId in result
//   s6 TUI Ctrl+Alt+B:    released wait reports backgrounding, task survives
//
// Requires Windows and pi 0.99+ (PI_BIN or on PATH); otherwise prints SKIP
// and exits 0. Scratch files live under os.tmpdir() and are removed on exit.
//
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import {
	DESCRIPTION,
	FOREGROUND_DESCRIPTION,
	FOREGROUND_PROMPT_GUIDELINE,
} from "../src/index.ts";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(E2E_DIR, "..");
const PLUGIN = join(REPO, "src", "index.ts");
const HARNESS = join(E2E_DIR, "fake-provider.mjs");

const FG_DESC_MARK = "wait until it exits";
const BG_DESC_MARK = "persistent background task";
const FG_GUIDE_MARK = "runs in the foreground until it exits";
const BG_GUIDE_MARK = "starts a persistent background task";
const GUIDANCE_MARK = "Do not poll it";

const MIN_PI = [0, 99, 0];

function skip(reason) {
	console.log(`SKIP [e2e] ${reason}`);
	process.exit(0);
}

if (process.platform !== "win32") {
	skip("non-win32 platform: the pwsh tool is Windows-only");
}

// --- locate pi -----------------------------------------------------------

function piCommand() {
	const explicit = process.env.PI_BIN?.trim();
	if (explicit) {
		if (!existsSync(explicit)) skip(`PI_BIN points to a missing file: ${explicit}`);
		// .cmd shims need a shell; exes can be spawned directly.
		if (/\.cmd$/i.test(explicit)) return { file: "cmd.exe", args: ["/c", explicit] };
		return { file: explicit, args: [] };
	}
	// `npm run` prepends node_modules/.bin, whose pi shim is the 0.8x
	// devDependency — not the pi this plugin must be tested against. Prefer
	// the first pi.exe outside any node_modules entry.
	for (const dir of process.env.PATH.split(delimiter)) {
		if (!dir || /node_modules/i.test(dir)) continue;
		const exe = join(dir, "pi.exe");
		if (existsSync(exe)) return { file: exe, args: [] };
	}
	const probe = spawnSync("cmd.exe", ["/c", "pi", "--version"], { encoding: "utf8", windowsHide: true });
	if (probe.status !== 0) skip("pi was not found on PATH (set PI_BIN to point at the pi executable)");
	return { file: "cmd.exe", args: ["/c", "pi"] };
}

const PI = piCommand();
const versionText = spawnSync(PI.file, [...PI.args, "--version"], { encoding: "utf8", windowsHide: true }).stdout?.trim() ?? "";
const version = versionText.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
function versionAtLeast(v, min) {
	for (let i = 0; i < 3; i++) {
		if (v[i] !== min[i]) return v[i] > min[i];
	}
	return true;
}
if (!version || !versionAtLeast(version, MIN_PI)) {
	skip(`pi ${versionText || "version unknown"} is too old; pi >= 0.99.0 is required`);
}

const BASE_ARGS = [
	"-ne", "-nbt", "-nc", "-ns", "-np", "--offline", "--no-session",
	"--provider", "fake-e2e", "--model", "scripted",
	"-e", PLUGIN, "-e", HARNESS,
];

// --- helpers --------------------------------------------------------------

const results = [];
function check(scenario, name, ok, detail = "") {
	results.push({ scenario, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} [${scenario}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const SCRATCH = mkdtempSync(join(tmpdir(), "pi-pwsh-e2e-"));

function readDumps(path) {
	try {
		return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

/** pi 0.99+: the system prompt is messages[0] with sections + toolsAdded. */
function modelView(dumpEntry) {
	const sys = dumpEntry?.messages?.find((m) => m.role === "system") ?? dumpEntry?.messages?.[0];
	const pwshTool = sys?.toolsAdded?.find((t) => t.name === "pwsh")
		?? dumpEntry?.tools?.find((t) => t.name === "pwsh");
	return {
		rules: sys?.sections?.rules ?? "",
		description: pwshTool?.description ?? "",
		messages: dumpEntry?.messages ?? [],
	};
}

function setupScenario(name, script) {
	const dump = join(SCRATCH, `dump-${name}.jsonl`);
	const scriptPath = join(SCRATCH, `script-${name}.json`);
	rmSync(dump, { force: true });
	writeFileSync(scriptPath, JSON.stringify(script), "utf8");
	return { dump, env: { ...process.env, FAKE_E2E_DUMP: dump, FAKE_E2E_SCRIPT: scriptPath } };
}

function runPi(args, env, timeoutMs) {
	return new Promise((resolve, reject) => {
		const child = spawn(PI.file, [...PI.args, ...args], { cwd: SCRATCH, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`timeout after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.on("data", (d) => { stdout += d; });
		child.stderr.on("data", (d) => { stderr += d; });
		child.on("error", (e) => { clearTimeout(timer); reject(e); });
		child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
	});
}

function parseJsonEvents(stdout) {
	return stdout.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => {
		try { return JSON.parse(l); } catch { return null; }
	}).filter(Boolean);
}

function markerSize(path) {
	try { return statSync(path).size; } catch { return -1; }
}

function taskLauncherPids() {
	const out = spawnSync("pwsh", ["-NoProfile", "-Command",
		"Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object CommandLine -like '*task-launcher.mjs*' | Select-Object -ExpandProperty ProcessId"],
		{ encoding: "utf8", windowsHide: true });
	return new Set((out.stdout ?? "").split(/\s+/).filter((t) => /^\d+$/.test(t)));
}

function killTrees(pids) {
	for (const pid of pids) {
		try { spawnSync("cmd.exe", ["/c", "taskkill", "/PID", String(pid), "/T", "/F"], { windowsHide: true }); } catch {}
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- scenarios ------------------------------------------------------------

async function s1PrintText() {
	const name = "s1-print-text";
	const { env } = setupScenario(name, [
		{ toolCall: { name: "pwsh", arguments: { command: "Write-Output 'E2E-PRINT-OK'" } } },
		{ text: "MODEL-DONE" },
	]);
	const { code, stdout } = await runPi(["-p", ...BASE_ARGS, "go"], env, 60_000);
	check(name, "pi -p exits cleanly", code === 0, `exit=${code}`);
	check(name, "assistant text printed", stdout.includes("MODEL-DONE"));
	check(name, "no taskId in output", !stdout.includes("taskId:"));
}

async function s2PrintJson() {
	const name = "s2-print-json";
	const { dump, env } = setupScenario(name, [
		{ toolCall: { name: "pwsh", arguments: { command: "Start-Sleep -Seconds 3; Write-Output 'SLEPT-3S-OK'" } } },
		{ text: "MODEL-DONE" },
	]);
	const { code, stdout } = await runPi(["-p", "--mode", "json", ...BASE_ARGS, "go"], env, 90_000);
	check(name, "pi exits cleanly", code === 0, `exit=${code}`);
	const events = parseJsonEvents(stdout);
	const start = events.find((e) => e.type === "tool_execution_start" && e.toolName === "pwsh");
	const end = events.find((e) => e.type === "tool_execution_end" && e.toolName === "pwsh");
	check(name, "pwsh tool executed", Boolean(start && end));
	if (!end) return;
	const text = end.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
	check(name, "waited for exit: completed output present after sleep 3",
		text.includes("SLEPT-3S-OK") && text.includes("status: completed"));
	check(name, "no taskId in foreground result", !text.includes("taskId:"));
	check(name, "no wait guidance in foreground result",
		!text.includes(GUIDANCE_MARK) && !text.includes("wait window ended"));
	const view = modelView(readDumps(dump)[0]);
	check(name, "model saw pwsh tool", view.description.length > 0);
	check(name, "FOREGROUND_DESCRIPTION", view.description.includes(FG_DESC_MARK) && !view.description.includes(BG_DESC_MARK));
	check(name, "FOREGROUND_PROMPT_GUIDELINE in system prompt",
		view.rules.includes(FG_GUIDE_MARK) && !view.rules.includes(BG_GUIDE_MARK));
	check(name, "foreground description matches the plugin constant",
		view.description.replace(/\s+/g, " ").includes(FOREGROUND_DESCRIPTION.split("\n")[0].trim()));
}

async function s3Rejections() {
	const name = "s3-rejections";
	const { env } = setupScenario(name, [
		{ toolCall: { name: "pwsh", arguments: { taskId: "ps_1234abcd" } } },
		{ toolCall: { name: "pwsh", arguments: { taskId: "ps_1234abcd", stop: true } } },
		{ toolCall: { name: "pwsh", arguments: { command: "Write-Output x", notifyOn: "x" } } },
		{ text: "MODEL-DONE" },
	]);
	const { code, stdout } = await runPi(["-p", "--mode", "json", ...BASE_ARGS, "go"], env, 90_000);
	check(name, "pi exits cleanly", code === 0, `exit=${code}`);
	const ends = parseJsonEvents(stdout).filter((e) => e.type === "tool_execution_end" && e.toolName === "pwsh");
	check(name, "three pwsh calls", ends.length === 3, String(ends.length));
	const expect = ["taskId rejected", "taskId+stop rejected", "notifyOn rejected"];
	ends.forEach((end, i) => {
		const text = end.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
		check(name, expect[i], end.isError === true || /unavailable outside the TUI/.test(text), JSON.stringify(text.slice(0, 120)));
	});
}

async function s4AbortRpc() {
	const name = "s4-abort-rpc";
	const marker = join(SCRATCH, "hb-s4.txt");
	rmSync(marker, { force: true });
	const heartbeat = `$env:E2E_MARKER='${marker}'; node -e "const fs=require('fs');fs.writeFileSync(process.env.E2E_MARKER,'x');setInterval(()=>fs.appendFileSync(process.env.E2E_MARKER,'.'),300)"`;
	const { env } = setupScenario(name, [
		{ toolCall: { name: "pwsh", arguments: { command: heartbeat } } },
	]);
	const child = spawn(PI.file, [...PI.args, "--mode", "rpc", ...BASE_ARGS], { cwd: SCRATCH, env, stdio: ["pipe", "pipe", "pipe"] });
	const events = [];
	let buf = "";
	child.stdout.on("data", (d) => {
		buf += d;
		let idx;
		while ((idx = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (line.startsWith("{")) { try { events.push(JSON.parse(line)); } catch {} }
		}
	});
	const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
	send({ id: "r1", type: "prompt", message: "go" });
	const deadline = Date.now() + 40_000;
	while (Date.now() < deadline && !events.some((e) => e.type === "tool_execution_start" && e.toolName === "pwsh")) {
		await sleep(250);
	}
	await sleep(3_000); // let the tree spawn and beat
	const beforeAbort = markerSize(marker);
	check(name, "heartbeat running before abort", beforeAbort > 0, `size=${beforeAbort}`);
	send({ type: "abort" });
	const settleDeadline = Date.now() + 30_000;
	while (Date.now() < settleDeadline && !events.some((e) => ["agent_end", "agent_settled"].includes(e.type))) {
		await sleep(250);
	}
	await sleep(2_500);
	const afterA = markerSize(marker);
	await sleep(2_500);
	const afterB = markerSize(marker);
	check(name, "process tree killed (marker stopped)", beforeAbort > 0 && afterA === afterB && afterA >= beforeAbort,
		`before=${beforeAbort} afterA=${afterA} afterB=${afterB}`);
	const end = events.find((e) => e.type === "tool_execution_end" && e.toolName === "pwsh");
	const endText = end ? (end.result?.content ?? []).map((c) => c.text ?? "").join("\n") : "";
	check(name, "aborted call reported cancelled",
		endText.includes("cancelled") || endText.includes("aborted") || events.some((e) => e.type === "agent_end"), JSON.stringify(endText.slice(0, 120)));
	child.kill();
}

async function s5TuiBackground() {
	const name = "s5-tui-background";
	const { dump, env } = setupScenario(name, [
		{ toolCall: { name: "pwsh", arguments: { command: "Write-Output 'TUI-BG-OK'" } } },
		{ text: "TUI-DONE" },
	]);
	const term = pty.spawn(PI.file, [...PI.args, ...BASE_ARGS, "go"], {
		name: "xterm-256color", cols: 120, rows: 30, cwd: SCRATCH, env,
	});
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline && readDumps(dump).length < 2) await sleep(300);
	await sleep(500);
	const dumps = readDumps(dump);
	check(name, "two LLM calls happened", dumps.length >= 2, `${dumps.length} calls`);
	const view = modelView(dumps[0]);
	check(name, "TUI keeps background DESCRIPTION", view.description.includes(BG_DESC_MARK) && !view.description.includes(FG_DESC_MARK));
	check(name, "TUI keeps background guideline", view.rules.includes(BG_GUIDE_MARK) && !view.rules.includes(FG_GUIDE_MARK));
	const toolResults = JSON.stringify(modelView(dumps[1]).messages);
	check(name, "background result carries taskId (ps_ id)", /taskId: ps_[0-9a-f]{8}/.test(toolResults), "");
	check(name, "command output captured", toolResults.includes("TUI-BG-OK"));
	term.write("/exit\r");
	await sleep(1_500);
	try { term.kill(); } catch {}
}

async function s6TuiCtrlAltB() {
	const name = "s6-tui-ctrl-alt-b";
	const marker = join(SCRATCH, "hb-s6.txt");
	rmSync(marker, { force: true });
	const before = taskLauncherPids();
	const heartbeat = `$env:E2E_MARKER='${marker}'; node -e "const fs=require('fs');fs.writeFileSync(process.env.E2E_MARKER,'x');setInterval(()=>fs.appendFileSync(process.env.E2E_MARKER,'.'),300)"`;
	const { dump, env } = setupScenario(name, [
		{ toolCall: { name: "pwsh", arguments: { command: heartbeat, wait: 120 } } },
		{ text: "BG-DONE" },
	]);
	const term = pty.spawn(PI.file, [...PI.args, ...BASE_ARGS, "go"], {
		name: "xterm-256color", cols: 120, rows: 30, cwd: SCRATCH, env,
	});
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline && readDumps(dump).length < 1) await sleep(300);
	await sleep(4_000); // foreground wait in progress
	check(name, "heartbeat running during foreground wait", markerSize(marker) > 0, `size=${markerSize(marker)}`);
	term.write("\x1b\x02"); // Ctrl+Alt+B (legacy: ESC + ctrl-b)
	const settleDeadline = Date.now() + 30_000;
	while (Date.now() < settleDeadline && readDumps(dump).length < 2) await sleep(300);
	await sleep(1_000);
	const dumps = readDumps(dump);
	const toolResults = JSON.stringify(modelView(dumps[1]).messages);
	check(name, "second LLM call after backgrounding", dumps.length >= 2, `${dumps.length} calls`);
	check(name, "result reports moved to background", toolResults.includes("moved this task to the background"), "");
	check(name, "backgrounded task keeps running", markerSize(marker) > 0, `size=${markerSize(marker)}`);
	term.write("/exit\r");
	await sleep(1_000);
	try { term.kill(); } catch {}
	rmSync(marker, { force: true });
	// Kill only the task launchers this scenario created; the tree kill
	// includes the pwsh child and the heartbeat node grandchild.
	const after = taskLauncherPids();
	killTrees([...after].filter((pid) => !before.has(pid)));
}

// --- main -----------------------------------------------------------------

const scenarios = { s1PrintText, s2PrintJson, s3Rejections, s4AbortRpc, s5TuiBackground, s6TuiCtrlAltB };
const launchersBefore = taskLauncherPids();
try {
	for (const key of Object.keys(scenarios)) {
		try {
			await scenarios[key]();
		} catch (error) {
			check(key, "scenario completed", false, String(error?.message ?? error));
		}
	}
} finally {
	// Safety net: never leave a pwsh task tree behind.
	killTrees([...taskLauncherPids()].filter((pid) => !launchersBefore.has(pid)));
	try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
}
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length} passed, ${failed.length} failed ===`);
// node-pty handles can keep the event loop (or a native ConPTY pump) alive
// after every scenario is done; force the exit code out on a short delay.
const exitCode = failed.length ? 1 : 0;
setTimeout(() => process.exit(exitCode), 10_000).unref();
process.exitCode = exitCode;
