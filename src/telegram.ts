// Thin Telegram Bot API client. Никогда не логировать `url` или `botToken` —
// url содержит токен в пути (`/bot<token>/method`). Ошибки ниже всегда
// собираются вручную, без включения сырого объекта ошибки fetch, который
// теоретически может нести в себе url.

export type TelegramMessage = {
	message_id: number;
};

export type SendPhotoOptions = {
	botToken: string;
	chatId: string;
	caption: string;
	png: Buffer;
};

export type SendMessageOptions = {
	botToken: string;
	chatId: string;
	text: string;
};

export type AlertAdminOptions = {
	botToken: string;
	adminChatId: string;
	message: string;
};

type TelegramApiResponse<T> =
	| { ok: true; result: T }
	| { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } };

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 429/5xx → 3 ретрая с экспонентой, уважая `retry_after` из ответа Telegram (раздел 8). */
async function callTelegramApi<T>(botToken: string, method: "sendPhoto" | "sendMessage", body: FormData): Promise<T> {
	const url = `https://api.telegram.org/bot${botToken}/${method}`;
	let lastError: Error = new Error(`telegram: ${method} failed`);

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		let response: Response;
		try {
			response = await fetch(url, { method: "POST", body });
		} catch {
			lastError = new Error(`telegram: network error calling ${method}`);
			if (attempt < MAX_ATTEMPTS) await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
			continue;
		}

		const data = (await response.json()) as TelegramApiResponse<T>;
		if (data.ok) return data.result;

		const retryable = data.error_code === 429 || data.error_code >= 500;
		lastError = new Error(`telegram: ${method} failed (${data.error_code}): ${data.description}`);
		if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;

		const retryAfterMs = data.parameters?.retry_after != null ? data.parameters.retry_after * 1000 : BASE_BACKOFF_MS * 2 ** (attempt - 1);
		await sleep(retryAfterMs);
	}
	throw lastError;
}

export async function sendPhoto(opts: SendPhotoOptions): Promise<TelegramMessage> {
	const form = new FormData();
	form.append("chat_id", opts.chatId);
	form.append("caption", opts.caption);
	form.append("parse_mode", "HTML");
	// Buffer's backing ArrayBufferLike can be a SharedArrayBuffer, which BlobPart
	// doesn't accept — copy into a plain Uint8Array first.
	form.append("photo", new Blob([new Uint8Array(opts.png)], { type: "image/png" }), "chart.png");
	return callTelegramApi<TelegramMessage>(opts.botToken, "sendPhoto", form);
}

export async function sendMessage(opts: SendMessageOptions): Promise<TelegramMessage> {
	const form = new FormData();
	form.append("chat_id", opts.chatId);
	form.append("text", opts.text);
	form.append("parse_mode", "HTML");
	return callTelegramApi<TelegramMessage>(opts.botToken, "sendMessage", form);
}

/** Best-effort: если сам алерт не ушёл, процесс из-за этого не роняем — только лог. */
export async function alertAdmin(opts: AlertAdminOptions): Promise<void> {
	try {
		await sendMessage({ botToken: opts.botToken, chatId: opts.adminChatId, text: opts.message });
	} catch (err) {
		console.error("[telegram] failed to alert admin:", err instanceof Error ? err.message : err);
	}
}
