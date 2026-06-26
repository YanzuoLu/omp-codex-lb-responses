import { describe, expect, test } from "bun:test";
import { createBridgeHandler, startLocalBridge } from "./local-bridge";

function fakePool(captured: Record<string, any>) {
	return {
		bind(sid: string | undefined, httpFetch: any) {
			return async (url: any, init: any) => {
				captured.sid = sid;
				captured.url = url;
				captured.init = init;
				captured.httpFetch = httpFetch;
				return new Response('data: {"type":"response.completed"}\n\ndata: [DONE]\n\n', {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			};
		},
		remove() {},
		close() {},
	} as any;
}

describe("createBridgeHandler", () => {
	test("POST …/responses forwards to codex-lb over the pool with Bearer auth + body passthrough", async () => {
		const cap: Record<string, any> = {};
		const sessions: string[] = [];
		const handle = createBridgeHandler({
			pool: fakePool(cap),
			baseUrl: "https://lb.example/v1",
			apiKey: "sk-clb-x",
			port: 0,
			models: [{ id: "gpt-5.5" }],
			onSession: (s) => sessions.push(s),
		});
		const body = JSON.stringify({ model: "gpt-5.5", stream: true, prompt_cache_key: "sess-1", input: [] });
		const res = await handle(new Request("http://127.0.0.1/v1/responses", { method: "POST", body }));
		expect(cap.url).toBe("https://lb.example/v1/responses");
		expect(cap.init.method).toBe("POST");
		expect(cap.init.headers.Authorization).toBe("Bearer sk-clb-x");
		expect(cap.init.headers["OpenAI-Beta"]).toBe("responses=experimental");
		expect(cap.init.body).toBe(body); // passed through unchanged
		expect(cap.sid).toBe("sess-1"); // keyed off prompt_cache_key
		expect(sessions).toEqual(["sess-1"]);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
	});

	test("keys off a session-id header when there is no prompt_cache_key", async () => {
		const cap: Record<string, any> = {};
		const handle = createBridgeHandler({ pool: fakePool(cap), baseUrl: "https://lb.example/v1", apiKey: "k", port: 0 });
		await handle(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "session-id": "hdr-9" }, body: "{}" }));
		expect(cap.sid).toBe("hdr-9");
	});

	test("falls back to a generated session id", async () => {
		const cap: Record<string, any> = {};
		const handle = createBridgeHandler({ pool: fakePool(cap), baseUrl: "https://lb.example/v1", apiKey: "k", port: 0 });
		await handle(new Request("http://127.0.0.1/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-5.5", stream: true }) }));
		expect(typeof cap.sid).toBe("string");
		expect((cap.sid as string).startsWith("bridge-")).toBe(true);
	});

	test("GET …/models returns the catalog", async () => {
		const handle = createBridgeHandler({ pool: fakePool({}), baseUrl: "https://lb.example/v1", apiKey: "k", port: 0, models: [{ id: "gpt-5.5" }, { id: "gpt-5.4" }] });
		const res = await handle(new Request("http://127.0.0.1/v1/models", { method: "GET" }));
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.object).toBe("list");
		expect(json.data.map((m: any) => m.id)).toEqual(["gpt-5.5", "gpt-5.4"]);
	});

	test("404 for unknown paths", async () => {
		const handle = createBridgeHandler({ pool: fakePool({}), baseUrl: "https://lb.example/v1", apiKey: "k", port: 0 });
		const res = await handle(new Request("http://127.0.0.1/v1/other", { method: "GET" }));
		expect(res.status).toBe(404);
	});

	test("returns 502 when the pool fetch throws", async () => {
		const pool = { bind: () => async () => { throw new Error("boom"); }, remove() {}, close() {} } as any;
		const handle = createBridgeHandler({ pool, baseUrl: "https://lb.example/v1", apiKey: "k", port: 0 });
		const res = await handle(new Request("http://127.0.0.1/v1/responses", { method: "POST", body: "{}" }));
		expect(res.status).toBe(502);
	});
});

describe("startLocalBridge", () => {
	test("serves on 127.0.0.1:port and returns a handle", () => {
		let served: any;
		const h = startLocalBridge({
			pool: fakePool({}),
			baseUrl: "https://lb.example/v1",
			apiKey: "k",
			port: 8787,
			serve: (o: any) => { served = o; return { stop() {}, unref() {} }; },
		});
		expect(served.port).toBe(8787);
		expect(served.hostname).toBe("127.0.0.1");
		expect(typeof served.fetch).toBe("function");
		expect(h?.port).toBe(8787);
	});

	test("reuses an existing bridge on EADDRINUSE instead of failing", () => {
		const h = startLocalBridge({
			pool: fakePool({}),
			baseUrl: "https://lb.example/v1",
			apiKey: "k",
			port: 8787,
			serve: () => { const e: any = new Error("address already in use"); e.code = "EADDRINUSE"; throw e; },
		});
		expect(h?.port).toBe(8787);
	});
});
