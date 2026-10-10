//
// Fake scripted LLM provider used by the e2e driver (npm run test:e2e).
//
// Registers provider "fake-e2e" with model "scripted". Every LLM call appends
// one JSON line to $FAKE_E2E_DUMP with exactly what the model received:
// the system message (pi 0.99+ carries the system prompt as messages[0] with
// sections and toolsAdded) plus the message history. The assistant reply is
// taken from the next turn of the JSON script at $FAKE_E2E_SCRIPT:
//   { "text": "..." }                       — plain text turn
//   { "toolCall": { "name": ..., "arguments": {...} } } — tool call turn
//
import { appendFileSync, readFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const dumpPath = process.env.FAKE_E2E_DUMP;
let callIndex = 0;

function nextTurn() {
	const script = JSON.parse(readFileSync(process.env.FAKE_E2E_SCRIPT, "utf8"));
	return script[callIndex] ?? { text: "script exhausted" };
}

export default function fakeProviderExtension(pi) {
	pi.registerProvider("fake-e2e", {
		name: "Fake E2E",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "local",
		api: "fake-e2e-stream",
		models: [{
			id: "scripted",
			name: "Scripted",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
		streamSimple(model, _context, options) {
			const stream = createAssistantMessageEventStream();
			const turn = nextTurn();
			const call = callIndex++;
			if (dumpPath) {
				appendFileSync(dumpPath, JSON.stringify({
					call,
					tools: (_context.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
					messages: (_context.messages ?? []).map((m) => ({
						role: m.role,
						content: m.content,
						sections: m.sections,
						toolsAdded: m.toolsAdded,
					})),
				}) + "\n", "utf8");
			}
			(async () => {
				const message = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "pending",
					timestamp: Date.now(),
				};
				try {
					stream.push({ type: "start", partial: message });
					if (turn.text !== undefined) {
						message.content.push({ type: "text", text: turn.text });
						stream.push({ type: "text_start", contentIndex: 0, partial: message });
						stream.push({ type: "text_delta", contentIndex: 0, delta: turn.text, partial: message });
						stream.push({ type: "text_end", contentIndex: 0, content: turn.text, partial: message });
						message.stopReason = "stop";
						stream.push({ type: "done", reason: "stop", message });
					} else if (turn.toolCall) {
						const toolCall = {
							type: "toolCall",
							id: `fake_call_${call}`,
							name: turn.toolCall.name,
							arguments: turn.toolCall.arguments,
						};
						message.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
						stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(turn.toolCall.arguments), partial: message });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
						message.stopReason = "toolUse";
						stream.push({ type: "done", reason: "toolUse", message });
					} else {
						throw new Error(`bad script turn: ${JSON.stringify(turn)}`);
					}
					stream.end();
				} catch (error) {
					message.stopReason = options?.signal?.aborted ? "aborted" : "error";
					message.errorMessage = String(error?.message ?? error);
					stream.push({ type: "error", reason: message.stopReason, error: message });
					stream.end();
				}
			})();
			return stream;
		},
	});
}
