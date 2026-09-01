import { describe, expect, it } from "vitest";
import { computeAttemptCost, DEFAULT_PROVIDER_NAME, listProviderNames, resolveProviderProfile } from "../src/ai/providers.js";

describe("resolveProviderProfile", () => {
	it("returns the openrouter profile by name, with costSource provider and balance api", () => {
		const profile = resolveProviderProfile("openrouter");
		expect(profile.name).toBe("openrouter");
		expect(profile.costSource).toBe("provider");
		expect(profile.balanceSource).toBe("api");
		expect(profile.authStyle).toBe("bearer");
		expect(profile.baseUrl).toBe("https://openrouter.ai/api/v1");
	});

	it("returns the anthropic profile by name, with costSource table and balance manual", () => {
		const profile = resolveProviderProfile("anthropic");
		expect(profile.name).toBe("anthropic");
		expect(profile.costSource).toBe("table");
		expect(profile.balanceSource).toBe("manual");
		expect(profile.authStyle).toBe("x-api-key");
		expect(Object.keys(profile.priceTable).length).toBeGreaterThan(0);
	});

	it("falls back to DEFAULT_PROVIDER_NAME when the name is empty/undefined", () => {
		expect(resolveProviderProfile(undefined).name).toBe(DEFAULT_PROVIDER_NAME);
		expect(resolveProviderProfile("").name).toBe(DEFAULT_PROVIDER_NAME);
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
	const anthropic = resolveProviderProfile("anthropic");

	it("prices a known model from the table — the real 25.08 numbers, verified against the panel to the 4th decimal", () => {
		// (3081/1e6)*14 + (287/1e6)*42 = 0.043134 + 0.012054 = 0.055188
		const cost = computeAttemptCost(anthropic, "claude-sonnet-4-7", { promptTokens: 3081, completionTokens: 287 }, null);
		expect(cost).toBeCloseTo(0.055188, 6);
	});

	it("prices the fallback model at its own rate, not the primary's", () => {
		// (100/1e6)*20 + (50/1e6)*60 = 0.002 + 0.003 = 0.005
		const cost = computeAttemptCost(anthropic, "claude-opus-5", { promptTokens: 100, completionTokens: 50 }, null);
		expect(cost).toBeCloseTo(0.005, 6);
	});

	it("returns null when the answering model has no entry in the price table", () => {
		expect(computeAttemptCost(anthropic, "some-unknown-model", { promptTokens: 100, completionTokens: 50 }, null)).toBeNull();
	});

	it("returns null when usage is null — nothing to price", () => {
		expect(computeAttemptCost(anthropic, "claude-sonnet-4-7", null, null)).toBeNull();
	});

	it("ignores rawUsage entirely for a 'table' costSource — even a real cost field in it is not consulted", () => {
		const cost = computeAttemptCost(anthropic, "claude-sonnet-4-7", { promptTokens: 3081, completionTokens: 287 }, { cost: 999 });
		expect(cost).toBeCloseTo(0.055188, 6);
	});

	it("subtracts inputOverhead from promptTokens before pricing, floored at zero — never a negative billed input", () => {
		const withOverhead = { ...anthropic, inputOverhead: 2539 };
		// billed input = max(0, 3081 - 2539) = 542; (542/1e6)*14 + (287/1e6)*42 = 0.007588 + 0.012054 = 0.019642
		const cost = computeAttemptCost(withOverhead, "claude-sonnet-4-7", { promptTokens: 3081, completionTokens: 287 }, null);
		expect(cost).toBeCloseTo(0.019642, 6);

		// overhead exceeding tokensIn floors at 0, not negative
		const tinyRequest = computeAttemptCost(withOverhead, "claude-sonnet-4-7", { promptTokens: 1000, completionTokens: 50 }, null);
		expect(tinyRequest).toBeCloseTo((0 / 1_000_000) * 14 + (50 / 1_000_000) * 42, 6);
		expect(tinyRequest).toBeGreaterThanOrEqual(0);
	});

	it("with the default inputOverhead of 0, pricing is unaffected — a no-op correction", () => {
		expect(anthropic.inputOverhead).toBe(0);
		const cost = computeAttemptCost(anthropic, "claude-sonnet-4-7", { promptTokens: 3081, completionTokens: 287 }, null);
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
		const anthropic = resolveProviderProfile("anthropic");
		const doubleUnit = { ...anthropic, unitRate: 2 };
		// native cost (3081/1e6)*14 + (287/1e6)*42 = 0.055188; * 2 = 0.110376
		const cost = computeAttemptCost(doubleUnit, "claude-sonnet-4-7", { promptTokens: 3081, completionTokens: 287 }, null);
		expect(cost).toBeCloseTo(0.110376, 6);
	});

	it("a unitRate of 1 (both current profiles) leaves the native figure unchanged", () => {
		const openrouter = resolveProviderProfile("openrouter");
		expect(computeAttemptCost(openrouter, "m", { promptTokens: 1, completionTokens: 1 }, { cost: 0.0957 })).toBe(0.0957);
	});
});
