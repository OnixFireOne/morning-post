// Единственный источник режима запуска — .env хранит только адреса, ключи и
// пороги, никогда режим (боевой/сухой/фикстура/реальный ИИ вне боя). Pure,
// без обращения к env/fs/process — index.ts не годится для прямого импорта
// в тест (у него собственные side-effects на уровне модуля, см. комментарий
// renderPost.ts), а разбор аргументов ровно поэтому вынесен сюда отдельно.
export type CliArgs = {
	/** --help/-h — печатает справку и завершает процесс кодом 0, ничего не запуская. Когда true, остальные поля не несут смысла (парсинг короткого замыкается на первом --help/-h, дальше аргументы не разбираются). */
	help: boolean;
	/** --dry — сухой прогон: не публикует, не спрашивает модель по-настоящему, если не добавлен --ai. */
	dry: boolean;
	/** --force — боевой запуск в обход защиты от повторной публикации за тот же день. */
	force: boolean;
	/** --ai — единственный способ потратить деньги на реальный запрос к модели вне боевого запуска. Допустим только вместе с --dry: без него — ошибка запуска (в бою ИИ и так управляется AI_ENABLED, флаг там был бы обманчив, а не просто бесполезен). */
	ai: boolean;
	/** --fixture=<path> — путь к фикстуре снапшота вместо живого браузера. Допустим только вместе с --dry. */
	fixture: string | null;
};

const FIXTURE_PREFIX = "--fixture=";

/**
 * Единственный источник текста для --help и для перечня допустимых флагов в
 * ошибке о неизвестном аргументе — оба читаются отсюда (formatFlagHelp), а
 * не дублируют список руками в двух местах, где он рано или поздно
 * разъедется.
 */
const FLAG_HELP: readonly { flag: string; description: string }[] = [
	{ flag: "--dry", description: "dry run: live site, no AI, no publish" },
	{ flag: "--dry --ai", description: "dry run with a real AI request — the only way to spend money outside a production run" },
	{ flag: "--dry --fixture=<path>", description: "dry run against a snapshot fixture instead of the live browser" },
	{ flag: "--force", description: "production run, bypassing the same-day republish guard" },
	{ flag: "--help, -h", description: "print this list and exit" },
];

function formatFlagHelp(): string {
	return FLAG_HELP.map(({ flag, description }) => `  ${flag} — ${description}`).join("\n");
}

/** Exported so index.ts can print the exact same text on --help/-h — see FLAG_HELP's own comment on why this and the unknown-argument error share one source. */
export function formatHelpText(): string {
	return `usage: tsx src/index.ts [flags]\n\n${formatFlagHelp()}\n\nno flags at all means a real production run: live site, AI per AI_ENABLED, publishes.`;
}

/**
 * Бросает обычный Error с перечнем допустимых флагов на первом же
 * нераспознанном аргументе — раньше неизвестный флаг просто молча
 * игнорировался. Не трогает process/console: вызывающий (index.ts) сам
 * решает, как показать ошибку и завершиться, это делает функцию пригодной
 * для прямого юнит-теста через `expect(...).toThrow(...)`.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
	// --help/-h short-circuits everything else — standard CLI convention
	// (e.g. `git commit --help --nonsense` still shows help, never errors on
	// the nonsense flag). Checked before the main loop, not folded into it.
	if (argv.includes("--help") || argv.includes("-h")) {
		return { help: true, dry: false, force: false, ai: false, fixture: null };
	}

	let dry = false;
	let force = false;
	let ai = false;
	let fixture: string | null = null;

	for (const arg of argv) {
		if (arg === "--dry") {
			dry = true;
			continue;
		}
		if (arg === "--force") {
			force = true;
			continue;
		}
		if (arg === "--ai") {
			ai = true;
			continue;
		}
		if (arg.startsWith(FIXTURE_PREFIX)) {
			fixture = arg.slice(FIXTURE_PREFIX.length);
			continue;
		}
		throw new Error(`unknown argument: "${arg}"\nallowed:\n${formatFlagHelp()}`);
	}

	// Боевой пост на выдуманных данных невозможен по построению — проверять
	// нечего, поэтому это ошибка запуска, а не тихий откат к браузеру.
	if (fixture !== null && !dry) {
		throw new Error("--fixture is only allowed together with --dry: a production run cannot use a fixture.");
	}

	// Раньше текст ошибки уже утверждал это ("--ai (only with --dry)"), но
	// проверки не было — флаг в бою просто молча ничего не делал. Теперь это
	// правда: в бою ИИ управляется исключительно AI_ENABLED, флаг здесь не
	// просто бесполезен, а вводит в заблуждение, поэтому это ошибка запуска,
	// а не тихий no-op.
	if (ai && !dry) {
		throw new Error("--ai is only allowed together with --dry: in a production run, AI is controlled by AI_ENABLED instead.");
	}

	return { help: false, dry, force, ai, fixture };
}
