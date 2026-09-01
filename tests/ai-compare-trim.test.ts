import { describe, expect, it } from "vitest";
import type { AiClient, AiGenerateParams, AiGenerateResult } from "../src/ai/client.js";
import { buildAiPayload } from "../src/ai/payload.js";
import type { Facts } from "../src/facts.js";
import { formatSummary, outcomeLabel, runOneWithOptionalRetry, runTotals, verdictText, type FixtureRun, type RunOneOutcome } from "../tools/ai-compare.js";

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

const threeSentenceDayCount =
	'{"observation": "Второй день подряд биток топчется в минусе — красных монет заметно больше зелёных. TRAC держится крепче остальных, почти не поддаваясь давлению. PI, наоборот, проседает быстрее прочих, оставаясь в числе главных аутсайдеров.", "direction": "red"}';

describe("runOneWithOptionalRetry: third outcome — trimmed", () => {
	it("returns kind: trimmed, with the cut observation, the original, and the removed sentence — no retry call even with retry: true", async () => {
		const { client, calls } = fakeClient([okResult(threeSentenceDayCount)]);
		const { outcome, retryOutcome } = await runOneWithOptionalRetry(client, "m", "sys", "user", 1000, payload, null, null, facts, true);

		expect(calls).toHaveLength(1); // trimming replaces the retry entirely
		expect(outcome.kind).toBe("trimmed");
		expect(retryOutcome).toBeUndefined();
		if (outcome.kind !== "trimmed") throw new Error("expected kind: trimmed");
		expect(outcome.removedSentence).toContain("Второй день подряд");
		expect(outcome.originalObservation).toContain("Второй день подряд");
		expect(outcome.observation).not.toContain("Второй день подряд");
		expect(outcome.picture).toBeTruthy();
		expect(outcome.direction).toBe("red");
	});

	it("a retry attempt can itself land on trimmed — same handling either way", async () => {
		const digitObservation = '{"observation": "Всё спокойно, биток держится ровно, но альты штормит на 5%.", "direction": "red"}';
		const { client } = fakeClient([okResult(digitObservation), okResult(threeSentenceDayCount)]);
		const { outcome, retryOutcome } = await runOneWithOptionalRetry(client, "m", "sys", "user", 1000, payload, null, null, facts, true);

		expect(outcome.kind).toBe("rejected");
		expect(retryOutcome?.kind).toBe("trimmed");
	});
});

describe("outcomeLabel/verdictText: trimmed reads as its own grade, not folded into accepted or rejected", () => {
	const trimmedOutcome: RunOneOutcome = {
		kind: "trimmed",
		picture: "p",
		observation: "o",
		direction: "red",
		originalObservation: "original o",
		removedSentence: "Второй день подряд.",
		tokensIn: 1,
		tokensOut: 1,
		durationMs: 1,
		costEstimate: null,
		rawUsage: null,
	};

	it("outcomeLabel", () => {
		expect(outcomeLabel(trimmedOutcome)).toBe("trimmed (cut 1 sentence)");
	});

	it("verdictText", () => {
		expect(verdictText(trimmedOutcome)).toBe("✂️ починено вырезанием");
	});
});

describe("runTotals: a trimmed attempt's tokens/cost count toward real spend, same as accepted/rejected", () => {
	it("sums a trimmed outcome's own tokens/cost when there was no retry", () => {
		const fr: FixtureRun = {
			fixtureName: "f",
			run: 1,
			outcome: { kind: "trimmed", picture: "p", observation: "o", direction: "red", originalObservation: "orig", removedSentence: "cut.", tokensIn: 100, tokensOut: 40, durationMs: 1, costEstimate: 1, rawUsage: null },
		};
		expect(runTotals(fr)).toEqual({ tokensIn: 100, tokensOut: 40, costEstimate: 1 });
	});
});

describe("formatSummary: trimmed gets its own line, separate from Принято and Отклонено/ошибок", () => {
	function acceptedRun(run: number): FixtureRun {
		return { fixtureName: "f", run, outcome: { kind: "accepted", picture: "p", observation: "o", direction: "red", tokensIn: 1, tokensOut: 1, durationMs: 1, costEstimate: null, rawUsage: null } };
	}
	function trimmedRun(run: number): FixtureRun {
		return {
			fixtureName: "f",
			run,
			outcome: { kind: "trimmed", picture: "p", observation: "o", direction: "red", originalObservation: "orig", removedSentence: "cut.", tokensIn: 1, tokensOut: 1, durationMs: 1, costEstimate: null, rawUsage: null },
		};
	}
	function rejectedRun(run: number): FixtureRun {
		return {
			fixtureName: "f",
			run,
			outcome: { kind: "rejected", reason: "validator:observation_digit", detail: "d", rawResponse: "r", tokensIn: 1, tokensOut: 1, durationMs: 1, costEstimate: null, rawUsage: null },
		};
	}

	it("counts trimmed separately, and excludes it from both Принято and Отклонено/ошибок", () => {
		const runs = [acceptedRun(1), trimmedRun(2), trimmedRun(3), rejectedRun(4)];
		const summary = formatSummary(runs, 1000);

		expect(summary).toContain("Всего прогонов: 4");
		expect(summary).toContain("Принято: 1 (25%)");
		expect(summary).toContain("Починено вырезанием предложения: 2 (50%)");
		expect(summary).toContain("Отклонено/ошибок: 1"); // not 3 — trimmed isn't a rejection
	});

	it("omits the trimmed line entirely when nothing was trimmed", () => {
		const runs = [acceptedRun(1), rejectedRun(2)];
		const summary = formatSummary(runs, 1000);
		expect(summary).not.toContain("Починено вырезанием");
	});
});
