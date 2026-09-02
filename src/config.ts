import { readFileSync } from "node:fs";
import { join, win32 } from "node:path";

export const CONFIG_FILE_NAME = "pwsh.json";

const EXECUTION_POLICIES = [
	"AllSigned",
	"Bypass",
	"Default",
	"RemoteSigned",
	"Restricted",
	"Undefined",
	"Unrestricted",
] as const;

export type ExecutionPolicy = (typeof EXECUTION_POLICIES)[number];

export interface PwshConfig {
	executable: "auto" | string;
	loadProfile: boolean;
	executionPolicy: ExecutionPolicy | null;
	replaceUserBash: boolean;
	stopOnError: boolean;
	pythonUtf8: boolean;
	pythonUnbuffered: boolean;
	defaultWaitSeconds: number;
}

export const DEFAULT_CONFIG: Readonly<PwshConfig> = Object.freeze({
	executable: "auto",
	loadProfile: false,
	executionPolicy: "Bypass",
	replaceUserBash: true,
	stopOnError: false,
	pythonUtf8: true,
	pythonUnbuffered: true,
	defaultWaitSeconds: 60,
});

const CONFIG_KEYS = new Set<keyof PwshConfig>(Object.keys(DEFAULT_CONFIG) as Array<keyof PwshConfig>);
const ENV_FIELDS = {
	PI_PWSH_EXECUTABLE: "executable",
	PI_PWSH_LOAD_PROFILE: "loadProfile",
	PI_PWSH_EXECUTION_POLICY: "executionPolicy",
	PI_PWSH_REPLACE_USER_BASH: "replaceUserBash",
	PI_PWSH_STOP_ON_ERROR: "stopOnError",
	PI_PWSH_PYTHON_UTF8: "pythonUtf8",
	PI_PWSH_PYTHON_UNBUFFERED: "pythonUnbuffered",
	PI_PWSH_DEFAULT_WAIT_SECONDS: "defaultWaitSeconds",
} as const;

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

function parseBoolean(value: unknown, field: string, source: string): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		switch (value.trim().toLowerCase()) {
			case "1":
			case "true":
			case "yes":
			case "on":
				return true;
			case "0":
			case "false":
			case "no":
			case "off":
				return false;
		}
	}
	throw new ConfigError(`${source}: ${field} must be a boolean (true/false, 1/0, yes/no, or on/off)`);
}

function parseExecutable(value: unknown, source: string): "auto" | string {
	if (typeof value !== "string" || !value.trim()) {
		throw new ConfigError(`${source}: executable must be "auto" or an absolute path to pwsh.exe`);
	}
	const executable = value.trim();
	if (executable.toLowerCase() === "auto") return "auto";
	if (!win32.isAbsolute(executable)) {
		throw new ConfigError(`${source}: executable must be an absolute Windows path, received ${JSON.stringify(executable)}`);
	}
	return win32.normalize(executable);
}

function parseExecutionPolicy(value: unknown, source: string): ExecutionPolicy | null {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "string") {
		throw new ConfigError(`${source}: executionPolicy must be null or a PowerShell execution policy name`);
	}
	const policy = EXECUTION_POLICIES.find((candidate) => candidate.toLowerCase() === value.trim().toLowerCase());
	if (!policy) {
		throw new ConfigError(
			`${source}: unsupported executionPolicy ${JSON.stringify(value)}; expected one of ${EXECUTION_POLICIES.join(", ")}`,
		);
	}
	return policy;
}

function parseWaitSeconds(value: unknown, source: string): number {
	let seconds = Number.NaN;
	if (typeof value === "number") seconds = value;
	else if (typeof value === "string" && /^\d+$/.test(value.trim())) seconds = Number(value.trim());
	if (!Number.isInteger(seconds) || seconds < 0 || seconds > 300) {
		throw new ConfigError(`${source}: defaultWaitSeconds must be an integer between 0 and 300`);
	}
	return seconds;
}

function parseConfigObject(value: unknown, source: string): Partial<PwshConfig> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ConfigError(`${source}: configuration must be a JSON object`);
	}
	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).filter((key) => !CONFIG_KEYS.has(key as keyof PwshConfig));
	if (unknown.length > 0) {
		throw new ConfigError(`${source}: unknown configuration field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
	}

	const parsed: Partial<PwshConfig> = {};
	if ("executable" in input) parsed.executable = parseExecutable(input.executable, source);
	if ("executionPolicy" in input) parsed.executionPolicy = parseExecutionPolicy(input.executionPolicy, source);
	if ("defaultWaitSeconds" in input) parsed.defaultWaitSeconds = parseWaitSeconds(input.defaultWaitSeconds, source);
	for (const key of [
		"loadProfile",
		"replaceUserBash",
		"stopOnError",
		"pythonUtf8",
		"pythonUnbuffered",
	] as const) {
		if (key in input) parsed[key] = parseBoolean(input[key], key, source);
	}
	return parsed;
}

function parseEnvironment(env: NodeJS.ProcessEnv): Partial<PwshConfig> {
	const parsed: Partial<PwshConfig> = {};
	for (const [environmentName, field] of Object.entries(ENV_FIELDS) as Array<
		[keyof typeof ENV_FIELDS, (typeof ENV_FIELDS)[keyof typeof ENV_FIELDS]]
	>) {
		const value = env[environmentName];
		if (value === undefined) continue;
		const source = `environment variable ${environmentName}`;
		if (field === "executable") parsed.executable = parseExecutable(value, source);
		else if (field === "executionPolicy") parsed.executionPolicy = parseExecutionPolicy(value, source);
		else if (field === "defaultWaitSeconds") parsed.defaultWaitSeconds = parseWaitSeconds(value, source);
		else parsed[field] = parseBoolean(value, field, source);
	}
	return parsed;
}

export interface LoadConfigOptions {
	agentDir: string;
	env?: NodeJS.ProcessEnv;
	readFile?: typeof readFileSync;
}

export interface LoadedConfig {
	config: PwshConfig;
	path: string;
}

export function loadConfig({ agentDir, env = process.env, readFile = readFileSync }: LoadConfigOptions): LoadedConfig {
	const explicitPath = env.PI_PWSH_CONFIG?.trim();
	const path = explicitPath || join(agentDir, CONFIG_FILE_NAME);
	let fileConfig: Partial<PwshConfig> = {};
	try {
		const text = readFile(path, "utf8");
		let json: unknown;
		try {
			json = JSON.parse(text.replace(/^\uFEFF/, ""));
		} catch (error) {
			throw new ConfigError(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		fileConfig = parseConfigObject(json, path);
	} catch (error) {
		if (error instanceof ConfigError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && explicitPath) {
			throw new ConfigError(`${path}: configured file was not found`);
		}
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new ConfigError(`${path}: unable to read configuration: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return {
		path,
		config: {
			...DEFAULT_CONFIG,
			...fileConfig,
			...parseEnvironment(env),
		},
	};
}
