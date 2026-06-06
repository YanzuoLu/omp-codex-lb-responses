import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai";
import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";

const PLUGIN_NAME = "omp-codex-lb-responses";
const CODEX_LB_API = "codex-lb-responses";
const INNER_CODEX_API = "openai-codex-responses";
const REAL_TOKEN_HEADER = "x-omp-codex-lb-token";
const FAKE_ACCOUNT_ID = "codex-lb";
const SHIM_KEY = Symbol.for("omp.codex-lb-responses.websocket-shim");

const DEFAULT_PROVIDER = "codex-lb";
const DEFAULT_MODEL_ID = "gpt-5.5";
const DEFAULT_MODEL_NAME = "gpt-5.5";
const DEFAULT_CONTEXT_WINDOW = 272000;
const DEFAULT_MAX_TOKENS = 128000;
const DEFAULT_COST_INPUT = 5;
const DEFAULT_COST_OUTPUT = 30;
const DEFAULT_COST_CACHE_READ = 0.5;
const DEFAULT_COST_CACHE_WRITE = 0;
const DEFAULT_API_KEY_ENV = "CODEX_LB_API_KEY";

type ExtensionApi = {
	setLabel?: (label: string) => void;
	registerProvider: (name: string, config: {
		baseUrl?: string;
		apiKey?: string;
		api: string;
		streamSimple: (
			model: Model,
			context: Context,
			options?: SimpleStreamOptions,
		) => AssistantMessageEventStream;
		models?: Array<{
			id: string;
			name: string;
			reasoning: boolean;
			input: ("text" | "image")[];
			contextWindow: number;
			maxTokens: number;
			cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		}>;
	}) => void;
};

type PluginSettings = Record<string, unknown>;

function createFakeCodexJwt(): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: FAKE_ACCOUNT_ID },
	})).toString("base64url");
	return `${header}.${payload}.codexlb`;
}

const FAKE_CODEX_JWT = createFakeCodexJwt();

function readPluginSettings(): PluginSettings {
	const lockPath = join(homedir(), ".omp", "plugins", "omp-plugins.lock.json");
	if (!existsSync(lockPath)) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(lockPath, "utf8"));
	} catch {
		return {};
	}

	if (!parsed || typeof parsed !== "object") return {};
	const settings = (parsed as { settings?: Record<string, unknown> }).settings?.[PLUGIN_NAME];
	if (!settings || typeof settings !== "object") return {};
	return settings as PluginSettings;
}

function stringSetting(settings: PluginSettings, key: string, fallback: string): string {
	const value = settings[key];
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function optionalStringSetting(settings: PluginSettings, key: string): string | undefined {
	const value = settings[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function numberSetting(settings: PluginSettings, key: string, fallback: number): number {
	const value = settings[key];
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveConfiguredApiKey(settings: PluginSettings): string | undefined {
	const direct = optionalStringSetting(settings, "apiKey");
	if (direct) return direct;

	const envName = stringSetting(settings, "apiKeyEnv", DEFAULT_API_KEY_ENV);
	const fromEnv = process.env[envName]?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

function rewriteCodexLbHeaders(init: HeadersInit | undefined): HeadersInit | undefined {
	if (!init) return init;
	const headers = new Headers(init);
	const realToken = headers.get(REAL_TOKEN_HEADER);
	if (!realToken) return init;

	headers.set("Authorization", `Bearer ${realToken}`);
	headers.delete("chatgpt-account-id");
	headers.delete(REAL_TOKEN_HEADER);
	return headers;
}

function createCodexLbFetch(fetchOverride: typeof fetch | undefined): typeof fetch {
	const baseFetch = fetchOverride ?? fetch;
	const lbFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
		baseFetch(input, init ? { ...init, headers: rewriteCodexLbHeaders(init.headers) } : init)) as typeof fetch;
	const preconnect = (baseFetch as typeof fetch & { preconnect?: unknown }).preconnect;
	if (typeof preconnect === "function") {
		(lbFetch as typeof fetch & { preconnect?: unknown }).preconnect = preconnect.bind(baseFetch);
	}
	return lbFetch;
}

function installCodexLbWebSocketShim(): void {
	const globalRecord = globalThis as typeof globalThis & Record<symbol, boolean>;
	if (globalRecord[SHIM_KEY]) return;

	const NativeWebSocket = globalThis.WebSocket;
	if (typeof NativeWebSocket !== "function") return;

	globalThis.WebSocket = new Proxy(NativeWebSocket, {
		construct(target, args, newTarget) {
			const [url, options, ...rest] = args;
			const nextOptions = options && typeof options === "object" ? { ...options } : options;
			if (nextOptions && typeof nextOptions === "object" && "headers" in nextOptions) {
				(nextOptions as { headers?: HeadersInit }).headers = rewriteCodexLbHeaders(
					(nextOptions as { headers?: HeadersInit }).headers,
				);
			}
			return Reflect.construct(target, [url, nextOptions, ...rest], newTarget);
		},
	}) as typeof WebSocket;
	globalRecord[SHIM_KEY] = true;
}

function streamCodexLbResponses(
	model: Model,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const realApiKey = options?.apiKey;
	if (!realApiKey || realApiKey === "N/A") {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	installCodexLbWebSocketShim();

	const innerModel = {
		...model,
		api: INNER_CODEX_API,
		headers: { ...(model.headers ?? {}), [REAL_TOKEN_HEADER]: realApiKey },
	} as Model<"openai-codex-responses">;
	const innerOptions = {
		...options,
		apiKey: FAKE_CODEX_JWT,
		fetch: createCodexLbFetch(options?.fetch),
		headers: { ...(options?.headers ?? {}), [REAL_TOKEN_HEADER]: realApiKey },
	};

	return streamOpenAICodexResponses(innerModel, context, innerOptions);
}

export default function codexLbResponses(pi: ExtensionApi): void {
	pi.setLabel?.("Codex LB Responses");
	const settings = readPluginSettings();
	const baseUrl = optionalStringSetting(settings, "baseUrl");
	const apiKey = resolveConfiguredApiKey(settings);

	if (!baseUrl || !apiKey) {
		pi.registerProvider(CODEX_LB_API, {
			api: CODEX_LB_API,
			streamSimple: streamCodexLbResponses,
		});
		return;
	}

	pi.registerProvider(stringSetting(settings, "provider", DEFAULT_PROVIDER), {
		baseUrl,
		apiKey,
		api: CODEX_LB_API,
		streamSimple: streamCodexLbResponses,
		models: [{
			id: stringSetting(settings, "modelId", DEFAULT_MODEL_ID),
			name: stringSetting(settings, "modelName", DEFAULT_MODEL_NAME),
			reasoning: true,
			input: ["text", "image"],
			contextWindow: numberSetting(settings, "contextWindow", DEFAULT_CONTEXT_WINDOW),
			maxTokens: numberSetting(settings, "maxTokens", DEFAULT_MAX_TOKENS),
			cost: {
				input: numberSetting(settings, "costInput", DEFAULT_COST_INPUT),
				output: numberSetting(settings, "costOutput", DEFAULT_COST_OUTPUT),
				cacheRead: numberSetting(settings, "costCacheRead", DEFAULT_COST_CACHE_READ),
				cacheWrite: numberSetting(settings, "costCacheWrite", DEFAULT_COST_CACHE_WRITE),
			},
		}],
	});
}
