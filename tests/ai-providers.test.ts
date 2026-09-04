import { describe, expect, it } from "vitest";
import { computeAttemptCost, listProviderNames, resolveProviderProfile } from "../src/ai/providers.js";

describe("resolveProviderProfile", () => {
	it("returns the openrouter profile by name, with costSource provider and balance api", () => {
		const profile = resolveProviderProfile("openrouter");
		expect(profile.name).toBe("openrouter");
		expect(profile.costSource).toBe("provider");
		expect(profile.balanceSource).toBe("api");
		expect(profile.authStyle).toBe("bearer");
		expect(profile.baseUrl).toBe("https://openrouter.ai/api/v1");
		// No protocol field in the committed JSON — defaults to "chat_completions".
		expect(profile.protocol).toBe("chat_completions");
	});

	it("returns the anthropic profile by name, with costSource table, balance manual, and protocol messages", () => {
		const profile = resolveProviderProfile("anthropic");
		expect(profile.name).toBe("anthropic");
		expect(profile.costSource).toBe("table");
		expect(profile.balanceSource).toBe("manual");
		expect(profile.authStyle).toBe("x-api-key");
		expect(Object.keys(profile.priceTable).length).toBeGreaterThan(0);
		expect(profile.protocol).toBe("messages");
		expect(profile.maxTokens).toBeGreaterThan(0);
	});

	// 02.09: this header is what makes openrouter_metadata show up in the
	// response at all (client.ts's OpenAiChatCompletion) — the primary path
	// for resolving which exact model/provider answered, replacing the old
	// post-hoc GET /api/v1/generation?id=<id> lookup.
	it("openrouter profile sends X-OpenRouter-Metadata: enabled on every request", () => {
		expect(resolveProviderProfile("openrouter").extraHeaders["X-OpenRouter-Metadata"]).toBe("enabled");
	});

	it("throws when AI_PROVIDER is empty/undefined, listing the catalog's own keys — no silent default provider", () => {
		expect(() => resolveProviderProfile(undefined)).toThrow(/AI_PROVIDER is required/);
		expect(() => resolveProviderProfile("")).toThrow(/AI_PROVIDER is required/);
		expect(() => resolveProviderProfile("  ")).toThrow(/AI_PROVIDER is required/);
		expect(() => resolveProviderProfile(undefined)).toThrow(/openrouter/);
		expect(() => resolveProviderProfile(undefined)).toThrow(/anthropic/);
	});

	it("throws loudly on an unrecognized AI_PROVIDER, listing the valid names — a typo must never silently fall back to the wrong account", () => {
		expect(() => resolveProviderProfile("openai")).toThrow(/unknown AI_PROVIDER/);
		expect(() => resolveProviderProfile("openai")).toThrow(/openrouter/);
		expect(() => resolveProviderProfile("openai")).toThrow(/anthropic/);
	});

	it("listProviderNames names exactly the two current profiles", () => {
		expect(listProviderNames().sort()).toEqual(["anthropic", "openrouter"]);
	});
});

describe("computeAttemptCost: costSource 'provider' reads usage.cost from the response verbatim", () => {
	const openrouter = resolveProviderProfile("openrouter");

	it("returns the response's own usage.cost as-is, no arithmetic at all", () => {
		const cost = computeAttemptCost(openrouter, "anthropic/claude-sonnet-5", { promptTokens: 6158, completionTokens: 226 }, { prompt_tokens: 6158, completion_tokens: 226, cost: 0.09570400000000001 });
		expect(cost).toBe(0.09570400000000001);
	});

	it("ignores inputOverhead entirely — a 'provider' cost is the real bill already, nothing left to correct", () => {
		const withOverhead = { ...openrouter, inputOverhead: 2539 };
		const cost = computeAttemptCost(withOverhead, "anthropic/claude-sonnet-5", { promptTokens: 6158, completionTokens: 226 }, { cost: 0.0957 });
		expect(cost).toBe(0.0957);
	});

	it("returns null when the response has no cost field at all", () => {
		const cost = computeAttemptCost(openrouter, "anthropic/claude-sonnet-5", { promptTokens: 100, completionTokens: 50 }, { prompt_tokens: 100, completion_tokens: 50 });
		expect(cost).toBeNull();
	});

	it("returns null when rawUsage isn't an object at all (null, or a transport failure's rawUsage)", () => {
		expect(computeAttemptCost(openrouter, "m", null, null)).toBeNull();
		expect(computeAttemptCost(openrouter, "m", null, undefined)).toBeNull();
	});

	it("returns null when cost is present but not a number", () => {
		const cost = computeAttemptCost(openrouter, "m", { promptTokens: 1, completionTokens: 1 }, { cost: "0.05" });
		expect(cost).toBeNull();
	});
});

describe("computeAttemptCost: costSource 'table' computes from priceTable, corrected by inputOverhead", () => {
	// anthropic's own committed primaryModel/fallbackModel/priceTable are
	// TODO(unverified) placeholders as of this migration (plan/
	// ai-providering.md §6 — real ids/prices need a live npm run ai:probe, not
	// a guess) — this profile keeps the real "table" shape (costSource,
	// inputOverhead, unitRate) but swaps in known test model ids/prices, so
	// the arithmetic below stays pinned to real, checkable numbers regardless
	// of what the catalog's own placeholders happen to say.
	const anthropicShaped = resolveProviderProfile("anthropic");
	const anthropic = { ...anthropicShaped, primaryModel: "model-a", fallbackModel: "model-b", priceTable: { "model-a": { priceInPerMillion: 14, priceOutPerMillion: 42 }, "model-b": { priceInPerMillion: 20, priceOutPerMillion: 60 } } };

	it("prices a known model from the table", () => {
		// (3081/1e6)*14 + (287/1e6)*42 = 0.043134 + 0.012054 = 0.055188
		const cost = computeAttemptCost(anthropic, "model-a", { promptTokens: 3081, completionTokens: 287 }, null);
		expect(cost).toBeCloseTo(0.055188, 6);
	});

	it("prices the fallback model at its own rate, not the primary's", () => {
		// (100/1e6)*20 + (50/1e6)*60 = 0.002 + 0.003 = 0.005
		const cost = computeAttemptCost(anthropic, "model-b", { promptTokens: 100, completionTokens: 50 }, null);
		expect(cost).toBeCloseTo(0.005, 6);
	});

	it("returns null when the answering model has no entry in the price table", () => {
		expect(computeAttemptCost(anthropic, "some-unknown-model", { promptTokens: 100, completionTokens: 50 }, null)).toBeNull();
	});

	it("returns null when usage is null — nothing to price", () => {
		expect(computeAttemptCost(anthropic, "model-a", null, null)).toBeNull();
	});

	it("ignores rawUsage entirely for a 'table' costSource — even a real cost field in it is not consulted", () => {
		const cost = computeAttemptCost(anthropic, "model-a", { promptTokens: 3081, completionTokens: 287 }, { cost: 999 });
		expect(cost).toBeCloseTo(0.055188, 6);
	});

	it("subtracts inputOverhead from promptTokens before pricing, floored at zero — never a negative billed input", () => {
		const withOverhead = { ...anthropic, inputOverhead: 2539 };
		// billed input = max(0, 3081 - 2539) = 542; (542/1e6)*14 + (287/1e6)*42 = 0.007588 + 0.012054 = 0.019642
		const cost = computeAttemptCost(withOverhead, "model-a", { promptTokens: 3081, completionTokens: 287 }, null);
		expect(cost).toBeCloseTo(0.019642, 6);

		// overhead exceeding tokensIn floors at 0, not negative
		const tinyRequest = computeAttemptCost(withOverhead, "model-a", { promptTokens: 1000, completionTokens: 50 }, null);
		expect(tinyRequest).toBeCloseTo((0 / 1_000_000) * 14 + (50 / 1_000_000) * 42, 6);
		expect(tinyRequest).toBeGreaterThanOrEqual(0);
	});

	it("with the default inputOverhead of 0, pricing is unaffected — a no-op correction", () => {
		expect(anthropicShaped.inputOverhead).toBe(0);
		const cost = computeAttemptCost(anthropic, "model-a", { promptTokens: 3081, completionTokens: 287 }, null);
		expect(cost).toBeCloseTo(0.055188, 6);
	});
});

describe("resolveProviderProfile: both current profiles bill in USD already (unitRate 1) — no field named unitLabel exists at all", () => {
	it("openrouter.unitRate and anthropic.unitRate are both 1", () => {
		expect(resolveProviderProfile("openrouter").unitRate).toBe(1);
		expect(resolveProviderProfile("anthropic").unitRate).toBe(1);
	});

	it("no AiProviderProfile carries a unitLabel field — that concept was replaced by unitRate (a conversion factor) plus usageReport.ts's own CURRENCY_SYMBOL", () => {
		expect((resolveProviderProfile("openrouter") as Record<string, unknown>).unitLabel).toBeUndefined();
		expect((resolveProviderProfile("anthropic") as Record<string, unknown>).unitLabel).toBeUndefined();
	});
});

describe("computeAttemptCost: unitRate is the one and only place a provider's native unit gets converted to USD", () => {
	it("multiplies a 'provider' cost source's usage.cost by unitRate", () => {
		const openrouter = resolveProviderProfile("openrouter");
		const halfDollarUnit = { ...openrouter, unitRate: 0.5 }; // e.g. a provider billing in 2x-dollar credits
		const cost = computeAttemptCost(halfDollarUnit, "anthropic/claude-sonnet-5", { promptTokens: 100, completionTokens: 50 }, { cost: 10 });
		expect(cost).toBe(5); // 10 native units * 0.5 USD/unit
	});

	it("multiplies a 'table' cost source's computed price by unitRate", () => {
		// Same test-model-id substitution as the "table" describe block above —
		// anthropic's own committed priceTable is a TODO(unverified) placeholder.
		const anthropic = { ...resolveProviderProfile("anthropic"), primaryModel: "model-a", priceTable: { "model-a": { priceInPerMillion: 14, priceOutPerMillion: 42 } } };
		const doubleUnit = { ...anthropic, unitRate: 2 };
		// native cost (3081/1e6)*14 + (287/1e6)*42 = 0.055188; * 2 = 0.110376
		const cost = computeAttemptCost(doubleUnit, "model-a", { promptTokens: 3081, completionTokens: 287 }, null);
		expect(cost).toBeCloseTo(0.110376, 6);
	});

	it("a unitRate of 1 (both current profiles) leaves the native figure unchanged", () => {
		const openrouter = resolveProviderProfile("openrouter");
		expect(computeAttemptCost(openrouter, "m", { promptTokens: 1, completionTokens: 1 }, { cost: 0.0957 })).toBe(0.0957);
	});
});
