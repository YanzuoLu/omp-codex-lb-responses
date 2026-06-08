# omp-codex-lb-patch

Patch [omp](https://github.com/can1357/oh-my-pi) to support non-JWT API keys on `openai-codex-responses` backends such as [codex-lb](https://github.com/Soju06/codex-lb).

## What it does

omp's built-in Codex provider assumes the API key is a ChatGPT OAuth JWT and throws `"Failed to extract accountId from token"` for plain API keys. This patcher applies 4 minimal changes (≈10 lines) to the installed omp:

| Change | File | Effect |
|--------|------|--------|
| `getAccountId` fallback | `pi-ai/…/openai-codex-responses.ts` | Derives a stable hash ID instead of throwing on non-JWT tokens |
| Remote compaction gate | `pi-agent-core/…/compaction/openai.ts` | Enables server-side compaction for any `openai-codex-responses` provider |
| Freeform tool format | `pi-ai/…/model-thinking.ts` | Enables grammar-based `apply_patch` tool for non-official providers |
| Image gen guard | `pi-coding-agent/…/tools/image-gen.ts` | Skips `chatgpt-account-id` header instead of throwing |

## Usage

```bash
# Apply patches (run after omp install/update)
bunx github:YanzuoLu/omp-codex-lb-responses

# Check if patches are applied
bunx github:YanzuoLu/omp-codex-lb-responses --check

# Revert to original
bunx github:YanzuoLu/omp-codex-lb-responses --revert
```

## Configure `models.yml`

After patching, use `api: openai-codex-responses` directly with your codex-lb backend — no plugin needed:

```yaml
providers:
  codex-lb:
    baseUrl: https://your-codex-lb-host/backend-api
    apiKey: sk-clb-your-token
    api: openai-codex-responses
    models:
      - id: gpt-5
        reasoning: true
        input: [text, image]
        contextWindow: 272000
        maxTokens: 128000
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }
```

## After `omp update`

`omp update` restores the original files. Re-run the patcher:

```bash
bunx github:YanzuoLu/omp-codex-lb-responses
```

## Security notes

- The real API key is sent directly to your configured `baseUrl` — no synthetic JWT or fetch shim involved.
- Do not commit real `apiKey` values to `models.yml`.
