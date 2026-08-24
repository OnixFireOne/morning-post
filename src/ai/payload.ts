// Builds exactly what the model is allowed to see (section 3). No raw
// snapshot, no mainSwarm/edgePins, no screenshot — every number here is
// already a formatted string produced by the same formatters the template
// post uses, so the model's job is to copy, not to compute or round.
import type { Facts, SwarmState } from "../facts.js";
import { formatBtcPercent, formatBtcPrice, formatMagnitude, formatSignedPercent } from "../format.js";

export type AiLeader = {
	ticker: string;
	changeLabel: string;
};

export type AiTodayPayload = {
	dateLabel: string;
	swarmState: SwarmState;
	/** Number, but never added to allowedNumbers — section 3.1: length-of-streak is spoken as a word, not a digit. */
	streak: number;
	prevState: SwarmState | null;
	red: number;
	green: number;
	total: number;
	btc: { priceLabel: string; changeLabel: string; change: number } | null;
	topGainer: AiLeader | null;
	topLoser: AiLeader | null;
	maxAbsLeaderChange: number;
};

/** One prior day for anti-repeat context. Its own numbers never enter allowedNumbers — section 3.1. */
export type AiHistoryEntry = {
	dateLabel: string;
	swarmState: SwarmState;
	picture: string;
	observation: string;
};

export type AiPayload = {
	today: AiTodayPayload;
	history: AiHistoryEntry[];
	allowedNumbers: string[];
};

/**
 * Every string the model is allowed to reproduce verbatim, plus the
 * unsigned/rounded magnitude form of each raw comparison number
 * (btc.change, maxAbsLeaderChange) — a model writing "потерял 2.1%" without
 * repeating the exact "−2.10%" label needs that form whitelisted too, or a
 * perfectly faithful paraphrase would fail validation for no real reason.
 * Reused as-is by validateAiParagraphs() (section 3.1) — one function, one list,
 * so the payload and the validator can never quietly drift apart.
 */
export function collectAllowedNumbers(today: AiTodayPayload): string[] {
	const numbers: string[] = [String(today.red), String(today.green), String(today.total)];
	if (today.btc) {
		numbers.push(today.btc.priceLabel, today.btc.changeLabel, `${formatMagnitude(Math.abs(today.btc.change))}%`);
	}
	if (today.topGainer) numbers.push(today.topGainer.changeLabel);
	if (today.topLoser) numbers.push(today.topLoser.changeLabel);
	numbers.push(`${formatMagnitude(today.maxAbsLeaderChange)}%`);
	return numbers;
}

/**
 * Pure. Same fixtures as the template version can feed this — computeFacts()
 * is untouched by v2, so any snapshot fixture already produces a valid Facts.
 */
export function buildAiPayload(facts: Facts, history: AiHistoryEntry[]): AiPayload {
	const winner = facts.winners[0];
	const loser = facts.losers[0];

	const today: AiTodayPayload = {
		dateLabel: facts.dateLabel,
		swarmState: facts.swarmState,
		streak: facts.streak,
		prevState: facts.prevState,
		red: facts.red,
		green: facts.green,
		total: facts.total,
		btc: facts.btc
			? {
					priceLabel: `$${formatBtcPrice(facts.btc.price)}`,
					changeLabel: formatBtcPercent(facts.btc.change24h),
					change: facts.btc.change24h,
				}
			: null,
		topGainer: winner ? { ticker: winner.ticker, changeLabel: formatSignedPercent(winner.change24h) } : null,
		topLoser: loser ? { ticker: loser.ticker, changeLabel: formatSignedPercent(loser.change24h) } : null,
		maxAbsLeaderChange: facts.maxAbsLeaderChange,
	};

	return { today, history, allowedNumbers: collectAllowedNumbers(today) };
}
