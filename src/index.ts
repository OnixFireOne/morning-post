import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { formatAlert, sendAlert } from "./alert.js";
import { resolveProviderProfile } from "./ai/providers.js";
import { buildUsageReport } from "./ai/usageReport.js";
import { captureSnapshotAndScreenshot } from "./capture.js";
import { parseArgs, type CliArgs } from "./cliArgs.js";
import { RetryExhaustedError } from "./errors.js";
import { computeFacts, type StateDay } from "./facts.js";
import { appendFactsLogLine } from "./factsLog.js";
import { renderPost } from "./renderPost.js";
import { loadSnapshotFileOrThrow, resolveSnapshotSource } from "./snapshot.js";
import { appendDay, findPostedDay, readState, writeStateAtomic } from "./state.js";
import { sendMessage, sendPhoto } from "./telegram.js";

/**
 * Режим определяется исключительно аргументами командной строки — .env
 * хранит только адреса/ключи/пороги. Разбирается до всего остального: сбой
 * здесь — это опечатка в самой команде запуска, а не ошибка во время
 * работы, поэтому печатается и завершает процесс сразу же, без алерта
 * (Telegram ещё даже не проверен на этом шаге — validateStartupConfig ниже
 * его и не видел).
 */
function parseArgsOrExit(): CliArgs {
	try {
		return parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`[startup] ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}

const args = parseArgsOrExit();

function readEnv(args: CliArgs) {
	const stateFile = path.resolve(process.env.STATE_FILE || "data/state.json");
	const usageReportMode = process.env.AI_USAGE_REPORT === "weekly" ? "weekly" : process.env.AI_USAGE_REPORT === "0" ? "0" : "daily";
	// Resolved once, up front: an unrecognized AI_PROVIDER must fail loudly at
	// startup (before any browser/network work), not fall back silently.
	// inputOverhead lives entirely in the profile itself (0 for both current
	// profiles) — no env knob for it: an external override for "correct for
	// someone else's undocumented billing" is a direct invitation to repeat
	// that exact history with a different magic number (see git history for
	// what that looked like the first time).
	const providerProfile = resolveProviderProfile(process.env.AI_PROVIDER);
	return {
		siteUrl: process.env.SITE_URL ?? "",
		// `||`, not `??`, everywhere below: an empty string in .env (e.g. a value
		// swallowed by an unquoted `#` comment) must fall back too, not become 0/"".
		chartSelector: process.env.CHART_SELECTOR || "#hot-coins-chart",
		// --fixture=<path>, parsed and validated (only with --dry) in cliArgs.ts.
		fixture: args.fixture,
		minSwarmSize: Number(process.env.MIN_SWARM_SIZE || 20),
		dryRun: args.dry,
		outDir: path.resolve(process.env.OUT_DIR || "out"),
		stateFile,
		// Section 3.2: usage.jsonl lives in ./data (the same mounted volume as
		// state.json), not ./out — an earlier version of this file put it in
		// outDir by mistake; fixed here since section 3.3's balance tracking
		// now depends on reading its real, documented location.
		usageFile: path.join(path.dirname(stateFile), "usage.jsonl"),
		// Eternal daily log — append-only, never rotated (unlike state.json's
		// own 60-day cap). Same mounted ./data volume by default, own
		// independently configurable path.
		factsLogFile: path.resolve(process.env.FACTS_LOG_FILE || "data/facts.jsonl"),
		force: args.force,
		telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
		telegramTargetChatId: process.env.TELEGRAM_TARGET_CHAT_ID || "",
		telegramAdminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || "",
		// v2: AI-generated paragraphs (plan/ai-start-integration.md). AI_ENABLED
		// must stay "0" until a human has run the full manual verification — see
		// .env.example. When it's off, none of the fields below are read.
		aiEnabled: process.env.AI_ENABLED === "1",
		// AI_PROVIDER selects the profile (src/ai/providers.ts) — the one place
		// a provider name, base URL default, model default, or price number may
		// live (tests/ai-providers-leak.test.ts enforces this). AI_BASE_URL/
		// AI_MODEL/AI_MODEL_FALLBACK, when actually set in .env, still override
		// the selected profile's own default for exactly that field — the
		// profile fills gaps, it never forces a value nobody asked to change.
		aiProvider: providerProfile,
		aiBaseUrl: process.env.AI_BASE_URL || providerProfile.baseUrl,
		aiApiKey: process.env.AI_API_KEY || "",
		aiModel: process.env.AI_MODEL || providerProfile.primaryModel,
		aiModelFallback: process.env.AI_MODEL_FALLBACK || providerProfile.fallbackModel,
		aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS || 25000),
		aiTotalBudgetMs: Number(process.env.AI_TOTAL_BUDGET_MS || 70000),
		aiMaxAttempts: Number(process.env.AI_MAX_ATTEMPTS || 2),
		promptVersion: Number(process.env.PROMPT_VERSION || 1),
		// Section 3.4: --dry must never spend a real request on its own — --ai
		// is the explicit opt-in on the command line for a deliberate obkatka
		// run. Meaningless (and unchecked) outside --dry: a real, non-dry
		// publish already asks the model whenever AI_ENABLED=1, flag or not.
		aiFlag: args.ai,
		// Not AI_BASE_URL's own proxy (AiClientOptions.proxyUrl) — this is the
		// outbound network proxy for reaching it at all (section 2).
		aiProxyUrl: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",
		// Section 3.3: daily/weekly usage summary to the admin chat.
		aiUsageReport: usageReportMode as "daily" | "weekly" | "0",
		aiBalanceStart: process.env.AI_BALANCE_START ? Number(process.env.AI_BALANCE_START) : null,
		aiBalanceAsOf: process.env.AI_BALANCE_AS_OF || null,
		aiBalanceWarn: process.env.AI_BALANCE_WARN ? Number(process.env.AI_BALANCE_WARN) : null,
	};
}

type Env = ReturnType<typeof readEnv>;

// Доступны process-level обработчикам ниже, которые не видят локальные
// переменные main() — поэтому шаг и env кэшируются на уровне модуля.
const env = readEnv(args);
let currentStep = "startup";
let alerted = false;

/**
 * Раздел 8: без TELEGRAM_ADMIN_CHAT_ID (и токена) алертить попросту некуда —
 * значит вся защита от «молча пропущенного дня» не работает. Падаем на
 * старте локально, до любой сетевой/браузерной работы; сам этот сбой
 * заалертить нечем, поэтому только stderr + exit 1.
 */
function validateStartupConfig(): void {
	if (!env.telegramBotToken || !env.telegramAdminChatId) {
		console.error("[startup] TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID must both be set — alerts have nowhere to go otherwise.");
		process.exit(1);
	}
	if (env.aiEnabled && (!env.aiBaseUrl || !env.aiApiKey || !env.aiModel || !env.aiModelFallback)) {
		console.error("[startup] AI_ENABLED=1 requires AI_BASE_URL, AI_API_KEY, AI_MODEL, and AI_MODEL_FALLBACK to all be set.");
		process.exit(1);
	}
}

/**
 * Единая точка выхода на любой фатальный сбой (раздел 8, «Алерты в личку»):
 * формирует алерт, шлёт его sendAlert() (10с таймаут, один ретрай), и если
 * доставка не удалась — печатает полный текст в stderr, чтобы сбой не
 * потерялся даже без Telegram. Всегда завершает процесс кодом 1.
 *
 * Ставим `process.exitCode`, а не вызываем `process.exit()` — на Windows
 * принудительный exit() сразу после `fetch()` к Telegram надёжно падает в
 * ассерт libuv (`UV_HANDLE_CLOSING`, известное взаимодействие undici
 * keep-alive сокетов с форс-завершением). Естественное завершение процесса
 * после того, как event loop опустеет, отрабатывает без этой проблемы.
 */
async function handleFatalError(ctx: { step: string; error: unknown; retriesExhausted?: number }): Promise<void> {
	const exitCode = 1;
	if (alerted) {
		process.exitCode = exitCode; // process-level handler дублирует то, что main() уже обработал
		return;
	}
	alerted = true;

	const text = formatAlert({ ...ctx, siteUrl: env.siteUrl || undefined, exitCode });
	console.error(text);

	const delivered = await sendAlert({ botToken: env.telegramBotToken, chatId: env.telegramAdminChatId, text });
	if (!delivered) {
		console.error("[alert] failed to deliver to admin chat — full alert text was already printed above.");
	}
	process.exitCode = exitCode;
}

process.on("uncaughtException", (error) => {
	handleFatalError({ step: currentStep, error })
		.catch(() => {})
		// Node's own guidance after uncaughtException is not to resume normal
		// operation — force-exit as a safety net if something is still hanging
		// 5s after we tried to alert, but let a clean fast exit win if it can.
		.finally(() => setTimeout(() => process.exit(1), 5000).unref());
});
process.on("unhandledRejection", (reason) => {
	handleFatalError({ step: currentStep, error: reason })
		.catch(() => {})
		.finally(() => setTimeout(() => process.exit(1), 5000).unref());
});

async function main() {
	// До любого тяжёлого шага и до validateStartupConfig — не нужно разбирать
	// стек, чтобы понять, какой режим вообще отработал и почему.
	const snapshotSource = resolveSnapshotSource({ fixture: env.fixture, siteUrl: env.siteUrl });
	// В бою ИИ решает единственный аварийный выключатель, AI_ENABLED; всухую —
	// --ai (аварийный выключатель прода всё равно первым — см. renderPost.ts).
	const aiActive = env.aiEnabled && (env.dryRun ? env.aiFlag : true);
	console.log(
		`mode: ${env.dryRun ? "dry" : "production"} / ${snapshotSource.mode === "file" ? `fixture ${snapshotSource.path}` : "live site"} / AI ${aiActive ? "on" : "off"}`,
	);

	validateStartupConfig();

	let snapshot;
	let png: Buffer | null = null;
	let stabilizationReads = 0;

	currentStep = "capture";
	if (snapshotSource.mode === "file") {
		snapshot = loadSnapshotFileOrThrow(snapshotSource.path);
	} else {
		if (!snapshotSource.url) throw new Error("SITE_URL is not set (.env)");
		const result = await captureSnapshotAndScreenshot({
			siteUrl: snapshotSource.url,
			chartSelector: env.chartSelector,
			minSwarmSize: env.minSwarmSize,
		});
		snapshot = result.snapshot;
		png = result.png;
		stabilizationReads = result.stabilizationReads;
	}
	console.log(
		`[capture] mainSwarm=${snapshot.mainSwarm.length} edgePins=${snapshot.edgePins.length} stabilizationReads=${stabilizationReads}`,
	);

	currentStep = "facts";
	const history = readState(env.stateFile);
	const facts = computeFacts(snapshot, history);
	const alreadyPosted = findPostedDay(history, facts.dateKey);

	currentStep = "render";
	// v2: skip the AI request when this run can't actually publish anyway
	// (already posted today, no --force) — usage.jsonl is an accounting log of
	// real attempts, and a manual no-op rerun spending a real request would
	// pollute it. Exempt in dry-run: dry:fixture is how the AI path gets
	// previewed, and a fixture's dateKey essentially never matches real
	// prod state.
	const skipAi = !env.dryRun && Boolean(alreadyPosted) && !env.force;
	const rendered = await renderPost(facts, history, skipAi, env);
	console.log(rendered.caption);

	if (env.dryRun) {
		currentStep = "dry-run-output";
		mkdirSync(env.outDir, { recursive: true });
		if (png) writeFileSync(path.join(env.outDir, `${facts.dateKey}.png`), png);
		writeFileSync(path.join(env.outDir, `${facts.dateKey}.facts.json`), JSON.stringify(facts, null, 2));
		console.log(`[dry-run] wrote ${env.outDir}`);
		return; // dry-run никогда не алертит
	}

	// v2: AI fell back to the template (either buildParagraphsAI() exhausted its
	// own retries/budget, or the AI text overflowed CAPTION_LIMIT). Mirrors the
	// existing "posted without a screenshot" pattern below: non-blocking,
	// exitCode 0 — sendAlert() never throws, and a failed alert delivery must
	// never turn a successful post into a failed run.
	if (env.aiEnabled && rendered.failureReason) {
		currentStep = "ai:fallback-alert";
		const text = formatAlert({
			step: "ai:fallback",
			error: new Error(rendered.failureReason),
			siteUrl: env.siteUrl || undefined,
			exitCode: 0,
		});
		const delivered = await sendAlert({ botToken: env.telegramBotToken, chatId: env.telegramAdminChatId, text });
		if (!delivered) console.error(text);
	}

	// Third outcome (2026-08-26, generalized 2026-09-01 to any trimmable
	// reason — see validator.ts's TRIMMABLE_REASONS/attemptObservationTrim):
	// the AI response was fixed by cutting one sentence instead of falling
	// back to the template. Not a failure — the post still goes out
	// AI-sourced — but it's still a repair worth knowing about, same
	// non-blocking alert mechanism and priority as the fallback alert above.
	// AiGenerationResult doesn't carry which reason triggered the cut (only
	// AiJsonOutput's own attempts[].outcome does, for offline debugging), so
	// this message stays reason-agnostic rather than naming one specific
	// validator item that may not be the one that actually fired.
	if (env.aiEnabled && rendered.source === "ai_trimmed") {
		currentStep = "ai:trim-alert";
		const text = formatAlert({
			step: "ai:trimmed",
			error: new Error(`cut one sentence that failed validation: "${rendered.trimmedSentence}"`),
			siteUrl: env.siteUrl || undefined,
			exitCode: 0,
		});
		const delivered = await sendAlert({ botToken: env.telegramBotToken, chatId: env.telegramAdminChatId, text });
		if (!delivered) console.error(text);
	}

	// Раздел 5: если за сегодняшнюю (московскую) дату уже есть пост — выходим
	// без публикации, код 0, без алерта. --force обходит эту проверку.
	if (alreadyPosted && !env.force) {
		console.log(`[state] already posted for ${facts.dateKey} (messageId=${alreadyPosted.messageId}) — skipping. Use --force to repost.`);
		return;
	}

	currentStep = "telegram";
	if (!env.telegramTargetChatId) throw new Error("TELEGRAM_TARGET_CHAT_ID is not set (.env)");

	let message;
	if (png) {
		message = await sendPhoto({ botToken: env.telegramBotToken, chatId: env.telegramTargetChatId, caption: rendered.caption, png });
	} else {
		// Раздел 8: снапшот есть, а скриншот не вышел — постим текстом, цифры
		// важнее картинки, но это всё равно алертится (не фатально — exit 0).
		console.error("[capture] no screenshot available — posting text-only");
		message = await sendMessage({ botToken: env.telegramBotToken, chatId: env.telegramTargetChatId, text: rendered.caption });
		const text = formatAlert({
			step: "telegram:no-screenshot",
			error: new Error(`posted without a screenshot for ${facts.dateKey}`),
			siteUrl: env.siteUrl || undefined,
			exitCode: 0,
		});
		const delivered = await sendAlert({ botToken: env.telegramBotToken, chatId: env.telegramAdminChatId, text });
		if (!delivered) console.error(text);
	}

	currentStep = "state:write";
	const day: StateDay = {
		date: facts.dateKey,
		swarmState: facts.swarmState,
		btcChange: facts.btc?.change24h ?? null,
		postedAt: new Date().toISOString(),
		messageId: message.message_id,
		// v2: written for template days too, not just AI ones (see StateDay in
		// facts.ts) — so stateHistoryToAiHistory() has anti-repeat context even
		// for days the AI path never touched (AI_ENABLED=0, or a day it fell back).
		picture: rendered.paragraphs.picture,
		observation: rendered.paragraphs.observation,
		source: rendered.source,
		model: rendered.model,
		provider: rendered.provider,
		promptVersion: rendered.promptVersion,
		...(rendered.tokensIn !== null ? { tokensIn: rendered.tokensIn } : {}),
		...(rendered.tokensOut !== null ? { tokensOut: rendered.tokensOut } : {}),
		...(rendered.attempts !== null ? { attempts: rendered.attempts } : {}),
	};
	writeStateAtomic(env.stateFile, appendDay(history, day));
	console.log(`[state] posted messageId=${message.message_id} for ${facts.dateKey}, saved to ${env.stateFile}`);

	// Eternal daily log (data/facts.jsonl) — right next to the state.json
	// write, strictly after it: state.json is already durably written by the
	// time this runs, so a failure here can never take that write back with
	// it. Non-critical, same as the other post-publish side channels below —
	// a log line plus a non-blocking alert, never a thrown error, never a
	// changed exit code.
	currentStep = "facts-log:write";
	try {
		appendFactsLogLine(env.factsLogFile, {
			date: facts.dateKey,
			facts,
			topGainer: facts.winners[0] ? { ticker: facts.winners[0].ticker, change24h: facts.winners[0].change24h } : null,
			topLoser: facts.losers[0] ? { ticker: facts.losers[0].ticker, change24h: facts.losers[0].change24h } : null,
			source: rendered.source,
			model: rendered.model,
			provider: rendered.responseProvider,
			promptVersion: rendered.promptVersion,
			attempts: rendered.attempts,
		});
	} catch (err) {
		console.error("[facts-log] failed to append:", err instanceof Error ? err.message : err);
		const text = formatAlert({
			step: "facts-log:write",
			error: err,
			siteUrl: env.siteUrl || undefined,
			exitCode: 0,
		});
		const delivered = await sendAlert({ botToken: env.telegramBotToken, chatId: env.telegramAdminChatId, text });
		if (!delivered) console.error(text);
	}

	// Section 3.3: strictly after the post is out and the day is on record.
	// Wrapped defensively — a bug in the summary itself (not just sendAlert(),
	// which already never throws) must not turn a successful post into a
	// failed run. buildUsageReport() already returns null when AI is
	// disabled or AI_USAGE_REPORT="0"/not-Sunday-in-weekly-mode; the
	// env.aiEnabled check here just avoids the usage.jsonl read entirely on
	// the common AI_ENABLED=0 path.
	if (env.aiEnabled) {
		currentStep = "usage-report";
		try {
			const report = buildUsageReport({
				aiEnabled: env.aiEnabled,
				mode: env.aiUsageReport,
				dateKey: facts.dateKey,
				today: {
					source: rendered.source,
					model: rendered.model,
					attempts: rendered.attempts ?? 0,
					tokensIn: rendered.tokensIn,
					tokensOut: rendered.tokensOut,
					totalCost: rendered.totalCost,
					failureReason: rendered.failureReason,
				},
				usageFile: env.usageFile,
				balanceStart: env.aiBalanceStart,
				balanceAsOf: env.aiBalanceAsOf,
				balanceWarn: env.aiBalanceWarn,
			});
			if (report) {
				const delivered = await sendAlert({ botToken: env.telegramBotToken, chatId: env.telegramAdminChatId, text: report });
				if (delivered) {
					console.log(`[usage-report] sent messageId=${delivered} to ${env.telegramAdminChatId}`);
				} else {
					console.error(report);
				}
			}
		} catch (err) {
			console.error("[usage-report] failed to build or send:", err instanceof Error ? err.message : err);
		}
	}
}

main().catch((error: unknown) => {
	const retriesExhausted = error instanceof RetryExhaustedError ? error.retries : undefined;
	void handleFatalError({ step: currentStep, error, retriesExhausted });
});
