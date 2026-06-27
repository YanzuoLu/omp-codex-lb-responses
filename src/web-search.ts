// omp glue for the codex-lb web-search tool (B3).
//
// Registers a `web_search` tool that OVERRIDES omp's built-in one (extension
// tools win the name in omp's tool registry). It routes by the active model:
//   - codex-lb model  → a byte-identical native codex web-search request sent to
//                        codex-lb OVER THE WEBSOCKET TRANSPORT (web-search-core),
//                        so native web search is effectively replaced for codex-lb
//                        turns.
//   - any other model → delegated to omp's native web_search, unchanged.
// Results render through omp's OWN exported card renderer, so the TUI card is
// identical to native.
//
// Transport: codex-lb's plain-HTTP `/responses` is non-functional (it closes the
// upstream with 1011 before completing); ONLY the WebSocket transport works. So
// the search MUST run over the same session-keyed WS pool the provider uses — it
// does NOT use the tool ctx's fetch (which is plain HTTP). codex-lb's upstream
// also returns transient 1011s even for valid requests, so the search retries a
// few times (a fresh WS/session per attempt) — mirroring how the chat path
// survives transient upstream failures via turn replay.
//
// This module imports omp internals (renderers + the native tool) and is loaded
// LAZILY by index.ts only when web search is enabled, so the unit-testable core
// (web-search-core) and the rest of the plugin never depend on pi-coding-agent.

import { randomUUID } from "node:crypto";
import { renderSearchCall, renderSearchResult } from "@oh-my-pi/pi-coding-agent/web/search/render";
import { getSearchTools } from "@oh-my-pi/pi-coding-agent/web/search/index";
import { codexLbSearch, formatForLLM, hasRenderableSearchContent, isCodexLbTurn, retryAsync, type SearchResponse, WEB_SEARCH_SYSTEM_PROMPT, WEB_SEARCH_TOOL_DESCRIPTION } from "./web-search-core";
import type { FetchLike, WebSocketFetch } from "./ws-pool";

type Pi = {
	zod: { z: any };
	logger?: { warn?: (m: string, meta?: unknown) => void; info?: (m: string, meta?: unknown) => void };
	registerTool: (tool: any) => void;
};

export interface WebSearchToolConfig {
	providerID: string;
	baseUrl: string;
	apiKey: string;
	searchModel: string;
	searchContextSize?: "low" | "medium" | "high";
	/** Force EVERY web_search to codex-lb, even on non-codex-lb turns (no native delegation). */
	force?: boolean;
}

/** Runtime wiring the search needs from the provider: the WS pool + a base fetch. */
export interface WebSearchRuntime {
	pool: WebSocketFetch;
	baseFetch: FetchLike;
	/** Returns the active conversation's session id so the search reuses its socket. */
	getSessionId?: () => string | undefined;
	/** True if `sessionId` belongs to a codex-lb turn (vs another provider's). */
	isCodexLbSession?: (sessionId: string) => boolean;
	/** True if a codex-lb turn ran very recently (fallback when no session/model in ctx). */
	recentlyCodexLb?: () => boolean;
	/** Max codex-lb search attempts before giving up. Default 3. */
	maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function isAbortLike(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

// A hard-timeout abort (AbortSignal.timeout) surfaces as a TimeoutError. Retrying
// a timeout just burns another full timeout budget for little gain, so we treat
// both abort and timeout as non-retryable (transient 1011/connection errors,
// which fail fast, are the ones worth retrying).
function isTimeoutLike(error: unknown): boolean {
	return error instanceof DOMException && error.name === "TimeoutError";
}

let nativeToolCache: any | null | undefined;
function getNativeWebSearchTool(): any | undefined {
	if (nativeToolCache !== undefined) return nativeToolCache ?? undefined;
	try {
		// omp's web/search module is ESM — must use the static import, NOT require()
		// (require returns no exports for it, which silently nulled the native tool and
		// sent every non-codex-lb search to the codex-lb fallback).
		const tools = typeof getSearchTools === "function" ? getSearchTools() : [];
		nativeToolCache = tools.find((t: any) => t?.name === "web_search") ?? null;
	} catch {
		nativeToolCache = null;
	}
	return nativeToolCache ?? undefined;
}

function errorResult(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { response: { provider: "codex", sources: [] }, error: message },
	};
}

/**
 * Builds the `web_search` ToolDefinition. Registered via `pi.registerTool`, it
 * overrides omp's built-in web_search and routes codex-lb turns to codex-lb.
 */
export function createWebSearchTool(pi: Pi, config: WebSearchToolConfig, runtime: WebSearchRuntime): any {
	const { z } = pi.zod;
	const parameters = z.object({
		query: z.string().describe("The search query"),
		recency: z.enum(["day", "week", "month", "year"]).optional().describe("Restrict results by recency"),
		limit: z.number().optional(),
		num_search_results: z.number().optional().describe("Max number of sources to return"),
		max_tokens: z.number().optional(),
		temperature: z.number().optional(),
	});
	const maxAttempts = Math.max(1, runtime.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

	// Runs one codex-lb web search over the WebSocket transport (codex-lb only works
	// over WS). REUSES the conversation's pooled socket (its session id) when known —
	// opening a SEPARATE WS gets a brand-new upgrade, which codex-lb rejects whenever
	// its new-connection path is degraded (502 → "Expected 101") even though the
	// conversation's already-established socket still works. Falls back to a fresh
	// ephemeral session otherwise. Throws on a transient/upstream failure so the
	// caller can retry.
	async function searchOnce(
		query: string,
		numSearchResults: number | undefined,
		signal: AbortSignal | undefined,
		conversationSession: string | undefined,
	): Promise<SearchResponse> {
		const sessionId = conversationSession ?? `websearch-${randomUUID()}`;
		const wsFetch = runtime.pool.bind(sessionId, runtime.baseFetch);
		try {
			return await codexLbSearch(
				{ query, systemPrompt: WEB_SEARCH_SYSTEM_PROMPT, numSearchResults, signal },
				{ baseUrl: config.baseUrl, apiKey: config.apiKey, modelId: config.searchModel, searchContextSize: config.searchContextSize, fetchImpl: wsFetch },
			);
		} finally {
			// Only drop sockets we created; the conversation owns (and reuses) its own.
			if (!conversationSession) runtime.pool.remove(sessionId);
		}
	}

	async function runCodexLb(
		query: string,
		numSearchResults: number | undefined,
		signal: AbortSignal | undefined,
		conversationSession: string | undefined,
	) {
		try {
			const response = await retryAsync((attempt) => searchOnce(query, numSearchResults, signal, conversationSession), {
				maxAttempts,
				isRetryable: (error) => !isAbortLike(error) && !isTimeoutLike(error),
				onRetry: (attempt, error) => pi.logger?.warn?.(`codex-lb web_search attempt ${attempt}/${maxAttempts} failed, retrying: ${String(error)}`),
				delayMs: (attempt) => 200 * attempt,
				signal,
			});
			if (!hasRenderableSearchContent(response)) {
				return { content: [{ type: "text" as const, text: "Error: codex-lb web search returned no results." }], details: { response } };
			}
			return { content: [{ type: "text" as const, text: formatForLLM(response) }], details: { response } };
		} catch (error) {
			if (isAbortLike(error)) throw error;
			pi.logger?.warn?.(`codex-lb web_search FAILED after ${maxAttempts} attempt(s): ${String((error as Error)?.stack ?? error)}`);
			return errorResult(`Error: codex-lb web search failed: ${String(error)}`);
		}
	}

	return {
		name: "web_search",
		label: "Web Search",
		description: WEB_SEARCH_TOOL_DESCRIPTION,
		parameters,
		approval: "read",

		// Extension ToolDefinition.execute signature: (toolCallId, params, signal, onUpdate, ctx).
		// omp's ctx carries { model, sessionId, signal, ... } — prefer ctx.sessionId so
		// the search rides THIS turn's conversation socket; fall back to the provider's
		// last-seen session, then a fresh ephemeral one.
		async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			// `force` (webSearchForce): always route to codex-lb regardless of the turn's
			// model — opt-in global override (no native delegation). Otherwise route by
			// the turn's provider: codex-lb turn → codex-lb, everything else → native.
			const isCodexLb = config.force === true || isCodexLbTurn(ctx, config.providerID, runtime);
			const conversationSession =
				(typeof ctx?.sessionId === "string" && ctx.sessionId) || runtime.getSessionId?.() || undefined;
			if (isCodexLb) {
				return runCodexLb(params.query, params.num_search_results, signal, conversationSession);
			}
			// NON-codex-lb turn (e.g. omp fell back to the built-in openai-codex): run
			// omp's native web search UNCHANGED. The native tool is a CustomTool, whose
			// execute order is (toolCallId, params, onUpdate, ctx, signal) — DIFFERENT
			// from our extension ToolDefinition order (..., signal, onUpdate, ctx) — so
			// we reorder when delegating (passing it straight through makes native read
			// our onUpdate as its ctx → "ctx.sessionManager is undefined"). NEVER fall
			// back to codex-lb here — that is exactly the hijack that broke openai-codex.
			const native = getNativeWebSearchTool();
			if (native?.execute) {
				return await native.execute(toolCallId, params, onUpdate, ctx, signal);
			}
			pi.logger?.warn?.("codex-lb: native web_search tool not found; cannot delegate non-codex-lb search");
			return errorResult("Error: web search is unavailable for this provider (native search tool not found).");
		},

		renderCall(args: any, options: any, theme: any) {
			return renderSearchCall(args, options, theme);
		},
		renderResult(result: any, options: any, theme: any, args: any) {
			return renderSearchResult(result, options, theme, args);
		},
	};
}

/** Registers the codex-lb web_search tool on the extension. */
export function registerCodexLbWebSearch(pi: Pi, config: WebSearchToolConfig, runtime: WebSearchRuntime): void {
	pi.registerTool(createWebSearchTool(pi, config, runtime));
	pi.logger?.info?.(
		config.force
			? `omp-codex-lb-responses: registered codex-lb web_search over WebSocket (FORCED for ALL turns — no native delegation)`
			: `omp-codex-lb-responses: registered codex-lb web_search over WebSocket (overrides native for ${config.providerID} turns)`,
	);
}
