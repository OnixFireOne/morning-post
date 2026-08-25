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
	| "validator:language"
	| "validator:derived_numbers"
	| "validator:streak_word_mismatch";

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
/** Exported for payload.ts's history redaction — same token shape, reused rather than duplicated. validator.ts's own import of AiPayload from payload.js is type-only (erased at compile time), so this doesn't create a real runtime circular dependency. */
export const NUMBER_TOKEN_RE = /[+−-]?\$?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?/gu;

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

/** Shared by item 3's HTML-tag check and item 6's language check — strips the day's own tickers (plus "BTC") so an allowed ticker that happens to look like markup or Latin script isn't mistaken for the real thing. */
function stripKnownTickers(text: string, payload: AiPayload): string {
	const tickers = [payload.today.topGainer?.ticker, payload.today.topLoser?.ticker, "BTC"].filter((t): t is string => Boolean(t));
	let stripped = text;
	for (const ticker of tickers) {
		stripped = stripped.replace(new RegExp(escapeRegExp(ticker), "giu"), "");
	}
	return stripped;
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

// --- item 10: word-form (ordinal) day-streak vs facts.streak. Independent of
// item 7 above: item 7 bans ANY digit next to a day-word, correct or not, but
// never looks at word forms at all — a model can satisfy item 7 perfectly
// while still lying with a word.
//
// Found on a live green --chain=3 run: facts.streak was pinned at 1 every
// step (same fixture, only the date advances), and step 1 correctly wrote
// "первый зелёный день" — but steps 2 and 3 wrote "второй день подряд" and
// "Третий зелёный день подряд". The model was counting entries in `history`,
// not reading facts.streak. In production that's silently wrong the moment a
// streak actually resets: two green days with one red day between them reset
// streak to 1, but a model counting history length instead would still call
// the second green day "третий день подряд" (its third mention of green in
// the recent history, not its actual streak).
//
// "третий" is the one irregular (soft-stem) ordinal among 1st-10th — see item
// 9's own DERIVED_NUMBER_WORDS_RE comment above on why the fraction word
// "треть" is matched as a bare word only, never stem-expanded: every
// inflected form of "третий" (третьего, третьему, третьим, третьем, третья,
// третьи...) starts with "треть" + a vowel/consonant. This alternation is
// that same constraint from the other side: it must match every "3rd" form
// without ever matching bare "треть" — which it can't, because "треть" alone
// has nothing following the stem, and every suffix below is non-empty.
const THIRD_ORDINAL_SUFFIX_ALT = "(?:ий|ьего|ьему|ьем|ья|ьей|ье|ьи|ьих|ьим|ьими)";
const HARD_ORDINAL_SUFFIX_ALT = "(?:ый|ой|ого|ому|ым|ом|ая|ую|ое|ые|ых|ыми)";

const ORDINAL_DAY_STEMS: readonly { stem: string; suffixAlt: string; value: number }[] = [
	{ stem: "перв", suffixAlt: HARD_ORDINAL_SUFFIX_ALT, value: 1 },
	{ stem: "втор", suffixAlt: HARD_ORDINAL_SUFFIX_ALT, value: 2 },
	{ stem: "трет", suffixAlt: THIRD_ORDINAL_SUFFIX_ALT, value: 3 },
	{ stem: "четвёрт", suffixAlt: HARD_ORDINAL_SUFFIX_ALT, value: 4 },
	{ stem: "пят", suffixAlt: HARD_ORDINAL_SUFFIX_ALT, value: 5 },
	{ stem: "шест", suffixAlt: HARD_ORDINAL_SUFFIX_ALT, value: 6 },
	{ stem: "седьм", suffixAlt: HARD_ORDINAL_SUFFIX_ALT, value: 7 },
	{ stem: "восьм", suffixAlt: HARD_ORDINAL_SUFFIX_ALT, value: 8 },
	{ stem: "девят", suffixAlt: HARD_ORDINAL_SUFFIX_ALT, value: 9 },
	{ stem: "десят", suffixAlt: HARD_ORDINAL_SUFFIX_ALT, value: 10 },
];

// A short adjective can sit between the ordinal and the day-word ("первый
// зелёный день") — same tolerance FORECAST_RE already gives "завтра...курс"
// above; a character window, not a hard word count.
const ORDINAL_DAY_GAP = ".{0,20}?";
const DAY_WORD_ALT = "(?:день|дня|сутки)";

const ORDINAL_DAY_RE = new RegExp(
	`${NOT_WORD_BEFORE}(${ORDINAL_DAY_STEMS.map(({ stem, suffixAlt }) => `${stem}${suffixAlt}`).join("|")})${NOT_WORD_AFTER}${ORDINAL_DAY_GAP}${DAY_WORD_ALT}${NOT_WORD_AFTER}`,
	"giu",
);

function ordinalWordValue(word: string): number | null {
	const lower = word.toLowerCase();
	for (const { stem, suffixAlt, value } of ORDINAL_DAY_STEMS) {
		if (new RegExp(`^${stem}${suffixAlt}$`, "u").test(lower)) return value;
	}
	return null;
}

function findStreakWordMismatch(text: string, streak: number): string | null {
	for (const match of text.matchAll(ORDINAL_DAY_RE)) {
		const value = ordinalWordValue(match[1]!);
		if (value !== null && value !== streak) return match[0];
	}
	return null;
}

// --- item 9: derived numbers spoken as words — a ratio or fraction the model
// computed itself from other allowed numbers ("зелёных в десять раз больше"),
// rather than copying a string verbatim from allowedNumbers. Arithmetically
// correct for the day it was written doesn't mean grounded: the numbers
// whitelist check (item 1) only looks at digit tokens, so it has nothing to
// catch here, and the same phrase on a different day's counts would be a
// silent miscalculation with no digit anywhere to flag.
//
// "треть" is matched as a bare word only, not stem-expanded like
// половин*/четверть* below — день-count ordinals ("третий день",
// "третьи сутки подряд", required verbatim by section 4's ДНИ ПОДРЯД rule)
// share the "треть-" prefix in every form except the masculine nominative
// ("третий" itself, spelled without a soft sign): третья, третье, третьи,
// третьего, третьей... all start with "треть" + a vowel/consonant. A stem
// match would silently reject correct day-count phrasing; the bare word
// "треть" (nominative/accusative singular of the fraction, e.g. "треть
// монет") never has anything following it, so NOT_WORD_AFTER already keeps
// it from matching into "третьи" and friends.
//
// "кратно"/"многократно"/"в разы" added after a live response wrote "зелёных
// монет кратно больше красных" for 50 vs 16 — a multiplicity masked as a
// plain adverb rather than the "вдвое"/"в N раз" phrasing already covered.
// Bare words, not stem-expanded, same reasoning as треть above: no observed
// day-count collision risk for these two, but matching the established
// narrow-by-default style rather than guessing at other inflections
// (кратный, кратное...) nothing has actually produced yet.
const DERIVED_NUMBER_WORDS_RE = new RegExp(
	`${NOT_WORD_BEFORE}(?:вдвое|втрое|вчетверо|в\\s+(?:два|три|четыре|пять|шесть|семь|восемь|девять|десять)\\s+раз(?:а)?|в\\s+разы|половин\\p{L}*|четверть\\p{L}*|две\\s+трети|треть|многократно|кратно)${NOT_WORD_AFTER}`,
	"iu",
);

function findDerivedNumberWords(text: string): string | null {
	const match = text.match(DERIVED_NUMBER_WORDS_RE);
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
// Opus 5 wrote "mixed-сигнал говорит о том, что…" — the model's own input
// field value (facts.swarmState is literally "mixed") leaked straight into
// prose as an English adjective. Cheaper to catch here than to grow the
// system prompt over it: it's already at 3960 of a 4000-char norm (see
// tools/ai-compare.ts's SYSTEM_PROMPT_NORM_MAX_CHARS), and every new prompt
// rule costs input tokens on every single future request forever, while a
// validator pattern costs nothing until it actually fires.
const AI_FIELD_LEAK_RE = new RegExp(`${NOT_WORD_BEFORE}(?:green|red|mixed|swarmState|streak)${NOT_WORD_AFTER}`, "iu");

const FORBIDDEN_PATTERNS: readonly { re: RegExp; label: string; stripTickers?: boolean }[] = [
	{ re: FORECAST_RE, label: "forecast language" },
	{ re: ADVICE_RE, label: "buy/sell advice" },
	{ re: MOONSHOT_RE, label: "moonshot promise" },
	{ re: HASHTAG_RE, label: "hashtag" },
	{ re: URL_RE, label: "URL" },
	// An allowed leader ticker can itself look like an HTML tag —
	// fixtures/escape-html.json's topLoser ticker is literally "<b>X", and a
	// model reproducing it verbatim (which is allowed) was getting rejected
	// as if it had written real markup. Strip the day's own tickers first,
	// same technique item 6 already uses for the Cyrillic-ratio check — the
	// pattern itself stays exactly as strict, only what it's tested against
	// changes.
	{ re: HTML_TAG_RE, label: "HTML tag", stripTickers: true },
	// Same reasoning: a ticker that happens to spell "RED"/"GREEN"/etc. must
	// not sink an otherwise-valid response either.
	{ re: AI_FIELD_LEAK_RE, label: "English field name/value (green/red/mixed/swarmState/streak) leaked into prose", stripTickers: true },
	// The template's own paragraphs never use emoji — no established "allowed
	// set" exists for prose, so any emoji at all is out until one is defined.
	{ re: EMOJI_RE, label: "emoji" },
];

function findForbiddenPattern(text: string, payload: AiPayload): string | null {
	for (const { re, label, stripTickers } of FORBIDDEN_PATTERNS) {
		const target = stripTickers ? stripKnownTickers(text, payload) : text;
		if (re.test(target)) return label;
	}
	return null;
}

// --- item 6: language — share of Cyrillic letters, tickers and "BTC" stripped first (stripKnownTickers, defined above with item 3's forbidden-pattern check) ---

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

// --- v2 section 4 rewrite: the model's only text output is now the
// observation paragraph — picture (paragraph 1) is entirely code-generated
// (render.ts's pickPicture), never sent to or returned by the model. Items
// 1/7/9/10 above (numbers whitelist, digit day-count, derived-number words,
// word-form streak mismatch) are kept in this file untouched — for
// validateAiParagraphs below and a possible rollback to the two-paragraph
// contract — but this new path calls neither them nor validateAiParagraphs:
// the two checks below are strictly broader supersets of what each of those
// four covered individually, now that the model has no legitimate reason to
// write a number or a day-count in any form at all. ---

export type ObservationValidationFailureReason =
	| "invalid_json"
	| "validator:length"
	| "validator:forbidden_pattern"
	| "validator:direction"
	| "validator:empty_or_cutoff"
	| "validator:language"
	| "validator:observation_digit"
	| "validator:observation_day_count";

export type AiObservation = {
	observation: string;
	direction: AiPayload["today"]["swarmState"];
};

export type ObservationValidationResult = { ok: true; result: AiObservation } | { ok: false; reason: ObservationValidationFailureReason; detail: string };

function parseAiObservationJson(rawText: string): { observation: string; direction: string } | null {
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
	if (typeof obj.observation !== "string" || typeof obj.direction !== "string") return null;
	return { observation: obj.observation, direction: obj.direction };
}

// Every number in the post is now either in a code-generated line or in
// paragraph 1 (also code-generated) — observation can't legitimately need a
// digit for anything, so unlike item 1 there's no whitelist to check
// against: any digit at all is a rejection, allowed or not.
const ANY_DIGIT_RE = /\d/;

function findAnyDigit(text: string): string | null {
	const match = text.match(ANY_DIGIT_RE);
	return match ? match[0] : null;
}

// Day-count mention in ANY form — word or digit — is banned outright now,
// not just checked for digit-form (item 7) or word-form correctness (item
// 10): the day count, when there is one, lives in paragraph 1 (code-
// generated from facts.streak via pickPicture), so observation has no
// business naming it at all, right or wrong. A digit-form count is already
// caught by the any-digit check above; this catches the word-form case
// (e.g. "третий день") that has no digit for that check to see. Reuses item
// 10's own stem/suffix/gap pieces — not a new generator, a non-global
// sibling of ORDINAL_DAY_RE for plain presence-detection: a global regex's
// mutable lastIndex makes it unsafe to .test() directly across repeated
// calls on the same module-level instance (matchAll, which ORDINAL_DAY_RE
// is built for, doesn't have that problem — a bare .test()/.match() would).
const ANY_ORDINAL_DAY_RE = new RegExp(
	`${NOT_WORD_BEFORE}(?:${ORDINAL_DAY_STEMS.map(({ stem, suffixAlt }) => `${stem}${suffixAlt}`).join("|")})${NOT_WORD_AFTER}${ORDINAL_DAY_GAP}${DAY_WORD_ALT}${NOT_WORD_AFTER}`,
	"iu",
);

function findAnyDayCountWord(text: string): string | null {
	const match = text.match(ANY_ORDINAL_DAY_RE);
	return match ? match[0] : null;
}

/**
 * New one-paragraph contract: parse {observation, direction} -> non-empty/
 * not cut off -> length -> forbidden content -> direction -> any digit ->
 * any day-count word -> language.
 */
export function validateAiObservation(rawText: string, payload: AiPayload): ObservationValidationResult {
	const parsed = parseAiObservationJson(rawText);
	if (!parsed) {
		return { ok: false, reason: "invalid_json", detail: "no valid {observation, direction} JSON object found in the response" };
	}

	const observation = parsed.observation.trim();

	if (!observation) return { ok: false, reason: "validator:empty_or_cutoff", detail: "observation is empty" };
	if (!endsLikeASentence(observation)) {
		return { ok: false, reason: "validator:empty_or_cutoff", detail: `observation does not end with sentence-ending punctuation: "...${observation.slice(-20)}"` };
	}
	if (observation.length > MAX_PARAGRAPH_LENGTH) {
		return { ok: false, reason: "validator:length", detail: `observation is ${observation.length} chars, limit ${MAX_PARAGRAPH_LENGTH}` };
	}

	const forbidden = findForbiddenPattern(observation, payload);
	if (forbidden) return { ok: false, reason: "validator:forbidden_pattern", detail: forbidden };

	if (parsed.direction !== payload.today.swarmState) {
		return { ok: false, reason: "validator:direction", detail: `direction "${parsed.direction}" !== facts.swarmState "${payload.today.swarmState}"` };
	}
	const direction = parsed.direction as AiPayload["today"]["swarmState"];

	const anyDigit = findAnyDigit(observation);
	if (anyDigit) return { ok: false, reason: "validator:observation_digit", detail: `"${anyDigit}" — observation may not contain any digit; every number already lives elsewhere in the post` };

	const anyDayCountWord = findAnyDayCountWord(observation);
	if (anyDayCountWord) {
		return { ok: false, reason: "validator:observation_day_count", detail: `"${anyDayCountWord}" — the day count (word or digit) belongs to paragraph 1 only, generated by code, never in observation` };
	}

	if (!isRussianEnough(observation, payload)) {
		return { ok: false, reason: "validator:language", detail: "text does not look like Russian (< 90% Cyrillic letters after stripping tickers/BTC)" };
	}

	return { ok: true, result: { observation, direction } };
}

/**
 * Section 5, checks in this order (first failure wins — order doesn't change
 * correctness, each check is independent): parse -> non-empty/not cut off ->
 * length -> forbidden content -> direction -> streak-as-digit ->
 * streak-as-mismatched-ordinal-word -> derived-number-words -> number
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

	const forbidden = findForbiddenPattern(combined, payload);
	if (forbidden) return { ok: false, reason: "validator:forbidden_pattern", detail: forbidden };

	if (parsed.direction !== payload.today.swarmState) {
		return { ok: false, reason: "validator:direction", detail: `direction "${parsed.direction}" !== facts.swarmState "${payload.today.swarmState}"` };
	}
	const direction = parsed.direction as AiPayload["today"]["swarmState"];

	const digitDayCount = findDigitDayCount(combined);
	if (digitDayCount) return { ok: false, reason: "validator:streak_digit", detail: `"${digitDayCount}" — day-streak must be spoken as a word, never a digit` };

	const streakWordMismatch = findStreakWordMismatch(combined, payload.today.streak);
	if (streakWordMismatch) return { ok: false, reason: "validator:streak_word_mismatch", detail: `"${streakWordMismatch}" — ordinal day-count in words doesn't match facts.streak (${payload.today.streak})` };

	const derivedNumberWords = findDerivedNumberWords(combined);
	if (derivedNumberWords) return { ok: false, reason: "validator:derived_numbers", detail: `"${derivedNumberWords}" — a ratio/fraction in words is a self-computed number, not a copy from allowedNumbers` };

	const badNumber = findDisallowedNumber(combined, payload.allowedNumbers);
	if (badNumber) return { ok: false, reason: "validator:numbers", detail: `"${badNumber}" is not in allowedNumbers` };

	if (!isRussianEnough(combined, payload)) {
		return { ok: false, reason: "validator:language", detail: "text does not look like Russian (< 90% Cyrillic letters after stripping tickers/BTC)" };
	}

	return { ok: true, paragraphs: { picture, observation, direction } };
}
