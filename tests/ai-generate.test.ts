import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AiClient, AiErrorKind, AiGenerateParams, AiGenerateResult } from "../src/ai/client.js";
import { buildParagraphs, pickPicture } from "../src/render.js";
import { buildParagraphsAI, type AiJsonOutput, type BuildParagraphsAiOptions, type AiModelConfig } from "../src/ai/generate.js";
import type { UsageRecord } from "../src/ai/usage.js";
import type { Facts } from "../src/facts.js";

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

// --- deterministic fake clock: each canned response's own durationMs advances
// Date.now() by exactly that much, no real waiting, so budget-exhaustion
// scenarios are exact and instant instead of flaky/slow ---
let clockNow = 0;
beforeEach(() => {
	clockNow = 1_700_000_000_000;
	vi.spyOn(Date, "now").mockImplementation(() => clockNow);
});
afterEach(() => {
	vi.restoreAllMocks();
});

function okResult(content: string, overrides: Partial<AiGenerateResult> = {}): AiGenerateResult {
	return {
		ok: true,
		content,
		finishReason: "stop",
		usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedTokens: null },
		usageReported: true,
		httpStatus: 200,
		durationMs: 500,
		errorKind: null,
		errorMessage: null,
		rawUsage: null,
		...overrides,
	};
}

function failResult(errorKind: NonNullable<AiErrorKind>, overrides: Partial<AiGenerateResult> = {}): AiGenerateResult {
	return {
		ok: false,
		content: null,
		finishReason: null,
		usage: null,
		usageReported: false,
		httpStatus: errorKind === "http_error" ? 500 : null,
		durationMs: 100,
		errorKind,
		errorMessage: "boom",
		rawUsage: null,
		...overrides,
	};
}

type CannedResponse = AiGenerateResult | ((params: AiGenerateParams) => AiGenerateResult);

/** A fully in-memory AiClient — no fetch, no undici, just a queue of canned results and a call log. */
function fakeClient(providerHost: string, responses: CannedResponse[]): { client: AiClient; calls: AiGenerateParams[] } {
	const calls: AiGenerateParams[] = [];
	let index = 0;
	const client: AiClient = {
		providerHost,
		async generate(params) {
			calls.push(params);
			const canned = responses[index++];
			if (!canned) throw new Error(`fakeClient: no canned response queued for call #${index}`);
			const result = typeof canned === "function" ? canned(params) : canned;
			clockNow += result.durationMs;
			return result;
		},
		async listModels() {
			return [];
		},
	};
	return { client, calls };
}

function modelConfig(model: string, overrides: Partial<AiModelConfig> = {}): AiModelConfig {
	return { model, priceInPerMillion: null, priceOutPerMillion: null, ...overrides };
}

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(path.join(tmpdir(), "morning-post-ai-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function readUsageLines(usageFile: string): UsageRecord[] {
	if (!readdirSync(path.dirname(usageFile)).includes(path.basename(usageFile))) return [];
	return readFileSync(usageFile, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as UsageRecord);
}

function readAiJson(aiJsonFile: string): AiJsonOutput {
	return JSON.parse(readFileSync(aiJsonFile, "utf8")) as AiJsonOutput;
}

function baseOptions(overrides: Partial<BuildParagraphsAiOptions> = {}): BuildParagraphsAiOptions {
	return {
		facts: specExampleFacts(),
		history: [],
		client: fakeClient("provider.example.com", []).client,
		primary: modelConfig("primary-model"),
		fallback: modelConfig("fallback-model"),
		timeoutMs: 25_000,
		totalBudgetMs: 70_000,
		maxAttemptsPerModel: 2,
		promptVersion: 1,
		usageFile: path.join(tmpDir, "usage.jsonl"),
		aiJsonFile: path.join(tmpDir, "day.ai.json"),
		dryRun: false,
		...overrides,
	};
}

describe("buildParagraphsAI: happy path", () => {
	it("accepts a good first attempt and returns AI-sourced paragraphs", async () => {
		const { client, calls } = fakeClient("provider.example.com", [okResult(fixtureText("observation-good"))]);
		const options = baseOptions({ client, primary: modelConfig("primary-model") });

		const result = await buildParagraphsAI(options);

		expect(result.source).toBe("ai");
		expect(result.model).toBe("primary-model");
		expect(result.provider).toBe("provider.example.com");
		expect(result.promptVersion).toBe(1);
		expect(result.failureReason).toBeNull();
		// picture is never the model's own text (PROMPT_VERSION 7) — it's always
		// pickPicture(facts), the same code-generated text the template path uses.
		expect(result.picture).toBe(pickPicture(options.facts));
		expect(result.attempts).toBe(1);
		expect(calls).toHaveLength(1);
	});
});

describe("buildParagraphsAI: usage.jsonl is written for rejected attempts too, before the retry/accept decision", () => {
	it("logs a usage line for a content-level rejection, with the real tokens spent on that attempt", async () => {
		const { client } = fakeClient("provider.example.com", [
			okResult(fixtureText("observation-digit"), { usage: { promptTokens: 200, completionTokens: 80, totalTokens: 280, cachedTokens: null } }),
			okResult(fixtureText("observation-good")), // the retry succeeds
		]);
		const options = baseOptions({ client, maxAttemptsPerModel: 2 });

		const result = await buildParagraphsAI(options);
		expect(result.source).toBe("ai"); // sanity: the run did succeed overall

		const lines = readUsageLines(options.usageFile);
		expect(lines).toHaveLength(2);
		expect(lines[0]!.outcome).toBe("validator:observation_digit");
		expect(lines[0]!.tokensIn).toBe(200);
		expect(lines[0]!.tokensOut).toBe(80);
		expect(lines[1]!.outcome).toBe("ok");
	});

	it("logs a usage line for a transport failure too — not just successful responses", async () => {
		const { client } = fakeClient("provider.example.com", [failResult("http_error", { httpStatus: 503 }), okResult(fixtureText("observation-good"))]);
		const options = baseOptions({ client });

		await buildParagraphsAI(options);

		const lines = readUsageLines(options.usageFile);
		expect(lines[0]!.outcome).toBe("http_503");
		expect(lines[0]!.tokensIn).toBeNull();
		expect(lines[0]!.usageReported).toBe(false);
	});

	it("usage: null and usageReported: false round-trip through the log without inventing zeros", async () => {
		const { client } = fakeClient("provider.example.com", [okResult(fixtureText("observation-good"), { usage: null, usageReported: false })]);
		const options = baseOptions({ client });

		await buildParagraphsAI(options);

		const [line] = readUsageLines(options.usageFile);
		expect(line!.tokensIn).toBeNull();
		expect(line!.tokensOut).toBeNull();
		expect(line!.tokensTotal).toBeNull();
		expect(line!.usageReported).toBe(false);
		expect(line!.costEstimate).toBeNull();
	});
});

describe("buildParagraphsAI: dryRun flag on every usage.jsonl line (section 3.4)", () => {
	it("writes dryRun: true on every line — success and transport-failure alike — when options.dryRun is true", async () => {
		const { client } = fakeClient("provider.example.com", [failResult("http_error", { httpStatus: 500 }), okResult(fixtureText("observation-good"))]);
		const options = baseOptions({ client, dryRun: true });

		await buildParagraphsAI(options);

		const lines = readUsageLines(options.usageFile);
		expect(lines).toHaveLength(2);
		expect(lines.every((l) => l.dryRun === true)).toBe(true);
	});

	it("writes dryRun: false on every line when options.dryRun is false", async () => {
		const { client } = fakeClient("provider.example.com", [okResult(fixtureText("observation-good"))]);
		const options = baseOptions({ client, dryRun: false });

		await buildParagraphsAI(options);

		const [line] = readUsageLines(options.usageFile);
		expect(line!.dryRun).toBe(false);
	});
});

describe("buildParagraphsAI: budget is checked before every request, not after", () => {
	it("stops before a request that would start after the budget is effectively spent", async () => {
		// First attempt takes 68s of a 70s budget with a 25s per-request timeout —
		// remaining (2s) < timeoutMs (25s) before attempt 2 even starts.
		const { client, calls } = fakeClient("provider.example.com", [
			okResult(fixtureText("observation-digit"), { durationMs: 68_000 }),
			okResult(fixtureText("observation-good")), // must never be reached
		]);
		const options = baseOptions({ client, timeoutMs: 25_000, totalBudgetMs: 70_000, maxAttemptsPerModel: 2 });

		const result = await buildParagraphsAI(options);

		expect(calls).toHaveLength(1); // the second canned response was never consumed
		expect(result.source).toBe("template");
		expect(result.failureReason).toContain("budget exhausted");
	});

	it("never even makes the first request when the budget is already too small for one attempt", async () => {
		const { client, calls } = fakeClient("provider.example.com", [okResult(fixtureText("observation-good"))]);
		const options = baseOptions({ client, timeoutMs: 25_000, totalBudgetMs: 10_000 });

		const result = await buildParagraphsAI(options);

		expect(calls).toHaveLength(0);
		expect(result.source).toBe("template");
		expect(result.attempts).toBe(0);
	});
});

describe("buildParagraphsAI: ok:false short-circuits before the validator", () => {
	it("never runs validateAiObservation on a transport failure — outcome is the transport code, not a validator reason", async () => {
		const { client } = fakeClient("provider.example.com", [failResult("timeout"), failResult("timeout")]);
		const options = baseOptions({ client, maxAttemptsPerModel: 1 });

		await buildParagraphsAI(options);

		const lines = readUsageLines(options.usageFile);
		for (const line of lines) {
			expect(line.outcome).toBe("timeout");
			expect(line.outcome).not.toMatch(/^validator:|^invalid_json$/);
		}
	});
});

describe("buildParagraphsAI: retry vs fallback split by errorKind", () => {
	it("a content-level failure retries the SAME model, with a retry-shaped prompt", async () => {
		const { client, calls } = fakeClient("provider.example.com", [okResult(fixtureText("observation-digit")), okResult(fixtureText("observation-good"))]);
		const options = baseOptions({ client, primary: modelConfig("primary-model"), maxAttemptsPerModel: 2 });

		const result = await buildParagraphsAI(options);

		expect(calls).toHaveLength(2);
		expect(calls[0]!.model).toBe("primary-model");
		expect(calls[1]!.model).toBe("primary-model"); // still the primary — a retry, not a fallback switch
		expect(JSON.parse(calls[1]!.user).retryInstruction).toBeDefined();
		expect(result.source).toBe("ai");
		expect(result.model).toBe("primary-model");
	});

	it("a transport-level failure skips straight to the fallback model — no retry on the same model", async () => {
		const { client, calls } = fakeClient("provider.example.com", [failResult("http_error", { httpStatus: 500 }), okResult(fixtureText("observation-good"))]);
		const options = baseOptions({ client, primary: modelConfig("primary-model"), fallback: modelConfig("fallback-model"), maxAttemptsPerModel: 2 });

		const result = await buildParagraphsAI(options);

		expect(calls).toHaveLength(2);
		expect(calls[0]!.model).toBe("primary-model");
		expect(calls[1]!.model).toBe("fallback-model"); // straight to fallback, not a second primary attempt
		expect(result.source).toBe("ai");
		expect(result.model).toBe("fallback-model");
	});
});

describe("buildParagraphsAI: pricing uses the model that actually answered", () => {
	it("costs a fallback attempt at the fallback's own price, not the primary's", async () => {
		const { client } = fakeClient("provider.example.com", [
			failResult("http_error", { httpStatus: 500 }),
			okResult(fixtureText("observation-good"), { usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000, cachedTokens: null } }),
		]);
		const options = baseOptions({
			client,
			primary: modelConfig("primary-model", { priceInPerMillion: 1, priceOutPerMillion: 2 }), // would give cost 3 if wrongly applied
			fallback: modelConfig("fallback-model", { priceInPerMillion: 10, priceOutPerMillion: 20 }), // correct: cost 30
		});

		await buildParagraphsAI(options);

		const lines = readUsageLines(options.usageFile);
		const successLine = lines.find((l) => l.outcome === "ok")!;
		expect(successLine.model).toBe("fallback-model");
		expect(successLine.costEstimate).toBe(30); // 1M/1M tokens * (10 + 20) per million
	});

	it("leaves costEstimate null when either price knob is unset for that model", async () => {
		const { client } = fakeClient("provider.example.com", [okResult(fixtureText("observation-good"))]);
		const options = baseOptions({ client, primary: modelConfig("primary-model", { priceInPerMillion: 5, priceOutPerMillion: null }) });

		await buildParagraphsAI(options);

		const [line] = readUsageLines(options.usageFile);
		expect(line!.costEstimate).toBeNull();
	});

	it("sums result.totalCost across a content-rejected primary attempt and a fallback that succeeds, each at its own price", async () => {
		// Directly what the daily usage summary reports as "стоимость дня" —
		// this has to be the sum of two different attempts priced by two
		// different models, not one blended tariff applied to the total tokens.
		const { client } = fakeClient("provider.example.com", [
			okResult(fixtureText("observation-digit"), { usage: { promptTokens: 100_000, completionTokens: 50_000, totalTokens: 150_000, cachedTokens: null } }),
			okResult(fixtureText("observation-good"), { usage: { promptTokens: 200_000, completionTokens: 100_000, totalTokens: 300_000, cachedTokens: null } }),
		]);
		const options = baseOptions({
			client,
			maxAttemptsPerModel: 1, // one content rejection exhausts the primary's own attempts and moves straight to fallback
			primary: modelConfig("primary-model", { priceInPerMillion: 10, priceOutPerMillion: 20 }), // (100k/1M)*10 + (50k/1M)*20 = 2
			fallback: modelConfig("fallback-model", { priceInPerMillion: 30, priceOutPerMillion: 60 }), // (200k/1M)*30 + (100k/1M)*60 = 12
		});

		const result = await buildParagraphsAI(options);

		expect(result.source).toBe("ai"); // sanity: the fallback did succeed
		expect(result.attempts).toBe(2);
		expect(result.totalCost).toBe(14); // 2 + 12, not a single blended price on 300k/150k total tokens
	});
});

describe("buildParagraphsAI: totalTokensIn/totalTokensOut", () => {
	it("sums promptTokens/completionTokens across every attempt — never totalTokens, never just the last attempt, never doubled", async () => {
		// totalTokens on each canned response is deliberately NOT promptTokens +
		// completionTokens (999, 888) — if the aggregation ever summed the wrong
		// field, or re-read a value already folded in, this would catch it
		// instead of silently passing on numbers that happen to agree by
		// coincidence, the way promptTokens+completionTokens===totalTokens does
		// in every other fixture in this file.
		const { client } = fakeClient("provider.example.com", [
			okResult(fixtureText("observation-digit"), { usage: { promptTokens: 150, completionTokens: 60, totalTokens: 999, cachedTokens: null } }),
			okResult(fixtureText("observation-good"), { usage: { promptTokens: 90, completionTokens: 40, totalTokens: 888, cachedTokens: null } }),
		]);
		const options = baseOptions({ client, maxAttemptsPerModel: 2 });

		const result = await buildParagraphsAI(options);

		expect(result.source).toBe("ai"); // sanity: the retry did succeed
		expect(result.attempts).toBe(2);
		expect(result.totalTokensIn).toBe(240); // 150 + 90
		expect(result.totalTokensOut).toBe(100); // 60 + 40
	});
});

describe("buildParagraphsAI: never throws", () => {
	it("falls back to the template when the client itself throws unexpectedly", async () => {
		const client: AiClient = {
			providerHost: "provider.example.com",
			async generate() {
				throw new Error("totally broken transport");
			},
			async listModels() {
				return [];
			},
		};
		const options = baseOptions({ client });

		const outcome = await buildParagraphsAI(options); // rejects synchronously if this throws instead of resolving
		expect(outcome.source).toBe("template");
		expect(outcome.failureReason).toContain("unexpected error");
	});

	it("template fallback returns exactly what buildParagraphs(facts) itself produces", async () => {
		const { client } = fakeClient("provider.example.com", [
			okResult(fixtureText("observation-digit")),
			okResult(fixtureText("observation-digit")),
			okResult(fixtureText("observation-digit")),
			okResult(fixtureText("observation-digit")),
		]);
		const facts = specExampleFacts();
		const options = baseOptions({ client, facts, maxAttemptsPerModel: 2 });

		const result = await buildParagraphsAI(options);
		const template = buildParagraphs(facts);

		expect(result.source).toBe("template");
		expect(result.picture).toBe(template.picture);
		expect(result.observation).toBe(template.observation);
		expect(result.attempts).toBe(4); // 2 attempts x 2 models, all content-rejected
		expect(result.failureReason).not.toBeNull();
	});
});

describe("buildParagraphsAI: ai.json is written for every outcome, including full AI failure", () => {
	it("writes ai.json on success, with the accepted result and every attempt", async () => {
		const { client } = fakeClient("provider.example.com", [okResult(fixtureText("observation-digit")), okResult(fixtureText("observation-good"))]);
		const options = baseOptions({ client });

		await buildParagraphsAI(options);

		const data = readAiJson(options.aiJsonFile);
		expect(data.result.source).toBe("ai");
		expect(data.result.model).toBe("primary-model");
		expect(data.attempts).toHaveLength(2);
		expect(data.payload.today.red).toBe(133);
	});

	it("writes ai.json even when every model and retry is exhausted", async () => {
		const { client } = fakeClient("provider.example.com", [
			okResult(fixtureText("observation-digit")),
			okResult(fixtureText("observation-digit")),
			okResult(fixtureText("observation-digit")),
			okResult(fixtureText("observation-digit")),
		]);
		const options = baseOptions({ client, maxAttemptsPerModel: 2 });

		await buildParagraphsAI(options);

		const data = readAiJson(options.aiJsonFile);
		expect(data.result.source).toBe("template");
		expect(data.result.failureReason).toBeTruthy();
		expect(data.attempts).toHaveLength(4);
	});

	it("writes ai.json even when the budget runs out before a single attempt", async () => {
		const { client } = fakeClient("provider.example.com", [okResult(fixtureText("observation-good"))]);
		const options = baseOptions({ client, timeoutMs: 25_000, totalBudgetMs: 1_000 });

		await buildParagraphsAI(options);

		const data = readAiJson(options.aiJsonFile);
		expect(data.result.source).toBe("template");
		expect(data.attempts).toHaveLength(0);
	});
});

describe("buildParagraphsAI: third outcome — validator:observation_day_count fixed by trimming one sentence", () => {
	const threeSentenceDayCount = JSON.stringify({
		observation:
			"Второй день подряд биток топчется в минусе — красных монет заметно больше зелёных. TRAC держится крепче остальных, почти не поддаваясь давлению. PI, наоборот, проседает быстрее прочих, оставаясь в числе главных аутсайдеров.",
		direction: "red",
	});

	it("returns source ai_trimmed, the cut remainder, and the removed sentence — with no retry call made", async () => {
		const { client, calls } = fakeClient("provider.example.com", [okResult(threeSentenceDayCount)]);
		const options = baseOptions({ client, primary: modelConfig("primary-model") });

		const result = await buildParagraphsAI(options);

		expect(calls).toHaveLength(1); // trimming replaces the retry — no second request
		expect(result.source).toBe("ai_trimmed");
		expect(result.model).toBe("primary-model");
		expect(result.failureReason).toBeNull();
		expect(result.trimmedSentence).toContain("Второй день подряд");
		expect(result.observation).not.toContain("Второй день подряд");
		expect(result.observation).toContain("TRAC");
		expect(result.observation).toContain("PI");
		// paragraph 1 is still always code-generated, unaffected by the trim
		expect(result.picture).toBe(pickPicture(options.facts));
	});

	it("usage.jsonl still logs the raw attempt's real outcome (validator:observation_day_count) — the trim is a processing decision, not a rewrite of what happened", async () => {
		const { client } = fakeClient("provider.example.com", [okResult(threeSentenceDayCount)]);
		const options = baseOptions({ client });

		await buildParagraphsAI(options);

		const lines = readUsageLines(options.usageFile);
		expect(lines).toHaveLength(1);
		expect(lines[0]!.outcome).toBe("validator:observation_day_count");
	});

	it("ai.json carries source: ai_trimmed and the removed sentence", async () => {
		const { client } = fakeClient("provider.example.com", [okResult(threeSentenceDayCount)]);
		const options = baseOptions({ client });

		await buildParagraphsAI(options);

		const data = readAiJson(options.aiJsonFile);
		expect(data.result.source).toBe("ai_trimmed");
		expect(data.result.trimmedSentence).toContain("Второй день подряд");
		expect(data.attempts).toHaveLength(1);
	});

	it("a trim that fails its own post-checks goes straight to the template — no retry, no fallback model", async () => {
		// Only two sentences after the cut would be too short/too few to matter here:
		// this response's remainder ("TRAC лидирует. PI падает.") is far under the
		// 80-char floor, so trimming is attempted (eligible: 3 sentences, exactly
		// one violates) but fails its own post-check.
		const shortRemainder = JSON.stringify({
			observation: "Второй день подряд биток топчется в минусе, а рой безучастно наблюдает за этим со стороны. TRAC лидирует. PI падает.",
			direction: "red",
		});
		const { client, calls } = fakeClient("provider.example.com", [okResult(shortRemainder), okResult(fixtureText("observation-good"))]);
		const options = baseOptions({ client, maxAttemptsPerModel: 2 });

		const result = await buildParagraphsAI(options);

		expect(calls).toHaveLength(1); // no retry attempt, no fallback-model attempt — straight to template
		expect(result.source).toBe("template");
		expect(result.failureReason).toContain("trim attempted but failed");
	});

	// Replaces the earlier version of this test, which asserted calls.length
	// === 2 (a same-model retry) for exactly this fixture: a day-count
	// rejection that attemptDayCountTrim can't safely fix (only one sentence
	// total here, need >= 3) used to fall through to the pre-existing
	// retry-same-model behavior. That's no longer true — a same-model retry
	// on validator:observation_day_count has no realistic upside once
	// buildRetryObservationPrompt's own day-count instruction is the thing
	// that already produced the sentence trimming couldn't salvage, so
	// "not_eligible" now goes straight to the template too, same as
	// "trim_failed" — no second paid request either way.
	it("not_eligible for trimming (day count confined to a single-sentence response) goes straight to the template — no retry, exactly one call", async () => {
		const { client, calls } = fakeClient("provider.example.com", [okResult(fixtureText("observation-day-count")), okResult(fixtureText("observation-good"))]);
		const options = baseOptions({ client, maxAttemptsPerModel: 2 });

		const result = await buildParagraphsAI(options);

		expect(calls).toHaveLength(1); // the second canned response (a would-be retry) is never consumed
		expect(result.source).toBe("template");
		expect(result.failureReason).toContain("not eligible for trim");
	});

	it("every other rejection reason keeps retrying under AI_MAX_ATTEMPTS, untouched by this outcome — a digit rejection still gets its retry", async () => {
		const { client, calls } = fakeClient("provider.example.com", [okResult(fixtureText("observation-digit")), okResult(fixtureText("observation-good"))]);
		const options = baseOptions({ client, maxAttemptsPerModel: 2 });

		const result = await buildParagraphsAI(options);

		expect(calls).toHaveLength(2);
		expect(JSON.parse(calls[1]!.user).retryInstruction).toBeDefined();
		expect(result.source).toBe("ai"); // the retry succeeded
	});

	it("every other rejection reason keeps retrying under AI_MAX_ATTEMPTS, untouched by this outcome — a forbidden-pattern rejection still gets its retry", async () => {
		const { client, calls } = fakeClient("provider.example.com", [okResult(fixtureText("advice")), okResult(fixtureText("observation-good"))]);
		const options = baseOptions({ client, maxAttemptsPerModel: 2 });

		const result = await buildParagraphsAI(options);

		expect(calls).toHaveLength(2);
		expect(JSON.parse(calls[1]!.user).retryInstruction).toBeDefined();
		expect(result.source).toBe("ai"); // the retry succeeded
	});
});
