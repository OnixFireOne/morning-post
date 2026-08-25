import { describe, expect, it } from "vitest";
import {
	findReusedRareWords,
	findWordChainMatches,
	formatRepetitionSection,
	normalizeWords,
	poolPriorWords,
	type ChainStep,
} from "../tools/ai-compare.js";

function step(overrides: Partial<ChainStep> = {}): ChainStep {
	return { run: 1, dateLabel: "23 августа", picture: "", observation: "", source: "ai", ...overrides };
}

describe("normalizeWords", () => {
	it("lowercases and splits on any non-letter/non-digit run, dropping empty tokens", () => {
		expect(normalizeWords("Рой сегодня — явно красный, 133 монеты!")).toEqual(["рой", "сегодня", "явно", "красный", "133", "монеты"]);
	});

	it("returns an empty array for empty or purely-punctuation text", () => {
		expect(normalizeWords("")).toEqual([]);
		expect(normalizeWords(" — , . ")).toEqual([]);
	});
});

describe("poolPriorWords", () => {
	it("joins each text's words with a boundary marker between texts, distinct from any real word", () => {
		const pooled = poolPriorWords(["рой сегодня красный", "биток упал сильно"]);
		expect(pooled).toEqual(["рой", "сегодня", "красный", " ", "биток", "упал", "сильно"]);
	});

	it("prevents a match spanning the boundary between two prior texts (separator breaks contiguity)", () => {
		// "конец" then "начало слова тут" — if pooled without a boundary marker,
		// "конец начало слова тут" would look contiguous. It must not.
		const pooled = poolPriorWords(["слова тут конец", "начало слова тут снова"]);
		const current = normalizeWords("конец начало слова тут снова");
		const { chains } = findWordChainMatches(current, pooled, 4);
		// "конец" (from step 1) is not adjacent to "начало слова тут снова" (from step 2)
		// in the real corpus, so no 5-word chain should be found across that boundary.
		expect(chains.some((c) => c.join(" ") === "конец начало слова тут снова")).toBe(false);
	});

	it("returns an empty array when given no prior texts", () => {
		expect(poolPriorWords([])).toEqual([]);
	});
});

describe("findWordChainMatches", () => {
	it("finds a verbatim run of 4+ words shared with prior text", () => {
		const prior = poolPriorWords(["рой сегодня явно красный и падает дальше"]);
		const current = normalizeWords("внезапно сегодня явно красный и падает дальше значит день продолжается");
		const { chains } = findWordChainMatches(current, prior, 4);
		expect(chains.map((c) => c.join(" "))).toContain("сегодня явно красный и падает дальше");
	});

	it("does not report a chain shorter than minLength", () => {
		const prior = poolPriorWords(["рой сегодня явно красный"]);
		const current = normalizeWords("рой сегодня явно зелёный");
		const { chains } = findWordChainMatches(current, prior, 4);
		expect(chains).toEqual([]);
	});

	it("never starts or extends a match through a numeric token, even if the numbers happen to match", () => {
		const text = "рынок сегодня рано закрыл 133 монеты вниз резко и сильно";
		const prior = poolPriorWords([text]);
		const current = normalizeWords(text);
		const { chains } = findWordChainMatches(current, prior, 4);
		// The 10-word run has a numeric token in the middle, so it must be
		// reported as two separate chains (one on each side), never one long
		// chain bridging across "133" and never containing "133" itself.
		for (const chain of chains) {
			expect(chain.some((w) => /^\d+$/.test(w))).toBe(false);
		}
		expect(chains.map((c) => c.join(" "))).toEqual(["рынок сегодня рано закрыл", "монеты вниз резко и сильно"]);
	});

	it("reports maximal non-overlapping matches, not every overlapping sub-window", () => {
		const prior = poolPriorWords(["рой сегодня явно красный и падает дальше без остановки"]);
		const current = normalizeWords("рой сегодня явно красный и падает дальше без остановки");
		const { chains, usedPositions } = findWordChainMatches(current, prior, 4);
		expect(chains).toHaveLength(1);
		expect(chains[0]).toEqual(["рой", "сегодня", "явно", "красный", "и", "падает", "дальше", "без", "остановки"]);
		expect(usedPositions.size).toBe(9);
	});

	it("returns no chains when current and prior share nothing", () => {
		const prior = poolPriorWords(["зелёный рой растёт бодро"]);
		const current = normalizeWords("совсем другой текст без ничего общего");
		const { chains } = findWordChainMatches(current, prior, 4);
		expect(chains).toEqual([]);
	});
});

describe("findReusedRareWords", () => {
	it("reports a word reused from prior text that is not in the stop list and not a numeric token", () => {
		const prior = poolPriorWords(["сегодня биток невероятно волатилен"]);
		const current = normalizeWords("биток снова волатилен как вчера");
		const rare = findReusedRareWords(current, prior, new Set());
		expect(rare).toContain("волатилен");
	});

	it("excludes generic stop words (function words and this project's core domain vocabulary)", () => {
		const prior = poolPriorWords(["рой сегодня на рынке растёт"]);
		const current = normalizeWords("рой на рынке снова растёт");
		const rare = findReusedRareWords(current, prior, new Set());
		// рой/на/рынке/растёт are all stop words (domain vocab or function words)
		expect(rare).toEqual([]);
	});

	it("excludes numeric tokens even when reused", () => {
		const prior = poolPriorWords(["изменение составило 133 пункта"]);
		const current = normalizeWords("сегодня снова 133 пункта");
		const rare = findReusedRareWords(current, prior, new Set());
		expect(rare).not.toContain("133");
	});

	it("excludes word positions already covered by a reported chain match", () => {
		const current = normalizeWords("волатилен необычайно сильно");
		// pretend position 0 ("волатилен") was already reported as part of a chain match
		const rare = findReusedRareWords(current, ["волатилен", "необычайно", "сильно"], new Set([0]));
		expect(rare).not.toContain("волатилен");
		expect(rare).toContain("необычайно");
	});

	it("does not duplicate a word that appears more than once in current", () => {
		const prior = poolPriorWords(["волатилен рынок очень волатилен"]);
		const current = normalizeWords("волатилен и снова волатилен");
		const rare = findReusedRareWords(current, prior, new Set());
		expect(rare.filter((w) => w === "волатилен")).toHaveLength(1);
	});
});

describe("formatRepetitionSection", () => {
	it("reports 'no repeats found' when the current step shares nothing with prior steps", () => {
		const steps: ChainStep[] = [
			step({ run: 1, picture: "Рой вчера был зелёным.", observation: "Всё спокойно." }),
			step({ run: 2, picture: "Сегодня рынок выглядит иначе целиком.", observation: "Другая картина полностью." }),
		];
		const section = formatRepetitionSection(steps);
		expect(section).toContain("Повторы относительно предыдущих шагов");
		expect(section).toContain("Повторов не найдено.");
	});

	it("lists a shared 4+ word chain between the current step and an earlier one", () => {
		const steps: ChainStep[] = [
			step({ run: 1, picture: "Рой сегодня явно красный и падает дальше.", observation: "Настрой мрачный." }),
			step({ run: 2, picture: "Рой сегодня явно красный и падает дальше, но есть надежда.", observation: "Настрой иной." }),
		];
		const section = formatRepetitionSection(steps);
		expect(section).toContain("Дословные цепочки (4+ слов)");
		expect(section).toContain("рой сегодня явно красный и падает дальше");
	});

	it("lists a reused rare word even without a 4-word chain", () => {
		const steps: ChainStep[] = [
			step({ run: 1, picture: "Рынок сегодня беспрецедентно нестабилен.", observation: "Ничего необычного." }),
			step({ run: 2, picture: "Совсем другая картина дня целиком.", observation: "Однако снова беспрецедентно волатильно." }),
		];
		const section = formatRepetitionSection(steps);
		expect(section).toContain("Повторно использованные редкие слова");
		expect(section).toContain("беспрецедентно");
	});

	it("only compares the last step against earlier ones — a repeat between two earlier steps is not reported here", () => {
		// steps 1 and 2 share a long chain, but step 3 (current) shares nothing with either.
		const steps: ChainStep[] = [
			step({ run: 1, picture: "Рой сегодня явно красный и падает дальше.", observation: "Настрой мрачный." }),
			step({ run: 2, picture: "Рой сегодня явно красный и падает дальше.", observation: "Настрой мрачный." }),
			step({ run: 3, picture: "Совершенно иная формулировка без ничего общего.", observation: "Полностью другой текст здесь." }),
		];
		const section = formatRepetitionSection(steps);
		expect(section).toContain("Повторов не найдено.");
	});

	it("never lists a numeric token in either the chain or rare-word part of the output", () => {
		const steps: ChainStep[] = [
			step({ run: 1, picture: "Рынок сегодня рано закрыл 133 монеты вниз резко и сильно.", observation: "133 упали." }),
			step({ run: 2, picture: "Рынок сегодня рано закрыл 133 монеты вниз резко и сильно.", observation: "133 упали снова." }),
		];
		const section = formatRepetitionSection(steps);
		expect(section).not.toContain("133");
	});
});

/** Pulls the comma-separated word list off the "reused rare words" line — word-boundary exact match, not substring containment (so e.g. a hypothetical "xrpusdt" token couldn't false-positive a check for "xrp"). */
function reusedRareWords(section: string): string[] {
	const line = section.split("\n").find((l) => l.startsWith("- Повторно использованные редкие слова:"));
	if (!line) return [];
	return line
		.slice(line.indexOf(":") + 1)
		.split(",")
		.map((w) => w.trim());
}

describe("formatRepetitionSection: regression against a real accepted --chain run", () => {
	// The three observation paragraphs actually accepted by the model — git
	// history of reports/compare-2026-08-25-claude-sonnet-4-7-chain3.md,
	// commit 9e0584d (fixture real-day.json, coin ENA; a later real run has
	// since overwritten that file's *current* content with a different
	// fixture/coin, so this text is pulled from git log, not the file as it
	// reads today). picture is left empty so the fixture exercises exactly
	// the reused-word behavior the observation text alone produces.
	const observation1 =
		"Такое единодушие редкость: когда биток прибавляет сразу столько, рой обычно не успевает — сегодня успел. ENA улетел особняком, далеко впереди остальных. Красных монет — единицы, и они скорее исключение, подчёркивающее общий импульс дня.";
	const observation2 =
		"Второй день подряд картина не меняется — те же 60 зелёных, те же 6 красных. Это уже не случайный всплеск, а устойчивое состояние: рой закрепился наверху и не спешит отступать. ENA тянет особняком, красные монеты — лишь точечный шум на общем фоне.";
	const observation3 =
		"Когда биток прибавляет столько, а расклад в рое при этом остаётся неизменным — 60 против 6 — это уже не инерция, а структура. ENA тянет особняком, M тихо сползает вниз, но красных монет по-прежнему ничтожно мало. Рой не рассыпается и не перегревается — он просто держит курс.";

	const realStep1 = step({ run: 1, dateLabel: "21 августа", observation: observation1 });
	const realStep2 = step({ run: 2, dateLabel: "22 августа", observation: observation2 });
	const realStep3 = step({ run: 3, dateLabel: "23 августа", observation: observation3 });

	// "особняком" describes ENA standing apart from the swarm and is reused
	// verbatim in all three steps' observation ("ENA улетел особняком" /
	// "ENA тянет особняком" / "ENA тянет особняком"). It never gets swallowed
	// into a 4+-word chain: "ena тянет особняком" is only 3 words, one short
	// of the chain threshold, so on both steps it should be named standalone
	// in the rare-word list rather than folded into a chain entry.
	it("names особняком standalone as a reused rare word on step 2 (vs step 1)", () => {
		const section = formatRepetitionSection([realStep1, realStep2]);
		expect(reusedRareWords(section)).toContain("особняком");
	});

	it("names особняком standalone as a reused rare word on step 3 (vs steps 1-2)", () => {
		const section = formatRepetitionSection([realStep1, realStep2, realStep3]);
		expect(reusedRareWords(section)).toContain("особняком");
		// "ena тянет особняком" repeats verbatim between steps 2 and 3 but stays
		// 3 words long (below the 4-word chain threshold), so it must never
		// appear as a chain entry — only as individual rare words.
		expect(section).not.toContain("Дословные цепочки");
	});
});
