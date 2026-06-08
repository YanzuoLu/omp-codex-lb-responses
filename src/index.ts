import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessageEventStream, streamOpenAICodexResponses } from "@oh-my-pi/pi-ai";
import { getAgentDir as getOmpAgentDir } from "@oh-my-pi/pi-utils/dirs";
import type { Context, Model, OpenAICodexResponsesOptions, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { parse as parseYaml } from "yaml";

const CODEX_API = "openai-codex-responses";
const CODEX_LB_API = "codex-lb-responses";
const LEGACY_REAL_TOKEN_HEADER = "x-omp-codex-lb-token";
const SHIM_KEY = Symbol.for("omp.codex-lb-responses.transport-shim");
const TOKEN_FINGERPRINT_BYTES = 16;
const DEFAULT_CONTEXT_WINDOW = 272000;
const DEFAULT_MAX_TOKENS = 128000;
const DEFAULT_COST = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 };

type ExtensionApi = {
	setLabel?: (label: string) => void;
	registerProvider: (name: string, config: {
		baseUrl?: string;
		apiKey?: string;
		api: string;
		streamSimple?: (
			model: Model,
			context: Context,
			options?: SimpleStreamOptions,
		) => AssistantMessageEventStream;
		headers?: Record<string, string>;
		authHeader?: boolean;
		models?: Array<Record<string, unknown>>;
		compat?: Record<string, unknown>;
	}) => void;
};

type RawCost = { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
type RawModel = Record<string, unknown> & {
	id?: unknown;
	name?: unknown;
	api?: unknown;
	reasoning?: unknown;
	input?: unknown;
	cost?: RawCost;
	contextWindow?: unknown;
	maxTokens?: unknown;
};
type RawProvider = {
	baseUrl?: unknown;
	apiKey?: unknown;
	api?: unknown;
	headers?: unknown;
	authHeader?: unknown;
	models?: unknown;
	compat?: unknown;
};
type ModelsConfig = { providers?: Record<string, RawProvider> };
type ShimState = {
	tokens: Map<string, string>;
	fetchInstalled: boolean;
	webSocketInstalled: boolean;
};

function getShimState(): ShimState {
	const globalRecord = globalThis as typeof globalThis & Record<symbol, ShimState | undefined>;
	let state = globalRecord[SHIM_KEY];
	if (!state) {
		state = { tokens: new Map(), fetchInstalled: false, webSocketInstalled: false };
		globalRecord[SHIM_KEY] = state;
	}
	return state;
}

function createFakeCodexJwt(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})).toString("base64url");
	return `${header}.${payload}.codexlb`;
}

function createFakeAccountId(providerName: string, baseUrl: string, realApiKey: string): string {
	const hash = createHash("sha256")
		.update(`${providerName}\0${baseUrl}\0${realApiKey}`)
		.digest("base64url")
		.slice(0, TOKEN_FINGERPRINT_BYTES);
	return `codex-lb-${hash}`;
}

function createFakeApiKey(providerName: string, baseUrl: string, realApiKey: string): string {
	return createFakeCodexJwt(createFakeAccountId(providerName, baseUrl, realApiKey));
}

function getAgentDir(): string {
	return getOmpAgentDir();
}

function readModelsConfig(): ModelsConfig | undefined {
	for (const name of ["models.yml", "models.yaml"]) {
		const path = join(getAgentDir(), name);
		if (!existsSync(path)) continue;
		try {
			const parsed = parseYaml(readFileSync(path, "utf8"));
			return parsed && typeof parsed === "object" ? parsed as ModelsConfig : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveNumber(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asHeaders(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, headerValue] of Object.entries(value)) {
		if (typeof headerValue === "string") out[key] = headerValue;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function resolveConfiguredApiKey(apiKey: string): string {
	return process.env[apiKey]?.trim() || apiKey;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length < 2) return undefined;
	try {
		const decoded = Buffer.from(parts[1]!, "base64url").toString("utf8");
		const parsed = JSON.parse(decoded);
		return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function tokenHasCodexAccountId(token: string): boolean {
	const payload = decodeJwtPayload(token);
	const auth = payload?.["https://api.openai.com/auth"];
	return Boolean(
		auth &&
			typeof auth === "object" &&
			"chatgpt_account_id" in auth &&
			typeof (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id === "string" &&
			(auth as { chatgpt_account_id: string }).chatgpt_account_id.length > 0,
	);
}

function isOfficialCodexBaseUrl(baseUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return false;
	}
	const path = url.pathname.replace(/\/+$/, "");
	const responsesPath = path.endsWith("/responses") ? path : `${path}/responses`;
	return url.origin === "https://chatgpt.com" && responsesPath === "/backend-api/codex/responses";
}

function providerUsesOnlyCodexResponses(provider: RawProvider, models: RawModel[]): boolean {
	if (models.length === 0) return false;
	for (const model of models) {
		const api = asNonEmptyString(model.api ?? provider.api);
		if (api !== CODEX_API) return false;
	}
	return true;
}

function shouldWrapProvider(provider: RawProvider, models: RawModel[]): boolean {
	const baseUrl = asNonEmptyString(provider.baseUrl);
	const apiKey = asNonEmptyString(provider.apiKey);
	if (!baseUrl || !apiKey) return false;
	if (!providerUsesOnlyCodexResponses(provider, models)) return false;
	if (isOfficialCodexBaseUrl(baseUrl)) return false;
	return !tokenHasCodexAccountId(resolveConfiguredApiKey(apiKey));
}

function normalizeModel(model: RawModel): Record<string, unknown> | undefined {
	const id = asNonEmptyString(model.id);
	if (!id) return undefined;
	const input = Array.isArray(model.input)
		? model.input.filter((value): value is "text" | "image" => value === "text" || value === "image")
		: ["text"];
	const cost = model.cost && typeof model.cost === "object" ? model.cost : DEFAULT_COST;
	const headers = asHeaders(model.headers);
	return {
		...model,
		id,
		name: asNonEmptyString(model.name) ?? id,
		api: CODEX_LB_API,
		reasoning: typeof model.reasoning === "boolean" ? model.reasoning : true,
		input: input.length > 0 ? input : ["text"],
		contextWindow: asPositiveNumber(model.contextWindow, DEFAULT_CONTEXT_WINDOW),
		maxTokens: asPositiveNumber(model.maxTokens, DEFAULT_MAX_TOKENS),
		cost: {
			input: asPositiveNumber(cost.input, DEFAULT_COST.input),
			output: asPositiveNumber(cost.output, DEFAULT_COST.output),
			cacheRead: typeof cost.cacheRead === "number" ? cost.cacheRead : DEFAULT_COST.cacheRead,
			cacheWrite: typeof cost.cacheWrite === "number" ? cost.cacheWrite : DEFAULT_COST.cacheWrite,
		},
		...(headers ? { headers } : {}),
	};
}

function discoverCodexLbProviders(): Array<{
	name: string;
	baseUrl: string;
	realApiKey: string;
	fakeApiKey: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models: Array<Record<string, unknown>>;
	compat?: Record<string, unknown>;
}> {
	const providers = readModelsConfig()?.providers;
	if (!providers) return [];
	const discovered = [];
	for (const [name, provider] of Object.entries(providers)) {
		if (!provider || typeof provider !== "object") continue;
		const rawModels = Array.isArray(provider.models) ? provider.models as RawModel[] : [];
		if (!shouldWrapProvider(provider, rawModels)) continue;
		const models = rawModels.map(normalizeModel).filter((model): model is Record<string, unknown> => Boolean(model));
		const baseUrl = asNonEmptyString(provider.baseUrl);
		const apiKey = asNonEmptyString(provider.apiKey);
		if (!baseUrl || !apiKey || models.length === 0) continue;
		const realApiKey = resolveConfiguredApiKey(apiKey);
		const fakeApiKey = createFakeApiKey(name, baseUrl, realApiKey);
		discovered.push({
			name,
			baseUrl,
			realApiKey,
			fakeApiKey,
			headers: asHeaders(provider.headers),
			authHeader: typeof provider.authHeader === "boolean" ? provider.authHeader : undefined,
			models,
			compat: asPlainRecord(provider.compat),
		});
	}
	return discovered;
}

function rewriteCodexLbHeaders(init: HeadersInit | undefined): HeadersInit | undefined {
	if (!init) return init;
	const headers = new Headers(init);
	const authorization = headers.get("authorization") ?? headers.get("Authorization");
	const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
	const realToken = bearerToken ? getShimState().tokens.get(bearerToken) : undefined;
	if (!realToken) return init;

	headers.set("Authorization", `Bearer ${realToken}`);
	headers.delete("chatgpt-account-id");
	headers.delete(LEGACY_REAL_TOKEN_HEADER);
	return headers;
}

function toWsUrl(httpUrl: string): string {
	return httpUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

function isCodexLbSseRequest(url: string, headers: Headers): boolean {
	const authorization = headers.get("authorization") ?? headers.get("Authorization");
	const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
	if (!bearerToken || !getShimState().tokens.has(bearerToken)) return false;
	const accept = headers.get("accept") ?? "";
	return accept.includes("text/event-stream");
}

const WS_PROXY_IDLE_TIMEOUT_MS = 300_000;
const WS_PROXY_TERMINAL_EVENTS = new Set([
	"response.completed", "response.done", "response.incomplete", "response.failed", "error",
]);

function fetchViaWebSocket(url: string, init: RequestInit): Promise<Response> {
	const headers = new Headers(init.headers);
	const rewritten = rewriteCodexLbHeaders(headers) as Headers;
	rewritten.delete("accept");
	rewritten.delete("content-type");
	const betaHeader = rewritten.get("openai-beta");
	if (betaHeader && betaHeader.includes("responses=")) {
		rewritten.set("openai-beta", betaHeader.replace(/responses=[^\s,;]+/, "responses_websockets=2026-02-06"));
	}
	const headerRecord: Record<string, string> = {};
	for (const [k, v] of rewritten.entries()) headerRecord[k] = v;

	return new Promise((resolve, reject) => {
		const wsUrl = toWsUrl(url);
		const ws = new WebSocket(wsUrl, { headers: headerRecord } as unknown as string[]);
		(ws as unknown as { binaryType: string }).binaryType = "nodebuffer";
		const signal = init.signal;
		let settled = false;
		let streamClosed = false;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

		const teardown = () => {
			if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
			signal?.removeEventListener("abort", onAbort);
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
				ws.close(1000, "teardown");
			}
		};

		const closeStream = (reason?: Error) => {
			if (streamClosed) return;
			streamClosed = true;
			teardown();
			if (!controllerRef) return;
			if (reason) {
				try { controllerRef.error(reason); } catch {}
			} else {
				try { controllerRef.close(); } catch {}
			}
		};

		const resetIdleTimer = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				closeStream(new Error("WebSocket proxy idle timeout"));
			}, WS_PROXY_IDLE_TIMEOUT_MS);
		};

		const onAbort = () => {
			if (!settled) {
				settled = true;
				teardown();
				reject(new Error("Request was aborted"));
				return;
			}
			closeStream(new Error("Request was aborted"));
		};
		signal?.addEventListener("abort", onAbort);

		ws.addEventListener("open", () => {
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(init.body as string);
			} catch {
				settled = true;
				teardown();
				reject(new Error("Failed to parse request body"));
				return;
			}
			body.type = "response.create";
			ws.send(JSON.stringify(body));
			resetIdleTimer();

			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controllerRef = controller;
					ws.addEventListener("message", (event: MessageEvent) => {
						if (streamClosed) return;
						resetIdleTimer();
						const text = typeof event.data === "string"
							? event.data
							: Buffer.isBuffer(event.data) ? event.data.toString("utf8") : String(event.data);
						let parsed: Record<string, unknown>;
						try { parsed = JSON.parse(text); } catch { return; }
						const eventType = typeof parsed.type === "string" ? parsed.type : "";
						if (!eventType || eventType === "codex.keepalive") return;
						const sseChunk = `event: ${eventType}\ndata: ${text}\n\n`;
						try { controller.enqueue(encoder.encode(sseChunk)); } catch { return; }
						if (WS_PROXY_TERMINAL_EVENTS.has(eventType)) {
							closeStream();
						}
					});
					ws.addEventListener("close", () => { closeStream(); });
					ws.addEventListener("error", (e: Event) => {
						closeStream(new Error(`WebSocket error: ${(e as ErrorEvent).message ?? "unknown"}`));
					});
				},
				cancel() { closeStream(); },
			});

			settled = true;
			resolve(new Response(stream, {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "text/event-stream; charset=utf-8" },
			}));
		});

		ws.addEventListener("error", (e: Event) => {
			if (!settled) {
				settled = true;
				teardown();
				reject(new Error(`WebSocket connection failed: ${(e as ErrorEvent).message ?? "unknown"}`));
			}
		});

		ws.addEventListener("close", (e: CloseEvent) => {
			if (!settled) {
				settled = true;
				teardown();
				reject(new Error(`WebSocket closed before open: ${e.code} ${e.reason}`));
			}
		});
	});
}

function installCodexLbFetchShim(): void {
	const state = getShimState();
	if (state.fetchInstalled) return;
	const nativeFetch = globalThis.fetch;
	if (typeof nativeFetch !== "function") return;
	const shimFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : input.toString();
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		if (isCodexLbSseRequest(url, headers) && init?.body) {
			return fetchViaWebSocket(url, init);
		}
		if (init?.headers) {
			return nativeFetch(input, { ...init, headers: rewriteCodexLbHeaders(init.headers) });
		}
		if (input instanceof Request) {
			const rewritten = rewriteCodexLbHeaders(input.headers);
			if (rewritten !== input.headers) return nativeFetch(new Request(input, { headers: rewritten }), init);
		}
		return nativeFetch(input, init);
	}) as typeof fetch;
	const preconnect = (nativeFetch as typeof fetch & { preconnect?: unknown }).preconnect;
	if (typeof preconnect === "function") {
		(shimFetch as typeof fetch & { preconnect?: unknown }).preconnect = preconnect.bind(nativeFetch);
	}
	globalThis.fetch = shimFetch;
	state.fetchInstalled = true;
}

function installCodexLbWebSocketShim(): void {
	const state = getShimState();
	if (state.webSocketInstalled) return;

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
	state.webSocketInstalled = true;
}

function installCodexLbTransportShims(): void {
	installCodexLbFetchShim();
	installCodexLbWebSocketShim();
}

function resolveRealApiKey(apiKey: string): string {
	return getShimState().tokens.get(apiKey) ?? apiKey;
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

function streamCodexLb(
	model: Model,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const apiKey = options?.apiKey;
	const realApiKey = apiKey ? resolveRealApiKey(apiKey) : undefined;
	if (!realApiKey || realApiKey === "N/A") {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	installCodexLbTransportShims();

	const innerModel = { ...model, api: CODEX_API, headers: model.headers } as Model<"openai-codex-responses">;
	const codexOptions = options as SimpleStreamOptions | undefined;
	const ensuredSessionId = codexOptions?.sessionId ?? randomUUID();
	const innerApiKey = createFakeApiKey(model.provider, model.baseUrl ?? "", realApiKey);

	const innerOptions: OpenAICodexResponsesOptions = {
		...codexOptions,
		apiKey: innerApiKey,
		sessionId: ensuredSessionId,
		promptCacheKey: codexOptions?.promptCacheKey ?? codexOptions?.sessionId ?? ensuredSessionId,
		providerSessionState: codexOptions?.providerSessionState ?? new Map(),
		preferWebsockets: true,
		reasoning: codexOptions?.disableReasoning ? "none" : codexOptions?.reasoning as OpenAICodexResponsesOptions["reasoning"],
		reasoningSummary: codexOptions?.hideThinkingSummary ? null : undefined,
		fetch: createCodexLbFetch(codexOptions?.fetch),
	};

	getShimState().tokens.set(innerApiKey, realApiKey);
	const inner = streamOpenAICodexResponses(innerModel, context, innerOptions);

	const outer = new AssistantMessageEventStream();
	(async () => {
		try {
			for await (const event of inner) {
				const ev = event as Record<string, unknown>;
				if (ev.message && typeof ev.message === "object") {
					(ev.message as Record<string, unknown>).api = CODEX_LB_API;
				}
				if (ev.partial && typeof ev.partial === "object") {
					(ev.partial as Record<string, unknown>).api = CODEX_LB_API;
				}
				if (ev.error && typeof ev.error === "object") {
					(ev.error as Record<string, unknown>).api = CODEX_LB_API;
				}
				outer.push(event);
			}
			const result = await inner.result();
			result.api = CODEX_LB_API as any;
			outer.end(result);
		} catch (error) {
			outer.fail(error);
		}
	})();
	return outer;
}

export default function codexLbResponses(pi: ExtensionApi): void {
	pi.setLabel?.("Codex LB Responses");
	installCodexLbTransportShims();

	pi.registerProvider(CODEX_LB_API, {
		api: CODEX_LB_API,
		streamSimple: streamCodexLb,
	});

	for (const provider of discoverCodexLbProviders()) {
		getShimState().tokens.set(provider.fakeApiKey, provider.realApiKey);
		pi.registerProvider(provider.name, {
			baseUrl: provider.baseUrl,
			apiKey: provider.fakeApiKey,
			headers: provider.headers,
			authHeader: provider.authHeader,
			api: CODEX_LB_API,
			models: provider.models,
			compat: provider.compat,
		});
	}
}
