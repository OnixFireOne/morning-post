// v2 step 7: local manual verification tool. Makes REAL requests to the model (unless a
// mocked AiClient is injected via runCompare() directly, e.g. for previewing
// the report format without spending credits) — this file is never invoked
// by index.ts or by any test, and lives outside tsconfig's "include" (src,
// tests only) so it never becomes part of the production build or its
// typecheck. Run manually: `npm run ai:compare -- <fixture>|--all [--runs=N]
// [--model=<id>] [--balance=N]`.
//
// Retries and fallback are turned off on purpose: one request is one attempt,
// full stop. buildParagraphsAI()'s retry/fallback loop exists to *hide* a
// content-level failure from the published post — exactly what must NOT
// happen here, since the whole point of this tool is to see the raw
// first-attempt failure rate before anything smooths it over.
//
// No prod logic is reimplemented: buildAiPayload, buildSystemPrompt/
// buildUserPrompt, validateAiParagraphs, computeCost, stateHistoryToAiHistory
// and buildParagraphs (the template fallback, shown alongside each AI run for
// a pairwise read — section 9's actual ask) are the exact functions the
// production path calls, imported as-is. This file only adds argument
// parsing, one bare client.generate() call per run (skipping generate.ts's
// loop), and markdown formatting.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAiClient, type AiClient, type AiUsage } from "../src/ai/client.js";
import { buildAiPayload, stateHistoryToAiHistory, type AiPayload } from "../src/ai/payload.js";
import { buildSystemPrompt, buildUserPrompt } from "../src/ai/prompt.js";
import { computeCost } from "../src/ai/usage.js";
import { validateAiParagraphs, type ValidationFailureReason } from "../src/ai/validator.js";
import { computeFacts, type Facts, type StateHistory } from "../src/facts.js";
import { buildParagraphs, type PostParagraphs } from "../src/render.js";
import { loadSnapshotFromFile } from "../src/snapshot.js";
import { readState } from "../src/state.js";
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

const HISTORY_ALLOWED_KEYS = new Set(["dateLabel", "swarmState", "picture", "observation"]);

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

/** Section 5's six checks plus item 7 (streak digit) and item 9 (derived numbers in words, both added after 24.08 — see validator.ts's own comments) and the pre-check for invalid JSON. */
const VALIDATOR_ITEM_LABELS: Record<ValidationFailureReason, string> = {
	invalid_json: "невалидный JSON (до проверок раздела 5)",
	"validator:numbers": "п.1 числа",
	"validator:length": "п.2 длина",
	"validator:forbidden_pattern": "п.3 запрещённые паттерны",
	"validator:direction": "п.4 direction",
	"validator:empty_or_cutoff": "п.5 пустой/оборванный абзац",
	"validator:streak_digit": "п.7 цифра в счёте дней",
	"validator:language": "п.6 язык",
	"validator:derived_numbers": "п.9 кратности/доли словами",
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
			reason: ValidationFailureReason;
			detail: string;
			rawResponse: string;
			tokensIn: number | null;
			tokensOut: number | null;
			durationMs: number;
			costEstimate: number | null;
			rawUsage: unknown;
	  }
	| { kind: "transport"; label: string; errorMessage: string | null; durationMs: number };

type FixtureRun = { fixtureName: string; run: number; outcome: RunOutcome };

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
): Promise<RunOutcome> {
	const result = await client.generate({ model: modelId, system, user, timeoutMs });

	if (!result.ok) {
		const label = result.errorKind === "timeout" ? "таймаут" : result.errorKind === "http_error" ? `HTTP ${result.httpStatus}` : "сетевая ошибка";
		return { kind: "transport", label, errorMessage: result.errorMessage, durationMs: result.durationMs };
	}

	const rawText = result.content ?? "";
	const validation = validateAiParagraphs(rawText, payload);
	const costEstimate = computeCost(result.usage, priceInPerMillion, priceOutPerMillion);
	const tokensIn = result.usage?.promptTokens ?? null;
	const tokensOut = result.usage?.completionTokens ?? null;

	if (validation.ok) {
		return {
			kind: "accepted",
			picture: validation.paragraphs.picture,
			observation: validation.paragraphs.observation,
			direction: validation.paragraphs.direction,
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

	const byReason = new Map<string, number>();
	for (const r of rejected) {
		const label = VALIDATOR_ITEM_LABELS[r.outcome.reason];
		byReason.set(label, (byReason.get(label) ?? 0) + 1);
	}
	for (const r of transport) {
		const label = `transport: ${r.outcome.label}`;
		byReason.set(label, (byReason.get(label) ?? 0) + 1);
	}

	const withTokens = runs.filter((r): r is FixtureRun & { outcome: Extract<RunOutcome, { kind: "accepted" | "rejected" }> } => r.outcome.kind !== "transport");
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
			const outcome = await runOne(opts.client, opts.modelId, system, user, opts.timeoutMs, payload, opts.priceInPerMillion, opts.priceOutPerMillion);
			console.log(outcome.kind === "accepted" ? "ok" : outcome.kind === "rejected" ? `rejected (${outcome.reason})` : `transport (${outcome.label})`);
			const fr: FixtureRun = { fixtureName, run, outcome };
			allRuns.push(fr);
			sections.push(formatRunSection(fr, opts.runsPerFixture, opts.priceInPerMillion, opts.priceOutPerMillion));
		}
	}

	const header = [
		`# ai:compare — ${opts.modelId}`,
		"",
		`- Дата запуска: ${new Date().toISOString()}`,
		`- PROMPT_VERSION: ${opts.promptVersion}`,
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

type CliArgs = { fixtureNames: string[]; runs: number; model: string | null; balance: number };

function normalizeFixtureName(name: string): string {
	const base = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
	return `${base}.json`;
}

function parseCliArgs(argv: string[]): CliArgs {
	let fixtureArg: string | null = null;
	let runs = 1;
	let model: string | null = null;
	let balance = 1000;

	for (const arg of argv) {
		if (arg === "--all") {
			fixtureArg = "--all";
		} else if (arg.startsWith("--runs=")) {
			runs = Number(arg.slice("--runs=".length));
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
		throw new Error("usage: npm run ai:compare -- <fixture-name>|--all [--runs=N] [--model=<id>] [--balance=N]");
	}
	if (!Number.isInteger(runs) || runs < 1) {
		throw new Error(`--runs must be a positive integer, got: ${runs}`);
	}
	if (!Number.isFinite(balance)) {
		throw new Error(`--balance must be a number, got: ${balance}`);
	}

	const fixtureNames = fixtureArg === "--all" ? ALL_FIXTURE_NAMES : [normalizeFixtureName(fixtureArg)];
	return { fixtureNames, runs, model, balance };
}

function sanitizeForFilename(s: string): string {
	return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
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

	const today = new Date().toISOString().slice(0, 10);
	const outFile = path.join(REPO_ROOT, "out", `compare-${today}-${sanitizeForFilename(modelId)}.md`);

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
