// Последний рубеж отчётности о сбоях (раздел 8, блок «Алерты в личку»).
// Намеренно ничего не импортирует из facts.ts/render.ts и не переиспользует
// retry-политику telegram.ts: та рассчитана на обычные посты (3 попытки,
// уважает retry_after, может ждать долго), а здесь нужен быстрый и
// безусловный путь, который отработает, даже если остальной пайплайн сломан.

const ALERT_TIMEOUT_MS = 10_000;
const ALERT_MAX_LENGTH = 3500;
const ALERT_ATTEMPTS = 2; // "один ретрай" = 2 попытки всего
const ALERT_RETRY_DELAY_MS = 1000;
const STACK_LINES_LIMIT = 10;

export type AlertContext = {
	step: string;
	error: unknown;
	/** Только для сбоев после исчерпания ретраев (RetryExhaustedError) — иначе не указывается. */
	retriesExhausted?: number;
	siteUrl?: string;
	exitCode: number;
};

function formatMoscowTimestamp(date: Date): string {
	return new Intl.DateTimeFormat("ru-RU", {
		timeZone: "Europe/Moscow",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(date);
}

/** Дата/время МСК, шаг, тип и текст ошибки, до 10 строк стека, ретраи, SITE_URL, exit code. */
export function formatAlert(ctx: AlertContext): string {
	const { error } = ctx;
	const errorType = error instanceof Error ? error.constructor.name : typeof error;
	const errorMessage = error instanceof Error ? error.message : String(error);
	const stackLines = error instanceof Error && error.stack ? error.stack.split("\n").slice(0, STACK_LINES_LIMIT) : null;

	const lines = [
		"morning-post: сбой",
		`Время (МСК): ${formatMoscowTimestamp(new Date())}`,
		`Шаг: ${ctx.step}`,
		`Ошибка: ${errorType}: ${errorMessage}`,
	];
	if (stackLines) lines.push("Стек:", ...stackLines);
	if (ctx.retriesExhausted != null) lines.push(`Ретраев исчерпано: ${ctx.retriesExhausted}`);
	if (ctx.siteUrl) lines.push(`SITE_URL: ${ctx.siteUrl}`);
	lines.push(`Exit code: ${ctx.exitCode}`);
	return lines.join("\n");
}

export type SendAlertOptions = {
	botToken: string;
	chatId: string;
	text: string;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Прямой fetch на sendMessage — без parse_mode (алерт всегда обычный текст,
 * так что содержимое ошибки не нужно HTML-экранировать и оно не может
 * сломать разметку). Таймаут 10с на попытку, один ретрай, текст обрезается
 * до 3500 символов. Никогда не бросает — возвращает false при неудаче,
 * вызывающий код (index.ts) сам печатает полный текст в stderr.
 */
export async function sendAlert(opts: SendAlertOptions): Promise<boolean> {
	const text = opts.text.length > ALERT_MAX_LENGTH ? `${opts.text.slice(0, ALERT_MAX_LENGTH)}\n…(обрезано)` : opts.text;
	// Токен встречается только здесь, в пути запроса — не логировать `url`.
	const url = `https://api.telegram.org/bot${opts.botToken}/sendMessage`;

	for (let attempt = 1; attempt <= ALERT_ATTEMPTS; attempt++) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
		try {
			const form = new FormData();
			form.append("chat_id", opts.chatId);
			form.append("text", text);
			const response = await fetch(url, { method: "POST", body: form, signal: controller.signal });
			const data = (await response.json()) as { ok: boolean };
			if (data.ok) return true;
		} catch {
			// сеть/таймаут/не-JSON ответ — попробуем ещё раз ниже, если попытки остались
		} finally {
			clearTimeout(timeout);
		}
		if (attempt < ALERT_ATTEMPTS) await sleep(ALERT_RETRY_DELAY_MS);
	}
	return false;
}
