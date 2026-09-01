import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAiPayload, type AiHistoryEntry } from "../src/ai/payload.js";
import { extractNumberTokens, findStreakWordMismatch, MAX_PARAGRAPH_LENGTH, validateAiObservation, validateAiParagraphs, type ValidationFailureReason } from "../src/ai/validator.js";
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
	// "third" as an ordinal day-count is only truthful when facts.streak is
	// actually 3 — item 10 (below) checks that now, so these two tests (which
	// predate item 10 and are specifically about item 9's own collision
	// avoidance, not about streak accuracy) need a payload where "third" is
	// actually correct, or item 10 would reject them for an unrelated reason
	// and mask the thing they're actually testing.
	const streakThreePayload = buildAiPayload(specExampleFacts({ streak: 3 }), []);

	it("accepts an ordinal day-count word that shares the 'треть-' prefix with the fraction word треть", () => {
		// "третьи" (agreeing with "сутки", a plural-only noun — "третий сутки"
		// would be ungrammatical) starts with the exact same letters as "треть"
		// (one third). item 9 matches "треть" as a bare word only, specifically
		// so this legitimate, spec-required day-count phrasing keeps passing.
		const result = validateAiParagraphs(response("day-count-third"), streakThreePayload);
		expect(result.ok).toBe(true);
	});

	it.each(["вдвое", "втрое", "вчетверо", "в два раза", "в десять раз", "половина", "половины", "четверть", "четвертью", "две трети", "кратно", "многократно", "в разы"])(
		"rejects %s as a self-computed ratio/fraction",
		(phrase) => {
			const text = JSON.stringify({ picture: `Рой красный: красных монет ${phrase} больше, чем зелёных.`, observation: "Биток держится спокойно, паники на рынке нет совсем.", direction: "red" });
			const result = validateAiParagraphs(text, payload);
			expect(result.ok, `expected "${phrase}" to be rejected`).toBe(false);
			if (!result.ok) expect(result.reason).toBe("validator:derived_numbers");
		},
	);

	it("rejects the exact live-found wording: \"кратно больше\" describing 50-vs-16 as an unwritten multiplicity", () => {
		const text = JSON.stringify({
			picture: "Рой встряхнулся и окрасился зелёным: зелёных монет кратно больше красных.",
			observation: "Биток держится спокойно, паники на рынке нет совсем.",
			direction: "green",
		});
		const result = validateAiParagraphs(text, buildAiPayload(specExampleFacts({ swarmState: "green", green: 50, red: 16, total: 66 }), []));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("validator:derived_numbers");
	});

	it("does not reject the bare word треть's non-fraction relatives (третий/третьего/третьему/третьих)", () => {
		// Extra direct coverage beyond the fixture above — every oblique-case
		// form of the ordinal "third" that isn't "третий" itself starts with
		// "треть", and none of them should trip item 9.
		for (const word of ["третий", "третьего", "третьему", "третьих", "третьим", "третьими"]) {
			const text = JSON.stringify({ picture: `Рой красный ${word} день подряд без единой красной цифры в тексте.`, observation: "Биток держится спокойно, паники на рынке нет совсем.", direction: "red" });
			const result = validateAiParagraphs(text, streakThreePayload);
			expect(result.ok, `expected "${word}" not to trip item 9`).toBe(true);
		}
	});
});

describe("findStreakWordMismatch: item 10 — word-form (ordinal) day-streak vs a real streak value", () => {
	// streak was removed from AiPayload entirely this session (a model that
	// can read it can also count matching-state entries in history instead —
	// the exact failure this check exists to catch, from the other side).
	// validateAiParagraphs no longer calls this at all (payload.today.streak
	// doesn't exist to call it with), so these test the standalone detection
	// function directly — still kept in the file for a possible rollback, per
	// validateAiParagraphs's own comment on why item 10 is unreachable now.

	it("flags «третий день подряд» when the real streak is actually 1 (streak reset, model counted history length instead)", () => {
		const mismatch = findStreakWordMismatch("Третий зелёный день подряд: рой уверенно держит курс наверх.", 1);
		expect(mismatch).not.toBeNull();
	});

	it("does not flag the exact same wording «третий день подряд» when the real streak actually is 3", () => {
		const mismatch = findStreakWordMismatch("Третий зелёный день подряд: рой уверенно держит курс наверх.", 3);
		expect(mismatch).toBeNull();
	});

	it.each([
		["второй", 2, 5],
		["четвёртый", 4, 1],
		["пятый", 5, 2],
	])("flags %s day-count when it doesn't match the real streak (word=%i, actual streak=%i)", (word, _wordValue, actualStreak) => {
		const mismatch = findStreakWordMismatch(`Рой держит зелёную серию: уже ${word} день подряд без единого сбоя.`, actualStreak);
		expect(mismatch, `expected "${word} день" with streak=${actualStreak} to be flagged`).not.toBeNull();
	});

	it("does not flag «первый зелёный день» when streak is 1, with an adjective between the ordinal and the day-word", () => {
		// Matches the real accepted step-1 wording exactly — an adjective
		// ("зелёный") sits between the ordinal and "день", not directly adjacent.
		const mismatch = findStreakWordMismatch("Рой пока держит первый зелёный день — посмотрим, наберёт ли он инерцию.", 1);
		expect(mismatch).toBeNull();
	});

	// Stem-collision guard (треть/третий) from item 9's own comment, checked
	// from the other side now that item 10 also matches "трет-" forms.
	it("does not match the bare fraction word треть (no day-word) as an ordinal", () => {
		const mismatch = findStreakWordMismatch("Рой красный: красных монет треть от общего числа.", 7);
		expect(mismatch).toBeNull();
	});

	it("does not match треть followed by a day-word nearby either — треть never has an ordinal suffix", () => {
		const mismatch = findStreakWordMismatch("Уже треть дня рой топчется на месте без единого движения.", 7);
		expect(mismatch).toBeNull();
	});
});

describe("validateAiParagraphs: streak-word-mismatch is dormant now, not a live rejection path", () => {
	it("accepts a streak-mismatched «третий день подряд» — payload no longer carries streak for item 10 to check against", () => {
		const twoGreenDaysHistory: AiHistoryEntry[] = ["Всё спокойно, без сюрпризов.", "Ничего необычного не происходило."];
		const mismatchedPayload = buildAiPayload(specExampleFacts({ swarmState: "green", streak: 1 }), twoGreenDaysHistory);
		const text = JSON.stringify({
			picture: "Третий зелёный день подряд: рой уверенно держит курс наверх.",
			observation: "Биток держится спокойно, паники на рынке нет совсем.",
			direction: "green",
		});
		const result = validateAiParagraphs(text, mismatchedPayload);
		expect(result.ok).toBe(true);
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
	// The value itself is derived from the 1024-char caption budget, not
	// chosen here — see tests/render.test.ts's worst-case-caption test for the
	// actual derivation and its own boundary check. This only guards the two
	// properties specific to *this* constant's role: hardcoded (shared with
	// the prompt, step 4), not an env knob.
	it("is a hardcoded constant shared with the prompt (step 4), not an env knob", () => {
		expect(MAX_PARAGRAPH_LENGTH).toBe(545);
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

// --- new one-paragraph contract (PROMPT_VERSION 7): picture is entirely
// code-generated (render.ts's pickPicture), never part of the model's
// response — the model returns only {observation, direction}. Items 1/7/9/10
// above (numbers whitelist, digit day-count, derived-number words, word-form
// streak mismatch) are validateAiParagraphs-only, not called here at all —
// see validator.ts's own comment on validateAiObservation for why the two
// checks below are broader supersets of what those four covered. ---

describe("validateAiObservation: happy path", () => {
	it("accepts a clean one-paragraph response with no picture field at all", () => {
		const text = '{"observation": "Лидер дня — TRAC, антигерой — PI: разброс между ними растёт быстрее, чем движется биток.", "direction": "red"}';
		const result = validateAiObservation(text, payload);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result.observation).toContain("TRAC");
			expect(result.result.direction).toBe("red");
		}
	});

	it("tolerates (and ignores) an extra picture field if the model sends one anyway", () => {
		const text = '{"picture": "Рой развернулся в минус: 133 монеты падают.", "observation": "Всё спокойно, биток держится ровно.", "direction": "red"}';
		const result = validateAiObservation(text, payload);
		// The picture field contains a digit, but validateAiObservation never
		// reads it — only observation is checked, so this must still pass.
		expect(result.ok).toBe(true);
	});
});

describe("validateAiObservation: new rejection — any digit at all, no whitelist", () => {
	it("rejects a digit in observation even though item 1's whitelist would have allowed it", () => {
		const result = validateAiObservation(response("observation-digit"), payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("validator:observation_digit");
	});

	it("rejects a digit that IS in payload.allowedNumbers — there is no whitelist exception on this path", () => {
		// "133" is red's own count — legitimately whitelisted for the old
		// contract (item 1), but the new contract has no exception for it at all.
		const text = '{"observation": "Сегодня падают 133 монеты.", "direction": "red"}';
		const result = validateAiObservation(text, payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("validator:observation_digit");
	});
});

describe("validateAiObservation: new rejection — any day-count mention, word or digit", () => {
	it("rejects a word-form day-count with no digit anywhere in the text", () => {
		const result = validateAiObservation(response("observation-day-count"), payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("validator:observation_day_count");
	});

	it("a digit-form day-count is still rejected, but as validator:observation_digit — the any-digit check runs first", () => {
		const text = '{"observation": "Уже 3 дня подряд рой топчется в минусе.", "direction": "red"}';
		const result = validateAiObservation(text, payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("validator:observation_digit");
	});
});

describe("validateAiObservation: new rejection — word-form multiplicity vs the real green/red ratio", () => {
	// green=50, red=16 is the exact live case that originally motivated
	// banning "кратно" outright (item 9's own commit) — the real ratio
	// (50/16 ≈ 3.1) genuinely supports both "кратно" and "в три раза", so a
	// blanket ban would have rejected a true statement. This check verifies
	// the claim against reality instead of banning the vocabulary.
	function ratioPayload(overrides: Partial<Facts> = {}) {
		return buildAiPayload(specExampleFacts({ swarmState: "green", red: 16, green: 50, total: 66, ...overrides }), []);
	}

	it("accepts «в три раза» at green=50/red=16 — the real ratio (≈3.1) rounds to 3", () => {
		const text = '{"observation": "Зелёных монет в три раза больше красных, биток держится ровно.", "direction": "green"}';
		const result = validateAiObservation(text, ratioPayload());
		expect(result.ok).toBe(true);
	});

	it("accepts «кратно» at green=50/red=16 — a genuine multiple (верная кратность)", () => {
		const text = '{"observation": "Зелёных монет кратно больше красных, биток держится ровно.", "direction": "green"}';
		const result = validateAiObservation(text, ratioPayload());
		expect(result.ok).toBe(true);
	});

	it("rejects «в три раза» when the real ratio doesn't round to 3", () => {
		// green=20/red=18 -> ratio ≈1.11, nowhere near 3.
		const text = '{"observation": "Зелёных монет в три раза больше красных, биток держится ровно.", "direction": "green"}';
		const result = validateAiObservation(text, ratioPayload({ red: 18, green: 20, total: 38 }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("validator:observation_ratio_mismatch");
	});

	it("rejects a generic «кратно» when the real ratio isn't genuinely a multiple", () => {
		// green=15/red=14 -> ratio ≈1.07, not "кратно" by any reasonable reading.
		const text = '{"observation": "Зелёных монет кратно больше красных, биток держится ровно.", "direction": "green"}';
		const result = validateAiObservation(text, ratioPayload({ red: 14, green: 15, total: 29 }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("validator:observation_ratio_mismatch");
	});

	it.each(["подавляющее большинство монет зелёные", "почти весь рой зелёный сегодня"])(
		"never rejects a qualitative claim with no numeric meaning (%s), regardless of the real ratio",
		(phrase) => {
			// Same mismatched ratio as the rejection case above — only the
			// wording changes, from a numeric claim to a qualitative one.
			const text = JSON.stringify({ observation: `${phrase[0]!.toUpperCase()}${phrase.slice(1)}, биток держится ровно.`, direction: "green" });
			const result = validateAiObservation(text, ratioPayload({ red: 18, green: 20, total: 38 }));
			expect(result.ok).toBe(true);
		},
	);
});

describe("validateAiObservation: items 1/7/9/10 are deliberately NOT applied on this path", () => {
	it("never rejects a multiplicity word purely for existing — item 9's blanket ban isn't called here", () => {
		// item 9 (validateAiParagraphs-only) would reject "кратно" outright,
		// no matter how accurate. This payload's own ratio (133 red vs 14
		// green ≈ 9.5x) genuinely supports "кратно" too, so this doesn't by
		// itself prove item 9 is bypassed — see the dedicated ratio-mismatch
		// describe block below for cases where the *new* check would reject
		// an inaccurate claim that item 9 would have banned for the wrong
		// reason (existing at all, not being wrong).
		const text = '{"observation": "Зелёных монет кратно больше красных.", "direction": "red"}';
		const result = validateAiObservation(text, payload);
		expect(result.ok).toBe(true);
	});
});

describe("validateAiObservation: everything else still applies", () => {
	it("rejects forbidden patterns", () => {
		const result = validateAiObservation(response("forecast"), payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("validator:forbidden_pattern");
	});

	it("rejects a direction mismatch", () => {
		const result = validateAiObservation(response("direction-mismatch"), payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("validator:direction");
	});

	it("rejects an empty observation", () => {
		const result = validateAiObservation(response("observation-empty"), payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("validator:empty_or_cutoff");
	});

	it("rejects non-Russian text", () => {
		const result = validateAiObservation(response("observation-english"), payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("validator:language");
	});

	it("rejects invalid JSON", () => {
		const result = validateAiObservation(response("invalid-json"), payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("invalid_json");
	});
});
