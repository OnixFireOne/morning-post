import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { formatAlert, sendAlert } from "./alert.js";
import { captureSnapshotAndScreenshot } from "./capture.js";
import { RetryExhaustedError } from "./errors.js";
import { computeFacts, type StateDay } from "./facts.js";
import { buildCaption } from "./render.js";
import { loadSnapshotFromFile } from "./snapshot.js";
import { appendDay, findPostedDay, readState, writeStateAtomic } from "./state.js";
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
	const caption = buildCaption(facts);
	console.log(caption);

	if (env.dryRun) {
		currentStep = "dry-run-output";
		mkdirSync(env.outDir, { recursive: true });
		if (png) writeFileSync(path.join(env.outDir, `${facts.dateKey}.png`), png);
		writeFileSync(path.join(env.outDir, `${facts.dateKey}.facts.json`), JSON.stringify(facts, null, 2));
		console.log(`[dry-run] wrote ${env.outDir}`);
		return; // dry-run никогда не алертит
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
		message = await sendPhoto({ botToken: env.telegramBotToken, chatId: env.telegramTargetChatId, caption, png });
	} else {
		// Раздел 8: снапшот есть, а скриншот не вышел — постим текстом, цифры
		// важнее картинки, но это всё равно алертится (не фатально — exit 0).
		console.error("[capture] no screenshot available — posting text-only");
		message = await sendMessage({ botToken: env.telegramBotToken, chatId: env.telegramTargetChatId, text: caption });
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
	};
	writeStateAtomic(env.stateFile, appendDay(history, day));
	console.log(`[state] posted messageId=${message.message_id} for ${facts.dateKey}, saved to ${env.stateFile}`);
}

main().catch((error: unknown) => {
	const retriesExhausted = error instanceof RetryExhaustedError ? error.retries : undefined;
	void handleFatalError({ step: currentStep, error, retriesExhausted });
});
