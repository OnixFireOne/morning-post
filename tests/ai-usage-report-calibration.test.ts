import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROXY_INPUT_TOKEN_OVERHEAD } from "../src/ai/usage.js";
import { buildUsageReport, type ModelPrice, type TodayUsage, type UsageReportInput } from "../src/ai/usageReport.js";
import type { UsageRecord } from "../src/ai/usage.js";

function tmpUsageFile(lines: string[]): { file: string; dir: string } {
	const dir = mkdtempSync(path.join(tmpdir(), "morning-post-usage-calibration-"));
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
		promptVersion: 9,
		tokensIn: 6158,
		tokensOut: 226,
		tokensTotal: 6384,
		cachedTokens: null,
		usageReported: true,
		durationMs: 900,
		outcome: "ok",
		finishReason: "stop",
		costEstimate: 0.09570400000000001, // 6158/1e6*14 + 226/1e6*42, real numbers from the 2026-08-25 live run
		dryRun: false,
		...overrides,
	};
	return JSON.stringify(record);
}

function today(overrides: Partial<TodayUsage> = {}): TodayUsage {
	return {
		source: "ai",
		model: "claude-sonnet-4-7",
		attempts: 1,
		tokensIn: 6158,
		tokensOut: 226,
		totalCost: 0.0957,
		failureReason: null,
		...overrides,
	};
}

const PRIMARY_PRICE: ModelPrice = { priceInPerMillion: 14, priceOutPerMillion: 42 };

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

describe("buildUsageReport: balance calibration across several usage.jsonl lines", () => {
	it("calibratedAccumulated is lower than the raw sum when modelPrices is supplied, and both numbers appear in the report", () => {
		const { file, dir } = tmpUsageFile([
			usageLine({ timestamp: "2026-08-24T06:00:00.000Z", tokensIn: 6158, tokensOut: 226, costEstimate: 0.09570400000000001 }),
			usageLine({ timestamp: "2026-08-25T06:00:00.000Z", tokensIn: 5620, tokensOut: 200, costEstimate: 0.087080000000000001 }),
		]);
		try {
			const report = buildUsageReport(
				baseInput({
					usageFile: file,
					balanceStart: 1000,
					balanceAsOf: "2026-08-24",
					modelPrices: { "claude-sonnet-4-7": PRIMARY_PRICE },
				}),
			);
			expect(report).not.toBeNull();

			// Raw sum (usage.jsonl, no correction): 0.095704 + 0.08708 = 0.182784
			expect(report).toContain("Накопленный расход: 0.1828 кредитов за 2 дн.");

			// Calibrated: billedInputTokens(6158)=3619, billedInputTokens(5620)=3081
			// cost1 = 3619/1e6*14 + 226/1e6*42 = 0.050666 + 0.009492 = 0.060158
			// cost2 = 3081/1e6*14 + 200/1e6*42 = 0.043134 + 0.0084   = 0.051534
			// sum = 0.111692
			expect(report).toContain("0.1117 кредитов");
			expect(report).toMatch(/с поправкой на оверхед прокси: 0\.1117 кредитов/);

			// Остаток баланса: calibrated is the primary figure (higher, since less was actually spent)
			// calibratedRemaining = 1000 - 0.111692 = 999.888308 -> 999.8883
			expect(report).toContain("Остаток баланса: 999.8883 кредитов");
			// raw remaining still shown, appended
			expect(report).toContain("999.8172 кредитов"); // 1000 - 0.182784 = 999.817216 -> 999.8172
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a record whose model has no known current price falls back to its own raw costEstimate for the calibrated sum too", () => {
		const { file, dir } = tmpUsageFile([usageLine({ timestamp: "2026-08-24T06:00:00.000Z", model: "some-retired-model", tokensIn: 6158, tokensOut: 226, costEstimate: 1 })]);
		try {
			const report = buildUsageReport(baseInput({ usageFile: file, balanceStart: 1000, balanceAsOf: "2026-08-24", modelPrices: { "claude-sonnet-4-7": PRIMARY_PRICE } }));
			// No calibration possible for "some-retired-model" -> calibrated == raw == 1
			expect(report).toContain("Накопленный расход: 1.0000 кредитов за 1 дн. (с 24 августа) — с поправкой на оверхед прокси: 1.0000 кредитов");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("buildUsageReport: остаток баланса never goes negative from the overhead correction itself", () => {
	it("a record with tokensIn below PROXY_INPUT_TOKEN_OVERHEAD contributes zero input cost, not a negative one", () => {
		expect(1500).toBeLessThan(PROXY_INPUT_TOKEN_OVERHEAD);
		const { file, dir } = tmpUsageFile([usageLine({ timestamp: "2026-08-24T06:00:00.000Z", tokensIn: 1500, tokensOut: 100, costEstimate: 0.025 })]);
		try {
			const report = buildUsageReport(baseInput({ usageFile: file, balanceStart: 1000, balanceAsOf: "2026-08-24", modelPrices: { "claude-sonnet-4-7": PRIMARY_PRICE } }));
			// billedInputTokens(1500) = 0 -> calibrated cost = 0/1e6*14 + 100/1e6*42 = 0.0042
			expect(report).toContain("с поправкой на оверхед прокси: 0.0042 кредитов");
			expect(report).not.toMatch(/с поправкой на оверхед прокси: -/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("buildUsageReport: the calibration marker and both figures are present in the summary text", () => {
	it("marks the calibrated number as an empirical proxy correction, not API data", () => {
		const { file, dir } = tmpUsageFile([usageLine({ timestamp: "2026-08-24T06:00:00.000Z" })]);
		try {
			const report = buildUsageReport(baseInput({ usageFile: file, balanceStart: 1000, balanceAsOf: "2026-08-24", modelPrices: { "claude-sonnet-4-7": PRIMARY_PRICE } }));
			expect(report).toContain("эмпирическая калибровка под этот прокси, не данные API");
			expect(report).toContain("по данным usage без поправки");
			expect(report).toMatch(/Среднее:.*\(расчёт с поправкой на оверхед прокси\)/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("with no modelPrices at all, calibrated figures equal the raw ones exactly (no silent divergence)", () => {
		const { file, dir } = tmpUsageFile([usageLine({ timestamp: "2026-08-24T06:00:00.000Z", costEstimate: 0.5 })]);
		try {
			const report = buildUsageReport(baseInput({ usageFile: file, balanceStart: 1000, balanceAsOf: "2026-08-24" }));
			expect(report).toContain("Накопленный расход: 0.5000 кредитов за 1 дн. (с 24 августа) — с поправкой на оверхед прокси: 0.5000 кредитов");
			expect(report).toContain("Остаток баланса: 999.5000 кредитов");
			expect(report).toContain("по данным usage без поправки: 999.5000 кредитов");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
