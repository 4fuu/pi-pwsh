import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type * as XtermHeadless from "@xterm/headless";
import type * as NodePty from "node-pty";
import type { IDisposable, IPty } from "node-pty";
import { createRuntimeEnv, EXIT_EPILOGUE } from "./spawn.ts";

const require = createRequire(import.meta.url);
let dependencies: { Terminal: typeof XtermHeadless.Terminal; spawn: typeof NodePty.spawn } | undefined;
function loadPtyDependencies(): { Terminal: typeof XtermHeadless.Terminal; spawn: typeof NodePty.spawn } {
	return dependencies ??= {
		Terminal: (require("@xterm/headless") as typeof XtermHeadless).Terminal,
		spawn: (require("node-pty") as typeof NodePty).spawn,
	};
}

const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 30;
const DEFAULT_SCROLLBACK = 5000;
const MAX_TRANSCRIPT_CHARS = 1024 * 1024;
const DEFAULT_IDLE_MS = 300;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

export type PtyState = "Running" | "Completed" | "Failed" | "Stopped";
export interface PtyRef { id?: number; name?: string }

export interface PtyMetadata {
	id: number;
	name: string;
	state: PtyState;
	pid: number;
	command: string;
	workingDirectory: string;
	columns: number;
	rows: number;
	hasMoreData: boolean;
	exitCode: number | null;
	startedAt: string;
}

export interface PtyScreen {
	columns: number;
	rows: number;
	lines: string[];
	cursor: { row: number; column: number };
	bufferType: "normal" | "alternate";
}

export interface StartPtyOptions {
	command: string;
	name?: string;
	workingDirectory?: string;
	environment?: Record<string, string>;
	columns?: number;
	rows?: number;
}

export interface ReceivePtyOptions {
	keep?: boolean;
	tail?: number;
}

interface PtySession {
	id: number;
	name: string;
	command: string;
	workingDirectory: string;
	startedAt: string;
	pty: IPty;
	terminal: XtermHeadless.Terminal;
	dataDisposable: IDisposable;
	exitDisposable: IDisposable;
	state: PtyState;
	exitCode: number | null;
	transcript: string;
	readOffset: number;
	lastOutputAt: number;
	outputVersion: number;
	listeners: Set<() => void>;
	writeQueue: Promise<void>;
}

class PtyManagerError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
		this.name = "PtyManagerError";
	}
}

function assertInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new PtyManagerError(`${name} must be an integer between ${minimum} and ${maximum}`, "INVALID_ARGUMENT");
	}
	return value;
}

function cleanTerminalText(data: string): string {
	return data
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1bP[\s\S]*?\x1b\\/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[@-_]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, "");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new PtyManagerError("Operation cancelled", "CANCELLED"));
	return new Promise((resolveDelay, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			cleanup();
			resolveDelay();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(new PtyManagerError("Operation cancelled", "CANCELLED"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		timer.unref?.();
	});
}

function toPtyEnv(environment: NodeJS.ProcessEnv): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(environment)) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

interface InternalSocket { destroy(): void; on(event: "error", listener: () => void): void }
interface InternalWindowsPty {
	_socket?: InternalSocket;
	_agent?: {
		_conoutSocketWorker?: {
			dispose(): void;
			_worker?: { on(event: "error", listener: () => void): void };
		};
		_inSocket?: InternalSocket;
		_outSocket?: InternalSocket;
		_ptyNative?: { kill(pty: number, useConptyDll: boolean): void };
		_pty?: number;
		_useConptyDll?: boolean;
	};
}

function suppressNativeErrors(internal: InternalWindowsPty): void {
	const agent = internal._agent;
	const ignoreError = () => {};
	try { internal._socket?.on("error", ignoreError); } catch {}
	try { agent?._inSocket?.on("error", ignoreError); } catch {}
	try { agent?._outSocket?.on("error", ignoreError); } catch {}
	try { agent?._conoutSocketWorker?._worker?.on("error", ignoreError); } catch {}
}

/** Release node-pty's Windows worker after a natural exit (not exposed by IPty). */
function disposeExitedPty(pty: IPty): void {
	const internal = pty as unknown as InternalWindowsPty;
	const agent = internal._agent;
	suppressNativeErrors(internal);
	try { agent?._inSocket?.destroy(); } catch {}
	// Let node-pty's worker drain its output pipe before termination; destroying
	// the output socket here races the worker and can surface an unhandled EPIPE.
	try { agent?._conoutSocketWorker?.dispose(); } catch {}
}

/** Kill ConPTY without node-pty's racy console-list helper, then release handles. */
function terminatePty(pty: IPty): void {
	const internal = pty as unknown as InternalWindowsPty;
	const agent = internal._agent;
	suppressNativeErrors(internal);
	// Wait for taskkill to enumerate and terminate descendants before closing
	// ConPTY; closing the root first can orphan grandchildren.
	try {
		spawnSync("taskkill", ["/pid", String(pty.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
			timeout: 5000,
		});
	} catch {}
	try { agent?._inSocket?.destroy(); } catch {}
	try {
		if (agent?._ptyNative && agent._pty !== undefined) {
			agent._ptyNative.kill(agent._pty, agent._useConptyDll ?? false);
		}
	} catch {}
	try { agent?._conoutSocketWorker?.dispose(); } catch {}
}

/** Session-scoped owner for interactive ConPTY processes. */
export class PtySessionManager {
	private readonly sessions = new Map<number, PtySession>();
	private nextId = 1;

	constructor(
		private readonly pwshExecutable: string,
		private readonly defaultCwd: string,
	) {}

	async start(options: StartPtyOptions): Promise<PtyMetadata> {
		const command = options.command?.trim();
		if (!command) throw new PtyManagerError("Start-Pty requires a non-empty command", "INVALID_ARGUMENT");
		const cwd = resolve(options.workingDirectory || this.defaultCwd);
		try {
			await access(cwd);
		} catch {
			throw new PtyManagerError(`Working directory does not exist: ${cwd}`, "INVALID_ARGUMENT");
		}
		const columns = assertInteger(options.columns, DEFAULT_COLUMNS, 20, 500, "Columns");
		const rows = assertInteger(options.rows, DEFAULT_ROWS, 5, 200, "Rows");
		const id = this.nextId++;
		const name = options.name?.trim() || `Pty${id}`;
		if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
			throw new PtyManagerError("PTY names may contain letters, digits, '.', '_' and '-'", "INVALID_ARGUMENT");
		}
		if ([...this.sessions.values()].some((session) => session.name.toLowerCase() === name.toLowerCase())) {
			throw new PtyManagerError(`A PTY named '${name}' already exists`, "ALREADY_EXISTS");
		}

		const { Terminal, spawn } = loadPtyDependencies();
		const terminal = new Terminal({ cols: columns, rows, scrollback: DEFAULT_SCROLLBACK, allowProposedApi: true });
		const env = createRuntimeEnv({
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			...(options.environment ?? {}),
		});
		const prefix = "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); if ($null -ne $PSStyle) { $PSStyle.OutputRendering = 'Ansi' }; ";
		const pty = spawn(
			this.pwshExecutable,
			["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `${prefix}${command}${EXIT_EPILOGUE}`],
			{
				name: "xterm-256color",
				cols: columns,
				rows,
				cwd,
				env: toPtyEnv(env),
				useConpty: true,
				handleFlowControl: true,
			},
		);

		const session: PtySession = {
			id,
			name,
			command,
			workingDirectory: cwd,
			startedAt: new Date().toISOString(),
			pty,
			terminal,
			dataDisposable: { dispose() {} },
			exitDisposable: { dispose() {} },
			state: "Running",
			exitCode: null,
			transcript: "",
			readOffset: 0,
			lastOutputAt: Date.now(),
			outputVersion: 0,
			listeners: new Set(),
			writeQueue: Promise.resolve(),
		};
		session.dataDisposable = pty.onData((data) => this.handleData(session, data));
		session.exitDisposable = pty.onExit(({ exitCode }) => {
			session.exitCode = exitCode;
			if (session.state === "Running") session.state = exitCode === 0 ? "Completed" : "Failed";
			session.listeners.forEach((listener) => listener());
		});
		this.sessions.set(id, session);
		return this.metadata(session);
	}

	list(): PtyMetadata[] {
		return [...this.sessions.values()].sort((a, b) => a.id - b.id).map((session) => this.metadata(session));
	}

	get(ref: PtyRef): PtyMetadata {
		return this.metadata(this.resolve(ref));
	}

	receive(ref: PtyRef, options: ReceivePtyOptions = {}): { text: string; metadata: PtyMetadata } {
		const session = this.resolve(ref);
		let text: string;
		if (options.tail !== undefined) {
			const tail = assertInteger(options.tail, 0, 1, 10_000, "Tail");
			const lines = session.transcript.trimEnd().split("\n");
			text = lines.slice(Math.max(0, lines.length - tail)).join("\n");
		} else {
			text = session.transcript.slice(session.readOffset);
			if (!options.keep) session.readOffset = session.transcript.length;
		}
		return { text: text.trimEnd(), metadata: this.metadata(session) };
	}

	async screen(ref: PtyRef): Promise<PtyScreen> {
		const session = this.resolve(ref);
		await new Promise<void>((resolveWrite) => session.terminal.write("", resolveWrite));
		return this.screenSync(session);
	}

	getScreenSync(ref: PtyRef): PtyScreen {
		return this.screenSync(this.resolve(ref));
	}

	write(ref: PtyRef, data: string): Promise<PtyMetadata> {
		const session = this.resolve(ref);
		if (session.state !== "Running") throw new PtyManagerError(`PTY '${session.name}' is not running`, "NOT_RUNNING");
		const operation = session.writeQueue.then(() => {
			session.pty.write(data);
		});
		session.writeQueue = operation.catch(() => {});
		return operation.then(() => this.metadata(session));
	}

	resize(ref: PtyRef, columns: number, rows: number): PtyMetadata {
		const session = this.resolve(ref);
		const safeColumns = assertInteger(columns, session.pty.cols, 20, 500, "Columns");
		const safeRows = assertInteger(rows, session.pty.rows, 5, 200, "Rows");
		if (session.state === "Running") session.pty.resize(safeColumns, safeRows);
		session.terminal.resize(safeColumns, safeRows);
		return this.metadata(session);
	}

	async wait(ref: PtyRef, mode: "idle" | "exit", timeoutMs?: number, idleMs?: number, signal?: AbortSignal): Promise<PtyMetadata> {
		const session = this.resolve(ref);
		const timeout = timeoutMs === undefined ? DEFAULT_WAIT_TIMEOUT_MS : assertInteger(timeoutMs, 0, 1, 2_147_483_647, "TimeoutMs");
		const idle = idleMs === undefined ? DEFAULT_IDLE_MS : assertInteger(idleMs, 0, 1, 60_000, "IdleMs");
		const deadline = Date.now() + timeout;
		while (true) {
			if (signal?.aborted) throw new PtyManagerError("Operation cancelled", "CANCELLED");
			if (session.state !== "Running") return this.metadata(session);
			if (mode === "idle") {
				const remainingIdle = idle - (Date.now() - session.lastOutputAt);
				if (remainingIdle <= 0) return this.metadata(session);
				const remainingTotal = deadline - Date.now();
				if (remainingTotal <= 0) return this.metadata(session);
				await delay(Math.min(remainingIdle, remainingTotal), signal);
			} else {
				const remainingTotal = deadline - Date.now();
				if (remainingTotal <= 0) return this.metadata(session);
				await delay(Math.min(100, remainingTotal), signal);
			}
		}
	}

	stop(ref: PtyRef): PtyMetadata {
		const session = this.resolve(ref);
		if (session.state === "Running") {
			session.state = "Stopped";
			terminatePty(session.pty);
			session.listeners.forEach((listener) => listener());
		}
		return this.metadata(session);
	}

	remove(ref: PtyRef, force = false): PtyMetadata {
		const session = this.resolve(ref);
		if (session.state === "Running" && !force) {
			throw new PtyManagerError(`PTY '${session.name}' is still running; stop it first or use -Force`, "STILL_RUNNING");
		}
		if (session.state === "Running") this.stop(ref);
		else disposeExitedPty(session.pty);
		this.sessions.delete(session.id);
		session.dataDisposable.dispose();
		session.exitDisposable.dispose();
		session.terminal.dispose();
		return this.metadata(session);
	}

	subscribe(ref: PtyRef, listener: () => void): () => void {
		const session = this.resolve(ref);
		session.listeners.add(listener);
		return () => session.listeners.delete(listener);
	}

	async close(): Promise<void> {
		for (const session of [...this.sessions.values()]) {
			try { this.remove({ id: session.id }, true); } catch {}
		}
		this.sessions.clear();
	}

	private resolve(ref: PtyRef): PtySession {
		let session: PtySession | undefined;
		if (ref.id !== undefined) session = this.sessions.get(ref.id);
		else if (ref.name) session = [...this.sessions.values()].find((item) => item.name.toLowerCase() === ref.name?.toLowerCase());
		if (!session) {
			const label = ref.id !== undefined ? `Id ${ref.id}` : `'${ref.name ?? ""}'`;
			throw new PtyManagerError(`PTY ${label} was not found`, "NOT_FOUND");
		}
		return session;
	}

	private metadata(session: PtySession): PtyMetadata {
		return {
			id: session.id,
			name: session.name,
			state: session.state,
			pid: session.pty.pid,
			command: session.command,
			workingDirectory: session.workingDirectory,
			columns: session.pty.cols,
			rows: session.pty.rows,
			hasMoreData: session.readOffset < session.transcript.length,
			exitCode: session.exitCode,
			startedAt: session.startedAt,
		};
	}

	private handleData(session: PtySession, data: string): void {
		session.lastOutputAt = Date.now();
		session.outputVersion++;
		const clean = cleanTerminalText(data);
		if (clean) {
			session.transcript += clean;
			if (session.transcript.length > MAX_TRANSCRIPT_CHARS) {
				const remove = session.transcript.length - MAX_TRANSCRIPT_CHARS;
				session.transcript = session.transcript.slice(remove);
				session.readOffset = Math.max(0, session.readOffset - remove);
			}
		}
		session.terminal.write(data, () => session.listeners.forEach((listener) => listener()));
	}

	private screenSync(session: PtySession): PtyScreen {
		const buffer = session.terminal.buffer.active;
		const lines: string[] = [];
		const start = buffer.viewportY;
		for (let row = 0; row < session.terminal.rows; row++) {
			lines.push(buffer.getLine(start + row)?.translateToString(true) ?? "");
		}
		while (lines.length > 1 && lines.at(-1) === "") lines.pop();
		const absoluteCursorRow = buffer.baseY + buffer.cursorY;
		return {
			columns: session.terminal.cols,
			rows: session.terminal.rows,
			lines,
			cursor: {
				row: Math.max(0, Math.min(session.terminal.rows - 1, absoluteCursorRow - buffer.viewportY)),
				column: buffer.cursorX,
			},
			bufferType: buffer.type,
		};
	}
}
