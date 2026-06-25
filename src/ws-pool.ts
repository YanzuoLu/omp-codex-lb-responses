// Session-keyed WebSocket connection pool, presented as a provider-scoped fetch.
//
// One socket per conversation (keyed by omp's `sessionId`) keeps codex-lb pinned
// to a single upstream account for the whole turn-sequence — the session/account
// consistency the load balancer needs. The fetch is bound to a session via
// `bind(sessionId, httpFetch)` (omp hands the session id to `streamSimple`, not as
// a request header), and only streaming POSTs to `/responses` are upgraded; every
// other request, and any request without a session id, falls through to plain HTTP.

import {
	connectResponsesWebSocket,
	isAbortError,
	streamResponsesWebSocket,
	type WebSocketLike,
} from "./ws-bridge";

const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000;
const DEFAULT_MAX_CONNECTION_AGE = 55 * 60 * 1000;
const DEFAULT_STREAM_RETRIES = 5;
const OPEN = 1;

export type FetchLike = (input: any, init?: any) => Promise<Response>;

interface PoolEntry {
	socket?: WebSocketLike;
	connectedAt?: number;
	lastUsedAt: number;
	busy: boolean;
	fallback: boolean;
	streamFailures: number;
}

export interface WebSocketFetchOptions {
	WebSocketImpl?: any;
	connectTimeout?: number;
	idleTimeout?: number;
	maxConnectionAge?: number;
	streamRetries?: number;
	injectWebSearch?: boolean;
	now?: () => number;
}

export interface WebSocketFetch {
	/** Bind a provider-scoped fetch to a conversation. `httpFetch` is the fallback transport. */
	bind(sessionID: string | undefined, httpFetch: FetchLike): FetchLike;
	/** Drop the socket for a session (e.g. on session end). */
	remove(sessionID: string): void;
	/** Tear down the pool. */
	close(): void;
}

export function normalizeHeaders(headersInit: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!headersInit) return out;
	if (typeof Headers !== "undefined" && headersInit instanceof Headers) {
		for (const [k, v] of headersInit) out[k.toLowerCase()] = v;
		return out;
	}
	if (Array.isArray(headersInit)) {
		for (const [k, v] of headersInit) out[String(k).toLowerCase()] = String(v);
		return out;
	}
	for (const [k, v] of Object.entries(headersInit as Record<string, unknown>)) out[k.toLowerCase()] = String(v);
	return out;
}

function parseBody(init: any): Record<string, unknown> | undefined {
	if (typeof init?.body !== "string") return undefined;
	try {
		const parsed = JSON.parse(init.body);
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function createWebSocketFetch(options: WebSocketFetchOptions = {}): WebSocketFetch {
	const WebSocketImpl = options.WebSocketImpl ?? (globalThis.WebSocket as unknown);
	const connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
	const idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
	const maxConnectionAge = options.maxConnectionAge ?? DEFAULT_MAX_CONNECTION_AGE;
	const streamRetries = options.streamRetries ?? DEFAULT_STREAM_RETRIES;
	const injectWebSearch = options.injectWebSearch ?? false;
	const pool = new Map<string, PoolEntry>();

	const pruneTimer = setInterval(prune, Math.min(idleTimeout, 60_000));
	(pruneTimer as { unref?: () => void }).unref?.();

	function now(): number {
		return options.now ? options.now() : Date.now();
	}
	function invalidate(entry: PoolEntry) {
		if (entry.socket) {
			try {
				entry.socket.close();
			} catch {}
			entry.socket = undefined;
		}
		entry.connectedAt = undefined;
	}
	function recordStreamFailure(entry: PoolEntry) {
		entry.streamFailures++;
		if (entry.streamFailures > streamRetries) entry.fallback = true;
	}
	function prune() {
		const ts = now();
		for (const [key, entry] of pool) {
			if (entry.busy || entry.fallback) continue;
			if (ts - entry.lastUsedAt < idleTimeout) continue;
			invalidate(entry);
			pool.delete(key);
		}
	}
	async function getSocket(
		entry: PoolEntry,
		url: string,
		headers: Record<string, string>,
		signal: AbortSignal | undefined,
	): Promise<WebSocketLike> {
		if (entry.socket?.readyState === OPEN && entry.connectedAt && now() - entry.connectedAt < maxConnectionAge) {
			return entry.socket;
		}
		invalidate(entry);
		const socket = await connectResponsesWebSocket({ url, headers, timeout: connectTimeout, signal, WebSocketImpl: WebSocketImpl as any });
		entry.connectedAt = now();
		return socket;
	}

	async function websocketFetch(
		input: any,
		init: any,
		sessionID: string | undefined,
		httpFetch: FetchLike,
	): Promise<Response> {
		const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
		const headers = normalizeHeaders(init?.headers);

		if (init?.method !== "POST" || !new URL(url).pathname.endsWith("/responses")) return httpFetch(input, init);
		const body = parseBody(init);
		if (!body?.stream) return httpFetch(input, init);
		if (!sessionID) return httpFetch(input, init);

		const key = `${sessionID}:conversation`;
		const entry = pool.get(key) ?? { lastUsedAt: now(), busy: false, fallback: false, streamFailures: 0 };
		pool.set(key, entry);
		if (entry.fallback) return httpFetch(input, init);
		if (entry.busy) return httpFetch(input, init);

		// codex-lb also keys account affinity off a session-id header on the socket.
		const connectHeaders = { ...headers, "session-id": sessionID };

		entry.busy = true;
		entry.lastUsedAt = now();
		try {
			entry.socket = await getSocket(entry, url, connectHeaders, init?.signal ?? undefined);

			let resolveFirst: (v: unknown) => void = () => {};
			let rejectFirst: (e: unknown) => void = () => {};
			const firstEvent = new Promise<unknown>((resolve, reject) => {
				resolveFirst = resolve;
				rejectFirst = reject;
			});
			const response = streamResponsesWebSocket({
				socket: entry.socket,
				body,
				idleTimeout,
				signal: init?.signal ?? undefined,
				injectWebSearch,
				onFirstEvent: (errorish) => resolveFirst(errorish ?? true),
				onComplete: () => {},
				onTerminal: (event) => {
					entry.busy = false;
					entry.lastUsedAt = now();
					entry.streamFailures = 0;
					// Reuse only after a clean completion; otherwise drop the socket.
					if (event?.type !== "response.completed" && event?.type !== "response.done") invalidate(entry);
				},
				onConnectionInvalid: () => {
					entry.busy = false;
					entry.lastUsedAt = now();
					if (!entry.fallback) recordStreamFailure(entry);
					invalidate(entry);
					resolveFirst(false);
				},
				onAbort: (error) => {
					entry.busy = false;
					entry.lastUsedAt = now();
					entry.streamFailures = 0;
					invalidate(entry);
					rejectFirst(error);
				},
			});

			const first = await firstEvent;
			if (first !== false) return response;
			// Socket died before producing anything. Retry over HTTP only once we've
			// exhausted the WS retry budget; otherwise surface the retryable response
			// (which carries the synthetic error frame) so omp replays the turn.
			if (!entry.fallback) return response;
			return httpFetch(input, init);
		} catch (error) {
			entry.busy = false;
			entry.lastUsedAt = now();
			if (isAbortError(error)) {
				entry.streamFailures = 0;
				invalidate(entry);
				throw error;
			}
			recordStreamFailure(entry);
			invalidate(entry);
			if (entry.fallback) return httpFetch(input, init);
			return failedResponse(error instanceof Error ? error : new Error(String(error)));
		}
	}

	function bind(sessionID: string | undefined, httpFetch: FetchLike): FetchLike {
		return (input: any, init?: any) => websocketFetch(input, init, sessionID, httpFetch);
	}
	function remove(sessionID: string) {
		const key = `${sessionID}:conversation`;
		const entry = pool.get(key);
		if (!entry) return;
		invalidate(entry);
		pool.delete(key);
	}
	function close() {
		clearInterval(pruneTimer);
		for (const entry of pool.values()) invalidate(entry);
		pool.clear();
	}

	return { bind, remove, close };
}

// A 200 text/event-stream Response whose body immediately errors — surfaces a
// connect failure to omp without pretending the turn completed.
function failedResponse(error: Error): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(error);
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}
