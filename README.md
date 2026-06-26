# omp-codex-lb-responses

An [omp](https://github.com/badlogic/pi-mono) (oh-my-pi) plugin that adds a
**`codex-lb` provider** which routes the OpenAI **Responses API over codex-lb's
WebSocket transport**. One WebSocket per conversation keeps codex-lb pinned to a
single upstream account for the whole turn-sequence — the session/account
consistency the load balancer needs — so long turns stop dropping silently.

You switch to it by selecting `codex-lb/<model>` (`--model codex-lb/gpt-5.5`, or
the model picker). Your other providers are left untouched.

> **0.18 is a rewrite.** Earlier versions (≤ 0.17) reused omp's built-in
> **codex** transport, which forced a synthetic ChatGPT JWT, a global
> `fetch`/`WebSocket` monkeypatch, a `models.yml` provider declaration, and a
> source **patcher** that had to be re-applied after every `omp update`. This
> version drops all four: it registers against omp's plain **`openai-responses`**
> path (a bare `Authorization: Bearer` key), injects a **provider-scoped `fetch`**
> for the WebSocket bridge, and is configured entirely from the **environment**.
> See [Migrating from 0.17.x](#migrating-from-017x).

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
omp plugin install github:YanzuoLu/omp-codex-lb-responses#v0.19.2
```

Pin a **version tag** (`#v0.19.2`), not a commit SHA, so upgrades are a one-line
bump. There is **no patcher step** and nothing to re-apply after `omp update`.

## Configure

Configure with `omp plugin config` (stored per-plugin in
`~/.omp/plugins/omp-plugins.lock.json`) — no `models.yml`, no `config.yml`:

```bash
omp plugin config set omp-codex-lb-responses baseUrl https://your-codex-lb-host/v1
omp plugin config set omp-codex-lb-responses apiKey  sk-clb-…
omp plugin config list omp-codex-lb-responses           # review (apiKey is masked)
```

| Setting | Required | Default | Env fallback | Meaning |
|---------|----------|---------|--------------|---------|
| `baseUrl` | **yes** | — | `CODEX_LB_BASE_URL` | Your codex-lb `/v1` endpoint. The plugin opens `wss://…/responses` derived from it. |
| `apiKey` | **yes** | — | `CODEX_LB_API_KEY` | codex-lb key (`sk-clb-…`), sent as a plain `Authorization: Bearer` (stored masked). |
| `providerId` | no | `codex-lb` | `CODEX_LB_PROVIDER_ID` | Provider id shown in the picker (`<id>/<model>`). |
| `models` | no | built-in catalog | `CODEX_LB_MODELS` | Comma-separated model ids to register instead of the defaults. |
| `webSearch` | no | off | `CODEX_LB_WEB_SEARCH` | `card` = native-identical codex web search with the full Search card (see [Web search](#web-search)); `inject` = hosted tool per turn, no card. |
| `searchModel` | no | first model | `CODEX_LB_WEB_SEARCH_MODEL` | Model used for `webSearch: card` search requests (e.g. `gpt-5.5`). |

`baseUrl` and `apiKey` are required — there is **no built-in default endpoint**
baked into this package, so a codex-lb host is never committed here. Each setting
also reads from its env var as a fallback (plugin config wins), so you can keep
secrets in the environment instead:

```bash
export CODEX_LB_API_KEY="sk-clb-…"
export CODEX_LB_BASE_URL="https://your-codex-lb-host/v1"
```

## Usage

```bash
omp --model codex-lb/gpt-5.5            # interactive
omp -p --model codex-lb/gpt-5.5 "…"    # headless
```

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

`searchModel` picks the model for the search request (default: your first model).
For hosted-tool search without the card, use `webSearch: inject` instead.

## How it works

- **Provider registration** (`pi.registerProvider`): registers `codex-lb` with a
  custom api id (`codex-lb-responses`) and a `streamSimple` wrapper. The models are
  registered **programmatically** (inline), so no `models.yml` is needed — and
  omp's YAML schema, which rejects custom api ids, is sidestepped.
- **Plain-key Responses** (`streamSimple` → `streamOpenAIResponses`): each turn is
  delegated to omp's built-in `openai-responses` path with a bare
  `Authorization: Bearer <key>` (no ChatGPT JWT, no `chatgpt-account-id`). The
  custom model has no catalog entry, so the plugin builds the standard
  `openai-responses` `compat` itself (`buildOpenAIResponsesCompat`).
- **WebSocket transport** (`src/ws-bridge.ts` + `src/ws-pool.ts`, the provider's
  `fetch`): a streaming Responses POST to `/responses` is upgraded to a
  `wss://…/responses` WebSocket. It sends `{ "type": "response.create", … }` and
  translates the `response.*` frames back into the `data:`-framed SSE stream omp's
  `readSseJson` decoder expects (terminated by `data: [DONE]`). codex-lb vendor
  frames (`codex.rate_limits`, `codex.keepalive`) are filtered out.
- **Account stickiness** (session-keyed pool): one socket per conversation, keyed
  by omp's `sessionId` (the id omp hands to `streamSimple`, plus a `session-id`
  header on the socket). Subsequent turns in the same conversation reuse the same
  socket.
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
