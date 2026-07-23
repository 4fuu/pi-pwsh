import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

const MAX_REQUEST_BYTES = 1024 * 1024;

export interface RpcRequest {
	id: string;
	method: string;
	params?: unknown;
}

export type RpcHandler = (request: RpcRequest, signal: AbortSignal) => Promise<unknown>;

interface WireRequest extends RpcRequest {
	version: 1;
	token: string;
}

interface WireResponse {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: { message: string; code?: string };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function tokenMatches(expected: string, actual: unknown): boolean {
	if (typeof actual !== "string") return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(actual, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Session-scoped JSON-lines RPC server exposed to the PowerShell helper functions. */
export class PwshRpcServer {
	readonly pipeName = `pi-pwsh-${process.pid}-${randomBytes(12).toString("hex")}`;
	readonly token = randomBytes(32).toString("base64url");
	readonly pipePath = `\\\\.\\pipe\\${this.pipeName}`;

	private server: Server | undefined;
	private readonly sockets = new Set<Socket>();

	constructor(private readonly handler: RpcHandler) {}

	get env(): Readonly<Record<string, string>> {
		return {
			PI_PWSH_RPC_PIPE: this.pipeName,
			PI_PWSH_RPC_TOKEN: this.token,
		};
	}

	async start(): Promise<void> {
		if (this.server) return;
		const server = createServer((socket) => this.accept(socket));
		this.server = server;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => {
					server.removeListener("listening", onListening);
					reject(error);
				};
				const onListening = () => {
					server.removeListener("error", onError);
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(this.pipePath);
			});
		} catch (error) {
			this.server = undefined;
			throw error;
		}
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		if (!server || !server.listening) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private accept(socket: Socket): void {
		this.sockets.add(socket);
		socket.setEncoding("utf8");
		let buffer = "";
		let dispatched = false;
		const controller = new AbortController();

		const reply = (response: WireResponse) => {
			if (socket.destroyed) return;
			socket.end(`${JSON.stringify(response)}\n`);
		};

		socket.on("data", (chunk: string) => {
			if (dispatched) return;
			buffer += chunk;
			if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
				dispatched = true;
				reply({ id: "", ok: false, error: { message: "RPC request is too large", code: "REQUEST_TOO_LARGE" } });
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			dispatched = true;
			let request: WireRequest;
			try {
				request = JSON.parse(buffer.slice(0, newline)) as WireRequest;
			} catch {
				reply({ id: "", ok: false, error: { message: "Invalid RPC JSON", code: "INVALID_JSON" } });
				return;
			}
			if (request.version !== 1 || !tokenMatches(this.token, request.token)) {
				reply({ id: typeof request.id === "string" ? request.id : "", ok: false, error: { message: "RPC authentication failed", code: "UNAUTHORIZED" } });
				return;
			}
			if (typeof request.id !== "string" || typeof request.method !== "string") {
				reply({ id: "", ok: false, error: { message: "Invalid RPC request", code: "INVALID_REQUEST" } });
				return;
			}

			void this.handler(request, controller.signal).then(
				(result) => reply({ id: request.id, ok: true, result }),
				(error) => reply({
					id: request.id,
					ok: false,
					error: { message: errorMessage(error), code: errorCode(error) },
				}),
			);
		});
		socket.on("error", () => controller.abort());
		socket.on("close", () => {
			this.sockets.delete(socket);
			controller.abort();
		});
	}
}
