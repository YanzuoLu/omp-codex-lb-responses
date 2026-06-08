import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import codexLbResponses from "./index";

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
		expect(config.api).toBe("openai-codex-responses");
		expect(config.streamSimple).toBeUndefined();
		expect(config.baseUrl).toBe("https://lb.example/backend-api/codex");
		expect(config.models?.[0]?.api).toBe("openai-codex-responses");
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
