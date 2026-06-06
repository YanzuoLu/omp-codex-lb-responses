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

## Configure

Do not put `api: codex-lb-responses` in `~/.omp/agent/models.yml`. OMP validates `models.yml` before plugins register custom API names, so the plugin registers the provider/model itself.

Set plugin config instead:

```sh
omp plugin config set omp-codex-lb-responses provider codex-lb
omp plugin config set omp-codex-lb-responses baseUrl https://your-codex-compatible-host/backend-api/codex
omp plugin config set omp-codex-lb-responses apiKey sk-clb-your-token
omp plugin config set omp-codex-lb-responses modelId gpt-5.5
omp plugin config set omp-codex-lb-responses modelName gpt-5.5
omp plugin config set omp-codex-lb-responses contextWindow 272000
omp plugin config set omp-codex-lb-responses maxTokens 128000
```

Alternative: omit `apiKey` and set an environment variable instead:

```sh
export CODEX_LB_API_KEY=sk-clb-your-token
```

The default `apiKeyEnv` is `CODEX_LB_API_KEY`. You can change it:

```sh
omp plugin config set omp-codex-lb-responses apiKeyEnv MY_CODEX_LB_API_KEY
```

To force Codex websocket transport, set this in `~/.omp/agent/config.yml`:

```yaml
providers:
  openaiWebsockets: "on"
```

## Verify

List models and confirm your provider/model appears:

```sh
omp --list-models codex-lb
```

Then run the smoke test:

```sh
omp --smoke-test
```

## What this plugin does

- Registers custom API name `codex-lb-responses`.
- Optionally registers a configured provider/model from plugin settings.
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

Remove any plugin-specific model/provider config after uninstalling.

## Security notes

- Do not commit real `apiKey` values.
- The real token is only forwarded to the configured `baseUrl`.
- The plugin uses an internal private header while wrapping OMP's built-in Codex provider, then strips that header before network I/O.
