# omp-codex-lb-responses

Make [omp](https://github.com/can1357/oh-my-pi) work with Codex-compatible load balancers like [codex-lb](https://github.com/Soju06/codex-lb).

This repo ships **two components** that work together:

| Component | What | Why |
|-----------|------|-----|
| **Plugin** (`src/index.ts`) | Auth shim + SSE→WebSocket upgrade | codex-lb uses plain API keys (not JWTs) and needs all requests on WebSocket for session consistency |
| **Patcher** (`bin/patch.mjs`) | Patches 2 hardcoded checks in omp | Enables remote compaction and freeform `apply_patch` tool — both gated by provider-name checks that plugins can't override |

## Install

```bash
# 1. Install the plugin
omp plugin install github:YanzuoLu/omp-codex-lb-responses

# 2. Apply patches
bunx github:YanzuoLu/omp-codex-lb-responses#main
```

## Configure

### `~/.omp/agent/models.yml`

```yaml
providers:
  codex-lb:
    baseUrl: https://your-codex-lb-host/backend-api/codex
    apiKey: sk-clb-your-token
    api: openai-codex-responses
    auth: apiKey
    models:
      - id: gpt-5.5
        name: gpt-5.5
        reasoning: true
        input: [text, image]
        contextWindow: 272000
        maxTokens: 128000
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }
```

### `~/.omp/agent/config.yml`

Optional. The plugin already forces WebSocket for codex-lb providers, so this is
**not required** for codex-lb — it only affects omp's built-in `openai-codex`
provider. Harmless to set:

```yaml
providers:
  openaiWebsockets: "on"
```

## What the plugin does

- **Forces WebSocket everywhere.** omp's native Codex WebSocket transport is the primary path (the plugin sets `preferWebsockets`). If omp ever falls back to SSE, the plugin upgrades that SSE request to WebSocket too — codex-lb needs WebSocket for session/account consistency.
- Intercepts `globalThis.WebSocket` — rewrites auth headers on every WebSocket connection.
- Intercepts `globalThis.fetch` / the per-request fetch — performs the SSE→WebSocket upgrade (detected on the synthetic token *before* it is swapped for the real key) and rewrites auth headers.
- Creates a synthetic JWT so omp's built-in Codex provider can initialize, then swaps it for the real API key before network I/O.
- Strips `chatgpt-account-id` header (codex-lb manages its own accounts).
- **Auto-recovers.** omp permanently disables WebSocket for a session after one fatal failure (e.g. a slow handshake under load); the plugin re-enables it after a short cooldown so a single hiccup doesn't pin the whole session to the slower path.

### Tuning the upgraded WebSocket (optional)

The upgrade path bounds itself with a 10s connect timeout, a 60s first-event timeout, and a 300s idle timeout (idle measured from the last real event — `codex.keepalive` frames no longer reset it). These are constants in `src/index.ts`; omp's own native-transport timeouts are tunable via `PI_CODEX_WEBSOCKET_*` env vars (see omp docs).

## What the patcher does

Two checks in omp are hardcoded to `model.provider === "openai-codex"` and cannot be overridden by plugins (ESM named imports are read-only):

| Patch | File | Change |
|-------|------|--------|
| Remote compaction | `pi-agent-core/.../compaction/openai.ts` | Also accept `model.api === "openai-codex-responses"` |
| Freeform apply-patch | `pi-ai/.../model-thinking.ts` | Gate on `model.api` alone, not `model.provider` |

Without these patches, long conversations fall back to local summarization (losing encrypted reasoning state) and the apply-patch tool uses standard JSON schema instead of the optimized grammar format.

## Patcher commands

```bash
bunx github:YanzuoLu/omp-codex-lb-responses#main          # apply
bunx github:YanzuoLu/omp-codex-lb-responses#main --check   # verify
bunx github:YanzuoLu/omp-codex-lb-responses#main --revert  # undo
```

## After `omp update`

The plugin survives updates. Patches don't — re-apply:

```bash
bunx github:YanzuoLu/omp-codex-lb-responses#main
```

## Uninstall

```bash
bunx github:YanzuoLu/omp-codex-lb-responses#main --revert
omp plugin uninstall omp-codex-lb-responses
```

## Security

- Real API keys are only sent to your configured `baseUrl`
- The synthetic JWT exists only inside the omp process and is never sent over the network
- Do not commit `apiKey` values to version control
