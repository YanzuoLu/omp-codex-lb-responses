import { describe, expect, test } from "bun:test";
import { buildSearchBody, buildSearchHeaders, codexLbSearch, formatForLLM, parseSearchStream, retryAsync } from "./web-search-core";

const noSleep = (_ms: number) => Promise.resolve();

function sseResponse(frames: unknown[]): Response {
	const enc = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
			c.enqueue(enc.encode("data: [DONE]\n\n"));
			c.close();
		},
	});
	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const SEARCH_FRAMES = [
	{ type: "response.created", response: { id: "resp_1", model: "gpt-5.5" } },
	{ type: "response.output_text.delta", delta: "Cats " },
	{ type: "response.output_text.delta", delta: "purr." },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			content: [
				{
					type: "output_text",
					text: "Cats purr to communicate.",
					annotations: [
						{ type: "url_citation", url: "https://a.example/cats", title: "Cat facts" },
						{ type: "url_citation", url: "https://a.example/cats", title: "dup" }, // dedup by url
						{ type: "url_citation", url: "https://b.example/purr", title: "Purring" },
					],
				},
			],
		},
	},
	{ type: "response.completed", response: { id: "resp_1", model: "gpt-5.5", usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 10 } } } },
];

describe("buildSearchBody (byte-identical to native codex)", () => {
	test("sends web_search tool + tool_choice + input + instructions", () => {
		const body = buildSearchBody("why do cats purr", { modelId: "gpt-5.5" });
		expect(body.model).toBe("gpt-5.5");
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
		expect(body.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "why do cats purr" }] }]);
		expect(body.tools).toEqual([{ type: "web_search", search_context_size: "high" }]);
		expect(body.tool_choice).toEqual({ type: "web_search" });
		expect(typeof body.instructions).toBe("string");
		expect(body.instructions as string).toContain("Research assistant with web search");
	});

	test("honors search_context_size override", () => {
		const body = buildSearchBody("q", { modelId: "gpt-5.5", searchContextSize: "medium" });
		expect(body.tools).toEqual([{ type: "web_search", search_context_size: "medium" }]);
	});
});

describe("buildSearchHeaders (plain bearer, no chatgpt-account-id)", () => {
	test("uses Authorization Bearer and omits chatgpt-account-id", () => {
		const h = buildSearchHeaders("sk-clb-x");
		expect(h.Authorization).toBe("Bearer sk-clb-x");
		expect(h["chatgpt-account-id"]).toBeUndefined();
		expect(h["OpenAI-Beta"]).toBe("responses=experimental");
		expect(h.Accept).toBe("text/event-stream");
		expect(h["Content-Type"]).toBe("application/json");
	});
});

describe("parseSearchStream", () => {
	test("extracts answer + deduped url_citation sources + usage", async () => {
		const res = sseResponse(SEARCH_FRAMES);
		const out = await parseSearchStream(res.body!, "gpt-5.5");
		expect(out.answer).toBe("Cats purr to communicate.");
		expect(out.sources).toEqual([
			{ title: "Cat facts", url: "https://a.example/cats" },
			{ title: "Purring", url: "https://b.example/purr" },
		]);
		expect(out.model).toBe("gpt-5.5");
		expect(out.requestId).toBe("resp_1");
		expect(out.usage).toEqual({ inputTokens: 90, outputTokens: 20, totalTokens: 120 }); // 100 - 10 cached
	});

	test("falls back to streamed text + scraped sources when no message item", async () => {
		const res = sseResponse([
			{ type: "response.output_text.delta", delta: "See https://x.example/page for details." },
			{ type: "response.completed", response: { id: "r", model: "gpt-5.5" } },
		]);
		const out = await parseSearchStream(res.body!, "gpt-5.5");
		expect(out.answer).toContain("https://x.example/page");
		expect(out.sources.map((s) => s.url)).toContain("https://x.example/page");
	});

	test("throws on an error frame", async () => {
		const res = sseResponse([{ type: "error", code: "account_stream_cap", message: "degraded" }]);
		await expect(parseSearchStream(res.body!, "gpt-5.5")).rejects.toThrow(/account_stream_cap|degraded/);
	});
});

describe("codexLbSearch end-to-end (fake fetch)", () => {
	test("POSTs to <baseUrl>/responses with the native body and parses results", async () => {
		let captured: { url?: string; init?: any } = {};
		const fakeFetch = async (url: any, init: any) => {
			captured = { url, init };
			return sseResponse(SEARCH_FRAMES);
		};
		const resp = await codexLbSearch(
			{ query: "why do cats purr" },
			{ baseUrl: "https://lb.example/v1", apiKey: "sk-clb-x", modelId: "gpt-5.5", fetchImpl: fakeFetch },
		);
		expect(captured.url).toBe("https://lb.example/v1/responses");
		expect(captured.init.method).toBe("POST");
		expect(captured.init.headers.Authorization).toBe("Bearer sk-clb-x");
		const sentBody = JSON.parse(captured.init.body);
		expect(sentBody.tools).toEqual([{ type: "web_search", search_context_size: "high" }]);
		expect(resp.provider).toBe("codex");
		expect(resp.answer).toBe("Cats purr to communicate.");
		expect(resp.sources).toHaveLength(2);
	});

	test("respects numSearchResults truncation", async () => {
		const resp = await codexLbSearch(
			{ query: "q", numSearchResults: 1 },
			{ baseUrl: "https://lb.example/v1", apiKey: "k", modelId: "gpt-5.5", fetchImpl: async () => sseResponse(SEARCH_FRAMES) },
		);
		expect(resp.sources).toHaveLength(1);
	});
});

describe("retryAsync (absorbs codex-lb transient 1011s)", () => {
	test("returns the first success and stops calling", async () => {
		let calls = 0;
		const out = await retryAsync(async () => { calls++; return "ok"; }, { maxAttempts: 3, sleep: noSleep });
		expect(out).toBe("ok");
		expect(calls).toBe(1);
	});

	test("retries transient failures then succeeds, reporting each retry", async () => {
		let calls = 0;
		const retried: number[] = [];
		const out = await retryAsync(
			async () => { calls++; if (calls < 3) throw new Error("Upstream websocket closed before response.completed: received 1011"); return "answer"; },
			{ maxAttempts: 3, sleep: noSleep, onRetry: (attempt) => retried.push(attempt) },
		);
		expect(out).toBe("answer");
		expect(calls).toBe(3);
		expect(retried).toEqual([1, 2]); // retried after attempts 1 and 2
	});

	test("re-throws the last error after exhausting attempts", async () => {
		let calls = 0;
		await expect(
			retryAsync(async () => { calls++; throw new Error(`fail-${calls}`); }, { maxAttempts: 2, sleep: noSleep }),
		).rejects.toThrow("fail-2");
		expect(calls).toBe(2);
	});

	test("does NOT retry a non-retryable error (e.g. abort)", async () => {
		let calls = 0;
		await expect(
			retryAsync(async () => { calls++; throw new DOMException("aborted", "AbortError"); }, {
				maxAttempts: 4,
				sleep: noSleep,
				isRetryable: (e) => !(e instanceof DOMException && e.name === "AbortError"),
			}),
		).rejects.toThrow(/aborted/);
		expect(calls).toBe(1);
	});

	test("throws AbortError without calling fn when the signal is already aborted", async () => {
		let calls = 0;
		await expect(
			retryAsync(async () => { calls++; return "x"; }, { maxAttempts: 3, sleep: noSleep, signal: AbortSignal.abort() }),
		).rejects.toThrow(/abort/i);
		expect(calls).toBe(0);
	});
});

describe("formatForLLM (model-facing output, copied from omp)", () => {
	test("renders answer + numbered sources", () => {
		const text = formatForLLM({
			provider: "codex",
			answer: "Cats purr to communicate.",
			sources: [
				{ title: "Cat facts", url: "https://a.example/cats" },
				{ title: "Purring", url: "https://b.example/purr", snippet: "purring explained" },
			],
		});
		expect(text).toContain("Cats purr to communicate.");
		expect(text).toContain("## Sources");
		expect(text).toContain("2 sources");
		expect(text).toContain("[1] Cat facts\n    https://a.example/cats");
		expect(text).toContain("[2] Purring\n    https://b.example/purr");
		expect(text).toContain("    purring explained");
	});
});
