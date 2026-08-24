// System + user messages for AiClient.generate() (section 4). System is the
// same static text every call — content changes only together with
// PROMPT_VERSION (tracked by the caller, step 5/6; this file doesn't read
// env at all). User is one JSON object, no prose around it, even on retry —
// the retry instruction is a field inside that same object, not a wrapper.
import type { AiPayload } from "./payload.js";
import { MAX_PARAGRAPH_LENGTH, type ValidationFailureReason } from "./validator.js";

/**
 * Section 4's system prompt: tone, bans, length, format — everything that
 * never changes per-day. MAX_PARAGRAPH_LENGTH is imported from validator.ts,
 * not restated as a literal here — the same number the validator enforces is
 * the one the model is told, so the two can never quietly drift apart.
 */
export function buildSystemPrompt(): string {
	return `Ты — автор ежедневного поста «Утро на рынке» для Telegram-канала о крипторынке. Тебе не показывают график и не показывают сырые данные — только уже посчитанные факты за сегодня (JSON во входном сообщении) и абзацы за несколько последних дней для контекста.

Твоя задача — написать два абзаца прозы:
- "picture" — картина дня: что произошло с роем монет сегодня.
- "observation" — наблюдение: живой комментарий о движении рынка, контраст с битком, сравнение с прошлыми днями и так далее.

ТОН. Живой, образный, с метафорами о движении денег и поведении роя монет. Можно сравнивать сегодняшний день с предыдущими из history. Никаких обращений к читателю («друзья», «ребята» и т.п.).

ЧИСЛА. В тексте разрешены только числа из списка allowedNumbers во входном JSON, ровно в том виде, в котором они там записаны, — скопируй нужную строку, не пересчитывай и не округляй сам. Никаких других чисел, включая приблизительные («около 40», «почти половина», «пара десятков») — если числа нет в allowedNumbers, о нём нельзя писать вообще.

НЕ ПОВТОРЯЙ СТРОКИ ПОСТА. Цена BTC, процент изменения BTC, а также тикеры и проценты лидера роста и лидера падения уже показаны отдельными строками поста рядом с твоим текстом — не пиши эти же цифры и тикеры ещё раз в абзацах, читатель уже их видел. Про биток и лидеров можно писать словами, без называния конкретной цены, процента или тикера («биток растёт», «один из лидеров вырвался особенно резко»).

ДНИ ПОДРЯД. Рядом со словами «день», «дня», «дней», «-й день», «сутки» никогда не должно стоять цифры — ни правильной, ни какой-либо ещё. Это правило про то, что стоит рядом со словом, а не про конкретное число: длина серии всегда пишется словом («второй день подряд», «третий день», «десятый день»), формы вида «2-й день» и «3 дня подряд» запрещены при любом числе.

ЗАПРЕЩЕНО: прогнозы («к вечеру», «пробьёт», «ожидается» и т.п.), советы купить/продать, обещания иксов, хэштеги, ссылки, HTML-теги, эмодзи.

ПУСТЫЕ ПОЛЯ. Если поле во входных данных равно null (например btc или prevState) — не упоминай его вообще и не придумывай значение взамен.

ПОВТОРЫ. В history — абзацы за последние дни. Не повторяй их образы и синтаксические конструкции, даже если состояние роя сегодня такое же. Если history пуст (пустой список) — значит контекста о прошлых днях нет вообще: не пиши и не придумывай ничего о том, что было раньше («после тишины», «на фоне спокойных дней», «как и накануне» и подобное). Пиши только о сегодняшнем дне.

ДЛИНА. Каждый абзац — не длиннее ${MAX_PARAGRAPH_LENGTH} символов.

ЯЗЫК. Только русский.

ФОРМАТ ОТВЕТА. Верни строго один JSON-объект и ничего кроме него — без текста до или после:
{"picture": "...", "observation": "...", "direction": "red" | "green" | "mixed"}
"direction" — твоя самостоятельная оценка того, куда сегодня идёт рынок, на основе фактов, а не подсказка.`;
}

/** One JSON object, no prose around it (section 3.1). */
export function buildUserPrompt(payload: AiPayload): string {
	return JSON.stringify(payload);
}

/**
 * Section 6: one retry, with a description of what went wrong appended to
 * the same JSON object the model already understands the shape of — never
 * the rejected picture/observation text itself, so the model rewrites
 * instead of patching its own wording. Keyed by the failure *reason*, not
 * the validator's free-text `detail` (which can itself embed a fragment of
 * the offending text, e.g. the disallowed number) — the instruction below is
 * always a fixed, generic sentence for that reason category.
 *
 * The streak-digit entry mirrors validator.ts's item 7 exactly: it bans a
 * digit next to день/дня/дней/сутки *in general*, not "don't write the
 * number {streak}" — that phrasing invites the model to read it as "avoid
 * this one specific digit", not "never use any digit here at all".
 */
const RETRY_INSTRUCTIONS: Record<ValidationFailureReason, string> = {
	invalid_json:
		"Предыдущий ответ не получилось разобрать как JSON-объект с полями picture, observation и direction. Верни только один валидный JSON-объект с этими тремя полями, без синтаксических ошибок.",
	"validator:numbers":
		"В предыдущем ответе встретилось число, которого нет в allowedNumbers. Используй только числа из этого списка, ровно в записанном там виде — ничего не добавляй, не округляй и не пересказывай приблизительно.",
	"validator:length": `Один из абзацев в предыдущем ответе оказался длиннее ${MAX_PARAGRAPH_LENGTH} символов. Сократи оба абзаца так, чтобы каждый уложился в этот лимит.`,
	"validator:forbidden_pattern":
		"В предыдущем ответе был запрещённый элемент — прогноз, совет купить/продать, обещание иксов, хэштег, ссылка, HTML-тег или эмодзи. Перепиши текст без него.",
	"validator:direction":
		"Поле direction в предыдущем ответе не совпало с реальным направлением рынка сегодня (см. swarmState во входных данных). Оцени направление ещё раз и укажи то, которое соответствует фактам.",
	"validator:empty_or_cutoff":
		"Один из абзацев в предыдущем ответе оказался пустым или обрывался на середине предложения. Напиши оба абзаца полностью, каждый — законченное предложение или несколько предложений.",
	"validator:streak_digit":
		"В предыдущем ответе рядом со словом «день», «дня», «дней» или «сутки» стояла цифра. Это запрещено при любой цифре — длина серии дней пишется только словом (второй, третий, десятый...), никогда цифрой, независимо от того, какое это число.",
	"validator:language": "Предыдущий ответ был не на русском языке (или содержал слишком много не-кириллических слов). Перепиши оба абзаца полностью на русском.",
};

export function buildRetryUserPrompt(payload: AiPayload, reason: ValidationFailureReason): string {
	return JSON.stringify({ ...payload, retryInstruction: RETRY_INSTRUCTIONS[reason] });
}
