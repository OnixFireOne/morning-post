import { describe, expect, it } from "vitest";
import type { AiClient, AiGenerateParams, AiGenerateResult } from "../src/ai/client.js";
import { buildAiPayload } from "../src/ai/payload.js";
import type { AiProviderProfile } from "../src/ai/providers.js";
import type { Facts } from "../src/facts.js";
import type { TrimmableFailureReason } from "../src/ai/validator.js";
import { formatRunSection, formatSummary, outcomeLabel, runOneWithOptionalRetry, runTotals, verdictText, type FixtureRun, type RunOneOutcome } from "../tools/ai-compare.js";

function testProvider(overrides: Partial<AiProviderProfile> = {}): AiProviderProfile {
	return {
		name: "test-provider",
		baseUrl: "https://provider.example.com",
		authStyle: "bearer",
		extraHeaders: {},
		primaryModel: "m",
		fallbackModel: "m",
		costSource: "table",
		priceTable: {},
		inputOverhead: 0,
		balanceSource: "manual",
		unitRate: 1,
		...overrides,
	};
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
		responseProvider: null,
		responseModel: null,
		openrouterMetadata: null,
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
		const { outcome, retryOutcome } = await runOneWithOptionalRetry(client, "m", "sys", "user", 1000, payload, testProvider(), facts, true);

		expect(calls).toHaveLength(1); // trimming replaces the retry entirely
		expect(outcome.kind).toBe("trimmed");
		expect(retryOutcome).toBeUndefined();
		if (outcome.kind !== "trimmed") throw new Error("expected kind: trimmed");
		expect(outcome.reason).toBe("validator:observation_day_count");
		expect(outcome.removedSentence).toContain("Второй день подряд");
		expect(outcome.originalObservation).toContain("Второй день подряд");
		expect(outcome.observation).not.toContain("Второй день подряд");
		expect(outcome.picture).toBeTruthy();
		expect(outcome.direction).toBe("red");
	});

	it("a retry attempt can itself land on trimmed — same handling either way", async () => {
		const digitObservation = '{"observation": "Всё спокойно, биток держится ровно, но альты штормит на 5%.", "direction": "red"}';
		const { client } = fakeClient([okResult(digitObservation), okResult(threeSentenceDayCount)]);
		const { outcome, retryOutcome } = await runOneWithOptionalRetry(client, "m", "sys", "user", 1000, payload, testProvider(), facts, true);

		expect(outcome.kind).toBe("rejected");
		expect(retryOutcome?.kind).toBe("trimmed");
	});

	// 02.09 regression: the 19:04 report labeled all three trims "day count"
	// (a hardcoded label in formatRunSection) even though the raw texts were
	// 559/604/639 chars against the 545 limit — actually validator:length.
	// outcome.reason must reflect what validateAiObservation actually
	// rejected for, not the mechanism's original (day-count-only) case.
	it("a length-overflow response also lands on trimmed, tagged reason: validator:length — not day-count", async () => {
		const s1 =
			"Рой уверенно движется вперёд без резких рывков, и общий настрой участников остаётся ровным и спокойным на протяжении всего наблюдения, без каких-либо всплесков паники или эйфории, которые могли бы исказить общую картину происходящего на рынке в этот момент времени.";
		const s2 =
			"Капитал распределяется широким фронтом, не концентрируясь в одной точке, а спокойно перетекая между разными активами по мере того, как участники присматриваются к новым возможностям и стараются действовать без лишней спешки и суеты.";
		const s3 = "Настроение остаётся ровнымыыыыыыыыыыыыыыыыыыыы.";
		const overLengthObservation = `${s1} ${s2} ${s3}`;
		expect(overLengthObservation.length).toBe(546); // one over the 545 limit
		const rawText = JSON.stringify({ observation: overLengthObservation, direction: "red" });

		const { client } = fakeClient([okResult(rawText)]);
		const { outcome } = await runOneWithOptionalRetry(client, "m", "sys", "user", 1000, payload, testProvider(), facts, false);

		expect(outcome.kind).toBe("trimmed");
		if (outcome.kind !== "trimmed") throw new Error("expected kind: trimmed");
		expect(outcome.reason).toBe("validator:length");
		expect(outcome.removedSentence).toBe(s3);
		expect(outcome.observation).toBe(`${s1} ${s2}`);
	});
});

describe("outcomeLabel/verdictText: trimmed reads as its own grade, not folded into accepted or rejected", () => {
	const trimmedOutcome: RunOneOutcome = {
		kind: "trimmed",
		reason: "validator:observation_day_count",
		detail: null,
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
		modelIdentity: { openrouterMetadata: null, responseModel: null, responseProvider: null },
	};

	it("outcomeLabel", () => {
		expect(outcomeLabel(trimmedOutcome)).toBe("trimmed (cut 1 sentence)");
	});

	it("verdictText", () => {
		expect(verdictText(trimmedOutcome)).toBe("✂️ починено вырезанием");
	});
});

// 02.09 regression, display level: formatRunSection's own "Вердикт:" line
// used to hardcode the day-count mechanism's description regardless of
// outcome.reason. This checks the actual rendered report text, not just
// that the data carries the right reason.
describe("formatRunSection: the trimmed verdict line names the actual reason, not a hardcoded one", () => {
	function trimmedFixtureRun(reason: TrimmableFailureReason, detail: string | null = null): FixtureRun {
		return {
			fixtureName: "f",
			run: 1,
			outcome: {
				kind: "trimmed",
				reason,
				detail,
				picture: "p",
				observation: "o",
				direction: "red",
				originalObservation: "orig",
				removedSentence: "cut.",
				tokensIn: 1,
				tokensOut: 1,
				durationMs: 1,
				costEstimate: null,
				rawUsage: null,
				modelIdentity: { openrouterMetadata: null, responseModel: null, responseProvider: null },
			},
		};
	}

	it("day-count reason: verdict line mentions the day-count validator item", () => {
		const section = formatRunSection(trimmedFixtureRun("validator:observation_day_count"), 1);
		expect(section).toContain("Вердикт: ✂️ починено вырезанием предложения");
		expect(section).toContain("новое: любой счёт дней (словом или цифрой)");
		expect(section).not.toContain("п.2 длина");
	});

	it("length reason: verdict line mentions п.2 длина, not the day-count wording", () => {
		const section = formatRunSection(trimmedFixtureRun("validator:length"), 1);
		expect(section).toContain("Вердикт: ✂️ починено вырезанием предложения");
		expect(section).toContain("п.2 длина");
		expect(section).not.toContain("счёт дней");
	});

	it("forbidden_pattern reason: verdict line names the specific matched pattern (outcome.detail), not just the generic п.3 label", () => {
		const section = formatRunSection(trimmedFixtureRun("validator:forbidden_pattern", "forecast language"), 1);
		expect(section).toContain("Вердикт: ✂️ починено вырезанием предложения");
		expect(section).toContain("п.3 запрещённые паттерны: forecast language");
		expect(section).toContain("вырезано предложение с сработавшим паттерном");
	});
});

describe("runTotals: a trimmed attempt's tokens/cost count toward real spend, same as accepted/rejected", () => {
	it("sums a trimmed outcome's own tokens/cost when there was no retry", () => {
		const fr: FixtureRun = {
			fixtureName: "f",
			run: 1,
			outcome: { kind: "trimmed", reason: "validator:observation_day_count", detail: null, picture: "p", observation: "o", direction: "red", originalObservation: "orig", removedSentence: "cut.", tokensIn: 100, tokensOut: 40, durationMs: 1, costEstimate: 1, rawUsage: null, modelIdentity: { openrouterMetadata: null, responseModel: null, responseProvider: null } },
		};
		expect(runTotals(fr)).toEqual({ tokensIn: 100, tokensOut: 40, costEstimate: 1 });
	});
});

describe("formatSummary: trimmed gets its own line, separate from Принято and Отклонено/ошибок", () => {
	function acceptedRun(run: number): FixtureRun {
		return { fixtureName: "f", run, outcome: { kind: "accepted", picture: "p", observation: "o", direction: "red", tokensIn: 1, tokensOut: 1, durationMs: 1, costEstimate: null, rawUsage: null, modelIdentity: { openrouterMetadata: null, responseModel: null, responseProvider: null } } };
	}
	function trimmedRun(run: number): FixtureRun {
		return {
			fixtureName: "f",
			run,
			outcome: { kind: "trimmed", reason: "validator:observation_day_count", detail: null, picture: "p", observation: "o", direction: "red", originalObservation: "orig", removedSentence: "cut.", tokensIn: 1, tokensOut: 1, durationMs: 1, costEstimate: null, rawUsage: null, modelIdentity: { openrouterMetadata: null, responseModel: null, responseProvider: null } },
		};
	}
	function rejectedRun(run: number): FixtureRun {
		return {
			fixtureName: "f",
			run,
			outcome: { kind: "rejected", reason: "validator:observation_digit", detail: "d", rawResponse: "r", tokensIn: 1, tokensOut: 1, durationMs: 1, costEstimate: null, rawUsage: null, modelIdentity: { openrouterMetadata: null, responseModel: null, responseProvider: null } },
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
