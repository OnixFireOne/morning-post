// Builds exactly what the model is allowed to see (section 3). No raw
// snapshot, no mainSwarm/edgePins, no screenshot — every number here is
// already a formatted string produced by the same formatters the template
// post uses, so the model's job is to copy, not to compute or round.
import { dateKeyToLabel, type Facts, type StateHistory, type SwarmState } from "../facts.js";
import { formatBtcPercent, formatBtcPrice, formatMagnitude, formatSignedPercent } from "../format.js";
import { NUMBER_TOKEN_RE } from "./validator.js";

const MAX_HISTORY_DAYS_FOR_AI = 3;

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
 * history text is shown to the model purely for anti-repeat style/structure
 * — never for citing (section 3.1: history's own numbers never enter
 * allowedNumbers, and a model pulling yesterday's count into today's
 * paragraph is a validator rejection). Redacting the actual digits out of
 * it removes the temptation to reuse an old day's specific numbers while
 * still showing the sentence shape to avoid repeating. Doesn't touch
 * tickers — this only matches digit-based tokens (NUMBER_TOKEN_RE, the same
 * pattern the validator itself uses), and every real ticker in this
 * project's data is purely alphabetic (TRAC, BTC, PI, ENA...), so there's
 * nothing for it to collide with. Only affects the payload built here —
 * state.json and facts.jsonl keep the original, unredacted text.
 */
function redactHistoryNumbers(entry: AiHistoryEntry): AiHistoryEntry {
	return {
		...entry,
		picture: entry.picture.replace(NUMBER_TOKEN_RE, "…"),
		observation: entry.observation.replace(NUMBER_TOKEN_RE, "…"),
	};
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

	return { today, history: history.map(redactHistoryNumbers), allowedNumbers: collectAllowedNumbers(today) };
}

/**
 * Bridges state.json (шаг 6) into the AI payload's history shape: the most
 * recent days before `todayKey`, newest first, capped at 3 (section 3 says
 * "2-3 предыдущих дня"). A record with no stored picture/observation — a
 * pre-v2 entry, or a day the AI path never got as far as producing text —
 * is skipped rather than passed through with empty strings: there's nothing
 * to anti-repeat against, and an empty pair of paragraphs in `history` would
 * just be noise the model has to ignore.
 */
export function stateHistoryToAiHistory(history: StateHistory, todayKey: string): AiHistoryEntry[] {
	return history.days
		.filter((day): day is typeof day & { picture: string; observation: string } => day.date < todayKey && Boolean(day.picture) && Boolean(day.observation))
		.sort((a, b) => b.date.localeCompare(a.date))
		.slice(0, MAX_HISTORY_DAYS_FOR_AI)
		.map((day) => ({
			dateLabel: dateKeyToLabel(day.date),
			swarmState: day.swarmState,
			picture: day.picture,
			observation: day.observation,
		}));
}
