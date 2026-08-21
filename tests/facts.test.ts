import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnapshotFromFile } from "../src/snapshot.js";
import { computeFacts, type StateHistory } from "../src/facts.js";
import type { HotCoinsSnapshot } from "../src/types.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const EMPTY_HISTORY: StateHistory = { days: [] };

function snapshot(name: string): HotCoinsSnapshot {
	return loadSnapshotFromFile(path.join(FIXTURES_DIR, name));
}

function history(name: string): StateHistory {
	return JSON.parse(readFileSync(path.join(FIXTURES_DIR, "history", name), "utf8"));
}

describe("computeFacts: date handling (Europe/Moscow, explicit — раздел 4.1)", () => {
	it("derives dateLabel/dateKey from the snapshot ts in Moscow time", () => {
		const snap: HotCoinsSnapshot = { version: 1, ts: "2026-07-13T10:00:00.000Z", btc: null, mainSwarm: [], edgePins: [] };
		const facts = computeFacts(snap, EMPTY_HISTORY);
		expect(facts.dateKey).toBe("2026-07-13");
		expect(facts.dateLabel).toBe("13 июля");
	});

	it("crosses into the next Moscow day at 21:00 UTC / 00:00 MSK, not at UTC midnight", () => {
		const before: HotCoinsSnapshot = { version: 1, ts: "2026-07-13T20:29:00.000Z", btc: null, mainSwarm: [], edgePins: [] }; // 23:29 MSK
		const after: HotCoinsSnapshot = { version: 1, ts: "2026-07-13T21:01:00.000Z", btc: null, mainSwarm: [], edgePins: [] }; // 00:01 MSK next day
		expect(computeFacts(before, EMPTY_HISTORY).dateKey).toBe("2026-07-13");
		expect(computeFacts(after, EMPTY_HISTORY).dateKey).toBe("2026-07-14");
	});
});

describe("computeFacts: red/green counting and swarmState", () => {
	it("counts red/green only from mainSwarm", () => {
		const facts = computeFacts(snapshot("red-streak.json"), EMPTY_HISTORY);
		expect(facts.red).toBe(45);
		expect(facts.green).toBe(21);
		expect(facts.total).toBe(66);
		expect(facts.swarmState).toBe("red");
	});

	it("classifies a strongly green day as green", () => {
		expect(computeFacts(snapshot("green.json"), EMPTY_HISTORY).swarmState).toBe("green");
	});

	it("classifies a roughly even split as mixed", () => {
		expect(computeFacts(snapshot("mixed.json"), EMPTY_HISTORY).swarmState).toBe("mixed");
	});

	it("treats red/total exactly 0.6 as red — pins the boundary to >=, not >", () => {
		const facts = computeFacts(snapshot("red-boundary-60.json"), EMPTY_HISTORY);
		expect(facts.red).toBe(30);
		expect(facts.green).toBe(20);
		expect(facts.red / facts.total).toBe(0.6);
		expect(facts.swarmState).toBe("red");
	});
});

describe("computeFacts: leaders", () => {
	it("excludes stablecoins (explicit list + near-$1/zero-change heuristic) from winners/losers", () => {
		const facts = computeFacts(snapshot("real-day.json"), EMPTY_HISTORY);
		const tickers = new Set([...facts.winners, ...facts.losers].map((c) => c.ticker));
		expect(tickers.has("USDGO")).toBe(false);
		expect(tickers.has("EURSAFO")).toBe(false);
	});

	it("sorts winners descending and losers ascending by change24h", () => {
		const facts = computeFacts(snapshot("mixed.json"), EMPTY_HISTORY);
		for (let i = 1; i < facts.winners.length; i++) {
			expect(facts.winners[i - 1]!.change24h).toBeGreaterThanOrEqual(facts.winners[i]!.change24h);
		}
		for (let i = 1; i < facts.losers.length; i++) {
			expect(facts.losers[i - 1]!.change24h).toBeLessThanOrEqual(facts.losers[i]!.change24h);
		}
	});

	it("puts the HTML-unsafe tickers at the extremes for the escape-html fixture", () => {
		const facts = computeFacts(snapshot("escape-html.json"), EMPTY_HISTORY);
		expect(facts.winners[0]!.ticker).toBe("A&B");
		expect(facts.losers[0]!.ticker).toBe("<b>X");
	});
});

describe("computeFacts: maxAbsEdgeChange", () => {
	it("is 0 (not -Infinity or NaN) when edgePins is empty — reduce with a 0 seed", () => {
		const facts = computeFacts(snapshot("edge-empty.json"), EMPTY_HISTORY);
		expect(facts.maxAbsEdgeChange).toBe(0);
		expect(Number.isFinite(facts.maxAbsEdgeChange)).toBe(true);
	});

	it("is the largest absolute edge change otherwise", () => {
		expect(computeFacts(snapshot("red-first-day.json"), EMPTY_HISTORY).maxAbsEdgeChange).toBe(25);
	});
});

describe("computeFacts: btc", () => {
	it("passes btc through unchanged when present", () => {
		const facts = computeFacts(snapshot("real-day.json"), EMPTY_HISTORY);
		expect(facts.btc).toEqual({ price: 77788, change24h: 8.4 });
	});

	it("is null when the snapshot has no BTC data at all", () => {
		const facts = computeFacts(snapshot("no-btc.json"), EMPTY_HISTORY);
		expect(facts.btc).toBeNull();
	});
});

describe("computeFacts: streak", () => {
	// fixtures/red-streak.json is dated 2026-08-18 (Europe/Moscow) — every history
	// fixture below is anchored to that date as "today".
	const today = snapshot("red-streak.json");

	it("is 1 on the very first run (empty history)", () => {
		expect(computeFacts(today, EMPTY_HISTORY).streak).toBe(1);
	});

	it("is 2 with one red day immediately before today", () => {
		expect(computeFacts(today, history("red-1-day-before.json")).streak).toBe(2);
	});

	it("is 4 with three red days immediately before today", () => {
		expect(computeFacts(today, history("red-3-days-before.json")).streak).toBe(4);
	});

	it("resets to 1 when the state switched (prior day was green)", () => {
		expect(computeFacts(today, history("green-to-red.json")).streak).toBe(1);
	});

	it("resets to 1 when there's a gap right before today, even with older red history", () => {
		expect(computeFacts(today, history("gap-before-today.json")).streak).toBe(1);
	});
});
