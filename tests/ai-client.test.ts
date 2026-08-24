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
