import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import { type PtyRef, PtySessionManager } from "./pty-manager.ts";

class UserRequestError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
		this.name = "UserRequestError";
	}
}

class SecretInputComponent implements Component, Focusable {
	private readonly input = new Input();
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private _focused = false;

	constructor(
		private readonly title: string,
		private readonly prompt: string,
		private readonly requestRender: () => void,
		onSubmit: (value: string | undefined) => void,
	) {
		this.input.onSubmit = (value) => onSubmit(value);
		this.input.onEscape = () => onSubmit(undefined);
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
		this.invalidate();
		this.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const count = [...this.input.getValue()].length;
		const cursor = this.focused ? CURSOR_MARKER : "";
		this.cachedLines = [
			truncateToWidth(this.title, width),
			truncateToWidth(this.prompt, width),
			truncateToWidth(`> ${"•".repeat(count)}${cursor}\x1b[7m \x1b[27m`, width),
			truncateToWidth("Enter submit • Esc cancel", width),
		];
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.input.invalidate();
	}
}

class PtyControlComponent implements Component {
	private unsubscribe: () => void;
	private disposed = false;
	private lastColumns = 0;
	private lastRows = 0;

	constructor(
		private readonly tui: TUI,
		private readonly manager: PtySessionManager,
		private readonly ref: PtyRef,
		private readonly name: string,
		private readonly done: (reason: "detached" | "exited" | "cancelled") => void,
	) {
		this.unsubscribe = manager.subscribe(ref, () => {
			if (this.disposed) return;
			if (manager.get(ref).state !== "Running") this.done("exited");
			else this.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (data === "\x1d" || matchesKey(data, Key.ctrl("]"))) {
			this.done("detached");
			return;
		}
		if (this.manager.get(this.ref).state !== "Running") {
			this.done("exited");
			return;
		}
		void this.manager.write(this.ref, data).catch(() => this.done("exited"));
	}

	render(width: number): string[] {
		const columns = Math.max(20, width);
		const rows = Math.max(5, this.tui.terminal.rows - 3);
		if (columns !== this.lastColumns || rows !== this.lastRows) {
			this.lastColumns = columns;
			this.lastRows = rows;
			try { this.manager.resize(this.ref, columns, rows); } catch {}
		}
		const screen = this.manager.getScreenSync(this.ref);
		const lines = screen.lines.slice(-rows);
		while (lines.length < rows) lines.push("");
		const cursorRow = Math.max(0, Math.min(lines.length - 1, screen.cursor.row));
		const cursorColumn = Math.max(0, Math.min(columns - 1, screen.cursor.column));
		const current = lines[cursorRow] ?? "";
		const padded = current.padEnd(cursorColumn + 1, " ");
		lines[cursorRow] = `${padded.slice(0, cursorColumn)}\x1b[7m${padded[cursorColumn] ?? " "}\x1b[27m${padded.slice(cursorColumn + 1)}`;
		return [
			truncateToWidth(`PTY ${this.name} — Ctrl+] returns control to pi`, width),
			...lines.map((line) => truncateToWidth(line, width, "")),
		];
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
	}
}

/** Serializes dialogs and connects user interaction to PTY sessions. */
export class UserRequestManager {
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly ctx: ExtensionContext,
		private readonly ptys: PtySessionManager,
	) {}

	requestInput(title: string, prompt: string, secret: boolean, signal?: AbortSignal): Promise<string> {
		return this.enqueue(signal, async () => {
			if (!this.ctx.hasUI) throw new UserRequestError("User input requires an interactive UI", "UI_UNAVAILABLE");
			const value = secret
				? await this.secretInput(title, prompt, signal)
				: await this.ctx.ui.input(title, prompt, { signal });
			if (value === undefined) throw new UserRequestError("User cancelled the input request", "CANCELLED");
			return value;
		});
	}

	requestConfirmation(title: string, message: string, signal?: AbortSignal): Promise<boolean> {
		return this.enqueue(signal, async () => {
			if (!this.ctx.hasUI) throw new UserRequestError("Confirmation requires an interactive UI", "UI_UNAVAILABLE");
			return this.ctx.ui.confirm(title, message, { signal });
		});
	}

	requestSelection(title: string, options: string[], signal?: AbortSignal): Promise<string> {
		return this.enqueue(signal, async () => {
			if (!this.ctx.hasUI) throw new UserRequestError("Selection requires an interactive UI", "UI_UNAVAILABLE");
			if (options.length === 0) throw new UserRequestError("Selection requires at least one option", "INVALID_ARGUMENT");
			const value = await this.ctx.ui.select(title, options, { signal });
			if (value === undefined) throw new UserRequestError("User cancelled the selection request", "CANCELLED");
			return value;
		});
	}

	requestPtyInput(ref: PtyRef, title: string, prompt: string, secret: boolean, enter: boolean, signal?: AbortSignal): Promise<{ submitted: true }> {
		return this.enqueue(signal, async () => {
			const value = await this.requestInputDirect(title, prompt, secret, signal);
			await this.ptys.write(ref, value + (enter ? "\r" : ""));
			return { submitted: true as const };
		});
	}

	requestPtyControl(ref: PtyRef, signal?: AbortSignal): Promise<{ reason: string; metadata: ReturnType<PtySessionManager["get"]> }> {
		return this.enqueue(signal, async () => {
			if (this.ctx.mode !== "tui") throw new UserRequestError("PTY control requires pi's TUI mode", "UI_UNAVAILABLE");
			const metadata = this.ptys.get(ref);
			if (metadata.state !== "Running") throw new UserRequestError(`PTY '${metadata.name}' is not running`, "NOT_RUNNING");
			const reason = await this.ctx.ui.custom<"detached" | "exited" | "cancelled">((tui, _theme, _kb, done) => {
				let finished = false;
				const finish = (value: "detached" | "exited" | "cancelled") => {
					if (finished) return;
					finished = true;
					done(value);
				};
				const component = new PtyControlComponent(tui, this.ptys, ref, metadata.name, finish);
				const onAbort = () => finish("cancelled");
				signal?.addEventListener("abort", onAbort, { once: true });
				return {
					render: (width) => component.render(width),
					handleInput: (data) => component.handleInput(data),
					invalidate: () => component.invalidate(),
					dispose: () => {
						signal?.removeEventListener("abort", onAbort);
						component.dispose();
					},
				};
			});
			return { reason, metadata: this.ptys.get(ref) };
		});
	}

	private requestInputDirect(title: string, prompt: string, secret: boolean, signal?: AbortSignal): Promise<string> {
		if (!this.ctx.hasUI) return Promise.reject(new UserRequestError("User input requires an interactive UI", "UI_UNAVAILABLE"));
		return secret ? this.secretInput(title, prompt, signal) : this.ctx.ui.input(title, prompt, { signal }).then((value) => {
			if (value === undefined) throw new UserRequestError("User cancelled the input request", "CANCELLED");
			return value;
		});
	}

	private secretInput(title: string, prompt: string, signal?: AbortSignal): Promise<string> {
		if (this.ctx.mode !== "tui") throw new UserRequestError("Secret input requires pi's TUI mode", "UI_UNAVAILABLE");
		return this.ctx.ui.custom<string | undefined>((tui, _theme, _kb, done) => {
			let finished = false;
			const finish = (value: string | undefined) => {
				if (finished) return;
				finished = true;
				done(value);
			};
			const component = new SecretInputComponent(title, prompt, () => tui.requestRender(), finish);
			const onAbort = () => finish(undefined);
			signal?.addEventListener("abort", onAbort, { once: true });
			return {
				get focused() { return component.focused; },
				set focused(value: boolean) { component.focused = value; },
				render: (width) => component.render(width),
				handleInput: (data) => component.handleInput(data),
				invalidate: () => component.invalidate(),
				dispose: () => signal?.removeEventListener("abort", onAbort),
			};
		}).then((value) => {
			if (value === undefined) throw new UserRequestError("User cancelled the secret input request", "CANCELLED");
			return value;
		});
	}

	private enqueue<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
		if (signal?.aborted) return Promise.reject(new UserRequestError("User request cancelled", "CANCELLED"));
		const run = this.queue.then(async () => {
			if (signal?.aborted) throw new UserRequestError("User request cancelled", "CANCELLED");
			return operation();
		});
		this.queue = run.then(() => {}, () => {});
		return run;
	}
}
