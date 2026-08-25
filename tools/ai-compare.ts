// v2 step 7: local manual verification tool. Makes REAL requests to the model (unless a
// mocked AiClient is injected via runCompare() directly, e.g. for previewing
// the report format without spending credits) — this file is never invoked
// by index.ts or by any test, and lives outside tsconfig's "include" (src,
// tests only) so it never becomes part of the production build or its
// typecheck. Run manually: `npm run ai:compare -- <fixture>|--all [--runs=N]
// [--chain=N] [--chain-degrade=K[,K...]] [--model=<id>] [--balance=N]`.
// --chain and --runs are mutually exclusive: --runs=N samples the same
// single day N independent times, --chain=N runs N sequential days where
// each day's own output feeds the next day's history — see runChain()
// below. --chain-degrade=K forces step K onto the template path with zero
// model calls, for testing "day after a degraded day" on demand instead of
// waiting for a real rejection/timeout.
//
// Retries and fallback are turned off on purpose: one request is one attempt,
// full stop. buildParagraphsAI()'s retry/fallback loop exists to *hide* a
// content-level failure from the published post — exactly what must NOT
// happen here, since the whole point of this tool is to see the raw
// first-attempt failure rate before anything smooths it over.
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
import { buildSystemPrompt, buildUserPrompt } from "../src/ai/prompt.js";
import { computeCost } from "../src/ai/usage.js";
import { validateAiObservation, type ObservationValidationFailureReason } from "../src/ai/validator.js";
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

const HISTORY_ALLOWED_KEYS = new Set(["dateLabel", "swarmState", "observation"]);

/**
 * Empirical calibration, not documented by the proxy: three consecutive real
 * requests (25.08, including one with a changed system prompt) showed
 * prompt_tokens exceeding the proxy's own billed input by exactly this many
 * tokens every time — 5620−3081, 5617−3078, 5861−3322, all =2539. Proxy-side
 * overhead unrelated to our text or to caching (it didn't move when the
 * system prompt did). Undocumented and may change silently, so it lives in
 * exactly this one place — report display only. It must never reach
 * usage.jsonl/ai.json/state.json: those record prompt_tokens exactly as the
 * API returned it, and an append-only log can't be corrected retroactively —
 * mixing calibrated and raw numbers into it with no marker of where the
 * line is would make the whole log unusable.
 */
const PROXY_INPUT_TOKEN_OVERHEAD = 2539;

/**
 * validateAiObservation's own checks (PROMPT_VERSION 7's active path — items
 * 1/7/9/10, the numbers whitelist/digit day-count/derived-number words/
 * word-form streak mismatch, are validateAiParagraphs-only now, not called
 * here at all): parse -> non-empty/not cut off -> length -> forbidden
 * content -> direction -> any digit -> any day-count word -> language.
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
};

type RunOutcome =
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
	| { kind: "transport"; label: string; errorMessage: string | null; durationMs: number }
	// --chain-degrade only: this step deliberately skipped the model entirely
	// (no client.generate() call at all) to force a degraded day on demand,
	// instead of waiting for a real rejection/timeout to happen naturally.
	| { kind: "forced"; template: PostParagraphs };

type FixtureRun = { fixtureName: string; run: number; outcome: RunOutcome };

/** What a real model call can produce — "forced" is never one of runOne()'s own results, it's only ever constructed directly by --chain-degrade's own branch, which skips runOne() entirely. */
type RunOneOutcome = Extract<RunOutcome, { kind: "accepted" } | { kind: "rejected" } | { kind: "transport" }>;

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
};

function loadSnapshotAndFacts(fixtureName: string, stateHistory: StateHistory): { snapshot: HotCoinsSnapshot; facts: Facts } {
	const snapshot = loadSnapshotFromFile(path.join(FIXTURES_DIR, fixtureName));
	return { snapshot, facts: computeFacts(snapshot, stateHistory) };
}

type Section31Check = {
	rawSnapshotFieldsLeaked: string[];
	unrelatedTickersLeaked: string[];
	historyEntriesWithExtraKeys: string[];
};

/**
 * Section 3.1's own three concerns, checked against the exact string sent to
 * the model — not a re-derivation, a direct inspection of buildUserPrompt()'s
 * output. Same technique tests/ai-payload.test.ts already uses for the first
 * two (no shared src/ function to reuse — that test doesn't call one either,
 * it's a plain substring/field check both times).
 */
function checkSection31(userJson: string, payload: AiPayload, snapshot: HotCoinsSnapshot): Section31Check {
	const rawSnapshotFieldsLeaked = ["mainSwarm", "edgePins", "marketCap"].filter((field) => userJson.includes(field));

	const winnerTicker = payload.today.topGainer?.ticker;
	const loserTicker = payload.today.topLoser?.ticker;
	const allCoins = [...snapshot.mainSwarm, ...snapshot.edgePins];
	const unrelatedTickersLeaked = [...new Set(allCoins.filter((c) => c.ticker !== winnerTicker && c.ticker !== loserTicker).map((c) => c.ticker))].filter((ticker) => userJson.includes(ticker));

	const historyEntriesWithExtraKeys = payload.history
		.map((entry, i) => ({ i, extra: Object.keys(entry).filter((k) => !HISTORY_ALLOWED_KEYS.has(k)) }))
		.filter((e) => e.extra.length > 0)
		.map((e) => `history[${e.i}]: ${e.extra.join(", ")}`);

	return { rawSnapshotFieldsLeaked, unrelatedTickersLeaked, historyEntriesWithExtraKeys };
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

function formatCostLine(costEstimate: number | null): string {
	return costEstimate !== null ? `- Стоимость (оценка): ${costEstimate.toFixed(4)} кредитов` : `- Стоимость: не посчитана (цена для этой модели не задана в .env)`;
}

/**
 * Same formula computeCost() already uses — just called with promptTokens
 * reduced by PROXY_INPUT_TOKEN_OVERHEAD first. Returns null (no line) under
 * the exact same conditions computeCost() itself would: no usage, or either
 * price knob unset for this model.
 */
function formatCalibratedCostLine(tokensIn: number | null, tokensOut: number | null, priceInPerMillion: number | null, priceOutPerMillion: number | null): string | null {
	if (tokensIn === null || tokensOut === null) return null;
	const calibratedTokensIn = Math.max(0, tokensIn - PROXY_INPUT_TOKEN_OVERHEAD);
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

/**
 * Shown once per fixture, above its AI runs. Two things, both free (no
 * request): the template half of the pairwise comparison (section 9's actual
 * ask: template vs AI, not AI in isolation — buildParagraphs() is a pure
 * local call), and the user message's own length plus, when the system
 * prompt is within norm, its full JSON body and a section-3.1 check (no raw
 * snapshot, no unrelated coin tickers, no extra fields on history entries).
 */
function formatFixtureHeader(fixtureName: string, facts: Facts, payload: AiPayload, template: PostParagraphs, userPrompt: string, systemInNorm: boolean, snapshot: HotCoinsSnapshot): string {
	const lines = [
		`## ${fixtureName}`,
		"",
		`- swarmState: ${facts.swarmState}`,
		`- streak: ${facts.streak}`,
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
			"### user-JSON (сверка с п.3.1: сырой снапшот, полный список монет, лишние поля истории)",
			"",
			"```json",
			JSON.stringify(payload, null, 2),
			"```",
			"",
			"Проверка п.3.1:",
			formatSection31Line("сырой снапшот отсутствует (mainSwarm/edgePins/marketCap)", check.rawSnapshotFieldsLeaked),
			formatSection31Line("нет тикеров посторонних монет", check.unrelatedTickersLeaked),
			formatSection31Line("history без лишних полей", check.historyEntriesWithExtraKeys),
		);
	}

	return lines.join("\n");
}

function formatRunSection(fr: FixtureRun, totalRuns: number, priceInPerMillion: number | null, priceOutPerMillion: number | null): string {
	const { run, outcome } = fr;
	const header = `### ИИ — прогон ${run}/${totalRuns}`;

	if (outcome.kind === "transport") {
		return [header, "", `- Вердикт: ⚠️ transport — ${outcome.label}${outcome.errorMessage ? ` (${outcome.errorMessage})` : ""}`, `- Время ответа: ${outcome.durationMs} ms`, `- Токены: н/д`].join("\n");
	}

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

	const tokensLine = `- Токены: in=${outcome.tokensIn ?? "н/д"} out=${outcome.tokensOut ?? "н/д"}`;
	const timeLine = `- Время ответа: ${outcome.durationMs} ms`;
	const costLine = formatCostLine(outcome.costEstimate);
	const calibratedCostLine = formatCalibratedCostLine(outcome.tokensIn, outcome.tokensOut, priceInPerMillion, priceOutPerMillion);

	if (outcome.kind === "accepted") {
		return [
			header,
			"",
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

	return [
		header,
		"",
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

function formatSummary(runs: FixtureRun[], balance: number): string {
	const total = runs.length;
	const accepted = runs.filter((r) => r.outcome.kind === "accepted");
	const rejected = runs.filter((r): r is FixtureRun & { outcome: Extract<RunOutcome, { kind: "rejected" }> } => r.outcome.kind === "rejected");
	const transport = runs.filter((r): r is FixtureRun & { outcome: Extract<RunOutcome, { kind: "transport" }> } => r.outcome.kind === "transport");
	const forced = runs.filter((r): r is FixtureRun & { outcome: Extract<RunOutcome, { kind: "forced" }> } => r.outcome.kind === "forced");

	const byReason = new Map<string, number>();
	for (const r of rejected) {
		const label = VALIDATOR_ITEM_LABELS[r.outcome.reason];
		byReason.set(label, (byReason.get(label) ?? 0) + 1);
	}
	for (const r of transport) {
		const label = `transport: ${r.outcome.label}`;
		byReason.set(label, (byReason.get(label) ?? 0) + 1);
	}
	if (forced.length > 0) {
		byReason.set("forced (--chain-degrade)", forced.length);
	}

	const withTokens = runs.filter((r): r is FixtureRun & { outcome: Extract<RunOutcome, { kind: "accepted" | "rejected" }> } => r.outcome.kind === "accepted" || r.outcome.kind === "rejected");
	const tokensInList = withTokens.map((r) => r.outcome.tokensIn).filter((t): t is number => t !== null);
	const tokensOutList = withTokens.map((r) => r.outcome.tokensOut).filter((t): t is number => t !== null);
	const avg = (nums: number[]) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null);
	const avgIn = avg(tokensInList);
	const avgOut = avg(tokensOutList);

	const costs = withTokens.map((r) => r.outcome.costEstimate).filter((c): c is number => c !== null);
	const totalCost = costs.length ? costs.reduce((a, b) => a + b, 0) : null;

	const lines = [
		"## Итог",
		"",
		`- Всего прогонов: ${total}`,
		`- Принято: ${accepted.length} (${total ? Math.round((accepted.length / total) * 100) : 0}%)`,
		`- Отклонено/ошибок: ${total - accepted.length}`,
	];
	if (byReason.size > 0) {
		lines.push("- Разбивка по причинам:");
		for (const [label, count] of byReason) lines.push(`  - ${label}: ${count}`);
	}
	lines.push(avgIn !== null && avgOut !== null ? `- Средние токены: in=${avgIn.toFixed(0)} out=${avgOut.toFixed(0)}` : "- Средние токены: н/д (usage не был получен ни разу)");

	if (totalCost !== null) {
		lines.push(`- Суммарная стоимость за прогон: ${totalCost.toFixed(4)} кредитов (оценка по цене модели, не счёт от прокси)`);
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
			const outcome = await runOne(opts.client, opts.modelId, system, user, opts.timeoutMs, payload, opts.priceInPerMillion, opts.priceOutPerMillion, facts);
			console.log(outcome.kind === "accepted" ? "ok" : outcome.kind === "rejected" ? `rejected (${outcome.reason})` : `transport (${outcome.label})`);
			const fr: FixtureRun = { fixtureName, run, outcome };
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
		"- Ретраи и фолбэк отключены — каждый прогон это ровно одна попытка одной моделью, без ретрая на содержательный отказ.",
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
};

export type ChainStep = { run: number; dateLabel: string; picture: string; observation: string; source: "ai" | "template" };

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
		const sourceTag = step.source === "template" ? " [шаблон]" : "";
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
		const outcome = await runOne(client, modelId, system, user, timeoutMs, payload, priceInPerMillion, priceOutPerMillion, facts);
		console.log(outcome.kind === "accepted" ? "ok" : outcome.kind === "rejected" ? `rejected (${outcome.reason})` : `transport (${outcome.label})`);

		const fr: FixtureRun = { fixtureName, run: k, outcome };
		runs.push(fr);
		const sectionParts = [formatRunSection(fr, chainLength, priceInPerMillion, priceOutPerMillion)];

		if (outcome.kind === "accepted") {
			chainHistory = appendDay(chainHistory, {
				date: todayKey,
				swarmState: facts.swarmState,
				btcChange: facts.btc?.change24h ?? null,
				postedAt: new Date().toISOString(),
				messageId: 0,
				picture: outcome.picture,
				observation: outcome.observation,
				source: "ai",
			});
			steps.push({ run: k, dateLabel: facts.dateLabel, picture: outcome.picture, observation: outcome.observation, source: "ai" });
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
		"- Деградация (отказ, transport-ошибка, или принудительно через --chain-degrade) не пропускает день — записывается шаблонный текст с source: \"template\", как и в бою, и он уходит в history следующего шага.",
		"- Ретраи и фолбэк отключены, как и в обычном режиме — один запрос это одна попытка.",
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

type CliArgs = { fixtureNames: string[]; runs: number; chain: number | null; chainDegrade: number[]; model: string | null; balance: number };

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

	for (const arg of argv) {
		if (arg === "--all") {
			fixtureArg = "--all";
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
		throw new Error("usage: npm run ai:compare -- <fixture-name>|--all [--runs=N] [--chain=N] [--chain-degrade=K[,K...]] [--model=<id>] [--balance=N]");
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
	return { fixtureNames, runs, chain, chainDegrade, model, balance };
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
