import { describe, expect, it } from "vitest";
import { attemptDayCountTrim, splitIntoSentences } from "../src/ai/validator.js";
import { buildAiPayload } from "../src/ai/payload.js";
import type { Facts } from "../src/facts.js";

// Same market picture as fixtures/green.json (the fixture behind the six live
// rejections this feature was built from — see
// reports/compare-2026-08-25-{1805,1844,1913,1943}-*.md).
function greenFacts(overrides: Partial<Facts> = {}): Facts {
	return {
		dateLabel: "20 августа",
		dateKey: "2026-08-20",
		btc: { price: 77_788, change24h: 6.3 },
		red: 16,
		green: 50,
		total: 66,
		swarmState: "green",
		streak: 1,
		prevState: null,
		winners: [{ id: "xrp", ticker: "XRP", change24h: 30, price: 1, marketCap: null }],
		losers: [{ id: "vvv", ticker: "VVV", change24h: -8, price: 1, marketCap: null }],
		maxAbsLeaderChange: 30,
		...overrides,
	};
}

const payload = buildAiPayload(greenFacts(), []);

function rawText(observation: string): string {
	return JSON.stringify({ observation, direction: "green" });
}

describe("attemptDayCountTrim: the six real 2026-08-25 rejections (validator:observation_day_count)", () => {
	it("18:05, прогон 2/3 — day count in sentence 1 of 3", () => {
		const observation =
			"Второй день подряд биток тянет рой вверх, и рой охотно подчиняется — зелёных монет снова подавляющее большинство. XRP на этот раз не просто выбился вперёд, а устроил настоящий отрыв от пелотона, пока VVV тихо сползает против течения. Рынок явно не спешит выдыхать.";
		const result = attemptDayCountTrim(rawText(observation), payload);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok:true");
		expect(result.removedSentence).toBe("Второй день подряд биток тянет рой вверх, и рой охотно подчиняется — зелёных монет снова подавляющее большинство.");
		expect(result.observation).toBe(
			"XRP на этот раз не просто выбился вперёд, а устроил настоящий отрыв от пелотона, пока VVV тихо сползает против течения. Рынок явно не спешит выдыхать.",
		);
		expect(result.direction).toBe("green");
	});

	it("18:05, прогон 3/3 — day count in sentence 1 of 3", () => {
		const observation =
			"Биток уверенно тянет рой вверх третий день кряду — зелёных монет снова подавляющее большинство, красных почти не видно. XRP вырвался далеко за пределы общего движения, став настоящим исключением в и без того бычьей картине. VVV выбивается из строя в противоход, но это скорее одиночный диссонанс, чем сигнал разлома.";
		const result = attemptDayCountTrim(rawText(observation), payload);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok:true");
		expect(result.removedSentence).toBe("Биток уверенно тянет рой вверх третий день кряду — зелёных монет снова подавляющее большинство, красных почти не видно.");
		expect(result.observation).toBe(
			"XRP вырвался далеко за пределы общего движения, став настоящим исключением в и без того бычьей картине. VVV выбивается из строя в противоход, но это скорее одиночный диссонанс, чем сигнал разлома.",
		);
	});

	it("18:44, прогон 2/3 — day count in sentence 1 of 3", () => {
		const observation =
			"Рой держит зелёный флаг второй день подряд: большинство монет идёт вверх вслед за битком, который уверенно набирает высоту. XRP снова в авангарде — похоже, вчерашний импульс не выдохся и тикер продолжает тянуть на себе внимание. VVV остаётся в тени, медленно теряя позиции, пока остальные купаются в росте.";
		const result = attemptDayCountTrim(rawText(observation), payload);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok:true");
		expect(result.removedSentence).toBe(
			"Рой держит зелёный флаг второй день подряд: большинство монет идёт вверх вслед за битком, который уверенно набирает высоту.",
		);
		expect(result.observation).toBe(
			"XRP снова в авангарде — похоже, вчерашний импульс не выдохся и тикер продолжает тянуть на себе внимание. VVV остаётся в тени, медленно теряя позиции, пока остальные купаются в росте.",
		);
	});

	it("19:13, прогон 3/3 — day count in sentence 1 of 3", () => {
		const observation =
			"Биток держит темп второй день, и рой снова густо зелёный — капитал течёт широким фронтом, не сбиваясь. XRP на этот раз не просто опережает стаю, а буквально улетает от неё на другую орбиту, превращаясь в точку притяжения всего дня. VVV тянет в обратную сторону, но красных монет так мало, что их сопротивление едва ощутимо на фоне общего прилива.";
		const result = attemptDayCountTrim(rawText(observation), payload);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok:true");
		expect(result.removedSentence).toBe("Биток держит темп второй день, и рой снова густо зелёный — капитал течёт широким фронтом, не сбиваясь.");
		expect(result.observation).toBe(
			"XRP на этот раз не просто опережает стаю, а буквально улетает от неё на другую орбиту, превращаясь в точку притяжения всего дня. VVV тянет в обратную сторону, но красных монет так мало, что их сопротивление едва ощутимо на фоне общего прилива.",
		);
	});

	it("19:43, прогон 3/3, первая попытка — day count in sentence 2 of 3 (the leader's own streak, not the market's)", () => {
		const observation =
			"Биток продолжает нести рой вперёд, и зелёная волна снова захлёстывает большую часть поля — красных монет совсем мало. XRP удерживает лидерство уже второй день подряд, и капитал вновь стягивается именно к нему, оставляя широкий рынок позади. VVV снова оказывается одиноким аутсайдером на другом краю — но его потери тонут в общем зелёном шуме.";
		const result = attemptDayCountTrim(rawText(observation), payload);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok:true");
		expect(result.removedSentence).toBe("XRP удерживает лидерство уже второй день подряд, и капитал вновь стягивается именно к нему, оставляя широкий рынок позади.");
		expect(result.observation).toBe(
			"Биток продолжает нести рой вперёд, и зелёная волна снова захлёстывает большую часть поля — красных монет совсем мало. VVV снова оказывается одиноким аутсайдером на другом краю — но его потери тонут в общем зелёном шуме.",
		);
	});

	it("19:43, прогон 3/3, повторная попытка (--retry) — day count in sentence 2 of 3", () => {
		const observation =
			"Биток уверенно держит ход, и рой не сбавляет темп — зелёных монет снова подавляющее большинство. XRP второй день подряд тянет одеяло на себя: альткоин обходит широкий рынок с запасом, собирая капитал вокруг себя точечно и решительно. VVV уходит в минус в одиночестве — аутсайдер не находит компании, пока зелёная масса держится плотно.";
		const result = attemptDayCountTrim(rawText(observation), payload);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok:true");
		expect(result.removedSentence).toBe(
			"XRP второй день подряд тянет одеяло на себя: альткоин обходит широкий рынок с запасом, собирая капитал вокруг себя точечно и решительно.",
		);
		expect(result.observation).toBe(
			"Биток уверенно держит ход, и рой не сбавляет темп — зелёных монет снова подавляющее большинство. VVV уходит в минус в одиночестве — аутсайдер не находит компании, пока зелёная масса держится плотно.",
		);
	});
});

describe("attemptDayCountTrim: negative cases", () => {
	// Cutting exactly one sentence out of a two-sentence response would leave a
	// one-sentence remainder — never a real second paragraph. The >=3-total
	// gate is what stops that before a remainder is ever computed at all: the
	// day count sits in the *second* sentence here specifically to show the
	// gate fires on total sentence count, not on where the violation happens
	// to be.
	it("blocked before a remainder is ever computed — cutting the violating sentence would leave just one sentence behind", () => {
		const observation = "Рой уверенно растёт сегодня. Второй день подряд зелёных монет заметно больше, чем красных.";
		expect(splitIntoSentences(observation)).toHaveLength(2); // sanity: confirms this really is a two-sentence response
		const result = attemptDayCountTrim(rawText(observation), payload);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected ok:false");
		expect(result.stage).toBe("not_eligible");
		expect(result.detail).toContain("2 sentence");
	});

	it("not_eligible — the response is only two sentences total, below the >=3 floor needed to safely cut one", () => {
		const observation = "Второй день подряд биток тянет рой вверх, и рой охотно подчиняется. VVV тихо сползает против течения.";
		const result = attemptDayCountTrim(rawText(observation), payload);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected ok:false");
		expect(result.stage).toBe("not_eligible");
		expect(result.detail).toContain("2 sentence");
	});

	it("not_eligible — day-count wording appears in two sentences at once, not exactly one", () => {
		const observation =
			"Второй день подряд биток тянет рой вверх, и рой охотно подчиняется. XRP тоже празднует уже второй день подряд без остановки. VVV тихо сползает против течения.";
		const result = attemptDayCountTrim(rawText(observation), payload);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected ok:false");
		expect(result.stage).toBe("not_eligible");
		expect(result.detail).toContain("2 sentence");
	});

	it("trim_failed — eligible (>=3 sentences, exactly one violates), but the remainder is too short (<80 chars)", () => {
		const observation = "Второй день подряд рой растёт. XRP лидирует. VVV падает.";
		const result = attemptDayCountTrim(rawText(observation), payload);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected ok:false");
		expect(result.stage).toBe("trim_failed");
		expect(result.detail).toContain("chars");
	});
});

describe("splitIntoSentences: boundary is only ./!/?, never : or —", () => {
	it("does not split on a colon or an em-dash inside a sentence", () => {
		const sentences = splitIntoSentences("Рой держит зелёный флаг второй день подряд: большинство монет идёт вверх — тренд уверенный. Второе предложение.");
		expect(sentences).toHaveLength(2);
		expect(sentences[0]).toBe("Рой держит зелёный флаг второй день подряд: большинство монет идёт вверх — тренд уверенный.");
	});

	it("splits on ., !, and ? alike", () => {
		expect(splitIntoSentences("Раз. Два! Три?")).toEqual(["Раз.", "Два!", "Три?"]);
	});
});
