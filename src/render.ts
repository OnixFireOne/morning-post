import type { Facts } from "./facts.js";
import { escapeHtml, formatBtcPercent, formatBtcPrice, formatSignedPercent } from "./format.js";
import {
	BTC_LEADS_VARIANTS,
	CORRECTION_VARIANTS,
	GREEN_FIRST_SHORT,
	GREEN_FIRST_VARIANTS,
	GREEN_STREAK_SHORT,
	GREEN_STREAK_VARIANTS,
	MIXED_SHORT,
	MIXED_VARIANTS,
	NEUTRAL_NO_BTC_VARIANTS,
	NEUTRAL_WITH_BTC_VARIANTS,
	pickVariant,
	QUIET_DUMP_VARIANTS,
	REBOUND_VARIANTS,
	RED_FIRST_SHORT,
	RED_FIRST_VARIANTS,
	RED_STREAK_SHORT,
	RED_STREAK_VARIANTS,
} from "./phrases.js";

export const CAPTION_LIMIT = 1024;
const CTA = "Вся карта в реальном времени → inp.one";
// Порог для веток "тихий слив" / "биток ведёт" в абзаце-наблюдении (раздел 4.2).
const QUIET_BTC_THRESHOLD = 1;
const LEADING_BTC_THRESHOLD = 3;
const QUIET_DUMP_LEADER_THRESHOLD = 15;

export type PostParagraphs = {
	picture: string;
	winnerLine: string;
	loserLine: string;
	observation: string;
};

/** Exported for the new one-paragraph AI contract (v2 section 4 rewrite): paragraph 1 is always this — code-generated, never sent to or returned by the model. Same function the template path already used. */
export function pickPicture(facts: Facts): string {
	if (facts.swarmState === "red") {
		const variants = facts.streak >= 2 ? RED_STREAK_VARIANTS : RED_FIRST_VARIANTS;
		return pickVariant(variants, facts.dateKey)(facts);
	}
	if (facts.swarmState === "green") {
		const variants = facts.streak >= 2 ? GREEN_STREAK_VARIANTS : GREEN_FIRST_VARIANTS;
		return pickVariant(variants, facts.dateKey)(facts);
	}
	return pickVariant(MIXED_VARIANTS, facts.dateKey)(facts);
}

function pickShortPicture(facts: Facts): string {
	if (facts.swarmState === "red") return (facts.streak >= 2 ? RED_STREAK_SHORT : RED_FIRST_SHORT)(facts);
	if (facts.swarmState === "green") return (facts.streak >= 2 ? GREEN_STREAK_SHORT : GREEN_FIRST_SHORT)(facts);
	return MIXED_SHORT(facts);
}

/**
 * Порядок веток (первая подошедшая выигрывает): разворот состояния (коррекция
 * после зелёного/отскок после красного) важнее любых чисел за сегодня — это
 * читателю интереснее, чем то, что биток стоит на месте. Ветки читают
 * facts.btc сами (через `!`) только там, где мы уже проверили его на не-null.
 */
function pickObservation(facts: Facts): string {
	if (facts.prevState === "green" && facts.swarmState === "red") {
		return pickVariant(CORRECTION_VARIANTS, facts.dateKey)(facts);
	}
	if (facts.prevState === "red" && facts.swarmState === "green") {
		return pickVariant(REBOUND_VARIANTS, facts.dateKey)(facts);
	}
	if (facts.btc && Math.abs(facts.btc.change24h) < QUIET_BTC_THRESHOLD && facts.maxAbsLeaderChange > QUIET_DUMP_LEADER_THRESHOLD) {
		return pickVariant(QUIET_DUMP_VARIANTS, facts.dateKey)(facts);
	}
	if (facts.btc && Math.abs(facts.btc.change24h) >= LEADING_BTC_THRESHOLD) {
		return pickVariant(BTC_LEADS_VARIANTS, facts.dateKey)(facts);
	}
	if (facts.btc) {
		return pickVariant(NEUTRAL_WITH_BTC_VARIANTS, facts.dateKey)(facts);
	}
	return pickVariant(NEUTRAL_NO_BTC_VARIANTS, facts.dateKey)(facts);
}

/** Exported for v2 (шаг 6): AI-sourced paragraphs still need these two deterministic lines, identical to the template path. */
export function buildLeaderLines(facts: Facts): { winnerLine: string; loserLine: string } {
	const winner = facts.winners[0];
	const loser = facts.losers[0];
	if (!winner || !loser) {
		throw new Error("buildParagraphs: no leaders left after filtering stablecoins");
	}
	const heroFirst = facts.swarmState === "green";
	const winnerLabel = heroFirst ? "Герой дня" : "Против течения";
	const loserLabel = heroFirst ? "Против течения" : "Антигерой дня";
	const winnerLine = `<b>📈 ${winnerLabel}: ${escapeHtml(winner.ticker)} ${formatSignedPercent(winner.change24h)}</b>`;
	const loserLine = `📉 ${loserLabel}: ${escapeHtml(loser.ticker)} ${formatSignedPercent(loser.change24h)}`;
	return { winnerLine, loserLine };
}

export function buildParagraphs(facts: Facts): PostParagraphs {
	const picture = pickPicture(facts);
	const { winnerLine, loserLine } = buildLeaderLines(facts);
	const observation = pickObservation(facts);
	return { picture, winnerLine, loserLine, observation };
}

function assembleCaption(facts: Facts, paragraphs: PostParagraphs, picture: string, includeObservation: boolean): string {
	const header = `<b>🌅 Утро на рынке — ${facts.dateLabel}</b>`;
	const blocks = [header];
	if (facts.btc) {
		const emoji = facts.btc.change24h < 0 ? "🔴" : "🟢";
		blocks.push(`<b>${emoji} BTC $${formatBtcPrice(facts.btc.price)} (${formatBtcPercent(facts.btc.change24h)})</b>`);
	}
	blocks.push(picture);
	blocks.push(`${paragraphs.winnerLine}\n${paragraphs.loserLine}`);
	if (includeObservation) blocks.push(paragraphs.observation);
	blocks.push(CTA);
	return blocks.join("\n\n");
}

/**
 * Склеивает caption из уже готовых абзацев (любого источника — шаблон или
 * ИИ, раздел 1 v2: "тем же интерфейсом") и деградирует его при превышении
 * лимита Telegram (раздел 4.3 v1): сначала убирается абзац-наблюдение, затем
 * — если дан короткий вариант картины дня — используется он. Заголовок,
 * строка BTC, строки лидеров и CTA не режутся никогда.
 *
 * `shortPicture` опционален: у ИИ-абзацев нет короткого варианта (см. решение
 * по переполнению v2 — если после удаления наблюдения текст всё ещё не
 * влезает, это отказ всего ИИ-пути целиком, не повод резать чужой текст).
 * Без `shortPicture` деградация останавливается на втором шаге; вызывающий
 * код (шаг 6) сам решает, что делать, если и это не помогло.
 */
export function buildCaptionFromParagraphs(facts: Facts, paragraphs: PostParagraphs, shortPicture?: string): string {
	let caption = assembleCaption(facts, paragraphs, paragraphs.picture, true);
	if (caption.length <= CAPTION_LIMIT) return caption;

	caption = assembleCaption(facts, paragraphs, paragraphs.picture, false);
	if (caption.length <= CAPTION_LIMIT) return caption;

	if (shortPicture !== undefined) {
		caption = assembleCaption(facts, paragraphs, shortPicture, false);
	}
	return caption;
}

/** Unchanged v1 behaviour — template paragraphs, template short-picture fallback. */
export function buildCaption(facts: Facts): string {
	const paragraphs = buildParagraphs(facts);
	const shortPicture = pickShortPicture(facts);
	return buildCaptionFromParagraphs(facts, paragraphs, shortPicture);
}
