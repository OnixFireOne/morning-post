import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { formatAlert, sendAlert } from "./alert.js";
import { createAiClient } from "./ai/client.js";
import { buildParagraphsAI, type AiModelConfig } from "./ai/generate.js";
import { stateHistoryToAiHistory } from "./ai/payload.js";
import { captureSnapshotAndScreenshot } from "./capture.js";
import { RetryExhaustedError } from "./errors.js";
import { computeFacts, type Facts, type StateDay } from "./facts.js";
import { buildCaption, buildCaptionFromParagraphs, buildLeaderLines, buildParagraphs, CAPTION_LIMIT, type PostParagraphs } from "./render.js";
import { loadSnapshotFromFile } from "./snapshot.js";
import { appendDay, findPostedDay, readState, writeStateAtomic, type StateHistory } from "./state.js";
import { sendMessage, sendPhoto } from "./telegram.js";

function readEnv() {
	const args = process.argv.slice(2);
	// Позиционный аргумент — обход .env для разовых прогонов на фикстуре, без
	// префиксов вида `SNAPSHOT_FILE=... npm run dry`, которые не работают в
	// PowerShell/cmd (раздел 6): `npm run dry:fixture -- fixtures/green.json`.
	const snapshotFileOverride = args.find((a) => !a.startsWith("--"));
	return {
		siteUrl: process.env.SITE_URL ?? "",
		// `||`, not `??`, everywhere below: an empty string in .env (e.g. a value
		// swallowed by an unquoted `#` comment) must fall back too, not become 0/"".
		chartSelector: process.env.CHART_SELECTOR || "#hot-coins-chart",
		snapshotFile: snapshotFileOverride || process.env.SNAPSHOT_FILE || "",
		minSwarmSize: Number(process.env.MIN_SWARM_SIZE || 20),
		dryRun: process.env.DRY_RUN === "1",
		outDir: path.resolve(process.env.OUT_DIR || "out"),
		stateFile: path.resolve(process.env.STATE_FILE || "data/state.json"),
		force: args.includes("--force"),
		telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
		telegramTargetChatId: process.env.TELEGRAM_TARGET_CHAT_ID || "",
		telegramAdminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || "",
		// v2: AI-generated paragraphs (plan/ai-start-integration.md). AI_ENABLED
		// must stay "0" until a human has run the full manual verification — see
		// .env.example. When it's off, none of the fields below are read.
		aiEnabled: process.env.AI_ENABLED === "1",
		aiBaseUrl: process.env.AI_BASE_URL || "",
		aiApiKey: process.env.AI_API_KEY || "",
		aiModel: process.env.AI_MODEL || "",
		aiModelFallback: process.env.AI_MODEL_FALLBACK || "",
		aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS || 25000),
		aiTotalBudgetMs: Number(process.env.AI_TOTAL_BUDGET_MS || 70000),
		aiMaxAttempts: Number(process.env.AI_MAX_ATTEMPTS || 2),
		promptVersion: Number(process.env.PROMPT_VERSION || 1),
		// null (not 0) means "price unknown, don't estimate cost" — distinct from a free model.
		aiPriceIn: process.env.AI_PRICE_IN ? Number(process.env.AI_PRICE_IN) : null,
		aiPriceOut: process.env.AI_PRICE_OUT ? Number(process.env.AI_PRICE_OUT) : null,
		aiFallbackPriceIn: process.env.AI_FALLBACK_PRICE_IN ? Number(process.env.AI_FALLBACK_PRICE_IN) : null,
		aiFallbackPriceOut: process.env.AI_FALLBACK_PRICE_OUT ? Number(process.env.AI_FALLBACK_PRICE_OUT) : null,
		aiDailyTokenWarn: process.env.AI_DAILY_TOKEN_WARN ? Number(process.env.AI_DAILY_TOKEN_WARN) : null,
		// Not AI_BASE_URL's own proxy (AiClientOptions.proxyUrl) — this is the
		// outbound network proxy for reaching it at all (section 2).
		aiProxyUrl: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",
	};
}

type Env = ReturnType<typeof readEnv>;

// Доступны process-level обработчикам ниже, которые не видят локальные
// переменные main() — поэтому шаг и env кэшируются на уровне модуля.
const env = readEnv();
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

type RenderedPost = {
	caption: string;
	paragraphs: PostParagraphs;
	source: "ai" | "template";
	model: string | null;
	provider: string | null;
	promptVersion: number | null;
	/** null when AI was never attempted at all (AI_ENABLED=0) — omitted from StateDay rather than written as 0. */
	tokensIn: number | null;
	tokensOut: number | null;
	attempts: number | null;
	/** Non-null exactly when the AI path was attempted and didn't produce what got published — drives the non-blocking fallback alert in main(). */
	failureReason: string | null;
};

/**
 * v2 step 6: when AI is disabled this calls nothing but the untouched v1
 * buildCaption()/buildParagraphs() — same functions, same facts, so the
 * caption is byte-for-byte what v1 always produced. AI_ENABLED=0 in
 * .env/.env.example — never flip this without a human running the full
 * dry:fixture verification first (plan/ai-start-integration.md, section 9).
 */
async function renderPost(facts: Facts, history: StateHistory): Promise<RenderedPost> {
	if (!env.aiEnabled) {
		return {
			caption: buildCaption(facts),
			paragraphs: buildParagraphs(facts),
			source: "template",
			model: null,
			provider: null,
			promptVersion: null,
			tokensIn: null,
			tokensOut: null,
			attempts: null,
			failureReason: null,
		};
	}

	const aiHistory = stateHistoryToAiHistory(history, facts.dateKey);
	const client = createAiClient({ baseUrl: env.aiBaseUrl, apiKey: env.aiApiKey, proxyUrl: env.aiProxyUrl || undefined });
	const primary: AiModelConfig = { model: env.aiModel, priceInPerMillion: env.aiPriceIn, priceOutPerMillion: env.aiPriceOut };
	const fallback: AiModelConfig = { model: env.aiModelFallback, priceInPerMillion: env.aiFallbackPriceIn, priceOutPerMillion: env.aiFallbackPriceOut };

	const result = await buildParagraphsAI({
		facts,
		history: aiHistory,
		client,
		primary,
		fallback,
		timeoutMs: env.aiTimeoutMs,
		totalBudgetMs: env.aiTotalBudgetMs,
		maxAttemptsPerModel: env.aiMaxAttempts,
		promptVersion: env.promptVersion,
		usageFile: path.join(env.outDir, "usage.jsonl"),
		aiJsonFile: path.join(env.outDir, `${facts.dateKey}.ai.json`),
	});

	if (result.source === "ai") {
		const { winnerLine, loserLine } = buildLeaderLines(facts);
		const paragraphs: PostParagraphs = { picture: result.picture, winnerLine, loserLine, observation: result.observation };
		const caption = buildCaptionFromParagraphs(facts, paragraphs); // no shortPicture: overflow here is a total AI-path failure, not a reason to graft template text on
		if (caption.length <= CAPTION_LIMIT) {
			return {
				caption,
				paragraphs,
				source: "ai",
				model: result.model,
				provider: result.provider,
				promptVersion: result.promptVersion,
				tokensIn: result.totalTokensIn,
				tokensOut: result.totalTokensOut,
				attempts: result.attempts,
				failureReason: null,
			};
		}
		return {
			caption: buildCaption(facts),
			paragraphs: buildParagraphs(facts),
			source: "template",
			model: null,
			provider: null,
			promptVersion: null,
			tokensIn: result.totalTokensIn,
			tokensOut: result.totalTokensOut,
			attempts: result.attempts,
			failureReason: "AI paragraphs were valid but the caption still exceeded CAPTION_LIMIT after dropping the observation paragraph",
		};
	}

	// buildParagraphsAI() never throws — it already fell back to the template internally.
	return {
		caption: buildCaption(facts),
		paragraphs: buildParagraphs(facts),
		source: "template",
		model: null,
		provider: null,
		promptVersion: null,
		tokensIn: result.totalTokensIn,
		tokensOut: result.totalTokensOut,
		attempts: result.attempts,
		failureReason: result.failureReason,
	};
}

async function main() {
	validateStartupConfig();

	let snapshot;
	let png: Buffer | null = null;
	let stabilizationReads = 0;

	currentStep = "capture";
	if (env.snapshotFile) {
		snapshot = loadSnapshotFromFile(env.snapshotFile);
		console.log(`[capture] snapshot from file: ${env.snapshotFile}`);
	} else {
		if (!env.siteUrl) throw new Error("SITE_URL is not set (.env)");
		const result = await captureSnapshotAndScreenshot({
			siteUrl: env.siteUrl,
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

	currentStep = "render";
	const rendered = await renderPost(facts, history);
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

	// One generation per day (single daily cron run) — this run's token total
	// is the day's token total, no need to sum usage.jsonl across runs.
	if (env.aiEnabled && env.aiDailyTokenWarn !== null && rendered.tokensIn !== null && rendered.tokensOut !== null) {
		const totalTokens = rendered.tokensIn + rendered.tokensOut;
		if (totalTokens > env.aiDailyTokenWarn) {
			currentStep = "ai:token-warn-alert";
			const text = formatAlert({
				step: "ai:token-warn",
				error: new Error(`AI token usage today: ${totalTokens} > AI_DAILY_TOKEN_WARN=${env.aiDailyTokenWarn}`),
				siteUrl: env.siteUrl || undefined,
				exitCode: 0,
			});
			const delivered = await sendAlert({ botToken: env.telegramBotToken, chatId: env.telegramAdminChatId, text });
			if (!delivered) console.error(text);
		}
	}

	// Раздел 5: если за сегодняшнюю (московскую) дату уже есть пост — выходим
	// без публикации, код 0, без алерта. --force обходит эту проверку.
	const alreadyPosted = findPostedDay(history, facts.dateKey);
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
}

main().catch((error: unknown) => {
	const retriesExhausted = error instanceof RetryExhaustedError ? error.retries : undefined;
	void handleFatalError({ step: currentStep, error, retriesExhausted });
});
