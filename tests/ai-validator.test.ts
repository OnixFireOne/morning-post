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
	it("rejects a multiplicity/fraction computed as words", () => expectRejected("derived-numbers", "validator:derived_numbers"));
});

describe("validateAiParagraphs: item 3 strips leader tickers before the HTML-tag check", () => {
	// Mirrors fixtures/escape-html.json's actual topLoser ticker exactly —
	// that's the real fixture that produced the false rejection.
	const htmlTickerPayload = buildAiPayload(specExampleFacts({ losers: [{ id: "test-html-coin", ticker: "<b>X", change24h: -17, price: 1, marketCap: null }] }), []);

	it("accepts a response that reproduces an allowed ticker containing HTML-like characters", () => {
		const text = JSON.stringify({
			picture: "Рой развернулся в минус: 133 монеты падают, растут только 14 из 147.",
			observation: "Антигерой дня — <b>X с -17%: разброс между лидерами растёт.",
			direction: "red",
		});
		const result = validateAiParagraphs(text, htmlTickerPayload);
		expect(result.ok).toBe(true);
	});

	it("still rejects a genuine HTML tag that isn't part of an allowed ticker", () => {
		const text = JSON.stringify({
			picture: "Рой развернулся в минус: 133 монеты падают, растут только 14 из 147.",
			observation: "<b>Внимание</b>: антигерой дня — <b>X с -17%.",
			direction: "red",
		});
		const result = validateAiParagraphs(text, htmlTickerPayload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("validator:forbidden_pattern");
	});
});

describe("validateAiParagraphs: item 3 rejects leaked English field names/values (green/red/mixed/swarmState/streak)", () => {
	it("rejects swarmState's own value used as an English adjective in prose", () => expectRejected("english-field-leak", "validator:forbidden_pattern"));

	it("still accepts a ticker that happens to spell one of the banned words, after stripKnownTickers", () => {
		// Same technique as the HTML-tag ticker test above — a real ticker
		// could plausibly be "RED" or similar; stripping the day's own tickers
		// first must keep this from sinking an otherwise-valid response.
		const tickerPayload = buildAiPayload(specExampleFacts({ winners: [{ id: "red-token", ticker: "RED", change24h: 18, price: 1, marketCap: null }] }), []);
		const text = JSON.stringify({
			picture: "Рой красный: RED вырвался в лидеры среди немногих растущих монет.",
			observation: "Биток держится спокойно, паники на рынке нет совсем.",
			direction: "red",
		});
		const result = validateAiParagraphs(text, tickerPayload);
		expect(result.ok).toBe(true);
	});

	it.each(["green", "Red", "MIXED", "swarmState", "Streak"])("rejects the bare word %s regardless of case", (word) => {
		const text = JSON.stringify({
			picture: `Рой сегодня в состоянии ${word}, судя по общей картине.`,
			observation: "Биток держится спокойно, паники на рынке нет совсем.",
			direction: "red",
		});
		const result = validateAiParagraphs(text, payload);
		expect(result.ok, `expected "${word}" to be rejected`).toBe(false);
		if (!result.ok) expect(result.reason).toBe("validator:forbidden_pattern");
	});
});

describe("validateAiParagraphs: item 9 (derived numbers in words) vs item 7 (day-count digit) don't collide", () => {
	it("accepts an ordinal day-count word that shares the 'треть-' prefix with the fraction word треть", () => {
		// "третьи" (agreeing with "сутки", a plural-only noun — "третий сутки"
		// would be ungrammatical) starts with the exact same letters as "треть"
		// (one third). item 9 matches "треть" as a bare word only, specifically
		// so this legitimate, spec-required day-count phrasing keeps passing.
		const result = validateAiParagraphs(response("day-count-third"), payload);
		expect(result.ok).toBe(true);
	});

	it.each(["вдвое", "втрое", "вчетверо", "в два раза", "в десять раз", "половина", "половины", "четверть", "четвертью", "две трети"])(
		"rejects %s as a self-computed ratio/fraction",
		(phrase) => {
			const text = JSON.stringify({ picture: `Рой красный: красных монет ${phrase} больше, чем зелёных.`, observation: "Биток держится спокойно, паники на рынке нет совсем.", direction: "red" });
			const result = validateAiParagraphs(text, payload);
			expect(result.ok, `expected "${phrase}" to be rejected`).toBe(false);
			if (!result.ok) expect(result.reason).toBe("validator:derived_numbers");
		},
	);

	it("does not reject the bare word треть's non-fraction relatives (третий/третьего/третьему/третьих)", () => {
		// Extra direct coverage beyond the fixture above — every oblique-case
		// form of the ordinal "third" that isn't "третий" itself starts with
		// "треть", and none of them should trip item 9.
		for (const word of ["третий", "третьего", "третьему", "третьих", "третьим", "третьими"]) {
			const text = JSON.stringify({ picture: `Рой красный ${word} день подряд без единой красной цифры в тексте.`, observation: "Биток держится спокойно, паники на рынке нет совсем.", direction: "red" });
			const result = validateAiParagraphs(text, payload);
			expect(result.ok, `expected "${word}" not to trip item 9`).toBe(true);
		}
	});
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
