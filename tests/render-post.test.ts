import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../src/ai/client.js";
import type { AiProviderProfile } from "../src/ai/providers.js";
import type { Facts } from "../src/facts.js";
import { renderPost, type RenderPostConfig } from "../src/renderPost.js";
import type { StateHistory } from "../src/state.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ai-responses");
function fixtureText(name: string): string {
	return readFileSync(path.join(FIXTURES_DIR, `${name}.txt`), "utf8");
}

/** Same worked example as the other ai-*.test.ts files. */
function specExampleFacts(overrides: Partial<Facts> = {}): Facts {
	return {
		dateLabel: "23 августа",
		dateKey: "2026-08-23",
		btc: { price: 76_150, change24h: -2.1 },
		red: 133,
		green: 14,
		total: 147,
		swarmState: "red",
		streak: 1,
		prevState: "green",
		winners: [{ id: "trac", ticker: "TRAC", change24h: 18, price: 1, marketCap: null }],
		losers: [{ id: "pi", ticker: "PI", change24h: -17, price: 1, marketCap: null }],
		maxAbsLeaderChange: 18,
		...overrides,
	};
}

const EMPTY_HISTORY: StateHistory = { days: [] };

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(path.join(tmpdir(), "morning-post-render-post-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function testProvider(overrides: Partial<AiProviderProfile> = {}): AiProviderProfile {
	return {
		name: "test-provider",
		baseUrl: "https://provider.example.com",
		authStyle: "bearer",
		apiKeyVar: "AI_API_KEY",
		extraHeaders: {},
		primaryModel: "primary-model",
		fallbackModel: "fallback-model",
		costSource: "table",
		priceTable: {},
		inputOverhead: 0,
		balanceSource: "manual",
		unitRate: 1,
		...overrides,
	};
}

function baseConfig(overrides: Partial<RenderPostConfig> = {}): RenderPostConfig {
	return {
		aiEnabled: true,
		dryRun: false,
		aiFlag: false,
		aiBaseUrl: "https://proxy.example.com/v1",
		aiApiKey: "test-key",
		aiProxyUrl: "",
		aiModel: "primary-model",
		aiModelFallback: "fallback-model",
		aiProvider: testProvider(),
		aiTimeoutMs: 25_000,
		aiTotalBudgetMs: 70_000,
		aiMaxAttempts: 2,
		promptVersion: 1,
		usageFile: path.join(tmpDir, "usage.jsonl"),
		outDir: tmpDir,
		...overrides,
	};
}

/** A fetchImpl that always succeeds with fixtures/ai-responses/observation-good.txt's content. */
function okFetch(): FetchLike {
	return async () => ({
		ok: true,
		status: 200,
		json: async () => ({
			choices: [{ message: { content: fixtureText("observation-good") }, finish_reason: "stop" }],
			usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
		}),
	});
}

describe("renderPost: section 3.4 dry-run gate", () => {
	it("never touches the AI transport with --dry and no --ai — this is the main test: zero fetch calls", async () => {
		const fetchImpl = vi.fn(okFetch());
		const config = baseConfig({ dryRun: true, aiFlag: false });

		const result = await renderPost(specExampleFacts(), EMPTY_HISTORY, false, config, fetchImpl);

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(result.source).toBe("template");
		expect(result.model).toBeNull();
		expect(result.failureReason).toBeNull(); // a deliberate skip, not a failure — no fallback alert should fire over this
	});

	it("does call the AI transport with --dry --ai", async () => {
		const fetchImpl = vi.fn(okFetch());
		const config = baseConfig({ dryRun: true, aiFlag: true });

		const result = await renderPost(specExampleFacts(), EMPTY_HISTORY, false, config, fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(result.source).toBe("ai");
	});

	it("is a separate check from skipAi — skipAi alone (dryRun false) also never calls the transport, for its own distinct reason", async () => {
		// Not the gate under test here, just proving the two checks don't
		// collapse into one: skipAi already short-circuits before the gate is
		// even reached, so this must never depend on aiFlag/--ai at all.
		const fetchImpl = vi.fn(okFetch());
		const config = baseConfig({ dryRun: false, aiFlag: false });

		const result = await renderPost(specExampleFacts(), EMPTY_HISTORY, true, config, fetchImpl);

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(result.source).toBe("template");
	});

	it("calls the transport normally in a real (non-dry) publish", async () => {
		const fetchImpl = vi.fn(okFetch());
		const config = baseConfig({ dryRun: false });

		const result = await renderPost(specExampleFacts(), EMPTY_HISTORY, false, config, fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(result.source).toBe("ai");
	});

	it("AI_ENABLED=0 skips before the dry-run gate even runs — template regardless of --dry/--ai", async () => {
		const fetchImpl = vi.fn(okFetch());
		const config = baseConfig({ aiEnabled: false, dryRun: true, aiFlag: true });

		const result = await renderPost(specExampleFacts(), EMPTY_HISTORY, false, config, fetchImpl);

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(result.source).toBe("template");
	});
});

describe("renderPost: third outcome — ai_trimmed passes through with the caption built from the cut remainder", () => {
	function trimmedFetch(): FetchLike {
		const observation = JSON.stringify({
			observation:
				"Второй день подряд биток топчется в минусе — красных монет заметно больше зелёных. TRAC держится крепче остальных, почти не поддаваясь давлению. PI, наоборот, проседает быстрее прочих, оставаясь в числе главных аутсайдеров.",
			direction: "red",
		});
		return async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				choices: [{ message: { content: observation }, finish_reason: "stop" }],
				usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
			}),
		});
	}

	it("returns source ai_trimmed, the cut observation in paragraphs/caption, and the removed sentence", async () => {
		const fetchImpl = vi.fn(trimmedFetch());
		const config = baseConfig({ dryRun: false });

		const result = await renderPost(specExampleFacts(), EMPTY_HISTORY, false, config, fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(1); // trimming replaces the retry — no second request
		expect(result.source).toBe("ai_trimmed");
		expect(result.failureReason).toBeNull();
		expect(result.trimmedSentence).toContain("Второй день подряд");
		expect(result.paragraphs.observation).not.toContain("Второй день подряд");
		expect(result.caption).toContain(result.paragraphs.observation);
		expect(result.caption).not.toContain("Второй день подряд");
	});
});
