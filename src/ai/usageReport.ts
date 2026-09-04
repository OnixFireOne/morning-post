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
//
// 26.08 provider migration: every costEstimate in usage.jsonl is now an
// exact USD figure at write time (providers.ts's computeAttemptCost — either
// the response's own real bill, or a table calc, both already converted by
// unitRate) — there is nothing left to recalibrate or double-report at read
// time. The old raw-vs-calibrated balance display, and its "остаток —
// оценка снизу" line, are gone entirely; a balance line is just the honest
// sum now. Old pre-migration usage.jsonl lines are never rewritten (append-
// only) — the boundary between old and new pricing is drawn by
// AI_BALANCE_AS_OF alone, same as it already was for any other pricing
// change: the window below only ever reads records on or after that date,
// nothing older is even loaded into it.
import { readFileSync } from "node:fs";
import { dateKeyToLabel, moscowDateKey, shiftDateKey } from "../facts.js";
import type { AiCostSource } from "./providers.js";
import type { UsageRecord } from "./usage.js";

// The dollar is the only unit anywhere in this project (see
// src/ai/providers.ts's own top-of-file note on unitRate) — this is the one
// place its sign is spelled out as a literal; every other module that shows
// a cost goes through formatMoney() below rather than writing its own "$".
// tests/ai-providers-leak.test.ts enforces that no other src/ file does.
const CURRENCY_SYMBOL = "$";

export type TodayUsage = {
	source: "ai" | "ai_trimmed" | "template";
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
	/** All records regardless of dryRun — "потраченное потрачено", a dry-run obkatka request still spent real money. */
	accumulated: number;
	daysCount: number;
	remaining: number;
	/** dryRun:false records only — feeds the average/forecast lines, so a burst of manual obkatka testing on one day doesn't inflate the modeled daily run-rate. */
	realAccumulated: number;
	realDaysCount: number;
	/**
	 * true when this window's records don't all share one costSource — some
	 * of the sum is an exact provider-reported bill, some is our own
	 * price-table estimate (or, for a record from before costSource existed
	 * at all, an unknown pre-migration scheme — its own distinct bucket,
	 * never coerced into "table" or "provider"). Not a units problem (see
	 * providers.ts's own AiCostSource doc comment) — formatBalanceLines turns
	 * this into a note that the sum includes an estimate, not that it mixed
	 * incompatible currencies.
	 *
	 * plan/ai-providering.md §7.1 extends the same flag to a second trigger:
	 * some in-window record got a real response (usageReported) yet still has
	 * no costEstimate at all — a costSource:"none" profile, or a "table"
	 * profile with a model missing from its own priceTable — mixed with
	 * *other* records that did get priced. A uniformly-untracked window
	 * (every record costSource:"none", nothing ever priced) does NOT trip
	 * this — that's an honest, consistent zero, not a partial one; only an
	 * inconsistent mix within the same window is worth flagging.
	 */
	mixedCostSource: boolean;
};

/** A record with no costSource key at all predates this field (pre-migration, priced under the old proxy's own scheme) — treated as its own distinct "unknown" bucket for the mixed-source check, never coerced into "table" or "provider". */
function costSourceKey(record: UsageRecord): AiCostSource | "unknown" {
	return record.costSource ?? "unknown";
}

/**
 * Sums costEstimate (already priced per-attempt, exactly, in USD, at write
 * time — see providers.ts's computeAttemptCost) across every record whose
 * Moscow day is on or after balanceAsOf. Records with costEstimate: null
 * contribute 0, same as an untracked-price attempt already does everywhere
 * else in this system. A record with no `dryRun` key at all (written before
 * section 3.4) is treated as dryRun:false — a real production line — never
 * rewritten to add the field, per the append-only rule.
 *
 * `records` is whatever readUsageRecords() returned for the whole file —
 * filtering happens *here*, first thing, on Moscow date alone. A record
 * whose day is before balanceAsOf is dropped before anything else in this
 * function ever looks at it, including the mixedCostSource check below — a
 * transition day that happened before the configured boundary can never
 * itself trigger the mixed-source note; only records on/after balanceAsOf
 * are eligible to.
 */
function computeBalanceWindow(records: UsageRecord[], balanceStart: number, balanceAsOf: string): BalanceWindow {
	const inWindow = records.filter((r) => moscowDateKey(r.timestamp) >= balanceAsOf);
	const accumulated = inWindow.reduce((sum, r) => sum + (r.costEstimate ?? 0), 0);
	const daysCount = new Set(inWindow.map((r) => moscowDateKey(r.timestamp))).size;
	const differentCostSources = new Set(inWindow.map(costSourceKey)).size > 1;
	// See BalanceWindow.mixedCostSource's own comment — a real response with
	// no price mixed in with at least one record that did get priced.
	const partiallyUncosted = inWindow.some((r) => r.costEstimate !== null) && inWindow.some((r) => r.usageReported && r.costEstimate === null);
	const mixedCostSource = differentCostSources || partiallyUncosted;

	const realRecords = inWindow.filter((r) => (r.dryRun ?? false) === false);
	const realAccumulated = realRecords.reduce((sum, r) => sum + (r.costEstimate ?? 0), 0);
	const realDaysCount = new Set(realRecords.map((r) => moscowDateKey(r.timestamp))).size;

	return { accumulated, daysCount, remaining: balanceStart - accumulated, realAccumulated, realDaysCount, mixedCostSource };
}

function formatMoney(n: number): string {
	return `${n.toFixed(4)}${CURRENCY_SYMBOL}`;
}

/** Shared by both modes — appended after the mode-specific lines. Returns [] when balance tracking isn't configured, so the whole block drops out of the joined message rather than showing zeros. */
function formatBalanceLines(balance: BalanceWindow | null, balanceAsOf: string | null): string[] {
	if (balance === null || balanceAsOf === null) return [];
	const lines = [
		`Накопленный расход: ${formatMoney(balance.accumulated)} за ${balance.daysCount} дн. (с ${dateKeyToLabel(balanceAsOf)})`,
		`Остаток баланса: ${formatMoney(balance.remaining)}`,
	];
	if (balance.mixedCostSource) {
		lines.push("⚠️ часть этой суммы — оценка по таблице цен (costSource: table) или вовсе не учтена (ответ был, стоимость посчитать не удалось), не точный счёт от провайдера (costSource: provider).");
	}
	// Real-only rate — a dry-run obkatka burst on one day must not inflate the
	// modeled daily spend, even though that same spend already reduced
	// `remaining` above (it was real money either way).
	const avgPerDay = balance.realDaysCount > 0 ? balance.realAccumulated / balance.realDaysCount : 0;
	lines.push(
		avgPerDay > 0
			? `Среднее: ${formatMoney(avgPerDay)}/день, хватит примерно на ${Math.floor(balance.remaining / avgPerDay)} дн. при текущем темпе`
			: "Среднее: недостаточно данных для прогноза",
	);
	return lines;
}

function buildDailyReport(input: UsageReportInput, balance: BalanceWindow | null, records: UsageRecord[]): string {
	const { today } = input;
	const dateLabel = dateKeyToLabel(input.dateKey);
	const dayTokensTotal = today.tokensIn !== null && today.tokensOut !== null ? today.tokensIn + today.tokensOut : null;
	const underBalanceWarn = balance !== null && input.balanceWarn !== null && balance.remaining < input.balanceWarn;
	// plan §7.1: how many of *today's own* attempts (any outcome) came back
	// with no usable token count at all — distinct from dayTokensTotal above,
	// which is generate.ts's own already-summed total across the attempts
	// that *did* report usage, and says nothing about the ones that didn't.
	const todayRecords = records.filter((r) => moscowDateKey(r.timestamp) === input.dateKey);
	const untrackedToday = todayRecords.filter((r) => !r.usageReported).length;
	// plan §6.1 fact 3, generalized: a provider that reports usage at all but
	// says promptTokens: 0 didn't actually count the (always non-empty)
	// prompt — a literal, reported zero, not the "nothing reported" case
	// above. computeAttemptCost still runs the "table" math on this 0 as if
	// it were real (nothing else it can do with what it was given), quietly
	// underpricing the input side — this line is the honest flag that the
	// day's shown cost may not be the whole story, not a fix to the math.
	const zeroPromptTokensToday = todayRecords.filter((r) => r.usageReported && r.tokensIn === 0).length;

	const lines: string[] = [];

	if (today.failureReason) {
		lines.push(`⚠️ ИИ не отработал, пост ушёл шаблоном: ${today.failureReason}`);
	}
	if (underBalanceWarn) lines.push(`⚠️ остаток баланса ниже порога (${formatMoney(balance!.remaining)} < ${formatMoney(input.balanceWarn!)})`);

	lines.push(`${dateLabel} — модель ${today.model ?? "—"}, попыток ${today.attempts}, source ${today.source}`);
	lines.push(dayTokensTotal !== null ? `Токены за день: вход ${today.tokensIn}, выход ${today.tokensOut}` : "Токены за день: нет данных");
	if (untrackedToday > 0) lines.push(`${untrackedToday} попыток без учёта токенов`);
	if (zeroPromptTokensToday > 0) lines.push(`${zeroPromptTokensToday} попыток: входные токены не отданы`);
	lines.push(today.totalCost !== null ? `Стоимость дня: ${formatMoney(today.totalCost)}` : "Стоимость дня: не посчитана");

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
	if (underBalanceWarn) lines.push(`⚠️ остаток баланса ниже порога (${formatMoney(balance!.remaining)} < ${formatMoney(input.balanceWarn!)})`);

	lines.push(`Неделя до ${dateKeyToLabel(input.dateKey)} — модели: ${modelsLabel}, попыток ${attempts}, source: ${aiDays} дн. ai / ${templateDays} дн. template`);
	lines.push(`Токены за неделю: вход ${tokensIn}, выход ${tokensOut}`);
	lines.push(`Стоимость недели: ${formatMoney(cost)}`);

	lines.push(...formatBalanceLines(balance, input.balanceAsOf));

	return lines.join("\n");
}

export function buildUsageReport(input: UsageReportInput): string | null {
	if (!input.aiEnabled) return null;
	if (input.mode === "0") return null;
	if (input.mode === "weekly" && !isSundayDateKey(input.dateKey)) return null;

	const records = readUsageRecords(input.usageFile);
	const balance = input.balanceStart !== null && input.balanceAsOf !== null ? computeBalanceWindow(records, input.balanceStart, input.balanceAsOf) : null;

	return input.mode === "weekly" ? buildWeeklyReport(input, balance, records) : buildDailyReport(input, balance, records);
}
