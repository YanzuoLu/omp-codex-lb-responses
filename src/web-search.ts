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
import { codexLbSearch, formatForLLM, hasRenderableSearchContent, retryAsync, type SearchResponse, WEB_SEARCH_SYSTEM_PROMPT, WEB_SEARCH_TOOL_DESCRIPTION } from "./web-search-core";
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
}

/** Runtime wiring the search needs from the provider: the WS pool + a base fetch. */
export interface WebSearchRuntime {
	pool: WebSocketFetch;
	baseFetch: FetchLike;
	/** Max codex-lb search attempts (fresh WS/session each) before giving up. Default 3. */
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
		// Lazy require so a missing/renamed internal never breaks loading our tool.
		const mod = require("@oh-my-pi/pi-coding-agent/web/search/index");
		const tools = typeof mod.getSearchTools === "function" ? mod.getSearchTools() : [];
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

	// Runs one codex-lb web search over a FRESH session-keyed WS (codex-lb only
	// works over the WebSocket transport). Throws on a transient/upstream failure
	// so the caller can retry.
	async function searchOnce(query: string, numSearchResults: number | undefined, signal: AbortSignal | undefined): Promise<SearchResponse> {
		const sessionId = `websearch-${randomUUID()}`;
		const wsFetch = runtime.pool.bind(sessionId, runtime.baseFetch);
		try {
			return await codexLbSearch(
				{ query, systemPrompt: WEB_SEARCH_SYSTEM_PROMPT, numSearchResults, signal },
				{ baseUrl: config.baseUrl, apiKey: config.apiKey, modelId: config.searchModel, searchContextSize: config.searchContextSize, fetchImpl: wsFetch },
			);
		} finally {
			runtime.pool.remove(sessionId);
		}
	}

	async function runCodexLb(query: string, numSearchResults: number | undefined, signal: AbortSignal | undefined) {
		try {
			const response = await retryAsync((attempt) => searchOnce(query, numSearchResults, signal), {
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
		async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			const model = ctx?.model;
			const isCodexLb = !model || model.provider === config.providerID;
			if (isCodexLb) {
				return runCodexLb(params.query, params.num_search_results, signal);
			}
			// Non-codex-lb model: keep omp's native web search exactly as-is.
			const native = getNativeWebSearchTool();
			if (native?.execute) {
				try {
					// Native CustomTool.execute order: (toolCallId, params, onUpdate, ctx, signal).
					return await native.execute(toolCallId, params, onUpdate, ctx, signal);
				} catch (error) {
					pi.logger?.warn?.("codex-lb: native web_search delegation failed", { error: String(error) });
				}
			}
			// Last resort: run codex-lb search so the model still gets web results.
			return runCodexLb(params.query, params.num_search_results, signal);
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
	pi.logger?.info?.(`omp-codex-lb-responses: registered codex-lb web_search over WebSocket (overrides native for ${config.providerID} turns)`);
}
