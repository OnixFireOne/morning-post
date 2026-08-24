// The real defense (section 5) — the prompt can be argued with, this either
// passes the text or it doesn't. Pure function, no network, no facts.ts
// dependency beyond the types payload.ts already re-exports.
import type { AiPayload } from "./payload.js";

/** Section 4: 320 chars, with room under the 1024 caption limit once header/BTC/leader lines/CTA are added. Hardcoded on purpose — the same number feeds the prompt (step 4), and an env knob here is a way to let a valid-but-oversized response into a broken caption. */
export const MAX_PARAGRAPH_LENGTH = 320;
const RUSSIAN_LETTER_RATIO_THRESHOLD = 0.9;

export type ValidationFailureReason =
	| "invalid_json"
	| "validator:numbers"
	| "validator:length"
	| "validator:forbidden_pattern"
	| "validator:direction"
	| "validator:empty_or_cutoff"
	| "validator:streak_digit"
	| "validator:language";

export type AiParagraphs = {
	picture: string;
	observation: string;
	direction: AiPayload["today"]["swarmState"];
};

export type ValidationResult = { ok: true; paragraphs: AiParagraphs } | { ok: false; reason: ValidationFailureReason; detail: string };

// --- number handling shared with payload.test.ts's own "no leaked number" check ---

// Comma only consumed as a proper thousands-group (exactly 3 digits after
// it) — `[\d,]*` alone also swallows a trailing sentence comma ("133,"
// right before "растут"), producing a token that can never match anything
// in allowedNumbers.
const NUMBER_TOKEN_RE = /[+−-]?\$?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?/gu;

/** U+2212 (typographic minus, house style) and ASCII "-" must compare equal — a model has no reason to know about U+2212. */
function normalizeMinus(s: string): string {
	return s.replace(/−/g, "-");
}

export function extractNumberTokens(text: string): string[] {
	return text.match(NUMBER_TOKEN_RE) ?? [];
}

function findDisallowedNumber(text: string, allowedNumbers: readonly string[]): string | null {
	const allowed = new Set(allowedNumbers.map(normalizeMinus));
	for (const token of extractNumberTokens(text)) {
		if (!allowed.has(normalizeMinus(token))) return token;
	}
	return null;
}

// --- item 7: any digit next to a day-word, independent of the numbers
// whitelist and of facts.streak's actual value. Section 4: streak length is
// spoken as a word, never a digit. Checking against streak's specific value
// breaks both ways — streak=14 with red=14 would kill the legitimate "14
// монет", and streak=2 would wave through a hallucinated "5-й день подряд"
// whenever 5 happens to be whitelisted for something else. The rule is about
// context, not value: no digit belongs next to день/дня/дней/сутки at all,
// correct or not. ---

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `\b` is ASCII-only in JS regex — it does not treat Cyrillic letters as
// "word" characters at all, so a boundary right after "дня" and before a
// space silently fails to match (non-word char on both sides, by \b's own
// definition). Every pattern below uses explicit \p{L}/\p{N} lookarounds
// instead, verified against the section-8 fixtures, not just eyeballed.
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";

const DIGIT_DAY_COUNT_RE = new RegExp(`${NOT_WORD_BEFORE}\\d+(?!\\d)\\s*-?\\s*(?:й\\s+)?(?:день|дня|дней|сутки)${NOT_WORD_AFTER}`, "iu");

function findDigitDayCount(text: string): string | null {
	const match = text.match(DIGIT_DAY_COUNT_RE);
	return match ? match[0] : null;
}

// --- item 3: forbidden content ---

const FORECAST_RE = new RegExp(
	`${NOT_WORD_BEFORE}(?:прогноз\\p{L}*|пробь[её]т|ожида[ею]тся|будет\\s+(?:расти|падать)|вырастет|упадёт|к\\s+вечеру|завтра(?=[^\\p{L}\\p{N}]|$).{0,25}(?:курс|цена|цену|рост|падени))${NOT_WORD_AFTER}`,
	"iu",
);
const ADVICE_RE = new RegExp(
	`${NOT_WORD_BEFORE}(?:покупа[йю]те|продава[йю]те|время\\s+покупать|время\\s+продавать|заходите\\s+в|не\\s+упустите\\s+шанс)${NOT_WORD_AFTER}`,
	"iu",
);
const MOONSHOT_RE = new RegExp(`${NOT_WORD_BEFORE}(?:иксы|x\\s?10|10\\s?x|удво[ий]тся|утро[ий]тся)${NOT_WORD_AFTER}`, "iu");
// \w is ASCII-only too — a Cyrillic hashtag like "#крипта" needs \p{L}/\p{N}, not \w.
const HASHTAG_RE = /#[\p{L}\p{N}_]+/u;
const URL_RE = /https?:\/\/|www\./iu;
const HTML_TAG_RE = /<\/?[a-z][^>]*>/iu;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

const FORBIDDEN_PATTERNS: readonly { re: RegExp; label: string }[] = [
	{ re: FORECAST_RE, label: "forecast language" },
	{ re: ADVICE_RE, label: "buy/sell advice" },
	{ re: MOONSHOT_RE, label: "moonshot promise" },
	{ re: HASHTAG_RE, label: "hashtag" },
	{ re: URL_RE, label: "URL" },
	{ re: HTML_TAG_RE, label: "HTML tag" },
	// The template's own paragraphs never use emoji — no established "allowed
	// set" exists for prose, so any emoji at all is out until one is defined.
	{ re: EMOJI_RE, label: "emoji" },
];

function findForbiddenPattern(text: string): string | null {
	for (const { re, label } of FORBIDDEN_PATTERNS) {
		if (re.test(text)) return label;
	}
	return null;
}

// --- item 6: language — share of Cyrillic letters, tickers and "BTC" stripped first ---

function stripKnownTickers(text: string, payload: AiPayload): string {
	const tickers = [payload.today.topGainer?.ticker, payload.today.topLoser?.ticker, "BTC"].filter((t): t is string => Boolean(t));
	let stripped = text;
	for (const ticker of tickers) {
		stripped = stripped.replace(new RegExp(escapeRegExp(ticker), "giu"), "");
	}
	return stripped;
}

function isRussianEnough(text: string, payload: AiPayload): boolean {
	const stripped = stripKnownTickers(text, payload);
	const letters = stripped.match(/\p{L}/gu) ?? [];
	if (letters.length === 0) return true; // nothing to judge on — don't fail an edge case with no letters at all
	const cyrillic = letters.filter((ch) => /\p{Script=Cyrillic}/u.test(ch)).length;
	return cyrillic / letters.length >= RUSSIAN_LETTER_RATIO_THRESHOLD;
}

// --- JSON extraction: section 8's "text before/after JSON" is section 2's "main
// scenario, not a rare one" for AI_STRUCTURED_OUTPUT=0 — extract and validate
// the JSON on its own merits, don't reject just for having a wrapper ---

function parseAiJson(rawText: string): { picture: string; observation: string; direction: string } | null {
	const start = rawText.indexOf("{");
	const end = rawText.lastIndexOf("}");
	if (start === -1 || end === -1 || end < start) return null;

	let candidate: unknown;
	try {
		candidate = JSON.parse(rawText.slice(start, end + 1));
	} catch {
		return null;
	}

	if (typeof candidate !== "object" || candidate === null) return null;
	const obj = candidate as Record<string, unknown>;
	if (typeof obj.picture !== "string" || typeof obj.observation !== "string" || typeof obj.direction !== "string") return null;
	return { picture: obj.picture, observation: obj.observation, direction: obj.direction };
}

function endsLikeASentence(text: string): boolean {
	return /[.!?…»)]$/.test(text);
}

/**
 * Section 5, checks in this order (first failure wins — order doesn't change
 * correctness, each check is independent): parse -> non-empty/not cut off ->
 * length -> forbidden content -> direction -> streak-as-day-count -> number
 * whitelist -> language.
 */
export function validateAiParagraphs(rawText: string, payload: AiPayload): ValidationResult {
	const parsed = parseAiJson(rawText);
	if (!parsed) {
		return { ok: false, reason: "invalid_json", detail: "no valid {picture, observation, direction} JSON object found in the response" };
	}

	const picture = parsed.picture.trim();
	const observation = parsed.observation.trim();

	for (const [name, text] of [
		["picture", picture],
		["observation", observation],
	] as const) {
		if (!text) return { ok: false, reason: "validator:empty_or_cutoff", detail: `${name} is empty` };
		if (!endsLikeASentence(text)) return { ok: false, reason: "validator:empty_or_cutoff", detail: `${name} does not end with sentence-ending punctuation: "...${text.slice(-20)}"` };
		if (text.length > MAX_PARAGRAPH_LENGTH) return { ok: false, reason: "validator:length", detail: `${name} is ${text.length} chars, limit ${MAX_PARAGRAPH_LENGTH}` };
	}

	const combined = `${picture}\n${observation}`;

	const forbidden = findForbiddenPattern(combined);
	if (forbidden) return { ok: false, reason: "validator:forbidden_pattern", detail: forbidden };

	if (parsed.direction !== payload.today.swarmState) {
		return { ok: false, reason: "validator:direction", detail: `direction "${parsed.direction}" !== facts.swarmState "${payload.today.swarmState}"` };
	}
	const direction = parsed.direction as AiPayload["today"]["swarmState"];

	const digitDayCount = findDigitDayCount(combined);
	if (digitDayCount) return { ok: false, reason: "validator:streak_digit", detail: `"${digitDayCount}" — day-streak must be spoken as a word, never a digit` };

	const badNumber = findDisallowedNumber(combined, payload.allowedNumbers);
	if (badNumber) return { ok: false, reason: "validator:numbers", detail: `"${badNumber}" is not in allowedNumbers` };

	if (!isRussianEnough(combined, payload)) {
		return { ok: false, reason: "validator:language", detail: "text does not look like Russian (< 90% Cyrillic letters after stripping tickers/BTC)" };
	}

	return { ok: true, paragraphs: { picture, observation, direction } };
}
