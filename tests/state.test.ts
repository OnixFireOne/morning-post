import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StateDay, StateHistory } from "../src/facts.js";
import { appendDay, findPostedDay, readState, writeStateAtomic } from "../src/state.js";

function day(date: string, overrides: Partial<StateDay> = {}): StateDay {
	return { date, swarmState: "red", btcChange: -1, postedAt: `${date}T06:00:00Z`, messageId: 1, ...overrides };
}

describe("readState", () => {
	it("returns an empty history when the file doesn't exist yet", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "morning-post-state-"));
		try {
			expect(readState(path.join(dir, "state.json"))).toEqual({ days: [] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("findPostedDay", () => {
	it("finds the entry for a given date key", () => {
		const history: StateHistory = { days: [day("2026-08-17"), day("2026-08-18")] };
		expect(findPostedDay(history, "2026-08-18")?.date).toBe("2026-08-18");
		expect(findPostedDay(history, "2026-08-19")).toBeUndefined();
	});
});

describe("appendDay", () => {
	it("adds a new day and keeps the history sorted by date", () => {
		const history: StateHistory = { days: [day("2026-08-17"), day("2026-08-19")] };
		const result = appendDay(history, day("2026-08-18"));
		expect(result.days.map((d) => d.date)).toEqual(["2026-08-17", "2026-08-18", "2026-08-19"]);
	});

	it("replaces an existing entry for the same date instead of duplicating it (--force repost)", () => {
		const history: StateHistory = { days: [day("2026-08-18", { messageId: 100 })] };
		const result = appendDay(history, day("2026-08-18", { messageId: 200 }));
		expect(result.days).toHaveLength(1);
		expect(result.days[0]!.messageId).toBe(200);
	});

	it("keeps only the last ~60 days", () => {
		const days = Array.from({ length: 65 }, (_, i) => day(`2026-01-${String(i + 1).padStart(3, "0")}`));
		// dates aren't calendar-valid past day 31, but that's fine — appendDay only
		// cares about lexicographic order, exactly like the real YYYY-MM-DD keys do.
		let history: StateHistory = { days: [] };
		for (const d of days) history = appendDay(history, d);
		expect(history.days).toHaveLength(60);
		expect(history.days[0]!.date).toBe("2026-01-006");
		expect(history.days.at(-1)!.date).toBe("2026-01-065");
	});
});

describe("writeStateAtomic + readState round-trip", () => {
	it("writes and reads back the same history", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "morning-post-state-"));
		try {
			const stateFile = path.join(dir, "nested", "state.json");
			const history: StateHistory = { days: [day("2026-08-18")] };
			writeStateAtomic(stateFile, history);
			expect(readState(stateFile)).toEqual(history);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves no leftover tmp file after a successful write", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "morning-post-state-"));
		try {
			const stateFile = path.join(dir, "state.json");
			writeStateAtomic(stateFile, { days: [day("2026-08-18")] });
			expect(readdirSync(dir)).toEqual(["state.json"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
