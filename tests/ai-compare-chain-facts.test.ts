import { describe, expect, it } from "vitest";
import { computeChainStepFacts } from "../tools/ai-compare.js";
import { shiftDateKey, type Facts, type StateHistory } from "../src/facts.js";
import { appendDay } from "../src/state.js";
import type { HotCoinsSnapshot } from "../src/types.js";

// 5 coins, all positive — green/total = 1 >= 0.6, so swarmState is
// deterministically "green" every step (the whole point of --chain: same
// market conditions repeating, only the date advances).
const greenSnapshot: HotCoinsSnapshot = {
	version: 1,
	ts: "2026-08-20T09:00:00+03:00",
	btc: { price: 76_150, change24h: 2.1 },
	mainSwarm: [
		{ id: "a", ticker: "AAA", change24h: 5, price: 1, marketCap: null },
		{ id: "b", ticker: "BBB", change24h: 3, price: 1, marketCap: null },
		{ id: "c", ticker: "CCC", change24h: 2, price: 1, marketCap: null },
		{ id: "d", ticker: "DDD", change24h: 4, price: 1, marketCap: null },
		{ id: "e", ticker: "EEE", change24h: 1, price: 1, marketCap: null },
	],
	edgePins: [],
};

const BASE_DATE_KEY = "2026-08-20";

/**
 * Mirrors runChainForFixture()'s own loop exactly: compute each step's facts
 * from the accumulated chainHistory, then append that step's own day —
 * "template"/"ai" source, chosen per step by `degradedSteps` — before moving
 * to the next step. Never a hole, same as production.
 */
function simulateChain(stepCount: number, degradedSteps: Set<number> = new Set()): Facts[] {
	let chainHistory: StateHistory = { days: [] };
	const factsPerStep: Facts[] = [];

	for (let k = 1; k <= stepCount; k++) {
		const todayKey = shiftDateKey(BASE_DATE_KEY, k - 1);
		const facts = computeChainStepFacts(greenSnapshot, todayKey, chainHistory);
		factsPerStep.push(facts);

		chainHistory = appendDay(chainHistory, {
			date: todayKey,
			swarmState: facts.swarmState,
			btcChange: facts.btc?.change24h ?? null,
			postedAt: new Date().toISOString(),
			messageId: 0,
			picture: "x",
			observation: "y",
			source: degradedSteps.has(k) ? "template" : "ai",
		});
	}

	return factsPerStep;
}

describe("computeChainStepFacts", () => {
	it("round-trips todayKey exactly through moscowDateKey — noon Moscow time is unambiguous", () => {
		const facts = computeChainStepFacts(greenSnapshot, "2026-08-23", { days: [] });
		expect(facts.dateKey).toBe("2026-08-23");
	});

	it("keeps red/green/total/swarmState pinned to the snapshot's own numbers regardless of chainHistory", () => {
		const withHistory = computeChainStepFacts(greenSnapshot, "2026-08-25", {
			days: [{ date: "2026-08-24", swarmState: "red", btcChange: -1, postedAt: "", messageId: 0 }],
		});
		expect(withHistory.green).toBe(5);
		expect(withHistory.red).toBe(0);
		expect(withHistory.total).toBe(5);
		expect(withHistory.swarmState).toBe("green");
	});
});

describe("--chain streak/prevState: real computeFacts() derivation, not pinned to day 1", () => {
	it("increases streak by 1 each step when swarmState matches the previous step (the bug: this used to stay at 1 forever)", () => {
		const facts = simulateChain(4);
		expect(facts.map((f) => f.streak)).toEqual([1, 2, 3, 4]);
	});

	it("prevState is the previous step's own swarmState, not null forever", () => {
		const facts = simulateChain(3);
		expect(facts[0]!.prevState).toBeNull();
		expect(facts[1]!.prevState).toBe("green");
		expect(facts[2]!.prevState).toBe("green");
	});

	it("a --chain-degrade template step does not break the streak — the swarm was still the same swarm that day", () => {
		// Step 2 is forced onto the template path (source: "template"), but it's
		// still appended to chainHistory — never a hole — so step 3's streak
		// must continue counting through it: 1, 2, 3, not reset to 1 at step 3.
		const facts = simulateChain(3, new Set([2]));
		expect(facts.map((f) => f.streak)).toEqual([1, 2, 3]);
		expect(facts[2]!.prevState).toBe("green");
	});

	it("a hole in chainHistory (day never recorded at all) would still break the streak — sanity check that appendDay is really what carries it forward", () => {
		// Not a --chain scenario (chainHistory always appends every step) — this
		// just confirms computeChainStepFacts still respects computeFacts's own
		// hole-breaks-streak rule, by skipping the append for step 2 by hand.
		let chainHistory: StateHistory = { days: [] };
		const day1 = computeChainStepFacts(greenSnapshot, "2026-08-20", chainHistory);
		chainHistory = appendDay(chainHistory, { date: "2026-08-20", swarmState: day1.swarmState, btcChange: null, postedAt: "", messageId: 0 });
		// step 2's day is deliberately never appended — a hole.
		const day3 = computeChainStepFacts(greenSnapshot, "2026-08-22", chainHistory);
		expect(day3.streak).toBe(1);
		expect(day3.prevState).toBeNull();
	});
});
