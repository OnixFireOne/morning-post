// The provider catalog itself now lives in data (config/providers.json or
// AI_PROVIDERS_FILE — see resolveProvidersFilePath below), not in this file
// as TypeScript literals. This file is the one remaining code entry point:
// it defines the shape (AiProviderProfile), validates the JSON against that
// shape by hand at load time, and exposes the same public API as before
// (resolveProviderProfile/computeAttemptCost/listProviderNames) so no
// calling code had to change. A provider's name, base URL, auth style,
// default models, or a pricing number may still only ever appear in the
// catalog file — never as a literal elsewhere in src/ — enforced by
// tests/ai-providers-leak.test.ts, which scans the rest of src/ for exactly
// those two things (it excludes this file, not the catalog file — the
// catalog lives outside src/ entirely, so it was never in that scan's scope
// to begin with). Selected by AI_PROVIDER (src/index.ts's readEnv());
// AI_BASE_URL/AI_MODEL/AI_MODEL_FALLBACK, when set in .env, still override a
// profile's own defaults for exactly that field — the profile fills gaps, it
// doesn't force a value nobody asked to change.
//
// The dollar is the only unit anywhere in this project — see
// src/ai/usageReport.ts's own CURRENCY_SYMBOL comment. A provider's own
// billing unit (if it isn't already USD) is converted to USD by `unitRate`
// below, inside computeAttemptCost() and nowhere else; nothing past that
// function ever sees or needs to know the provider's native unit existed.
import { readFileSync } from "node:fs";
import path from "node:path";

export type AiAuthStyle = "bearer" | "x-api-key";

export type AiModelPrice = { priceInPerMillion: number; priceOutPerMillion: number };

/**
 * Describes *accuracy*, not a unit — both values already produce genuine USD
 * figures (computeAttemptCost applies unitRate to both). "provider": the
 * response itself carries the real bill (OpenRouter's `usage.cost`, verified
 * 26.08 against a live request — matches the public per-model price to the
 * digit, keyed by `usage.prompt_tokens`, the same count billing uses) —
 * exact, nothing to estimate. "table": the response has no cost field at
 * all, so this attempt is priced from `priceTable` below instead — an
 * estimate under our own assumed per-model rate, not the provider's own
 * confirmed charge. A balance window mixing the two isn't mixing
 * incompatible units (usageReport.ts's own note is careful to say so) — it's
 * mixing an exact sum with a partly-estimated one.
 */
export type AiCostSource = "provider" | "table";

/** "api": balance is meant to be read from the provider's own account/credits endpoint — not implemented yet (no real call happens anywhere in this codebase; see README before wiring one in). "manual": there is no such endpoint — the only balance this app can ever know is AI_BALANCE_START minus what usage.jsonl itself records having spent. */
export type AiBalanceSource = "api" | "manual";

export type AiProviderProfile = {
	name: string;
	baseUrl: string;
	authStyle: AiAuthStyle;
	/** Name of the environment variable holding this provider's API key — never the key value itself (the catalog file is committed to git; see index.ts's readEnv, `process.env[providerProfile.apiKeyVar]`, for where the real value actually gets read). Same pattern as LiteLLM's `os.environ/VAR` and llm-env's `api_key_var=`. Both current profiles point at "AI_API_KEY" today — nothing stops a future entry from naming a different variable if it needs its own secret. */
	apiKeyVar: string;
	/** Static headers merged into every request — provider-specific extras (e.g. OpenRouter's optional ranking attribution), never a secret (the API key itself is never a header value here; see authStyle/apiKeyVar). */
	extraHeaders: Record<string, string>;
	primaryModel: string;
	fallbackModel: string;
	costSource: AiCostSource;
	/** Only consulted when costSource is "table" — a "provider" cost source reads usage.cost straight from the response and never looks at this at all. Keyed by model id, in the provider's own native unit (before unitRate). Required to have at least one entry when costSource is "table" — an empty table would silently price every attempt as null forever, no error, exactly the kind of trap the loader's own validation catches instead. */
	priceTable: Partial<Record<string, AiModelPrice>>;
	/**
	 * Subtracted from tokensIn before a "table" cost calc only — a "provider"
	 * cost is the real bill already, there is nothing left to correct. 0 is a
	 * no-op, and both current profiles use it. Deliberately not overridable
	 * from .env: an external knob for "correct for someone else's
	 * undocumented billing" is exactly how the old per-proxy
	 * PROXY_INPUT_TOKEN_OVERHEAD=2539 constant happened in the first place
	 * (see git history) — if a provider's real billing needs this, it belongs
	 * here, in the catalog entry itself, reasoned about per profile, not
	 * tweaked blind from an env var.
	 */
	inputOverhead: number;
	balanceSource: AiBalanceSource;
	/** How many USD one unit of priceTable/usage.cost is worth — 1 for both current profiles (both already bill in USD). The one place this ever gets multiplied in is computeAttemptCost() below; everything downstream of it (usage.jsonl, *.ai.json, every report) only ever sees the resulting dollar figure. */
	unitRate: number;
};

export const DEFAULT_PROVIDER_NAME = "openrouter";

/** cwd-relative, same convention as every other default path in this app (STATE_FILE, OUT_DIR, FACTS_LOG_FILE) — the app is always run from the repo root, whether via `npm run`, tsx directly, or the Dockerfile's WORKDIR. */
const DEFAULT_PROVIDERS_FILE = "config/providers.json";

const KNOWN_PROFILE_FIELDS = new Set([
	"name",
	"baseUrl",
	"authStyle",
	"apiKeyVar",
	"extraHeaders",
	"primaryModel",
	"fallbackModel",
	"costSource",
	"priceTable",
	"inputOverhead",
	"balanceSource",
	"unitRate",
]);

/**
 * Hand-written schema check, not a library — the catalog is small and fixed-
 * shape enough that a validation library would be more ceremony than the
 * problem needs. Every failure names the provider key and the specific field
 * (never a bare "invalid config") — an operator editing AI_PROVIDERS_FILE by
 * hand on a VPS, no git pull, no code review, needs to know exactly what to
 * fix. No silent defaults anywhere: a missing/wrong-shaped field throws,
 * it's never filled in with something plausible-looking.
 */
export function validateProviderProfile(key: string, raw: unknown): AiProviderProfile {
	function fail(field: string, message: string): never {
		throw new Error(`providers catalog: provider "${key}": ${field} ${message}`);
	}

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`providers catalog: provider "${key}" must be an object`);
	}
	const obj = raw as Record<string, unknown>;

	for (const field of Object.keys(obj)) {
		if (!KNOWN_PROFILE_FIELDS.has(field)) fail(field, "is not a recognized field");
	}

	function requireString(field: string): string {
		const v = obj[field];
		if (typeof v !== "string" || v.trim() === "") fail(field, "must be a non-empty string");
		return v as string;
	}

	const name = requireString("name");
	if (name !== key) fail("name", `must match the provider's own key ("${key}"), got "${name}"`);

	const baseUrl = requireString("baseUrl");

	const authStyle = requireString("authStyle");
	if (authStyle !== "bearer" && authStyle !== "x-api-key") fail("authStyle", 'must be "bearer" or "x-api-key"');

	const apiKeyVar = requireString("apiKeyVar");

	const extraHeadersRaw = obj.extraHeaders;
	if (typeof extraHeadersRaw !== "object" || extraHeadersRaw === null || Array.isArray(extraHeadersRaw)) {
		fail("extraHeaders", "must be an object of string headers (use {} for none)");
	}
	const extraHeaders: Record<string, string> = {};
	for (const [headerName, headerValue] of Object.entries(extraHeadersRaw as Record<string, unknown>)) {
		if (typeof headerValue !== "string") fail("extraHeaders", `value for "${headerName}" must be a string`);
		extraHeaders[headerName] = headerValue;
	}

	const primaryModel = requireString("primaryModel");
	const fallbackModel = requireString("fallbackModel");

	const costSource = requireString("costSource");
	if (costSource !== "provider" && costSource !== "table") fail("costSource", 'must be "provider" or "table"');

	const priceTableRaw = obj.priceTable;
	if (typeof priceTableRaw !== "object" || priceTableRaw === null || Array.isArray(priceTableRaw)) {
		fail("priceTable", "must be an object (use {} when there's nothing to price)");
	}
	const priceTable: Partial<Record<string, AiModelPrice>> = {};
	for (const [modelId, price] of Object.entries(priceTableRaw as Record<string, unknown>)) {
		if (typeof price !== "object" || price === null || Array.isArray(price)) fail("priceTable", `entry "${modelId}" must be an object`);
		const p = price as Record<string, unknown>;
		if (typeof p.priceInPerMillion !== "number") fail("priceTable", `entry "${modelId}".priceInPerMillion must be a number`);
		if (typeof p.priceOutPerMillion !== "number") fail("priceTable", `entry "${modelId}".priceOutPerMillion must be a number`);
		priceTable[modelId] = { priceInPerMillion: p.priceInPerMillion, priceOutPerMillion: p.priceOutPerMillion };
	}
	// costSource "table" with an empty priceTable would silently price every
	// attempt as null forever — the same practical trap as not having a table
	// at all, so it's rejected the same way (see priceTable's own doc comment).
	if (costSource === "table" && Object.keys(priceTable).length === 0) {
		fail("priceTable", 'must have at least one entry when costSource is "table"');
	}

	const inputOverheadRaw = obj.inputOverhead;
	if (typeof inputOverheadRaw !== "number" || !Number.isFinite(inputOverheadRaw) || inputOverheadRaw < 0) {
		fail("inputOverhead", "must be a number >= 0");
	}

	const balanceSource = requireString("balanceSource");
	if (balanceSource !== "api" && balanceSource !== "manual") fail("balanceSource", 'must be "api" or "manual"');

	const unitRateRaw = obj.unitRate;
	if (typeof unitRateRaw !== "number" || !Number.isFinite(unitRateRaw) || unitRateRaw <= 0) {
		fail("unitRate", "must be a positive number");
	}

	return {
		name,
		baseUrl,
		authStyle,
		apiKeyVar,
		extraHeaders,
		primaryModel,
		fallbackModel,
		costSource,
		priceTable,
		inputOverhead: inputOverheadRaw,
		balanceSource,
		unitRate: unitRateRaw,
	};
}

/** Empty/unset AI_PROVIDERS_FILE resolves to the committed default; a set-but-empty-after-trim value is treated the same as unset (whitespace in an env var is never a real path). `custom` distinguishes the two for error messages — a typo in an operator's own AI_PROVIDERS_FILE reads differently from a broken commit to config/providers.json. */
function resolveProvidersFilePath(): { filePath: string; custom: boolean } {
	const override = process.env.AI_PROVIDERS_FILE?.trim();
	return override ? { filePath: override, custom: true } : { filePath: DEFAULT_PROVIDERS_FILE, custom: false };
}

/**
 * Reads and validates the whole catalog fresh on every call — no caching, no
 * eager load at import time. The catalog is a small local file and this is
 * called at most a handful of times per process run (once in index.ts, once
 * in tools/ai-compare.ts), so re-reading it costs nothing measurable, and
 * "no cached state" means a test can set AI_PROVIDERS_FILE and call
 * resolveProviderProfile()/listProviderNames() directly, no module-reset
 * tricks required. Never falls back to the built-in catalog when
 * AI_PROVIDERS_FILE is set but broken — per spec, a silent fallback to a
 * different provider's catalog is worse than refusing to start.
 */
function loadCatalog(): Readonly<Record<string, AiProviderProfile>> {
	const { filePath, custom } = resolveProvidersFilePath();
	const resolvedPath = path.resolve(filePath);
	const source = custom ? ` (from AI_PROVIDERS_FILE)` : "";

	let raw: string;
	try {
		raw = readFileSync(resolvedPath, "utf8");
	} catch (err) {
		throw new Error(`providers catalog: cannot read ${resolvedPath}${source}: ${err instanceof Error ? err.message : String(err)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`providers catalog: ${resolvedPath}${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`providers catalog: ${resolvedPath}${source} must be a JSON object keyed by provider name`);
	}

	const catalog: Record<string, AiProviderProfile> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		try {
			catalog[key] = validateProviderProfile(key, value);
		} catch (err) {
			// Re-thrown with the file path appended — validateProviderProfile's
			// own message already names the provider and field (it's also
			// called directly by tests against ad-hoc objects with no file
			// involved, so it can't know the path itself).
			throw new Error(`${err instanceof Error ? err.message : String(err)} (in ${resolvedPath}${source})`);
		}
	}
	if (Object.keys(catalog).length === 0) {
		throw new Error(`providers catalog: ${resolvedPath}${source} has no providers defined`);
	}
	return catalog;
}

export function listProviderNames(): string[] {
	return Object.keys(loadCatalog());
}

/** Empty/undefined resolves to DEFAULT_PROVIDER_NAME; any other unrecognized name throws — a typo in AI_PROVIDER must fail loudly at startup, not silently fall back to some default provider and spend against the wrong account. */
export function resolveProviderProfile(providerName: string | undefined): AiProviderProfile {
	const name = providerName || DEFAULT_PROVIDER_NAME;
	const catalog = loadCatalog();
	const profile = catalog[name];
	if (!profile) {
		throw new Error(`unknown AI_PROVIDER: "${name}" — expected one of: ${Object.keys(catalog).join(", ")}`);
	}
	return profile;
}

/**
 * A single attempt's cost in USD — the one function that actually reads
 * costSource/priceTable/inputOverhead/unitRate, so every caller (generate.ts,
 * tools/ai-compare.ts) prices an attempt identically regardless of which one
 * asked, and the provider's native billing unit (if not already USD) is
 * converted exactly once, here, never again downstream. `rawUsage` is the
 * provider's own usage object exactly as received (AiGenerateResult.rawUsage
 * from client.ts) — read here, not by widening client.ts's own typed AiUsage,
 * since "provider" cost is a src/ai/providers.ts concern, not a transport
 * one; a "table" cost source never looks at it at all.
 */
export function computeAttemptCost(profile: AiProviderProfile, modelId: string, usage: { promptTokens: number; completionTokens: number } | null, rawUsage: unknown): number | null {
	if (profile.costSource === "provider") {
		if (!rawUsage || typeof rawUsage !== "object" || !("cost" in rawUsage)) return null;
		const cost = (rawUsage as Record<string, unknown>).cost;
		return typeof cost === "number" ? cost * profile.unitRate : null;
	}

	// costSource === "table"
	if (!usage) return null;
	const price = profile.priceTable[modelId];
	if (!price) return null;
	const billedTokensIn = Math.max(0, usage.promptTokens - profile.inputOverhead);
	const nativeCost = (billedTokensIn / 1_000_000) * price.priceInPerMillion + (usage.completionTokens / 1_000_000) * price.priceOutPerMillion;
	return nativeCost * profile.unitRate;
}
