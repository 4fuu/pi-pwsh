import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
	getAgentDir,
	type BashOperations,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerTaskCoordinator } from "@4fu/pi-task-coordinator";
import { loadConfig } from "./config.ts";
import { resolvePowerShellRuntime, userPowerShellArguments } from "./runtime.ts";
import { PwshSessionRuntime } from "./session-runtime.ts";
import {
	createRuntimeEnv,
	SOURCE_BOOTSTRAP,
	spawnAndStream,
	UTF8_PREFIX,
	wrapPowerShellCommand,
} from "./spawn.ts";
import { TaskNotificationManager } from "./task-notifications.ts";
import { PwshTaskRuntime, type TaskSnapshot, type TaskStatus } from "./task-runtime.ts";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PTY_PATH = join(SOURCE_DIR, "powershell", "pty.ps1");
const USER_REQUEST_PATH = join(SOURCE_DIR, "powershell", "user-request.ps1");
const PTY_PATTERN = /\b(?:Start-Pty|Get-Pty(?:Screen|Help)?|Receive-Pty|Send-PtyInput|Wait-Pty|Resize-Pty|Stop-Pty|Remove-Pty)\b/i;
const USER_REQUEST_PATTERN = /\b(?:Request-Pi(?:Input|Confirmation|Selection|PtyInput)|Get-PiRequestHelp)\b/i;

export const DESCRIPTION = `Run a PowerShell 7 command as a persistent background task, or inspect, wait for, or stop an existing task.

Write PowerShell 7 syntax. Single quotes are literal; double quotes expand variables; backtick is the escape character. Set environment variables with $env:NAME = 'value'; command. Quote paths containing spaces. Prefer modern cross-platform tools such as rg and fd when available. PowerShell recursive searches do not honor .gitignore, so bound paths, depth, and output tightly.

Exactly one of command or taskId is required. A command always starts a persistent task and returns immediately unless wait is supplied. With notifyOn, start and taskId waits end when that case-sensitive literal UTF-8 text appears or the task terminates; otherwise they wait for termination. A timeout or tool abort ends only waiting—the task continues. Only stop=true terminates its process tree. Queries are idempotent snapshots containing status and bounded latest output. Task IDs are usable only in the parent session that launched them.

Do not create a second background layer inside the command. Use taskId in a later pwsh call to inspect or stop work.

PTY SESSIONS: Start-Pty and related functions provide persistent interactive processes. USER REQUESTS: Request-PiInput, Request-PiConfirmation, Request-PiSelection, and Request-PiPtyInput ask through pi's UI.`;

const ELEVATION_DESCRIPTION = `\n\nELEVATION: Windows sudo is available in inline mode. Prefix a command with sudo to request administrator execution; Windows will display a UAC prompt.`;

export const PROMPT_GUIDELINE = "Use pwsh for shell tasks; every command starts a persistent background task. Write PowerShell syntax; prefer modern cross-platform tools (rg, fd, etc.) when available, otherwise use native PowerShell cmdlets with tightly bounded scope, and avoid Unix-only commands.";

export const PwshParams = Type.Object({
	command: Type.Optional(Type.String({
		minLength: 1,
		description: "PowerShell 7 command that starts a persistent task.",
	})),
	notifyOn: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 256,
		description: "Command-only, case-sensitive literal readiness text (1–256 UTF-8 bytes).",
	})),
	taskId: Type.Optional(Type.String({
		pattern: "^ps_[0-9a-f]{8}$",
		description: "Persistent task ID returned by an earlier pwsh call in this parent session.",
	})),
	wait: Type.Optional(Type.Number({
		minimum: 0,
		maximum: 300,
		description: "Seconds to wait for readiness when configured, otherwise terminal status. Omit to return immediately.",
	})),
	stop: Type.Optional(Type.Boolean({
		description: "With taskId, terminate the complete process tree before returning its snapshot.",
	})),
}, { additionalProperties: false });

interface PwshParamsValue {
	command?: string;
	notifyOn?: string;
	taskId?: string;
	wait?: number;
	stop?: boolean;
}

interface PwshDetails {
	version: 1;
	taskId: string;
	status: TaskStatus;
	ready: boolean;
	exitCode?: number | null;
	pid?: number;
	createdAt: string;
	omittedBytes: number;
	output: string;
	error?: string;
}

export function validate(params: PwshParamsValue): void {
	if ((params.command === undefined) === (params.taskId === undefined)) {
		throw new Error("pwsh: provide exactly one of command or taskId");
	}
	if (params.command !== undefined && params.stop !== undefined) {
		throw new Error("pwsh: stop is accepted only with taskId");
	}
	if (params.taskId !== undefined && params.notifyOn !== undefined) {
		throw new Error("pwsh: notifyOn is accepted only with command");
	}
	if (params.stop && params.wait !== undefined) {
		throw new Error("pwsh: wait is not accepted when stop=true");
	}
	if (params.notifyOn !== undefined && (params.notifyOn.length === 0 || Buffer.byteLength(params.notifyOn, "utf8") > 256)) {
		throw new Error("pwsh: notifyOn must contain 1 to 256 UTF-8 bytes");
	}
}

function taskText(snapshot: TaskSnapshot): string {
	const metadata = snapshot.metadata;
	return [
		`taskId: ${metadata.id}`,
		`status: ${metadata.status}`,
		...(snapshot.ready ? ["ready: true"] : []),
		...(metadata.pid ? [`pid: ${metadata.pid}`] : []),
		...(metadata.exitCode !== undefined ? [`exitCode: ${metadata.exitCode ?? "unknown"}`] : []),
		snapshot.omittedBytes > 0 ? `output: [${snapshot.omittedBytes} earlier bytes omitted]` : "output:",
		snapshot.output.trimEnd() || "(no output)",
		...(metadata.error ? [`error: ${metadata.error}`] : []),
	].join("\n");
}

function taskDetails(snapshot: TaskSnapshot): PwshDetails {
	return {
		version: 1,
		taskId: snapshot.metadata.id,
		status: snapshot.metadata.status,
		ready: snapshot.ready,
		exitCode: snapshot.metadata.exitCode,
		pid: snapshot.metadata.pid,
		createdAt: snapshot.metadata.createdAt,
		omittedBytes: snapshot.omittedBytes,
		output: snapshot.output,
		error: snapshot.metadata.error,
	};
}

function quotePowerShell(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function helperPrelude(command: string): { source: string; needsRpc: boolean } {
	const paths = [
		...(PTY_PATTERN.test(command) ? [PTY_PATH] : []),
		...(USER_REQUEST_PATTERN.test(command) ? [USER_REQUEST_PATH] : []),
	];
	return {
		source: paths.map((path) => `. ${quotePowerShell(path)}; `).join(""),
		needsRpc: paths.length > 0,
	};
}

function isBatchFileSpawnError(stderr: string): boolean {
	return stderr.includes("is not a valid Win32 application")
		|| stderr.includes("no es una aplicación Win32 válida")
		|| stderr.includes("不是有效的 Win32 应用程序")
		|| stderr.includes("cannot run due to the error");
}

function userBashOperations(session: PwshSessionRuntime): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			const helper = helperPrelude(command);
			const strict = session.pwsh.stopOnError ? "$ErrorActionPreference = 'Stop'; " : "";
			const source = `${UTF8_PREFIX}${helper.source}${strict}$global:LASTEXITCODE = $null; ${wrapPowerShellCommand(command)}`;
			const env = createRuntimeEnv(helper.needsRpc ? session.env : {}, options.env ?? process.env, session.pwsh);
			const first = await spawnAndStream(
				session.pwsh.executable,
				[...userPowerShellArguments(session.pwsh, { nonInteractive: true }), "-Command", SOURCE_BOOTSTRAP],
				cwd,
				{
					...options,
					env,
					stdin: Buffer.from(source, "utf8").toString("base64"),
				},
			);
			if (
				first.exitCode !== 0
				&& !helper.source
				&& process.platform === "win32"
				&& isBatchFileSpawnError(first.stderrText)
				&& !options.signal?.aborted
			) {
				options.onData(Buffer.from("\n[pi-pwsh] direct spawn failed; retrying via cmd /c.\n"));
				const retry = await spawnAndStream(
					"cmd",
					["/d", "/s", "/c", `chcp 65001>nul & ${command}`],
					cwd,
					{ ...options, env },
				);
				return { exitCode: retry.exitCode };
			}
			return { exitCode: first.exitCode };
		},
	};
}

function detectSudo(): Promise<boolean> {
	if (process.platform !== "win32") return Promise.resolve(false);
	return new Promise((resolve) => {
		let output = "";
		const child = spawn("sudo", ["config"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		child.stdout?.on("data", (data: Buffer) => {
			output += data.toString("utf8");
		});
		child.once("error", () => resolve(false));
		child.once("close", (code) => resolve(code === 0 && /inline|内联/i.test(output)));
	});
}

function sanitizeOutput(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1bP[\s\S]*?\x1b\\/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\r/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function statusTone(status: TaskStatus): "success" | "error" | "warning" | "muted" {
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	if (status === "cancelled") return "muted";
	return "warning";
}

export default function pwshExtension(pi: ExtensionAPI): void {
	const coordinator = registerTaskCoordinator(pi, "pwsh");
	let sessions: PwshSessionRuntime | undefined;
	let tasks: PwshTaskRuntime | undefined;
	let notifications: TaskNotificationManager | undefined;
	let operations: BashOperations | undefined;
	let config: ReturnType<typeof loadConfig>["config"] | undefined;
	let setupError: string | undefined;
	try {
		config = loadConfig({ agentDir: getAgentDir() }).config;
	} catch (error) {
		setupError = error instanceof Error ? error.message : String(error);
	}

	if (config?.replaceUserBash) {
		pi.on("user_bash", () => operations ? { operations } : undefined);
	}

	const registerTool = (description: string): void => {
		pi.registerTool({
			name: "pwsh",
			label: "pwsh",
			description,
			promptSnippet: "Execute PowerShell 7 (pwsh) commands",
			promptGuidelines: [PROMPT_GUIDELINE],
			parameters: PwshParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				validate(params);
				if (!tasks || !sessions) throw new Error(`pwsh: ${setupError ?? "PowerShell runtime is unavailable"}`);
				const activeTasks = tasks;
				let release = params.taskId !== undefined
					? coordinator.holdTask(`pwsh:${params.taskId}`)
					: coordinator.holdSource();
				try {
					let snapshot: TaskSnapshot;
					if (params.taskId !== undefined) {
						snapshot = params.stop
							? await activeTasks.stop(params.taskId)
							: await activeTasks.snapshot(params.taskId, params.wait ?? 0, signal);
					} else {
						const command = params.command as string;
						const helper = helperPrelude(command);
						const metadata = await activeTasks.start(
							command,
							ctx.cwd,
							params.notifyOn,
							helper.source,
							helper.needsRpc ? sessions.env : {},
						);
						const releaseSource = release;
						release = coordinator.holdTask(`pwsh:${metadata.id}`);
						releaseSource();
						snapshot = await activeTasks.snapshot(metadata.id, params.wait ?? 0, signal);
					}
					if (snapshot.metadata.status !== "starting" && snapshot.metadata.status !== "running") {
						coordinator.withdrawTask(`pwsh:${snapshot.metadata.id}`, ["ready", "terminal"], "presented");
					} else if (snapshot.ready) {
						await activeTasks.markReadyPresented(snapshot.metadata);
						coordinator.withdrawTask(`pwsh:${snapshot.metadata.id}`, ["ready"], "presented");
					}
					return {
						content: [{ type: "text" as const, text: taskText(snapshot) }],
						details: taskDetails(snapshot),
					};
				} finally {
					release();
				}
			},
			renderCall(args, theme) {
				const action = args.taskId
					? args.stop ? "stop" : args.wait !== undefined ? `wait ${args.wait}s` : "inspect"
					: args.wait !== undefined ? `start · wait ${args.wait}s` : "start";
				let header = `${theme.fg("toolTitle", theme.bold("pwsh"))} ${theme.fg("accent", args.taskId ?? "new task")} ${theme.fg("dim", `· ${action}`)}`;
				if (args.notifyOn) header += theme.fg("dim", ` · notify on ${JSON.stringify(args.notifyOn)}`);
				const command = typeof args.command === "string" ? args.command.replace(/\r/g, "").replace(/\t/g, "   ") : "";
				if (!command) return new Text(header, 0, 0);
				const lines = command.split("\n");
				const shown = lines.slice(0, 10);
				return new Text(`${header}\n${shown.join("\n")}${lines.length > shown.length ? theme.fg("dim", `\n… ${lines.length - shown.length} more lines`) : ""}`, 0, 0);
			},
			renderResult(result, options, theme) {
				const details = result.details as PwshDetails | undefined;
				if (!details) return new Text(theme.fg("muted", "pwsh"), 0, 0);
				const elapsed = Math.max(0, Date.now() - Date.parse(details.createdAt));
				const duration = `${(elapsed / 1_000).toFixed(1)}s`;
				const tone = statusTone(details.status);
				const header = `${theme.fg("toolTitle", theme.bold("pwsh"))} ${theme.fg("accent", details.taskId)} ${theme.fg(tone, details.status)} ${theme.fg("dim", `· ${duration}`)}`;
				const output = sanitizeOutput(details.output).trimEnd();
				const note = details.omittedBytes > 0 ? theme.fg("warning", `[${details.omittedBytes} earlier bytes omitted]`) : "";
				if (!options.expanded) {
					const preview = output.split("\n").slice(-5).join("\n");
					return new Text([header, note, preview ? theme.fg("toolOutput", preview) : ""].filter(Boolean).join("\n"), 0, 0);
				}
				const processInfo = [
					details.ready ? "ready" : undefined,
					details.pid ? `PID ${details.pid}` : undefined,
					details.exitCode !== undefined ? `exit ${details.exitCode ?? "unknown"}` : undefined,
				].filter(Boolean).join(" · ");
				return new Text([
					header,
					processInfo ? theme.fg("dim", processInfo) : "",
					note,
					theme.fg("toolOutput", output || "(no output)"),
					...(details.error ? [theme.fg("error", details.error)] : []),
				].filter(Boolean).join("\n"), 0, 0);
			},
		});
	};

	registerTool(DESCRIPTION);

	pi.on("session_shutdown", async () => {
		const currentNotifications = notifications;
		const currentSessions = sessions;
		notifications = undefined;
		sessions = undefined;
		tasks = undefined;
		operations = undefined;
		await currentNotifications?.close();
		coordinator.closeSession();
		await currentSessions?.close();
	});

	pi.on("session_start", async (_event, ctx) => {
		await notifications?.close();
		await sessions?.close();
		notifications = undefined;
		sessions = undefined;
		tasks = undefined;
		operations = undefined;
		coordinator.closeSession();
		if (!config) {
			activateBuiltInBash(pi);
			ctx.ui.notify(`pi-pwsh: ${setupError ?? "configuration could not be loaded"}. The built-in bash tool remains active.`, "error");
			return;
		}

		let resolved;
		let sudoAvailable = false;
		try {
			[resolved, sudoAvailable] = await Promise.all([resolvePowerShellRuntime(config), detectSudo()]);
		} catch (error) {
			activateBuiltInBash(pi);
			ctx.ui.notify(`pi-pwsh: ${error instanceof Error ? error.message : String(error)}. The built-in bash tool remains active.`, "error");
			return;
		}

		const nextSessions = new PwshSessionRuntime(pi, ctx, resolved);
		try {
			await nextSessions.rpc.start();
		} catch (error) {
			ctx.ui.notify(`pi-pwsh: interactive service startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		const nextTasks = new PwshTaskRuntime(resolved, { sessionId: ctx.sessionManager.getSessionId() });
		try {
			await nextTasks.cleanupExpired();
		} catch (error) {
			await nextSessions.close();
			activateBuiltInBash(pi);
			ctx.ui.notify(`pi-pwsh: task runtime startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}

		coordinator.startSession(ctx, ctx.sessionManager.getSessionId());
		const nextNotifications = new TaskNotificationManager(coordinator, ctx, nextTasks, ctx.sessionManager.getSessionId());
		try {
			await nextNotifications.start();
			notifications = nextNotifications;
		} catch (error) {
			await nextNotifications.close();
			ctx.ui.notify(`pi-pwsh: task notification startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		sessions = nextSessions;
		tasks = nextTasks;
		operations = userBashOperations(nextSessions);
		if (sudoAvailable) registerTool(`${DESCRIPTION}${ELEVATION_DESCRIPTION}`);
		activatePwsh(pi);
	});
}

function activatePwsh(pi: ExtensionAPI): void {
	const replaced = new Set(["bash", "pwsh"]);
	pi.setActiveTools([...pi.getActiveTools().filter((name) => !replaced.has(name)), "pwsh"]);
}

function activateBuiltInBash(pi: ExtensionAPI): void {
	const active = pi.getActiveTools().filter((name) => name !== "pwsh");
	if (!active.includes("bash")) active.push("bash");
	pi.setActiveTools(active);
}
