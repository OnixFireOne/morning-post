// 02.09: replaces tests/ai-compare-permaslug.test.ts — the old
// GET /api/v1/generation?id=<id> lookup (with a 404-retry-after-pause added
// the same day) is gone entirely. A live rerun still 404'd on every lookup
// even with the retry: OpenRouter's own docs say 404 there means "not
// found", not "not ready yet", so the eventual-consistency hypothesis behind
// the retry was wrong. Replaced with three fallback tiers that never need a
// generation id at all — see tools/ai-compare.ts's resolveModelIdentity for
// the full story. No real network call anywhere in this file — fetchImpl is
// always a canned in-memory function.
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../src/ai/client.js";
import {
	fetchCanonicalModelSlug,
	formatModelIdentityLine,
	resolveModelIdentity,
	type ModelIdentityResult,
	type ModelIdentitySource,
} from "../tools/ai-compare.js";

describe("fetchCanonicalModelSlug: GET /api/v1/models/{slug} — tier 2's own lookup", () => {
	it("returns { ok: true, slug } on a successful lookup, hitting the right URL with Bearer auth", async () => {
		const fetchImpl: FetchLike = async (url, init) => {
			expect(url).toBe("https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5");
			expect(init.method).toBe("GET");
			expect(init.headers.Authorization).toBe("Bearer sk-or-v1-test");
			return { ok: true, status: 200, json: async () => ({ data: { canonical_slug: "anthropic/claude-sonnet-4.5-20250929" } }) };
		};
		const result = await fetchCanonicalModelSlug("https://openrouter.ai/api/v1", "sk-or-v1-test", "anthropic/claude-sonnet-5", fetchImpl);
		expect(result).toEqual({ ok: true, slug: "anthropic/claude-sonnet-4.5-20250929" });
	});

	it("strips a trailing slash from baseUrl before appending the path", async () => {
		const fetchImpl: FetchLike = async (url) => {
			expect(url).toBe("https://openrouter.ai/api/v1/models/m");
			return { ok: true, status: 200, json: async () => ({ data: { canonical_slug: "x" } }) };
		};
		await fetchCanonicalModelSlug("https://openrouter.ai/api/v1/", "key", "m", fetchImpl);
	});

	it("never throws on a non-2xx response — reason names the HTTP status", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: false, status: 404, json: async () => ({}) });
		const result = await fetchCanonicalModelSlug("https://openrouter.ai/api/v1", "key", "missing-model", fetchImpl);
		expect(result).toEqual({ ok: false, reason: "HTTP 404" });
	});

	it("never throws when the response body doesn't have the expected shape", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}) });
		const result = await fetchCanonicalModelSlug("https://openrouter.ai/api/v1", "key", "m", fetchImpl);
		expect(result).toEqual({ ok: false, reason: "ответ без canonical_slug" });
	});

	it("never throws on a network error — reason includes the exception message", async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error("network down");
		};
		const result = await fetchCanonicalModelSlug("https://openrouter.ai/api/v1", "key", "m", fetchImpl);
		expect(result).toEqual({ ok: false, reason: "сетевая ошибка: network down" });
	});
});

function source(overrides: Partial<ModelIdentitySource> = {}): ModelIdentitySource {
	return { openrouterMetadata: null, responseModel: null, responseProvider: null, ...overrides };
}

describe("resolveModelIdentity: three tiers, never throws", () => {
	it("source === null (no real run at all) — returns null without ever calling fetchImpl", async () => {
		const fetchImpl = vi.fn<FetchLike>();
		const result = await resolveModelIdentity(null, "https://openrouter.ai/api/v1", "key", "m", fetchImpl);
		expect(result).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("tier 1: openrouter_metadata has a model — used directly, no network call at all", async () => {
		const fetchImpl = vi.fn<FetchLike>();
		const result = await resolveModelIdentity(source({ openrouterMetadata: { model: "anthropic/claude-sonnet-4.5-20250929", provider: "Anthropic" } }), "https://openrouter.ai/api/v1", "key", "m", fetchImpl);
		expect(result).toEqual({ source: "openrouter_metadata", model: "anthropic/claude-sonnet-4.5-20250929", provider: "Anthropic" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("tier 1 present but provider is null — still used, provider comes back null too", async () => {
		const result = await resolveModelIdentity(source({ openrouterMetadata: { model: "m/x", provider: null } }), "https://openrouter.ai/api/v1", "key", "m", vi.fn<FetchLike>());
		expect(result).toEqual({ source: "openrouter_metadata", model: "m/x", provider: null });
	});

	it("tier 1 absent (openrouterMetadata null) — falls to tier 2, GET /models/{slug} succeeds", async () => {
		const fetchImpl: FetchLike = async (url) => {
			expect(url).toBe("https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5");
			return { ok: true, status: 200, json: async () => ({ data: { canonical_slug: "anthropic/claude-sonnet-4.5-20250929" } }) };
		};
		const result = await resolveModelIdentity(source(), "https://openrouter.ai/api/v1", "key", "anthropic/claude-sonnet-5", fetchImpl);
		expect(result).toEqual({ source: "canonical_slug", slug: "anthropic/claude-sonnet-4.5-20250929" });
	});

	it("tier 1 present but model is null (only provider) — still falls through to tier 2, model is the usable signal", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ data: { canonical_slug: "x" } }) });
		const result = await resolveModelIdentity(source({ openrouterMetadata: { model: null, provider: "Anthropic" } }), "https://openrouter.ai/api/v1", "key", "m", fetchImpl);
		expect(result).toEqual({ source: "canonical_slug", slug: "x" });
	});

	it("tier 1 and tier 2 both fail — falls to tier 3, the response body's own plain model/provider", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: false, status: 404, json: async () => ({}) });
		const result = await resolveModelIdentity(source({ responseModel: "anthropic/claude-sonnet-5", responseProvider: "Anthropic" }), "https://openrouter.ai/api/v1", "key", "m", fetchImpl);
		expect(result).toEqual({ source: "response_body", model: "anthropic/claude-sonnet-5", provider: "Anthropic" });
	});

	it("tier 3 with nothing at all — still returns a result object, never throws or returns null for a real run", async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error("network down");
		};
		const result = await resolveModelIdentity(source(), "https://openrouter.ai/api/v1", "key", "m", fetchImpl);
		expect(result).toEqual({ source: "response_body", model: null, provider: null });
	});
});

describe("formatModelIdentityLine", () => {
	it("null (no real run) — н/д, distinct wording from a failed resolution", () => {
		expect(formatModelIdentityLine(null)).toBe("н/д (не было ни одного реального ответа)");
	});

	it("openrouter_metadata source, with provider", () => {
		const result: ModelIdentityResult = { source: "openrouter_metadata", model: "anthropic/claude-sonnet-4.5-20250929", provider: "Anthropic" };
		expect(formatModelIdentityLine(result)).toBe("anthropic/claude-sonnet-4.5-20250929 (Anthropic)");
	});

	it("openrouter_metadata source, no provider", () => {
		const result: ModelIdentityResult = { source: "openrouter_metadata", model: "anthropic/claude-sonnet-4.5-20250929", provider: null };
		expect(formatModelIdentityLine(result)).toBe("anthropic/claude-sonnet-4.5-20250929");
	});

	it("canonical_slug source names where the slug came from", () => {
		const result: ModelIdentityResult = { source: "canonical_slug", slug: "anthropic/claude-sonnet-4.5-20250929" };
		expect(formatModelIdentityLine(result)).toBe("anthropic/claude-sonnet-4.5-20250929 (canonical_slug из /models — openrouter_metadata недоступен)");
	});

	it("response_body source flags that the exact version is unavailable", () => {
		const result: ModelIdentityResult = { source: "response_body", model: "anthropic/claude-sonnet-5", provider: "Anthropic" };
		expect(formatModelIdentityLine(result)).toBe("anthropic/claude-sonnet-5 (Anthropic) — точная версия недоступна");
	});

	it("response_body source with nothing at all still produces a line, not an empty string", () => {
		const result: ModelIdentityResult = { source: "response_body", model: null, provider: null };
		expect(formatModelIdentityLine(result)).toBe("н/д — точная версия недоступна");
	});
});
