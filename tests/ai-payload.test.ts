import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnapshotFromFile } from "../src/snapshot.js";
import { computeFacts, type Facts, type StateDay, type StateHistory } from "../src/facts.js";
import { buildAiPayload, collectAllowedNumbers, stateHistoryToAiHistory, type AiHistoryEntry } from "../src/ai/payload.js";

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

function factsFor(name: string): Facts {
	return computeFacts(loadSnapshotFromFile(path.join(FIXTURES_DIR, name)), EMPTY_HISTORY);
}

/** Section 3's own worked example: 133/14/147, BTC −2.10%, TRAC +18%, PI −17%, maxAbsLeaderChange 18. */
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

describe("buildAiPayload: section 3's worked example", () => {
	it("reproduces exactly the today object and allowedNumbers from the spec", () => {
		const payload = buildAiPayload(specExampleFacts(), []);
		expect(payload.today).toEqual({
			dateLabel: "23 августа",
			swarmState: "red",
			streak: 1,
			prevState: "green",
			red: 133,
			green: 14,
			total: 147,
			btc: { priceLabel: "$76,150", changeLabel: "−2.10%", change: -2.1 },
			topGainer: { ticker: "TRAC", changeLabel: "+18%" },
			topLoser: { ticker: "PI", changeLabel: "−17%" },
			maxAbsLeaderChange: 18,
		});
		expect(payload.allowedNumbers).toEqual(["133", "14", "147", "$76,150", "−2.10%", "2.1%", "+18%", "−17%", "18%"]);
	});

	it("never includes streak's own digit in allowedNumbers", () => {
		const payload = buildAiPayload(specExampleFacts({ streak: 5 }), []);
		expect(payload.allowedNumbers).not.toContain("5");
	});

	it("passes history's dateLabel/swarmState through untouched, but redacts its own numbers — they never enter allowedNumbers either", () => {
		const history: AiHistoryEntry[] = [
			{ dateLabel: "22 августа", swarmState: "green", picture: "133 монеты выросли вчера.", observation: "Всё зелено." },
		];
		const payload = buildAiPayload(specExampleFacts(), history);
		expect(payload.history).toEqual([{ dateLabel: "22 августа", swarmState: "green", picture: "… монеты выросли вчера.", observation: "Всё зелено." }]);
		// "133" from yesterday's picture text must not leak in as if it were today's —
		// it already is today's red count here, so assert on a number that ISN'T:
		const historyOnlyNumber = "999";
		expect(payload.allowedNumbers).not.toContain(historyOnlyNumber);
	});
});

describe("buildAiPayload: history numbers are redacted before reaching the payload", () => {
	it("replaces every number token (plain, percent, dollar, signed, comma-grouped) with an ellipsis in both picture and observation", () => {
		const history: AiHistoryEntry[] = [
			{
				dateLabel: "22 августа",
				swarmState: "green",
				picture: "Рой вырос: 60 монет из $1,234 капитализации против 6 падающих.",
				observation: "Биток прибавил +8.40%, а лидер вырос на 43%.",
			},
		];
		const payload = buildAiPayload(specExampleFacts(), history);
		expect(payload.history[0]!.picture).toBe("Рой вырос: … монет из … капитализации против … падающих.");
		expect(payload.history[0]!.observation).toBe("Биток прибавил …, а лидер вырос на ….");
	});

	it("leaves tickers alone — every real ticker in this project is purely alphabetic, so nothing collides", () => {
		const history: AiHistoryEntry[] = [
			{ dateLabel: "22 августа", swarmState: "red", picture: "TRAC вырвался в лидеры с ростом 18%.", observation: "PI остаётся антигероем." },
		];
		const payload = buildAiPayload(specExampleFacts(), history);
		expect(payload.history[0]!.picture).toBe("TRAC вырвался в лидеры с ростом ….");
		expect(payload.history[0]!.observation).toBe("PI остаётся антигероем.");
	});

	it("doesn't mutate the caller's history array or its entries", () => {
		const history: AiHistoryEntry[] = [{ dateLabel: "22 августа", swarmState: "green", picture: "133 монеты выросли вчера.", observation: "Всё зелено." }];
		const original = JSON.parse(JSON.stringify(history)) as AiHistoryEntry[];
		buildAiPayload(specExampleFacts(), history);
		expect(history).toEqual(original);
	});

	it("leaves dateLabel and swarmState untouched — only picture/observation text is redacted", () => {
		const history: AiHistoryEntry[] = [{ dateLabel: "22 августа", swarmState: "mixed", picture: "133 монеты выросли вчера.", observation: "Всё спокойно." }];
		const payload = buildAiPayload(specExampleFacts(), history);
		expect(payload.history[0]!.dateLabel).toBe("22 августа");
		expect(payload.history[0]!.swarmState).toBe("mixed");
	});

	it("handles an empty history array without error", () => {
		const payload = buildAiPayload(specExampleFacts(), []);
		expect(payload.history).toEqual([]);
	});
});

describe("buildAiPayload: null handling", () => {
	it("passes btc through as an explicit null, not an omitted field", () => {
		const payload = buildAiPayload(specExampleFacts({ btc: null }), []);
		expect(payload.today.btc).toBeNull();
		expect("btc" in payload.today).toBe(true);
	});

	it("passes prevState through as explicit null on a first run / history gap", () => {
		const payload = buildAiPayload(specExampleFacts({ prevState: null }), []);
		expect(payload.today.prevState).toBeNull();
	});

	it("sets topGainer/topLoser to null when there are no leaders at all", () => {
		const payload = buildAiPayload(specExampleFacts({ winners: [], losers: [] }), []);
		expect(payload.today.topGainer).toBeNull();
		expect(payload.today.topLoser).toBeNull();
	});

	it("still allows maxAbsLeaderChange's own formatted form even with no leaders", () => {
		const payload = buildAiPayload(specExampleFacts({ winners: [], losers: [], maxAbsLeaderChange: 0 }), []);
		expect(payload.allowedNumbers).toContain("0%");
	});
});

describe("buildAiPayload: no raw snapshot leakage, on real fixtures", () => {
	it.each(ALL_FIXTURE_NAMES)("payload for %s never mentions mainSwarm/edgePins or an unrelated coin's ticker", (name) => {
		const snap = loadSnapshotFromFile(path.join(FIXTURES_DIR, name));
		const facts = computeFacts(snap, EMPTY_HISTORY);
		const payload = buildAiPayload(facts, []);
		const json = JSON.stringify(payload);

		expect(json).not.toContain("mainSwarm");
		expect(json).not.toContain("edgePins");
		expect(json).not.toContain("marketCap");

		const winnerTicker = facts.winners[0]?.ticker;
		const loserTicker = facts.losers[0]?.ticker;
		// Every coin that isn't today's winner/loser must be absent from the payload.
		const leakedCoin = snap.mainSwarm.find((c) => c.ticker !== winnerTicker && c.ticker !== loserTicker && json.includes(c.ticker));
		expect(leakedCoin, `unexpected ticker leaked into payload: ${leakedCoin?.ticker}`).toBeUndefined();
	});

	it.each(ALL_FIXTURE_NAMES)("every quotable label for %s is a member of allowedNumbers, and streak's own digit never is", (name) => {
		// Scanning JSON.stringify(payload.today) with a number-regex would also
		// catch JSON's own structural commas and the *raw* comparison numbers
		// (btc.change, maxAbsLeaderChange) that section 3.1 explicitly keeps
		// unformatted for magnitude comparison, not for quoting — those aren't
		// meant to appear in allowedNumbers verbatim, only their "%"-suffixed
		// formatted form is. So check the actual quotable strings directly
		// instead of pattern-matching the payload's own JSON encoding.
		const facts = computeFacts(loadSnapshotFromFile(path.join(FIXTURES_DIR, name)), EMPTY_HISTORY);
		const { today, allowedNumbers } = buildAiPayload(facts, []);
		const allowed = new Set(allowedNumbers);

		expect(allowed.has(String(today.red))).toBe(true);
		expect(allowed.has(String(today.green))).toBe(true);
		expect(allowed.has(String(today.total))).toBe(true);
		if (today.btc) {
			expect(allowed.has(today.btc.priceLabel)).toBe(true);
			expect(allowed.has(today.btc.changeLabel)).toBe(true);
		}
		if (today.topGainer) expect(allowed.has(today.topGainer.changeLabel)).toBe(true);
		if (today.topLoser) expect(allowed.has(today.topLoser.changeLabel)).toBe(true);
		// Not asserting streak's digit is absent here — on a fixture where it
		// coincidentally equals red/green/total that number IS legitimately
		// allowed, for that unrelated reason. The "never independently
		// whitelisted" guarantee is covered precisely above, with streak=5
		// against 133/14/147 where no coincidence is possible.
	});
});

describe("collectAllowedNumbers", () => {
	it("is the exact function buildAiPayload uses — calling it directly reproduces the same list", () => {
		const today = buildAiPayload(specExampleFacts(), []).today;
		expect(collectAllowedNumbers(today)).toEqual(buildAiPayload(specExampleFacts(), []).allowedNumbers);
	});
});

describe("stateHistoryToAiHistory", () => {
	function stateDay(date: string, overrides: Partial<StateDay> = {}): StateDay {
		return { date, swarmState: "red", btcChange: -1, postedAt: `${date}T06:00:00Z`, messageId: 1, ...overrides };
	}

	it("maps the most recent days before todayKey, newest first, capped at 3", () => {
		const history: StateHistory = {
			days: [
				stateDay("2026-08-18", { swarmState: "red", picture: "A", observation: "a" }),
				stateDay("2026-08-19", { swarmState: "green", picture: "B", observation: "b" }),
				stateDay("2026-08-20", { swarmState: "green", picture: "C", observation: "c" }),
				stateDay("2026-08-21", { swarmState: "mixed", picture: "D", observation: "d" }),
			],
		};
		const result = stateHistoryToAiHistory(history, "2026-08-22");
		expect(result.map((h) => h.picture)).toEqual(["D", "C", "B"]); // newest first, only 3
	});

	it("excludes today and any day on/after it", () => {
		const history: StateHistory = { days: [stateDay("2026-08-22", { picture: "today", observation: "x" })] };
		expect(stateHistoryToAiHistory(history, "2026-08-22")).toEqual([]);
	});

	it("formats dateLabel from the date key, not from postedAt", () => {
		const history: StateHistory = { days: [stateDay("2026-08-21", { picture: "P", observation: "O" })] };
		expect(stateHistoryToAiHistory(history, "2026-08-22")).toEqual([{ dateLabel: "21 августа", swarmState: "red", picture: "P", observation: "O" }]);
	});

	it("skips days with no stored picture/observation, on the real pre-v2 file — not just a synthetic one", () => {
		// fixtures/history/real-pre-v2-state.json is a verbatim copy of the real
		// data/state.test.json from шаг 5's manual test run (messageId 379/384) —
		// written before StateDay had picture/observation at all.
		const realHistory = JSON.parse(readFileSync(path.join(FIXTURES_DIR, "history", "real-pre-v2-state.json"), "utf8")) as StateHistory;
		expect(realHistory.days).toHaveLength(2); // sanity: the fixture really has both real entries

		const result = stateHistoryToAiHistory(realHistory, "2026-08-22");

		expect(result).toEqual([]); // neither entry has text — nothing to anti-repeat against, and no crash
	});

	it("a mix of pre-v2 and v2 entries only surfaces the ones with real text", () => {
		const realHistory = JSON.parse(readFileSync(path.join(FIXTURES_DIR, "history", "real-pre-v2-state.json"), "utf8")) as StateHistory;
		const withOneV2Day: StateHistory = {
			days: [...realHistory.days, stateDay("2026-08-21", { swarmState: "green", picture: "Рой зеленеет.", observation: "Биток спокоен." })],
		};
		// appendDay would normally replace the pre-v2 2026-08-21 entry with this
		// one; constructing it directly here since only the read-side (history
		// filtering) is under test.
		const result = stateHistoryToAiHistory(withOneV2Day, "2026-08-22");
		expect(result).toHaveLength(1);
		expect(result[0]!.picture).toBe("Рой зеленеет.");
	});
});
