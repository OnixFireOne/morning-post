import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAiPayload } from "../src/ai/payload.js";
import { extractNumberTokens, MAX_PARAGRAPH_LENGTH, validateAiParagraphs, type ValidationFailureReason } from "../src/ai/validator.js";
import type { Facts } from "../src/facts.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ai-responses");

function response(name: string): string {
	return readFileSync(path.join(FIXTURES_DIR, `${name}.txt`), "utf8");
}

/** Same worked example as section 3 / tests/ai-payload.test.ts: 133/14/147, BTC −2.10%, TRAC +18%, PI −17%. */
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

const payload = buildAiPayload(specExampleFacts(), []);

function expectRejected(name: string, reason: ValidationFailureReason) {
	const result = validateAiParagraphs(response(name), payload);
	expect(result.ok, `expected fixture "${name}" to be rejected, but it passed`).toBe(false);
	if (!result.ok) expect(result.reason).toBe(reason);
}

describe("validateAiParagraphs: happy path", () => {
	it("accepts a well-formed response that only uses allowed numbers", () => {
		const result = validateAiParagraphs(response("good"), payload);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.paragraphs.direction).toBe("red");
			expect(result.paragraphs.picture).toContain("133");
			expect(result.paragraphs.observation).toContain("TRAC");
		}
	});

	it("extracts and validates JSON wrapped in prose — section 2's 'main scenario, not rare' for AI_STRUCTURED_OUTPUT=0", () => {
		const result = validateAiParagraphs(response("text-around-json"), payload);
		expect(result.ok).toBe(true);
	});

	it("accepts an ASCII hyphen as equivalent to the typographic minus in allowedNumbers", () => {
		// "good.txt" uses U+2212 for "−17%"; a model has no reason to know about
		// that character and will write a plain "-" instead.
		const asciiHyphen = response("good").replace(/−/g, "-");
		const result = validateAiParagraphs(asciiHyphen, payload);
		expect(result.ok).toBe(true);
	});
});

describe("validateAiParagraphs: section 8 bad-response fixtures", () => {
	it("rejects invalid JSON", () => expectRejected("invalid-json", "invalid_json"));
	it("rejects a number that isn't in facts", () => expectRejected("number-not-in-facts", "validator:numbers"));
	it("rejects forecast language", () => expectRejected("forecast", "validator:forbidden_pattern"));
	it("rejects buy/sell advice", () => expectRejected("advice", "validator:forbidden_pattern"));
	it("rejects a hashtag", () => expectRejected("hashtag", "validator:forbidden_pattern"));
	it("rejects an HTML tag", () => expectRejected("html-tag", "validator:forbidden_pattern"));
	it("rejects a direction that disagrees with facts.swarmState", () => expectRejected("direction-mismatch", "validator:direction"));
	it("rejects an empty paragraph", () => expectRejected("empty-paragraph", "validator:empty_or_cutoff"));
	it("rejects a paragraph over the length limit", () => expectRejected("over-length", "validator:length"));
	it("rejects an English-language response", () => expectRejected("english", "validator:language"));
	it("rejects a digit used as a day-streak count, regardless of facts.streak's actual value", () => expectRejected("streak-digit", "validator:streak_digit"));
});

describe("validateAiParagraphs: numbers vs streak-digit are independent checks", () => {
	it("a digit equal to streak is still fine as an unrelated allowed count, away from a day-word", () => {
		// streak=14 AND red=14 coincide on purpose — "14 монет" must NOT be
		// rejected just because it happens to equal streak's value.
		const coincidence = buildAiPayload(specExampleFacts({ streak: 14, red: 14 }), []);
		const text = '{"picture": "Рой развернулся в минус: 14 монет падают против 14 растущих.", "observation": "Биток держится спокойно, паники на рынке нет совсем.", "direction": "red"}';
		const result = validateAiParagraphs(text, coincidence);
		expect(result.ok).toBe(true);
	});

	it("a day-count digit is rejected even when it does NOT match facts.streak at all", () => {
		// facts.streak is 1 here — "5-й день" is wrong on the facts too, but the
		// point of section 4's rule is that it's rejected for being a digit next
		// to a day-word, not for disagreeing with the real streak number.
		const text = '{"picture": "Рой красный уже 5-й день подряд: 133 монеты падают против 14 растущих.", "observation": "Биток держится спокойно, паники на рынке нет совсем.", "direction": "red"}';
		const result = validateAiParagraphs(text, payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("validator:streak_digit");
	});
});

describe("validateAiParagraphs: language check strips known tickers/BTC first", () => {
	it("does not fail a Russian paragraph just for containing Latin tickers or BTC", () => {
		const text =
			'{"picture": "Рой развернулся в минус: 133 монеты падают против 14 растущих.", "observation": "Лидер дня TRAC против антигероя PI, пока BTC держится ровно.", "direction": "red"}';
		const result = validateAiParagraphs(text, payload);
		expect(result.ok).toBe(true);
	});
});

describe("MAX_PARAGRAPH_LENGTH", () => {
	it("is 320, a hardcoded constant shared with the prompt (step 4), not an env knob", () => {
		expect(MAX_PARAGRAPH_LENGTH).toBe(320);
	});
});

describe("extractNumberTokens", () => {
	it("pulls out signed/percent/dollar/comma-grouped numbers from free text", () => {
		expect(extractNumberTokens("цена $76,150, изменение −2.10% и ещё 133 монеты")).toEqual(["$76,150", "−2.10%", "133"]);
	});

	it("finds nothing in text with no digits", () => {
		expect(extractNumberTokens("рой держится спокойно")).toEqual([]);
	});
});
