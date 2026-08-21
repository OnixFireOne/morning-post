import { chromium } from "playwright";
import { parseSnapshot } from "./snapshot.js";
import type { HotCoinsSnapshot } from "./types.js";

export type CaptureOptions = {
	siteUrl: string;
	chartSelector: string;
	minSwarmSize: number;
};

export type CaptureResult = {
	snapshot: HotCoinsSnapshot;
	png: Buffer;
	/** How many stabilization-loop reads it took before two consecutive reads matched. */
	stabilizationReads: number;
};

const NAV_TIMEOUT_MS = 60_000;
const SNAPSHOT_READY_TIMEOUT_MS = 45_000;
const STABILIZATION_MAX_ITERATIONS = 20;
const STABILIZATION_INTERVAL_MS = 1500;
const LAYOUT_SETTLE_MS = 1200;

async function captureOnce(opts: CaptureOptions): Promise<CaptureResult> {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({
			viewport: { width: 1200, height: 900 },
			deviceScaleFactor: 2,
			colorScheme: "dark",
		});

		// domcontentloaded, никогда networkidle: на dev-сервере Next.js HMR держит
		// соединение открытым, networkidle может вообще не наступить (раздел 3).
		await page.goto(opts.siteUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

		await page.waitForFunction(
			(min) => (window.__HOT_COINS_SNAPSHOT__?.mainSwarm?.length ?? 0) >= min,
			opts.minSwarmSize,
			{ timeout: SNAPSHOT_READY_TIMEOUT_MS },
		);

		// Данные приходят страницами по 100 монет — снапшот перепишется 2-3 раза.
		// Ждём не "появился", а "перестал расти": два одинаковых чтения подряд.
		let prev = -1;
		let stabilizationReads = 0;
		for (let i = 0; i < STABILIZATION_MAX_ITERATIONS; i++) {
			const size = await page.evaluate(() => {
				const s = window.__HOT_COINS_SNAPSHOT__;
				return s ? s.mainSwarm.length + s.edgePins.length : 0;
			});
			stabilizationReads++;
			if (size === prev) break;
			prev = size;
			await page.waitForTimeout(STABILIZATION_INTERVAL_MS);
		}
		await page.waitForTimeout(LAYOUT_SETTLE_MS); // доиграть анимацию раскладки роя

		const rawSnapshot = await page.evaluate(() => window.__HOT_COINS_SNAPSHOT__);
		const snapshot = parseSnapshot(rawSnapshot); // бросает внятную ошибку при version !== 1

		await page.mouse.move(0, 0); // увести курсор — иначе может всплыть тултип монеты
		const png = await page.locator(opts.chartSelector).screenshot({ type: "png" });

		return { snapshot, png, stabilizationReads };
	} finally {
		// Кнопку настроек не кликаем, DOM не парсим — снапшот и скриншот, больше ничего.
		await browser.close();
	}
}

export type RetryOptions = {
	attempts: number;
	delayMs: number;
};

const DEFAULT_RETRY: RetryOptions = { attempts: 2, delayMs: 30_000 };

/**
 * Раздел 8: при неудаче — ретрай с новым контекстом браузера (каждый вызов
 * captureOnce уже поднимает и закрывает свой собственный browser). Ошибка
 * никогда не глотается молча — после исчерпания попыток бросаем последнюю.
 */
export async function captureSnapshotAndScreenshot(opts: CaptureOptions, retry: RetryOptions = DEFAULT_RETRY): Promise<CaptureResult> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= retry.attempts; attempt++) {
		try {
			return await captureOnce(opts);
		} catch (err) {
			lastError = err;
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[capture] attempt ${attempt}/${retry.attempts} failed: ${message}`);
			if (attempt < retry.attempts) {
				await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
			}
		}
	}
	throw lastError;
}
