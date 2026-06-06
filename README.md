# omp-codex-lb-responses

OMP plugin that registers `api: codex-lb-responses` for Codex-compatible load-balanced backends that use opaque bearer tokens such as `sk-clb-...`.

Use this when your backend speaks the OpenAI Codex Responses protocol, but is not the official `https://chatgpt.com/backend-api/codex/responses` endpoint and cannot provide a ChatGPT `accountId` from the bearer token.

## Install

```sh
omp plugin install github:YanzuoLu/omp-codex-lb-responses
```

Check that OMP sees it:

```sh
omp plugin list
```

Expected plugin name:

```text
omp-codex-lb-responses
```

## Configure a model

Edit `~/.omp/agent/models.yml` and set the provider API to `codex-lb-responses`.

```yaml
providers:
  mvp-lab:
    baseUrl: https://your-codex-compatible-host/backend-api/codex
    apiKey: sk-clb-your-token
    api: codex-lb-responses
    auth: apiKey
    models:
      - id: gpt-5.5
        name: gpt-5.5
        reasoning: true
        input: [text, image]
```

To force Codex websocket transport, set this in `~/.omp/agent/config.yml`:

```yaml
providers:
  openaiWebsockets: "on"
```

If you leave that unset, OMP's normal Codex websocket selection still applies.

## Verify

```sh
omp --smoke-test
```

Then start OMP with a model from the configured provider. If OMP says the API is unknown, the plugin is not installed or not enabled.

## What this plugin does

- Registers custom API name `codex-lb-responses`.
- Reuses OMP's built-in `openai-codex-responses` implementation.
- Lets the built-in Codex provider initialize with a synthetic internal JWT.
- Rewrites outbound SSE/WebSocket headers so the real opaque token is sent as `Authorization: Bearer ...`.
- Removes `chatgpt-account-id` before the request reaches the custom backend.
- Does not patch OMP or require a local OMP fork.

## When not to use it

Do not use this for the official ChatGPT Codex endpoint. For official ChatGPT Codex, use OMP's built-in API:

```yaml
api: openai-codex-responses
```

## Update

Re-run install:

```sh
omp plugin install github:YanzuoLu/omp-codex-lb-responses
```

## Uninstall

```sh
omp plugin uninstall omp-codex-lb-responses
```

Then change any model using `api: codex-lb-responses` back to a supported API.

## Security notes

- Do not commit real `apiKey` values.
- The real token is only forwarded to the configured `baseUrl`.
- The plugin uses an internal private header while wrapping OMP's built-in Codex provider, then strips that header before network I/O.
