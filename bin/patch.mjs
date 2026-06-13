#!/usr/bin/env node
/**
 * omp-codex-lb-patch — enable remote compaction and freeform apply-patch
 * for third-party openai-codex-responses providers.
 *
 * These two checks are hardcoded in omp's ESM exports and cannot be
 * overridden by a plugin. The plugin handles everything else.
 *
 * Usage:  bunx omp-codex-lb-patch          # apply
 *         bunx omp-codex-lb-patch --check  # verify
 *         bunx omp-codex-lb-patch --revert # undo
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";

const PATCHES = [
	{
		pkg: "@oh-my-pi/pi-agent-core",
		file: "src/compaction/openai.ts",
		replacements: [
			{
				label: "shouldUseOpenAiRemoteCompaction: accept by api type",
				find: `return model.provider === "openai" || model.provider === "openai-codex";`,
				replace: `return model.provider === "openai" || model.provider === "openai-codex" || model.api === "openai-codex-responses";`,
			},
		],
	},
	// NOTE: the old `applyPatchToolType` gate in pi-ai/src/model-thinking.ts is
	// gone as of omp 15.x — `model-thinking` moved to @oh-my-pi/pi-catalog and the
	// freeform-vs-function apply_patch decision is now the per-model catalog field
	// `model.applyPatchToolType === "freeform"` (read in openai-codex-responses.ts
	// / openai-responses.ts). The plugin now sets that field on its normalized
	// models instead, so no source patch is needed for freeform apply_patch.
	{
		// Optional — only needed for `webSearch: tool` (native search-card UI).
		// Redirects omp's built-in `codex` web-search provider to codex-lb when the
		// plugin has published a web-search config on the global. Falls back to the
		// official ChatGPT OAuth endpoint otherwise, so this is a no-op for users
		// who don't enable it.
		pkg: "@oh-my-pi/pi-coding-agent",
		file: "src/web/search/providers/codex.ts",
		replacements: [
			{
				label: "hasCodexSearch: enable codex-lb web search",
				find: 'return authStorage.hasOAuth("openai-codex");',
				replace:
					'if ((globalThis as any)[Symbol.for("omp.codex-lb-responses.web-search")]) return true;\n\treturn authStorage.hasOAuth("openai-codex");',
			},
			{
				label: "findCodexAuth: use codex-lb credentials",
				find: 'const access = await authStorage.getOAuthAccess("openai-codex", sessionId, { signal });',
				replace:
					'const __ompCodexLb = (globalThis as any)[Symbol.for("omp.codex-lb-responses.web-search")];\n\tif (__ompCodexLb) return { accessToken: __ompCodexLb.apiKey, accountId: __ompCodexLb.accountId };\n\tconst access = await authStorage.getOAuthAccess("openai-codex", sessionId, { signal });',
			},
			{
				label: "callCodexSearch: route to codex-lb base URL",
				find: 'const url = `${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}`;',
				replace:
					'const __ompCodexLbUrl = (globalThis as any)[Symbol.for("omp.codex-lb-responses.web-search")];\n\tconst url = __ompCodexLbUrl ? `${__ompCodexLbUrl.baseUrl}/responses` : `${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}`;',
			},
			{
				label: "callCodexSearch: apply codex-lb web_search tool + reasoning",
				find: 'const fetchImpl = options.fetch ?? fetch;',
				replace:
					'if (__ompCodexLbUrl) {\n\t\tif (__ompCodexLbUrl.searchTool) body.tools = [__ompCodexLbUrl.searchTool];\n\t\tif (__ompCodexLbUrl.reasoningEffort) body.reasoning = { effort: __ompCodexLbUrl.reasoningEffort };\n\t}\n\tconst fetchImpl = options.fetch ?? fetch;',
			},
			{
				label: "callCodexSearch: use codex-lb search timeout",
				find: 'signal: withHardTimeout(options.signal),',
				replace: 'signal: withHardTimeout(options.signal, __ompCodexLbUrl?.searchTimeoutMs),',
			},
		],
	},
	{
		// Auto-recover from codex-lb stale-anchor failures that omp doesn't classify.
		// Two known shapes:
		// 1. codex-lb's non-standard `codex_previous_response_stale` ("Upstream previous
		//    response anchor expired; retry without previous_response_id.").
		// 2. Upstream `invalid_request_error` "No tool call found for function call
		//    output with call_id …" — codex-lb replays a turn upstream mid-stream and
		//    keeps the downstream response id pinned to the pre-replay id, so omp's next
		//    delta request anchors at an upstream response that lacks the tool calls.
		// Both mean the anchor is unusable; omp's recovery (retry with full context, no
		// previous_response_id) fixes both, but only fires on the standard
		// `previous_response_not_found`. Helps all codex-lb users.
		pkg: "@oh-my-pi/pi-ai",
		file: "src/providers/openai-codex-responses.ts",
		replacements: [
			{
				// As of omp 15.12.x the matcher is `isCodexStalePreviousResponseError`
				// and its first line early-returns for ANY CodexProviderStreamError with
				// `code === "previous_response_not_found"` — short-circuiting BEFORE the
				// message regex below it. codex-lb surfaces its stale anchor as a
				// `response.failed` → CodexProviderStreamError with code
				// `codex_previous_response_stale`, so stock omp returns false here and the
				// stale-anchor recovery never fires. Broaden the early return to also match
				// codex-lb's code and the two message shapes (stale anchor + replayed
				// "no tool call found for function call output").
				label: "isCodexStalePreviousResponseError: also match codex-lb stale anchor",
				find: 'if (error instanceof CodexProviderStreamError) return error.code === "previous_response_not_found";',
				replace:
					'if (error instanceof CodexProviderStreamError) return error.code === "previous_response_not_found" || error.code === "codex_previous_response_stale" || /previous_response_not_found|codex_previous_response_stale|previous response anchor expired|retry without previous_response_id|no tool call found for function call output/i.test(error.message);',
			},
			{
				// Auto-retry codex-lb TRANSIENT upstream failures. codex-lb load-balances
				// across upstream ChatGPT accounts and surfaces a `response.failed` with an
				// `error.code` once its own per-request account failover (up to ~3 accounts)
				// is exhausted. omp only classifies {model_error, server_error,
				// internal_error} as retryable, so a transient upstream blip (e.g.
				// `upstream_unavailable` / "Request to upstream timed out") fails the whole
				// turn on the FIRST attempt instead of retrying — surprising on session
				// turn 1. `upstream_error` and `upstream_request_timeout` are unconditionally
				// transient in codex-lb (helpers.py classify_upstream_failure / _TRANSIENT_*),
				// so add them as retryable codes. A fresh omp retry starts a new account
				// selection round, bounded by CODEX_MAX_RETRIES and gated on no content yet.
				label: "CODEX_RETRYABLE_EVENT_CODES: also retry codex-lb transient upstream codes",
				find: 'const CODEX_RETRYABLE_EVENT_CODES = new Set(["model_error", "server_error", "internal_error"]);',
				replace:
					'const CODEX_RETRYABLE_EVENT_CODES = new Set(["model_error", "server_error", "internal_error", "upstream_error", "upstream_request_timeout"]);',
			},
			{
				// Match codex-lb's transient *messages* too (covers `upstream_unavailable`
				// and `stream_incomplete`, both of which are retryable ONLY when the message
				// is a transient-network phrase). Matching by message — not bare code —
				// deliberately EXCLUDES the non-retryable lookalikes: TLS-cert failures
				// ("certificate verify failed"), the suppressed-duplicate-tool-call
				// `stream_incomplete`, and `client_disconnected` (none contain these
				// phrases), so auth/400/permission/duplicate errors still surface.
				label: "CODEX_RETRYABLE_EVENT_MESSAGE: also retry codex-lb transient upstream messages",
				find: '/processing your request|retry your request|temporar(?:y|ily)|overloaded|service.?unavailable|internal error|server error/i;',
				replace:
					'/processing your request|retry your request|temporar(?:y|ily)|overloaded|service.?unavailable|internal error|server error|timed out|connection reset|connection closed|connection aborted|broken pipe|server disconnected|cannot connect|keepalive ping timeout|upstream closed|websocket closed before response/i;',
			},
		],
	},
];

function resolveGlobalNm() {
	const home = process.env.HOME || process.env.USERPROFILE || "~";
	const candidates = [join(home, ".bun/install/global/node_modules")];
	try {
		const bunBin = execSync("bun pm bin -g", { encoding: "utf8" }).trim();
		candidates.unshift(join(dirname(bunBin), "install/global/node_modules"));
	} catch {}
	for (const c of candidates) {
		if (existsSync(join(c, "@oh-my-pi/pi-ai"))) return c;
	}
	throw new Error("Cannot locate omp global install. Is omp installed via bun?");
}

function main() {
	const mode = process.argv[2];
	const isCheck = mode === "--check";
	const isRevert = mode === "--revert";
	const globalNm = resolveGlobalNm();
	let applied = 0, skipped = 0, failed = 0;

	for (const patch of PATCHES) {
		const filePath = join(globalNm, patch.pkg, patch.file);
		if (!existsSync(filePath)) {
			console.error(`  ✘ ${patch.pkg}/${patch.file} not found`);
			failed++;
			continue;
		}
		const backupPath = filePath + ".codex-lb-orig";
		let content = readFileSync(filePath, "utf8");

		if (isRevert) {
			if (existsSync(backupPath)) {
				copyFileSync(backupPath, filePath);
				console.log(`  ✔ Reverted ${patch.pkg}/${patch.file}`);
				applied++;
			} else {
				console.log(`  - ${patch.pkg}/${patch.file} (no backup)`);
				skipped++;
			}
			continue;
		}

		let filePatched = false;
		for (const r of patch.replacements) {
			for (const superseded of r.supersedes ?? []) {
				if (!content.includes(superseded)) continue;
				content = content.replace(superseded, r.find);
				if (!isCheck) filePatched = true;
			}
			const alreadyApplied = content.includes(r.replace);
			const canApply = content.includes(r.find);
			if (isCheck) {
				if (alreadyApplied) { console.log(`  ✔ ${r.label}`); applied++; }
				else if (canApply) { console.log(`  ✘ ${r.label} — not applied`); failed++; }
				else { console.log(`  ? ${r.label} — source changed`); failed++; }
				continue;
			}
			if (alreadyApplied) { console.log(`  - ${r.label} (already applied)`); skipped++; continue; }
			if (!canApply) { console.error(`  ✘ ${r.label} — cannot match source`); failed++; continue; }
			if (!filePatched && !existsSync(backupPath)) copyFileSync(filePath, backupPath);
			content = content.replace(r.find, r.replace);
			filePatched = true;
			console.log(`  ✔ ${r.label}`);
			applied++;
		}
		if (filePatched) writeFileSync(filePath, content);
	}

	console.log();
	if (isCheck) {
		if (failed > 0) { console.log(`${failed} patch(es) not applied. Run: bunx omp-codex-lb-patch`); process.exit(1); }
		console.log("All patches applied.");
	} else if (isRevert) {
		console.log(`Reverted ${applied} file(s).`);
	} else {
		if (failed > 0) { console.log(`${applied} applied, ${failed} failed.`); process.exit(1); }
		console.log(`Done. ${applied} applied, ${skipped} skipped.`);
	}
}

main();
