import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnapshotFromFile, parseSnapshot } from "../src/snapshot.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

const EDGE_CASE_TICKERS = ["FIGR_HELOC", "M", "币安人生", "USDGO", "EURSAFO"];

describe("loadSnapshotFromFile", () => {
	it("loads the real snapshot verbatim", () => {
		const snap = loadSnapshotFromFile(path.join(FIXTURES_DIR, "real-day.json"));
		expect(snap.version).toBe(1);
		expect(snap.btc).toEqual({ price: 77788, change24h: 8.4 });
		expect(snap.mainSwarm.length).toBeGreaterThan(0);
		expect(snap.edgePins.length).toBeGreaterThan(0);
	});

	it.each([
		"red-streak.json",
		"red-first-day.json",
		"green.json",
		"mixed.json",
		"boring.json",
		"edge-empty.json",
		"red-boundary-60.json",
		"escape-html.json",
	])("loads derived fixture %s and keeps the edge-case tickers", (name) => {
		const snap = loadSnapshotFromFile(path.join(FIXTURES_DIR, name));
		expect(snap.version).toBe(1);
		const tickers = new Set(snap.mainSwarm.map((c) => c.ticker));
		for (const ticker of EDGE_CASE_TICKERS) {
			expect(tickers.has(ticker), `missing ${ticker} in ${name}`).toBe(true);
		}
	});

	it("keeps btc null and drops the BTC coin from mainSwarm for the no-btc fixture", () => {
		const snap = loadSnapshotFromFile(path.join(FIXTURES_DIR, "no-btc.json"));
		expect(snap.btc).toBeNull();
		expect(snap.mainSwarm.some((c) => c.ticker === "BTC")).toBe(false);
	});

	it("has no edge pins in the edge-empty fixture", () => {
		const snap = loadSnapshotFromFile(path.join(FIXTURES_DIR, "edge-empty.json"));
		expect(snap.edgePins).toEqual([]);
	});

	it("carries raw HTML-unsafe tickers in the escape-html fixture", () => {
		const snap = loadSnapshotFromFile(path.join(FIXTURES_DIR, "escape-html.json"));
		const tickers = snap.edgePins.map((c) => c.ticker);
		expect(tickers).toContain("A&B");
		expect(tickers).toContain("<b>X");
	});
});

describe("parseSnapshot", () => {
	it("rejects a missing/unknown contract version", () => {
		expect(() => parseSnapshot({ version: 2 })).toThrow(/contract version/);
		expect(() => parseSnapshot({})).toThrow(/contract version/);
	});

	it("rejects non-object input", () => {
		expect(() => parseSnapshot(null)).toThrow(/expected an object/);
	});
});
