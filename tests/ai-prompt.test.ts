import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAiPayload } from "../src/ai/payload.js";
import { buildRetryObservationPrompt, buildRetryUserPrompt, buildSystemPrompt, buildUserPrompt } from "../src/ai/prompt.js";
import { MAX_PARAGRAPH_LENGTH, validateAiObservation, validateAiParagraphs, type ObservationValidationFailureReason, type ValidationFailureReason } from "../src/ai/validator.js";
import type { Facts } from "../src/facts.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ai-responses");

function response(name: string): string {
	return readFileSync(path.join(FIXTURES_DIR, `${name}.txt`), "utf8");
}

/** Same worked example as tests/ai-payload.test.ts and tests/ai-validator.test.ts. */
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

const ALL_REASONS: ValidationFailureReason[] = [
	"invalid_json",
	"validator:numbers",
	"validator:length",
	"validator:forbidden_pattern",
	"validator:direction",
	"validator:empty_or_cutoff",
	"validator:streak_digit",
	"validator:language",
	"validator:derived_numbers",
	"validator:streak_word_mismatch",
];

describe("buildSystemPrompt: length limit comes from the same constant the validator reads", () => {
	it("interpolates MAX_PARAGRAPH_LENGTH itself, not a restated literal", () => {
		const system = buildSystemPrompt();
		expect(system).toContain(String(MAX_PARAGRAPH_LENGTH));
	});

	it("would still be correct if the shared constant changed — proven by asserting against the import, not the number 320", () => {
		// This test doesn't hardcode "320" anywhere. If validator.ts's constant
		// ever changes, this assertion tracks it automatically; a version of
		// prompt.ts that had its own separate "320" literal would still pass a
		// test that checked for "320" specifically, which is exactly the drift
		// this is meant to catch.
		expect(MAX_PARAGRAPH_LENGTH).toBeGreaterThan(0);
		expect(buildSystemPrompt().includes(`${MAX_PARAGRAPH_LENGTH} символов`)).toBe(true);
	});
});

describe("buildSystemPrompt: day-count is entirely paragraph 1's concern (PROMPT_VERSION 7), not something the model phrases", () => {
	// PROMPT_VERSION 1-6's ДНИ ПОДРЯД rule (still true, no longer relevant
	// here) governed HOW the model could phrase a day-count — word not digit,
	// value must match facts.streak. PROMPT_VERSION 7 moves the day-count out
	// of the model's output entirely: paragraph 1 (picture) is code-generated
	// via render.ts's pickPicture, which already includes it when streak >= 2.
	// The model is told not to mention it at all, not told how to phrase it.
	it("tells the model not to write the day number — it already lives in paragraph 1", () => {
		const system = buildSystemPrompt();
		expect(system).toMatch(/О номере дня не писать/);
		expect(system).toMatch(/это в первом абзаце/);
	});

	it("does not take facts/streak as a parameter — nothing here can degrade into a per-day number leak even by accident", () => {
		expect(buildSystemPrompt.length).toBe(0);
	});
});

describe("buildSystemPrompt: covers the rest of section 4", () => {
	const system = buildSystemPrompt();

	it("bans forecasts, advice, hashtags, links, HTML tags, and emoji", () => {
		expect(system).toMatch(/прогноз/i);
		expect(system).toMatch(/купить|продать/i);
		expect(system).toMatch(/хэштег/i);
		expect(system).toMatch(/ссылк/i);
		expect(system).toMatch(/html/i);
		expect(system).toMatch(/эмодзи/i);
	});

	it("states the null-field rule and the anti-repeat rule", () => {
		expect(system).toMatch(/null/);
		expect(system).toMatch(/history/);
	});

	it("asks for Russian and for strict JSON with exactly observation/direction — no picture field at all", () => {
		expect(system).toMatch(/русск/i);
		expect(system).toContain('"observation"');
		expect(system).toContain('"direction"');
		// Not optional, not omitted-but-tolerated — removed from the contract
		// entirely (PROMPT_VERSION 7): an optional field a model can still
		// choose to fill is a field that eventually reappears in the post.
		expect(system).not.toContain('"picture"');
	});
});

describe("buildSystemPrompt: PROMPT_VERSION 2 additions — manual verification findings, 2026-08-24", () => {
	const system = buildSystemPrompt();

	it("tells the model not to invent anything about previous days when history is empty", () => {
		// Found during manual verification: with an empty history the model
		// twice guessed at an "after the quiet" narrative that never happened.
		// The rule has to name the empty-history case explicitly — "don't
		// repeat history's own wording" (the pre-existing anti-repeat rule
		// above) doesn't cover inventing something history never said at all.
		expect(system).toMatch(/history пуст/);
	});
});

describe("buildSystemPrompt: PROMPT_VERSION 3 additions — manual verification findings, 2026-08-25", () => {
	const system = buildSystemPrompt();

	it("bans restating the BTC/leader lines' own price/percent, but allows naming the leader tickers", () => {
		// v2's rule banned tickers too, which made the model go vague ("один из
		// лидеров вырвался особенно резко") instead of naming names — the
		// ticker itself isn't a duplicate of anything, only its number is
		// (that number already has its own dedicated line in the post).
		expect(system).toMatch(/эти цифры \(но не сами тикеры\) не пиши ещё раз/);
		expect(system).toMatch(/Тикеры лидеров называть можно и нужно/);
	});

	it("keeps the BTC-in-words guidance from v2 unchanged", () => {
		expect(system).toMatch(/биток рванул вверх/i);
	});

	// The multiplicity/fraction vocabulary this block used to enumerate here
	// (вдвое/половина/треть/кратно/...) is gone from ЧИСЛА as of PROMPT_VERSION
	// 7 — ЧИСЛА is now one line ("Цифр в абзаце нет вовсе"), a blanket ban
	// that makes enumerating digit-adjacent phrasing moot. It does NOT extend
	// to non-digit ratio words like "вдвое"/"кратно" though — that was item
	// 9's job, and item 9 is deliberately not called by validateAiObservation
	// (see validator.ts's own comment on the new one-paragraph contract) — a
	// known, deliberate gap, not an oversight. See "PROMPT_VERSION 7" below
	// for what's actually checked now.
});

describe("buildSystemPrompt: PROMPT_VERSION 4 additions — manual verification findings, 2026-08-25", () => {
	const system = buildSystemPrompt();

	it("bans mentioning dateLabel in the paragraphs — it's the post header's own line", () => {
		// Found on the first --all run: two rejections out of ten were the
		// model opening with "18 августа рой накрыло…" — the day number isn't
		// in allowedNumbers, so item 1 already rejected it correctly, but
		// telling the model not to reach for the date at all avoids the wasted
		// retry instead of just catching it after the fact.
		expect(system).toMatch(/dateLabel.*не пиши её в абзаце/);
	});

	it("bans narrating the empty-history state itself, not just inventing a false past", () => {
		// Found on the edge-empty fixture: the model wrote "Контекста прошлых
		// дней нет, судим только по сегодняшнему срезу" — technically accurate,
		// but it's the model describing its own input data. The reader never
		// sees the payload and shouldn't be able to infer that such a field
		// exists at all.
		expect(system).toMatch(/Пустая history — повод молчать о прошлом, а не тема для абзаца/);
		expect(system).toMatch(/не должен даже заподозрить/);
	});
});

describe("buildSystemPrompt: PROMPT_VERSION 5 additions — manual verification findings, 2026-08-25", () => {
	const system = buildSystemPrompt();

	it("bans narrating the anti-repeat mechanism itself — not as a repeat, not as \"yesterday's image/scenario\"", () => {
		// Live response: "рой сохраняет единодушие, хотя вчерашний образ «почти
		// весь рой» уже использован" — the model narrating its own anti-repeat
		// process out loud. Same class as the empty-history leak above: history
		// (empty or not) is an internal technical detail the reader never sees.
		// Unchanged by PROMPT_VERSION 7 — still verbatim in ПОВТОРЫ.
		expect(system).toMatch(/не называй что-то повтором/);
		expect(system).toMatch(/вчерашний образ/);
		expect(system).toMatch(/вчерашний сценарий/);
	});

	// This block's other two PROMPT_VERSION 5 findings — the "streak comes
	// from facts.streak, not history length" sentence and the "кратно" ban —
	// governed HOW the model phrased a day-count/multiplicity in observation.
	// PROMPT_VERSION 7 made both moot from this side: observation can't
	// contain a digit or a day-count in any form at all (validator's own
	// any-digit/any-day-count checks), so there's nothing left to phrase
	// correctly. See "PROMPT_VERSION 7" below.
});

// PROMPT_VERSION 6's only finding (streak: 1 gets no «подряд»/day-number) was
// itself a refinement of the same two-paragraph contract's ДНИ ПОДРЯД rule —
// PROMPT_VERSION 7 replaced that whole rule with "the model never mentions a
// day-count at all, regardless of streak's value" (see below), which already
// covers streak: 1 as a special case of "never".

describe("buildSystemPrompt: PROMPT_VERSION 7 — one-paragraph contract (picture is code-generated)", () => {
	const system = buildSystemPrompt();

	it("asks for exactly one paragraph (observation) and says picture/numbers are code's job", () => {
		expect(system).toMatch(/написать один абзац прозы/);
		expect(system).toMatch(/Картину дня и все цифры поста пишет код, не ты/);
	});

	it("ЧИСЛА is a blanket ban — no digits at all, not a whitelist to consult", () => {
		expect(system).toMatch(/Цифр в абзаце нет вовсе/);
		expect(system).toMatch(/все числа уже в посте выше/);
	});

	it("ДНИ ПОДРЯД just says the day-number isn't observation's to write", () => {
		expect(system).toMatch(/О номере дня не писать/);
		expect(system).toMatch(/это в первом абзаце/);
	});

	it("refers to history as the model's own past observations, not 'paragraphs'", () => {
		expect(system).toMatch(/твои наблюдения за последние дни/);
	});

	it("still bans forecasts/advice/moonshots/hashtags/links/HTML/emoji — unrelated to the contract change", () => {
		expect(system).toMatch(/прогноз/i);
		expect(system).toMatch(/купить|продать/i);
		expect(system).toMatch(/иксов/i);
		expect(system).toMatch(/хэштег/i);
		expect(system).toMatch(/html/i);
		expect(system).toMatch(/эмодзи/i);
	});
});

describe("buildUserPrompt", () => {
	it("is exactly one JSON object, parseable end to end, with no wrapping prose", () => {
		const user = buildUserPrompt(payload);
		expect(() => JSON.parse(user)).not.toThrow();
		expect(JSON.parse(user)).toEqual(payload);
	});
});

describe("buildRetryUserPrompt: never echoes the rejected text back", () => {
	it.each([
		["number-not-in-facts", "validator:numbers"],
		["streak-digit", "validator:streak_digit"],
		["forecast", "validator:forbidden_pattern"],
		["direction-mismatch", "validator:direction"],
		["empty-paragraph", "validator:empty_or_cutoff"],
		["english", "validator:language"],
	] as const)("retry prompt after rejecting %s (%s) doesn't contain the rejected picture/observation text", (fixtureName, expectedReason) => {
		const rejected = JSON.parse(response(fixtureName).match(/\{[\s\S]*\}/)![0]) as { picture: string; observation: string };
		const result = validateAiParagraphs(response(fixtureName), payload);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe(expectedReason);

		const retryPrompt = buildRetryUserPrompt(payload, result.reason);

		// "".includes("") is vacuously true — only assert non-containment for a
		// field that actually had text (empty-paragraph.txt's picture is "").
		if (rejected.picture) expect(retryPrompt).not.toContain(rejected.picture);
		if (rejected.observation) expect(retryPrompt).not.toContain(rejected.observation);
	});

	it("is still exactly one JSON object — the correction lives in a field, not as prose around it", () => {
		const retryPrompt = buildRetryUserPrompt(payload, "validator:numbers");
		expect(() => JSON.parse(retryPrompt)).not.toThrow();
		const parsed = JSON.parse(retryPrompt) as Record<string, unknown>;
		expect(parsed.today).toEqual(payload.today);
		expect(parsed.allowedNumbers).toEqual(payload.allowedNumbers);
		expect(typeof parsed.retryInstruction).toBe("string");
	});

	it("has a non-empty instruction for every possible ValidationFailureReason", () => {
		for (const reason of ALL_REASONS) {
			const retryPrompt = buildRetryUserPrompt(payload, reason);
			const parsed = JSON.parse(retryPrompt) as { retryInstruction: string };
			expect(parsed.retryInstruction.length).toBeGreaterThan(0);
		}
	});

	it("the streak-digit retry instruction is phrased contextually, not as 'do not write the number N'", () => {
		const retryPrompt = buildRetryUserPrompt(payload, "validator:streak_digit");
		const { retryInstruction } = JSON.parse(retryPrompt) as { retryInstruction: string };

		expect(retryInstruction).toMatch(/день/);
		// facts.streak is 1 here — the instruction must not single out "1" (or
		// any other specific digit) as the thing to avoid. streak itself isn't
		// even in payload.today anymore (removed from the contract entirely),
		// so this reads the source Facts value instead.
		expect(retryInstruction).not.toContain(String(specExampleFacts().streak));
		expect(retryInstruction).not.toMatch(/\d/);
	});

	it("the numbers retry instruction never repeats the specific rejected number", () => {
		// number-not-in-facts.txt used "156" — the correction must describe the
		// *rule* (use only allowedNumbers), not quote the bad number back.
		const retryPrompt = buildRetryUserPrompt(payload, "validator:numbers");
		const { retryInstruction } = JSON.parse(retryPrompt) as { retryInstruction: string };
		expect(retryInstruction).not.toContain("156");
	});
});

const ALL_OBSERVATION_REASONS: ObservationValidationFailureReason[] = [
	"invalid_json",
	"validator:length",
	"validator:forbidden_pattern",
	"validator:direction",
	"validator:empty_or_cutoff",
	"validator:language",
	"validator:observation_digit",
	"validator:observation_day_count",
];

describe("buildRetryObservationPrompt: new one-paragraph contract's retry path — never echoes the rejected text back", () => {
	it.each([
		["observation-digit", "validator:observation_digit"],
		["observation-day-count", "validator:observation_day_count"],
		["forecast", "validator:forbidden_pattern"],
		["direction-mismatch", "validator:direction"],
		["observation-empty", "validator:empty_or_cutoff"],
		["observation-english", "validator:language"],
	] as const)("retry prompt after rejecting %s (%s) doesn't contain the rejected observation text", (fixtureName, expectedReason) => {
		const rejected = JSON.parse(response(fixtureName).match(/\{[\s\S]*\}/)![0]) as { observation: string };
		const result = validateAiObservation(response(fixtureName), payload);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe(expectedReason);

		const retryPrompt = buildRetryObservationPrompt(payload, result.reason);
		if (rejected.observation) expect(retryPrompt).not.toContain(rejected.observation);
	});

	it("is still exactly one JSON object — the correction lives in a field, not as prose around it", () => {
		const retryPrompt = buildRetryObservationPrompt(payload, "validator:observation_digit");
		expect(() => JSON.parse(retryPrompt)).not.toThrow();
		const parsed = JSON.parse(retryPrompt) as Record<string, unknown>;
		expect(parsed.today).toEqual(payload.today);
		expect(typeof parsed.retryInstruction).toBe("string");
	});

	it("has a non-empty instruction for every possible ObservationValidationFailureReason", () => {
		for (const reason of ALL_OBSERVATION_REASONS) {
			const retryPrompt = buildRetryObservationPrompt(payload, reason);
			const parsed = JSON.parse(retryPrompt) as { retryInstruction: string };
			expect(parsed.retryInstruction.length).toBeGreaterThan(0);
		}
	});

	it("the any-digit retry instruction doesn't repeat the specific rejected digit", () => {
		// observation-digit.txt used "5%" — the correction must describe the
		// *rule* (no digits at all), not quote the bad number back.
		const retryPrompt = buildRetryObservationPrompt(payload, "validator:observation_digit");
		const { retryInstruction } = JSON.parse(retryPrompt) as { retryInstruction: string };
		expect(retryInstruction).not.toMatch(/\d/);
	});

	it("the day-count retry instruction is phrased contextually, not naming the specific rejected ordinal", () => {
		const retryPrompt = buildRetryObservationPrompt(payload, "validator:observation_day_count");
		const { retryInstruction } = JSON.parse(retryPrompt) as { retryInstruction: string };
		expect(retryInstruction).toMatch(/номер дня/);
		expect(retryInstruction).not.toMatch(/третий/i);
	});
});
