import type { HotCoinsSnapshot, SwarmCoin } from "./types.js";

const MOSCOW_TZ = "Europe/Moscow";
const NEUTRAL_THRESHOLD = 0.05; // ±0.05% counts as neither red nor green
const RED_GREEN_STATE_RATIO = 0.6;

// Раздел 4.1: список расширяем по мере появления новых стейблов/money-market фондов.
const STABLE_TICKERS = new Set(["USDT", "USDC", "DAI", "USDE", "FDUSD", "USDGO", "EURSAFO"]);
const STABLE_PRICE_TOLERANCE = 0.05; // страховка: change24h===0 и цена ~$1 — тоже стейбл, даже если не в списке

export type SwarmState = "red" | "green" | "mixed";

export type StateDay = {
	date: string; // YYYY-MM-DD, Europe/Moscow
	swarmState: SwarmState;
	btcChange: number | null;
	postedAt: string;
	messageId: number;
	// v2, all optional so pre-existing records (written before this field set
	// existed — e.g. the real 20/21.08 entries from шаг 5's manual test run)
	// keep parsing exactly as before: absent fields just read as undefined,
	// nothing here requires a migration or a fallback default at read time.
	/** The text actually posted — written for template days too, not just AI ones, so anti-repeat history has no holes on a day the AI path failed. */
	picture?: string;
	observation?: string;
	source?: "ai" | "ai_trimmed" | "template";
	/** null when source is "template" (or absent on pre-v2 records). */
	model?: string | null;
	provider?: string | null;
	promptVersion?: number | null;
	tokensIn?: number;
	tokensOut?: number;
	attempts?: number;
};

export type StateHistory = {
	days: StateDay[];
};

export type Facts = {
	dateLabel: string; // "14 июля"
	dateKey: string; // "2026-07-14" — ключ дня для state.json, та же таймзона
	btc: { price: number; change24h: number } | null;
	red: number;
	green: number;
	total: number;
	swarmState: SwarmState;
	streak: number;
	/** swarmState за календарно предыдущий день (по state.json); null — дыра в истории или первый запуск. */
	prevState: SwarmState | null;
	losers: SwarmCoin[]; // asc by change24h
	winners: SwarmCoin[]; // desc by change24h
	/** max(|winners[0]|, |losers[0]|) — по уже отфильтрованным лидерам, не по edgePins (те часто пусты). */
	maxAbsLeaderChange: number;
};

/** v2: exported for usageReport.ts — grouping usage.jsonl's UTC timestamps into the same Moscow calendar day the rest of the app uses (streak, dateKey, etc.), not a naive UTC-date string match. */
export function moscowDateKey(iso: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: MOSCOW_TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(iso));
}

function moscowDateLabel(iso: string): string {
	return new Intl.DateTimeFormat("ru-RU", {
		timeZone: MOSCOW_TZ,
		day: "numeric",
		month: "long",
	}).format(new Date(iso));
}

/** v2: exported for usageReport.ts — computing the start of a weekly report's 7-day window. */
export function shiftDateKey(dateKey: string, deltaDays: number): string {
	const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
	const dt = new Date(Date.UTC(y, m - 1, d));
	dt.setUTCDate(dt.getUTCDate() + deltaDays);
	return dt.toISOString().slice(0, 10);
}

/**
 * v2: formats a state.json date key ("2026-08-22") into "22 августа" for the
 * AI history payload — unlike moscowDateLabel(), the input is already the
 * Moscow calendar date (state.json stores it that way), not a UTC instant, so
 * there's no timezone conversion to make. Formatted against a fixed "UTC"
 * timeZone anyway (not the Date object's implicit local zone) purely to keep
 * the day from shifting on a machine whose local zone differs from the one
 * used to build the Date.UTC() value below.
 */
export function dateKeyToLabel(dateKey: string): string {
	const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
	return new Intl.DateTimeFormat("ru-RU", {
		timeZone: "UTC",
		day: "numeric",
		month: "long",
	}).format(new Date(Date.UTC(y, m - 1, d)));
}

function isStableLike(coin: SwarmCoin): boolean {
	if (STABLE_TICKERS.has(coin.ticker)) return true;
	return coin.change24h === 0 && Math.abs(coin.price - 1) <= STABLE_PRICE_TOLERANCE;
}

/** Дыра в истории обрывает стрик — не считаем дни до пропуска (раздел 4.1). */
function computeStreak(dateKey: string, swarmState: SwarmState, byDate: ReadonlyMap<string, StateDay>): number {
	let streak = 1;
	let cursor = shiftDateKey(dateKey, -1);
	for (;;) {
		const prevDay = byDate.get(cursor);
		if (!prevDay || prevDay.swarmState !== swarmState) break;
		streak++;
		cursor = shiftDateKey(cursor, -1);
	}
	return streak;
}

/**
 * Состояние роя за вчера — именно вчерашняя запись, а не последняя в
 * истории: дыра в истории (пропущенный день) даёт null, даже если более
 * старая запись есть. Та же логика поиска "дня минус один", что у стрика.
 */
function computePrevState(dateKey: string, byDate: ReadonlyMap<string, StateDay>): SwarmState | null {
	return byDate.get(shiftDateKey(dateKey, -1))?.swarmState ?? null;
}

export function computeFacts(snapshot: HotCoinsSnapshot, history: StateHistory): Facts {
	const dateKey = moscowDateKey(snapshot.ts);
	const dateLabel = moscowDateLabel(snapshot.ts);

	let red = 0;
	let green = 0;
	for (const coin of snapshot.mainSwarm) {
		if (Math.abs(coin.change24h) <= NEUTRAL_THRESHOLD) continue;
		if (coin.change24h < 0) red++;
		else green++;
	}
	const total = red + green;

	let swarmState: SwarmState = "mixed";
	if (total > 0) {
		if (red / total >= RED_GREEN_STATE_RATIO) swarmState = "red";
		else if (green / total >= RED_GREEN_STATE_RATIO) swarmState = "green";
	}

	// edgePins — только источник монет-кандидатов в лидеры, больше ничего не
	// считаем от него напрямую: он пуст в большинстве дней, и вычисление
	// "измеренного" значения от пустого массива — ровно та грабля, из-за
	// которой в проде 23.08 «±0%» ушло в текст как реальное затишье.
	const leaderPool = [...snapshot.mainSwarm, ...snapshot.edgePins].filter((c) => !isStableLike(c));
	const winners = [...leaderPool].sort((a, b) => b.change24h - a.change24h);
	const losers = [...leaderPool].sort((a, b) => a.change24h - b.change24h);

	const maxAbsLeaderChange = Math.max(winners[0] ? Math.abs(winners[0].change24h) : 0, losers[0] ? Math.abs(losers[0].change24h) : 0);

	const byDate = new Map(history.days.map((d) => [d.date, d]));
	const streak = computeStreak(dateKey, swarmState, byDate);
	const prevState = computePrevState(dateKey, byDate);

	return { dateLabel, dateKey, btc: snapshot.btc, red, green, total, swarmState, streak, prevState, losers, winners, maxAbsLeaderChange };
}
