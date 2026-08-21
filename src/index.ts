import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { captureSnapshotAndScreenshot } from "./capture.js";
import { computeFacts, type StateDay } from "./facts.js";
import { buildCaption } from "./render.js";
import { loadSnapshotFromFile } from "./snapshot.js";
import { appendDay, findPostedDay, readState, writeStateAtomic } from "./state.js";
import { alertAdmin, sendMessage, sendPhoto } from "./telegram.js";

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

async function alertAdminIfConfigured(env: Env, message: string): Promise<void> {
	if (!env.telegramBotToken || !env.telegramAdminChatId) return;
	await alertAdmin({ botToken: env.telegramBotToken, adminChatId: env.telegramAdminChatId, message });
}

async function main() {
	const env = readEnv();

	let snapshot;
	let png: Buffer | null = null;
	let stabilizationReads = 0;

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

	const history = readState(env.stateFile);
	const facts = computeFacts(snapshot, history);
	const caption = buildCaption(facts);

	console.log(caption);

	if (env.dryRun) {
		mkdirSync(env.outDir, { recursive: true });
		if (png) writeFileSync(path.join(env.outDir, `${facts.dateKey}.png`), png);
		writeFileSync(path.join(env.outDir, `${facts.dateKey}.facts.json`), JSON.stringify(facts, null, 2));
		console.log(`[dry-run] wrote ${env.outDir}`);
		return;
	}

	// Раздел 5: если за сегодняшнюю (московскую) дату уже есть пост — выходим
	// без публикации, код 0. --force обходит эту проверку для ручного репоста.
	const alreadyPosted = findPostedDay(history, facts.dateKey);
	if (alreadyPosted && !env.force) {
		console.log(`[state] already posted for ${facts.dateKey} (messageId=${alreadyPosted.messageId}) — skipping. Use --force to repost.`);
		return;
	}

	if (!env.telegramBotToken || !env.telegramTargetChatId) {
		throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_TARGET_CHAT_ID are not set (.env)");
	}

	let message;
	if (png) {
		message = await sendPhoto({ botToken: env.telegramBotToken, chatId: env.telegramTargetChatId, caption, png });
	} else {
		// Раздел 8: снапшот есть, а скриншот не вышел — постим текстом и алертим,
		// цифры важнее картинки.
		console.error("[capture] no screenshot available — posting text-only");
		message = await sendMessage({ botToken: env.telegramBotToken, chatId: env.telegramTargetChatId, text: caption });
		await alertAdminIfConfigured(env, `[morning-post] posted without a screenshot for ${facts.dateKey} — capture produced no PNG.`);
	}

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

main().catch(async (err) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error(message);
	process.exitCode = 1;
	await alertAdminIfConfigured(readEnv(), `[morning-post] run failed: ${message}`);
});
