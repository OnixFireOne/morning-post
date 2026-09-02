import { describe, expect, it } from "vitest";
import { createAiClient, type AiClientOptions, type FetchLike } from "../src/ai/client.js";

const BASE_URL = "https://proxy.example.com/v1";

function client(fetchImpl: FetchLike, extra: Partial<AiClientOptions> = {}) {
	return createAiClient({ baseUrl: BASE_URL, apiKey: "test-key", fetchImpl, ...extra });
}

describe("createAiClient: generate — success", () => {
	it("returns content, usage, and finishReason, and calls the right URL/headers", async () => {
		const fetchImpl: FetchLike = async (url, init) => {
			expect(url).toBe("https://proxy.example.com/v1/chat/completions");
			expect(init.method).toBe("POST");
			expect(init.headers.Authorization).toBe("Bearer test-key");
			expect(JSON.parse(init.body!)).toEqual({
				model: "m",
				messages: [
					{ role: "system", content: "s" },
					{ role: "user", content: "u" },
				],
			});
			return {
				ok: true,
				status: 200,
				json: async () => ({
					choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
				}),
			};
		};
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.ok).toBe(true);
		expect(result.content).toBe("hello");
		expect(result.finishReason).toBe("stop");
		expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: null });
		expect(result.usageReported).toBe(true);
		expect(result.errorKind).toBeNull();
		expect(result.errorMessage).toBeNull();
	});

	it("includes response_format only when the caller passes one", async () => {
		let sentBody: Record<string, unknown> = {};
		const fetchImpl: FetchLike = async (_url, init) => {
			sentBody = JSON.parse(init.body!);
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }) };
		};
		await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(sentBody.response_format).toBeUndefined();

		await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000, responseFormat: { type: "json_schema" } });
		expect(sentBody.response_format).toEqual({ type: "json_schema" });
	});

	it("reports usage: null and usageReported: false when the provider omits the usage block — never invents a 0", async () => {
		const fetchImpl: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }),
		});
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.ok).toBe(true);
		expect(result.usage).toBeNull();
		expect(result.usageReported).toBe(false);
	});

	it("exposes the provider's usage block completely unparsed in rawUsage, including fields the normalized `usage` doesn't model", async () => {
		const fetchImpl: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
				// estimated_cost isn't a field OpenAiChatCompletion's type names at
				// all — proving rawUsage passes through the runtime object as-is,
				// not just the subset this client happens to interpret.
				usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, estimated_cost: 0.0042 },
			}),
		});
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.rawUsage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, estimated_cost: 0.0042 });
	});

	it("rawUsage is null (not an empty object) when the provider omits the usage block entirely", async () => {
		const fetchImpl: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }),
		});
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.rawUsage).toBeNull();
	});

	it("reads cached tokens when the provider reports them, null when it doesn't", async () => {
		const withCache: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } },
			}),
		});
		expect((await client(withCache).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 })).usage?.cachedTokens).toBe(40);

		const withoutCache: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
		});
		expect((await client(withoutCache).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 })).usage?.cachedTokens).toBeNull();
	});
});

describe("createAiClient: generate — failure classification", () => {
	it("marks a non-2xx response as http_error, with the status code and no content", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({}) });
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.ok).toBe(false);
		expect(result.httpStatus).toBe(401);
		expect(result.errorKind).toBe("http_error");
		expect(result.content).toBeNull();
		expect(result.usage).toBeNull();
		expect(result.rawUsage).toBeNull(); // no body was ever parsed — nothing to dump
	});

	it("marks a 2xx response with a non-JSON body as http_error too, not a crash", async () => {
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

	it("marks an aborted request as timeout, not network", async () => {
		const fetchImpl: FetchLike = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					const err = new Error("The operation was aborted");
					err.name = "AbortError";
					reject(err);
				});
			});
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 20 });
		expect(result.ok).toBe(false);
		expect(result.errorKind).toBe("timeout");
		expect(result.errorMessage).toContain("20ms");
		expect(result.rawUsage).toBeNull();
	});

	it("marks a thrown network error as network, with a message that never contains proxy credentials or the raw underlying error", async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error("connect ECONNREFUSED 10.0.0.1:443 via http://alice:s3cr3t@proxy.internal:3128");
		};
		const result = await client(fetchImpl, { proxyUrl: "http://alice:s3cr3t@proxy.internal:3128" }).generate({
			model: "m",
			system: "s",
			user: "u",
			timeoutMs: 1000,
		});
		expect(result.ok).toBe(false);
		expect(result.errorKind).toBe("network");
		expect(result.errorMessage).not.toContain("s3cr3t");
		expect(result.errorMessage).not.toContain("ECONNREFUSED"); // raw error text discarded, not scrubbed
		expect(result.errorMessage).toContain("proxy.internal:3128"); // host/port alone is fine
	});

	it("never includes the API key in any returned field, on success or failure", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
		const result = await client(fetchImpl, { apiKey: "sk-super-secret-key" }).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(JSON.stringify(result)).not.toContain("sk-super-secret-key");
	});
});

describe("createAiClient: listModels", () => {
	it("returns model ids from the /models endpoint with the right auth header", async () => {
		const fetchImpl: FetchLike = async (url, init) => {
			expect(url).toBe("https://proxy.example.com/v1/models");
			expect(init.method).toBe("GET");
			expect(init.headers.Authorization).toBe("Bearer test-key");
			return { ok: true, status: 200, json: async () => ({ data: [{ id: "claude-sonnet-4.6" }, { id: "claude-opus-4.7" }] }) };
		};
		const models = await client(fetchImpl).listModels();
		expect(models).toEqual([{ id: "claude-sonnet-4.6" }, { id: "claude-opus-4.7" }]);
	});

	it("returns an empty array when the provider's data field is missing", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}) });
		expect(await client(fetchImpl).listModels()).toEqual([]);
	});

	it("throws a status-only error on failure — no secrets in the message", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({}) });
		await expect(client(fetchImpl, { apiKey: "sk-secret" }).listModels()).rejects.toThrow(/401/);
		try {
			await client(fetchImpl, { apiKey: "sk-secret" }).listModels();
		} catch (err) {
			expect(String(err)).not.toContain("sk-secret");
		}
	});
});

describe("createAiClient: providerHost", () => {
	it("exposes just the host of baseUrl, for safe logging", () => {
		const c = client(async () => ({ ok: true, status: 200, json: async () => ({}) }));
		expect(c.providerHost).toBe("proxy.example.com");
	});
});

describe("createAiClient: authStyle (26.08 provider migration — src/ai/providers.ts's AiProviderProfile.authStyle)", () => {
	it("defaults to Bearer when authStyle is unset, unchanged from before this option existed", async () => {
		const fetchImpl: FetchLike = async (_url, init) => {
			expect(init.headers.Authorization).toBe("Bearer test-key");
			expect(init.headers["x-api-key"]).toBeUndefined();
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }) };
		};
		await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
	});

	it("sends x-api-key instead of Authorization: Bearer when authStyle is x-api-key", async () => {
		const fetchImpl: FetchLike = async (_url, init) => {
			expect(init.headers["x-api-key"]).toBe("test-key");
			expect(init.headers.Authorization).toBeUndefined();
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }) };
		};
		await client(fetchImpl, { authStyle: "x-api-key" }).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
	});

	it("merges extraHeaders on top of Content-Type/auth, without dropping either", async () => {
		const fetchImpl: FetchLike = async (_url, init) => {
			expect(init.headers["Content-Type"]).toBe("application/json");
			expect(init.headers.Authorization).toBe("Bearer test-key");
			expect(init.headers["HTTP-Referer"]).toBe("https://example.com");
			expect(init.headers["X-Title"]).toBe("morning-post");
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }) };
		};
		await client(fetchImpl, { extraHeaders: { "HTTP-Referer": "https://example.com", "X-Title": "morning-post" } }).generate({
			model: "m",
			system: "s",
			user: "u",
			timeoutMs: 1000,
		});
	});
});

describe("createAiClient: responseProvider/responseModel (26.08 — OpenRouter-specific top-level response fields)", () => {
	it("reads provider/model straight from the response body on success", async () => {
		const fetchImpl: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				provider: "Anthropic",
				model: "anthropic/claude-sonnet-5",
				choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			}),
		});
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.responseProvider).toBe("Anthropic");
		expect(result.responseModel).toBe("anthropic/claude-sonnet-5");
	});

	it("are all null when the response doesn't carry them (a provider without OpenRouter's extensions)", async () => {
		const fetchImpl: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }),
		});
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.responseProvider).toBeNull();
		expect(result.responseModel).toBeNull();
	});

	it("are all null on any transport-level failure — nothing was ever parsed", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.responseProvider).toBeNull();
		expect(result.responseModel).toBeNull();
	});
});

// 02.09: replaces the old GET /api/v1/generation?id=<id> lookup — that was a
// second round trip after the fact and its 404s turned out to be genuine
// ("not found", not "not ready yet"). X-OpenRouter-Metadata: enabled (set by
// providers.ts's OPENROUTER profile, on every request) makes the same
// response carry this instead — no second call.
describe("createAiClient: openrouterMetadata", () => {
	function fetchWith(body: Record<string, unknown>): FetchLike {
		return async () => ({
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }], ...body }),
		});
	}

	it("reads model/provider from openrouter_metadata when present", async () => {
		const result = await client(fetchWith({ openrouter_metadata: { model: "anthropic/claude-sonnet-4.5-20250929", provider: "Anthropic" } })).generate({
			model: "m",
			system: "s",
			user: "u",
			timeoutMs: 1000,
		});
		expect(result.openrouterMetadata).toEqual({ model: "anthropic/claude-sonnet-4.5-20250929", provider: "Anthropic" });
	});

	it("is null when the response has no openrouter_metadata field at all (header wasn't honored, or a non-OpenRouter provider)", async () => {
		const result = await client(fetchWith({})).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.openrouterMetadata).toBeNull();
	});

	it("is null (never throws) when openrouter_metadata is present but malformed — wrong type, or neither sub-field a usable string", async () => {
		for (const malformed of ["a string, not an object", 42, null, {}, { model: 5, provider: null }, { model: "", provider: "" }]) {
			const result = await client(fetchWith({ openrouter_metadata: malformed })).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
			expect(result.openrouterMetadata, `expected null for ${JSON.stringify(malformed)}`).toBeNull();
		}
	});

	it("keeps whichever sub-field is a real string even when the other is missing", async () => {
		const result = await client(fetchWith({ openrouter_metadata: { model: "anthropic/claude-sonnet-4.5-20250929" } })).generate({
			model: "m",
			system: "s",
			user: "u",
			timeoutMs: 1000,
		});
		expect(result.openrouterMetadata).toEqual({ model: "anthropic/claude-sonnet-4.5-20250929", provider: null });
	});

	it("is null on any transport-level failure", async () => {
		const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
		const result = await client(fetchImpl).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.openrouterMetadata).toBeNull();
	});
});
