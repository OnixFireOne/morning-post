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

	it("returns the aiprime.messages profile by name, with costSource table, balance manual, and protocol messages", () => {
		const profile = resolveProviderProfile("aiprime.messages");
		expect(profile.name).toBe("aiprime.messages");
		expect(profile.costSource).toBe("table");
		expect(profile.balanceSource).toBe("manual");
		expect(profile.authStyle).toBe("x-api-key");
		expect(Object.keys(profile.priceTable).length).toBeGreaterThan(0);
		expect(profile.protocol).toBe("messages");
		expect(profile.maxTokens).toBeGreaterThan(0);
	});

	it("returns the aiprime.chat_completions profile — same endpoint/key, costSource none (that path doesn't report input tokens, see plan §6.1)", () => {
		const profile = resolveProviderProfile("aiprime.chat_completions");
		expect(profile.name).toBe("aiprime.chat_completions");
		expect(profile.protocol).toBe("chat_completions");
		expect(profile.costSource).toBe("none");
		expect(profile.priceTable).toEqual({});
		expect(profile.baseUrl).toBe(resolveProviderProfile("aiprime.messages").baseUrl);
		expect(profile.apiKeyVar).toBe(resolveProviderProfile("aiprime.messages").apiKeyVar);
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
		expect(() => resolveProviderProfile(undefined)).toThrow(/aiprime\.messages/);
	});

	it("throws loudly on an unrecognized AI_PROVIDER, listing the valid names — a typo must never silently fall back to the wrong account", () => {
		expect(() => resolveProviderProfile("openai")).toThrow(/unknown AI_PROVIDER/);
		expect(() => resolveProviderProfile("openai")).toThrow(/openrouter/);
		expect(() => resolveProviderProfile("openai")).toThrow(/aiprime\.messages/);
	});

	it("listProviderNames names exactly the three current profiles", () => {
		expect(listProviderNames().sort()).toEqual(["aiprime.chat_completions", "aiprime.messages", "openrouter"]);
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
	// aiprime.messages's own committed priceTable — real numbers from the
	// 04.09.2026 ai:probe run, reconciled against the proxy's own dashboard
	// to the cent (plan/ai-providering.md §6): 1315 in + 32 out on
	// claude-sonnet-5 billed $0.00295; 1328 in + 22 out on claude-opus-5
	// billed $0.00719. Used here as-is, not a synthetic stand-in.
	const aiprime = resolveProviderProfile("aiprime.messages");

	it("prices the primary model from the table — the real probed figure", () => {
		// (1315/1e6)*2 + (32/1e6)*10 = 0.00263 + 0.00032 = 0.00295
		const cost = computeAttemptCost(aiprime, "claude-sonnet-5", { promptTokens: 1315, completionTokens: 32 }, null);
		expect(cost).toBeCloseTo(0.00295, 6);
	});

	it("prices the fallback model at its own rate, not the primary's — the real probed figure", () => {
		// (1328/1e6)*5 + (22/1e6)*25 = 0.00664 + 0.00055 = 0.00719
		const cost = computeAttemptCost(aiprime, "claude-opus-5", { promptTokens: 1328, completionTokens: 22 }, null);
		expect(cost).toBeCloseTo(0.00719, 6);
	});

	it("returns null when the answering model has no entry in the price table", () => {
		expect(computeAttemptCost(aiprime, "some-unknown-model", { promptTokens: 100, completionTokens: 50 }, null)).toBeNull();
	});

	it("returns null when usage is null — nothing to price", () => {
		expect(computeAttemptCost(aiprime, "claude-sonnet-5", null, null)).toBeNull();
	});

	it("ignores rawUsage entirely for a 'table' costSource — even a real cost field in it is not consulted", () => {
		const cost = computeAttemptCost(aiprime, "claude-sonnet-5", { promptTokens: 1315, completionTokens: 32 }, { cost: 999 });
		expect(cost).toBeCloseTo(0.00295, 6);
	});

	it("subtracts inputOverhead from promptTokens before pricing, floored at zero — never a negative billed input", () => {
		const withOverhead = { ...aiprime, inputOverhead: 1000 };
		// billed input = max(0, 1315 - 1000) = 315; (315/1e6)*2 + (32/1e6)*10 = 0.00063 + 0.00032 = 0.00095
		const cost = computeAttemptCost(withOverhead, "claude-sonnet-5", { promptTokens: 1315, completionTokens: 32 }, null);
		expect(cost).toBeCloseTo(0.00095, 6);

		// overhead exceeding tokensIn floors at 0, not negative
		const tinyRequest = computeAttemptCost(withOverhead, "claude-sonnet-5", { promptTokens: 500, completionTokens: 32 }, null);
		expect(tinyRequest).toBeCloseTo((0 / 1_000_000) * 2 + (32 / 1_000_000) * 10, 6);
		expect(tinyRequest).toBeGreaterThanOrEqual(0);
	});

	it("with the default inputOverhead of 0, pricing is unaffected — a no-op correction (plan §6.1 fact 4: the proxy's own ~1300-token overhead is never re-subtracted here)", () => {
		expect(aiprime.inputOverhead).toBe(0);
		const cost = computeAttemptCost(aiprime, "claude-sonnet-5", { promptTokens: 1315, completionTokens: 32 }, null);
		expect(cost).toBeCloseTo(0.00295, 6);
	});
});

describe("resolveProviderProfile: every profile bills in USD already (unitRate 1) — no field named unitLabel exists at all", () => {
	it.each(["openrouter", "aiprime.messages", "aiprime.chat_completions"])("%s.unitRate is 1, no unitLabel field", (name) => {
		const profile = resolveProviderProfile(name);
		expect(profile.unitRate).toBe(1);
		expect((profile as Record<string, unknown>).unitLabel).toBeUndefined();
	});
});

describe("computeAttemptCost: unitRate is the one and only place a provider's native unit gets converted to USD", () => {
	it("multiplies a 'provider' cost source's usage.cost by unitRate", () => {
		const openrouter = resolveProviderProfile("openrouter");
		const halfDollarUnit = { ...openrouter, unitRate: 0.5 }; // e.g. a provider billing in 2x-dollar credits
		const cost = computeAttemptCost(halfDollarUnit, "anthropic/claude-sonnet-5", { promptTokens: 100, completionTokens: 50 }, { cost: 10 });
		expect(cost).toBe(5); // 10 native units * 0.5 USD/unit
	});

	it("multiplies a 'table' cost source's computed price by unitRate — aiprime.messages's own real priceTable", () => {
		const doubleUnit = { ...resolveProviderProfile("aiprime.messages"), unitRate: 2 };
		// native cost (1315/1e6)*2 + (32/1e6)*10 = 0.00295; * 2 = 0.0059
		const cost = computeAttemptCost(doubleUnit, "claude-sonnet-5", { promptTokens: 1315, completionTokens: 32 }, null);
		expect(cost).toBeCloseTo(0.0059, 6);
	});

	it("a unitRate of 1 (every current profile) leaves the native figure unchanged", () => {
		const openrouter = resolveProviderProfile("openrouter");
		expect(computeAttemptCost(openrouter, "m", { promptTokens: 1, completionTokens: 1 }, { cost: 0.0957 })).toBe(0.0957);
	});
});
