import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnapshotFromFile } from "../src/snapshot.js";
import { computeFacts, type Facts, type StateHistory } from "../src/facts.js";
import type { HotCoinsSnapshot } from "../src/types.js";
import { buildCaption, buildParagraphs, CAPTION_LIMIT } from "../src/render.js";
import { escapeHtml, formatBtcPercent, formatSignedPercent } from "../src/format.js";
import {
	BTC_LEADS_VARIANTS,
	CALM_DAY_VARIANTS,
	GREEN_FIRST_VARIANTS,
	GREEN_STREAK_VARIANTS,
	MIXED_SHORT,
	MIXED_VARIANTS,
	NEUTRAL_NO_BTC_VARIANTS,
	NEUTRAL_WITH_BTC_VARIANTS,
	QUIET_DUMP_VARIANTS,
	RED_FIRST_VARIANTS,
	RED_STREAK_VARIANTS,
} from "../src/phrases.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const EMPTY_HISTORY: StateHistory = { days: [] };

function factsFor(name: string, history: StateHistory = EMPTY_HISTORY): Facts {
	return computeFacts(loadSnapshotFromFile(path.join(FIXTURES_DIR, name)), history);
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

describe("buildParagraphs: observation paragraph branch selection", () => {
	it("quiet BTC + wild edges -> quiet-dump branch", () => {
		const facts = factsFor("red-first-day.json"); // btc -0.59%, maxAbsEdgeChange 25
		expect(QUIET_DUMP_VARIANTS.map((v) => v(facts))).toContain(buildParagraphs(facts).observation);
	});

	it("|btc%| >= 3 -> btc-leads branch", () => {
		const facts = factsFor("red-streak.json"); // btc -4.1%
		expect(BTC_LEADS_VARIANTS.map((v) => v(facts))).toContain(buildParagraphs(facts).observation);
	});

	it("edges under 8% -> calm-day branch, regardless of btc", () => {
		expect(CALM_DAY_VARIANTS.map((v) => v(factsFor("boring.json")))).toContain(buildParagraphs(factsFor("boring.json")).observation);
		const emptyEdges = factsFor("edge-empty.json"); // btc 0.9%, edges 0
		expect(CALM_DAY_VARIANTS.map((v) => v(emptyEdges))).toContain(buildParagraphs(emptyEdges).observation);
	});

	it("otherwise, with btc known -> neutral-with-btc branch", () => {
		const facts = factsFor("mixed.json"); // btc 1.6%, maxAbsEdgeChange 11.5
		expect(NEUTRAL_WITH_BTC_VARIANTS.map((v) => v(facts))).toContain(buildParagraphs(facts).observation);
	});

	it("otherwise, with btc missing -> neutral-no-btc branch, and never mentions BTC", () => {
		const facts = factsFor("no-btc.json"); // btc null, maxAbsEdgeChange 13.2
		const { observation } = buildParagraphs(facts);
		expect(NEUTRAL_NO_BTC_VARIANTS.map((v) => v(facts))).toContain(observation);
		expect(observation).not.toMatch(/биток|BTC/i);
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
		for (const name of ["real-day.json", "red-streak.json", "red-first-day.json", "green.json", "mixed.json", "boring.json", "no-btc.json", "edge-empty.json", "red-boundary-60.json", "escape-html.json"]) {
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
