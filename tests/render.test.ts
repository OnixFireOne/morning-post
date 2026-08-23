import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnapshotFromFile } from "../src/snapshot.js";
import { computeFacts, type Facts, type StateHistory } from "../src/facts.js";
import type { HotCoinsSnapshot } from "../src/types.js";
import { buildCaption, buildParagraphs, CAPTION_LIMIT } from "../src/render.js";
import { escapeHtml, formatBtcPercent, formatSignedPercent } from "../src/format.js";
import {
	BTC_LEADS_VARIANTS,
	CORRECTION_VARIANTS,
	GREEN_FIRST_VARIANTS,
	GREEN_STREAK_VARIANTS,
	MIXED_SHORT,
	MIXED_VARIANTS,
	NEUTRAL_NO_BTC_VARIANTS,
	NEUTRAL_WITH_BTC_VARIANTS,
	QUIET_DUMP_VARIANTS,
	REBOUND_VARIANTS,
	RED_FIRST_VARIANTS,
	RED_STREAK_VARIANTS,
} from "../src/phrases.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const EMPTY_HISTORY: StateHistory = { days: [] };

const ALL_FIXTURE_NAMES = [
	"real-day.json",
	"red-streak.json",
	"red-first-day.json",
	"green.json",
	"mixed.json",
	"boring.json",
	"no-btc.json",
	"edge-empty.json",
	"red-boundary-60.json",
	"escape-html.json",
];

function factsFor(name: string, history: StateHistory = EMPTY_HISTORY): Facts {
	return computeFacts(loadSnapshotFromFile(path.join(FIXTURES_DIR, name)), history);
}

function historyFixture(name: string): StateHistory {
	return JSON.parse(readFileSync(path.join(FIXTURES_DIR, "history", name), "utf8"));
}

describe("format helpers", () => {
	it("formatSignedPercent rounds to an integer at |x| >= 10, one decimal below that", () => {
		expect(formatSignedPercent(25)).toBe("+25%");
		expect(formatSignedPercent(-25)).toBe("−25%");
		expect(formatSignedPercent(-15.53)).toBe("−16%"); // |x| >= 10 -> integer, per the раздел 4.2 rule
		expect(formatSignedPercent(-5.53)).toBe("−5.5%");
	});

	it("formatBtcPercent always keeps two decimals (раздел 1's own {±X.XX%} template)", () => {
		expect(formatBtcPercent(-0.59)).toBe("−0.59%");
		expect(formatBtcPercent(8.4)).toBe("+8.40%");
	});

	it("escapeHtml escapes & < > only", () => {
		expect(escapeHtml("A&B")).toBe("A&amp;B");
		expect(escapeHtml("<b>X")).toBe("&lt;b&gt;X");
		expect(escapeHtml("币安人生")).toBe("币安人生");
	});
});

describe("buildParagraphs: leader lines", () => {
	it("escapes unsafe ticker characters", () => {
		const { winnerLine, loserLine } = buildParagraphs(factsFor("escape-html.json"));
		expect(winnerLine).toContain("A&amp;B");
		expect(winnerLine).not.toContain("A&B");
		expect(loserLine).toContain("&lt;b&gt;X");
		expect(loserLine).not.toContain("<b>X");
	});

	it("wraps only the winner line in <b>", () => {
		const { winnerLine, loserLine } = buildParagraphs(factsFor("mixed.json"));
		expect(winnerLine.startsWith("<b>📈")).toBe(true);
		expect(winnerLine.endsWith("</b>")).toBe(true);
		expect(loserLine.startsWith("📉")).toBe(true);
		expect(loserLine).not.toContain("<b>");
	});

	it("labels the winner 'Герой дня' on green days, 'Против течения' otherwise", () => {
		expect(buildParagraphs(factsFor("green.json")).winnerLine).toContain("Герой дня");
		expect(buildParagraphs(factsFor("red-streak.json")).winnerLine).toContain("Против течения");
		expect(buildParagraphs(factsFor("mixed.json")).winnerLine).toContain("Против течения");
	});

	it("labels the loser 'Против течения' on green days, 'Антигерой дня' otherwise", () => {
		expect(buildParagraphs(factsFor("green.json")).loserLine).toContain("Против течения");
		expect(buildParagraphs(factsFor("red-streak.json")).loserLine).toContain("Антигерой дня");
	});
});

describe("buildParagraphs: picture paragraph branch selection", () => {
	it("red + streak>=2 -> a red-streak variant", () => {
		const facts = factsFor("red-streak.json", {
			days: [{ date: "2026-08-17", swarmState: "red", btcChange: -1, postedAt: "2026-08-17T06:00:00Z", messageId: 1 }],
		});
		expect(facts.streak).toBeGreaterThanOrEqual(2);
		expect(RED_STREAK_VARIANTS.map((v) => v(facts))).toContain(buildParagraphs(facts).picture);
	});

	it("red + streak==1 -> a red-first variant", () => {
		const facts = factsFor("red-streak.json");
		expect(facts.streak).toBe(1);
		expect(RED_FIRST_VARIANTS.map((v) => v(facts))).toContain(buildParagraphs(facts).picture);
	});

	it("green + streak>=2 -> a green-streak variant", () => {
		const facts = factsFor("green.json", {
			days: [{ date: "2026-08-19", swarmState: "green", btcChange: 3, postedAt: "2026-08-19T06:00:00Z", messageId: 1 }],
		});
		expect(facts.streak).toBeGreaterThanOrEqual(2);
		expect(GREEN_STREAK_VARIANTS.map((v) => v(facts))).toContain(buildParagraphs(facts).picture);
	});

	it("green + streak==1 -> a green-first variant", () => {
		const facts = factsFor("green.json");
		expect(facts.streak).toBe(1);
		expect(GREEN_FIRST_VARIANTS.map((v) => v(facts))).toContain(buildParagraphs(facts).picture);
	});

	it("mixed -> a mixed variant", () => {
		const facts = factsFor("mixed.json");
		expect(MIXED_VARIANTS.map((v) => v(facts))).toContain(buildParagraphs(facts).picture);
	});
});

describe("buildParagraphs: verb/participle agreement at red = 1 (integration, not just the bare verbForm unit)", () => {
	it("uses singular verb forms ('растёт'/'падает'), not plural, when a count is exactly 1", () => {
		// red = 1, green = 1 -> total 2, neither ratio >= 0.6 -> swarmState "mixed".
		// ts is 2026-01-01 (Moscow) -> dayOfYear 1 -> pickVariant lands on
		// MIXED_VARIANTS[1], the one with a verb attached to each count.
		const snap: HotCoinsSnapshot = {
			version: 1,
			ts: "2026-01-01T06:00:00.000Z",
			btc: { price: 50_000, change24h: 1 },
			mainSwarm: [
				{ id: "coin-a", ticker: "AAA", change24h: 5, price: 1, marketCap: null },
				{ id: "coin-b", ticker: "BBB", change24h: -5, price: 1, marketCap: null },
			],
			edgePins: [],
		};
		const facts = computeFacts(snap, EMPTY_HISTORY);
		expect(facts.red).toBe(1);
		expect(facts.green).toBe(1);
		expect(facts.swarmState).toBe("mixed");

		const { picture } = buildParagraphs(facts);
		expect(picture).toBe("Ни одного явного тренда: 1 монета растёт, 1 падает почти поровну.");
		expect(picture).not.toMatch(/1 монета растут|1 монета падают|1 растут|1 падают/);
	});
});

describe("buildParagraphs: observation paragraph branch selection", () => {
	it("prevState green -> swarmState red: correction branch, ahead of btc-leads even though |btc%| >= 3", () => {
		const facts = factsFor("red-streak.json", historyFixture("green-to-red.json"));
		expect(facts.prevState).toBe("green");
		expect(facts.swarmState).toBe("red");
		expect(Math.abs(facts.btc!.change24h)).toBeGreaterThanOrEqual(3); // btc-leads would otherwise also match
		expect(CORRECTION_VARIANTS.map((v) => v(facts))).toContain(buildParagraphs(facts).observation);
	});

	it("prevState red -> swarmState green: rebound branch, ahead of btc-leads even though |btc%| >= 3", () => {
		const facts = factsFor("green.json", historyFixture("red-then-green.json"));
		expect(facts.prevState).toBe("red");
		expect(facts.swarmState).toBe("green");
		expect(Math.abs(facts.btc!.change24h)).toBeGreaterThanOrEqual(3);
		expect(REBOUND_VARIANTS.map((v) => v(facts))).toContain(buildParagraphs(facts).observation);
	});

	it("a gap right before today does not trigger the correction branch, even with an older matching entry", () => {
		const facts = factsFor("red-streak.json", historyFixture("green-gap-before-today.json"));
		expect(facts.prevState).toBeNull();
		expect(BTC_LEADS_VARIANTS.map((v) => v(facts))).toContain(buildParagraphs(facts).observation);
	});

	it("quiet BTC + a wild leader -> quiet-dump branch", () => {
		const facts = factsFor("red-first-day.json"); // btc -0.59%, maxAbsLeaderChange 25
		expect(QUIET_DUMP_VARIANTS.map((v) => v(facts))).toContain(buildParagraphs(facts).observation);
	});

	it("|btc%| >= 3 -> btc-leads branch", () => {
		const facts = factsFor("red-streak.json"); // btc -4.1%, empty history -> prevState null
		expect(BTC_LEADS_VARIANTS.map((v) => v(facts))).toContain(buildParagraphs(facts).observation);
	});

	it("otherwise, with btc known -> neutral-with-btc branch (no calm-day branch exists anymore)", () => {
		for (const name of ["mixed.json", "boring.json", "edge-empty.json"]) {
			const facts = factsFor(name);
			expect(NEUTRAL_WITH_BTC_VARIANTS.map((v) => v(facts))).toContain(buildParagraphs(facts).observation);
		}
	});

	it("otherwise, with btc missing -> neutral-no-btc branch, and never mentions BTC", () => {
		const facts = factsFor("no-btc.json"); // btc null, maxAbsLeaderChange 13.2
		const { observation } = buildParagraphs(facts);
		expect(NEUTRAL_NO_BTC_VARIANTS.map((v) => v(facts))).toContain(observation);
		expect(observation).not.toMatch(/биток|BTC/i);
	});
});

describe("buildParagraphs: no more edge-of-the-swarm claims (раздел про инцидент 23.08)", () => {
	// The old "calm day" branch measured maxAbsEdgeChange (edgePins only, often
	// empty) and reported it as real volatility — that's exactly what produced
	// "±0%" in prod on a day with ±17-18% leaders. The branch is gone; these
	// are regression guards so it (or wording like it) can't come back quietly.
	const FORBIDDEN_CALM_SUBSTRINGS = ["Спокойный день", "штиле", "волатильность на минимуме", "не превысили", "никто не вышел", "затиш"];
	// The specific removed phrasing, not a bare "кра" substring check — "рой
	// красный" is legitimate wanted text and must not trip this.
	const FORBIDDEN_EDGE_PHRASES = ["краёв роя", "краях роя", "краям роя", "края роя", "на краях", "у краёв"];

	it("never mentions calm-day language when maxAbsLeaderChange >= 8, across every fixture at once", () => {
		const offenders: string[] = [];
		for (const name of ALL_FIXTURE_NAMES) {
			const facts = factsFor(name);
			if (facts.maxAbsLeaderChange < 8) continue;
			const caption = buildCaption(facts).toLowerCase();
			for (const phrase of FORBIDDEN_CALM_SUBSTRINGS) {
				if (caption.includes(phrase.toLowerCase())) offenders.push(`${name}: "${phrase}"`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("never contains ±0% or any 'edge of the swarm' phrasing, across every fixture at once", () => {
		const offenders: string[] = [];
		for (const name of ALL_FIXTURE_NAMES) {
			const caption = buildCaption(factsFor(name));
			if (caption.includes("±0%")) offenders.push(`${name}: "±0%"`);
			for (const phrase of FORBIDDEN_EDGE_PHRASES) {
				if (caption.includes(phrase)) offenders.push(`${name}: "${phrase}"`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("buildCaption", () => {
	it("wraps exactly the header, BTC line, and winner line in <b>", () => {
		const caption = buildCaption(factsFor("mixed.json"));
		const bold = [...caption.matchAll(/<b>([\s\S]*?)<\/b>/g)].map((m) => m[1]);
		expect(bold).toHaveLength(3);
		expect(bold[0]).toContain("Утро на рынке");
		expect(bold[1]).toContain("BTC $");
		expect(bold[2]).toContain("📈");
	});

	it("omits the BTC line entirely when btc is null, with no leftover blank gap", () => {
		const caption = buildCaption(factsFor("no-btc.json"));
		expect(caption).not.toContain("BTC $");
		expect(caption).not.toContain("\n\n\n");
	});

	it("puts the winner line above the loser line", () => {
		const caption = buildCaption(factsFor("green.json"));
		expect(caption.indexOf("📈")).toBeLessThan(caption.indexOf("📉"));
	});

	it("ends with the CTA", () => {
		expect(buildCaption(factsFor("mixed.json")).endsWith("Вся карта в реальном времени → inp.one")).toBe(true);
	});

	it("stays within the Telegram caption limit for every fixture", () => {
		for (const name of ALL_FIXTURE_NAMES) {
			expect(buildCaption(factsFor(name)).length).toBeLessThanOrEqual(CAPTION_LIMIT);
		}
	});
});

describe("buildCaption: length degradation (раздел 4.3)", () => {
	function factsWithLongTickers(tickerLength: number): Facts {
		const snap: HotCoinsSnapshot = {
			version: 1,
			ts: "2026-08-21T06:00:00.000Z",
			btc: { price: 77788, change24h: 1.6 },
			mainSwarm: [
				{ id: "w", ticker: "W".repeat(tickerLength), change24h: 20, price: 5, marketCap: null },
				{ id: "l", ticker: "L".repeat(tickerLength), change24h: -20, price: 5, marketCap: null },
			],
			edgePins: [],
		};
		return computeFacts(snap, EMPTY_HISTORY);
	}

	it("drops the observation paragraph, then switches to the short picture, to fit back under the limit", () => {
		// Calibrated so both the full caption and the observation-dropped caption
		// still exceed CAPTION_LIMIT, and only the short-picture stage fits —
		// exercises all three degradation stages, not just the first cut.
		const facts = factsWithLongTickers(400);
		const paragraphs = buildParagraphs(facts);

		const caption = buildCaption(facts);
		expect(caption).not.toContain(paragraphs.observation);
		expect(caption).not.toContain(paragraphs.picture);
		expect(caption).toContain(MIXED_SHORT(facts));
		expect(caption.length).toBeLessThanOrEqual(CAPTION_LIMIT);
	});

	it("never drops the header, BTC line, leader lines, or CTA — even if that means exceeding the limit", () => {
		const facts = factsWithLongTickers(5000); // pathological: leader lines alone blow the budget
		const caption = buildCaption(facts);
		expect(caption).toContain("Утро на рынке");
		expect(caption).toContain("BTC $");
		expect(caption).toContain("W".repeat(5000));
		expect(caption).toContain("L".repeat(5000));
		expect(caption.endsWith("Вся карта в реальном времени → inp.one")).toBe(true);
	});
});
