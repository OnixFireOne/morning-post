import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnapshotFileOrThrow, loadSnapshotFromFile, parseSnapshot, resolveSnapshotSource } from "../src/snapshot.js";

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

// index.ts used to decide file-vs-browser with a bare `if (env.snapshotFile)`,
// scattered around its own merge of a positional arg and process.env — this
// pins the decision itself down as a pure function. `fixture` is now the
// already-parsed --fixture=<path> value (cliArgs.ts's CliArgs.fixture, null
// when the flag wasn't passed), not an env var.
describe("resolveSnapshotSource", () => {
	it("file mode when fixture is a real path", () => {
		expect(resolveSnapshotSource({ fixture: "./fixtures/green.json", siteUrl: "https://inp.one/?snapshot=1" })).toEqual({
			mode: "file",
			path: "./fixtures/green.json",
		});
	});

	it("trims a fixture path with surrounding whitespace", () => {
		expect(resolveSnapshotSource({ fixture: "  ./fixtures/green.json  " })).toEqual({ mode: "file", path: "./fixtures/green.json" });
	});

	it("browser mode when fixture is null (flag never passed)", () => {
		expect(resolveSnapshotSource({ fixture: null, siteUrl: "https://inp.one/?snapshot=1" })).toEqual({ mode: "browser", url: "https://inp.one/?snapshot=1" });
	});

	it("browser mode when fixture is an empty string (--fixture= with nothing after it)", () => {
		expect(resolveSnapshotSource({ fixture: "", siteUrl: "https://inp.one/?snapshot=1" })).toEqual({ mode: "browser", url: "https://inp.one/?snapshot=1" });
	});

	it("browser mode when fixture is whitespace-only — not a zero-length path, still 'not set'", () => {
		expect(resolveSnapshotSource({ fixture: "   ", siteUrl: "https://inp.one/?snapshot=1" })).toEqual({ mode: "browser", url: "https://inp.one/?snapshot=1" });
	});

	it("trims a siteUrl with surrounding whitespace", () => {
		expect(resolveSnapshotSource({ fixture: null, siteUrl: "  https://inp.one/?snapshot=1  " })).toEqual({ mode: "browser", url: "https://inp.one/?snapshot=1" });
	});

	it("browser mode with an empty url when neither fixture nor siteUrl is set — caller decides whether that's an error", () => {
		expect(resolveSnapshotSource({ fixture: null })).toEqual({ mode: "browser", url: "" });
		expect(resolveSnapshotSource({ fixture: "", siteUrl: "   " })).toEqual({ mode: "browser", url: "" });
	});
});

describe("loadSnapshotFileOrThrow", () => {
	it("loads a real fixture exactly like loadSnapshotFromFile", () => {
		const filePath = path.join(FIXTURES_DIR, "real-day.json");
		expect(loadSnapshotFileOrThrow(filePath)).toEqual(loadSnapshotFromFile(filePath));
	});

	it("a missing file gets a message naming the actual path, not a bare ENOENT", () => {
		const missingPath = path.join(FIXTURES_DIR, "does-not-exist.json");
		let thrown: unknown;
		try {
			loadSnapshotFileOrThrow(missingPath);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(message).toContain(missingPath);
		expect(message).toContain("--fixture=");
	});

	it("a malformed (non-ENOENT) failure — bad JSON — passes through unchanged, not reworded as a missing-file error", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "morning-post-snapshot-"));
		try {
			const badFile = path.join(dir, "not-json.json");
			writeFileSync(badFile, "this is not json");
			expect(() => loadSnapshotFileOrThrow(badFile)).toThrow(SyntaxError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
