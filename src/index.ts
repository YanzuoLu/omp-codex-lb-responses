// omp-codex-lb-responses
//
// Registers a `codex-lb` provider that reuses omp's built-in **openai-responses**
// code path (plain `Authorization: Bearer` — no ChatGPT JWT, no account-id) but
// routes each streaming turn through codex-lb's `/responses` WebSocket via a
// PROVIDER-SCOPED `fetch`. One socket per conversation keeps codex-lb pinned to a
// single upstream account — the session/account consistency the load balancer
// needs — so long turns stop dropping silently.
//
// No global monkeypatching, no synthetic JWT, no source patcher. Configured by
// environment: CODEX_LB_API_KEY (required) + CODEX_LB_BASE_URL (optional). Switch
// to it by selecting `codex-lb/<model>` in the model picker.

import { AssistantMessageEventStream, streamOpenAIResponses } from "@oh-my-pi/pi-ai";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import { buildOpenAIResponsesCompat } from "@oh-my-pi/pi-catalog";
import { createWebSocketFetch, type FetchLike, type WebSocketFetch } from "./ws-pool";

const SERVICE = "omp-codex-lb-responses";
/** Custom api id omp dispatches to our streamSimple (must not collide with a built-in). */
const CUSTOM_API = "codex-lb-responses";
/** Built-in plain-key Responses path we delegate to under the hood. */
const INNER_API = "openai-responses";
const DEFAULT_PROVIDER_ID = "codex-lb";

const DEFAULT_COST = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 272_000;
const DEFAULT_MAX_TOKENS = 128_000;

type ModelEntry = {
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
};

export interface CodexLbConfig {
	providerID: string;
	baseUrl: string;
	apiKey: string;
	models: ModelEntry[];
	injectWebSearch: boolean;
}

type ProviderConfig = {
	api?: string;
	baseUrl?: string;
	apiKey?: string;
	streamSimple?: (model: Model, context: Context, options?: Record<string, unknown>) => AssistantMessageEventStream;
	models?: ModelEntry[];
	headers?: Record<string, string>;
};

type ExtensionApi = {
	setLabel?: (label: string) => void;
	logger?: { warn?: (msg: string, meta?: unknown) => void; info?: (msg: string, meta?: unknown) => void };
	on?: (event: string, handler: (payload: unknown) => void) => void;
	registerProvider: (name: string, config: ProviderConfig) => void;
};

function modelEntry(id: string, opts: { name?: string; context?: number; output?: number; attachment?: boolean } = {}): ModelEntry {
	return {
		id,
		name: opts.name ?? id,
		api: CUSTOM_API,
		reasoning: true,
		input: opts.attachment === false ? ["text"] : ["text", "image"],
		cost: { ...DEFAULT_COST },
		contextWindow: opts.context ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: opts.output ?? DEFAULT_MAX_TOKENS,
	};
}

export function defaultModels(): ModelEntry[] {
	return [
		modelEntry("gpt-5.5", { name: "GPT-5.5" }),
		modelEntry("gpt-5.4", { name: "GPT-5.4" }),
		modelEntry("gpt-5.4-mini", { name: "GPT-5.4-Mini" }),
		modelEntry("gpt-5.3-codex-spark", { name: "GPT-5.3-Codex-Spark", context: 128_000, attachment: false }),
	];
}

type Settings = Record<string, unknown>;

function pickString(settings: Settings, settingKey: string, env: Record<string, string | undefined>, envKey: string): string | undefined {
	const fromSettings = settings[settingKey];
	if (typeof fromSettings === "string" && fromSettings.trim()) return fromSettings.trim();
	const fromEnv = env[envKey]?.trim();
	return fromEnv || undefined;
}

function pickModelIds(settings: Settings, env: Record<string, string | undefined>): string[] | undefined {
	const raw = settings.models ?? env.CODEX_LB_MODELS;
	const list = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : undefined;
	if (!list) return undefined;
	const ids = list.map((s) => String(s).trim()).filter(Boolean);
	return ids.length > 0 ? ids : undefined;
}

/**
 * Resolves codex-lb config from this plugin's persistent settings
 * (`omp plugin config omp-codex-lb-responses --set key=value`), falling back to
 * environment variables. Returns undefined unless BOTH a base URL and an API key
 * are resolved — there is no built-in default endpoint, so a codex-lb host is
 * never baked into this package.
 *
 * Keys: `baseUrl`/`CODEX_LB_BASE_URL`, `apiKey`/`CODEX_LB_API_KEY`,
 * `providerId`/`CODEX_LB_PROVIDER_ID`, `models`/`CODEX_LB_MODELS`,
 * `webSearch`/`CODEX_LB_WEB_SEARCH`.
 */
export function readConfig(settings: Settings = {}, env: Record<string, string | undefined> = process.env): CodexLbConfig | undefined {
	const apiKey = pickString(settings, "apiKey", env, "CODEX_LB_API_KEY");
	const baseUrlRaw = pickString(settings, "baseUrl", env, "CODEX_LB_BASE_URL");
	if (!apiKey || !baseUrlRaw) return undefined;
	const baseUrl = baseUrlRaw.replace(/\/+$/, "");
	const providerID = pickString(settings, "providerId", env, "CODEX_LB_PROVIDER_ID") ?? DEFAULT_PROVIDER_ID;
	const webSearch = (pickString(settings, "webSearch", env, "CODEX_LB_WEB_SEARCH") ?? "").toLowerCase();
	const injectWebSearch = webSearch === "inject" || webSearch === "true";
	const ids = pickModelIds(settings, env);
	const models = ids ? ids.map((id) => modelEntry(id)) : defaultModels();
	return { providerID, baseUrl, apiKey, models, injectWebSearch };
}

/**
 * Loads this plugin's persistent settings from omp (the `omp plugin config`
 * store). Best-effort: returns {} if omp's plugin loader isn't reachable, in
 * which case config falls back entirely to environment variables.
 */
export async function loadPluginSettings(pluginName = SERVICE): Promise<Settings> {
	try {
		const mod = (await import("@oh-my-pi/pi-coding-agent/extensibility/plugins/loader")) as {
			getPluginSettings?: (name: string, cwd: string) => Promise<Settings>;
		};
		if (typeof mod.getPluginSettings === "function") return await mod.getPluginSettings(pluginName, process.cwd());
	} catch {}
	return {};
}

type InnerStream = (model: Model, context: Context, options?: Record<string, unknown>) => AssistantMessageEventStream;
type EventStreamCtor = new () => AssistantMessageEventStream;
type BuildCompat = (spec: { id?: string; provider: string; name: string; baseUrl: string; reasoning?: boolean }) => unknown;

// Re-tag the inner openai-responses events with our custom api id so omp's
// history/resume bookkeeping stays consistent with the registered model's api.
function retagStream(inner: AssistantMessageEventStream, StreamCtor: EventStreamCtor): AssistantMessageEventStream {
	const outer = new StreamCtor();
	(async () => {
		try {
			for await (const event of inner as AsyncIterable<Record<string, unknown>>) {
				for (const key of ["message", "partial", "error"] as const) {
					const part = event[key];
					if (part && typeof part === "object") (part as Record<string, unknown>).api = CUSTOM_API;
				}
				outer.push(event as never);
			}
			const result = (await inner.result()) as Record<string, unknown>;
			result.api = CUSTOM_API;
			outer.end(result as never);
		} catch (error) {
			outer.fail(error);
		}
	})();
	return outer;
}

export function makeStreamSimple(
	config: CodexLbConfig,
	pool: WebSocketFetch,
	innerStream: InnerStream,
	StreamCtor: EventStreamCtor,
	buildCompat: BuildCompat = buildOpenAIResponsesCompat as unknown as BuildCompat,
) {
	return function streamCodexLb(model: Model, context: Context, options?: Record<string, unknown>): AssistantMessageEventStream {
		const opts = (options ?? {}) as Record<string, unknown>;
		const m = model as unknown as Record<string, unknown>;
		const apiKey = typeof opts.apiKey === "string" && opts.apiKey ? (opts.apiKey as string) : config.apiKey;
		const sessionID =
			(typeof opts.sessionId === "string" && opts.sessionId) || (typeof opts.promptCacheKey === "string" && opts.promptCacheKey) || undefined;
		const httpFetch = (typeof opts.fetch === "function" ? opts.fetch : globalThis.fetch) as FetchLike;
		const wsFetch = pool.bind(sessionID || undefined, httpFetch);

		// omp resolves a built-in model's `compat` from its catalog; a custom-api model
		// has none, and omp's openai-responses path reads `model.compat` directly
		// (resolveOpenAICompatPolicy / buildResponsesInput). Build the standard
		// openai-responses compat ourselves and put it on the inner model.
		const compat = buildCompat({
			id: typeof m.id === "string" ? m.id : undefined,
			provider: typeof m.provider === "string" ? m.provider : config.providerID,
			name: typeof m.name === "string" ? m.name : typeof m.id === "string" ? m.id : "gpt-5",
			baseUrl: config.baseUrl,
			reasoning: m.reasoning !== false,
		});

		const innerModel = { ...m, api: INNER_API, baseUrl: config.baseUrl, compat } as unknown as Model;
		const innerOptions: Record<string, unknown> = {
			...opts,
			apiKey,
			fetch: wsFetch,
			// codex-lb proxies the Responses API; keep encrypted reasoning across the
			// full-transcript replay (statefulResponses stays off for a non-OpenAI host).
			includeEncryptedReasoning: true,
			statefulResponses: false,
			reasoningSummary: opts.reasoningSummary ?? "auto",
		};

		const inner = innerStream(innerModel, context, innerOptions);
		return retagStream(inner, StreamCtor);
	};
}

export interface ActivateDeps {
	settings?: Settings;
	env?: Record<string, string | undefined>;
	innerStream?: InnerStream;
	AssistantMessageEventStream?: EventStreamCtor;
	WebSocketImpl?: unknown;
	createPool?: typeof createWebSocketFetch;
}

export function activate(pi: ExtensionApi, deps: ActivateDeps = {}): WebSocketFetch | undefined {
	pi.setLabel?.("Codex LB Responses");
	const config = readConfig(deps.settings ?? {}, deps.env);
	if (!config) {
		pi.logger?.warn?.(
			`${SERVICE}: not configured. Set a base URL and API key via \`omp plugin config ${SERVICE} --set baseUrl=<your codex-lb /v1 endpoint> --set apiKey=<sk-clb-…>\` (or the CODEX_LB_BASE_URL / CODEX_LB_API_KEY env vars).`,
		);
		return undefined;
	}
	const createPool = deps.createPool ?? createWebSocketFetch;
	const pool = createPool({ injectWebSearch: config.injectWebSearch, WebSocketImpl: deps.WebSocketImpl });
	const innerStream = deps.innerStream ?? (streamOpenAIResponses as unknown as InnerStream);
	const StreamCtor = deps.AssistantMessageEventStream ?? (AssistantMessageEventStream as unknown as EventStreamCtor);

	pi.registerProvider(config.providerID, {
		api: CUSTOM_API,
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		streamSimple: makeStreamSimple(config, pool, innerStream, StreamCtor),
		models: config.models,
	});

	// Drop a session's socket when omp ends it, if the host emits such an event.
	pi.on?.("session-end", (payload) => {
		const id = (payload as { sessionId?: string } | undefined)?.sessionId;
		if (id) pool.remove(id);
	});

	pi.logger?.info?.(
		`${SERVICE}: registered provider "${config.providerID}" (${config.models.length} models) over codex-lb WebSocket at ${config.baseUrl}`,
	);
	return pool;
}

export default async function codexLbResponses(pi: ExtensionApi): Promise<void> {
	const settings = await loadPluginSettings();
	activate(pi, { settings });
}
