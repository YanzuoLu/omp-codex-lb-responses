import { existsSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { modelOmitsReasoningEffort, requireSupportedEffort, streamOpenAICodexResponses } from "@oh-my-pi/pi-ai";
import type {
	AssistantMessageEventStream,
	Context,
	Effort,
	Model,
	OpenAICodexResponsesOptions,
	SimpleStreamOptions,
	ToolChoice,
} from "@oh-my-pi/pi-ai";
import { parse as parseYaml } from "yaml";

const CODEX_LB_API = "codex-lb-responses";
const INNER_CODEX_API = "openai-codex-responses";
const REAL_TOKEN_HEADER = "x-omp-codex-lb-token";
const SHIM_KEY = Symbol.for("omp.codex-lb-responses.transport-shim");
const DEFAULT_CONTEXT_WINDOW = 272000;
const DEFAULT_MAX_TOKENS = 128000;
const DEFAULT_COST = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 };

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
		headers?: Record<string, string>;
		authHeader?: boolean;
		models?: Array<Record<string, unknown>>;
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

function createFakeAccountId(providerName: string, baseUrl: string): string {
	const hash = createHash("sha256").update(`${providerName}\0${baseUrl}`).digest("base64url").slice(0, 12);
	return `codex-lb-${hash}`;
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent");
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
		if (api !== INNER_CODEX_API) return false;
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
		discovered.push({
			name,
			baseUrl,
			realApiKey,
			fakeApiKey: createFakeCodexJwt(createFakeAccountId(name, baseUrl)),
			headers: asHeaders(provider.headers),
			authHeader: typeof provider.authHeader === "boolean" ? provider.authHeader : undefined,
			models,
		});
	}
	return discovered;
}

function rewriteCodexLbHeaders(init: HeadersInit | undefined): HeadersInit | undefined {
	if (!init) return init;
	const headers = new Headers(init);
	const privateToken = headers.get(REAL_TOKEN_HEADER);
	const authorization = headers.get("authorization") ?? headers.get("Authorization");
	const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
	const mappedToken = bearerToken ? getShimState().tokens.get(bearerToken) : undefined;
	const realToken = privateToken ?? mappedToken;
	if (!realToken) return init;

	headers.set("Authorization", `Bearer ${realToken}`);
	headers.delete("chatgpt-account-id");
	headers.delete(REAL_TOKEN_HEADER);
	return headers;
}

function installCodexLbFetchShim(): void {
	const state = getShimState();
	if (state.fetchInstalled) return;
	const nativeFetch = globalThis.fetch;
	if (typeof nativeFetch !== "function") return;
	const shimFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.headers) {
			return nativeFetch(input, { ...init, headers: rewriteCodexLbHeaders(init.headers) });
		}
		if (input instanceof Request) {
			const headers = rewriteCodexLbHeaders(input.headers);
			if (headers !== input.headers) return nativeFetch(new Request(input, { headers }), init);
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

type CodexLbStreamOptions = Omit<SimpleStreamOptions, "reasoning"> &
	Pick<OpenAICodexResponsesOptions, "include" | "reasoning" | "reasoningSummary" | "textVerbosity">;

function resolveRealApiKey(apiKey: string): string {
	return getShimState().tokens.get(apiKey) ?? apiKey;
}

function resolveCodexReasoning(
	model: Model<"openai-codex-responses">,
	options: CodexLbStreamOptions | undefined,
): OpenAICodexResponsesOptions["reasoning"] {
	if (!options || !model.reasoning) return undefined;
	if (options.disableReasoning || options.reasoning === "none") return "none";
	if (!options.reasoning || modelOmitsReasoningEffort(model)) return undefined;
	return requireSupportedEffort(model, options.reasoning as Effort) as OpenAICodexResponsesOptions["reasoning"];
}

function mapCodexToolChoice(choice: ToolChoice | undefined): ToolChoice | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "any") return "required";
		if (choice === "auto" || choice === "none" || choice === "required") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "function", function: { name: choice.name } } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "function", function: { name } } : undefined;
	}
	return undefined;
}

function omitCodexReasoningSummary(payload: unknown): void {
	if (!payload || typeof payload !== "object") return;
	const reasoning = (payload as { reasoning?: unknown }).reasoning;
	if (!reasoning || typeof reasoning !== "object") return;
	delete (reasoning as { summary?: unknown }).summary;
}

function mapCodexOnPayload(
	options: CodexLbStreamOptions | undefined,
): OpenAICodexResponsesOptions["onPayload"] {
	if (!options?.hideThinkingSummary) return options?.onPayload;
	return (payload, model) => {
		omitCodexReasoningSummary(payload);
		return options.onPayload?.(payload, model);
	};
}

function needsCodexUtilitySession(options: CodexLbStreamOptions | undefined): boolean {
	return Boolean(options && !options.sessionId && (options.disableReasoning || options.toolChoice !== undefined));
}

function mapCodexOptions(
	model: Model<"openai-codex-responses">,
	options: SimpleStreamOptions | undefined,
	realApiKey: string,
): OpenAICodexResponsesOptions {
	const codexOptions = options as CodexLbStreamOptions | undefined;
	const generatedSessionId = needsCodexUtilitySession(codexOptions) ? randomUUID() : undefined;
	return {
		temperature: codexOptions?.temperature,
		topP: codexOptions?.topP,
		topK: codexOptions?.topK,
		minP: codexOptions?.minP,
		presencePenalty: codexOptions?.presencePenalty,
		repetitionPenalty: codexOptions?.repetitionPenalty,
		maxTokens: codexOptions?.maxTokens ?? model.maxTokens,
		signal: codexOptions?.signal,
		apiKey: createFakeCodexJwt(createFakeAccountId(model.provider, model.baseUrl ?? "")),
		cacheRetention: codexOptions?.cacheRetention,
		headers: { ...(codexOptions?.headers ?? {}), [REAL_TOKEN_HEADER]: realApiKey },
		initiatorOverride: codexOptions?.initiatorOverride,
		maxRetryDelayMs: codexOptions?.maxRetryDelayMs,
		metadata: codexOptions?.metadata,
		taskBudget: codexOptions?.taskBudget,
		sessionId: codexOptions?.sessionId ?? generatedSessionId,
		promptCacheKey: codexOptions?.promptCacheKey,
		streamFirstEventTimeoutMs: codexOptions?.streamFirstEventTimeoutMs,
		streamIdleTimeoutMs: codexOptions?.streamIdleTimeoutMs,
		providerSessionState: codexOptions?.providerSessionState ?? (generatedSessionId ? new Map() : undefined),
		onPayload: mapCodexOnPayload(codexOptions),
		onResponse: codexOptions?.onResponse,
		onSseEvent: codexOptions?.onSseEvent,
		execHandlers: codexOptions?.execHandlers,
		fetch: createCodexLbFetch(codexOptions?.fetch),
		include: codexOptions?.include,
		reasoning: resolveCodexReasoning(model, codexOptions),
		reasoningSummary: codexOptions?.hideThinkingSummary ? null : codexOptions?.reasoningSummary,
		textVerbosity: codexOptions?.textVerbosity,
		toolChoice: mapCodexToolChoice(codexOptions?.toolChoice),
		serviceTier: codexOptions?.serviceTier,
		preferWebsockets: codexOptions?.preferWebsockets ?? (generatedSessionId ? true : undefined),
	};
}

function streamCodexLbResponses(
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

	const innerModel = {
		...model,
		api: INNER_CODEX_API,
		headers: { ...(model.headers ?? {}), [REAL_TOKEN_HEADER]: realApiKey },
	} as Model<"openai-codex-responses">;
	const innerOptions = mapCodexOptions(innerModel, options, realApiKey);

	getShimState().tokens.set(innerOptions.apiKey, realApiKey);
	return streamOpenAICodexResponses(innerModel, context, innerOptions);
}

export default function codexLbResponses(pi: ExtensionApi): void {
	pi.setLabel?.("Codex LB Responses");
	installCodexLbTransportShims();
	const providers = discoverCodexLbProviders();
	if (providers.length === 0) {
		pi.registerProvider(CODEX_LB_API, {
			api: CODEX_LB_API,
			streamSimple: streamCodexLbResponses,
		});
		return;
	}

	for (const provider of providers) {
		getShimState().tokens.set(provider.fakeApiKey, provider.realApiKey);
		pi.registerProvider(provider.name, {
			baseUrl: provider.baseUrl,
			apiKey: provider.fakeApiKey,
			headers: provider.headers,
			authHeader: provider.authHeader,
			api: CODEX_LB_API,
			models: provider.models,
			streamSimple: streamCodexLbResponses,
		});
	}
}
