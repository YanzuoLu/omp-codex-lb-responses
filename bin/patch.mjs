#!/usr/bin/env node
/**
 * omp-codex-lb-patch — patch a global omp install to support non-JWT API keys
 * on openai-codex-responses backends (e.g. codex-lb).
 *
 * Usage:  bunx omp-codex-lb-patch          # apply patches
 *         bunx omp-codex-lb-patch --check  # verify patches are applied
 *         bunx omp-codex-lb-patch --revert # restore originals
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";

const PATCHES = [
	{
		pkg: "@oh-my-pi/pi-ai",
		file: "src/providers/openai-codex-responses.ts",
		replacements: [
			{
				label: "getAccountId: derive stable synthetic ID for non-JWT tokens",
				find: `import * as os from "node:os";`,
				replace: `import { createHash } from "node:crypto";\nimport * as os from "node:os";`,
			},
			{
				label: "getAccountId: remove throw on non-JWT",
				find: [
					`function getAccountId(accessToken: string): string {`,
					`\tconst accountId = getCodexAccountId(accessToken);`,
					`\tif (!accountId) {`,
					`\t\tthrow new Error("Failed to extract accountId from token");`,
					`\t}`,
					`\treturn accountId;`,
					`}`,
				].join("\n"),
				replace: [
					`function getAccountId(accessToken: string): string {`,
					`\tconst accountId = getCodexAccountId(accessToken);`,
					`\tif (accountId) return accountId;`,
					`\treturn \`opaque-\${createHash("sha256").update(accessToken).digest("base64url").slice(0, 16)}\`;`,
					`}`,
				].join("\n"),
			},
			{
				label: "createCodexHeaders: skip chatgpt-account-id for synthetic IDs",
				find: `\theaders.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);`,
				replace: [
					`\tif (!accountId.startsWith("opaque-")) {`,
					`\t\theaders.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);`,
					`\t}`,
				].join("\n"),
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
		pkg: "@oh-my-pi/pi-coding-agent",
		file: "src/tools/image-gen.ts",
		replacements: [
			{
				label: "image-gen: skip chatgpt-account-id when absent",
				find: [
					`\t\tconst accountId = getCodexAccountId(apiKey);`,
					`\t\tif (!accountId) {`,
					`\t\t\tthrow new Error("Failed to extract accountId from OpenAI Codex token");`,
					`\t\t}`,
					`\t\theaders.delete("x-api-key");`,
					`\t\theaders.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);`,
				].join("\n"),
				replace: [
					`\t\tconst accountId = getCodexAccountId(apiKey);`,
					`\t\theaders.delete("x-api-key");`,
					`\t\tif (accountId) {`,
					`\t\t\theaders.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);`,
					`\t\t}`,
				].join("\n"),
			},
		],
	},
];

function resolveGlobalNm() {
	const home = process.env.HOME || process.env.USERPROFILE || "~";
	const candidates = [
		join(home, ".bun/install/global/node_modules"),
	];
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

	let applied = 0;
	let skipped = 0;
	let failed = 0;

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
				if (alreadyApplied) {
					console.log(`  ✔ ${r.label}`);
					applied++;
				} else if (canApply) {
					console.log(`  ✘ ${r.label} — not applied`);
					failed++;
				} else {
					console.log(`  ? ${r.label} — source changed, cannot match`);
					failed++;
				}
				continue;
			}

			if (alreadyApplied) {
				console.log(`  - ${r.label} (already applied)`);
				skipped++;
				continue;
			}
			if (!canApply) {
				console.error(`  ✘ ${r.label} — cannot match source (omp version incompatible?)`);
				failed++;
				continue;
			}

			if (!filePatched && !existsSync(backupPath)) {
				copyFileSync(filePath, backupPath);
			}
			content = content.replace(r.find, r.replace);
			filePatched = true;
			console.log(`  ✔ ${r.label}`);
			applied++;
		}

		if (filePatched) {
			writeFileSync(filePath, content);
		}
	}

	console.log();
	if (isCheck) {
		if (failed > 0) {
			console.log(`${failed} patch(es) not applied. Run: bunx omp-codex-lb-patch`);
			process.exit(1);
		}
		console.log("All patches applied.");
	} else if (isRevert) {
		console.log(`Reverted ${applied} file(s).`);
	} else {
		if (failed > 0) {
			console.log(`${applied} applied, ${failed} failed. Check omp version compatibility.`);
			process.exit(1);
		}
		console.log(`Done. ${applied} applied, ${skipped} skipped.`);
	}
}

main();
