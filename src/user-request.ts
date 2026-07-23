import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Input,
	truncateToWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import { type PtyRef, PtySessionManager } from "./pty-manager.ts";

class UserRequestError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
		this.name = "UserRequestError";
	}
}

class InputDialogComponent implements Component, Focusable {
	private readonly input = new Input();
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private _focused = false;

	constructor(
		private readonly title: string,
		private readonly prompt: string,
		private readonly secret: boolean,
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
		// pi's built-in ui.input dialog never renders the prompt, so draw our own.
		// Secret entry masks the value manually; plain entry reuses Input.render
		// for full cursor/scroll/IME fidelity.
		const inputLine = this.secret
			? truncateToWidth(`> ${"•".repeat([...this.input.getValue()].length)}${this.focused ? CURSOR_MARKER : ""}\x1b[7m \x1b[27m`, width)
			: this.input.render(width)[0];
		this.cachedLines = [
			truncateToWidth(this.title, width),
			truncateToWidth(this.prompt, width),
			inputLine,
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
			if (secret && this.ctx.mode !== "tui") throw new UserRequestError("Secret input requires pi's TUI mode", "UI_UNAVAILABLE");
			const value = this.ctx.mode === "tui"
				? await this.customInput(title, prompt, secret, signal)
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

	private requestInputDirect(title: string, prompt: string, secret: boolean, signal?: AbortSignal): Promise<string> {
		if (!this.ctx.hasUI) return Promise.reject(new UserRequestError("User input requires an interactive UI", "UI_UNAVAILABLE"));
		if (secret && this.ctx.mode !== "tui") return Promise.reject(new UserRequestError("Secret input requires pi's TUI mode", "UI_UNAVAILABLE"));
		if (this.ctx.mode === "tui") return this.customInput(title, prompt, secret, signal);
		return this.ctx.ui.input(title, prompt, { signal }).then((value) => {
			if (value === undefined) throw new UserRequestError("User cancelled the input request", "CANCELLED");
			return value;
		});
	}

	private customInput(title: string, prompt: string, secret: boolean, signal?: AbortSignal): Promise<string> {
		return this.ctx.ui.custom<string | undefined>((tui, _theme, _kb, done) => {
			let finished = false;
			const finish = (value: string | undefined) => {
				if (finished) return;
				finished = true;
				done(value);
			};
			const component = new InputDialogComponent(title, prompt, secret, () => tui.requestRender(), finish);
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
			if (value === undefined) throw new UserRequestError("User cancelled the input request", "CANCELLED");
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
