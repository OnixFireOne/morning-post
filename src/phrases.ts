// Словарь фраз по веткам (раздел 4.2). Логика ветвления живёт в render.ts —
// этот файл только формулировки, чтобы их можно было править не трогая код.
import type { Facts } from "./facts.js";
import { formatMagnitude, formatSignedPercent, plural, verbForm } from "./format.js";

// Формы объявлены один раз здесь — шаблоны ниже никогда не зашивают
// "монета"/"монеты"/"монет", "день"/"дня"/"дней" или глаголы/причастия рядом
// со счётчиком строками напрямую, только через plural()/verbForm().
const COIN_FORMS = ["монета", "монеты", "монет"] as const;
const DAY_FORMS = ["день", "дня", "дней"] as const;
const coins = (n: number) => plural(n, COIN_FORMS);
const days = (n: number) => plural(n, DAY_FORMS);

// Глаголы/причастия рядом со счётчиком — двухформенное согласование
// (verbForm), не то же самое, что три формы существительного (plural()).
// falls/grows идут с "красным"/"зелёным" счётчиком соответственно (падают —
// красные монеты, растут — зелёные); rising/falling — родительный падеж
// после "против" ("против 21 растущей", "против 11 растущих").
const FALLS_FORMS = ["падает", "падают"] as const;
const GROWS_FORMS = ["растёт", "растут"] as const;
const HOLDS_FORMS = ["держится", "держатся"] as const;
const REMAINS_FORMS = ["остаётся", "остаются"] as const;
const RISING_FORMS = ["растущей", "растущих"] as const;
const FALLING_FORMS = ["падающей", "падающих"] as const;
const falls = (n: number) => verbForm(n, FALLS_FORMS);
const grows = (n: number) => verbForm(n, GROWS_FORMS);
const holds = (n: number) => verbForm(n, HOLDS_FORMS);
const remains = (n: number) => verbForm(n, REMAINS_FORMS);
const rising = (n: number) => verbForm(n, RISING_FORMS);
const falling = (n: number) => verbForm(n, FALLING_FORMS);

function dayOfYear(dateKey: string): number {
	const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
	const start = Date.UTC(y, 0, 1);
	const current = Date.UTC(y, m - 1, d);
	return Math.floor((current - start) / 86_400_000) + 1;
}

/** Детерминированный выбор варианта по дате — воспроизводимо в тестах, не повторяется два дня подряд. */
export function pickVariant<T>(variants: readonly T[], dateKey: string): T {
	if (variants.length === 0) throw new Error("pickVariant: empty variants list");
	const idx = dayOfYear(dateKey) % variants.length;
	return variants[idx] as T;
}

const ORDINAL_WORDS_RU = [
	"",
	"Первый",
	"Второй",
	"Третий",
	"Четвёртый",
	"Пятый",
	"Шестой",
	"Седьмой",
	"Восьмой",
	"Девятый",
	"Десятый",
	"Одиннадцатый",
	"Двенадцатый",
	"Тринадцатый",
	"Четырнадцатый",
	"Пятнадцатый",
] as const;

/** Word ordinal for the red-streak paragraph ("Второй день подряд…"); falls back to "N-й" past 15. */
export function ordinalWordRu(n: number): string {
	return ORDINAL_WORDS_RU[n] || `${n}-й`;
}

type PhraseVariant = (facts: Facts) => string;

// --- Абзац 1: картина дня ---

export const RED_STREAK_VARIANTS: readonly PhraseVariant[] = [
	(f) =>
		`${ordinalWordRu(f.streak)} день подряд рой красный: биток медленно сползает, большинство монет в минусе — ${f.red} ${falls(f.red)} против ${f.green} ${rising(f.green)} в основном рое.`,
	(f) =>
		`${ordinalWordRu(f.streak)} день подряд рынок в минусе: ${f.red} ${coins(f.red)} ${falls(f.red)}, только ${f.green} ${holds(f.green)} в плюсе.`,
	(f) =>
		`Красная серия не отпускает: уже ${f.streak} ${days(f.streak)} подряд рой в минусе — ${f.red} ${coins(f.red)} ${falls(f.red)} против ${f.green} ${rising(f.green)}.`,
];

export const RED_STREAK_SHORT: PhraseVariant = (f) => `Красный рой уже ${f.streak} ${days(f.streak)} подряд: ${f.red} против ${f.green}.`;

export const RED_FIRST_VARIANTS: readonly PhraseVariant[] = [
	(f) => `Рой развернулся в минус: ${f.red} ${coins(f.red)} ${falls(f.red)} против ${f.green} ${rising(f.green)}.`,
	(f) => `После зелёных дней рой покраснел: ${f.red} ${coins(f.red)} в минусе, ${f.green} ${holds(f.green)} в плюсе.`,
	(f) => `Разворот вниз: ${falls(f.red)} ${f.red} ${coins(f.red)}, ${grows(f.green)} только ${f.green}.`,
];

export const RED_FIRST_SHORT: PhraseVariant = (f) => `Рой в минусе: ${f.red} против ${f.green}.`;

export const GREEN_STREAK_VARIANTS: readonly PhraseVariant[] = [
	(f) => `${f.streak}-й день рой держится в зелёном: ${f.green} ${coins(f.green)} в плюсе против ${f.red} ${falling(f.red)}.`,
	(f) => `Зелёная серия продолжается — ${f.streak}-й день подряд: ${f.green} ${coins(f.green)} ${grows(f.green)}, ${f.red} в минусе.`,
	(f) => `Рой зеленеет уже ${f.streak} ${days(f.streak)} подряд: в плюсе ${f.green} ${coins(f.green)}, в минусе ${f.red}.`,
];

export const GREEN_STREAK_SHORT: PhraseVariant = (f) => `Зелёный рой уже ${f.streak} ${days(f.streak)} подряд: ${f.green} против ${f.red}.`;

export const GREEN_FIRST_VARIANTS: readonly PhraseVariant[] = [
	(f) => `Рой зеленеет после падения: ${f.green} ${coins(f.green)} в плюсе против ${f.red} в минусе.`,
	(f) => `Рынок развернулся вверх: ${f.green} ${coins(f.green)} ${grows(f.green)}, ${f.red} ${remains(f.red)} в минусе.`,
	(f) => `Зелёный разворот: в плюсе ${f.green} ${coins(f.green)} против ${f.red} ${falling(f.red)}.`,
];

export const GREEN_FIRST_SHORT: PhraseVariant = (f) => `Рой зеленеет: ${f.green} против ${f.red}.`;

export const MIXED_VARIANTS: readonly PhraseVariant[] = [
	(f) => `Рынок разошёлся: ${f.green} ${coins(f.green)} в плюсе, ${f.red} в минусе — единого направления нет.`,
	(f) => `Ни одного явного тренда: ${f.green} ${coins(f.green)} ${grows(f.green)}, ${f.red} ${falls(f.red)} почти поровну.`,
	(f) => `Рой разбрёлся в разные стороны: ${f.green} в плюсе против ${f.red} в минусе.`,
];

export const MIXED_SHORT: PhraseVariant = (f) => `Разброс: ${f.green} в плюсе, ${f.red} в минусе.`;

// --- Абзац 2: наблюдение ---
// BTC_LEADS и NEUTRAL_WITH_BTC читают facts.btc напрямую: render.ts выбирает эти
// ветки только когда facts.btc уже проверен на не-null (см. pickObservation).

export const QUIET_DUMP_VARIANTS: readonly PhraseVariant[] = [
	(f) =>
		`Интересно, что рынок падает без паники: биток теряет доли процента, а альты по краям роя штормит на ±${formatMagnitude(f.maxAbsEdgeChange)}%. Классическая картина «тихого» слива — деньги не уходят с рынка, а перебегают между монетами.`,
	(f) =>
		`Биток почти не шевелится, а на краях роя штормит на ±${formatMagnitude(f.maxAbsEdgeChange)}% — деньги явно перетекают между монетами, а не покидают рынок.`,
	(f) =>
		`Тихий день для битка и бурный для альтов: колебания на краях роя доходят до ±${formatMagnitude(f.maxAbsEdgeChange)}%, пока биток топчется на месте.`,
];

export const BTC_LEADS_VARIANTS: readonly PhraseVariant[] = [
	(f) => `Движение ведёт биток: его ${formatSignedPercent(f.btc!.change24h)} тянет за собой весь рой.`,
	(f) => `Биток задаёт тон рынку — при ${formatSignedPercent(f.btc!.change24h)} альты синхронно повторяют его движение.`,
	(f) => `Рынок двигается вслед за битком: ${formatSignedPercent(f.btc!.change24h)} по BTC отражается на всём рое.`,
];

export const CALM_DAY_VARIANTS: readonly PhraseVariant[] = [
	(f) => `Спокойный день: даже на краях роя никто не вышел за ±${formatMagnitude(f.maxAbsEdgeChange)}%.`,
	(f) => `Волатильность на минимуме: максимальное движение на краях роя — ±${formatMagnitude(f.maxAbsEdgeChange)}%.`,
	(f) => `Рынок в штиле: даже самые резкие монеты на краях роя не превысили ±${formatMagnitude(f.maxAbsEdgeChange)}%.`,
];

export const NEUTRAL_WITH_BTC_VARIANTS: readonly PhraseVariant[] = [
	(f) => `Контраст дня: биток двигается на ${formatSignedPercent(f.btc!.change24h)}, пока альты на краях роя разбегаются заметно шире.`,
	(f) => `Биток держится спокойнее рынка — его ${formatSignedPercent(f.btc!.change24h)} против куда более резких скачков на краях роя.`,
	(f) => `Пока биток меняется на ${formatSignedPercent(f.btc!.change24h)}, альты на краях роя двигаются размашистее.`,
];

export const NEUTRAL_NO_BTC_VARIANTS: readonly PhraseVariant[] = [
	(f) => `Данных по битку сегодня нет, но альты на краях роя двигаются заметно — до ±${formatMagnitude(f.maxAbsEdgeChange)}%.`,
	(f) => `Биток выпал из снапшота, зато на краях роя есть движение — колебания доходят до ±${formatMagnitude(f.maxAbsEdgeChange)}%.`,
	(f) => `Без данных по битку картину дня определяют альты: на краях роя движение доходит до ±${formatMagnitude(f.maxAbsEdgeChange)}%.`,
];
