import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai";
import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";

const CODEX_LB_API = "codex-lb-responses";
const INNER_CODEX_API = "openai-codex-responses";
const REAL_TOKEN_HEADER = "x-omp-codex-lb-token";
const FAKE_ACCOUNT_ID = "codex-lb";
const SHIM_KEY = Symbol.for("omp.codex-lb-responses.websocket-shim");

type ExtensionApi = {
	setLabel?: (label: string) => void;
	registerProvider: (name: string, config: {
		api: string;
		streamSimple: (
			model: Model,
			context: Context,
			options?: SimpleStreamOptions,
		) => AssistantMessageEventStream;
	}) => void;
};

function base64UrlJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createFakeCodexJwt(): string {
	return `${base64UrlJson({ alg: "none", typ: "JWT" })}.${base64UrlJson({
		"https://api.openai.com/auth": { chatgpt_account_id: FAKE_ACCOUNT_ID },
	})}.codexlb`;
}

const FAKE_CODEX_JWT = createFakeCodexJwt();

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
	pi.registerProvider("codex-lb-responses", {
		api: CODEX_LB_API,
		streamSimple: streamCodexLbResponses,
	});
}
