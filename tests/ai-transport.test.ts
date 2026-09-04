// plan/ai-providering.md §4/§9: createTransport is the one switch on
// AiProviderProfile.protocol in the whole project — this file only checks
// that the switch itself routes correctly; the two transports' own request/
// response behavior is covered by tests/ai-client.test.ts and
// tests/ai-client-messages.test.ts.
import { describe, expect, it } from "vitest";
import { createTransport } from "../src/ai/transport.js";
import type { AiProviderProfile } from "../src/ai/providers.js";
import type { FetchLike } from "../src/ai/client.js";

function profile(overrides: Partial<AiProviderProfile> = {}): AiProviderProfile {
	return {
		name: "test",
		baseUrl: "https://example.com/v1",
		protocol: "chat_completions",
		authStyle: "bearer",
		apiKeyVar: "TEST_API_KEY",
		extraHeaders: {},
		primaryModel: "m",
		fallbackModel: "m",
		costSource: "provider",
		priceTable: {},
		inputOverhead: 0,
		balanceSource: "api",
		unitRate: 1,
		...overrides,
	};
}

describe("createTransport: routes by protocol", () => {
	it("protocol: chat_completions -> a client that POSTs to /chat/completions", async () => {
		const fetchImpl: FetchLike = async (url) => {
			expect(url).toBe("https://example.com/v1/chat/completions");
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }) };
		};
		const client = createTransport(profile({ protocol: "chat_completions" }), { apiKey: "k", fetchImpl });
		const result = await client.generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.content).toBe("hi");
	});

	it("protocol omitted (as if the field were absent from the JSON) defaults to chat_completions, same as the validator's own default", async () => {
		const { protocol: _protocol, ...rest } = profile();
		const fetchImpl: FetchLike = async (url) => {
			expect(url).toBe("https://example.com/v1/chat/completions");
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }) };
		};
		const client = createTransport(rest as AiProviderProfile, { apiKey: "k", fetchImpl });
		await client.generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
	});

	it("protocol: messages -> a client that POSTs to /messages with max_tokens/system from the profile", async () => {
		const fetchImpl: FetchLike = async (url, init) => {
			expect(url).toBe("https://example.com/v1/messages");
			expect(JSON.parse(init.body!)).toMatchObject({ max_tokens: 512, system: "s" });
			return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "hi" }] }) };
		};
		const client = createTransport(profile({ protocol: "messages", maxTokens: 512, authStyle: "x-api-key" }), { apiKey: "k", fetchImpl });
		const result = await client.generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });
		expect(result.content).toBe("hi");
	});

	it("protocol: messages without maxTokens throws immediately — defensive, since the validator already guarantees this for a loaded profile", () => {
		const p = profile({ protocol: "messages" });
		expect(() => createTransport(p, { apiKey: "k" })).toThrow(/maxTokens is required/);
	});

	it("an unrecognized protocol value throws, naming it", () => {
		const p = { ...profile(), protocol: "bogus" } as unknown as AiProviderProfile;
		expect(() => createTransport(p, { apiKey: "k" })).toThrow(/unknown protocol/);
	});

	it("passes authStyle/extraHeaders/proxyUrl/apiKey through to the underlying client identically for both protocols", async () => {
		const chatCompletions: FetchLike = async (_url, init) => {
			expect(init.headers.Authorization).toBe("Bearer k");
			expect(init.headers["X-Extra"]).toBe("1");
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }) };
		};
		await createTransport(profile({ extraHeaders: { "X-Extra": "1" } }), { apiKey: "k", fetchImpl: chatCompletions }).generate({ model: "m", system: "s", user: "u", timeoutMs: 1000 });

		const messages: FetchLike = async (_url, init) => {
			expect(init.headers["x-api-key"]).toBe("k");
			expect(init.headers["X-Extra"]).toBe("1");
			return { ok: true, status: 200, json: async () => ({ content: [] }) };
		};
		await createTransport(profile({ protocol: "messages", maxTokens: 100, authStyle: "x-api-key", extraHeaders: { "X-Extra": "1" } }), { apiKey: "k", fetchImpl: messages }).generate({
			model: "m",
			system: "s",
			user: "u",
			timeoutMs: 1000,
		});
	});
});
