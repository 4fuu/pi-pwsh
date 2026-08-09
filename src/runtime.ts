import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { ExecutionPolicy, PwshConfig } from "./config.ts";

const KNOWN_PWSH_PATH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const PROBE_TIMEOUT_MS = 5_000;
// Force UTF-8 first so a non-ASCII $PSHOME path survives the parent's UTF-8 decode.
const VERSION_PROBE =
	"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.WriteLine($PSVersionTable.PSVersion.ToString()); [Console]::Out.Write((Join-Path $PSHOME 'pwsh.exe'))";

export interface PowerShellProbe {
	version: string;
	executable: string;
}

export interface ResolvedPwshRuntime extends PowerShellProbe {
	loadProfile: boolean;
	executionPolicy: ExecutionPolicy | null;
	stopOnError: boolean;
	pythonUtf8: boolean;
	pythonUnbuffered: boolean;
}

export interface RuntimeDependencies {
	exists: (path: string) => boolean;
	probe: (executable: string) => Promise<PowerShellProbe | null>;
}

export class RuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeError";
	}
}

function defaultProbe(executable: string): Promise<PowerShellProbe | null> {
	return new Promise((resolve) => {
		let settled = false;
		let output = "";
		const child = spawn(
			executable,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", VERSION_PROBE],
			{ stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
		);
		const finish = (value: PowerShellProbe | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			try { child.kill(); } catch {}
			finish(null);
		}, PROBE_TIMEOUT_MS);
		child.stdout?.on("data", (data: Buffer) => {
			output += data.toString("utf8");
		});
		child.once("error", () => finish(null));
		child.once("close", (code) => {
			if (code !== 0) return finish(null);
			const [version = "", path = ""] = output.trim().split(/\r?\n/, 2);
			if (!/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(version) || !win32.isAbsolute(path)) {
				return finish(null);
			}
			finish({ version, executable: win32.normalize(path) });
		});
	});
}

const DEFAULT_DEPENDENCIES: RuntimeDependencies = {
	exists: existsSync,
	probe: defaultProbe,
};

function majorVersion(version: string): number | null {
	const match = /^(\d+)/.exec(version);
	return match ? Number(match[1]) : null;
}

export async function resolvePowerShellRuntime(
	config: PwshConfig,
	dependencies: RuntimeDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResolvedPwshRuntime> {
	const explicit = config.executable !== "auto";
	const candidates = explicit
		? [config.executable]
		: ["pwsh", ...(dependencies.exists(KNOWN_PWSH_PATH) ? [KNOWN_PWSH_PATH] : [])];
	const failures: string[] = [];

	for (const candidate of candidates) {
		if (explicit && !dependencies.exists(candidate)) {
			failures.push(`${candidate}: file not found`);
			continue;
		}
		const probe = await dependencies.probe(candidate);
		if (!probe) {
			failures.push(`${candidate}: failed to start or returned an invalid version`);
			continue;
		}
		const major = majorVersion(probe.version);
		if (major === null || major < 7) {
			failures.push(`${probe.executable}: PowerShell ${probe.version} is unsupported`);
			continue;
		}
		if (!dependencies.exists(probe.executable)) {
			failures.push(`${probe.executable}: resolved executable was not found`);
			continue;
		}
		return {
			...probe,
			executable: win32.normalize(probe.executable),
			loadProfile: config.loadProfile,
			executionPolicy: config.executionPolicy,
			stopOnError: config.stopOnError,
			pythonUtf8: config.pythonUtf8,
			pythonUnbuffered: config.pythonUnbuffered,
		};
	}

	const prefix = explicit
		? `Configured PowerShell executable ${JSON.stringify(config.executable)} is unavailable.`
		: "PowerShell 7 or newer was not found.";
	const details = failures.length > 0 ? ` Checked: ${failures.join("; ")}.` : "";
	throw new RuntimeError(`${prefix}${details} Install PowerShell 7 or configure an absolute pwsh.exe path.`);
}

export interface PowerShellArgumentOptions {
	nonInteractive: boolean;
}

export function userPowerShellArguments(
	runtime: ResolvedPwshRuntime,
	{ nonInteractive }: PowerShellArgumentOptions,
): string[] {
	const args = ["-NoLogo"];
	if (!runtime.loadProfile) args.push("-NoProfile");
	if (nonInteractive) args.push("-NonInteractive");
	if (runtime.executionPolicy) args.push("-ExecutionPolicy", runtime.executionPolicy);
	return args;
}
