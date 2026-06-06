# omp-codex-lb-responses

OMP plugin for Codex-compatible load-balanced backends that use opaque bearer tokens such as `sk-clb-...`.

Use this when your backend speaks the OpenAI Codex Responses protocol, but is not the official `https://chatgpt.com/backend-api/codex/responses` endpoint and cannot provide a ChatGPT `accountId` from the bearer token.

## Install

```sh
omp plugin install github:YanzuoLu/omp-codex-lb-responses
```

Check that OMP sees it:

```sh
omp plugin list
```

## Configure in `models.yml`

Keep provider/model/baseUrl/apiKey in `~/.omp/agent/models.yml`.

Write the schema-valid API name `openai-codex-responses`, not `codex-lb-responses`. OMP validates `models.yml` before plugins load, so custom plugin API names cannot appear directly in that file.

```yaml
providers:
  codex-lb:
    baseUrl: https://your-codex-compatible-host/backend-api/codex
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

At runtime, this plugin detects eligible providers and installs an auth shim for them.

A provider is eligible when:

- its effective model API is `openai-codex-responses`
- it has a non-official `baseUrl`
- it has an opaque token that does not contain a ChatGPT Codex `accountId`

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

- Scans `~/.omp/agent/models.yml` for eligible Codex-compatible providers.
- Registers a provider-level runtime API key override with a synthetic internal JWT so OMP's built-in Codex provider can initialize.
- Installs fetch/WebSocket header shims that replace the synthetic JWT with the real opaque token before network I/O.
- Removes `chatgpt-account-id` before the request reaches the custom backend.
- Keeps provider/model configuration in `models.yml`.
- Does not patch OMP or require a local OMP fork.

The package still reserves/registers the custom API name `codex-lb-responses` for direct extension use, but normal `models.yml` usage should keep `api: openai-codex-responses`.

## When not to use it

Do not use this for the official ChatGPT Codex endpoint. Official ChatGPT Codex tokens already contain the account id needed by OMP's built-in provider.

## Update

Re-run install:

```sh
omp plugin install github:YanzuoLu/omp-codex-lb-responses
```

## Uninstall

```sh
omp plugin uninstall omp-codex-lb-responses
```

Then remove or change any `models.yml` provider that relied on opaque-token Codex LB behavior.

## Security notes

- Do not commit real `apiKey` values.
- The real token is only forwarded to the configured `baseUrl`.
- The plugin uses an internal synthetic JWT inside OMP, then rewrites it to the real opaque bearer token immediately before network I/O.
