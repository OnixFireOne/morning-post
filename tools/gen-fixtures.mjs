// Regenerates every derived snapshot fixture in fixtures/ from fixtures/real-day.json.
// fixtures/real-day.json itself is the real capture from inp.one and is never touched here.
//
// Run: node tools/gen-fixtures.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");

const base = JSON.parse(readFileSync(path.join(FIXTURES_DIR, "real-day.json"), "utf8"));

const STABLE_TICKERS = new Set(["USDGO", "EURSAFO"]);
// Kept present (with a non-zero change24h) in every fixture on purpose: real edge
// cases from the live site (non-latin ticker, underscore, single letter) that
// double as escaping/filtering tests. See раздел 9, п.2 плана.
const REQUIRED_NONSTABLE_TICKERS = ["BTC", "FIGR_HELOC", "M", "币安人生"];

function clone(o) {
	return JSON.parse(JSON.stringify(o));
}

function round1(n) {
	return Math.round(n * 10) / 10;
}

// Deterministic PRNG (mulberry32) so regenerating fixtures reproduces the same numbers.
function prng(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffle(arr, rnd) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

/**
 * Builds a mainSwarm of exactly `totalNonNeutral` coins with non-zero change24h
 * (`redCount` of them negative, the rest positive) plus the two stablecoins
 * pinned at 0. REQUIRED_NONSTABLE_TICKERS (minus BTC when `includeBtc` is
 * false) are always included among the non-neutral coins; the rest are
 * filled from the real dataset.
 *
 * BTC's sign is fixed by `btcChange` *before* the random split, and counted
 * against `redCount` — assigning it after the split would silently turn a
 * 30/20 boundary fixture into 31/19 whenever btcChange disagreed with the
 * coin's randomly-drawn sign.
 */
function buildSwarm(seed, { totalNonNeutral, redCount, magMin, magMax, btcChange, includeBtc = true }) {
	const rnd = prng(seed);
	const byTicker = new Map(base.mainSwarm.map((c) => [c.ticker, c]));

	const requiredTickers = includeBtc ? REQUIRED_NONSTABLE_TICKERS : REQUIRED_NONSTABLE_TICKERS.filter((t) => t !== "BTC");
	const required = requiredTickers.map((t) => clone(byTicker.get(t)));
	const stableCoins = [...STABLE_TICKERS].map((t) => clone(byTicker.get(t)));

	const pool = shuffle(
		base.mainSwarm.filter((c) => !REQUIRED_NONSTABLE_TICKERS.includes(c.ticker) && !STABLE_TICKERS.has(c.ticker)).map(clone),
		rnd,
	);
	const filler = pool.slice(0, Math.max(0, totalNonNeutral - required.length));
	const nonNeutral = [...required, ...filler];

	const btcIndex = includeBtc ? nonNeutral.findIndex((c) => c.ticker === "BTC") : -1;
	const btcIsRed = includeBtc && btcChange < 0;
	const otherIndices = nonNeutral.map((_, i) => i).filter((i) => i !== btcIndex);
	const otherRedCount = redCount - (btcIsRed ? 1 : 0);

	const signOrder = shuffle(otherIndices, rnd);
	const redSet = new Set(signOrder.slice(0, otherRedCount));
	if (btcIsRed) redSet.add(btcIndex);

	nonNeutral.forEach((coin, i) => {
		if (i === btcIndex) {
			coin.change24h = btcChange;
			return;
		}
		const mag = magMin + rnd() * (magMax - magMin);
		coin.change24h = round1(redSet.has(i) ? -mag : mag);
	});
	stableCoins.forEach((c) => (c.change24h = 0));

	return [...nonNeutral, ...stableCoins];
}

function edgePinsFrom(changes) {
	return base.edgePins.map((coin, i) => ({ ...clone(coin), change24h: changes[i % changes.length] }));
}

function write(name, obj) {
	writeFileSync(path.join(FIXTURES_DIR, name), JSON.stringify(obj));
	console.log("wrote", name);
}

function btcField(mainSwarm, change24h) {
	const btcCoin = mainSwarm.find((c) => c.ticker === "BTC");
	return { price: btcCoin.price, change24h };
}

// --- red-streak: strong red day, BTC clearly leading the move (|btc%|>=3 branch) ---
{
	const mainSwarm = buildSwarm(1, { totalNonNeutral: 66, redCount: 45, magMin: 0.5, magMax: 9, btcChange: -4.1 });
	const edgePins = edgePinsFrom([-9.8, -7.2, 6.1, -8.9, -6.5, -5.4]);
	write("red-streak.json", {
		version: 1,
		ts: "2026-08-18T07:12:03.000Z",
		btc: btcField(mainSwarm, -4.1),
		mainSwarm,
		edgePins,
	});
}

// --- red-first-day: matches the reference post example (quiet BTC dump, wild edges) ---
{
	const mainSwarm = buildSwarm(2, { totalNonNeutral: 66, redCount: 46, magMin: 0.3, magMax: 6, btcChange: -0.59 });
	const edgePins = edgePinsFrom([25, -25, 12, -14, 9, -11]);
	write("red-first-day.json", {
		version: 1,
		ts: "2026-08-19T06:58:40.000Z",
		btc: btcField(mainSwarm, -0.59),
		mainSwarm,
		edgePins,
	});
}

// --- green: strong green day, streak-eligible ---
{
	const mainSwarm = buildSwarm(3, { totalNonNeutral: 66, redCount: 16, magMin: 0.5, magMax: 10, btcChange: 6.3 });
	const edgePins = edgePinsFrom([31.4, 18.2, -6.5, 22.7, 14.9, 9.8]);
	write("green.json", {
		version: 1,
		ts: "2026-08-20T06:41:12.000Z",
		btc: btcField(mainSwarm, 6.3),
		mainSwarm,
		edgePins,
	});
}

// --- mixed: roughly even split, no dominant branch ---
{
	const mainSwarm = buildSwarm(4, { totalNonNeutral: 66, redCount: 33, magMin: 0.5, magMax: 7, btcChange: 1.6 });
	const edgePins = edgePinsFrom([11.5, -10.2, 7.4, -8.1, 6.6, -5.9]);
	write("mixed.json", {
		version: 1,
		ts: "2026-08-21T06:30:55.000Z",
		btc: btcField(mainSwarm, 1.6),
		mainSwarm,
		edgePins,
	});
}

// --- boring: small moves everywhere, edges stay under +-8% ---
{
	const mainSwarm = buildSwarm(5, { totalNonNeutral: 66, redCount: 31, magMin: 0.1, magMax: 2.5, btcChange: 0.31 });
	const edgePins = edgePinsFrom([4.2, -3.8, 2.1, -2.6, 5.5, -4.9]);
	write("boring.json", {
		version: 1,
		ts: "2026-08-17T06:20:00.000Z",
		btc: btcField(mainSwarm, 0.31),
		mainSwarm,
		edgePins,
	});
}

// --- no-btc: BTC fell out of the swarm and the site's own fallback also came up
// empty — snapshot.btc is null and there's no "BTC" entry in mainSwarm either.
// Text branches must render without the BTC header line at all (раздел 4.1 update).
{
	const mainSwarm = buildSwarm(6, { totalNonNeutral: 65, redCount: 33, magMin: 0.5, magMax: 8, btcChange: 0, includeBtc: false });
	const edgePins = edgePinsFrom([13.2, -12.4, 8.9, -9.3, 5.2, -6.7]);
	write("no-btc.json", {
		version: 1,
		ts: "2026-08-16T06:15:30.000Z",
		btc: null,
		mainSwarm,
		edgePins,
	});
}

// --- edge-empty: no edge pins at all — leaders (and maxAbsLeaderChange) must
// still come from mainSwarm, not silently read as 0 (раздел про инцидент 23.08) ---
{
	const mainSwarm = buildSwarm(7, { totalNonNeutral: 66, redCount: 30, magMin: 0.5, magMax: 6, btcChange: 0.9 });
	write("edge-empty.json", {
		version: 1,
		ts: "2026-08-15T06:10:00.000Z",
		btc: btcField(mainSwarm, 0.9),
		mainSwarm,
		edgePins: [],
	});
}

// --- red-boundary-60: red/total exactly 0.6 (30 of 50) — pins down `>=`, not `>` ---
{
	const mainSwarm = buildSwarm(8, { totalNonNeutral: 50, redCount: 30, magMin: 0.5, magMax: 6, btcChange: -1.2 });
	const edgePins = edgePinsFrom([9.5, -8.7, 6.3, -7.1, 5.4, -4.6]);
	write("red-boundary-60.json", {
		version: 1,
		ts: "2026-08-14T06:05:00.000Z",
		btc: btcField(mainSwarm, -1.2),
		mainSwarm,
		edgePins,
	});
}

// --- escape-html: winner/loser tickers carry raw `&` and `<b>` — escapeHtml() must survive them ---
{
	const mainSwarm = buildSwarm(9, { totalNonNeutral: 66, redCount: 32, magMin: 0.5, magMax: 15, btcChange: 2.1 });
	const edgePins = edgePinsFrom([10.4, -9.6, 7.8, -6.9, 5.1, -4.4]);
	edgePins[0] = { id: "test-amp-coin", ticker: "A&B", change24h: 52.3, price: 1.23, marketCap: 10_000_000 };
	edgePins[1] = { id: "test-html-coin", ticker: "<b>X", change24h: -52.7, price: 0.45, marketCap: 9_000_000 };
	write("escape-html.json", {
		version: 1,
		ts: "2026-08-13T06:00:00.000Z",
		btc: btcField(mainSwarm, 2.1),
		mainSwarm,
		edgePins,
	});
}
