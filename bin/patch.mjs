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
	{
		pkg: "@oh-my-pi/pi-ai",
		file: "src/model-thinking.ts",
		replacements: [
			{
				label: "applyPatchToolType: gate on api type alone",
				find: `if (model.provider === "openai-codex" && model.api === "openai-codex-responses") {`,
				replace: `if (model.api === "openai-codex-responses") {`,
			},
		],
	},
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
		// Auto-recover from codex-lb's non-standard stale-previous_response_id error.
		// codex-lb returns code `codex_previous_response_stale` / "Upstream previous
		// response anchor expired; retry without previous_response_id.", but omp only
		// recognizes the standard `previous_response_not_found`, so the turn fails
		// instead of transparently retrying with full context. Helps all codex-lb users.
		pkg: "@oh-my-pi/pi-ai",
		file: "src/providers/openai-codex-responses.ts",
		replacements: [
			{
				label: "isCodexPreviousResponseNotFound: also match codex-lb stale anchor",
				find: 'return error instanceof CodexProviderStreamError && error.code === "previous_response_not_found";',
				replace:
					'return error instanceof CodexProviderStreamError && (error.code === "previous_response_not_found" || error.code === "codex_previous_response_stale" || /previous_response_not_found|codex_previous_response_stale|previous response anchor expired|retry without previous_response_id/i.test(error.message));',
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
