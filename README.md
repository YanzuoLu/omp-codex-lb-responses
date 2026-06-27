# omp-codex-lb-responses

An [omp](https://github.com/badlogic/pi-mono) (oh-my-pi) plugin that makes a
**`codex-lb` model usable in omp — including as the startup default** — by
streaming the OpenAI **Responses API over codex-lb's WebSocket transport**. One
WebSocket per conversation keeps codex-lb pinned to a single upstream account (the
session/account consistency the load balancer needs), so long turns stop dropping
silently.

You declare `codex-lb` in `~/.omp/agent/models.yml` pointing at a **local HTTP→WS
bridge** the plugin runs: omp talks ordinary `openai-responses` HTTP to
`127.0.0.1`, and the bridge upgrades each request to codex-lb's WebSocket. Because
models.yml is read **at startup** (before extension providers register),
`codex-lb/<model>` resolves as the default — something a plugin-registered provider
can't do. Toggle with `omp plugin config set omp-codex-lb-responses mode on|off`.

> **0.20 is a re-architecture.** ≤ 0.19 registered a standalone `codex-lb` provider
> whose `streamSimple` opened the WebSocket. That worked, but omp resolves
> `modelRoles.default` before extensions register, so codex-lb could never be the
> startup default. 0.20 declares codex-lb in `models.yml` (resolves early) and runs
> an in-process **local HTTP→WS bridge** instead of a standalone provider. The
> WebSocket transport, account stickiness, and the native web-search card are
> unchanged.

Requires **omp ≥ 16.0**.

## Why WebSocket

codex-lb needs a WebSocket for session/account consistency: each socket is pinned
to one upstream ChatGPT account, so a conversation that streams every turn down
the *same* socket always lands on the same account. Over stateless HTTP the load
balancer can route consecutive turns to different accounts, and a turn sometimes
ends with no reply. This plugin reuses omp's built-in `openai-responses` code path
(so reasoning / encrypted-content behave exactly like a native Responses model)
and upgrades each streaming request to a `wss://…/responses` WebSocket via a
provider-scoped `fetch`. Nothing global is patched.

## Install

```bash
omp plugin install github:YanzuoLu/omp-codex-lb-responses#v0.22.0
```

Pin a **version tag** (`#v0.22.0`), not a commit SHA, so upgrades are a one-line
bump. There is **no patcher step** and nothing to re-apply after `omp update`.

## Configure

Two pieces: the **plugin config** (the bridge's codex-lb endpoint + key, and the
on/off toggle) and a one-time **`models.yml`** entry (so omp knows about `codex-lb`
at startup).

**1. Plugin config** — the bridge's codex-lb endpoint + key:

```bash
omp plugin config set omp-codex-lb-responses baseUrl https://your-codex-lb-host/v1
omp plugin config set omp-codex-lb-responses apiKey  sk-clb-…
omp plugin config set omp-codex-lb-responses mode    on   # or `off`
```

| Setting | Required | Default | Env fallback | Meaning |
|---------|----------|---------|--------------|---------|
| `mode` | no | `on` | `CODEX_LB_MODE` | `on` = run the bridge; `off` = do nothing (use native models). Restart omp after changing. |
| `baseUrl` | **yes** | — | `CODEX_LB_BASE_URL` | Your codex-lb `/v1` endpoint. The bridge opens `wss://…/responses` derived from it. |
| `apiKey` | **yes** | — | `CODEX_LB_API_KEY` | codex-lb key (`sk-clb-…`), sent by the bridge as a plain `Authorization: Bearer`. |
| `bridgePort` | no | `8787` | `CODEX_LB_BRIDGE_PORT` | Local port the shared bridge listens on. Must match the `baseUrl` port in your models.yml. All omp instances share one bridge here (first to bind owns it; others stand by and auto-take-over if it exits). |
| `models` | no | built-in catalog | `CODEX_LB_MODELS` | Comma-separated model ids served by the bridge's `/models`. |
| `webSearch` | no | off | `CODEX_LB_WEB_SEARCH` | `card` = native-identical codex web search with the full Search card (see [Web search](#web-search)); `inject` = hosted tool per turn, no card. |
| `searchModel` | no | first model | `CODEX_LB_WEB_SEARCH_MODEL` | Model used for `webSearch: card` search requests (e.g. `gpt-5.5`). |
| `webSearchForce` | no | off | `CODEX_LB_WEB_SEARCH_FORCE` | When set (`true`/`on`/`all`), `webSearch: card` routes **every** `web_search` to codex-lb — even on non-codex-lb turns (anthropic/openai-codex/…), with no native fallback. Requires `mode: on`. |

Each setting also reads from its env var (plugin config wins), so you can keep the
secret out of the config file entirely:

```bash
export CODEX_LB_API_KEY="sk-clb-…"
export CODEX_LB_BASE_URL="https://your-codex-lb-host/v1"
```

**2. `~/.omp/agent/models.yml`** — declare `codex-lb` pointing at the bridge (so it
resolves at startup). Use `apiKey: CODEX_LB_API_KEY` (an env-var *name*, not the
secret) and a `baseUrl` whose port matches `bridgePort`. A ready-to-copy file is in
[`examples/models.yml`](examples/models.yml):

```yaml
providers:
  codex-lb:
    api: openai-responses
    baseUrl: http://127.0.0.1:8787/v1
    apiKey: CODEX_LB_API_KEY
    models:
      - { id: gpt-5.5, name: GPT-5.5, api: openai-responses, reasoning: true, input: [text, image], contextWindow: 272000, maxTokens: 128000, cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } }
      # gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark likewise
```

**3. Make it the default (optional)** — set your default role in
`~/.omp/agent/config.yml` so plain `omp` starts on codex-lb:

```yaml
modelRoles:
  default: codex-lb/gpt-5.5:xhigh
```

## Usage

Plain `omp` starts on codex-lb when `modelRoles.default` is set (above). Otherwise
select it explicitly:

```bash
omp --model codex-lb/gpt-5.5            # interactive
omp -p --model codex-lb/gpt-5.5 "…"    # headless
```

To go back to native models, `omp plugin config set omp-codex-lb-responses mode off`
and restart (then pick a native model with `/model`). You can also just `/model
openai-codex/gpt-5.5` at any time while the bridge is on — only `codex-lb/*` turns
go through the bridge, native models are untouched.

Or pick `codex-lb/<model>` in the model picker. The default catalog is `gpt-5.5`,
`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark` (reasoning models).

## Web search

```bash
omp plugin config set omp-codex-lb-responses webSearch card
```

`webSearch: card` registers a `web_search` tool that **reproduces omp's native
codex web search**, pointed at your codex-lb account — **no source patch, no
global monkeypatch**:

- The search request is **byte-identical** to omp's built-in codex search
  (`stream`, `store:false`, the `web_search` tool with `search_context_size`,
  `tool_choice`, and omp's own search system prompt); only the URL (→ codex-lb)
  and auth (→ your `sk-clb-…` Bearer, no `chatgpt-account-id`) differ.
- It runs over codex-lb's **WebSocket** transport (the same session-keyed pool the
  provider uses), not plain HTTP — codex-lb's HTTP `/responses` is non-functional.
  Transient upstream `1011` closes are **retried** (a fresh socket per attempt), so
  a single flaky turn no longer surfaces as a hard failure.
- Results render through **omp's own exported Search card** (answer + clickable
  sources), so the UI is the native one.
- It **overrides omp's built-in `web_search`**: on codex-lb turns the search goes
  to codex-lb; on other models it transparently delegates to omp's native search.
  So when you're on a `codex-lb/<model>`, the official-ChatGPT codex search (which
  you have no OAuth for) is effectively replaced by codex-lb's.

**Force all search to codex-lb** (`webSearchForce`): by default routing is per-turn
— only `codex-lb/*` turns search via codex-lb, everything else delegates to native.
Set `omp plugin config set omp-codex-lb-responses webSearchForce true` to route
**every** `web_search` to codex-lb regardless of the turn's model (e.g. you chat on
`anthropic/opus` but want all web search billed to and served by your codex-lb
account, with no ChatGPT OAuth needed). Trade-off: there is **no native fallback** —
if codex-lb is down or `mode: off`, web search fails for all models. Restart omp
after changing.

`searchModel` picks the model for the search request (default: your first model).
For hosted-tool search without the card, use `webSearch: inject` instead.

## How it works

- **models.yml + local bridge** (`src/local-bridge.ts`): codex-lb is declared in
  `~/.omp/agent/models.yml` as a plain `openai-responses` provider whose `baseUrl`
  is `http://127.0.0.1:<bridgePort>/v1`. Because models.yml is read at startup
  (before extensions), `codex-lb/<model>` resolves as the default — which a
  plugin-registered provider can't. In `activate()` the plugin runs a `Bun.serve`
  bridge on that port; it never calls `pi.registerProvider`.
- **Plain-key Responses → WebSocket** (`src/ws-pool.ts` + `src/ws-bridge.ts`): omp
  sends an ordinary `openai-responses` HTTP `POST …/responses` (bare
  `Authorization: Bearer`, no ChatGPT JWT/account-id) to the bridge. The bridge
  swaps in the codex-lb Bearer key and forwards through the session-keyed pool,
  which upgrades the request to a `wss://…/responses` WebSocket: it sends
  `{ "type": "response.create", … }` and translates the `response.*` frames back
  into the `data:`-framed SSE omp's `readSseJson` decoder expects (terminated by
  `data: [DONE]`). codex-lb vendor frames (`codex.rate_limits`, `codex.keepalive`)
  are filtered out.
- **Account stickiness** (session-keyed pool): one socket per conversation, keyed
  off omp's `prompt_cache_key` (carried in the request body), plus a `session-id`
  header on the socket. Subsequent turns in the same conversation reuse the same
  socket.
- **One shared bridge, with automatic failover**: omp always sends `codex-lb` to the
  single port models.yml declares, so every running omp instance shares one bridge —
  the first to bind the port owns it, the rest stand by. Conversations stay isolated
  regardless (the pool keys each to its own socket/account). If the owner exits, a
  standby's unref'd retry timer re-binds the port within a few seconds and takes
  over, so other instances never lose codex-lb. (omp resolves a session's model URL
  at startup from models.yml and a runtime `registerProvider` override can't change
  it, so a per-instance dynamic port is not possible — hence the shared bridge.)
- **Fail-closed & resilient**: codex-lb degraded states (e.g. `429
  account_stream_cap`, "No available accounts") surface as a real error instead of
  a silent empty turn. A socket that dies before a terminal event yields a
  synthetic retryable error frame, so omp replays the turn (bounded), then falls
  back to plain HTTP after the WebSocket retry budget is exhausted.
- **Web search** (`webSearch: card`, `src/web-search.ts` + `src/web-search-core.ts`):
  a plugin-registered `web_search` tool that replicates omp's native codex search
  request to codex-lb and renders results through omp's own exported card renderer.
  It runs over the **same session-keyed WebSocket pool** as the provider (codex-lb's
  HTTP `/responses` is non-functional) and **retries** transient upstream `1011`
  closes. No source patch, no global monkeypatch. See [Web search](#web-search).
- **No globals patched, no source patched.** The fetch override is per-provider and
  the auth is a plain key. The one omp behavior still hardcoded to the built-in
  `openai-codex` provider — remote compaction — is intentionally **not** used.

## Migrating from 0.17.x

- **Uninstall the old patcher.** If you ran `bunx …omp-codex-lb-responses` to patch
  omp, revert it: `bunx github:YanzuoLu/omp-codex-lb-responses#<old-tag> --revert`
  (or just reinstall omp). 0.18 needs no patches.
- **Remove the `codex-lb` provider from `~/.omp/agent/models.yml`** — it is no
  longer read. Configure with `omp plugin config` (or the env vars) instead.
- Reinstall the plugin at the new tag and set `baseUrl` + `apiKey` via
  `omp plugin config set omp-codex-lb-responses …` (see [Configure](#configure)).
- **Web search is back, patch-free.** 0.17 needed the source patcher for the native
  search card; 0.19's `webSearch: card` reproduces it as a plugin tool (see
  [Web search](#web-search)) — set `omp plugin config set omp-codex-lb-responses
  webSearch card`.
- **Lost vs 0.17:** only omp's remote compaction (long conversations fall back to
  local summarization). Everything else — WebSocket transport, account stickiness,
  encrypted reasoning, transient-failure resilience, and now the native search card
  — is kept, without the patcher/monkeypatch/JWT machinery.

## Development

```bash
bun install
bun test          # unit tests: ws-bridge, ws-pool, index

# end-to-end against a local mock codex-lb (zero deps, Bun):
bun test/mock-codex-lb.mjs 8531 ok "HELLO"   # modes: ok | error429 | closeEarly | hang
CODEX_LB_API_KEY=sk-test CODEX_LB_BASE_URL=http://127.0.0.1:8531/v1 \
  omp -p --model codex-lb/gpt-5.5 -e src/index.ts "say hi"
```

## Releases

Releases are tagged `vX.Y.Z` matching `package.json`. Install by referencing the tag.
```
