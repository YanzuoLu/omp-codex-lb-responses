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
	test("registers no provider and returns undefined when unconfigured", () => {
		let registered = 0;
		const pool = activate({ registerProvider: () => registered++ }, { env: {} });
		expect(registered).toBe(0);
		expect(pool).toBeUndefined();
	});

	test("registers a codex-lb provider with custom api + streamSimple + models", () => {
		const providers: Record<string, any> = {};
		let label: string | undefined;
		const pool = activate(
			{ setLabel: (l) => (label = l), registerProvider: (n, c) => (providers[n] = c) },
			{ env: { CODEX_LB_API_KEY: "k", CODEX_LB_BASE_URL: BASE }, WebSocketImpl: class {} },
		);
		expect(label).toBe("Codex LB Responses");
		const cfg = providers["codex-lb"];
		expect(cfg).toBeDefined();
		expect(cfg.api).toBe("codex-lb-responses");
		expect(cfg.baseUrl).toBe(BASE);
		expect(cfg.apiKey).toBe("k");
		expect(typeof cfg.streamSimple).toBe("function");
		expect(cfg.models.length).toBeGreaterThan(0);
		expect(cfg.models[0].api).toBe("codex-lb-responses");
		pool?.close();
	});

	test("activates from plugin settings (no env)", () => {
		const providers: Record<string, any> = {};
		const pool = activate(
			{ registerProvider: (n, c) => (providers[n] = c) },
			{ settings: { apiKey: "k", baseUrl: BASE }, env: {}, WebSocketImpl: class {} },
		);
		expect(providers["codex-lb"]).toBeDefined();
		expect(providers["codex-lb"].baseUrl).toBe(BASE);
		pool?.close();
	});

	test("honors a custom provider id", () => {
		const providers: Record<string, any> = {};
		const pool = activate(
			{ registerProvider: (n, c) => (providers[n] = c) },
			{ env: { CODEX_LB_API_KEY: "k", CODEX_LB_BASE_URL: BASE, CODEX_LB_PROVIDER_ID: "my-lb" }, WebSocketImpl: class {} },
		);
		expect(providers["my-lb"]).toBeDefined();
		expect(providers["codex-lb"]).toBeUndefined();
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
});
