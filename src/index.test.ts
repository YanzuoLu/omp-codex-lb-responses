import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import codexLbResponses, { createCodexLbFetch, injectWebSearchTool } from "./index";

type ProviderConfig = {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	streamSimple?: unknown;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models?: Array<Record<string, unknown>>;
	compat?: Record<string, unknown>;
};

function registerWithModelsYml(yml: string): Record<string, ProviderConfig> {
	const agentDir = mkdtempSync(join(tmpdir(), "codex-lb-test-"));
	writeFileSync(join(agentDir, "models.yml"), yml);
	const previousAgentDir = getAgentDir();
	setAgentDir(agentDir);
	const providers: Record<string, ProviderConfig> = {};
	try {
		codexLbResponses({
			registerProvider(name, config) {
				providers[name] = config;
			},
		});
	} finally {
		setAgentDir(previousAgentDir);
	}
	return providers;
}

describe("provider discovery", () => {
	test("discovers eligible codex-lb providers from models.yml", () => {
		const providers = registerWithModelsYml(`
providers:
  codex-lb:
    baseUrl: https://lb.example/backend-api/codex
    apiKey: sk-real-token
    api: openai-codex-responses
    compat:
      supportsReasoningEffort: false
    models:
      - id: gpt-5
        name: gpt-5
        reasoning: true
`);
		const config = providers["codex-lb"];
		expect(config).toBeDefined();
		expect(config.api).toBe("codex-lb-responses");
		expect(config.streamSimple).toBeUndefined();
		expect(config.baseUrl).toBe("https://lb.example/backend-api/codex");
		expect(config.models?.[0]?.api).toBe("codex-lb-responses");
		expect(config.models?.[0]?.id).toBe("gpt-5");
		expect(config.compat?.supportsReasoningEffort).toBe(false);
	});

	test("skips official ChatGPT Codex endpoint", () => {
		const providers = registerWithModelsYml(`
providers:
  official:
    baseUrl: https://chatgpt.com/backend-api/codex
    apiKey: sk-real-token
    api: openai-codex-responses
    models:
      - id: gpt-5
`);
		expect(providers["official"]).toBeUndefined();
	});

	test("skips tokens that already contain a chatgpt account id", () => {
		const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
		const payload = Buffer.from(JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "real-account" },
		})).toString("base64url");
		const jwt = `${header}.${payload}.sig`;
		const providers = registerWithModelsYml(`
providers:
  official-jwt:
    baseUrl: https://lb.example/backend-api/codex
    apiKey: "${jwt}"
    api: openai-codex-responses
    models:
      - id: gpt-5
`);
		expect(providers["official-jwt"]).toBeUndefined();
	});

	test("skips providers not using openai-codex-responses API", () => {
		const providers = registerWithModelsYml(`
providers:
  openai:
    baseUrl: https://api.openai.com/v1
    apiKey: sk-real-token
    api: openai-responses
    models:
      - id: gpt-5
`);
		expect(providers["openai"]).toBeUndefined();
	});

	test("generates different fake keys for different real keys", () => {
		const providers = registerWithModelsYml(`
providers:
  codex-a:
    baseUrl: https://lb.example/backend-api/codex
    apiKey: sk-one
    api: openai-codex-responses
    models:
      - id: gpt-5
  codex-b:
    baseUrl: https://lb.example/backend-api/codex
    apiKey: sk-two
    api: openai-codex-responses
    models:
      - id: gpt-5
`);
		expect(providers["codex-a"]?.apiKey).toBeDefined();
		expect(providers["codex-b"]?.apiKey).toBeDefined();
		expect(providers["codex-a"]!.apiKey).not.toBe(providers["codex-b"]!.apiKey);
	});
});

describe("transport shim", () => {
	let shimState: { webSocketInstalled?: boolean } | undefined;

	beforeAll(() => {
		shimState = (globalThis as typeof globalThis & Record<symbol, { webSocketInstalled?: boolean } | undefined>)[
			Symbol.for("omp.codex-lb-responses.transport-shim")
		];
	});

	test("rewrites fake bearer to real token and strips private headers via WebSocket", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "codex-lb-ws-"));
		writeFileSync(
			join(agentDir, "models.yml"),
			`providers:\n  codex-lb:\n    baseUrl: https://lb.example/backend-api/codex\n    apiKey: sk-real-token\n    api: openai-codex-responses\n    models:\n      - id: gpt-5\n`,
		);
		const previousAgentDir = getAgentDir();
		const originalWebSocket = globalThis.WebSocket;
		let capturedHeaders = new Headers();

		class CapturingWebSocket {
			static CONNECTING = 0;
			static OPEN = 1;
			readyState = CapturingWebSocket.OPEN;
			binaryType = "";
			constructor(_url: string, options?: { headers?: HeadersInit }) {
				capturedHeaders = new Headers(options?.headers);
			}
			send() {}
			close() {}
			ping() {}
		}

		let fakeApiKey: string | undefined;
		try {
			setAgentDir(agentDir);
			globalThis.WebSocket = CapturingWebSocket as typeof WebSocket;
			if (shimState) shimState.webSocketInstalled = false;
			codexLbResponses({
				registerProvider(name, config) {
					if (name === "codex-lb") fakeApiKey = config.apiKey;
				},
			});
			expect(fakeApiKey).toBeDefined();
			new WebSocket("wss://lb.example/backend-api/codex/responses", {
				headers: new Headers([
					["authorization", `Bearer ${fakeApiKey}`],
					["chatgpt-account-id", "fake-account"],
					["x-omp-codex-lb-token", "legacy-real-token"],
				]),
			} as unknown as string[]);
		} finally {
			setAgentDir(previousAgentDir);
			globalThis.WebSocket = originalWebSocket;
			if (shimState) shimState.webSocketInstalled = false;
		}

		expect(capturedHeaders.get("authorization")).toBe("Bearer sk-real-token");
		expect(capturedHeaders.has("chatgpt-account-id")).toBe(false);
		expect(capturedHeaders.has("x-omp-codex-lb-token")).toBe(false);
	});
});

const SHIM_SYMBOL = Symbol.for("omp.codex-lb-responses.transport-shim");

function shimTokens(): Map<string, string> {
	const record = globalThis as typeof globalThis &
		Record<symbol, { tokens: Map<string, string> } | undefined>;
	let state = record[SHIM_SYMBOL];
	if (!state) {
		state = {
			tokens: new Map(),
			fetchInstalled: false,
			webSocketInstalled: false,
			webSearchWsPrefixes: new Set(),
		} as never;
		record[SHIM_SYMBOL] = state;
	}
	return state.tokens;
}

class MockWebSocket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
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
}

describe("SSE→WebSocket upgrade", () => {
	test("createCodexLbFetch upgrades codex-lb SSE to WebSocket before rewriting the bearer", async () => {
		const FAKE = "header.payload.codexlb";
		const REAL = "sk-clb-real-token";
		shimTokens().set(FAKE, REAL);
		const originalWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		MockWebSocket.instances = [];
		try {
			let baseFetchCalled = false;
			const baseFetch = ((..._args: unknown[]) => {
				baseFetchCalled = true;
				return Promise.resolve(new Response(null));
			}) as unknown as typeof fetch;
			const lbFetch = createCodexLbFetch(baseFetch);

			const responseP = lbFetch("https://lb.example/backend-api/codex/responses", {
				method: "POST",
				headers: {
					authorization: `Bearer ${FAKE}`,
					accept: "text/event-stream",
					"content-type": "application/json",
					"chatgpt-account-id": "fake-account",
				},
				body: JSON.stringify({ model: "gpt-5", input: [] }),
			});

			expect(MockWebSocket.instances.length).toBe(1);
			const ws = MockWebSocket.instances[0]!;
			expect(ws.url).toBe("wss://lb.example/backend-api/codex/responses");
			const sentHeaders = new Headers(ws.options?.headers);
			expect(sentHeaders.get("authorization")).toBe(`Bearer ${REAL}`);
			expect(sentHeaders.has("chatgpt-account-id")).toBe(false);

			ws.fireOpen();
			const res = await responseP;
			expect(baseFetchCalled).toBe(false);
			expect(res.headers.get("content-type")).toContain("text/event-stream");
			expect(ws.sent.length).toBe(1);
			const sent = JSON.parse(ws.sent[0]!);
			expect(sent.type).toBe("response.create");
			expect(sent.model).toBe("gpt-5");

			ws.fireMessage(JSON.stringify({ type: "response.output_text.delta", delta: "hi" }));
			const reader = res.body!.getReader();
			const { value } = await reader.read();
			const chunk = new TextDecoder().decode(value);
			expect(chunk).toContain("event: response.output_text.delta");

			ws.fireMessage(JSON.stringify({ type: "response.completed" }));
			expect(ws.readyState).toBe(MockWebSocket.CLOSED);
		} finally {
			globalThis.WebSocket = originalWebSocket;
		}
	});

	test("upgraded stream filters codex.keepalive frames", async () => {
		const FAKE = "header.payload.codexlb2";
		const REAL = "sk-clb-real-2";
		shimTokens().set(FAKE, REAL);
		const originalWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		MockWebSocket.instances = [];
		try {
			const lbFetch = createCodexLbFetch(undefined);
			const responseP = lbFetch("https://lb.example/backend-api/codex/responses", {
				method: "POST",
				headers: { authorization: `Bearer ${FAKE}`, accept: "text/event-stream" },
				body: JSON.stringify({ model: "gpt-5" }),
			});
			const ws = MockWebSocket.instances[0]!;
			ws.fireOpen();
			const res = await responseP;
			const reader = res.body!.getReader();
			ws.fireMessage(JSON.stringify({ type: "codex.keepalive" }));
			ws.fireMessage(JSON.stringify({ type: "response.output_text.delta", delta: "x" }));
			const { value } = await reader.read();
			const chunk = new TextDecoder().decode(value);
			expect(chunk).toContain("event: response.output_text.delta");
			expect(chunk).not.toContain("codex.keepalive");
			ws.fireMessage(JSON.stringify({ type: "response.completed" }));
		} finally {
			globalThis.WebSocket = originalWebSocket;
		}
	});

	test("createCodexLbFetch passes non-codex-lb requests through to the base fetch", async () => {
		const originalWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		MockWebSocket.instances = [];
		try {
			let baseFetchCalled = false;
			const baseFetch = ((..._args: unknown[]) => {
				baseFetchCalled = true;
				return Promise.resolve(new Response("ok"));
			}) as unknown as typeof fetch;
			const lbFetch = createCodexLbFetch(baseFetch);
			await lbFetch("https://api.example/v1/chat", {
				method: "POST",
				headers: { authorization: "Bearer sk-not-codex-lb", accept: "text/event-stream" },
				body: "{}",
			});
			expect(baseFetchCalled).toBe(true);
			expect(MockWebSocket.instances.length).toBe(0);
		} finally {
			globalThis.WebSocket = originalWebSocket;
		}
	});
});

describe("hosted web_search injection", () => {
	test("injectWebSearchTool adds web_search to a response.create without tools", () => {
		const out = injectWebSearchTool(JSON.stringify({ type: "response.create", model: "gpt-5", input: [] }));
		expect(out).toBeDefined();
		const body = JSON.parse(out!);
		expect(body.tools).toEqual([{ type: "web_search" }]);
		expect(body.model).toBe("gpt-5");
	});

	test("injectWebSearchTool appends web_search alongside existing tools", () => {
		const out = injectWebSearchTool(
			JSON.stringify({ type: "response.create", tools: [{ type: "function", name: "shell" }] }),
		);
		const body = JSON.parse(out!);
		expect(body.tools).toHaveLength(2);
		expect(body.tools.some((t: { type: string }) => t.type === "web_search")).toBe(true);
		expect(body.tools.some((t: { type: string }) => t.type === "function")).toBe(true);
	});

	test("injectWebSearchTool replaces omp's client-side function web_search with the hosted tool", () => {
		const out = injectWebSearchTool(
			JSON.stringify({
				type: "response.create",
				tools: [
					{ type: "function", name: "web_search" },
					{ type: "function", name: "shell" },
				],
			}),
		);
		const body = JSON.parse(out!);
		expect(body.tools.some((t: { type: string }) => t.type === "web_search")).toBe(true);
		expect(body.tools.some((t: { type: string; name?: string }) => t.type === "function" && t.name === "web_search")).toBe(false);
		expect(body.tools.some((t: { type: string; name?: string }) => t.type === "function" && t.name === "shell")).toBe(true);
	});

	test("injectWebSearchTool is a no-op when web_search already present, non-create, or invalid", () => {
		expect(injectWebSearchTool(JSON.stringify({ type: "response.create", tools: [{ type: "web_search" }] }))).toBeUndefined();
		expect(injectWebSearchTool(JSON.stringify({ type: "response.create", tools: [{ type: "web_search_preview" }] }))).toBeUndefined();
		expect(injectWebSearchTool(JSON.stringify({ type: "session.update" }))).toBeUndefined();
		expect(injectWebSearchTool("not json")).toBeUndefined();
	});

	function runWithProvider(yml: string, fn: (ws: MockWebSocket) => void): void {
		const agentDir = mkdtempSync(join(tmpdir(), "codex-lb-search-"));
		writeFileSync(join(agentDir, "models.yml"), yml);
		const previousAgentDir = getAgentDir();
		const originalWebSocket = globalThis.WebSocket;
		const state = (globalThis as typeof globalThis & Record<symbol, { webSocketInstalled?: boolean; webSearchWsPrefixes?: Set<string> }>)[
			Symbol.for("omp.codex-lb-responses.transport-shim")
		];
		try {
			setAgentDir(agentDir);
			globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
			MockWebSocket.instances = [];
			if (state) {
				state.webSocketInstalled = false;
				state.webSearchWsPrefixes?.clear();
			}
			codexLbResponses({ registerProvider() {} });
			const ws = new WebSocket("wss://lb.example/backend-api/codex/responses", { headers: {} } as never);
			fn(ws as unknown as MockWebSocket);
		} finally {
			setAgentDir(previousAgentDir);
			globalThis.WebSocket = originalWebSocket;
			if (state) {
				state.webSocketInstalled = false;
				state.webSearchWsPrefixes?.clear();
			}
		}
	}

	test("WebSocket shim injects web_search into response.create when provider opts in", () => {
		runWithProvider(
			`providers:\n  codex-lb:\n    baseUrl: https://lb.example/backend-api/codex\n    apiKey: sk-real-token\n    api: openai-codex-responses\n    webSearch: true\n    models:\n      - id: gpt-5\n`,
			ws => {
				ws.send(JSON.stringify({ type: "response.create", model: "gpt-5", input: [] }));
				expect(ws.sent).toHaveLength(1);
				const body = JSON.parse(ws.sent[0]!);
				expect(body.tools.some((t: { type: string }) => t.type === "web_search")).toBe(true);
			},
		);
	});

	test("WebSocket shim does NOT inject when provider omits webSearch", () => {
		runWithProvider(
			`providers:\n  codex-lb:\n    baseUrl: https://lb.example/backend-api/codex\n    apiKey: sk-real-token\n    api: openai-codex-responses\n    models:\n      - id: gpt-5\n`,
			ws => {
				ws.send(JSON.stringify({ type: "response.create", model: "gpt-5", input: [] }));
				expect(ws.sent).toHaveLength(1);
				const body = JSON.parse(ws.sent[0]!);
				expect(body.tools).toBeUndefined();
			},
		);
	});
});

describe("codex-lb web-search tool mode", () => {
	test("webSearch: tool publishes the codex-lb web-search config and does not inject", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "codex-lb-tool-"));
		writeFileSync(
			join(agentDir, "models.yml"),
			`providers:\n  codex-lb:\n    baseUrl: https://lb.example/backend-api/codex/\n    apiKey: sk-real-token\n    api: openai-codex-responses\n    webSearch: tool\n    models:\n      - id: gpt-5\n`,
		);
		const previousAgentDir = getAgentDir();
		const wsKey = Symbol.for("omp.codex-lb-responses.web-search");
		const shimKey = Symbol.for("omp.codex-lb-responses.transport-shim");
		const g = globalThis as typeof globalThis &
			Record<symbol, { baseUrl?: string; apiKey?: string; accountId?: string } | { webSearchWsPrefixes?: Set<string> } | undefined>;
		const prevConfig = g[wsKey];
		try {
			setAgentDir(agentDir);
			g[wsKey] = undefined;
			(g[shimKey] as { webSearchWsPrefixes?: Set<string> } | undefined)?.webSearchWsPrefixes?.clear();
			codexLbResponses({ registerProvider() {} });
			const cfg = g[wsKey] as { baseUrl: string; apiKey: string; accountId: string };
			expect(cfg).toBeDefined();
			expect(cfg.baseUrl).toBe("https://lb.example/backend-api/codex"); // trailing slash stripped
			// synthetic JWT (not the real key) so the fetch shim upgrades the search to WebSocket
			expect(cfg.apiKey).not.toBe("sk-real-token");
			expect(cfg.apiKey.split(".").length).toBe(3);
			expect(typeof cfg.accountId).toBe("string");
			expect(cfg.accountId.length).toBeGreaterThan(0);
			// tool mode must NOT register an injection prefix
			const prefixes = (g[shimKey] as { webSearchWsPrefixes?: Set<string> } | undefined)?.webSearchWsPrefixes;
			expect(prefixes?.size ?? 0).toBe(0);
		} finally {
			setAgentDir(previousAgentDir);
			g[wsKey] = prevConfig;
		}
	});
});
