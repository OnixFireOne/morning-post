// plan/ai-providering.md §4/§9: createMessagesClient is the second transport
// behind the same AiClient contract as createChatCompletionsClient
// (tests/ai-client.test.ts) — POST {baseUrl}/messages, system as its own
// top-level field, required max_tokens, text-block concatenation instead of
// choices[0].message.content, input_tokens/output_tokens instead of
// prompt_tokens/completion_tokens.
import { describe, expect, it } from "vitest";
import { createMessagesClient, type AiMessagesClientOptions } from "../src/ai/clientMessages.js";
import type { FetchLike } from "../src/ai/client.js";

const BASE_URL = "https://api.anthropic.com/v1";

function client(fetchImpl: FetchLike, extra: Partial<AiMessagesClientOptions> = {}) {
	return createMessagesClient({ baseUrl: BASE_URL, apiKey: "test-key", maxTokens: 1024, fetchImpl, ...extra });
}

/** Shared base for every stop_reason: "max_tokens" fixture below — spread from, not copied, per plan/ai-providering.md §9's "экономия тестов" rule. */
const EMPTY_CONTENT_MAX_TOKENS_BODY: { content: { type: string; text?: string }[]; stop_reason: string } = { content: [], stop_reason: "max_tokens" };

describe("createMessagesClient: generate — request shape", () => {
	it("POSTs to {baseUrl}/messages with system as its own top-level field, max_tokens, and a single user message", async () => {
		const fetchImpl: FetchLike = async (url, init) => {
			expect(url).toBe("https://api.anthropic.com/v1/messages");
			expect(init.method).toBe("POST");
			expect(JSON.parse(init.body!)).toEqual({
				model: "m",
				max_tokens: 1024,
				system: "s",
				messages: [{ role: "user", content: "u" }],
			});
			return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "ok" }] }) };
		};
		await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
	});

	it("sends x-api-key by default (authStyle x-api-key) and Bearer when authStyle is bearer", async () => {
		const xApiKey: FetchLike = async (_url, init) => {
			expect(init.headers["x-api-key"]).toBe("test-key");
			expect(init.headers.Authorization).toBeUndefined();
			return { ok: true, status: 200, json: async () => ({ content: [] }) };
		};
		await client(xApiKey, { authStyle: "x-api-key" }).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });

		const bearer: FetchLike = async (_url, init) => {
			expect(init.headers.Authorization).toBe("Bearer test-key");
			expect(init.headers["x-api-key"]).toBeUndefined();
			return { ok: true, status: 200, json: async () => ({ content: [] }) };
		};
		await client(bearer, { authStyle: "bearer" }).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
	});

	it("sends anthropic-version when the profile sets one, omits it entirely when not", async () => {
		const withVersion: FetchLike = async (_url, init) => {
			expect(init.headers["anthropic-version"]).toBe("2023-06-01");
			return { ok: true, status: 200, json: async () => ({ content: [] }) };
		};
		await client(withVersion, { apiVersion: "2023-06-01" }).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });

		const withoutVersion: FetchLike = async (_url, init) => {
			expect(init.headers["anthropic-version"]).toBeUndefined();
			return { ok: true, status: 200, json: async () => ({ content: [] }) };
		};
		await client(withoutVersion).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
	});

	it("merges extraHeaders on top of Content-Type/auth/version", async () => {
		const fetchImpl: FetchLike = async (_url, init) => {
			expect(init.headers["Content-Type"]).toBe("application/json");
			expect(init.headers["x-api-key"]).toBe("test-key");
			expect(init.headers["X-Extra"]).toBe("yes");
			return { ok: true, status: 200, json: async () => ({ content: [] }) };
		};
		await client(fetchImpl, { extraHeaders: { "X-Extra": "yes" } }).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
	});
});

describe("createMessagesClient: generate — response parsing", () => {
	it("concatenates every text block in order, ignoring non-text blocks (thinking, tool_use, ...)", async () => {
		const fetchImpl: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				content: [
					{ type: "thinking", text: "should be skipped" },
					{ type: "text", text: "hello " },
					{ type: "tool_use", id: "x" },
					{ type: "text", text: "world" },
				],
			}),
		});
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.content).toBe("hello world");
	});

	it("an empty content array (or no text blocks at all) gives content: \"\", never null", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", id: "x" }] }) });
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.content).toBe("");
	});

	it("finishReason is stop_reason as-is, no translation to an OpenAI-style value", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ ...EMPTY_CONTENT_MAX_TOKENS_BODY }) });
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		// This particular body is also the empty_response case tested in detail
		// below (empty content + stop_reason "max_tokens") — finishReason is
		// preserved on that path too, which is exactly the point here.
		expect(result.finishReason).toBe("max_tokens");
	});

	// plan/ai-providering.md §6.1 fact 1, reproduced live against a real proxy:
	// max_tokens can be spent entirely on the provider's own internal
	// reasoning, leaving zero output text. This is the main behavior change
	// in this revision of the spec.
	it("empty content with stop_reason \"max_tokens\" is errorKind empty_response, not a valid empty answer — usage/rawUsage still preserved (the attempt was billed)", async () => {
		const fetchImpl: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ ...EMPTY_CONTENT_MAX_TOKENS_BODY, content: [{ type: "text", text: "" }], usage: { input_tokens: 1315, output_tokens: 32 } }),
		});
		const result = await client(fetchImpl, { maxTokens: 32 }).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.ok).toBe(false);
		expect(result.errorKind).toBe("empty_response");
		expect(result.content).toBeNull();
		expect(result.finishReason).toBe("max_tokens");
		// paid attempt: usage/rawUsage survive so generate.ts can still price and log it
		expect(result.usage).toEqual({ promptTokens: 1315, completionTokens: 32, totalTokens: 1347, cachedTokens: null });
		expect(result.rawUsage).toEqual({ input_tokens: 1315, output_tokens: 32 });
		expect(result.errorMessage).not.toBeNull();
		expect(result.errorMessage).not.toContain("test-key");
		expect(result.errorMessage).not.toContain(BASE_URL);
	});

	it("empty content with any other stop_reason stays content: \"\", not an error", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ ...EMPTY_CONTENT_MAX_TOKENS_BODY, stop_reason: "end_turn" }) });
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.ok).toBe(true);
		expect(result.content).toBe("");
		expect(result.errorKind).toBeNull();
	});

	it("maps usage: input_tokens/output_tokens to promptTokens/completionTokens, totalTokens is their own sum, cachedTokens from cache_read_input_tokens or null", async () => {
		const withCache: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ content: [], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 } }),
		});
		const withCacheResult = await client(withCache).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(withCacheResult.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 40 });
		expect(withCacheResult.usageReported).toBe(true);

		const withoutCache: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ content: [], usage: { input_tokens: 5, output_tokens: 3 } }) });
		const withoutCacheResult = await client(withoutCache).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(withoutCacheResult.usage?.cachedTokens).toBeNull();
	});

	it("no usage block at all -> usage: null, usageReported: false, never an invented 0", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "hi" }] }) });
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.usage).toBeNull();
		expect(result.usageReported).toBe(false);
		expect(result.rawUsage).toBeNull();
	});

	it("a partial usage block (only one of the two counts) is treated the same as absent — half a count is worse than none (plan §7.1)", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ content: [], usage: { input_tokens: 100 } }) });
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.usage).toBeNull();
		expect(result.usageReported).toBe(false);
		// rawUsage still mirrors exactly what the provider sent, partial or not.
		expect(result.rawUsage).toEqual({ input_tokens: 100 });
	});

	it("rawUsage is the usage object exactly as received, for computeAttemptCost's 'provider' costSource", async () => {
		const fetchImpl: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ content: [], usage: { input_tokens: 10, output_tokens: 5, cost: 0.002 } }),
		});
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.rawUsage).toEqual({ input_tokens: 10, output_tokens: 5, cost: 0.002 });
	});

	it("responseModel reads the response's own model field; responseProvider/openrouterMetadata are always null — neither exists in this protocol", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ content: [], model: "claude-x" }) });
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.responseModel).toBe("claude-x");
		expect(result.responseProvider).toBeNull();
		expect(result.openrouterMetadata).toBeNull();
	});
});

describe("createMessagesClient: generate — failure classification (same contract as client.ts)", () => {
	it("a non-2xx response is http_error, with the status and no content", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: false, status: 400, json: async () => ({}) });
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.ok).toBe(false);
		expect(result.httpStatus).toBe(400);
		expect(result.errorKind).toBe("http_error");
		expect(result.content).toBeNull();
		expect(result.rawUsage).toBeNull();
	});

	it("a 2xx response with a non-JSON body is http_error too, not a crash", async () => {
		const fetchImpl: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError("Unexpected token < in JSON");
			},
		});
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.ok).toBe(false);
		expect(result.errorKind).toBe("http_error");
		expect(result.httpStatus).toBe(200);
	});

	it("an aborted request is timeout, not network", async () => {
		const fetchImpl: FetchLike = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					const err = new Error("The operation was aborted");
					err.name = "AbortError";
					reject(err);
				});
			});
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 20 });
		expect(result.errorKind).toBe("timeout");
		expect(result.errorMessage).toContain("20ms");
	});

	it("a thrown network error is 'network', with a message that never contains proxy credentials or the raw underlying error", async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error("connect ECONNREFUSED 10.0.0.1:443 via http://alice:s3cr3t@proxy.internal:3128");
		};
		const result = await client(fetchImpl, { proxyUrl: "http://alice:s3cr3t@proxy.internal:3128" }).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.errorKind).toBe("network");
		expect(result.errorMessage).not.toContain("s3cr3t");
		expect(result.errorMessage).not.toContain("ECONNREFUSED");
		expect(result.errorMessage).toContain("proxy.internal:3128");
	});

	it("never includes the API key or proxy URL in any returned field, on success or failure", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
		const result = await client(fetchImpl, { apiKey: "sk-super-secret-key", proxyUrl: "http://user:pw@proxy.internal:3128" }).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(JSON.stringify(result)).not.toContain("sk-super-secret-key");
		expect(JSON.stringify(result)).not.toContain("pw");
	});
});

describe("createMessagesClient: listModels / modelsPath", () => {
	it("defaults to GET {baseUrl}/models when modelsPath is unset", async () => {
		const fetchImpl: FetchLike = async (url) => {
			expect(url).toBe("https://api.anthropic.com/v1/models");
			return { ok: true, status: 200, json: async () => ({ data: [{ id: "claude-a" }] }) };
		};
		expect(await client(fetchImpl).listModels()).toEqual([{ id: "claude-a" }]);
	});

	it("uses an explicit modelsPath when the profile sets one", async () => {
		const fetchImpl: FetchLike = async (url) => {
			expect(url).toBe("https://api.anthropic.com/v1/v1/model-list");
			return { ok: true, status: 200, json: async () => ({ data: [] }) };
		};
		await client(fetchImpl, { modelsPath: "/v1/model-list" }).listModels();
	});

	it("modelsPath: null throws a distinct 'not supported' error instead of making a request", async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error("should never be called");
		};
		await expect(client(fetchImpl, { modelsPath: null, name: "myproxy" }).listModels()).rejects.toThrow(/not supported.*"myproxy"/);
	});

	it("a non-2xx listModels response throws a status-only error, no secrets", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({}) });
		await expect(client(fetchImpl, { apiKey: "sk-secret" }).listModels()).rejects.toThrow(/401/);
	});
});
