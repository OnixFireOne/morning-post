import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Facts } from "../src/facts.js";
import { appendFactsLogLine, formatFactsLogLine, type FactsLogEntry } from "../src/factsLog.js";

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

function entry(overrides: Partial<FactsLogEntry> = {}): FactsLogEntry {
	const facts = specExampleFacts();
	return {
		date: facts.dateKey,
		facts,
		topGainer: { ticker: "TRAC", change24h: 18 },
		topLoser: { ticker: "PI", change24h: -17 },
		source: "ai",
		model: "anthropic/claude-sonnet-5",
		provider: "Anthropic",
		promptVersion: 4,
		attempts: 1,
		...overrides,
	};
}

describe("formatFactsLogLine", () => {
	it("is exactly JSON.stringify(entry) — one self-contained JSON object per line, no wrapping", () => {
		const e = entry();
		const line = formatFactsLogLine(e);
		expect(() => JSON.parse(line)).not.toThrow();
		expect(JSON.parse(line)).toEqual(e);
	});
});

describe("appendFactsLogLine", () => {
	let tmpDir: string;

	function withTmpDir<T>(fn: (dir: string) => T): T {
		tmpDir = mkdtempSync(path.join(tmpdir(), "morning-post-facts-log-"));
		try {
			return fn(tmpDir);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}

	it("creates the parent directory if it doesn't exist yet", () => {
		withTmpDir((dir) => {
			const file = path.join(dir, "nested", "facts.jsonl");
			expect(existsSync(path.dirname(file))).toBe(false);
			appendFactsLogLine(file, entry());
			expect(existsSync(file)).toBe(true);
		});
	});

	it("writes the whole Facts object, both leaders' ticker/change24h, source, model, and promptVersion — round-trips exactly", () => {
		withTmpDir((dir) => {
			const file = path.join(dir, "facts.jsonl");
			const e = entry();
			appendFactsLogLine(file, e);

			const lines = readFileSync(file, "utf8").trim().split("\n");
			expect(lines).toHaveLength(1);
			const parsed = JSON.parse(lines[0]!) as FactsLogEntry;
			expect(parsed).toEqual(e);
			expect(parsed.facts).toEqual(e.facts); // the entire Facts object, not a subset
			expect(parsed.topGainer).toEqual({ ticker: "TRAC", change24h: 18 });
			expect(parsed.topLoser).toEqual({ ticker: "PI", change24h: -17 });
		});
	});

	it("is append-only — a second write adds a line, never rewrites or truncates the first", () => {
		withTmpDir((dir) => {
			const file = path.join(dir, "facts.jsonl");
			appendFactsLogLine(file, entry({ date: "2026-08-23" }));
			appendFactsLogLine(file, entry({ date: "2026-08-24", facts: specExampleFacts({ dateKey: "2026-08-24" }) }));

			const lines = readFileSync(file, "utf8").trim().split("\n");
			expect(lines).toHaveLength(2);
			expect((JSON.parse(lines[0]!) as FactsLogEntry).date).toBe("2026-08-23");
			expect((JSON.parse(lines[1]!) as FactsLogEntry).date).toBe("2026-08-24");
		});
	});

	it("records template days too — source: template, model and promptVersion null", () => {
		withTmpDir((dir) => {
			const file = path.join(dir, "facts.jsonl");
			appendFactsLogLine(file, entry({ source: "template", model: null, promptVersion: null }));

			const [line] = readFileSync(file, "utf8").trim().split("\n");
			const parsed = JSON.parse(line!) as FactsLogEntry;
			expect(parsed.source).toBe("template");
			expect(parsed.model).toBeNull();
			expect(parsed.promptVersion).toBeNull();
		});
	});

	// 02.09: without `attempts`, a day recovered by a same-model retry (e.g. a
	// malformed invalid_json first response — src/ai/generate.ts) was
	// indistinguishable here from a clean first-try success: both show
	// source: "ai" and no failureReason. This is the field that tells them
	// apart, alongside usage.jsonl's own per-attempt record.
	it("attempts distinguishes a retry-recovered day (attempts: 2) from a clean first-try success (attempts: 1) — both source: ai", () => {
		withTmpDir((dir) => {
			const file = path.join(dir, "facts.jsonl");
			appendFactsLogLine(file, entry({ date: "2026-08-23", attempts: 1 }));
			appendFactsLogLine(file, entry({ date: "2026-08-24", attempts: 2, facts: specExampleFacts({ dateKey: "2026-08-24" }) }));

			const lines = readFileSync(file, "utf8").trim().split("\n");
			const [clean, retried] = lines.map((l) => JSON.parse(l) as FactsLogEntry);
			expect(clean!.source).toBe("ai");
			expect(clean!.attempts).toBe(1);
			expect(retried!.source).toBe("ai");
			expect(retried!.attempts).toBe(2);
		});
	});

	it("attempts is null when AI was never attempted at all (AI_ENABLED=0), same as model/promptVersion", () => {
		withTmpDir((dir) => {
			const file = path.join(dir, "facts.jsonl");
			appendFactsLogLine(file, entry({ source: "template", model: null, promptVersion: null, attempts: null }));

			const [line] = readFileSync(file, "utf8").trim().split("\n");
			const parsed = JSON.parse(line!) as FactsLogEntry;
			expect(parsed.attempts).toBeNull();
		});
	});

	it("records null topGainer/topLoser when there are no leaders at all", () => {
		withTmpDir((dir) => {
			const file = path.join(dir, "facts.jsonl");
			appendFactsLogLine(file, entry({ topGainer: null, topLoser: null }));

			const [line] = readFileSync(file, "utf8").trim().split("\n");
			const parsed = JSON.parse(line!) as FactsLogEntry;
			expect(parsed.topGainer).toBeNull();
			expect(parsed.topLoser).toBeNull();
		});
	});
});
