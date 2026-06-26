import { describe, expect, test } from "bun:test";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { activate, defaultModels, makeStreamSimple, readConfig, type CodexLbConfig } from "./index";

const BASE = "https://lb.test/v1";

describe("readConfig", () => {
	test("returns undefined unless BOTH api key and base url are resolved", () => {
		expect(readConfig({}, {})).toBeUndefined();
		expect(readConfig({}, { CODEX_LB_API_KEY: "   " })).toBeUndefined();
		expect(readConfig({}, { CODEX_LB_API_KEY: "k" })).toBeUndefined(); // no base url → no default
		expect(readConfig({}, { CODEX_LB_BASE_URL: BASE })).toBeUndefined(); // no api key
		expect(readConfig({ apiKey: "k" }, {})).toBeUndefined(); // settings: no base url
	});

	test("reads from plugin settings (omp plugin config --set)", () => {
		const c = readConfig({ apiKey: "sk-clb-x", baseUrl: BASE, providerId: "clb", models: "a, b ,", webSearch: "inject" })!;
		expect(c.apiKey).toBe("sk-clb-x");
		expect(c.baseUrl).toBe(BASE);
		expect(c.providerID).toBe("clb");
		expect(c.models.map((m) => m.id)).toEqual(["a", "b"]);
		expect(c.webSearch).toBe("inject");
	});

	test("plugin settings take precedence over env, with env as fallback", () => {
		const c = readConfig(
			{ baseUrl: BASE }, // base url from settings
			{ CODEX_LB_API_KEY: "env-key", CODEX_LB_BASE_URL: "https://ignored/v1" }, // api key from env
		)!;
		expect(c.baseUrl).toBe(BASE); // settings win
		expect(c.apiKey).toBe("env-key"); // env fallback
	});

	test("defaults providerID / models, and strips a trailing slash from baseUrl", () => {
		const c = readConfig({}, { CODEX_LB_API_KEY: "k", CODEX_LB_BASE_URL: "https://host/v1/", CODEX_LB_MODELS: "a, b ," })!;
		expect(c.baseUrl).toBe("https://host/v1");
		expect(c.providerID).toBe("codex-lb");
		expect(c.models.map((m) => m.id)).toEqual(["a", "b"]);
		expect(c.webSearch).toBe("off");
	});

	test("parses webSearch card mode + searchModel default", () => {
		const c = readConfig({ apiKey: "k", baseUrl: BASE, webSearch: "card" })!;
		expect(c.webSearch).toBe("card");
		expect(c.searchModel).toBe("gpt-5.5"); // first default model
		const c2 = readConfig({ apiKey: "k", baseUrl: BASE, webSearch: "tool", searchModel: "gpt-5.4" })!;
		expect(c2.webSearch).toBe("card"); // "tool" is an alias for card
		expect(c2.searchModel).toBe("gpt-5.4");
	});

	test("default models are reasoning models with sane limits", () => {
		const models = defaultModels();
		expect(models.every((m) => m.reasoning)).toBe(true);
		const spark = models.find((m) => m.id === "gpt-5.3-codex-spark")!;
		expect(spark.input).toEqual(["text"]); // no image attachment
		expect(spark.contextWindow).toBe(128_000);
	});
});

describe("activate", () => {
	const fakeBridge = (calls: any[]) => (opts: any) => {
		calls.push(opts);
		return { port: opts.port, close() {} };
	};

	test("starts no bridge and returns undefined when unconfigured", () => {
		const bridges: any[] = [];
		let registered = 0;
		const pool = activate({ registerProvider: () => registered++ }, { env: {}, startBridge: fakeBridge(bridges) });
		expect(registered).toBe(0);
		expect(bridges.length).toBe(0);
		expect(pool).toBeUndefined();
	});

	test("starts the local bridge (NO standalone provider) when configured", () => {
		const bridges: any[] = [];
		let label: string | undefined;
		let registered = 0;
		const pool = activate(
			{ setLabel: (l) => (label = l), registerProvider: () => registered++ },
			{ env: { CODEX_LB_API_KEY: "k", CODEX_LB_BASE_URL: BASE }, WebSocketImpl: class {}, startBridge: fakeBridge(bridges) },
		);
		expect(label).toBe("Codex LB Responses");
		expect(registered).toBe(0); // Option B: the bridge replaces the standalone provider
		expect(bridges).toHaveLength(1);
		expect(bridges[0].baseUrl).toBe(BASE);
		expect(bridges[0].apiKey).toBe("k");
		expect(bridges[0].port).toBe(8787);
		expect(bridges[0].models.length).toBeGreaterThan(0);
		expect(typeof bridges[0].onSession).toBe("function");
		expect(pool).toBeDefined();
		pool?.close();
	});

	test("activates from plugin settings (no env)", () => {
		const bridges: any[] = [];
		const pool = activate(
			{ registerProvider: () => {} },
			{ settings: { apiKey: "k", baseUrl: BASE }, env: {}, WebSocketImpl: class {}, startBridge: fakeBridge(bridges) },
		);
		expect(bridges).toHaveLength(1);
		expect(bridges[0].baseUrl).toBe(BASE);
		pool?.close();
	});

	test("mode=off starts no bridge and returns undefined", () => {
		const bridges: any[] = [];
		const pool = activate(
			{ registerProvider: () => {} },
			{ env: { CODEX_LB_API_KEY: "k", CODEX_LB_BASE_URL: BASE, CODEX_LB_MODE: "off" }, startBridge: fakeBridge(bridges) },
		);
		expect(bridges.length).toBe(0);
		expect(pool).toBeUndefined();
	});

	test("honors a custom bridge port", () => {
		const bridges: any[] = [];
		const pool = activate(
			{ registerProvider: () => {} },
			{ env: { CODEX_LB_API_KEY: "k", CODEX_LB_BASE_URL: BASE, CODEX_LB_BRIDGE_PORT: "9123" }, WebSocketImpl: class {}, startBridge: fakeBridge(bridges) },
		);
		expect(bridges[0].port).toBe(9123);
		pool?.close();
	});
});

describe("makeStreamSimple", () => {
	const config: CodexLbConfig = readConfig({ apiKey: "real-key", baseUrl: BASE })!;

	test("delegates to the inner openai-responses stream with a bound WS fetch and re-tags events", async () => {
		const boundFetch = async () => new Response(null);
		const bindCalls: { sid?: string; http?: unknown } = {};
		const pool = {
			bind: (sid: string | undefined, http: unknown) => {
				bindCalls.sid = sid;
				bindCalls.http = http;
				return boundFetch as never;
			},
			remove() {},
			close() {},
		};

		let innerArgs: { model: any; context: any; options: any } | undefined;
		const fakeInner = (model: any, context: any, options: any) => {
			innerArgs = { model, context, options };
			const s = new AssistantMessageEventStream();
			queueMicrotask(() => {
				s.push({ message: { api: "openai-responses", role: "assistant" } } as never);
				s.end({ api: "openai-responses", role: "assistant" } as never);
			});
			return s;
		};

		const stubCompat = () => ({ __compat: true });
		const streamSimple = makeStreamSimple(config, pool as never, fakeInner as never, AssistantMessageEventStream as never, stubCompat);
		const out = streamSimple(
			{ id: "gpt-5.5", provider: "codex-lb", api: "codex-lb-responses", baseUrl: "ignored", reasoning: true } as never,
			{} as never,
			{ sessionId: "S1", apiKey: "turn-key", reasoning: "medium" },
		);

		// inner model is switched to the plain openai-responses path with our base URL + compat
		expect(innerArgs!.model.api).toBe("openai-responses");
		expect(innerArgs!.model.baseUrl).toBe(config.baseUrl);
		expect(innerArgs!.model.compat).toEqual({ __compat: true });
		// provider-scoped WS fetch + plain key + encrypted reasoning forwarded
		expect(innerArgs!.options.fetch).toBe(boundFetch);
		expect(innerArgs!.options.apiKey).toBe("turn-key");
		expect(innerArgs!.options.includeEncryptedReasoning).toBe(true);
		expect(innerArgs!.options.statefulResponses).toBe(false);
		expect(bindCalls.sid).toBe("S1");

		// events are re-tagged with the registered custom api id
		const events: any[] = [];
		for await (const e of out as any) events.push(e);
		expect(events[0].message.api).toBe("codex-lb-responses");
		const result = (await out.result()) as any;
		expect(result.api).toBe("codex-lb-responses");
	});

	test("falls back to the config api key and binds promptCacheKey when sessionId is absent", () => {
		const bindCalls: { sid?: string } = {};
		const pool = {
			bind: (sid: string | undefined) => {
				bindCalls.sid = sid;
				return (async () => new Response(null)) as never;
			},
			remove() {},
			close() {},
		};
		let innerArgs: any;
		const fakeInner = (model: any, context: any, options: any) => {
			innerArgs = { model, context, options };
			const s = new AssistantMessageEventStream();
			queueMicrotask(() => s.end({ api: "openai-responses" } as never));
			return s;
		};
		const streamSimple = makeStreamSimple(config, pool as never, fakeInner as never, AssistantMessageEventStream as never, () => ({}));
		streamSimple({ id: "gpt-5.5", provider: "codex-lb" } as never, {} as never, { promptCacheKey: "PCK" });
		expect(innerArgs.options.apiKey).toBe("real-key"); // no per-turn key → config key
		expect(bindCalls.sid).toBe("PCK");
	});

	test("reports the conversation session id via onSession so web_search reuses its socket", () => {
		const pool = { bind: () => (async () => new Response(null)) as never, remove() {}, close() {} };
		const fakeInner = () => {
			const s = new AssistantMessageEventStream();
			queueMicrotask(() => s.end({ api: "openai-responses" } as never));
			return s;
		};
		const seen: string[] = [];
		const streamSimple = makeStreamSimple(config, pool as never, fakeInner as never, AssistantMessageEventStream as never, () => ({}), (sid) => seen.push(sid));
		streamSimple({ id: "gpt-5.5", provider: "codex-lb" } as never, {} as never, { sessionId: "CONV-1" });
		expect(seen).toEqual(["CONV-1"]);
		// A turn without any session id must not report (so the search keeps the last known one).
		streamSimple({ id: "gpt-5.5", provider: "codex-lb" } as never, {} as never, {});
		expect(seen).toEqual(["CONV-1"]);
	});
});
