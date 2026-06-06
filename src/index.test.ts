import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import type { AssistantMessageEventStream, Context, Model, ProviderSessionState, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import codexLbResponses from "./index";

type StreamSimple = (model: Model, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

const CAPTURED = new Error("payload captured");
let streamSimple: StreamSimple | undefined;

beforeAll(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "codex-lb-test-"));
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

async function captureHeadersForDiscoveredProvider(): Promise<Headers> {
	const agentDir = mkdtempSync(join(tmpdir(), "codex-lb-discovered-"));
	writeFileSync(
		join(agentDir, "models.yml"),
		`providers:\n  codex-lb:\n    baseUrl: https://lb.example/backend-api/codex\n    apiKey: sk-real-token\n    api: openai-codex-responses\n    models:\n      - id: gpt-5\n        name: gpt-5\n        reasoning: true\n`,
	);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let providerConfig: { apiKey?: string; streamSimple?: StreamSimple; models?: Array<Record<string, unknown>> } | undefined;
	codexLbResponses({
		registerProvider(name, config) {
			if (name === "codex-lb") providerConfig = config;
		},
	});
	process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	expect(providerConfig.models?.[0]?.api).toBe("codex-lb-responses");
	if (!providerConfig?.apiKey || !providerConfig.streamSimple) throw new Error("codex-lb provider was not registered");

	let headers = new Headers();
	const stream = providerConfig.streamSimple(createModel(), context, {
		apiKey: providerConfig.apiKey,
		fetch: async (_input, init) => {
			headers = new Headers(init?.headers);
			return new Response(JSON.stringify({ error: { message: "stop" } }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		},
	});
	await stream.result();
	return headers;
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

	test("rewrites discovered provider fake key to real bearer", async () => {
		const headers = await captureHeadersForDiscoveredProvider();
		expect(headers.get("authorization")).toBe("Bearer sk-real-token");
		expect(headers.has("chatgpt-account-id")).toBe(false);
	});
});
