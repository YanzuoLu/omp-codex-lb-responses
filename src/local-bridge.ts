// Local HTTP→WebSocket bridge for codex-lb.
//
// omp resolves `modelRoles.default` BEFORE extension providers register, so a
// plugin-registered `codex-lb` provider can never be the startup default. The fix
// is to declare codex-lb in `~/.omp/agent/models.yml` (read early at startup) as a
// plain `openai-responses` provider whose `baseUrl` points at THIS in-process
// bridge. omp then talks ordinary openai-responses HTTP to `127.0.0.1`, and the
// bridge upgrades each `/responses` request to codex-lb's WebSocket — reusing the
// exact same session-keyed pool the provider used to use. codex-lb's own HTTP
// `/responses` is non-functional (1011/502); only the WS transport works, which is
// why the indirection exists.
//
// Runs on Bun (`Bun.serve`). The serve fn + the request handler are separable so
// the handler is unit-testable against a fake pool without binding a port.

import { randomUUID } from "node:crypto";
import type { FetchLike, WebSocketFetch } from "./ws-pool";

export interface LocalBridgeOptions {
	/** The session-keyed WS pool (createWebSocketFetch()). */
	pool: WebSocketFetch;
	/** codex-lb `/v1` endpoint the bridge upgrades to. */
	baseUrl: string;
	/** codex-lb API key, sent as a plain `Authorization: Bearer`. */
	apiKey: string;
	/** Local port to listen on (127.0.0.1). */
	port: number;
	/** Model catalog, served at `GET …/models`. */
	models?: Array<{ id: string }>;
	logger?: { warn?: (m: string, meta?: unknown) => void; info?: (m: string, meta?: unknown) => void };
	/** Called with the pool session id for each conversation request (lets the web_search tool reuse the socket). */
	onSession?: (sid: string) => void;
	/** Injectable Bun.serve (defaults to globalThis.Bun.serve) — for tests. */
	serve?: (opts: { port: number; hostname?: string; idleTimeout?: number; fetch: (req: Request) => Promise<Response> | Response }) => {
		stop?: (closeActiveConnections?: boolean) => void;
		unref?: () => void;
		port?: number;
	};
	/** Injectable timers (default globalThis.setInterval/clearInterval) — for tests + unref control. */
	setIntervalImpl?: (cb: () => void, ms: number) => unknown;
	clearIntervalImpl?: (handle: unknown) => void;
}

export interface LocalBridgeHandle {
	port: number;
	close(): void;
}

const BRIDGE_HEADERS = (apiKey: string): Record<string, string> => ({
	Authorization: `Bearer ${apiKey}`,
	"OpenAI-Beta": "responses=experimental",
	"Content-Type": "application/json",
	Accept: "text/event-stream",
});

/**
 * Builds the bridge's request handler. Exposed for unit tests; `startLocalBridge`
 * wires it into `Bun.serve`.
 *   - `POST …/responses` → forward to codex-lb WS via the pool (auth swapped to the
 *     codex-lb Bearer key, session keyed off `prompt_cache_key`), returning the SSE.
 *   - `GET  …/models`     → the model catalog.
 */
export function createBridgeHandler(opts: LocalBridgeOptions): (req: Request) => Promise<Response> {
	const { pool, baseUrl, apiKey, models, logger } = opts;
	const url = `${baseUrl.replace(/\/+$/, "")}/responses`;
	const catalog = { object: "list", data: (models ?? []).map((m) => ({ id: m.id, object: "model", owned_by: "codex-lb" })) };

	return async function handle(req: Request): Promise<Response> {
		const path = new URL(req.url).pathname;
		if (req.method === "GET" && path.endsWith("/models")) {
			return Response.json(catalog);
		}
		if (req.method === "POST" && path.endsWith("/responses")) {
			const bodyText = await req.text();
			let body: Record<string, unknown> = {};
			try {
				const parsed = JSON.parse(bodyText);
				if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
			} catch {}
			// Pool key = omp's per-session prompt_cache_key (keeps account stickiness),
			// then a session-id header, then a fresh id.
			const sid =
				(typeof body.prompt_cache_key === "string" && body.prompt_cache_key) ||
				req.headers.get("session-id") ||
				`bridge-${randomUUID()}`;
			opts.onSession?.(sid);
			const wsFetch = pool.bind(sid, globalThis.fetch as FetchLike);
			try {
				return await wsFetch(url, { method: "POST", headers: BRIDGE_HEADERS(apiKey), body: bodyText, signal: req.signal });
			} catch (error) {
				logger?.warn?.(`omp-codex-lb-responses: bridge request failed: ${String(error)}`);
				return new Response(JSON.stringify({ error: { message: String(error) } }), {
					status: 502,
					headers: { "content-type": "application/json" },
				});
			}
		}
		return new Response("not found", { status: 404 });
	};
}

/** How often a standby instance retries binding the shared port to take over if the owner exits. */
export const REBIND_INTERVAL_MS = 3000;

/**
 * Starts the local bridge. All omp instances must talk to codex-lb at the single
 * port models.yml declares, so they share one bridge: the first to bind owns it,
 * the rest stand by. Returns undefined only if Bun.serve is unavailable or the bind
 * fails fatally (not EADDRINUSE).
 *
 * Automatic failover: a standby instance runs an unref'd timer that retries the
 * bind every `REBIND_INTERVAL_MS`. When the owner exits and frees the port, the
 * next standby's tick takes over — so survivors never lose codex-lb just because
 * the instance that happened to own the bridge quit first. Per-conversation account
 * stickiness is unaffected: the pool keys each conversation to its own WebSocket.
 */
export function startLocalBridge(opts: LocalBridgeOptions): LocalBridgeHandle | undefined {
	const serve = opts.serve ?? (globalThis as unknown as { Bun?: { serve?: LocalBridgeOptions["serve"] } }).Bun?.serve;
	if (typeof serve !== "function") {
		opts.logger?.warn?.("omp-codex-lb-responses: Bun.serve unavailable; local bridge not started");
		return undefined;
	}
	const handler = createBridgeHandler(opts);
	const port = opts.port;
	let server: ReturnType<NonNullable<LocalBridgeOptions["serve"]>> | undefined;
	let rebindTimer: unknown;

	// "bound" = we own the port now; "inuse" = another omp owns it (retry later);
	// "error" = fatal, nothing to take over.
	const attemptBind = (): "bound" | "inuse" | "error" => {
		try {
			const s = serve({ port, hostname: "127.0.0.1", idleTimeout: 240, fetch: handler });
			try {
				s.unref?.();
			} catch {}
			server = s;
			return "bound";
		} catch (error) {
			const msg = String((error as { message?: string })?.message ?? error);
			if ((error as { code?: string })?.code === "EADDRINUSE" || /in use|address already/i.test(msg)) return "inuse";
			opts.logger?.warn?.(`omp-codex-lb-responses: failed to start local bridge: ${msg}`);
			return "error";
		}
	};

	const clearTimer = (): void => {
		if (rebindTimer === undefined) return;
		const clearImpl =
			opts.clearIntervalImpl ?? (globalThis as unknown as { clearInterval?: (h: unknown) => void }).clearInterval;
		try {
			clearImpl?.(rebindTimer);
		} catch {}
		rebindTimer = undefined;
	};

	const first = attemptBind();
	if (first === "error") return undefined;
	if (first === "bound") {
		opts.logger?.info?.(`omp-codex-lb-responses: local HTTP→WS bridge on http://127.0.0.1:${port} → ${opts.baseUrl}`);
	} else {
		// Another omp owns the port. Stand by and watch for it to free up.
		opts.logger?.info?.(
			`omp-codex-lb-responses: port ${port} owned by another omp; standing by to take over the bridge if it exits`,
		);
		const setIntervalImpl =
			opts.setIntervalImpl ??
			(globalThis as unknown as { setInterval?: (cb: () => void, ms: number) => unknown }).setInterval;
		rebindTimer = setIntervalImpl?.(() => {
			if (server) return;
			if (attemptBind() === "bound") {
				opts.logger?.info?.(`omp-codex-lb-responses: took over the bridge on http://127.0.0.1:${port} → ${opts.baseUrl}`);
				clearTimer();
			}
		}, REBIND_INTERVAL_MS);
		try {
			(rebindTimer as { unref?: () => void } | undefined)?.unref?.();
		} catch {}
	}

	return {
		port,
		close() {
			clearTimer();
			try {
				server?.stop?.(true);
			} catch {}
		},
	};
}
