// v2 step 7: local manual verification tool. Makes REAL requests to the model (unless a
// mocked AiClient is injected via runCompare() directly, e.g. for previewing
// the report format without spending credits) — this file is never invoked
// by index.ts or by any test, and lives outside tsconfig's "include" (src,
// tests only) so it never becomes part of the production build or its
// typecheck. Run manually: `npm run ai:compare -- <fixture>|--all [--runs=N]
// [--chain=N] [--chain-degrade=K[,K...]] [--retry] [--model=<id>] [--balance=N]`.
// --chain and --runs are mutually exclusive: --runs=N samples the same
// single day N independent times, --chain=N runs N sequential days where
// each day's own output feeds the next day's history — see runChain()
// below. --chain-degrade=K forces step K onto the template path with zero
// model calls, for testing "day after a degraded day" on demand instead of
// waiting for a real rejection/timeout.
//
// Fallback (a second model) is off on purpose regardless of --retry: this
// tool compares one model at a time, and simulating a fallback switch would
// blur which model actually produced which text. Retries are off by
// default for the same reason buildParagraphsAI()'s retry loop exists to
// *hide* a content-level failure from the published post in production —
// exactly what must NOT happen here by default, since the whole point of
// this tool is to see the raw first-attempt failure rate before anything
// smooths it over. --retry opts back in explicitly: on a content-level
// rejection, exactly one more attempt, the same way generate.ts's own retry
// loop does it (buildRetryObservationPrompt keyed by the rejection reason,
// the same one-retry limit) — reported as its own separate line, with the
// fixture's tally following the final outcome and marked when reached by
// retry, so the raw-vs-retried rate stays visible instead of blending back
// into "just accepted".
//
// Reports land in reports/, not out/ — reports/ is tracked by git (out/
// isn't) because a report from a real, paid run can't be reproduced without
// spending real credits again, and out/'s own cleanup rule (age-based file
// deletion only, never removing the directory — see README.md) has no way
// to tell a report worth keeping from a stale daily *.ai.json dump.
//
// No prod logic is reimplemented: buildAiPayload, buildSystemPrompt/
// buildUserPrompt, validateAiObservation, computeCost, stateHistoryToAiHistory,
// pickPicture (paragraph 1, code-generated since PROMPT_VERSION 7) and
// buildParagraphs (the template fallback, shown alongside each AI run for
// a pairwise read — section 9's actual ask) are the exact functions the
// production path calls, imported as-is. This file only adds argument
// parsing, one bare client.generate() call per run (skipping generate.ts's
// loop), and markdown formatting.
import "dotenv/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAiClient, type AiClient, type AiUsage } from "../src/ai/client.js";
import { buildAiPayload, stateHistoryToAiHistory, type AiPayload } from "../src/ai/payload.js";
import { buildRetryObservationPrompt, buildSystemPrompt, buildUserPrompt } from "../src/ai/prompt.js";
import { billedInputTokens, computeCost, PROXY_INPUT_TOKEN_OVERHEAD } from "../src/ai/usage.js";
import { attemptDayCountTrim, validateAiObservation, type ObservationValidationFailureReason } from "../src/ai/validator.js";
import { computeFacts, shiftDateKey, type Facts, type StateHistory } from "../src/facts.js";
import { buildParagraphs, pickPicture, type PostParagraphs } from "../src/render.js";
import { loadSnapshotFromFile } from "../src/snapshot.js";
import { appendDay, readState } from "../src/state.js";
import type { HotCoinsSnapshot } from "../src/types.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");

// Same ten fixtures as tests/ai-payload.test.ts's ALL_FIXTURE_NAMES — section 9's list.
const ALL_FIXTURE_NAMES = [
	"real-day.json",
	"red-streak.json",
	"red-first-day.json",
	"green.json",
	"mixed.json",
	"boring.json",
	"no-btc.json",
	"edge-empty.json",
	"red-boundary-60.json",
	"escape-html.json",
];

// Current buildSystemPrompt() output is ~2800 chars — this ceiling gives
// comfortable room to grow (e.g. a new prompt-version rule) while still
// catching genuine bloat: an accidental duplication, a debug string left in,
// or anything else that would silently start eating into every single day's
// token budget. system is static (buildSystemPrompt() takes no arguments),
// so this check is really about catching *code* regressions, not per-day
// data variance — checked once per report, not once per fixture.
const SYSTEM_PROMPT_NORM_MAX_CHARS = 4000;

/**
 * validateAiObservation's own checks (PROMPT_VERSION 7's active path — items
 * 1/7/9/10, the numbers whitelist/digit day-count/derived-number words/
 * word-form streak mismatch, are validateAiParagraphs-only now, not called
 * here at all): parse -> non-empty/not cut off -> length -> forbidden
 * content -> direction -> any digit -> any day-count word -> ratio-mismatch
 * -> language.
 */
const VALIDATOR_ITEM_LABELS: Record<ObservationValidationFailureReason, string> = {
	invalid_json: "невалидный JSON (до проверок раздела 5)",
	"validator:length": "п.2 длина",
	"validator:forbidden_pattern": "п.3 запрещённые паттерны",
	"validator:direction": "п.4 direction",
	"validator:empty_or_cutoff": "п.5 пустой/оборванный абзац",
	"validator:language": "п.6 язык",
	"validator:observation_digit": "новое: любая цифра в абзаце",
	"validator:observation_day_count": "новое: любой счёт дней (словом или цифрой)",
	"validator:observation_ratio_mismatch": "новое: словесная кратность не совпадает с реальным соотношением зелёных/красных",
};

export type RunOutcome =
	| {
			kind: "accepted";
			picture: string;
			observation: string;
			direction: string;
			tokensIn: number | null;
			tokensOut: number | null;
			durationMs: number;
			costEstimate: number | null;
			/** The proxy's own usage block, untouched — see AiGenerateResult.rawUsage in client.ts. */
			rawUsage: unknown;
	  }
	| {
			kind: "rejected";
			reason: ObservationValidationFailureReason;
			detail: string;
			rawResponse: string;
			tokensIn: number | null;
			tokensOut: number | null;
			durationMs: number;
			costEstimate: number | null;
			rawUsage: unknown;
	  }
	// Third outcome (2026-08-26): would have been "rejected" for
	// validator:observation_day_count, but exactly one sentence carried the
	// violation and cutting it left a paragraph that passed
	// validateAiObservation whole — see validator.ts's attemptDayCountTrim.
	// A distinct grade from "accepted", shown separately in the report: the
	// model's raw answer wasn't clean, even though what got published was.
	| {
			kind: "trimmed";
			picture: string;
			observation: string;
			direction: string;
			originalObservation: string;
			removedSentence: string;
			tokensIn: number | null;
			tokensOut: number | null;
			durationMs: number;
			costEstimate: number | null;
			rawUsage: unknown;
	  }
	| { kind: "transport"; label: string; errorMessage: string | null; durationMs: number }
	// --chain-degrade only: this step deliberately skipped the model entirely
	// (no client.generate() call at all) to force a degraded day on demand,
	// instead of waiting for a real rejection/timeout to happen naturally.
	| { kind: "forced"; template: PostParagraphs };

export type FixtureRun = {
	fixtureName: string;
	run: number;
	outcome: RunOutcome;
	/** --retry only: present exactly when the first attempt was "rejected" (content-level) and a second attempt was made — the second attempt's own outcome, built the same way generate.ts's own retry does (buildRetryObservationPrompt keyed by the rejection reason). Never set for "transport" (matches generate.ts's own retry-vs-fallback split: a transport failure moves to a different model in production, and this tool has no fallback model to move to) or "forced" (--chain-degrade skips the model entirely, nothing to retry). Never set when the first attempt is "trimmed" either — a trimmed attempt is already a resolved, publishable outcome, same as "accepted", nothing left to retry. */
	retryOutcome?: RunOneOutcome;
};

/** What a real model call can produce — "forced" is never one of runOne()'s own results, it's only ever constructed directly by --chain-degrade's own branch, which skips runOne() entirely. */
export type RunOneOutcome = Extract<RunOutcome, { kind: "accepted" } | { kind: "rejected" } | { kind: "trimmed" } | { kind: "transport" }>;

/** The outcome that actually determines a run's verdict/summary classification — the retry's own outcome when one happened, otherwise the first attempt's. Exported for direct testing alongside runOneWithOptionalRetry/runTotals. */
export function finalOutcome(fr: FixtureRun): RunOutcome {
	return fr.retryOutcome ?? fr.outcome;
}

export function outcomeLabel(outcome: RunOneOutcome): string {
	if (outcome.kind === "accepted") return "ok";
	if (outcome.kind === "trimmed") return "trimmed (cut 1 sentence)";
	if (outcome.kind === "rejected") return `rejected (${outcome.reason})`;
	return `transport (${outcome.label})`;
}

export type CompareOptions = {
	client: AiClient;
	modelId: string;
	/** This run's own price knobs — the fallback's when modelId is the fallback model, mirroring how production prices an attempt by whichever model actually answered it. */
	priceInPerMillion: number | null;
	priceOutPerMillion: number | null;
	fixtureNames: string[];
	runsPerFixture: number;
	timeoutMs: number;
	promptVersion: number;
	stateHistory: StateHistory;
	balance: number;
	outFile: string;
	/** Same instant the caller used to build outFile's HHMM — the header's "Дата запуска" line must read the exact same time, not a fresh `new Date()` at write time. */
	startedAt: Date;
	/** --retry: on a content-level rejection, one more attempt the same way generate.ts's own retry does — see FixtureRun.retryOutcome. */
	retry: boolean;
};

function loadSnapshotAndFacts(fixtureName: string, stateHistory: StateHistory): { snapshot: HotCoinsSnapshot; facts: Facts } {
	const snapshot = loadSnapshotFromFile(path.join(FIXTURES_DIR, fixtureName));
	return { snapshot, facts: computeFacts(snapshot, stateHistory) };
}

type Section31Check = {
	rawSnapshotFieldsLeaked: string[];
	unrelatedTickersLeaked: string[];
	/** streak was removed from AiPayload entirely (see payload.ts's own comment on AiTodayPayload) — a regression that brings it back must fail loudly here, not pass silently the way a plain field-shape check would. */
	streakLeaked: boolean;
};

/**
 * Section 3.1's own concerns, checked against the exact string sent to the
 * model — not a re-derivation, a direct inspection of buildUserPrompt()'s
 * output. Same technique tests/ai-payload.test.ts already uses for the first
 * two (no shared src/ function to reuse — that test doesn't call one either,
 * it's a plain substring/field check both times). history no longer has a
 * shape worth checking here — AiHistoryEntry is a bare string now (payload.ts),
 * so there's no object key to leak; TypeScript itself guarantees that shape.
 */
function checkSection31(userJson: string, payload: AiPayload, snapshot: HotCoinsSnapshot): Section31Check {
	const rawSnapshotFieldsLeaked = ["mainSwarm", "edgePins", "marketCap"].filter((field) => userJson.includes(field));

	const winnerTicker = payload.today.topGainer?.ticker;
	const loserTicker = payload.today.topLoser?.ticker;
	const allCoins = [...snapshot.mainSwarm, ...snapshot.edgePins];
	const unrelatedTickersLeaked = [...new Set(allCoins.filter((c) => c.ticker !== winnerTicker && c.ticker !== loserTicker).map((c) => c.ticker))].filter((ticker) => userJson.includes(ticker));

	const streakLeaked = /"streak"\s*:/.test(userJson);

	return { rawSnapshotFieldsLeaked, unrelatedTickersLeaked, streakLeaked };
}

async function runOne(
	client: AiClient,
	modelId: string,
	system: string,
	user: string,
	timeoutMs: number,
	payload: AiPayload,
	priceInPerMillion: number | null,
	priceOutPerMillion: number | null,
	/** Paragraph 1 is code-generated (pickPicture), never part of the model's response — needed here only to attach it to the "accepted" outcome for the report's pairwise display. */
	facts: Facts,
): Promise<RunOneOutcome> {
	const result = await client.generate({ model: modelId, system, user, timeoutMs });

	if (!result.ok) {
		const label = result.errorKind === "timeout" ? "таймаут" : result.errorKind === "http_error" ? `HTTP ${result.httpStatus}` : "сетевая ошибка";
		return { kind: "transport", label, errorMessage: result.errorMessage, durationMs: result.durationMs };
	}

	const rawText = result.content ?? "";
	const validation = validateAiObservation(rawText, payload);
	const costEstimate = computeCost(result.usage, priceInPerMillion, priceOutPerMillion);
	const tokensIn = result.usage?.promptTokens ?? null;
	const tokensOut = result.usage?.completionTokens ?? null;

	if (validation.ok) {
		return {
			kind: "accepted",
			picture: pickPicture(facts),
			observation: validation.result.observation,
			direction: validation.result.direction,
			tokensIn,
			tokensOut,
			durationMs: result.durationMs,
			costEstimate,
			rawUsage: result.rawUsage,
		};
	}

	// Same third outcome as generate.ts's production path (src/ai/generate.ts) —
	// one shared definition of the eligibility/re-validation rules
	// (validator.ts's attemptDayCountTrim), so this report can never disagree
	// with what the real post would have done for the exact same response.
	if (validation.reason === "validator:observation_day_count") {
		const trim = attemptDayCountTrim(rawText, payload);
		if (trim.ok) {
			return {
				kind: "trimmed",
				picture: pickPicture(facts),
				observation: trim.observation,
				direction: trim.direction,
				originalObservation: trim.originalObservation,
				removedSentence: trim.removedSentence,
				tokensIn,
				tokensOut,
				durationMs: result.durationMs,
				costEstimate,
				rawUsage: result.rawUsage,
			};
		}
		// "not_eligible" or "trim_failed" — either way, this specific rawText
		// stays a plain rejection, same as before this outcome existed. The
		// stage/detail difference only matters to generate.ts's own
		// retry-vs-template branching, not to this report.
	}

	return {
		kind: "rejected",
		reason: validation.reason,
		detail: validation.detail,
		rawResponse: rawText,
		tokensIn,
		tokensOut,
		durationMs: result.durationMs,
		costEstimate,
		rawUsage: result.rawUsage,
	};
}

/**
 * --retry: on a content-level rejection, exactly one more attempt — the
 * same targeted instruction generate.ts's own retry loop builds
 * (buildRetryObservationPrompt keyed by the rejection reason), the same
 * one-retry limit (maxAttemptsPerModel=2's real default). A transport
 * failure is never retried here, matching generate.ts's own retry-vs-
 * fallback split exactly: a transport failure moves to a *different* model
 * in production, and this tool has no fallback model to move to, so a
 * transport failure on attempt 1 simply stays a transport failure.
 */
export async function runOneWithOptionalRetry(
	client: AiClient,
	modelId: string,
	system: string,
	user: string,
	timeoutMs: number,
	payload: AiPayload,
	priceInPerMillion: number | null,
	priceOutPerMillion: number | null,
	facts: Facts,
	retry: boolean,
): Promise<{ outcome: RunOneOutcome; retryOutcome?: RunOneOutcome }> {
	const outcome = await runOne(client, modelId, system, user, timeoutMs, payload, priceInPerMillion, priceOutPerMillion, facts);
	if (!retry || outcome.kind !== "rejected") return { outcome };

	const retryUser = buildRetryObservationPrompt(payload, outcome.reason);
	const retryOutcome = await runOne(client, modelId, system, retryUser, timeoutMs, payload, priceInPerMillion, priceOutPerMillion, facts);
	return { outcome, retryOutcome };
}

function formatCostLine(costEstimate: number | null): string {
	return costEstimate !== null ? `- Стоимость (оценка): ${costEstimate.toFixed(4)} кредитов` : `- Стоимость: не посчитана (цена для этой модели не задана в .env)`;
}

/**
 * Same formula computeCost() already uses — just called with promptTokens
 * reduced by billedInputTokens() (src/ai/usage.js — the one shared
 * definition, also used by src/ai/usageReport.ts's balance calibration).
 * Returns null (no line) under the exact same conditions computeCost()
 * itself would: no usage, or either price knob unset for this model.
 */
export function formatCalibratedCostLine(tokensIn: number | null, tokensOut: number | null, priceInPerMillion: number | null, priceOutPerMillion: number | null): string | null {
	if (tokensIn === null || tokensOut === null) return null;
	const calibratedTokensIn = billedInputTokens(tokensIn);
	const calibratedUsage: AiUsage = { promptTokens: calibratedTokensIn, completionTokens: tokensOut, totalTokens: calibratedTokensIn + tokensOut, cachedTokens: null };
	const calibratedCost = computeCost(calibratedUsage, priceInPerMillion, priceOutPerMillion);
	if (calibratedCost === null) return null;
	return `- Оценка с поправкой на оверхед прокси (−${PROXY_INPUT_TOKEN_OVERHEAD} входных токенов): ${calibratedCost.toFixed(4)} кредитов — эмпирическая калибровка по панели прокси, не данные API.`;
}

/** As-is, no interpretation — exactly what client.ts's AiGenerateResult.rawUsage carries, for comparing against the proxy's own billing panel by eye. */
function formatRawUsageBlock(rawUsage: unknown): string {
	return ["**Сырой usage от прокси (как есть, без интерпретации):**", "```json", JSON.stringify(rawUsage, null, 2), "```"].join("\n");
}

function formatSection31Line(label: string, leaked: string[]): string {
	return leaked.length === 0 ? `  - ✅ ${label}` : `  - ❌ ${label}: ${leaked.join(", ")}`;
}

function formatSection31BooleanLine(label: string, failed: boolean): string {
	return failed ? `  - ❌ ${label}` : `  - ✅ ${label}`;
}

/**
 * Shown once per fixture, above its AI runs. Two things, both free (no
 * request): the template half of the pairwise comparison (section 9's actual
 * ask: template vs AI, not AI in isolation — buildParagraphs() is a pure
 * local call), and the user message's own length plus, when the system
 * prompt is within norm, its full JSON body and a section-3.1 check (no raw
 * snapshot, no unrelated coin tickers, no leaked streak field).
 */
function formatFixtureHeader(fixtureName: string, facts: Facts, payload: AiPayload, template: PostParagraphs, userPrompt: string, systemInNorm: boolean, snapshot: HotCoinsSnapshot): string {
	const lines = [
		`## ${fixtureName}`,
		"",
		`- swarmState: ${facts.swarmState}`,
		`- streak: ${facts.streak} (не отправляется модели — см. payload.ts)`,
		`- allowedNumbers: ${payload.allowedNumbers.join(", ")}`,
		`- Длина user-сообщения: ${userPrompt.length} символов`,
		"",
		"### Шаблон (buildParagraphs, без запроса к модели)",
		"",
		"**Абзац 1 (picture):**",
		`> ${template.picture}`,
		"",
		"**Абзац 2 (observation):**",
		`> ${template.observation}`,
	];

	if (systemInNorm) {
		const check = checkSection31(userPrompt, payload, snapshot);
		lines.push(
			"",
			"### user-JSON (сверка с п.3.1: сырой снапшот, полный список монет, поле streak)",
			"",
			"```json",
			JSON.stringify(payload, null, 2),
			"```",
			"",
			"Проверка п.3.1:",
			formatSection31Line("сырой снапшот отсутствует (mainSwarm/edgePins/marketCap)", check.rawSnapshotFieldsLeaked),
			formatSection31Line("нет тикеров посторонних монет", check.unrelatedTickersLeaked),
			formatSection31BooleanLine("поле streak отсутствует в payload", check.streakLeaked),
		);
	}

	return lines.join("\n");
}

/**
 * One attempt's block — verdict, tokens, cost, time, raw usage, text/
 * response. `label` is null for the (common, non-retried) single-attempt
 * case, producing exactly the same output this function's predecessor
 * always did; a real label ("Первая попытка"/"Повторная попытка (--retry)")
 * is only used once a run actually has two attempts to tell apart.
 */
function formatAttemptOutcome(label: string | null, outcome: RunOneOutcome, priceInPerMillion: number | null, priceOutPerMillion: number | null): string {
	const labelLines = label ? [`**${label}:**`, ""] : [];

	if (outcome.kind === "transport") {
		return [...labelLines, `- Вердикт: ⚠️ transport — ${outcome.label}${outcome.errorMessage ? ` (${outcome.errorMessage})` : ""}`, `- Время ответа: ${outcome.durationMs} ms`, `- Токены: н/д`].join(
			"\n",
		);
	}

	const tokensLine = `- Токены: in=${outcome.tokensIn ?? "н/д"} out=${outcome.tokensOut ?? "н/д"}`;
	const timeLine = `- Время ответа: ${outcome.durationMs} ms`;
	const costLine = formatCostLine(outcome.costEstimate);
	const calibratedCostLine = formatCalibratedCostLine(outcome.tokensIn, outcome.tokensOut, priceInPerMillion, priceOutPerMillion);

	if (outcome.kind === "accepted") {
		return [
			...labelLines,
			"- Вердикт: ✅ принято",
			tokensLine,
			costLine,
			...(calibratedCostLine ? [calibratedCostLine] : []),
			timeLine,
			"",
			formatRawUsageBlock(outcome.rawUsage),
			"",
			"**Абзац 1 (picture):**",
			`> ${outcome.picture}`,
			"",
			"**Абзац 2 (observation):**",
			`> ${outcome.observation}`,
			"",
			`**direction:** ${outcome.direction}`,
		].join("\n");
	}

	if (outcome.kind === "trimmed") {
		return [
			...labelLines,
			"- Вердикт: ✂️ починено вырезанием предложения (новое: любой счёт дней (словом или цифрой), исходно только в одном предложении из трёх+)",
			tokensLine,
			costLine,
			...(calibratedCostLine ? [calibratedCostLine] : []),
			timeLine,
			"",
			formatRawUsageBlock(outcome.rawUsage),
			"",
			"**Абзац 2 (observation) до вырезания:**",
			`> ${outcome.originalObservation}`,
			"",
			"**Вырезанное предложение:**",
			`> ${outcome.removedSentence}`,
			"",
			"**Абзац 1 (picture):**",
			`> ${outcome.picture}`,
			"",
			"**Абзац 2 (observation) после вырезания — именно это ушло бы в пост:**",
			`> ${outcome.observation}`,
			"",
			`**direction:** ${outcome.direction}`,
		].join("\n");
	}

	return [
		...labelLines,
		`- Вердикт: ❌ отклонено — ${VALIDATOR_ITEM_LABELS[outcome.reason]}: ${outcome.detail}`,
		tokensLine,
		costLine,
		...(calibratedCostLine ? [calibratedCostLine] : []),
		timeLine,
		"",
		formatRawUsageBlock(outcome.rawUsage),
		"",
		"**Сырой ответ модели:**",
		"```",
		outcome.rawResponse,
		"```",
	].join("\n");
}

/** Exported for direct testing — the same short verdict string used in formatRunSection's "Итог по прогону" line. */
export function verdictText(outcome: RunOneOutcome): string {
	if (outcome.kind === "accepted") return "✅ принято";
	if (outcome.kind === "trimmed") return "✂️ починено вырезанием";
	if (outcome.kind === "transport") return `⚠️ transport — ${outcome.label}`;
	return `❌ отклонено — ${VALIDATOR_ITEM_LABELS[outcome.reason]}`;
}

function formatRunSection(fr: FixtureRun, totalRuns: number, priceInPerMillion: number | null, priceOutPerMillion: number | null): string {
	const { run, outcome, retryOutcome } = fr;
	const header = `### ИИ — прогон ${run}/${totalRuns}`;

	if (outcome.kind === "forced") {
		return [
			header,
			"",
			"- Вердикт: 🔧 принудительная деградация (--chain-degrade) — запроса к модели не было",
			"- Токены: н/д",
			"",
			"**Абзац 1 (picture, шаблон):**",
			`> ${outcome.template.picture}`,
			"",
			"**Абзац 2 (observation, шаблон):**",
			`> ${outcome.template.observation}`,
		].join("\n");
	}

	if (!retryOutcome) {
		return [header, "", formatAttemptOutcome(null, outcome, priceInPerMillion, priceOutPerMillion)].join("\n");
	}

	return [
		header,
		"",
		formatAttemptOutcome("Первая попытка", outcome, priceInPerMillion, priceOutPerMillion),
		"",
		formatAttemptOutcome("Повторная попытка (--retry)", retryOutcome, priceInPerMillion, priceOutPerMillion),
		"",
		`**Итог по прогону:** ${verdictText(retryOutcome)} — достигнуто ретраем`,
	].join("\n");
}

/** Real spend for one run — both attempts' tokens/cost when a retry happened (a retry is a second real request, priced like the first), not just whichever attempt turned out final. null+null only when nothing is known at all, never invented as 0. */
export function runTotals(fr: FixtureRun): { tokensIn: number | null; tokensOut: number | null; costEstimate: number | null } {
	const candidates: (RunOneOutcome | undefined)[] = [fr.outcome.kind === "forced" ? undefined : fr.outcome, fr.retryOutcome];
	const attempts = candidates.filter((o): o is Extract<RunOneOutcome, { kind: "accepted" | "rejected" | "trimmed" }> => o !== undefined && o.kind !== "transport");
	if (attempts.length === 0) return { tokensIn: null, tokensOut: null, costEstimate: null };
	const sum = (nums: (number | null)[]) => (nums.every((n) => n === null) ? null : nums.reduce((a: number, b) => a + (b ?? 0), 0));
	return {
		tokensIn: sum(attempts.map((a) => a.tokensIn)),
		tokensOut: sum(attempts.map((a) => a.tokensOut)),
		costEstimate: sum(attempts.map((a) => a.costEstimate)),
	};
}

/** Exported for direct testing — the "## Итог" block at the end of every ai:compare report. */
export function formatSummary(runs: FixtureRun[], balance: number): string {
	const total = runs.length;
	const finals = runs.map((r) => finalOutcome(r));
	const accepted = finals.filter((f) => f.kind === "accepted");
	const trimmed = finals.filter((f) => f.kind === "trimmed");
	const rejected = finals.filter((f): f is Extract<RunOutcome, { kind: "rejected" }> => f.kind === "rejected");
	const transport = finals.filter((f): f is Extract<RunOutcome, { kind: "transport" }> => f.kind === "transport");
	const forced = finals.filter((f): f is Extract<RunOutcome, { kind: "forced" }> => f.kind === "forced");
	const retried = runs.filter((r) => r.retryOutcome !== undefined);

	const byReason = new Map<string, number>();
	for (const f of rejected) {
		const label = VALIDATOR_ITEM_LABELS[f.reason];
		byReason.set(label, (byReason.get(label) ?? 0) + 1);
	}
	for (const f of transport) {
		const label = `transport: ${f.label}`;
		byReason.set(label, (byReason.get(label) ?? 0) + 1);
	}
	if (forced.length > 0) {
		byReason.set("forced (--chain-degrade)", forced.length);
	}

	const totals = runs.map(runTotals);
	const tokensInList = totals.map((t) => t.tokensIn).filter((t): t is number => t !== null);
	const tokensOutList = totals.map((t) => t.tokensOut).filter((t): t is number => t !== null);
	const avg = (nums: number[]) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null);
	const avgIn = avg(tokensInList);
	const avgOut = avg(tokensOutList);

	const costs = totals.map((t) => t.costEstimate).filter((c): c is number => c !== null);
	const totalCost = costs.length ? costs.reduce((a, b) => a + b, 0) : null;

	const lines = [
		"## Итог",
		"",
		`- Всего прогонов: ${total}`,
		`- Принято: ${accepted.length} (${total ? Math.round((accepted.length / total) * 100) : 0}%)`,
	];
	if (trimmed.length > 0) {
		lines.push(`- Починено вырезанием предложения: ${trimmed.length} (${total ? Math.round((trimmed.length / total) * 100) : 0}%)`);
	}
	lines.push(`- Отклонено/ошибок: ${total - accepted.length - trimmed.length}`);
	if (retried.length > 0) {
		const acceptedByRetry = retried.filter((r) => r.retryOutcome?.kind === "accepted").length;
		lines.push(`- Из них достигнуто ретраем: ${retried.length} (успешно после ретрая: ${acceptedByRetry})`);
	}
	if (byReason.size > 0) {
		lines.push("- Разбивка по причинам (по финальному исходу):");
		for (const [label, count] of byReason) lines.push(`  - ${label}: ${count}`);
	}
	lines.push(
		avgIn !== null && avgOut !== null
			? `- Средние токены на прогон (обе попытки суммарно, если был ретрай): in=${avgIn.toFixed(0)} out=${avgOut.toFixed(0)}`
			: "- Средние токены: н/д (usage не был получен ни разу)",
	);

	if (totalCost !== null) {
		lines.push(`- Суммарная стоимость (все попытки, включая ретраи): ${totalCost.toFixed(4)} кредитов (оценка по цене модели, не счёт от прокси)`);
		lines.push(`- Остаток от баланса ${balance}: ${(balance - totalCost).toFixed(4)} кредитов (оценка, не запрос к прокси)`);
	} else {
		lines.push("- Суммарная стоимость: не посчитана — цена для этой модели не задана в .env");
		lines.push(`- Остаток от баланса ${balance}: н/д (стоимость не посчитана)`);
	}
	return lines.join("\n");
}

export async function runCompare(opts: CompareOptions): Promise<void> {
	const allRuns: FixtureRun[] = [];
	const sections: string[] = [];

	// Computed once — system is static (buildSystemPrompt() takes no
	// arguments), so checking it per-fixture would just repeat the same
	// number ten times. If it's anomalously large, the per-fixture user-JSON
	// dump/section-3.1 check is skipped everywhere: a bloated system prompt is the
	// more urgent, systemic problem (it repeats on every single request),
	// and ten JSON dumps wouldn't tell the reader anything a bloated system
	// prompt doesn't already explain by itself.
	const system = buildSystemPrompt();
	const systemInNorm = system.length <= SYSTEM_PROMPT_NORM_MAX_CHARS;

	for (const fixtureName of opts.fixtureNames) {
		const { snapshot, facts } = loadSnapshotAndFacts(fixtureName, opts.stateHistory);
		const aiHistory = stateHistoryToAiHistory(opts.stateHistory, facts.dateKey);
		const payload = buildAiPayload(facts, aiHistory);
		const user = buildUserPrompt(payload);
		const template = buildParagraphs(facts);

		sections.push(formatFixtureHeader(fixtureName, facts, payload, template, user, systemInNorm, snapshot));

		for (let run = 1; run <= opts.runsPerFixture; run++) {
			process.stdout.write(`[ai:compare] ${fixtureName} run ${run}/${opts.runsPerFixture}... `);
			const { outcome, retryOutcome } = await runOneWithOptionalRetry(
				opts.client,
				opts.modelId,
				system,
				user,
				opts.timeoutMs,
				payload,
				opts.priceInPerMillion,
				opts.priceOutPerMillion,
				facts,
				opts.retry,
			);
			console.log(retryOutcome ? `${outcomeLabel(outcome)} -> retry: ${outcomeLabel(retryOutcome)}` : outcomeLabel(outcome));
			const fr: FixtureRun = { fixtureName, run, outcome, retryOutcome };
			allRuns.push(fr);
			sections.push(formatRunSection(fr, opts.runsPerFixture, opts.priceInPerMillion, opts.priceOutPerMillion));
		}
	}

	const header = [
		`# ai:compare — ${opts.modelId}`,
		"",
		`- Дата запуска: ${opts.startedAt.toISOString()}`,
		`- PROMPT_VERSION: ${opts.promptVersion}`,
		`- Хост шлюза: ${opts.client.providerHost}`,
		`- Фикстур: ${opts.fixtureNames.length}, прогонов на фикстуру: ${opts.runsPerFixture}, всего прогонов: ${opts.fixtureNames.length * opts.runsPerFixture}`,
		opts.retry
			? "- Фолбэк отключён (одна модель за прогон). --retry включён: на содержательный отказ делается ровно одна повторная попытка тем же путём, что generate.ts (buildRetryObservationPrompt, тот же лимит) — показана отдельной строкой в каждом прогоне, итог по прогону считается по финальному исходу."
			: "- Ретраи и фолбэк отключены — каждый прогон это ровно одна попытка одной моделью, без ретрая на содержательный отказ.",
		"- Стоимость везде в кредитах прокси (1 кредит = 50 000 токенов), не в $ — см. AI_PRICE_IN/AI_PRICE_OUT в .env.",
		`- Длина system-сообщения: ${system.length} символов (норма: до ${SYSTEM_PROMPT_NORM_MAX_CHARS}) — ${systemInNorm ? "✅ в норме" : "⚠️ аномально большой"}`,
		...(systemInNorm
			? []
			: ["  Дамп user-JSON и проверка п.3.1 пропущены для всех фикстур — сначала разберитесь с системным промптом, раздутый промпт бьёт по каждому запросу, а не по одной фикстуре."]),
	].join("\n");

	const report = [header, ...sections, formatSummary(allRuns, opts.balance)].join("\n\n");

	mkdirSync(path.dirname(opts.outFile), { recursive: true });
	writeFileSync(opts.outFile, report);
	console.log(`[ai:compare] wrote ${opts.outFile}`);
}

// --- --chain=N: anti-repeat mode. Same fixture, N runs in a row, each run's
// own output feeding into the next run's history — exactly the day-over-day
// situation the anti-repeat prompt rule is supposed to handle, instead of
// N independent samples of the same single day (what --runs=N gives). No
// validator change: repeated phrasing is a style problem, not a factual one,
// so this only ever surfaces it for a human to read, never rejects it. ---

export type ChainOptions = {
	client: AiClient;
	modelId: string;
	priceInPerMillion: number | null;
	priceOutPerMillion: number | null;
	fixtureNames: string[];
	chainLength: number;
	timeoutMs: number;
	promptVersion: number;
	balance: number;
	outFile: string;
	/** Same instant the caller used to build outFile's HHMM — the header's "Дата запуска" line must read the exact same time, not a fresh `new Date()` at write time. */
	startedAt: Date;
	/** --chain-degrade: 1-based step numbers to force onto the template path with zero model calls, instead of waiting for a natural rejection/timeout. */
	forcedDegradeSteps: number[];
	/** --retry: on a content-level rejection, one more attempt the same way generate.ts's own retry does — see FixtureRun.retryOutcome. */
	retry: boolean;
};

export type ChainStep = { run: number; dateLabel: string; picture: string; observation: string; source: "ai" | "ai_trimmed" | "template" };

/** First few words of a paragraph — enough to spot a repeated opening by eye, not a full sentence. */
function leadIn(text: string, wordCount = 6): string {
	const words = text.trim().split(/\s+/);
	const lead = words.slice(0, wordCount).join(" ");
	return words.length > wordCount ? `${lead}…` : lead;
}

/** Grows by one row each chain step — printed after every run but the first, so all prior lead-ins stay visible without scrolling back. Every step has real text now (template or AI — see runChainForFixture), so the [шаблон] tag is what shows where a step's context actually came from. */
function formatLeadInTable(steps: ChainStep[]): string {
	const lines = ["**Завязки по цепочке (picture / observation) — для сравнения глазами, без автоматического вердикта:**"];
	for (const step of steps) {
		const sourceTag = step.source === "template" ? " [шаблон]" : step.source === "ai_trimmed" ? " [починено]" : "";
		lines.push(`- прогон ${step.run} (${step.dateLabel})${sourceTag}: «${leadIn(step.picture)}» / «${leadIn(step.observation)}»`);
	}
	return lines.join("\n");
}

// --- repetition detection: purely informational, appended after the
// lead-in table for every step but the first. No verdict, no effect on
// RunOutcome/formatSummary/whether a step is accepted — the validator is
// not extended for this (per instruction: repeated phrasing is a style
// question, not a factual one). Just a list for a human to read. ---

// Heuristic, not exhaustive: generic Russian function words (prepositions,
// conjunctions, pronouns, common auxiliary verb forms) plus this project's
// own core domain vocabulary — words expected to recur every single day
// regardless of phrasing quality, because the post is always about the same
// subject (рой, монеты, биток, рынок, лидер/антигерой, red/green/mixed day
// framing). Excluding these keeps the "reused rare words" list meaningful —
// without them every step would trivially "reuse" рой/монет/биток forever.
const STOP_WORDS = new Set([
	// prepositions
	"в",
	"во",
	"на",
	"с",
	"со",
	"по",
	"за",
	"из",
	"от",
	"до",
	"для",
	"при",
	"без",
	"над",
	"под",
	"о",
	"об",
	"у",
	"через",
	"между",
	"среди",
	"к",
	"ко",
	// conjunctions / particles
	"и",
	"а",
	"но",
	"или",
	"что",
	"как",
	"чтобы",
	"если",
	"хотя",
	"пока",
	"же",
	"ли",
	"бы",
	"не",
	"ни",
	"да",
	"тоже",
	"также",
	// pronouns
	"он",
	"она",
	"оно",
	"они",
	"это",
	"тот",
	"эта",
	"этот",
	"эти",
	"свой",
	"своя",
	"своё",
	"свои",
	"весь",
	"вся",
	"всё",
	"все",
	"каждый",
	"каждая",
	"каждое",
	"который",
	"которая",
	"которое",
	"которые",
	"кто",
	"какой",
	"какая",
	"какое",
	"какие",
	// common verb forms
	"есть",
	"был",
	"была",
	"было",
	"были",
	"будет",
	"будут",
	"стал",
	"стала",
	"стало",
	"стали",
	"остаётся",
	"остаются",
	"является",
	// this project's own core domain vocabulary
	"рой",
	"монета",
	"монеты",
	"монет",
	"биток",
	"btc",
	"рынок",
	"рынке",
	"рынка",
	"день",
	"дня",
	"дней",
	"сутки",
	"подряд",
	"против",
	"течения",
	"лидер",
	"лидера",
	"лидеров",
	"герой",
	"антигерой",
	"зелёный",
	"зелёная",
	"зелёное",
	"зелёные",
	"красный",
	"красная",
	"красное",
	"красные",
	"растёт",
	"растут",
	"падает",
	"падают",
]);

function isNumericWord(word: string): boolean {
	return /^\d+$/.test(word);
}

/** Lowercased letter/digit runs — punctuation, dashes, quotes all become word boundaries. */
export function normalizeWords(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

/** Separator between pooled prior steps' word arrays — never equals a real extracted word, so a chain match can't accidentally span the boundary between two different prior days. */
const POOL_SEPARATOR = " ";

export function poolPriorWords(priorTexts: string[]): string[] {
	const pooled: string[] = [];
	for (const text of priorTexts) {
		if (pooled.length > 0) pooled.push(POOL_SEPARATOR);
		pooled.push(...normalizeWords(text));
	}
	return pooled;
}

/**
 * Verbatim word-chains of at least minLength words shared between `current`
 * and anywhere in the pooled `prior` corpus. Numeric tokens never extend or
 * start a match — --chain pins facts (the numbers) fixed for the whole
 * chain by design, so every step trivially "shares" its numbers with every
 * other step; that's an artifact of the simulation, not a real phrasing
 * repeat, and would drown out genuine matches. Matches are maximal and
 * non-overlapping in `current` (greedy left-to-right), not every possible
 * sub-window — a shared 6-word run is reported once, not as three
 * overlapping 4-word windows.
 */
export function findWordChainMatches(current: string[], prior: string[], minLength: number): { chains: string[][]; usedPositions: Set<number> } {
	const chains: string[][] = [];
	const usedPositions = new Set<number>();

	let i = 0;
	while (i < current.length) {
		if (usedPositions.has(i) || isNumericWord(current[i]!)) {
			i++;
			continue;
		}
		let bestLen = 0;
		for (let j = 0; j < prior.length; j++) {
			let len = 0;
			while (i + len < current.length && j + len < prior.length && prior[j + len] !== POOL_SEPARATOR && current[i + len] === prior[j + len] && !isNumericWord(current[i + len]!)) {
				len++;
			}
			if (len > bestLen) bestLen = len;
		}
		if (bestLen >= minLength) {
			chains.push(current.slice(i, i + bestLen));
			for (let p = i; p < i + bestLen; p++) usedPositions.add(p);
			i += bestLen;
		} else {
			i++;
		}
	}

	return { chains, usedPositions };
}

/** Words already covered by a reported chain match are excluded here — reporting "красный" separately when "рой сегодня явно красный" is already listed as a chain would just be noise. */
export function findReusedRareWords(current: string[], prior: string[], excludePositions: Set<number>): string[] {
	const priorSet = new Set(prior);
	const found = new Set<string>();
	current.forEach((word, i) => {
		if (excludePositions.has(i)) return;
		if (STOP_WORDS.has(word)) return;
		if (isNumericWord(word)) return;
		if (word.length <= 2) return;
		if (priorSet.has(word)) found.add(word);
	});
	return [...found];
}

/**
 * The current (last) step's text checked against every earlier step's text,
 * pooled together. Purely informational — see the section comment above.
 */
export function formatRepetitionSection(steps: ChainStep[]): string {
	const current = steps[steps.length - 1]!;
	const priors = steps.slice(0, -1);

	const currentWords = normalizeWords(`${current.picture} ${current.observation}`);
	const priorWords = poolPriorWords(priors.map((p) => `${p.picture} ${p.observation}`));

	const { chains, usedPositions } = findWordChainMatches(currentWords, priorWords, 4);
	const rareWords = findReusedRareWords(currentWords, priorWords, usedPositions);

	const lines = ["**Повторы относительно предыдущих шагов (только список, без вердикта и без влияния на исход):**"];
	if (chains.length === 0 && rareWords.length === 0) {
		lines.push("- Повторов не найдено.");
	} else {
		if (chains.length > 0) lines.push(`- Дословные цепочки (4+ слов): ${chains.map((c) => `«${c.join(" ")}»`).join(", ")}`);
		if (rareWords.length > 0) lines.push(`- Повторно использованные редкие слова: ${rareWords.join(", ")}`);
	}
	return lines.join("\n");
}

/** Builds the StateDay-shaped history entry + the two lines appended after a run's own section, shared by every path (natural rejection/transport, or --chain-degrade) that records a step as template. */
function formatDegradedTemplateBlock(template: PostParagraphs): string {
	return [
		"**Записано в историю как шаблон (source: template) — именно это увидит следующий шаг цепочки:**",
		"",
		"**Абзац 1 (picture, шаблон):**",
		`> ${template.picture}`,
		"",
		"**Абзац 2 (observation, шаблон):**",
		`> ${template.observation}`,
	].join("\n");
}

/**
 * red/green/total/swarmState/btc/winners/losers stay pinned to the fixture's
 * own snapshot numbers for every step — only the date advances, one day per
 * run, same market conditions repeating. streak/prevState do NOT stay
 * pinned: each step re-derives them from `chainHistory` via the real
 * computeFacts() (same function production calls), the same way a real day
 * over day would — swarmState matching the previous recorded day increments
 * streak, prevState is that previous day's swarmState. Getting this from a
 * one-off computeFacts({ days: [] }) call and reusing its streak/prevState
 * for every step (the pre-fix behavior) always gave streak=1/prevState=null
 * on every single step, contradicting production the moment a chain ran
 * past day 1. Noon Moscow time on todayKey — unambiguously that calendar
 * day regardless of DST (Moscow has had none since 2014), so
 * computeFacts's own moscowDateKey(ts) round-trips to exactly todayKey.
 */
export function computeChainStepFacts(snapshot: HotCoinsSnapshot, todayKey: string, chainHistory: StateHistory): Facts {
	return computeFacts({ ...snapshot, ts: `${todayKey}T12:00:00+03:00` }, chainHistory);
}

/**
 * A step that's rejected, fails in transport, or is force-degraded via
 * --chain-degrade is recorded exactly like a real degraded production day
 * is (see index.ts's state-write and stateHistoryToAiHistory()): template
 * text via buildParagraphs(facts), source: "template", still appended to
 * history — never a hole, so a degraded day never breaks the streak either
 * (the swarm was still the same swarm that day, template text or not). The
 * model reading tomorrow's history has no way to tell
 * that text apart from AI prose (stateHistoryToAiHistory() strips `source`
 * before it ever reaches the payload), so the chain has to carry that
 * forward too, not skip the day, to actually model production.
 */
async function runChainForFixture(
	fixtureName: string,
	chainLength: number,
	client: AiClient,
	modelId: string,
	timeoutMs: number,
	priceInPerMillion: number | null,
	priceOutPerMillion: number | null,
	forcedDegradeSteps: Set<number>,
	retry: boolean,
): Promise<{ sections: string[]; runs: FixtureRun[] }> {
	const { snapshot, facts: baseFacts } = loadSnapshotAndFacts(fixtureName, { days: [] });
	const system = buildSystemPrompt();

	let chainHistory: StateHistory = { days: [] };
	const steps: ChainStep[] = [];
	const runs: FixtureRun[] = [];
	const sections: string[] = [
		[
			`## ${fixtureName} — цепочка из ${chainLength}`,
			"",
			`- swarmState (зафиксировано по всей цепочке): ${baseFacts.swarmState}`,
			"- Факты (числа) одни и те же каждый шаг — меняется только дата, как при одинаковом рынке несколько дней подряд.",
			...(forcedDegradeSteps.size > 0
				? [`- Принудительная деградация (--chain-degrade) на шаге(ах): ${[...forcedDegradeSteps].sort((a, b) => a - b).join(", ")} — без запроса к модели.`]
				: []),
		].join("\n"),
	];

	function recordTemplateStep(k: number, facts: Facts, todayKey: string): PostParagraphs {
		const template = buildParagraphs(facts);
		chainHistory = appendDay(chainHistory, {
			date: todayKey,
			swarmState: facts.swarmState,
			btcChange: facts.btc?.change24h ?? null,
			postedAt: new Date().toISOString(),
			messageId: 0,
			picture: template.picture,
			observation: template.observation,
			source: "template",
		});
		steps.push({ run: k, dateLabel: facts.dateLabel, picture: template.picture, observation: template.observation, source: "template" });
		return template;
	}

	for (let k = 1; k <= chainLength; k++) {
		const todayKey = shiftDateKey(baseFacts.dateKey, k - 1);
		const facts: Facts = computeChainStepFacts(snapshot, todayKey, chainHistory);

		if (forcedDegradeSteps.has(k)) {
			process.stdout.write(`[ai:compare] ${fixtureName} chain ${k}/${chainLength}... `);
			console.log("forced template (--chain-degrade), no request sent");

			const template = recordTemplateStep(k, facts, todayKey);
			const fr: FixtureRun = { fixtureName, run: k, outcome: { kind: "forced", template } };
			runs.push(fr);

			const sectionParts = [formatRunSection(fr, chainLength, priceInPerMillion, priceOutPerMillion)];
			if (k > 1) {
				sectionParts.push(formatLeadInTable(steps));
				sectionParts.push(formatRepetitionSection(steps));
			}
			sections.push(sectionParts.join("\n\n"));
			continue;
		}

		const aiHistory = stateHistoryToAiHistory(chainHistory, todayKey);
		const payload = buildAiPayload(facts, aiHistory);
		const user = buildUserPrompt(payload);

		process.stdout.write(`[ai:compare] ${fixtureName} chain ${k}/${chainLength}... `);
		const { outcome, retryOutcome } = await runOneWithOptionalRetry(client, modelId, system, user, timeoutMs, payload, priceInPerMillion, priceOutPerMillion, facts, retry);
		console.log(retryOutcome ? `${outcomeLabel(outcome)} -> retry: ${outcomeLabel(retryOutcome)}` : outcomeLabel(outcome));

		const fr: FixtureRun = { fixtureName, run: k, outcome, retryOutcome };
		runs.push(fr);
		const sectionParts = [formatRunSection(fr, chainLength, priceInPerMillion, priceOutPerMillion)];

		const final = finalOutcome(fr);
		if (final.kind === "accepted" || final.kind === "trimmed") {
			const source = final.kind === "accepted" ? "ai" : "ai_trimmed";
			chainHistory = appendDay(chainHistory, {
				date: todayKey,
				swarmState: facts.swarmState,
				btcChange: facts.btc?.change24h ?? null,
				postedAt: new Date().toISOString(),
				messageId: 0,
				picture: final.picture,
				observation: final.observation,
				source,
			});
			steps.push({ run: k, dateLabel: facts.dateLabel, picture: final.picture, observation: final.observation, source });
		} else {
			const template = recordTemplateStep(k, facts, todayKey);
			sectionParts.push(formatDegradedTemplateBlock(template));
		}

		if (k > 1) {
			sectionParts.push(formatLeadInTable(steps));
			sectionParts.push(formatRepetitionSection(steps));
		}
		sections.push(sectionParts.join("\n\n"));
	}

	return { sections, runs };
}

export async function runChain(opts: ChainOptions): Promise<void> {
	const forcedSet = new Set(opts.forcedDegradeSteps);
	const allSections: string[] = [];
	const allRuns: FixtureRun[] = [];

	for (const fixtureName of opts.fixtureNames) {
		const { sections, runs } = await runChainForFixture(
			fixtureName,
			opts.chainLength,
			opts.client,
			opts.modelId,
			opts.timeoutMs,
			opts.priceInPerMillion,
			opts.priceOutPerMillion,
			forcedSet,
			opts.retry,
		);
		allSections.push(...sections);
		allRuns.push(...runs);
	}

	const header = [
		`# ai:compare --chain=${opts.chainLength} — ${opts.modelId}`,
		"",
		`- Дата запуска: ${opts.startedAt.toISOString()}`,
		`- PROMPT_VERSION: ${opts.promptVersion}`,
		`- Хост шлюза: ${opts.client.providerHost}`,
		`- Фикстур: ${opts.fixtureNames.length}, длина цепочки: ${opts.chainLength}, всего прогонов: ${opts.fixtureNames.length * opts.chainLength}`,
		"- Режим анти-повтора: вывод каждого прогона уходит в history следующего, тем же способом, что stateHistoryToAiHistory() строит его в бою; дата сдвигается на день вперёд за прогон, факты (числа) зафиксированы — та же фикстура каждый раз.",
		"- Деградация (отказ, transport-ошибка, или принудительно через --chain-degrade) не пропускает день — записывается шаблонный текст с source: \"template\", как и в бою, и он уходит в history следующего шага. Если включён --retry, деградация означает «отклонено и после ретрая» — успешный ретрай признаётся принятым и уходит в history как обычный ai-текст.",
		opts.retry
			? "- Фолбэк отключён (одна модель за прогон). --retry включён: на содержательный отказ делается ровно одна повторная попытка тем же путём, что generate.ts (buildRetryObservationPrompt, тот же лимит) — показана отдельной строкой в каждом прогоне, итог по прогону считается по финальному исходу."
			: "- Ретраи и фолбэк отключены, как и в обычном режиме — один запрос это одна попытка.",
		"- Стоимость везде в кредитах прокси (1 кредит = 50 000 токенов), не в $ — см. AI_PRICE_IN/AI_PRICE_OUT в .env.",
		"- Завязки первых предложений — материал для взгляда человека, не автоматический вердикт: валидатор на повтор формулировок не расширялся, это вопрос стиля, а не фактической ошибки.",
	].join("\n");

	const report = [header, ...allSections, formatSummary(allRuns, opts.balance)].join("\n\n");

	mkdirSync(path.dirname(opts.outFile), { recursive: true });
	writeFileSync(opts.outFile, report);
	console.log(`[ai:compare] wrote ${opts.outFile}`);
}

// --- CLI entry point ---

function readEnv() {
	return {
		baseUrl: process.env.AI_BASE_URL || "",
		apiKey: process.env.AI_API_KEY || "",
		proxyUrl: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",
		model: process.env.AI_MODEL || "",
		modelFallback: process.env.AI_MODEL_FALLBACK || "",
		timeoutMs: Number(process.env.AI_TIMEOUT_MS || 25000),
		promptVersion: Number(process.env.PROMPT_VERSION || 1),
		priceIn: process.env.AI_PRICE_IN ? Number(process.env.AI_PRICE_IN) : null,
		priceOut: process.env.AI_PRICE_OUT ? Number(process.env.AI_PRICE_OUT) : null,
		fallbackPriceIn: process.env.AI_FALLBACK_PRICE_IN ? Number(process.env.AI_FALLBACK_PRICE_IN) : null,
		fallbackPriceOut: process.env.AI_FALLBACK_PRICE_OUT ? Number(process.env.AI_FALLBACK_PRICE_OUT) : null,
		stateFile: path.resolve(process.env.STATE_FILE || "data/state.json"),
	};
}

type CliArgs = { fixtureNames: string[]; runs: number; chain: number | null; chainDegrade: number[]; model: string | null; balance: number; retry: boolean };

function normalizeFixtureName(name: string): string {
	const base = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
	return `${base}.json`;
}

function parseCliArgs(argv: string[]): CliArgs {
	let fixtureArg: string | null = null;
	let runs = 1;
	let runsExplicit = false;
	let chain: number | null = null;
	let chainDegrade: number[] = [];
	let model: string | null = null;
	let balance = 1000;
	let retry = false;

	for (const arg of argv) {
		if (arg === "--all") {
			fixtureArg = "--all";
		} else if (arg === "--retry") {
			retry = true;
		} else if (arg.startsWith("--runs=")) {
			runs = Number(arg.slice("--runs=".length));
			runsExplicit = true;
		} else if (arg.startsWith("--chain=")) {
			chain = Number(arg.slice("--chain=".length));
		} else if (arg.startsWith("--chain-degrade=")) {
			chainDegrade = arg
				.slice("--chain-degrade=".length)
				.split(",")
				.map((s) => Number(s.trim()));
		} else if (arg.startsWith("--model=")) {
			model = arg.slice("--model=".length);
		} else if (arg.startsWith("--balance=")) {
			balance = Number(arg.slice("--balance=".length));
		} else if (!arg.startsWith("--")) {
			fixtureArg = arg;
		} else {
			throw new Error(`unrecognized flag: ${arg}`);
		}
	}

	if (!fixtureArg) {
		throw new Error("usage: npm run ai:compare -- <fixture-name>|--all [--runs=N] [--chain=N] [--chain-degrade=K[,K...]] [--retry] [--model=<id>] [--balance=N]");
	}
	if (chain !== null && runsExplicit) {
		throw new Error("--chain and --runs are mutually exclusive — --chain implies one sequential run per step, not N independent samples");
	}
	if (!Number.isInteger(runs) || runs < 1) {
		throw new Error(`--runs must be a positive integer, got: ${runs}`);
	}
	if (chain !== null && (!Number.isInteger(chain) || chain < 1)) {
		throw new Error(`--chain must be a positive integer, got: ${chain}`);
	}
	if (chainDegrade.length > 0 && chain === null) {
		throw new Error("--chain-degrade requires --chain=N — it names which step(s) of the chain to force onto the template path");
	}
	if (chainDegrade.some((n) => !Number.isInteger(n) || n < 1)) {
		throw new Error(`--chain-degrade must be a comma-separated list of positive integers, got: ${chainDegrade.join(",")}`);
	}
	if (chain !== null && chainDegrade.some((n) => n > chain)) {
		throw new Error(`--chain-degrade step ${Math.max(...chainDegrade)} is beyond --chain=${chain}`);
	}
	if (!Number.isFinite(balance)) {
		throw new Error(`--balance must be a number, got: ${balance}`);
	}

	const fixtureNames = fixtureArg === "--all" ? ALL_FIXTURE_NAMES : [normalizeFixtureName(fixtureArg)];
	return { fixtureNames, runs, chain, chainDegrade, model, balance, retry };
}

function sanitizeForFilename(s: string): string {
	return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/**
 * reports/compare-<YYYY-MM-DD>-<HHMM>-<model>-<fixture|all>[-chainN].md —
 * HHMM is sliced from the same `startedAt` instant the caller also passes as
 * CompareOptions/ChainOptions.startedAt, so the filename and the report
 * header's own "Дата запуска" line always read the same time, never two
 * independent `new Date()` calls a few ms apart.
 */
export function buildReportBaseName(startedAt: Date, modelId: string, fixtureLabel: string, chainLength: number | null): string {
	const iso = startedAt.toISOString();
	const datePart = iso.slice(0, 10);
	const timePart = iso.slice(11, 16).replace(":", "");
	const chainSuffix = chainLength !== null ? `-chain${chainLength}` : "";
	return `compare-${datePart}-${timePart}-${sanitizeForFilename(modelId)}-${sanitizeForFilename(fixtureLabel)}${chainSuffix}.md`;
}

/**
 * Never overwrites an existing report — a paid run's own record is
 * irreplaceable (reports/ has no way to regenerate one without spending
 * credits again). If `dir/baseName` is already taken, tries `-2`, `-3`, ...
 * before the extension until a free path turns up. Pure filesystem check,
 * no write — the caller must resolve this (and thus discover any name
 * collision) before making the first network request, so a run can never
 * get all the way to being billed and then lose its own report to another
 * file of the same name.
 */
export function resolveUniqueReportPath(dir: string, baseName: string): string {
	const ext = path.extname(baseName);
	const stem = baseName.slice(0, -ext.length);
	let candidate = path.join(dir, baseName);
	for (let n = 2; existsSync(candidate); n++) {
		candidate = path.join(dir, `${stem}-${n}${ext}`);
	}
	return candidate;
}

async function main() {
	const args = parseCliArgs(process.argv.slice(2));
	const env = readEnv();

	if (!env.baseUrl || !env.apiKey) {
		console.error("[ai:compare] AI_BASE_URL and AI_API_KEY must both be set in .env.");
		process.exitCode = 1;
		return;
	}

	const modelId = args.model || env.model;
	if (!modelId) {
		console.error("[ai:compare] no model — set AI_MODEL in .env or pass --model=<id>.");
		process.exitCode = 1;
		return;
	}

	// Priced like production prices a fallback answer: by the model that
	// actually answers this run, not unconditionally by the primary's rate.
	const isFallbackModel = env.modelFallback !== "" && modelId === env.modelFallback;
	const priceInPerMillion = isFallbackModel ? env.fallbackPriceIn : env.priceIn;
	const priceOutPerMillion = isFallbackModel ? env.fallbackPriceOut : env.priceOut;

	const client = createAiClient({ baseUrl: env.baseUrl, apiKey: env.apiKey, proxyUrl: env.proxyUrl || undefined });
	const stateHistory = readState(env.stateFile);

	// reports/ is tracked by git (unlike out/) — a report from a real, paid
	// run has no other history or way back once out/ gets cleaned up, and
	// out/'s own cleanup rule (age-based file deletion, never removing the
	// directory) doesn't distinguish a report worth keeping from a stale
	// *.ai.json debug dump. Name + collision check happen here, before any
	// network call below — a run can never end up billed with nowhere of its
	// own to land, and an existing report is never silently overwritten by a
	// second run the same minute.
	const startedAt = new Date();
	const fixtureLabel = args.fixtureNames.length > 1 ? "all" : args.fixtureNames[0]!.replace(/\.json$/, "");
	const outFile = resolveUniqueReportPath(path.join(REPO_ROOT, "reports"), buildReportBaseName(startedAt, modelId, fixtureLabel, args.chain));

	if (args.chain !== null) {
		await runChain({
			client,
			modelId,
			priceInPerMillion,
			priceOutPerMillion,
			fixtureNames: args.fixtureNames,
			chainLength: args.chain,
			timeoutMs: env.timeoutMs,
			promptVersion: env.promptVersion,
			balance: args.balance,
			outFile,
			startedAt,
			forcedDegradeSteps: args.chainDegrade,
			retry: args.retry,
		});
		return;
	}

	await runCompare({
		client,
		modelId,
		priceInPerMillion,
		priceOutPerMillion,
		fixtureNames: args.fixtureNames,
		runsPerFixture: args.runs,
		timeoutMs: env.timeoutMs,
		promptVersion: env.promptVersion,
		stateHistory,
		balance: args.balance,
		outFile,
		startedAt,
		retry: args.retry,
	});
}

// Guarded so importing this module for runCompare()/its types (e.g. a
// throwaway script demoing the report format against a mocked AiClient
// instead of a real one) doesn't also run the CLI against that script's own
// unrelated argv.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
	main().catch((err: unknown) => {
		console.error("[ai:compare] failed:", err instanceof Error ? err.message : err);
		process.exitCode = 1;
	});
}
