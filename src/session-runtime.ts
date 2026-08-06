import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { JobNotificationManager } from "./job-notifications.ts";
import { PtySessionManager, type PtyRef, type StartPtyOptions } from "./pty-manager.ts";
import { PwshRpcServer, type RpcRequest } from "./rpc.ts";
import { userPowerShellArguments, type ResolvedPwshRuntime } from "./runtime.ts";
import { UserRequestManager } from "./user-request.ts";

function objectParams(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
}

function requiredString(value: unknown, name: string): string {
	const result = optionalString(value, name);
	if (result === undefined) throw new Error(`${name} is required`);
	return result;
}

function optionalBoolean(value: unknown, fallback = false): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function optionalNumber(value: unknown, name: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
	return value;
}

function stringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name} must be a string array`);
	return value as string[];
}

function ptyRef(params: Record<string, unknown>): PtyRef {
	const id = optionalNumber(params.id, "id");
	const name = optionalString(params.name, "name");
	if (id === undefined && name === undefined) throw new Error("A PTY name or id is required");
	return { id, name };
}

function environment(value: unknown): Record<string, string> | undefined {
	if (value === undefined || value === null) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("environment must be an object");
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item !== "string") throw new Error(`environment.${key} must be a string`);
		result[key] = item;
	}
	return result;
}

const KEY_SEQUENCES: Readonly<Record<string, string>> = {
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	backspace: "\x7f",
	delete: "\x1b[3~",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	home: "\x1b[H",
	end: "\x1b[F",
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
	ctrlc: "\x03",
	ctrld: "\x04",
	ctrlz: "\x1a",
};

function inputSequence(params: Record<string, unknown>): string {
	let result = optionalString(params.text, "text") ?? "";
	if (params.keys !== undefined) {
		for (const key of stringArray(params.keys, "keys")) {
			const sequence = KEY_SEQUENCES[key.replace(/[-_+]/g, "").toLowerCase()];
			if (sequence === undefined) throw new Error(`Unsupported PTY key: ${key}`);
			result += sequence;
		}
	}
	if (optionalBoolean(params.enter)) result += "\r";
	if (!result) throw new Error("Send-PtyInput requires text, keys, or -Enter");
	return result;
}

/** Owns all session-scoped interactive services and the PowerShell RPC endpoint. */
export class PwshSessionRuntime {
	readonly ptys: PtySessionManager;
	readonly users: UserRequestManager;
	readonly rpc: PwshRpcServer;
	readonly notifications: JobNotificationManager;
	private closed = false;
	private readonly sessionId: string;

	constructor(pi: ExtensionAPI, ctx: ExtensionContext, readonly pwsh: ResolvedPwshRuntime) {
		this.sessionId = ctx.sessionManager.getSessionId();
		this.ptys = new PtySessionManager(pwsh, ctx.cwd);
		this.users = new UserRequestManager(ctx, this.ptys);
		this.rpc = new PwshRpcServer((request, signal) => this.handle(request, signal));
		this.notifications = new JobNotificationManager(pi, ctx, this.sessionId);
	}

	get env(): Readonly<Record<string, string>> { return this.rpc.env; }

	get jobEnv(): Readonly<Record<string, string>> {
		const userArguments = userPowerShellArguments(this.pwsh, { nonInteractive: true });
		return {
			PIPWSH_NODE: process.execPath,
			PIPWSH_SESSION_ID: this.sessionId,
			PIPWSH_EXECUTABLE: this.pwsh.executable,
			PIPWSH_USER_ARGS: Buffer.from(JSON.stringify(userArguments), "utf8").toString("base64"),
			PIPWSH_STOP_ON_ERROR: this.pwsh.stopOnError ? "1" : "0",
		};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.notifications.close();
		await this.rpc.stop();
		await this.ptys.close();
	}

	private async handle(request: RpcRequest, signal: AbortSignal): Promise<unknown> {
		const params = objectParams(request.params);
		switch (request.method) {
			case "pty.start": {
				const options: StartPtyOptions = {
					command: requiredString(params.command, "command"),
					name: optionalString(params.name, "name"),
					workingDirectory: optionalString(params.workingDirectory, "workingDirectory"),
					environment: environment(params.environment),
					columns: optionalNumber(params.columns, "columns"),
					rows: optionalNumber(params.rows, "rows"),
				};
				return this.ptys.start(options);
			}
			case "pty.list": return this.ptys.list();
			case "pty.get": return this.ptys.get(ptyRef(params));
			case "pty.receive": return this.ptys.receive(ptyRef(params), {
				keep: optionalBoolean(params.keep),
				tail: optionalNumber(params.tail, "tail"),
			});
			case "pty.screen": return this.ptys.screen(ptyRef(params));
			case "pty.send": return this.ptys.write(ptyRef(params), inputSequence(params));
			case "pty.resize": return this.ptys.resize(
				ptyRef(params),
				optionalNumber(params.columns, "columns") ?? 100,
				optionalNumber(params.rows, "rows") ?? 30,
			);
			case "pty.wait": return this.ptys.wait(
				ptyRef(params),
				params.mode === "exit" ? "exit" : "idle",
				optionalNumber(params.timeoutMs, "timeoutMs"),
				optionalNumber(params.idleMs, "idleMs"),
				signal,
			);
			case "pty.stop": return this.ptys.stop(ptyRef(params));
			case "pty.remove": return this.ptys.remove(ptyRef(params), optionalBoolean(params.force));
			case "user.input": return this.users.requestInput(
				requiredString(params.title, "title"),
				requiredString(params.prompt, "prompt"),
				optionalBoolean(params.secret),
				signal,
			);
			case "user.confirm": return this.users.requestConfirmation(
				requiredString(params.title, "title"),
				requiredString(params.message, "message"),
				signal,
			);
			case "user.select": return this.users.requestSelection(
				requiredString(params.title, "title"),
				stringArray(params.options, "options"),
				signal,
			);
			case "user.ptyInput": return this.users.requestPtyInput(
				ptyRef(params),
				requiredString(params.title, "title"),
				requiredString(params.prompt, "prompt"),
				optionalBoolean(params.secret),
				optionalBoolean(params.enter),
				signal,
			);
			default: throw new Error(`Unknown pi-pwsh RPC method: ${request.method}`);
		}
	}
}
