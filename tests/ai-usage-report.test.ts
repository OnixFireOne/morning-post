import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildUsageReport, readUsageRecords, type TodayUsage, type UsageReportInput } from "../src/ai/usageReport.js";
import type { UsageRecord } from "../src/ai/usage.js";

function tmpUsageFile(lines: string[]): { file: string; dir: string } {
	const dir = mkdtempSync(path.join(tmpdir(), "morning-post-usage-report-"));
	const file = path.join(dir, "usage.jsonl");
	writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
	return { file, dir };
}

function usageLine(overrides: Partial<UsageRecord> = {}): string {
	const record: UsageRecord = {
		timestamp: "2026-08-25T06:01:00.000Z",
		attempt: 1,
		provider: "proxy.example.com",
		model: "claude-sonnet-4-7",
		promptVersion: 4,
		tokensIn: 3081,
		tokensOut: 287,
		tokensTotal: 3368,
		cachedTokens: null,
		usageReported: true,
		durationMs: 900,
		outcome: "ok",
		finishReason: "stop",
		costEstimate: 0.0552,
		...overrides,
	};
	return JSON.stringify(record);
}

function today(overrides: Partial<TodayUsage> = {}): TodayUsage {
	return {
		source: "ai",
		model: "claude-sonnet-4-7",
		attempts: 1,
		tokensIn: 3081,
		tokensOut: 287,
		totalCost: 0.0552,
		failureReason: null,
		...overrides,
	};
}

function baseInput(overrides: Partial<UsageReportInput> = {}): UsageReportInput {
	return {
		aiEnabled: true,
		mode: "daily",
		dateKey: "2026-08-25",
		today: today(),
		usageFile: path.join(tmpdir(), "does-not-exist-morning-post-usage.jsonl"),
		dailyTokenWarn: null,
		balanceStart: null,
		balanceAsOf: null,
		balanceWarn: null,
		...overrides,
	};
}

describe("buildUsageReport: AI_ENABLED gate", () => {
	it("returns null when AI is disabled, regardless of everything else", () => {
		expect(buildUsageReport(baseInput({ aiEnabled: false, mode: "daily" }))).toBeNull();
	});
});

describe("buildUsageReport: AI_USAGE_REPORT modes", () => {
	it("returns null when mode is '0'", () => {
		expect(buildUsageReport(baseInput({ mode: "0" }))).toBeNull();
	});

	it("weekly mode is silent on a non-Sunday", () => {
		// 2026-08-25 is a Tuesday.
		expect(buildUsageReport(baseInput({ mode: "weekly", dateKey: "2026-08-25" }))).toBeNull();
	});

	it("weekly mode produces a report on Sunday", () => {
		// 2026-08-23 is a Sunday.
		const report = buildUsageReport(baseInput({ mode: "weekly", dateKey: "2026-08-23" }));
		expect(report).not.toBeNull();
		expect(report).toMatch(/^Неделя до/m);
	});
});

describe("buildUsageReport: degradation to template", () => {
	it("puts the degradation reason on the first line", () => {
		const report = buildUsageReport(
			baseInput({
				today: today({ source: "template", model: null, attempts: 2, failureReason: "primary-model attempt 1: validator:numbers; fallback-model attempt 1: timeout; all models and retries exhausted" }),
			}),
		);
		expect(report).not.toBeNull();
		const firstLine = report!.split("\n")[0];
		expect(firstLine).toContain("ИИ не отработал, пост ушёл шаблоном");
		expect(firstLine).toContain("validator:numbers");
	});

	it("has no degradation line when the AI path succeeded", () => {
		const report = buildUsageReport(baseInput({ today: today({ source: "ai", failureReason: null }) }));
		expect(report).not.toContain("ИИ не отработал");
	});
});

describe("buildUsageReport: the day's cost is priced per-attempt, not blended", () => {
	it("uses today.totalCost as-is (already summed by generate.ts across a primary content-rejection and a fallback success, each at its own model's price)", () => {
		// today.totalCost=14 here stands in for generate.ts's own accumulation
		// (proven separately in tests/ai-generate.test.ts: 2 + 12 = 14 across two
		// differently-priced models) — this module just has to report it
		// faithfully, not recompute it.
		const report = buildUsageReport(baseInput({ today: today({ attempts: 2, model: "fallback-model", totalCost: 14 }) }));
		expect(report).toContain("Стоимость дня: 14.0000 кредитов");
		expect(report).toContain("попыток 2");
	});

	it("balance-window accumulation sums each usage.jsonl row's own costEstimate, from two different models' rows", () => {
		const { file, dir } = tmpUsageFile([
			usageLine({ timestamp: "2026-08-24T06:00:00.000Z", model: "claude-sonnet-4-7", costEstimate: 0.05 }),
			usageLine({ timestamp: "2026-08-25T06:00:00.000Z", model: "claude-opus-5", costEstimate: 0.08 }),
		]);
		try {
			const report = buildUsageReport(baseInput({ usageFile: file, balanceStart: 1000, balanceAsOf: "2026-08-24" }));
			expect(report).toContain("Накопленный расход: 0.1300 кредитов за 2 дн.");
			expect(report).toContain("Остаток баланса: 999.8700 кредитов");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("buildUsageReport: a corrupted/truncated usage.jsonl line doesn't break the count", () => {
	it("skips a truncated line silently and still sums the valid ones", () => {
		const { file, dir } = tmpUsageFile([
			usageLine({ timestamp: "2026-08-24T06:00:00.000Z", costEstimate: 0.05 }),
			'{"timestamp": "2026-08-24T06:05:00.000Z", "model": "claude-sonn', // truncated mid-write
			usageLine({ timestamp: "2026-08-25T06:00:00.000Z", costEstimate: 0.06 }),
		]);
		try {
			expect(readUsageRecords(file)).toHaveLength(2);
			const report = buildUsageReport(baseInput({ usageFile: file, balanceStart: 1000, balanceAsOf: "2026-08-24" }));
			expect(report).toContain("Накопленный расход: 0.1100 кредитов за 2 дн.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips a syntactically valid line with a garbage timestamp, not just malformed JSON", () => {
		const { file, dir } = tmpUsageFile([usageLine({ timestamp: "not-a-date", costEstimate: 999 }), usageLine({ timestamp: "2026-08-25T06:00:00.000Z", costEstimate: 0.06 })]);
		try {
			expect(readUsageRecords(file)).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a missing usage.jsonl file is treated as empty, not an error", () => {
		expect(readUsageRecords(path.join(tmpdir(), "definitely-does-not-exist-12345.jsonl"))).toEqual([]);
	});
});

describe("buildUsageReport: balance thresholds", () => {
	it("adds an attention line when the remaining balance drops below AI_BALANCE_WARN", () => {
		const { file, dir } = tmpUsageFile([usageLine({ timestamp: "2026-08-25T06:00:00.000Z", costEstimate: 950 })]);
		try {
			const report = buildUsageReport(baseInput({ usageFile: file, balanceStart: 1000, balanceAsOf: "2026-08-25", balanceWarn: 100 }));
			expect(report!.split("\n")[0]).toContain("⚠️");
			expect(report!.split("\n")[0]).toContain("остаток баланса ниже порога");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("adds an attention line when the day's tokens exceed AI_DAILY_TOKEN_WARN", () => {
		const report = buildUsageReport(baseInput({ today: today({ tokensIn: 5000, tokensOut: 2000 }), dailyTokenWarn: 1000 }));
		expect(report!.split("\n")[0]).toContain("⚠️");
		expect(report!.split("\n")[0]).toContain("токены дня выше порога");
	});

	it("is neutral — no warning markers — on an ordinary day", () => {
		const report = buildUsageReport(baseInput({ dailyTokenWarn: 100_000, balanceStart: 1000, balanceAsOf: "2026-08-25", balanceWarn: 10 }));
		expect(report).not.toContain("⚠️");
	});
});

describe("buildUsageReport: missing AI_BALANCE_START drops the whole balance block, not zeros", () => {
	it("omits накопленный/остаток/среднее entirely when balanceStart is null", () => {
		const report = buildUsageReport(baseInput({ balanceStart: null, balanceAsOf: "2026-08-25" }));
		expect(report).not.toContain("Накопленный расход");
		expect(report).not.toContain("Остаток баланса");
		expect(report).not.toContain("Среднее");
		// the day-level lines are still there
		expect(report).toContain("Токены за день");
		expect(report).toContain("Стоимость дня");
	});

	it("also drops the block when balanceAsOf alone is missing", () => {
		const report = buildUsageReport(baseInput({ balanceStart: 1000, balanceAsOf: null }));
		expect(report).not.toContain("Накопленный расход");
	});
});
