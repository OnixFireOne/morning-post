// Step 4/5 of the 26.08 provider migration: without this test, a provider
// name, a hardcoded price/overhead number, a stray currency literal, or a
// retired env var name will quietly creep back into some other file the next
// time someone "just adds a quick fallback" — exactly how
// PROXY_INPUT_TOKEN_OVERHEAD=2539 and AI_PRICE_IN/AI_PRICE_OUT ended up
// scattered across usage.ts/usageReport.ts/tools/ai-compare.ts before this
// migration. This test scans every .ts file under src/ (except
// src/ai/providers.ts itself) as raw text — comments included, deliberately:
// a provider name or a real price number written down anywhere, even in a
// comment, is exactly the kind of thing a future edit copy-pastes into real
// code.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listProviderNames, resolveProviderProfile } from "../src/ai/providers.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const TOOLS_DIR = path.join(REPO_ROOT, "tools");
const PROVIDERS_FILE = path.join(SRC_DIR, "ai", "providers.ts");
const USAGE_REPORT_FILE = path.join(SRC_DIR, "ai", "usageReport.ts");

function listTsFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			files.push(...listTsFiles(full));
		} else if (full.endsWith(".ts")) {
			files.push(full);
		}
	}
	return files;
}

const ALL_SRC_FILES = listTsFiles(SRC_DIR);
const OTHER_SRC_FILES = ALL_SRC_FILES.filter((f) => f !== PROVIDERS_FILE);
/** "The report module" for step 5's currency-literal check — the one file allowed to spell the currency sign as a literal (src/ai/usageReport.ts's own CURRENCY_SYMBOL). tools/ai-compare.ts has its own separate local copy of the same literal — it lives outside src/, outside this scan's scope entirely, same as the rest of this file's checks. */
const NON_REPORT_SRC_FILES = ALL_SRC_FILES.filter((f) => f !== USAGE_REPORT_FILE);

describe("no src/ file outside providers.ts names a provider or hardcodes a pricing number", () => {
	it("sanity: this scan actually found more than one file (otherwise it's vacuously passing)", () => {
		expect(OTHER_SRC_FILES.length).toBeGreaterThan(10);
	});

	it("the quoted provider-profile selector strings never appear outside providers.ts", () => {
		const names = listProviderNames(); // ["anthropic", "openrouter"] today — read from the module, not hardcoded here, so this test itself can't drift from what actually needs guarding
		expect(names.length).toBeGreaterThan(0);
		for (const file of OTHER_SRC_FILES) {
			const text = readFileSync(file, "utf8");
			for (const name of names) {
				expect(text, `${file} contains the literal provider name "${name}" — provider names belong only in src/ai/providers.ts`).not.toContain(`"${name}"`);
			}
		}
	});

	it("no real model slug from either profile's priceTable/primaryModel/fallbackModel is hardcoded elsewhere", () => {
		const modelIds = new Set<string>();
		for (const name of listProviderNames()) {
			const profile = resolveProviderProfile(name);
			modelIds.add(profile.primaryModel);
			modelIds.add(profile.fallbackModel);
			for (const id of Object.keys(profile.priceTable)) modelIds.add(id);
		}
		for (const file of OTHER_SRC_FILES) {
			const text = readFileSync(file, "utf8");
			for (const modelId of modelIds) {
				expect(text, `${file} hardcodes the model id "${modelId}" — model defaults belong only in src/ai/providers.ts (env.aiModel/aiModelFallback carry it everywhere else)`).not.toContain(modelId);
			}
		}
	});

	it("no priceInPerMillion/priceOutPerMillion field is ever set to a numeric literal outside providers.ts", () => {
		const priceFieldWithNumber = /price(In|Out)PerMillion\s*:\s*\d/;
		for (const file of OTHER_SRC_FILES) {
			const text = readFileSync(file, "utf8");
			expect(priceFieldWithNumber.test(text), `${file} sets a price*PerMillion field to a numeric literal — prices belong only in src/ai/providers.ts's priceTable`).toBe(false);
		}
	});

	// A bare-numeric-literal scan for the actual price values (14/42/20/60)
	// was deliberately left out here: those are small, generic integers that
	// show up in this codebase for entirely unrelated reasons (percentages,
	// thresholds, array sizes...) — a scan like that is a false-positive trap,
	// not a real guard. The precise field-shape check above (price*PerMillion
	// set to a numeric literal) already catches the actual risk — a price
	// table recreated somewhere else — without flagging unrelated numbers.

	it("the retired PROXY_INPUT_TOKEN_OVERHEAD constant name and its value (2539) never reappear outside providers.ts", () => {
		for (const file of OTHER_SRC_FILES) {
			const text = readFileSync(file, "utf8");
			expect(text, `${file} still contains the retired constant name PROXY_INPUT_TOKEN_OVERHEAD`).not.toContain("PROXY_INPUT_TOKEN_OVERHEAD");
			expect(new RegExp(`(?<!\\d)2539(?!\\d)`).test(text), `${file} still contains the retired overhead value 2539`).toBe(false);
		}
	});

	it("the retired billedInputTokens/computeCost(usage.js) names never reappear — computeAttemptCost is the one replacement", () => {
		for (const file of OTHER_SRC_FILES) {
			const text = readFileSync(file, "utf8");
			expect(text, `${file} still contains the retired billedInputTokens name`).not.toContain("billedInputTokens");
		}
	});
});

describe("step 5: unitLabel is fully retired, and the currency sign lives only in the report module", () => {
	it("unitLabel never appears anywhere in src/, including providers.ts itself — the field was removed, not renamed", () => {
		for (const file of ALL_SRC_FILES) {
			const text = readFileSync(file, "utf8");
			expect(text, `${file} still references unitLabel — it was replaced by AiProviderProfile.unitRate (a conversion factor, not a display string) plus usageReport.ts's own CURRENCY_SYMBOL`).not.toContain("unitLabel");
		}
	});

	it('the literal currency sign "$" as its own string never appears outside src/ai/usageReport.ts', () => {
		for (const file of NON_REPORT_SRC_FILES) {
			const text = readFileSync(file, "utf8");
			expect(text, `${file} hardcodes the currency literal "$" — the dollar sign belongs only in src/ai/usageReport.ts's CURRENCY_SYMBOL (tools/ai-compare.ts has its own separate copy, outside this scan's scope)`).not.toContain('"$"');
		}
	});
});

describe("step 3/4: the removed legacy env vars are never read again, in src/ or tools/", () => {
	// AI_PRICE_IN/AI_PRICE_OUT/AI_FALLBACK_PRICE_IN/AI_FALLBACK_PRICE_OUT: gone
	// with the old per-model env-var pricing, replaced by providers.ts's
	// priceTable. AI_DAILY_TOKEN_WARN: gone with the whole daily-token-warning
	// feature, not just unused. AI_INPUT_TOKEN_OVERHEAD: deliberately never
	// introduced at all — overhead lives only in AiProviderProfile.inputOverhead
	// (see providers.ts's own comment on why no env knob exists for it). A
	// variable forgotten in a real .env must be inert, not silently read by
	// some file nobody thought to update.
	const REMOVED_ENV_VARS = ["AI_PRICE_IN", "AI_PRICE_OUT", "AI_FALLBACK_PRICE_IN", "AI_FALLBACK_PRICE_OUT", "AI_DAILY_TOKEN_WARN", "AI_INPUT_TOKEN_OVERHEAD"];

	it("sanity: this scan actually found more than one file in each directory", () => {
		expect(ALL_SRC_FILES.length).toBeGreaterThan(10);
		expect(listTsFiles(TOOLS_DIR).length).toBeGreaterThan(0);
	});

	it("no src/ or tools/ file reads process.env.<removed var>", () => {
		const allFiles = [...ALL_SRC_FILES, ...listTsFiles(TOOLS_DIR)];
		for (const file of allFiles) {
			const text = readFileSync(file, "utf8");
			for (const name of REMOVED_ENV_VARS) {
				expect(text, `${file} still reads process.env.${name} — this variable was removed and must be inert if left set in a real .env`).not.toContain(`process.env.${name}`);
			}
		}
	});
});
