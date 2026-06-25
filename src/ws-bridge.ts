// codex-lb WebSocket bridge for omp.
//
// Speaks the OpenAI Responses-over-WebSocket protocol and exposes it to omp's
// built-in `openai-responses` transport as a normal streaming `fetch` Response:
// a 200 `text/event-stream` whose body is `data: <json>` SSE frames terminated
// by `data: [DONE]`. omp's `readSseJson` decoder (pi-utils/stream.ts) parses
// exactly that shape (it `JSON.parse`s each `data:` payload, ignores `event:`
// lines, and stops on `[DONE]`).
//
// Runs on Bun with zero runtime deps (Bun's `globalThis.WebSocket` accepts a
// `{ headers }` option and emits WHATWG events). The WebSocket constructor is
// injectable so node-based unit tests can drive a mock.

const PROTOCOL_HEADER = "responses_websockets=2026-02-06";
const OPEN = 1;
const encoder = new TextEncoder();

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

const KEEPALIVE_EVENT = "codex.keepalive";
const VENDOR_PREFIX = "codex."; // codex-lb's vendor frames; not part of the Responses wire
const CLEAN_TERMINAL = new Set(["response.completed", "response.done"]);
const ERROR_TERMINAL = new Set(["response.failed", "response.incomplete", "error"]);
const WEB_SEARCH_TOOL_TYPES = new Set(["web_search", "web_search_preview"]);

type Json = Record<string, unknown>;

export function toWsUrl(url: string): string {
	return url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

export function frameToString(data: unknown): string {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as ArrayBufferView);
	if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return data.toString("utf8");
	return String(data);
}

function abortError(signal?: AbortSignal): Error {
	const reason = (signal as { reason?: unknown } | undefined)?.reason;
	if (reason instanceof Error) return reason;
	return new DOMException("The operation was aborted.", "AbortError");
}

export function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

type WebSocketImpl = new (url: string, options?: { headers?: Record<string, string> }) => WebSocketLike;

export interface WebSocketLike {
	readyState: number;
	binaryType?: string;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void;
	removeEventListener?(type: string, listener: (event: any) => void): void;
}

export interface ConnectArgs {
	url: string;
	headers?: Record<string, string>;
	timeout?: number;
	signal?: AbortSignal;
	WebSocketImpl?: WebSocketImpl;
}

// Opens a Responses WebSocket and resolves once it is OPEN. Rejects on connect
// timeout, socket error, abort, or a close-before-open.
export function connectResponsesWebSocket({
	url,
	headers = {},
	timeout = DEFAULT_CONNECT_TIMEOUT_MS,
	signal,
	WebSocketImpl = globalThis.WebSocket as unknown as WebSocketImpl,
}: ConnectArgs): Promise<WebSocketLike> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const finalHeaders: Record<string, string> = { ...headers };
		// codex-lb upgrades a Responses request to a websocket via this beta header.
		const beta = finalHeaders["openai-beta"];
		if (beta && /responses=/.test(beta)) {
			finalHeaders["openai-beta"] = beta.replace(/responses=[^\s,;]+/, PROTOCOL_HEADER);
		} else if (!beta) {
			finalHeaders["openai-beta"] = PROTOCOL_HEADER;
		}
		delete finalHeaders["content-length"];
		delete finalHeaders["content-type"];
		delete finalHeaders["accept"];

		const socket = new WebSocketImpl(toWsUrl(url), { headers: finalHeaders });
		try {
			(socket as { binaryType?: string }).binaryType = "nodebuffer";
		} catch {}

		const timer = timeout
			? setTimeout(() => {
					cleanup();
					try {
						socket.close();
					} catch {}
					reject(new Error("WebSocket connect timed out"));
				}, timeout)
			: undefined;

		function cleanup() {
			if (timer) clearTimeout(timer);
			socket.removeEventListener?.("open", onOpen);
			socket.removeEventListener?.("error", onError);
			socket.removeEventListener?.("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		}
		function onOpen() {
			cleanup();
			resolve(socket);
		}
		function onError(event: any) {
			cleanup();
			const message = event?.message ?? event?.error?.message ?? "WebSocket error";
			reject(event?.error instanceof Error ? event.error : new Error(message));
		}
		function onClose(event: any) {
			cleanup();
			reject(new Error(`WebSocket closed before open (code ${event?.code ?? "?"})`));
		}
		function onAbort() {
			cleanup();
			try {
				socket.close();
			} catch {}
			reject(abortError(signal));
		}
		socket.addEventListener("open", onOpen, { once: true });
		socket.addEventListener("error", onError, { once: true });
		socket.addEventListener("close", onClose, { once: true });
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Injects the hosted `web_search` tool into a `response.create` body — the same
 * thing the Codex CLI sends, which codex-lb forwards to the upstream account.
 * Returns the body unchanged when web search is already present; drops omp's
 * client-side `web_search` FUNCTION tool so the hosted tool runs server-side.
 */
export function injectWebSearchTool(body: Json): Json {
	const tools = Array.isArray(body.tools) ? (body.tools as Json[]) : [];
	if (tools.some((t) => t && typeof t === "object" && WEB_SEARCH_TOOL_TYPES.has(t.type as string))) {
		return body;
	}
	const filtered = tools.filter(
		(t) => !(t && typeof t === "object" && t.type === "function" && WEB_SEARCH_TOOL_TYPES.has(t.name as string)),
	);
	return { ...body, tools: [...filtered, { type: "web_search" }] };
}

export interface StreamArgs {
	socket: WebSocketLike;
	body: Json;
	idleTimeout?: number;
	firstEventTimeout?: number;
	signal?: AbortSignal;
	injectWebSearch?: boolean;
	/** Fired once, after the first frame arrives (or with an error-ish value). */
	onFirstEvent?: (errorish?: unknown) => void;
	/** Fired with the terminal frame on a clean completion (`response.completed`). */
	onComplete?: (event: Json) => void;
	/** Fired with the parsed terminal frame (clean or error) before the stream closes. */
	onTerminal?: (event: Json | undefined) => void;
	/** Fired when the socket died before a terminal frame (premature close / error / idle). */
	onConnectionInvalid?: (error: Error) => void;
	/** Fired when the caller's signal aborts mid-stream. */
	onAbort?: (error: Error) => void;
}

// Streams one Responses turn over an already-open WebSocket. Returns a 200
// text/event-stream Response carrying `data: <json>` frames + `data: [DONE]`.
//
// On a premature death (socket closes/errors before a terminal frame, or it
// goes idle) it injects a SYNTHETIC retryable error frame
// `{ "type":"error","code":"server_error", ... }` instead of closing cleanly:
// a clean EOF would make omp's reader throw the UNRECOVERABLE "stream ended
// before terminal completion", whereas a retryable error frame lets omp replay
// the turn (bounded, content-gated).
export function streamResponsesWebSocket({
	socket,
	body,
	idleTimeout = DEFAULT_IDLE_TIMEOUT_MS,
	firstEventTimeout = DEFAULT_FIRST_EVENT_TIMEOUT_MS,
	signal,
	injectWebSearch = false,
	onFirstEvent,
	onComplete,
	onTerminal,
	onConnectionInvalid,
	onAbort,
}: StreamArgs): Response {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let completed = false;
	let sawFirst = false;
	let sawTerminal = false;
	let lastProgressAt = 0;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	function clearIdle() {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
	}
	function armIdle() {
		clearIdle();
		const ms = sawFirst ? Math.max(0, idleTimeout - (Date.now() - lastProgressAt)) : firstEventTimeout;
		idleTimer = setTimeout(() => {
			failRetryable(sawFirst ? "codex-lb websocket idle timeout" : "codex-lb websocket first-event timeout");
		}, ms);
	}
	function detach() {
		clearIdle();
		socket.removeEventListener?.("message", onMessage);
		socket.removeEventListener?.("error", onError);
		socket.removeEventListener?.("close", onClose);
	}
	function enqueue(text: string) {
		try {
			controller?.enqueue(encoder.encode(`data: ${text}\n\n`));
		} catch {}
	}
	function emitDone() {
		try {
			controller?.enqueue(encoder.encode("data: [DONE]\n\n"));
		} catch {}
	}
	function finish() {
		try {
			controller?.close();
		} catch {}
	}
	// Inject a retryable error FRAME (not a stream error) so omp recovers.
	function failRetryable(message: string) {
		if (completed) return;
		completed = true;
		detach();
		enqueue(JSON.stringify({ type: "error", code: "server_error", message }));
		finish();
		onConnectionInvalid?.(new Error(message));
	}

	function onMessage(event: any) {
		if (completed) return;
		const text = frameToString(event?.data);
		let parsed: Json | undefined;
		try {
			const value = JSON.parse(text);
			parsed = value && typeof value === "object" ? (value as Json) : undefined;
		} catch {
			parsed = undefined;
		}
		const type = typeof parsed?.type === "string" ? (parsed.type as string) : "";
		const isKeepalive = type === KEEPALIVE_EVENT;

		// Liveness: any frame ends the first-event phase; only non-keepalive frames
		// reset the idle window (so a keepalive-only stream still times out).
		if (!sawFirst) {
			sawFirst = true;
			if (!isKeepalive) lastProgressAt = Date.now();
			armIdle();
			onFirstEvent?.();
		} else if (!isKeepalive) {
			lastProgressAt = Date.now();
			armIdle();
		}

		// Don't forward codex-lb vendor frames (codex.rate_limits / codex.keepalive):
		// omp's openai-responses wire doesn't model them.
		if (!type || type.startsWith(VENDOR_PREFIX)) return;

		enqueue(text);

		if (CLEAN_TERMINAL.has(type)) {
			completed = true;
			sawTerminal = true;
			detach();
			emitDone();
			finish();
			onComplete?.(parsed!);
			onTerminal?.(parsed);
			return;
		}
		if (ERROR_TERMINAL.has(type)) {
			completed = true;
			sawTerminal = true;
			detach();
			finish(); // already forwarded the error frame; omp's handler classifies it
			onTerminal?.(parsed);
		}
	}

	function onError(event: any) {
		failRetryable(`codex-lb websocket error: ${event?.message ?? event?.error?.message ?? "unknown"}`);
	}
	function onClose(event: any) {
		if (completed) return;
		if (sawTerminal) return;
		failRetryable(`codex-lb websocket closed before terminal completion event (code ${event?.code ?? "?"})`);
	}
	function handleAbort() {
		if (completed) return;
		completed = true;
		detach();
		try {
			socket.close();
		} catch {}
		const error = abortError(signal);
		onAbort?.(error);
		try {
			controller?.error(error);
		} catch {}
	}

	function attach() {
		socket.addEventListener("message", onMessage);
		socket.addEventListener("error", onError, { once: true });
		socket.addEventListener("close", onClose, { once: true });
		const { stream: _stream, background: _background, ...rest } = body ?? {};
		const payload = injectWebSearch ? injectWebSearchTool(rest as Json) : (rest as Json);
		lastProgressAt = Date.now();
		armIdle();
		socket.send(JSON.stringify({ type: "response.create", ...payload }));
	}

	return new Response(
		new ReadableStream<Uint8Array>({
			start(next) {
				controller = next;
				if (signal?.aborted) {
					handleAbort();
					return;
				}
				signal?.addEventListener("abort", handleAbort, { once: true });
				if (socket.readyState !== OPEN) {
					failRetryable("codex-lb websocket is not open");
					return;
				}
				attach();
			},
			cancel() {
				if (completed) return;
				completed = true;
				detach();
				try {
					socket.close();
				} catch {}
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
	);
}
