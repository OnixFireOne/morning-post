// Step 5 (second half) of the 26.08 provider migration: ai:compare-only,
// never called from the production path (see fetchModelPermaslug's own
// comment in tools/ai-compare.ts). No real network call anywhere in this
// file — fetchImpl is always a canned in-memory function.
//
// 2026-09-01: fetchModelPermaslug used to collapse every failure mode (non-
// 2xx, network error, malformed body) into a bare `null`, shown in the
// report header as an undifferentiated "н/д (запрос не удался)" — no way to
// tell an expired/under-scoped key apart from a transient miss. It now
// returns a PermaslugLookupResult carrying the specific reason instead.
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/ai/client.js";
import { fetchModelPermaslug } from "../tools/ai-compare.js";

describe("fetchModelPermaslug: GET .../generation?id=<id>, OpenRouter-specific model_permaslug lookup", () => {
	it("returns { ok: true, permaslug } on a successful lookup, hitting the right URL with Bearer auth", async () => {
		const fetchImpl: FetchLike = async (url, init) => {
			expect(url).toBe("https://openrouter.ai/api/v1/generation?id=gen-abc123");
			expect(init.method).toBe("GET");
			expect(init.headers.Authorization).toBe("Bearer sk-or-v1-test");
			return { ok: true, status: 200, json: async () => ({ data: { model_permaslug: "anthropic/claude-sonnet-4.5-20250929" } }) };
		};
		const result = await fetchModelPermaslug("https://openrouter.ai/api/v1", "sk-or-v1-test", "gen-abc123", fetchImpl);
		expect(result).toEqual({ ok: true, permaslug: "anthropic/claude-sonnet-4.5-20250929" });
	});

	it("URL-encodes the generation id", async () => {
		const fetchImpl: FetchLike = async (url) => {
			expect(url).toContain("id=gen-with%20space");
			return { ok: true, status: 200, json: async () => ({ data: { model_permaslug: "x" } }) };
		};
		await fetchModelPermaslug("https://openrouter.ai/api/v1", "key", "gen-with space", fetchImpl);
	});

	it("never throws on a non-2xx response — reason names the HTTP status", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: false, status: 404, json: async () => ({}) });
		const result = await fetchModelPermaslug("https://openrouter.ai/api/v1", "key", "gen-missing", fetchImpl);
		expect(result).toEqual({ ok: false, reason: "HTTP 404" });
	});

	it("a non-2xx response with an error body — reason includes the provider's own error message (e.g. an under-scoped/expired key)", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "Invalid API key" } }) });
		const result = await fetchModelPermaslug("https://openrouter.ai/api/v1", "key", "gen-x", fetchImpl);
		expect(result).toEqual({ ok: false, reason: "HTTP 401: Invalid API key" });
	});

	it("never throws when the response body doesn't have the expected shape", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}) });
		const result = await fetchModelPermaslug("https://openrouter.ai/api/v1", "key", "gen-x", fetchImpl);
		expect(result).toEqual({ ok: false, reason: "ответ без model_permaslug" });
	});

	it("never throws on a network error — reason includes the exception message", async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error("network down");
		};
		const result = await fetchModelPermaslug("https://openrouter.ai/api/v1", "key", "gen-x", fetchImpl);
		expect(result).toEqual({ ok: false, reason: "сетевая ошибка: network down" });
	});

	it("strips a trailing slash from baseUrl before appending the path", async () => {
		const fetchImpl: FetchLike = async (url) => {
			expect(url).toBe("https://openrouter.ai/api/v1/generation?id=gen-x");
			return { ok: true, status: 200, json: async () => ({ data: { model_permaslug: "x" } }) };
		};
		await fetchModelPermaslug("https://openrouter.ai/api/v1/", "key", "gen-x", fetchImpl);
	});
});
