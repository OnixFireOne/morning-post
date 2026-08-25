// Section 3.3: a short, plain-text usage/balance summary sent to the admin
// chat after a successful publish. Pure function — no fs writes, no
// telegram calls — the caller (index.ts) reads usage.jsonl indirectly
// through this module, calls buildUsageReport(), and sends the result
// through sendAlert() itself. That keeps this module trivially testable and
// keeps the "never blocks the post" guarantee entirely in index.ts's
// existing non-blocking sendAlert() pattern, not duplicated here.
//
// Daily mode uses two data sources, deliberately not blended:
// - "today's" figures (source/model/attempts/tokens/cost) come straight
//   from the `today` input — already computed correctly by generate.ts
//   (attempts counted regardless of usage, tokens/cost only from attempts
//   that actually returned usage). No need to re-derive any of this from
//   the log.
// - The cumulative/balance figures need history only usage.jsonl can
//   provide (other days, other runs) — read fresh every call, grouped by
//   Moscow calendar day so a UTC timestamp near the day boundary lands on
//   the same day the rest of the app would call it.
//
// Weekly mode has no single day's model/source to report, so it discards
// `today` entirely and re-aggregates everything straight from usage.jsonl
// over the trailing 7 days.
import { readFileSync } from "node:fs";
import { dateKeyToLabel, moscowDateKey, shiftDateKey } from "../facts.js";
import type { UsageRecord } from "./usage.js";

export type TodayUsage = {
	source: "ai" | "template";
	model: string | null;
	attempts: number;
	tokensIn: number | null;
	tokensOut: number | null;
	totalCost: number | null;
	/** Non-null only when source is "template" AND the AI path was actually attempted and failed — mirrors index.ts's RenderedPost.failureReason. Drives the first-line degradation notice. */
	failureReason: string | null;
};

export type UsageReportInput = {
	aiEnabled: boolean;
	mode: "daily" | "weekly" | "0";
	dateKey: string;
	today: TodayUsage;
	usageFile: string;
	dailyTokenWarn: number | null;
	balanceStart: number | null;
	balanceAsOf: string | null;
	balanceWarn: number | null;
};

/** Robust read: a truncated or corrupted line (e.g. the process died mid-write) is skipped silently rather than failing the whole summary. Validates just enough of each record's shape to group it by day safely — a syntactically valid JSON object with a garbage `timestamp` is exactly as unusable as a truncated line. */
export function readUsageRecords(usageFile: string): UsageRecord[] {
	let raw: string;
	try {
		raw = readFileSync(usageFile, "utf8");
	} catch {
		return [];
	}

	const records: UsageRecord[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as Partial<UsageRecord>;
			if (typeof parsed.timestamp !== "string" || Number.isNaN(new Date(parsed.timestamp).getTime())) continue;
			records.push(parsed as UsageRecord);
		} catch {
			// truncated JSON after a crash mid-write — skip, don't throw
		}
	}
	return records;
}

function isSundayDateKey(dateKey: string): boolean {
	const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
}

type BalanceWindow = {
	/** All records regardless of dryRun — "потраченное потрачено", a dry-run obkatka request still spent real proxy credits. */
	accumulated: number;
	daysCount: number;
	remaining: number;
	/** dryRun:false records only — feeds the average/forecast lines, so a burst of manual obkatka testing on one day doesn't inflate the modeled daily run-rate. */
	realAccumulated: number;
	realDaysCount: number;
};

/** Sums costEstimate (already priced per-attempt by whichever model answered it — see generate.ts) across every record whose Moscow day is on or after balanceAsOf. Records with costEstimate: null contribute 0, same as an untracked-price attempt already does everywhere else in this system. A record with no `dryRun` key at all (written before section 3.4) is treated as dryRun:false — a real production line — never rewritten to add the field, per the append-only rule. */
function computeBalanceWindow(records: UsageRecord[], balanceStart: number, balanceAsOf: string): BalanceWindow {
	const inWindow = records.filter((r) => moscowDateKey(r.timestamp) >= balanceAsOf);
	const accumulated = inWindow.reduce((sum, r) => sum + (r.costEstimate ?? 0), 0);
	const daysCount = new Set(inWindow.map((r) => moscowDateKey(r.timestamp))).size;

	const realRecords = inWindow.filter((r) => (r.dryRun ?? false) === false);
	const realAccumulated = realRecords.reduce((sum, r) => sum + (r.costEstimate ?? 0), 0);
	const realDaysCount = new Set(realRecords.map((r) => moscowDateKey(r.timestamp))).size;

	return { accumulated, daysCount, remaining: balanceStart - accumulated, realAccumulated, realDaysCount };
}

function formatCredits(n: number): string {
	return n.toFixed(4);
}

/** Shared by both modes — appended after the mode-specific lines. Returns [] when balance tracking isn't configured, so the whole block drops out of the joined message rather than showing zeros. */
function formatBalanceLines(balance: BalanceWindow | null, balanceAsOf: string | null): string[] {
	if (balance === null || balanceAsOf === null) return [];
	const lines = [
		`Накопленный расход: ${formatCredits(balance.accumulated)} кредитов за ${balance.daysCount} дн. (с ${dateKeyToLabel(balanceAsOf)})`,
		`Остаток баланса: ${formatCredits(balance.remaining)} кредитов — оценка снизу: прокси не биллит фиксированный оверхед входных токенов на попытку, реальный остаток немного больше.`,
	];
	// Real-only rate — a dry-run obkatka burst on one day must not inflate the
	// modeled daily spend, even though that same spend already reduced
	// `remaining` above (it was real money either way).
	const avgPerDay = balance.realDaysCount > 0 ? balance.realAccumulated / balance.realDaysCount : 0;
	lines.push(
		avgPerDay > 0
			? `Среднее: ${formatCredits(avgPerDay)} кредитов/день, хватит примерно на ${Math.floor(balance.remaining / avgPerDay)} дн. при текущем темпе`
			: "Среднее: недостаточно данных для прогноза",
	);
	return lines;
}

function buildDailyReport(input: UsageReportInput, balance: BalanceWindow | null): string {
	const { today } = input;
	const dateLabel = dateKeyToLabel(input.dateKey);
	const dayTokensTotal = today.tokensIn !== null && today.tokensOut !== null ? today.tokensIn + today.tokensOut : null;
	const overTokenWarn = input.dailyTokenWarn !== null && dayTokensTotal !== null && dayTokensTotal > input.dailyTokenWarn;
	const underBalanceWarn = balance !== null && input.balanceWarn !== null && balance.remaining < input.balanceWarn;

	const lines: string[] = [];

	if (today.failureReason) {
		lines.push(`⚠️ ИИ не отработал, пост ушёл шаблоном: ${today.failureReason}`);
	}
	const attentionParts: string[] = [];
	if (overTokenWarn) attentionParts.push(`токены дня выше порога (${dayTokensTotal} > ${input.dailyTokenWarn})`);
	if (underBalanceWarn) attentionParts.push(`остаток баланса ниже порога (${formatCredits(balance!.remaining)} < ${input.balanceWarn})`);
	if (attentionParts.length > 0) lines.push(`⚠️ ${attentionParts.join("; ")}`);

	lines.push(`${dateLabel} — модель ${today.model ?? "—"}, попыток ${today.attempts}, source ${today.source}`);
	lines.push(dayTokensTotal !== null ? `Токены за день: вход ${today.tokensIn}, выход ${today.tokensOut}` : "Токены за день: нет данных");
	lines.push(today.totalCost !== null ? `Стоимость дня: ${formatCredits(today.totalCost)} кредитов` : "Стоимость дня: не посчитана");

	lines.push(...formatBalanceLines(balance, input.balanceAsOf));

	return lines.join("\n");
}

function buildWeeklyReport(input: UsageReportInput, balance: BalanceWindow | null, records: UsageRecord[]): string {
	const windowStart = shiftDateKey(input.dateKey, -6);
	const weekRecords = records.filter((r) => moscowDateKey(r.timestamp) >= windowStart);

	const attempts = weekRecords.length;
	const tokensIn = weekRecords.reduce((sum, r) => sum + (r.tokensIn ?? 0), 0);
	const tokensOut = weekRecords.reduce((sum, r) => sum + (r.tokensOut ?? 0), 0);
	const cost = weekRecords.reduce((sum, r) => sum + (r.costEstimate ?? 0), 0);

	const daysBySource = new Map<string, "ai" | "template">();
	for (const day of new Set(weekRecords.map((r) => moscowDateKey(r.timestamp)))) {
		const dayHasOk = weekRecords.some((r) => moscowDateKey(r.timestamp) === day && r.outcome === "ok");
		daysBySource.set(day, dayHasOk ? "ai" : "template");
	}
	const aiDays = [...daysBySource.values()].filter((s) => s === "ai").length;
	const templateDays = daysBySource.size - aiDays;

	const modelCounts = new Map<string, number>();
	for (const r of weekRecords) modelCounts.set(r.model, (modelCounts.get(r.model) ?? 0) + 1);
	const modelsLabel = [...modelCounts.entries()].map(([model, count]) => `${model} (${count})`).join(", ") || "—";

	const underBalanceWarn = balance !== null && input.balanceWarn !== null && balance.remaining < input.balanceWarn;

	const lines: string[] = [];
	if (underBalanceWarn) lines.push(`⚠️ остаток баланса ниже порога (${formatCredits(balance!.remaining)} < ${input.balanceWarn})`);

	lines.push(`Неделя до ${dateKeyToLabel(input.dateKey)} — модели: ${modelsLabel}, попыток ${attempts}, source: ${aiDays} дн. ai / ${templateDays} дн. template`);
	lines.push(`Токены за неделю: вход ${tokensIn}, выход ${tokensOut}`);
	lines.push(`Стоимость недели: ${formatCredits(cost)} кредитов`);

	lines.push(...formatBalanceLines(balance, input.balanceAsOf));

	return lines.join("\n");
}

export function buildUsageReport(input: UsageReportInput): string | null {
	if (!input.aiEnabled) return null;
	if (input.mode === "0") return null;
	if (input.mode === "weekly" && !isSundayDateKey(input.dateKey)) return null;

	const records = readUsageRecords(input.usageFile);
	const balance = input.balanceStart !== null && input.balanceAsOf !== null ? computeBalanceWindow(records, input.balanceStart, input.balanceAsOf) : null;

	return input.mode === "weekly" ? buildWeeklyReport(input, balance, records) : buildDailyReport(input, balance);
}
