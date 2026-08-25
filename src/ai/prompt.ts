// System + user messages for AiClient.generate() (section 4). System is the
// same static text every call — content changes only together with
// PROMPT_VERSION (tracked by the caller, step 5/6; this file doesn't read
// env at all). User is one JSON object, no prose around it, even on retry —
// the retry instruction is a field inside that same object, not a wrapper.
import type { AiPayload } from "./payload.js";
import { MAX_PARAGRAPH_LENGTH, type ObservationValidationFailureReason, type ValidationFailureReason } from "./validator.js";

/**
 * Section 4's system prompt: tone, bans, length, format — everything that
 * never changes per-day. MAX_PARAGRAPH_LENGTH is imported from validator.ts,
 * not restated as a literal here — the same number the validator enforces is
 * the one the model is told, so the two can never quietly drift apart.
 *
 * PROMPT_VERSION 7: one-paragraph contract. Paragraph 1 (picture) is now
 * entirely code-generated (render.ts's pickPicture) — the model writes only
 * "observation" and never sees or returns "picture" at all (not optional,
 * removed from the contract: an optional field a model can still choose to
 * fill is a field that eventually reappears in the post). ЧИСЛА and ДНИ
 * ПОДРЯД collapse to one line each — both rules are now "don't", full stop,
 * enforced by the validator's own any-digit/any-day-count checks (no
 * whitelist, no exceptions to spell out).
 *
 * PROMPT_VERSION 9: ДНИ ПОДРЯД gained a sentence closing the last version of
 * the same loophole PROMPT_VERSION 8's payload shrink (streak/dateLabel/
 * swarmState removed from the payload) didn't fully close — history's own
 * *length* (how many entries it has) is still visible to the model and
 * still countable, even with no field naming a count directly. ПОВТОРЫ
 * gained a sentence banning verb-construction reuse with swapped nouns
 * ("превращает тикер в …" with a different ticker each day is still the
 * same repeat), found live.
 */
export function buildSystemPrompt(): string {
	return `Ты — автор ежедневного поста «Утро на рынке» для Telegram-канала о крипторынке. Тебе не показывают график и не показывают сырые данные — только уже посчитанные факты за сегодня (JSON во входном сообщении) и твои наблюдения за несколько последних дней для контекста.

Твоя задача — написать один абзац прозы: "observation" — живой комментарий о движении рынка, контраст с битком, сравнение с прошлыми днями и так далее. Картину дня и все цифры поста пишет код, не ты.

ТОН. Живой, образный, с метафорами о движении денег и поведении роя монет. Можно сравнивать сегодняшний день с предыдущими из history. Никаких обращений к читателю («друзья», «ребята» и т.п.).

ЧИСЛА. Цифр в абзаце нет вовсе — все числа уже в посте выше.

НЕ ПОВТОРЯЙ ЦИФРЫ СТРОК ПОСТА. Цена BTC и процент изменения BTC, а также проценты изменения у лидера роста и лидера падения уже показаны отдельными строками поста рядом с твоим текстом — эти цифры (но не сами тикеры) не пиши ещё раз в абзаце, читатель уже их видел. Про биток пиши словами, без цены и процента («биток рванул вверх», «биток топчется на месте»). Тикеры лидеров называть можно и нужно — запрещено повторять только их проценты изменения (тикер TRAC в тексте — нормально, «TRAC вырос на 18%» — нет, это число уже показано отдельной строкой). dateLabel («18 августа» и подобное) — тоже чужая строка: дата уже стоит в заголовке поста, не пиши её в абзаце ни в каком виде, ни числом дня, ни названием месяца.

ДНИ ПОДРЯД. О номере дня не писать — это в первом абзаце. В history может лежать несколько текстов; их количество не означает длину серии — ни о номере дня, ни о самой серии не пиши ни словом, ни цифрой.

ЗАПРЕЩЕНО: прогнозы («к вечеру», «пробьёт», «ожидается» и т.п.), советы купить/продать, обещания иксов, хэштеги, ссылки, HTML-теги, эмодзи.

ПУСТЫЕ ПОЛЯ. Если поле во входных данных равно null (например btc или prevState) — не упоминай его вообще и не придумывай значение взамен.

ПОВТОРЫ. В history — твои наблюдения за последние дни. Не повторяй их образы и синтаксические конструкции, даже если состояние роя сегодня такое же. Это касается и глагольных конструкций отдельно: не переиспользуй их из history, даже подставив другие существительные — «превращает тикер в …» вчера и та же конструкция с другим тикером сегодня это тот же повтор, что дословное совпадение. Если history пуст (пустой список) — значит контекста о прошлых днях нет вообще: не пиши и не придумывай ничего о том, что было раньше («после тишины», «на фоне спокойных дней», «как и накануне» и подобное). Пустая history — повод молчать о прошлом, а не тема для абзаца: не пиши и о самом отсутствии данных («контекста нет», «сравнивать не с чем», «судим только по сегодняшнему срезу» и подобное) — это твоя внутренняя техническая деталь, читатель никогда не видит входной JSON и не должен даже заподозрить, что в нём есть такое поле. То же самое — про непустую history: сам механизм антиповтора тоже внутренняя техническая деталь, о ней не говорят вслух — не называй что-то повтором и не ссылайся на прошлые абзацы как на источник («вчерашний образ», «вчерашний сценарий», «уже использовано» и подобное), просто не повторяй, не объясняя вслух, что ты этого не делаешь. Пиши только о сегодняшнем дне.

ДЛИНА. Абзац — не длиннее ${MAX_PARAGRAPH_LENGTH} символов.

ЯЗЫК. Только русский.

ФОРМАТ ОТВЕТА. Верни строго один JSON-объект и ничего кроме него — без текста до или после:
{"observation": "...", "direction": "red" | "green" | "mixed"}
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
 *
 * Old two-paragraph contract (validateAiParagraphs). Not called by the
 * active PROMPT_VERSION 7 path — kept for a possible rollback, alongside
 * validateAiParagraphs and validator.ts's items 1/7/9/10 themselves.
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
	"validator:derived_numbers":
		"В предыдущем ответе была кратность или доля, посчитанная словами (например «вдвое», «в три раза», «половина», «треть») — такие числа модель не должна вычислять сама, даже если расчёт верный. Опиши то же самое либо без арифметики («заметно больше», «почти весь рой»), либо числом строго из allowedNumbers.",
	"validator:streak_word_mismatch":
		"В предыдущем ответе счёт дней подряд словом (например «третий день») не совпал с полем streak во входных данных. Считай длину серии только по streak, а не по количеству дней в history — назови её тем словом, которое соответствует именно этому числу.",
};

export function buildRetryUserPrompt(payload: AiPayload, reason: ValidationFailureReason): string {
	return JSON.stringify({ ...payload, retryInstruction: RETRY_INSTRUCTIONS[reason] });
}

/**
 * New one-paragraph contract (validateAiObservation, PROMPT_VERSION 7) —
 * the active retry path. Never echoes the rejected observation text itself,
 * same reasoning as RETRY_INSTRUCTIONS above.
 */
const RETRY_INSTRUCTIONS_OBSERVATION: Record<ObservationValidationFailureReason, string> = {
	invalid_json:
		'Предыдущий ответ не получилось разобрать как JSON-объект с полями observation и direction. Верни только один валидный JSON-объект вида {"observation": "...", "direction": "..."}, без синтаксических ошибок.',
	"validator:length": `Абзац в предыдущем ответе оказался длиннее ${MAX_PARAGRAPH_LENGTH} символов. Сократи его так, чтобы он уложился в этот лимит.`,
	"validator:forbidden_pattern":
		"В предыдущем ответе был запрещённый элемент — прогноз, совет купить/продать, обещание иксов, хэштег, ссылка, HTML-тег или эмодзи. Перепиши текст без него.",
	"validator:direction":
		"Поле direction в предыдущем ответе не совпало с реальным направлением рынка сегодня (см. swarmState во входных данных). Оцени направление ещё раз и укажи то, которое соответствует фактам.",
	"validator:empty_or_cutoff":
		"Абзац в предыдущем ответе оказался пустым или обрывался на середине предложения. Напиши его полностью — законченное предложение или несколько предложений.",
	"validator:language": "Предыдущий ответ был не на русском языке (или содержал слишком много не-кириллических слов). Перепиши абзац полностью на русском.",
	"validator:observation_digit":
		"В предыдущем ответе была цифра. В этом абзаце цифр не должно быть вовсе — все числа поста уже показаны отдельными строками, картину дня с числами пишет код, не ты.",
	"validator:observation_day_count":
		"В предыдущем ответе был назван номер дня (словом или цифрой). Про номер дня в этом абзаце не пишут — он в первом абзаце, который пишет код.",
	"validator:observation_ratio_mismatch":
		"В предыдущем ответе кратность (например «вдвое», «в три раза», «кратно») не совпала с реальным соотношением зелёных и красных монет. Опиши то же самое либо без числового смысла («подавляющее большинство», «почти весь рой»), либо кратностью, которая действительно соответствует реальному соотношению.",
};

export function buildRetryObservationPrompt(payload: AiPayload, reason: ObservationValidationFailureReason): string {
	return JSON.stringify({ ...payload, retryInstruction: RETRY_INSTRUCTIONS_OBSERVATION[reason] });
}
