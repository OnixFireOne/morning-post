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
	losers: SwarmCoin[]; // asc by change24h
	winners: SwarmCoin[]; // desc by change24h
	maxAbsEdgeChange: number;
};

function moscowDateKey(iso: string): string {
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

function shiftDateKey(dateKey: string, deltaDays: number): string {
	const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
	const dt = new Date(Date.UTC(y, m - 1, d));
	dt.setUTCDate(dt.getUTCDate() + deltaDays);
	return dt.toISOString().slice(0, 10);
}

function isStableLike(coin: SwarmCoin): boolean {
	if (STABLE_TICKERS.has(coin.ticker)) return true;
	return coin.change24h === 0 && Math.abs(coin.price - 1) <= STABLE_PRICE_TOLERANCE;
}

/** Дыра в истории обрывает стрик — не считаем дни до пропуска (раздел 4.1). */
function computeStreak(dateKey: string, swarmState: SwarmState, history: StateHistory): number {
	const byDate = new Map(history.days.map((d) => [d.date, d]));
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

	const leaderPool = [...snapshot.mainSwarm, ...snapshot.edgePins].filter((c) => !isStableLike(c));
	const winners = [...leaderPool].sort((a, b) => b.change24h - a.change24h);
	const losers = [...leaderPool].sort((a, b) => a.change24h - b.change24h);

	// reduce from a 0 seed, not Math.max(...edgePins) — that's -Infinity when edgePins is empty.
	const maxAbsEdgeChange = snapshot.edgePins.reduce((max, c) => Math.max(max, Math.abs(c.change24h)), 0);

	const streak = computeStreak(dateKey, swarmState, history);

	return { dateLabel, dateKey, btc: snapshot.btc, red, green, total, swarmState, streak, losers, winners, maxAbsEdgeChange };
}
