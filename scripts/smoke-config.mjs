import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { resolvePowerShellRuntime, RuntimeError, userPowerShellArguments } from "../src/runtime.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-pwsh-config-"));
let passed = 0;

function test(name, body) {
	try {
		const result = body();
		if (result instanceof Promise) {
			return result.then(() => {
				passed++;
				console.log(`PASS [${name}]`);
			});
		}
		passed++;
		console.log(`PASS [${name}]`);
	} catch (error) {
		console.error(`FAIL [${name}]`, error);
		throw error;
	}
}

try {
	test("defaults-without-file", () => {
		assert.deepEqual(loadConfig({ agentDir: directory, env: {} }).config, DEFAULT_CONFIG);
	});

	writeFileSync(join(directory, "pwsh.json"), JSON.stringify({ loadProfile: true, pythonUtf8: false }));
	test("file-and-environment-precedence", () => {
		const loaded = loadConfig({
			agentDir: directory,
			env: { PI_PWSH_LOAD_PROFILE: "off", PI_PWSH_STOP_ON_ERROR: "yes" },
		});
		assert.equal(loaded.config.loadProfile, false);
		assert.equal(loaded.config.stopOnError, true);
		assert.equal(loaded.config.pythonUtf8, false);
	});

	test("strict-unknown-field", () => {
		writeFileSync(join(directory, "pwsh.json"), JSON.stringify({ typo: true }));
		assert.throws(() => loadConfig({ agentDir: directory, env: {} }), ConfigError);
	});

	test("invalid-environment-value", () => {
		rmSync(join(directory, "pwsh.json"));
		assert.throws(
			() => loadConfig({ agentDir: directory, env: { PI_PWSH_EXECUTION_POLICY: "Anything" } }),
			ConfigError,
		);
	});

	test("explicit-config-file-is-required", () => {
		assert.throws(
			() => loadConfig({ agentDir: directory, env: { PI_PWSH_CONFIG: join(directory, "missing.json") } }),
			ConfigError,
		);
	});

	await test("runtime-pins-probed-absolute-path", async () => {
		const runtime = await resolvePowerShellRuntime({ ...DEFAULT_CONFIG }, {
			exists: (path) => path === "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			probe: async (candidate) => {
				assert.equal(candidate, "pwsh");
				return { version: "7.5.2", executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" };
			},
		});
		assert.equal(runtime.executable, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
		assert.deepEqual(userPowerShellArguments(runtime, { nonInteractive: true }), [
			"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		]);
	});

	await test("runtime-accepts-spawnable-app-execution-alias", async () => {
		const alias = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe";
		const resolved = "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.5.0_x64__8wekyb3d8bbwe\\pwsh.exe";
		const runtime = await resolvePowerShellRuntime({ ...DEFAULT_CONFIG, executable: alias }, {
			exists: (path) => path === resolved,
			probe: async (candidate) => {
				assert.equal(candidate, alias);
				return { version: "7.6.5", executable: resolved };
			},
		});
		assert.equal(runtime.executable, resolved);
	});

	await test("rejects-powershell-before-seven", async () => {
		await assert.rejects(
			resolvePowerShellRuntime({ ...DEFAULT_CONFIG }, {
				exists: () => true,
				probe: async () => ({ version: "5.1.0", executable: "C:\\Windows\\pwsh.exe" }),
			}),
			RuntimeError,
		);
	});

	console.log(`\n=== ${passed} passed, 0 failed ===`);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
