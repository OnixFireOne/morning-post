import { describe, expect, it } from "vitest";
import type { AiClient, AiGenerateParams, AiGenerateResult } from "../src/ai/client.js";
import { buildAiPayload } from "../src/ai/payload.js";
import type { Facts } from "../src/facts.js";
import { finalOutcome, outcomeLabel, runOneWithOptionalRetry, runTotals, type FixtureRun, type RunOneOutcome } from "../tools/ai-compare.js";

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

const facts = specExampleFacts();
const payload = buildAiPayload(facts, []);

function okResult(content: string, overrides: Partial<AiGenerateResult> = {}): AiGenerateResult {
	return {
		ok: true,
		content,
		finishReason: "stop",
		usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedTokens: null },
		usageReported: true,
		httpStatus: 200,
		durationMs: 5,
		errorKind: null,
		errorMessage: null,
		rawUsage: null,
		...overrides,
	};
}

function failResult(overrides: Partial<AiGenerateResult> = {}): AiGenerateResult {
	return {
		ok: false,
		content: null,
		finishReason: null,
		usage: null,
		usageReported: false,
		httpStatus: 500,
		durationMs: 5,
		errorKind: "http_error",
		errorMessage: "boom",
		rawUsage: null,
		...overrides,
	};
}

const cleanObservation = '{"observation": "Лидер дня — TRAC, антигерой — PI: разброс между ними растёт быстрее, чем движется биток.", "direction": "red"}';
const digitObservation = '{"observation": "Всё спокойно, биток держится ровно, но альты штормит на 5%.", "direction": "red"}';

/** A fully in-memory AiClient — no fetch, no undici, just a queue of canned results and a call log. */
function fakeClient(responses: AiGenerateResult[]): { client: AiClient; calls: AiGenerateParams[] } {
	const calls: AiGenerateParams[] = [];
	let index = 0;
	const client: AiClient = {
		providerHost: "mock.local",
		async generate(params) {
			calls.push(params);
			const result = responses[index++];
			if (!result) throw new Error(`fakeClient: no canned response queued for call #${index}`);
			return result;
		},
		async listModels() {
			return [];
		},
	};
	return { client, calls };
}

describe("runOneWithOptionalRetry", () => {
	it("makes only one call when retry is false, even on a content-level rejection", async () => {
		const { client, calls } = fakeClient([okResult(digitObservation)]);
		const { outcome, retryOutcome } = await runOneWithOptionalRetry(client, "m", "sys", "user", 1000, payload, null, null, facts, false);
		expect(calls).toHaveLength(1);
		expect(outcome.kind).toBe("rejected");
		expect(retryOutcome).toBeUndefined();
	});

	it("retries once on a content-level rejection when retry is true, using buildRetryObservationPrompt's own instruction", async () => {
		const { client, calls } = fakeClient([okResult(digitObservation), okResult(cleanObservation)]);
		const { outcome, retryOutcome } = await runOneWithOptionalRetry(client, "m", "sys", "user", 1000, payload, null, null, facts, true);

		expect(calls).toHaveLength(2);
		expect(outcome.kind).toBe("rejected");
		expect(retryOutcome?.kind).toBe("accepted");

		// The retry call's user message must be the real retry-shaped prompt,
		// not the original user message repeated — same targeted instruction
		// generate.ts's own retry builds, keyed by the exact rejection reason.
		const retryUser = JSON.parse(calls[1]!.user) as { retryInstruction?: string };
		expect(retryUser.retryInstruction).toBeDefined();
		expect(retryUser.retryInstruction).toMatch(/цифр/i);
		expect(calls[1]!.user).not.toBe(calls[0]!.user);
	});

	it("does not retry when the first attempt is already accepted", async () => {
		const { client, calls } = fakeClient([okResult(cleanObservation)]);
		const { outcome, retryOutcome } = await runOneWithOptionalRetry(client, "m", "sys", "user", 1000, payload, null, null, facts, true);
		expect(calls).toHaveLength(1);
		expect(outcome.kind).toBe("accepted");
		expect(retryOutcome).toBeUndefined();
	});

	it("does not retry a transport failure — matches generate.ts's own retry-vs-fallback split (transport moves to a different model in production; this tool has none to move to)", async () => {
		const { client, calls } = fakeClient([failResult()]);
		const { outcome, retryOutcome } = await runOneWithOptionalRetry(client, "m", "sys", "user", 1000, payload, null, null, facts, true);
		expect(calls).toHaveLength(1);
		expect(outcome.kind).toBe("transport");
		expect(retryOutcome).toBeUndefined();
	});

	it("the retry attempt can itself be rejected again — finalOutcome then reads as the second rejection, not the first", async () => {
		const { client, calls } = fakeClient([okResult(digitObservation), okResult(digitObservation)]);
		const { outcome, retryOutcome } = await runOneWithOptionalRetry(client, "m", "sys", "user", 1000, payload, null, null, facts, true);
		expect(calls).toHaveLength(2);
		expect(outcome.kind).toBe("rejected");
		expect(retryOutcome?.kind).toBe("rejected");
	});
});

describe("finalOutcome", () => {
	it("returns the first attempt's outcome when no retry happened", () => {
		const fr: FixtureRun = { fixtureName: "f", run: 1, outcome: { kind: "accepted", picture: "p", observation: "o", direction: "red", tokensIn: 1, tokensOut: 1, durationMs: 1, costEstimate: null, rawUsage: null } };
		expect(finalOutcome(fr).kind).toBe("accepted");
	});

	it("returns the retry's own outcome when one is present, not the original rejection", () => {
		const fr: FixtureRun = {
			fixtureName: "f",
			run: 1,
			outcome: { kind: "rejected", reason: "validator:observation_digit", detail: "d", rawResponse: "r", tokensIn: 1, tokensOut: 1, durationMs: 1, costEstimate: null, rawUsage: null },
			retryOutcome: { kind: "accepted", picture: "p", observation: "o", direction: "red", tokensIn: 1, tokensOut: 1, durationMs: 1, costEstimate: null, rawUsage: null },
		};
		expect(finalOutcome(fr).kind).toBe("accepted");
	});
});

describe("outcomeLabel", () => {
	it("formats each outcome kind for the console progress line", () => {
		const accepted: RunOneOutcome = { kind: "accepted", picture: "p", observation: "o", direction: "red", tokensIn: 1, tokensOut: 1, durationMs: 1, costEstimate: null, rawUsage: null };
		const rejected: RunOneOutcome = {
			kind: "rejected",
			reason: "validator:observation_digit",
			detail: "d",
			rawResponse: "r",
			tokensIn: 1,
			tokensOut: 1,
			durationMs: 1,
			costEstimate: null,
			rawUsage: null,
		};
		const transport: RunOneOutcome = { kind: "transport", label: "таймаут", errorMessage: null, durationMs: 1 };

		expect(outcomeLabel(accepted)).toBe("ok");
		expect(outcomeLabel(rejected)).toBe("rejected (validator:observation_digit)");
		expect(outcomeLabel(transport)).toBe("transport (таймаут)");
	});
});

describe("runTotals: real spend per run, both attempts summed when a retry happened", () => {
	it("sums tokens/cost across the first attempt and the retry when both are known", () => {
		const fr: FixtureRun = {
			fixtureName: "f",
			run: 1,
			outcome: { kind: "rejected", reason: "validator:observation_digit", detail: "d", rawResponse: "r", tokensIn: 100, tokensOut: 40, durationMs: 1, costEstimate: 1, rawUsage: null },
			retryOutcome: { kind: "accepted", picture: "p", observation: "o", direction: "red", tokensIn: 80, tokensOut: 30, durationMs: 1, costEstimate: 0.8, rawUsage: null },
		};
		expect(runTotals(fr)).toEqual({ tokensIn: 180, tokensOut: 70, costEstimate: 1.8 });
	});

	it("returns just the single attempt's own totals when there was no retry", () => {
		const fr: FixtureRun = { fixtureName: "f", run: 1, outcome: { kind: "accepted", picture: "p", observation: "o", direction: "red", tokensIn: 100, tokensOut: 40, durationMs: 1, costEstimate: 1, rawUsage: null } };
		expect(runTotals(fr)).toEqual({ tokensIn: 100, tokensOut: 40, costEstimate: 1 });
	});

	it("a transport attempt contributes nothing (it never has tokens), but doesn't null out a known sibling attempt", () => {
		const fr: FixtureRun = {
			fixtureName: "f",
			run: 1,
			outcome: { kind: "rejected", reason: "validator:observation_digit", detail: "d", rawResponse: "r", tokensIn: 100, tokensOut: 40, durationMs: 1, costEstimate: 1, rawUsage: null },
			retryOutcome: { kind: "transport", label: "таймаут", errorMessage: null, durationMs: 1 },
		};
		expect(runTotals(fr)).toEqual({ tokensIn: 100, tokensOut: 40, costEstimate: 1 });
	});

	it("returns all-null when nothing is known at all (e.g. a lone transport failure, or --chain-degrade's forced template)", () => {
		const transportOnly: FixtureRun = { fixtureName: "f", run: 1, outcome: { kind: "transport", label: "таймаут", errorMessage: null, durationMs: 1 } };
		expect(runTotals(transportOnly)).toEqual({ tokensIn: null, tokensOut: null, costEstimate: null });

		const forced: FixtureRun = { fixtureName: "f", run: 1, outcome: { kind: "forced", template: { picture: "p", winnerLine: "w", loserLine: "l", observation: "o" } } };
		expect(runTotals(forced)).toEqual({ tokensIn: null, tokensOut: null, costEstimate: null });
	});
});
