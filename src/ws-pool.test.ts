import { describe, expect, test } from "bun:test";
import { createWebSocketFetch } from "./ws-pool";

class MockWS extends EventTarget {
	static instances: MockWS[] = [];
	url: string;
	options: { headers?: Record<string, string> } | undefined;
	readyState = 0;
	binaryType = "";
	sent: string[] = [];
	constructor(url: string, options?: { headers?: Record<string, string> }) {
		super();
		this.url = url;
		this.options = options;
		MockWS.instances.push(this);
		queueMicrotask(() => {
			this.readyState = 1;
			this.dispatchEvent(new Event("open"));
		});
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.readyState = 3; // invalidate without dispatching a spurious close event
	}
	fireMessage(data: string): void {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}
	fireClose(code = 1001): void {
		this.readyState = 3;
		this.dispatchEvent(Object.assign(new Event("close"), { code }));
	}
}

const tick = () => new Promise((r) => setTimeout(r, 10));

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

function streamingInit(extra: Record<string, unknown> = {}) {
	return { method: "POST", headers: { authorization: "Bearer sk-real" }, body: JSON.stringify({ model: "gpt-5.5", stream: true, ...extra }) };
}

const URL_RESPONSES = "https://lb.example/v1/responses";

// Drive one full clean turn on the latest socket: open → send → completed.
async function runCleanTurn(fetchFn: (i: any, init?: any) => Promise<Response>, beforeIndex = 0): Promise<MockWS> {
	const p = fetchFn(URL_RESPONSES, streamingInit());
	await tick();
	const ws = MockWS.instances[MockWS.instances.length - 1]!;
	void beforeIndex;
	ws.fireMessage(JSON.stringify({ type: "response.output_text.delta", delta: "hi" }));
	ws.fireMessage(JSON.stringify({ type: "response.completed" }));
	const res = await p;
	await readAll(res);
	return ws;
}

describe("createWebSocketFetch routing", () => {
	test("falls through to httpFetch for non-eligible requests", async () => {
		MockWS.instances = [];
		const pool = createWebSocketFetch({ WebSocketImpl: MockWS as any });
		let httpCalls = 0;
		const http = async () => {
			httpCalls++;
			return new Response("ok");
		};
		const f = pool.bind("s1", http);

		await f(URL_RESPONSES, { method: "GET", headers: {} }); // not POST
		await f("https://lb.example/v1/chat", streamingInit()); // not /responses
		await f(URL_RESPONSES, { method: "POST", headers: {}, body: JSON.stringify({ stream: false }) }); // not streaming
		await pool.bind(undefined, http)(URL_RESPONSES, streamingInit()); // no session id

		expect(httpCalls).toBe(4);
		expect(MockWS.instances.length).toBe(0);
		pool.close();
	});
});

describe("createWebSocketFetch pooling", () => {
	test("reuses one socket across turns within a session", async () => {
		MockWS.instances = [];
		const pool = createWebSocketFetch({ WebSocketImpl: MockWS as any });
		const http = async () => new Response("ok");
		const f = pool.bind("sess-A", http);

		const ws1 = await runCleanTurn(f);
		expect(MockWS.instances.length).toBe(1);
		expect(ws1.options?.headers?.["session-id"]).toBe("sess-A");

		const ws2 = await runCleanTurn(f);
		expect(MockWS.instances.length).toBe(1); // same socket reused
		expect(ws2).toBe(ws1);
		expect(ws1.sent.length).toBe(2); // two response.create frames on the one socket
		pool.close();
	});

	test("uses a distinct socket per session", async () => {
		MockWS.instances = [];
		const pool = createWebSocketFetch({ WebSocketImpl: MockWS as any });
		const http = async () => new Response("ok");

		const wsA = await runCleanTurn(pool.bind("A", http));
		const wsB = await runCleanTurn(pool.bind("B", http));
		expect(MockWS.instances.length).toBe(2);
		expect(wsA).not.toBe(wsB);
		pool.close();
	});

	test("invalidates the socket after a non-clean terminal, opening a fresh one next turn", async () => {
		MockWS.instances = [];
		const pool = createWebSocketFetch({ WebSocketImpl: MockWS as any });
		const http = async () => new Response("ok");
		const f = pool.bind("sess-E", http);

		const p = f(URL_RESPONSES, streamingInit());
		await tick();
		const ws1 = MockWS.instances[0]!;
		ws1.fireMessage(JSON.stringify({ type: "error", status: 429, error: { code: "account_stream_cap" } }));
		await readAll(await p);
		expect(ws1.readyState).toBe(3); // invalidated/closed by the pool

		const ws2 = await runCleanTurn(f);
		expect(MockWS.instances.length).toBe(2);
		expect(ws2).not.toBe(ws1);
		pool.close();
	});

	test("remove() drops a session's socket", async () => {
		MockWS.instances = [];
		const pool = createWebSocketFetch({ WebSocketImpl: MockWS as any });
		const http = async () => new Response("ok");
		const f = pool.bind("sess-R", http);
		const ws1 = await runCleanTurn(f);
		pool.remove("sess-R");
		expect(ws1.readyState).toBe(3);
		const ws2 = await runCleanTurn(f);
		expect(ws2).not.toBe(ws1);
		pool.close();
	});
});
