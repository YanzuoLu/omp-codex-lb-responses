import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import type { AssistantMessageEventStream, Context, Model, ProviderSessionState, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import codexLbResponses from "./index";

type StreamSimple = (model: Model, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

const CAPTURED = new Error("payload captured");
let streamSimple: StreamSimple | undefined;

beforeAll(() => {
	setAgentDir(mkdtempSync(join(tmpdir(), "codex-lb-test-")));
	codexLbResponses({
		registerProvider(name, config) {
			if (name === "codex-lb-responses") streamSimple = config.streamSimple;
		},
	});
	if (!streamSimple) throw new Error("codex-lb-responses streamSimple was not registered");
});

function createModel(overrides: Partial<Model> = {}): Model {
	return {
		id: "gpt-5",
		name: "gpt-5",
		api: "codex-lb-responses",
		provider: "codex-lb",
		baseUrl: "https://lb.example/backend-api/codex",
		reasoning: true,
		input: ["text"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
		thinking: { minLevel: "minimal" as never, maxLevel: "xhigh" as never, mode: "effort" },
		...overrides,
	};
}

const context: Context = {
	messages: [{ role: "user", content: "Generate a short title.", timestamp: 0 }],
};

async function capturePayload(
	options: SimpleStreamOptions,
	testContext: Context = context,
	model: Model = createModel(),
): Promise<Record<string, unknown>> {
	let payload: unknown;
	const stream = streamSimple!(model, testContext, {
		apiKey: "sk-real-token",
		...options,
		onPayload(value) {
			payload = value;
			throw CAPTURED;
		},
	});
	await stream.result();
	expect(payload).toBeDefined();
	return payload as Record<string, unknown>;
}

async function captureDiscoveredProviderHeaders(): Promise<{
	headers: Headers;
	providerConfig: {
		api?: string;
		apiKey?: string;
		streamSimple?: StreamSimple;
		models?: Array<Record<string, unknown>>;
		compat?: Record<string, unknown>;
	};
}> {
	const agentDir = mkdtempSync(join(tmpdir(), "codex-lb-discovered-"));
	writeFileSync(
		join(agentDir, "models.yml"),
		`providers:\n  codex-lb:\n    baseUrl: https://lb.example/backend-api/codex\n    apiKey: sk-real-token\n    api: openai-codex-responses\n    compat:\n      supportsReasoningEffort: false\n    models:\n      - id: gpt-5\n        name: gpt-5\n        reasoning: true\n`,
	);
	const previousAgentDir = getAgentDir();
	const originalWebSocket = globalThis.WebSocket;
	const shimState = (globalThis as typeof globalThis & Record<symbol, { webSocketInstalled?: boolean } | undefined>)[
		Symbol.for("omp.codex-lb-responses.transport-shim")
	];
	let providerConfig:
		| {
				api?: string;
				apiKey?: string;
				streamSimple?: StreamSimple;
				models?: Array<Record<string, unknown>>;
				compat?: Record<string, unknown>;
			}
		| undefined;
	let headers = new Headers();
	class CapturingWebSocket {
		static CONNECTING = 0;
		static OPEN = 1;
		readyState = CapturingWebSocket.OPEN;
		binaryType = "";

		constructor(_url: string, options?: { headers?: HeadersInit }) {
			headers = new Headers(options?.headers);
		}

		send() {}
		close() {}
		ping() {}
	}

	try {
		setAgentDir(agentDir);
		globalThis.WebSocket = CapturingWebSocket as typeof WebSocket;
		if (shimState) shimState.webSocketInstalled = false;
		codexLbResponses({
			registerProvider(name, config) {
				if (name === "codex-lb") providerConfig = config;
			},
		});
		if (!providerConfig?.apiKey) throw new Error("codex-lb provider was not registered");
		new WebSocket("wss://lb.example/backend-api/codex/responses", {
			headers: new Headers([
				["authorization", `Bearer ${providerConfig.apiKey}`],
				["chatgpt-account-id", "fake-account"],
				["x-omp-codex-lb-token", "legacy-real-token"],
			]),
		} as unknown as string[]);
	} finally {
		setAgentDir(previousAgentDir);
		globalThis.WebSocket = originalWebSocket;
		if (shimState) shimState.webSocketInstalled = false;
	}

	return { headers, providerConfig };
}

describe("Codex LB utility request options", () => {
	test("maps disableReasoning to Codex none effort", async () => {
		const payload = await capturePayload({ disableReasoning: true, reasoning: "high" as never });
		expect(typeof payload.prompt_cache_key).toBe("string");
		const reasoning = payload.reasoning as { effort?: string } | undefined;

		expect(reasoning?.effort).toBe("none");
	});

	test("keeps disableReasoning effective when effort is otherwise omitted", async () => {
		const payload = await capturePayload(
			{ disableReasoning: true, reasoning: "high" as never },
			context,
			createModel({ compat: { supportsReasoningEffort: false } as never }),
		);
		const reasoning = payload.reasoning as { effort?: string } | undefined;

		expect(reasoning?.effort).toBe("none");
	});

	test("omits normal reasoning effort for models that reject it", async () => {
		const payload = await capturePayload(
			{ reasoning: "high" as never },
			context,
			createModel({ compat: { supportsReasoningEffort: false } as never }),
		);

		expect(payload.reasoning).toBeUndefined();
	});

	test("maps hideThinkingSummary to omitted Codex summary", async () => {
		const payload = await capturePayload({ hideThinkingSummary: true, reasoning: "high" as never });
		const reasoning = payload.reasoning as { effort?: string; summary?: string } | undefined;

		expect(reasoning).toEqual({ effort: "high" });
	});

	test("maps generic any tool choice to OpenAI required", async () => {
		const payload = await capturePayload(
			{ toolChoice: "any" },
			{
				...context,
				tools: [
					{
						name: "lookup",
						description: "Lookup test data",
						parameters: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			},
		);

		expect(payload.tool_choice).toBe("required");
	});

	test("maps scoped OpenAI service tier to Codex priority", async () => {
		const payload = await capturePayload({ serviceTier: "openai-only" });

		expect(payload.service_tier).toBe("priority");
	});

	test("keeps generated utility sessions out of caller provider state", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const stream = streamSimple!(createModel(), context, {
			apiKey: "sk-real-token",
			disableReasoning: true,
			preferWebsockets: false,
			providerSessionState,
			fetch: async () =>
				new Response(JSON.stringify({ error: { message: "stop" } }), {
					status: 401,
					headers: { "content-type": "application/json" },
				}),
		});
		await stream.result();

		expect(providerSessionState.size).toBe(0);
	});

	test("keeps discovered providers on the built-in Codex API for core lifecycle", async () => {
		const { providerConfig } = await captureDiscoveredProviderHeaders();

		expect(providerConfig.api).toBe("openai-codex-responses");
		expect(providerConfig.streamSimple).toBeUndefined();
		expect(providerConfig.models?.[0]?.api).toBe("openai-codex-responses");
		expect(providerConfig.compat?.supportsReasoningEffort).toBe(false);
	});

	test("rewrites discovered provider fake key to real bearer without private token headers", async () => {
		const { headers } = await captureDiscoveredProviderHeaders();
		expect(headers.get("authorization")).toBe("Bearer sk-real-token");
		expect(headers.has("chatgpt-account-id")).toBe(false);
		expect(headers.has("x-omp-codex-lb-token")).toBe(false);
	});

	test("keys fake Codex auth by the real bearer", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "codex-lb-rotated-"));
		writeFileSync(
			join(agentDir, "models.yml"),
			`providers:\n  codex-a:\n    baseUrl: https://lb.example/backend-api/codex\n    apiKey: sk-one\n    api: openai-codex-responses\n    models:\n      - id: gpt-5\n  codex-b:\n    baseUrl: https://lb.example/backend-api/codex\n    apiKey: sk-two\n    api: openai-codex-responses\n    models:\n      - id: gpt-5\n`,
		);
		const previousAgentDir = getAgentDir();
		setAgentDir(agentDir);
		const apiKeys: Record<string, string> = {};
		codexLbResponses({
			registerProvider(name, config) {
				if (config.apiKey) apiKeys[name] = config.apiKey;
			},
		});
		setAgentDir(previousAgentDir);

		expect(apiKeys["codex-a"]).toBeDefined();
		expect(apiKeys["codex-b"]).toBeDefined();
		expect(apiKeys["codex-a"]).not.toBe(apiKeys["codex-b"]);
	});
});
