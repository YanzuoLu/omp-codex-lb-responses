// Faithful replica of omp's native "codex" web search, pointed at codex-lb.
//
// The request body, the web_search tool spec, the SSE result parsing, and the
// model-facing `formatForLLM` output are copied byte-for-byte from omp 16.x
// (pi-coding-agent/src/web/search/providers/codex.ts + .../web/search/index.ts)
// so the search behaves identically to native Codex web search. Only the URL
// (→ codex-lb), the auth (→ plain Bearer, no chatgpt-account-id), and the fetch
// (→ provider-scoped) differ. Zero omp runtime imports so it stays unit-testable.

export interface SearchSource {
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
	ageSeconds?: number;
	author?: string;
}

export interface SearchResponse {
	provider: string;
	answer?: string;
	sources: SearchSource[];
	usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
	model?: string;
	requestId?: string;
}

// omp's prompts/system/web-search.md — sent as `instructions` so the answer
// style matches native Codex web search verbatim.
export const WEB_SEARCH_SYSTEM_PROMPT = `Research assistant with web search. Find accurate, well-sourced information. Synthesize comprehensive answers.

<priorities>
1. Accuracy over speed — verify claims across multiple sources when possible
2. Primary over secondary — prefer official docs, papers, and announcements over blog summaries
3. Recency matters — note publication dates; prefer recent sources for time-sensitive topics
4. Transparency on uncertainty — distinguish confirmed facts from inferences
</priorities>

<synthesis>
- Lead with a direct answer, then supporting evidence
- Quote or paraphrase specific sources; no vague attributions
- Sources conflict: acknowledge the discrepancy and note which is more authoritative
- Technical topics: prefer official documentation and specifications
- News/events: prefer primary reporting over aggregators
- Include concrete data: version numbers, dates, exact figures, code snippets, specific examples
</synthesis>

<format>
- Be thorough — cover the topic in depth with specific evidence, not surface-level summaries
- Omit filler and unnecessary hedging; do NOT sacrifice detail for brevity
- Include publication dates when recency affects relevance
- Structure answers with clear sections when covering multiple aspects
- Cite sources inline using provided search results
</format>`;

// omp's prompts/tools/web-search.md — the model-facing tool description.
export const WEB_SEARCH_TOOL_DESCRIPTION = `Searches the web for up-to-date information beyond knowledge cutoff.

<instruction>
- You SHOULD prefer primary sources (papers, official docs) and corroborate key claims with multiple sources
- You MUST include links for cited sources in the final response
</instruction>`;

// omp's native codex search uses a 60s hard timeout against chatgpt.com directly.
// codex-lb proxies to upstream accounts and is materially slower — a thorough
// `search_context_size: high` query has been measured at ~90s end-to-end — so 60s
// guarantees spurious timeouts. Give codex-lb a much longer budget.
export const SEARCH_HARD_TIMEOUT_MS = 180_000;

export function withHardTimeout(signal: AbortSignal | undefined, ms: number = SEARCH_HARD_TIMEOUT_MS): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// ── request body (copied verbatim from codex.ts:341-360) ─────────────────────

export function buildSearchBody(
	query: string,
	options: { modelId: string; searchContextSize?: "low" | "medium" | "high"; systemPrompt?: string },
): Record<string, unknown> {
	return {
		model: options.modelId,
		stream: true,
		store: false,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: query }],
			},
		],
		tools: [
			{
				type: "web_search",
				search_context_size: options.searchContextSize ?? "high",
			},
		],
		tool_choice: { type: "web_search" },
		instructions: options.systemPrompt ?? WEB_SEARCH_SYSTEM_PROMPT,
	};
}

export function buildSearchHeaders(apiKey: string): Record<string, string> {
	// codex-lb uses a plain Bearer key — no chatgpt-account-id (that header is
	// only for ChatGPT OAuth). Everything else mirrors omp's buildCodexHeaders.
	return {
		Authorization: `Bearer ${apiKey}`,
		"OpenAI-Beta": "responses=experimental",
		originator: "pi",
		Accept: "text/event-stream",
		"Content-Type": "application/json",
	};
}

// ── helpers copied from codex.ts ─────────────────────────────────────────────

function addSource(sources: SearchSource[], source: SearchSource): void {
	if (!sources.some((existing) => existing.url === source.url)) sources.push(source);
}

const IMAGE_PLACEHOLDER_ANSWERS = new Set([
	"see attached image",
	"see the attached image",
	"see image",
	"see the image below",
	"image attached",
]);

function isImagePlaceholderAnswer(answer: string): boolean {
	const normalized = answer.trim().toLowerCase().replace(/[.!]+$/, "");
	return IMAGE_PLACEHOLDER_ANSWERS.has(normalized);
}

function normalizeExtractedUrl(url: string): string | undefined {
	let trimmed = url.trim().replace(/[).,;]+$/, "");
	if (!/^https?:\/\//i.test(trimmed)) return undefined;
	try {
		return new URL(trimmed).toString();
	} catch {
		return undefined;
	}
}

function extractTextSources(text: string): SearchSource[] {
	const out: SearchSource[] = [];
	const seen = new Set<string>();
	const markdown = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
	let m: RegExpExecArray | null;
	while ((m = markdown.exec(text)) !== null) {
		const url = normalizeExtractedUrl(m[2]!);
		if (url && !seen.has(url)) {
			seen.add(url);
			out.push({ title: m[1]!.trim() || url, url });
		}
	}
	const bare = /(?<![(\[])\bhttps?:\/\/[^\s)\]]+/g;
	while ((m = bare.exec(text)) !== null) {
		const url = normalizeExtractedUrl(m[0]!);
		if (url && !seen.has(url)) {
			seen.add(url);
			out.push({ title: url, url });
		}
	}
	return out;
}

type CodexAnnotation = { type?: string; url?: string; title?: string };
type CodexContentPart = { type?: string; text?: string; annotations?: CodexAnnotation[] };
type CodexSummaryPart = { type?: string; text?: string };
type CodexResponseItem = { type?: string; content?: CodexContentPart[]; summary?: CodexSummaryPart[] };

// ── SSE reader (data: {json}\n\n, [DONE]-aware) — equivalent to readSseJson ───

async function* readSseJson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let sep: number;
			// SSE events are separated by a blank line.
			while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
				const rawEvent = buffer.slice(0, sep);
				buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
				const dataLines = rawEvent
					.split(/\r?\n/)
					.filter((l) => l.startsWith("data:"))
					.map((l) => l.slice(5).replace(/^ /, ""));
				if (dataLines.length === 0) continue;
				const data = dataLines.join("\n");
				if (data === "" ) continue;
				if (data === "[DONE]") return;
				try {
					yield JSON.parse(data) as Record<string, unknown>;
				} catch {
					/* ignore malformed frame */
				}
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {}
	}
}

// ── parse the codex web-search response stream (copied from codex.ts:382-484) ─

export async function parseSearchStream(
	body: ReadableStream<Uint8Array>,
	fallbackModel: string,
	signal?: AbortSignal,
): Promise<{ answer: string; sources: SearchSource[]; model: string; requestId: string; usage?: SearchResponse["usage"] }> {
	const answerParts: string[] = [];
	const streamedAnswerParts: string[] = [];
	const sources: SearchSource[] = [];
	let model = fallbackModel;
	let requestId = "";
	let usage: SearchResponse["usage"] | undefined;

	for await (const rawEvent of readSseJson(body, signal)) {
		const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
		if (!eventType) continue;

		if (eventType === "response.output_text.delta") {
			const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
			if (delta) streamedAnswerParts.push(delta);
		} else if (eventType === "response.output_item.done") {
			const item = rawEvent.item as CodexResponseItem | undefined;
			if (!item) continue;
			if (item.type === "message" && item.content) {
				for (const part of item.content) {
					if (part.type === "output_text" && part.text) {
						answerParts.push(part.text);
						if (part.annotations) {
							for (const annotation of part.annotations) {
								if (annotation.type === "url_citation" && annotation.url) {
									addSource(sources, { title: annotation.title ?? annotation.url, url: annotation.url });
								}
							}
						}
					}
				}
			}
			if (item.type === "reasoning" && item.summary) {
				for (const part of item.summary) {
					if (part.type === "summary_text" && part.text) answerParts.push(part.text);
				}
			}
		} else if (eventType === "response.completed" || eventType === "response.done") {
			const resp = (rawEvent as { response?: any }).response;
			if (resp) {
				if (resp.model) model = resp.model;
				if (resp.id) requestId = resp.id;
				if (resp.usage) {
					const cachedTokens = resp.usage.input_tokens_details?.cached_tokens ?? 0;
					usage = {
						inputTokens: (resp.usage.input_tokens ?? 0) - cachedTokens,
						outputTokens: resp.usage.output_tokens ?? 0,
						totalTokens: resp.usage.total_tokens ?? 0,
					};
				}
			}
		} else if (eventType === "error") {
			const code = (rawEvent as { code?: string }).code ?? "";
			const message = (rawEvent as { message?: string }).message ?? "Unknown error";
			throw new Error(`codex-lb search error (${code}): ${message}`);
		} else if (eventType === "response.failed") {
			const resp = (rawEvent as { response?: { error?: { message?: string } } }).response;
			throw new Error(`codex-lb search failed: ${resp?.error?.message ?? "Request failed"}`);
		}
	}

	const finalAnswer = answerParts.join("\n\n").trim();
	const streamedAnswer = streamedAnswerParts.join("").trim();
	const hasFinalText = finalAnswer.length > 0 && !isImagePlaceholderAnswer(finalAnswer);
	const hasStreamedText = streamedAnswer.length > 0 && !isImagePlaceholderAnswer(streamedAnswer);
	if (!hasFinalText && !hasStreamedText && sources.length === 0) {
		throw new Error("codex-lb search returned no content");
	}
	const answer = hasFinalText ? finalAnswer : hasStreamedText ? streamedAnswer : "";
	if (sources.length === 0 && answer.length > 0) {
		for (const source of extractTextSources(answer)) addSource(sources, source);
	}
	return { answer, sources, model, requestId, usage };
}

export interface CodexLbSearchConfig {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	searchContextSize?: "low" | "medium" | "high";
	fetchImpl?: (input: any, init?: any) => Promise<Response>;
	/** Hard timeout for the whole search request (ms). Defaults to SEARCH_HARD_TIMEOUT_MS. */
	timeoutMs?: number;
}

// Runs one codex-lb web search and returns a SearchResponse (same shape omp's
// SearchProvider.search returns). The request is byte-identical to native codex
// search; only URL/auth/fetch differ.
export async function codexLbSearch(
	params: { query: string; systemPrompt?: string; numSearchResults?: number; signal?: AbortSignal },
	config: CodexLbSearchConfig,
): Promise<SearchResponse> {
	const url = `${config.baseUrl.replace(/\/+$/, "")}/responses`;
	const body = buildSearchBody(params.query, {
		modelId: config.modelId,
		searchContextSize: config.searchContextSize ?? "high",
		systemPrompt: params.systemPrompt,
	});
	const fetchImpl = config.fetchImpl ?? fetch;
	const response = await fetchImpl(url, {
		method: "POST",
		headers: buildSearchHeaders(config.apiKey),
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal, config.timeoutMs),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`codex-lb search HTTP ${response.status}: ${text.slice(0, 300)}`);
	}
	if (!response.body) throw new Error("codex-lb search returned no response body");

	const result = await parseSearchStream(response.body, config.modelId, params.signal);
	let sources = result.sources;
	if (params.numSearchResults && sources.length > params.numSearchResults) {
		sources = sources.slice(0, params.numSearchResults);
	}
	return {
		provider: "codex",
		answer: result.answer || undefined,
		sources,
		usage: result.usage,
		model: result.model,
		requestId: result.requestId,
	};
}

// ── model-facing output (copied verbatim from web/search/index.ts:69-117) ─────

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 1)}…`;
}

function formatCount(noun: string, count: number): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatAge(ageSeconds: number | undefined): string {
	if (ageSeconds === undefined) return "";
	const days = Math.floor(ageSeconds / 86400);
	if (days > 0) return `${days}d ago`;
	const hours = Math.floor(ageSeconds / 3600);
	if (hours > 0) return `${hours}h ago`;
	const minutes = Math.floor(ageSeconds / 60);
	return minutes > 0 ? `${minutes}m ago` : "just now";
}

export function formatForLLM(response: SearchResponse): string {
	const parts: string[] = [];
	if (response.answer) {
		parts.push(response.answer);
		if (response.sources.length > 0) {
			parts.push("\n## Sources");
			parts.push(formatCount("source", response.sources.length));
		}
	}
	for (const [i, src] of response.sources.entries()) {
		const age = formatAge(src.ageSeconds) || src.publishedDate;
		const agePart = age ? ` (${age})` : "";
		parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
		if (src.snippet) parts.push(`    ${truncateText(src.snippet, 240)}`);
	}
	return parts.join("\n");
}

export function hasRenderableSearchContent(response: SearchResponse): boolean {
	return Boolean((response.answer && response.answer.length > 0) || response.sources.length > 0);
}

// ── provider routing for the global web_search override ───────────────────────

export interface CodexLbTurnDeps {
	/** True if `sessionId` belongs to a codex-lb turn (vs another provider's). */
	isCodexLbSession?: (sessionId: string) => boolean;
	/** True if a codex-lb turn ran very recently (fallback when no session/model in ctx). */
	recentlyCodexLb?: () => boolean;
}

/**
 * Decides whether THIS web_search turn is a codex-lb turn (→ codex-lb search) or
 * another provider's (→ delegate to native). The tool OVERRIDES omp's built-in
 * web_search globally, so getting this right is what stops it from hijacking, e.g.,
 * an openai-codex search onto codex-lb (which happens when omp falls back to the
 * built-in provider). Priority: ctx.model.provider (authoritative when present) →
 * the session's known provider → "did a codex-lb turn just run" recency. Defaults
 * to NOT codex-lb (the safe choice: native search), so a non-codex-lb turn is never
 * forced onto codex-lb.
 */
export function isCodexLbTurn(ctx: { model?: { provider?: unknown }; sessionId?: unknown } | undefined, providerID: string, deps: CodexLbTurnDeps): boolean {
	const provider = typeof ctx?.model?.provider === "string" ? ctx.model.provider : undefined;
	if (provider) return provider === providerID;
	const sid = typeof ctx?.sessionId === "string" && ctx.sessionId ? ctx.sessionId : undefined;
	if (sid && deps.isCodexLbSession) return deps.isCodexLbSession(sid) || (deps.recentlyCodexLb?.() ?? false);
	return deps.recentlyCodexLb?.() ?? false;
}

// ── transient-failure retry ───────────────────────────────────────────────────
//
// codex-lb's upstream returns transient 1011 "internal error" closes even for
// valid requests; the chat path survives these via omp's turn replay. A one-shot
// web search has no such loop, so it retries here. Generic + sleep-injectable so
// it stays unit-testable.

export interface RetryOptions {
	maxAttempts?: number;
	isRetryable?: (error: unknown) => boolean;
	onRetry?: (attempt: number, error: unknown) => void;
	delayMs?: (attempt: number) => number;
	sleep?: (ms: number) => Promise<void>;
	signal?: AbortSignal;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` up to `maxAttempts` times, retrying while `isRetryable(error)` holds
 * (default: always). Re-throws the last error when attempts are exhausted or the
 * error is non-retryable, and throws an AbortError if `signal` is aborted.
 */
export async function retryAsync<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
	const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
	const isRetryable = options.isRetryable ?? (() => true);
	const sleep = options.sleep ?? defaultSleep;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (options.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
		try {
			return await fn(attempt);
		} catch (error) {
			lastError = error;
			if (attempt === maxAttempts || !isRetryable(error)) throw error;
			options.onRetry?.(attempt, error);
			const ms = options.delayMs ? options.delayMs(attempt) : 0;
			if (ms > 0) await sleep(ms);
		}
	}
	throw lastError;
}
