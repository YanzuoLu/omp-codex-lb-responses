// omp glue for the codex-lb web-search tool (B3).
//
// Registers a `web_search` tool that OVERRIDES omp's built-in one (extension
// tools win the name in omp's tool registry). It routes by the active model:
//   - codex-lb model  → a byte-identical native codex web-search request sent to
//                        codex-lb (web-search-core), so native web search is
//                        effectively replaced for codex-lb turns.
//   - any other model → delegated to omp's native web_search, unchanged.
// Results render through omp's OWN exported card renderer, so the TUI card is
// identical to native.
//
// This module imports omp internals (renderers + the native tool) and is loaded
// LAZILY by index.ts only when web search is enabled, so the unit-testable core
// (web-search-core) and the rest of the plugin never depend on pi-coding-agent.

import { renderSearchCall, renderSearchResult } from "@oh-my-pi/pi-coding-agent/web/search/render";
import { codexLbSearch, formatForLLM, hasRenderableSearchContent, WEB_SEARCH_SYSTEM_PROMPT, WEB_SEARCH_TOOL_DESCRIPTION } from "./web-search-core";

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

/**
 * Builds the `web_search` ToolDefinition. Registered via `pi.registerTool`, it
 * overrides omp's built-in web_search and routes codex-lb turns to codex-lb.
 */
export function createWebSearchTool(pi: Pi, config: WebSearchToolConfig): any {
	const { z } = pi.zod;
	const parameters = z.object({
		query: z.string().describe("The search query"),
		recency: z.enum(["day", "week", "month", "year"]).optional().describe("Restrict results by recency"),
		limit: z.number().optional(),
		num_search_results: z.number().optional().describe("Max number of sources to return"),
		max_tokens: z.number().optional(),
		temperature: z.number().optional(),
	});

	async function runCodexLb(
		query: string,
		numSearchResults: number | undefined,
		signal: AbortSignal | undefined,
		fetchImpl: ((input: any, init?: any) => Promise<Response>) | undefined,
	) {
		const response = await codexLbSearch(
			{ query, systemPrompt: WEB_SEARCH_SYSTEM_PROMPT, numSearchResults, signal },
			{ baseUrl: config.baseUrl, apiKey: config.apiKey, modelId: config.searchModel, searchContextSize: config.searchContextSize, fetchImpl },
		);
		if (!hasRenderableSearchContent(response)) {
			return {
				content: [{ type: "text" as const, text: "Error: codex-lb web search returned no results." }],
				details: { response: { provider: "codex", sources: [] }, error: "no results" },
			};
		}
		return { content: [{ type: "text" as const, text: formatForLLM(response) }], details: { response } };
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
			const ctxFetch = typeof ctx?.fetch === "function" ? ctx.fetch : undefined;
			const isCodexLb = !model || model.provider === config.providerID;
			if (isCodexLb) {
				try {
					return await runCodexLb(params.query, params.num_search_results, signal, ctxFetch);
				} catch (error) {
					pi.logger?.warn?.(`codex-lb web_search FAILED: ${String((error as Error)?.stack ?? error)}`);
					return { content: [{ type: "text" as const, text: `Error: codex-lb web search failed: ${String(error)}` }], details: { response: { provider: "codex", sources: [] }, error: String(error) } };
				}
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
			return runCodexLb(params.query, params.num_search_results, signal, ctxFetch);
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
export function registerCodexLbWebSearch(pi: Pi, config: WebSearchToolConfig): void {
	pi.registerTool(createWebSearchTool(pi, config));
	pi.logger?.info?.(`omp-codex-lb-responses: registered codex-lb web_search (overrides native for ${config.providerID} turns)`);
}
