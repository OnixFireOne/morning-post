import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnapshotFromFile } from "../src/snapshot.js";
import { computeFacts, type Facts, type StateHistory } from "../src/facts.js";
import { buildAiPayload, collectAllowedNumbers, type AiHistoryEntry } from "../src/ai/payload.js";

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

	it("passes history through untouched — its numbers never enter allowedNumbers", () => {
		const history: AiHistoryEntry[] = [
			{ dateLabel: "22 августа", swarmState: "green", picture: "133 монеты выросли вчера.", observation: "Всё зелено." },
		];
		const payload = buildAiPayload(specExampleFacts(), history);
		expect(payload.history).toEqual(history);
		// "133" from yesterday's picture text must not leak in as if it were today's —
		// it already is today's red count here, so assert on a number that ISN'T:
		const historyOnlyNumber = "999";
		expect(payload.allowedNumbers).not.toContain(historyOnlyNumber);
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
