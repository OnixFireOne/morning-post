import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAiPayload } from "../src/ai/payload.js";
import { buildRetryUserPrompt, buildSystemPrompt, buildUserPrompt } from "../src/ai/prompt.js";
import { MAX_PARAGRAPH_LENGTH, validateAiParagraphs, type ValidationFailureReason } from "../src/ai/validator.js";
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

describe("buildSystemPrompt: streak rule is phrased contextually, not value-specifically", () => {
	it("bans a digit next to день/дня/дней/сутки in general — never mentions writing streak's value as forbidden", () => {
		const system = buildSystemPrompt();
		expect(system).toMatch(/день/);
		expect(system).toMatch(/дня/);
		expect(system).toMatch(/дней/);
		expect(system).toMatch(/сутки/);
		// "320" (the length limit) and "2-й"/"3 дня" (illustrative examples of
		// the *forbidden* form) are legitimate digits here — the actual
		// guarantee against "don't write digit N" framing is that the function
		// has nowhere to receive N from at all (next test), not "zero digits
		// anywhere in the string".
		expect(system).toMatch(/«2-й день»/);
		expect(system).toMatch(/«3 дня подряд»/);
	});

	it("does not take facts/streak as a parameter — the rule can't degrade into a per-day number ban even by accident", () => {
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

	it("asks for Russian and for strict JSON with exactly picture/observation/direction", () => {
		expect(system).toMatch(/русск/i);
		expect(system).toContain('"picture"');
		expect(system).toContain('"observation"');
		expect(system).toContain('"direction"');
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
		// any other specific digit) as the thing to avoid.
		expect(retryInstruction).not.toContain(String(payload.today.streak));
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
