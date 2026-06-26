import { describe, expect, test } from "bun:test";
import {
	connectResponsesWebSocket,
	injectWebSearchTool,
	streamResponsesWebSocket,
	toWsUrl,
	type WebSocketLike,
} from "./ws-bridge";

class MockWebSocket extends EventTarget implements WebSocketLike {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSED = 3;
	static instances: MockWebSocket[] = [];
	url: string;
	options: { headers?: Record<string, string> } | undefined;
	binaryType = "";
	readyState = MockWebSocket.CONNECTING;
	sent: string[] = [];
	constructor(url: string, options?: { headers?: Record<string, string> }) {
		super();
		this.url = url;
		this.options = options;
		MockWebSocket.instances.push(this);
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}
	fireOpen(): void {
		this.readyState = MockWebSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}
	fireMessage(data: string): void {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}
	fireClose(code = 1000): void {
		this.readyState = MockWebSocket.CLOSED;
		this.dispatchEvent(Object.assign(new Event("close"), { code }));
	}
	fireError(message = "boom"): void {
		this.dispatchEvent(Object.assign(new Event("error"), { message }));
	}
}

function openSocket(): MockWebSocket {
	const ws = new MockWebSocket("wss://lb.example/v1/responses");
	ws.readyState = MockWebSocket.OPEN;
	return ws;
}

async function readAll(res: Response): Promise<string> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let out = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (value) out += decoder.decode(value);
		if (done) break;
	}
	return out;
}

describe("toWsUrl", () => {
	test("maps https→wss and http→ws, preserving host/path/query", () => {
		expect(toWsUrl("https://lb.example/v1/responses")).toBe("wss://lb.example/v1/responses");
		expect(toWsUrl("http://127.0.0.1:2455/v1/responses?x=1")).toBe("ws://127.0.0.1:2455/v1/responses?x=1");
	});
});

describe("connectResponsesWebSocket", () => {
	test("resolves once open and sets the responses_websockets beta header", async () => {
		MockWebSocket.instances = [];
		const p = connectResponsesWebSocket({
			url: "https://lb.example/v1/responses",
			headers: { authorization: "Bearer sk-real" },
			WebSocketImpl: MockWebSocket as unknown as typeof MockWebSocket & (new (u: string, o?: any) => WebSocketLike),
		});
		const ws = MockWebSocket.instances[0]!;
		expect(ws.url).toBe("wss://lb.example/v1/responses");
		expect(ws.options?.headers?.["openai-beta"]).toBe("responses_websockets=2026-02-06");
		expect(ws.options?.headers?.["authorization"]).toBe("Bearer sk-real");
		ws.fireOpen();
		await expect(p).resolves.toBe(ws as unknown as WebSocketLike);
	});

	test("normalizes mixed-case header keys so the beta rewrite never emits a duplicate (root cause of upstream 1011)", async () => {
		MockWebSocket.instances = [];
		// Headers that bypass normalizeHeaders (e.g. buildSearchHeaders) arrive mixed-case.
		const p = connectResponsesWebSocket({
			url: "https://lb.example/v1/responses",
			headers: {
				Authorization: "Bearer sk-real",
				"OpenAI-Beta": "responses=experimental",
				originator: "pi",
				Accept: "text/event-stream",
				"Content-Type": "application/json",
			},
			WebSocketImpl: MockWebSocket as unknown as typeof MockWebSocket & (new (u: string, o?: any) => WebSocketLike),
		});
		const ws = MockWebSocket.instances[0]!;
		const headers = ws.options?.headers ?? {};
		// Exactly one beta header, under the lowercase key, carrying the websocket protocol —
		// NOT the experimental value, and NOT a mixed-case duplicate.
		const betaKeys = Object.keys(headers).filter((k) => k.toLowerCase() === "openai-beta");
		expect(betaKeys).toEqual(["openai-beta"]);
		expect(headers["openai-beta"]).toBe("responses_websockets=2026-02-06");
		expect(headers["OpenAI-Beta"]).toBeUndefined();
		expect(Object.values(headers)).not.toContain("responses=experimental");
		// Auth preserved (lowercased key); content-type/accept stripped for the upgrade.
		expect(headers["authorization"]).toBe("Bearer sk-real");
		expect(headers["content-type"]).toBeUndefined();
		expect(headers["accept"]).toBeUndefined();
		ws.fireOpen();
		await p;
	});
});

describe("streamResponsesWebSocket", () => {
	test("relays Responses frames as data: SSE ending with [DONE]", async () => {
		const ws = openSocket();
		const res = streamResponsesWebSocket({ socket: ws, body: { model: "gpt-5.5", input: "hi", stream: true } });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		// response.create frame is sent (stream/background stripped)
		expect(ws.sent).toHaveLength(1);
		const sent = JSON.parse(ws.sent[0]!);
		expect(sent.type).toBe("response.create");
		expect(sent.model).toBe("gpt-5.5");
		expect(sent.stream).toBeUndefined();

		ws.fireMessage(JSON.stringify({ type: "response.output_text.delta", delta: "OK" }));
		ws.fireMessage(JSON.stringify({ type: "response.completed", response: { id: "r1" } }));
		const text = await readAll(res);
		expect(text).toContain('data: {"type":"response.output_text.delta","delta":"OK"}');
		expect(text).toContain('data: {"type":"response.completed"');
		expect(text.trim().endsWith("data: [DONE]")).toBe(true);
		// The bridge leaves the socket OPEN on a clean completion so the pool can reuse it.
		expect(ws.readyState).toBe(MockWebSocket.OPEN);
	});

	test("filters codex.* vendor frames (rate_limits, keepalive) but still tracks liveness", async () => {
		const ws = openSocket();
		let firstFired = 0;
		const res = streamResponsesWebSocket({ socket: ws, body: { model: "gpt-5.5" }, onFirstEvent: () => firstFired++ });
		ws.fireMessage(JSON.stringify({ type: "codex.rate_limits", plan_type: "pro" }));
		ws.fireMessage(JSON.stringify({ type: "codex.keepalive" }));
		ws.fireMessage(JSON.stringify({ type: "response.output_text.delta", delta: "x" }));
		ws.fireMessage(JSON.stringify({ type: "response.completed" }));
		const text = await readAll(res);
		expect(firstFired).toBe(1); // first frame (rate_limits) ends the first-event phase exactly once
		expect(text).not.toContain("codex.rate_limits");
		expect(text).not.toContain("codex.keepalive");
		expect(text).toContain("response.output_text.delta");
	});

	test("injects a synthetic retryable error frame when the socket closes before a terminal", async () => {
		const ws = openSocket();
		let invalid = 0;
		const res = streamResponsesWebSocket({
			socket: ws,
			body: { model: "gpt-5.5" },
			onConnectionInvalid: () => invalid++,
		});
		ws.fireMessage(JSON.stringify({ type: "response.output_text.delta", delta: "hi" }));
		ws.fireClose(1001);
		const text = await readAll(res);
		expect(text).toContain("response.output_text.delta");
		const errLine = text.split("\n").find((l) => l.startsWith("data:") && l.includes("server_error"))!;
		const payload = JSON.parse(errLine.slice("data:".length).trim());
		expect(payload.type).toBe("error");
		expect(payload.code).toBe("server_error");
		expect(payload.message).toContain("closed before terminal");
		expect(text).not.toContain("[DONE]"); // not a clean completion
		expect(invalid).toBe(1);
	});

	test("does NOT inject a synthetic error when a terminal was already seen, even on a late close", async () => {
		const ws = openSocket();
		let invalid = 0;
		const res = streamResponsesWebSocket({ socket: ws, body: { model: "gpt-5.5" }, onConnectionInvalid: () => invalid++ });
		ws.fireMessage(JSON.stringify({ type: "response.completed" }));
		ws.fireClose();
		const text = await readAll(res);
		expect(text).toContain("response.completed");
		expect(text).not.toContain("server_error");
		expect(invalid).toBe(0);
	});

	test("surfaces a mid-stream socket error as a retryable error frame", async () => {
		const ws = openSocket();
		const res = streamResponsesWebSocket({ socket: ws, body: { model: "gpt-5.5" } });
		ws.fireMessage(JSON.stringify({ type: "response.output_text.delta", delta: "hi" }));
		ws.fireError("socket reset");
		const text = await readAll(res);
		expect(text).toContain("server_error");
		expect(text).toContain("socket reset");
	});

	test("forwards a server error frame (e.g. 429) verbatim and ends the stream", async () => {
		const ws = openSocket();
		let terminal: any;
		const res = streamResponsesWebSocket({ socket: ws, body: { model: "gpt-5.5" }, onTerminal: (e) => (terminal = e) });
		ws.fireMessage(
			JSON.stringify({ type: "error", status: 429, error: { code: "account_stream_cap", message: "degraded" } }),
		);
		const text = await readAll(res);
		expect(text).toContain("account_stream_cap");
		expect(terminal?.type).toBe("error");
		// Bridge stays hands-off on the socket; the pool invalidates it on a non-clean terminal.
		expect(ws.readyState).toBe(MockWebSocket.OPEN);
	});

	test("injectWebSearch adds the hosted web_search tool to the response.create frame", async () => {
		const ws = openSocket();
		streamResponsesWebSocket({ socket: ws, body: { model: "gpt-5.5", input: "q" }, injectWebSearch: true });
		const sent = JSON.parse(ws.sent[0]!);
		expect(sent.tools).toEqual([{ type: "web_search" }]);
	});
});

describe("injectWebSearchTool", () => {
	test("adds web_search when absent", () => {
		expect(injectWebSearchTool({ model: "gpt-5.5" }).tools).toEqual([{ type: "web_search" }]);
	});
	test("is a no-op when a hosted web_search tool is already present", () => {
		const body = { tools: [{ type: "web_search" }] };
		expect(injectWebSearchTool(body)).toEqual(body);
	});
	test("replaces omp's client-side function web_search with the hosted tool", () => {
		const out = injectWebSearchTool({
			tools: [
				{ type: "function", name: "web_search" },
				{ type: "function", name: "shell" },
			],
		});
		const tools = out.tools as Array<{ type: string; name?: string }>;
		expect(tools.some((t) => t.type === "web_search")).toBe(true);
		expect(tools.some((t) => t.type === "function" && t.name === "web_search")).toBe(false);
		expect(tools.some((t) => t.type === "function" && t.name === "shell")).toBe(true);
	});
});
