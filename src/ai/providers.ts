// One object per AI provider — the *only* place a provider's name, base URL,
// auth style, default models, or a pricing number may appear in src/. Every
// other module receives this data through an AiProviderProfile value, never a
// literal "openrouter"/"anthropic" string or a hardcoded price — enforced by
// tests/ai-providers-leak.test.ts, which scans the rest of src/ for exactly
// those two things and fails the build if either leaks out. Selected by
// AI_PROVIDER (src/index.ts's readEnv()); AI_BASE_URL/AI_MODEL/
// AI_MODEL_FALLBACK, when set in .env, still override a profile's own
// defaults for exactly that field — the profile fills gaps, it doesn't force
// a value nobody asked to change.
//
// The dollar is the only unit anywhere in this project — see
// src/ai/usageReport.ts's own CURRENCY_SYMBOL comment. A provider's own
// billing unit (if it isn't already USD) is converted to USD by `unitRate`
// below, inside computeAttemptCost() and nowhere else; nothing past that
// function ever sees or needs to know the provider's native unit existed.
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
	/** Static headers merged into every request — provider-specific extras (e.g. OpenRouter's optional ranking attribution), never a secret (the API key itself is never a header value here; see authStyle). */
	extraHeaders: Record<string, string>;
	primaryModel: string;
	fallbackModel: string;
	costSource: AiCostSource;
	/** Only consulted when costSource is "table" — a "provider" cost source reads usage.cost straight from the response and never looks at this at all. Keyed by model id, in the provider's own native unit (before unitRate). */
	priceTable: Partial<Record<string, AiModelPrice>>;
	/**
	 * Subtracted from tokensIn before a "table" cost calc only — a "provider"
	 * cost is the real bill already, there is nothing left to correct. Default
	 * 0 (a no-op) for both profiles below. Deliberately not overridable from
	 * .env: an external knob for "correct for someone else's undocumented
	 * billing" is exactly how the old per-proxy PROXY_INPUT_TOKEN_OVERHEAD=2539
	 * constant happened in the first place (see git history) — if a provider's
	 * real billing needs this, it belongs here, reasoned about and comment-
	 * documented per profile, not tweaked blind from an env var.
	 */
	inputOverhead: number;
	balanceSource: AiBalanceSource;
	/** How many USD one unit of priceTable/usage.cost is worth — 1 for both current profiles (both already bill in USD). The one place this ever gets multiplied in is computeAttemptCost() below; everything downstream of it (usage.jsonl, *.ai.json, every report) only ever sees the resulting dollar figure. */
	unitRate: number;
};

const OPENROUTER: AiProviderProfile = {
	name: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	authStyle: "bearer",
	extraHeaders: {
		// Both optional, OpenRouter-specific, and purely cosmetic — identify
		// this app on openrouter.ai/rankings, no effect on billing, routing, or
		// response shape. Harmless to leave in even against a provider that
		// ignores unknown headers.
		"HTTP-Referer": "https://github.com/morning-post",
		"X-Title": "morning-post",
	},
	// Confirmed live against a real GET /models call (26.08) — vendor/model
	// slugs, unlike the old proxy's bare "claude-sonnet-4-7".
	primaryModel: "anthropic/claude-sonnet-5",
	fallbackModel: "anthropic/claude-opus-5",
	costSource: "provider",
	priceTable: {},
	inputOverhead: 0,
	balanceSource: "api",
	unitRate: 1,
};

/**
 * Direct-to-Anthropic-shaped profile (an OpenAI-compatible gateway serving
 * Claude models, same as this project's own pre-migration proxy) — no
 * response-level cost field to trust, so cost comes from `priceTable`
 * instead. Prices below are this project's own pre-migration $/1M-token
 * figures (see the 25.08 obkatka session and plan/ai-start-integration.md
 * section 3.2 for how they were derived) for the same two fictional model
 * ids this app has used all along — carried forward unchanged in USD; only
 * the old overhead-calibration *display* machinery around them (raw vs.
 * calibrated balance) is what this migration removes, not the numbers
 * themselves.
 */
const ANTHROPIC: AiProviderProfile = {
	name: "anthropic",
	baseUrl: "https://api.anthropic.com/v1",
	authStyle: "x-api-key",
	extraHeaders: {},
	primaryModel: "claude-sonnet-4-7",
	fallbackModel: "claude-opus-5",
	costSource: "table",
	priceTable: {
		"claude-sonnet-4-7": { priceInPerMillion: 14, priceOutPerMillion: 42 },
		"claude-opus-5": { priceInPerMillion: 20, priceOutPerMillion: 60 },
	},
	inputOverhead: 0,
	balanceSource: "manual",
	unitRate: 1,
};

const PROFILES: Readonly<Record<string, AiProviderProfile>> = {
	openrouter: OPENROUTER,
	anthropic: ANTHROPIC,
};

export const DEFAULT_PROVIDER_NAME = "openrouter";

export function listProviderNames(): string[] {
	return Object.keys(PROFILES);
}

/** Empty/undefined resolves to DEFAULT_PROVIDER_NAME; any other unrecognized name throws — a typo in AI_PROVIDER must fail loudly at startup, not silently fall back to some default provider and spend against the wrong account. */
export function resolveProviderProfile(providerName: string | undefined): AiProviderProfile {
	const name = providerName || DEFAULT_PROVIDER_NAME;
	const profile = PROFILES[name];
	if (!profile) {
		throw new Error(`unknown AI_PROVIDER: "${name}" — expected one of: ${listProviderNames().join(", ")}`);
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
