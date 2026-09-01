// Единственный источник режима запуска — .env хранит только адреса, ключи и
// пороги, никогда режим (боевой/сухой/фикстура/реальный ИИ вне боя). Pure,
// без обращения к env/fs/process — index.ts не годится для прямого импорта
// в тест (у него собственные side-effects на уровне модуля, см. комментарий
// renderPost.ts), а разбор аргументов ровно поэтому вынесен сюда отдельно.
export type CliArgs = {
	/** --dry — сухой прогон: не публикует, не спрашивает модель по-настоящему, если не добавлен --ai. */
	dry: boolean;
	/** --force — боевой запуск в обход защиты от повторной публикации за тот же день. */
	force: boolean;
	/** --ai — единственный способ потратить деньги на реальный запрос к модели вне боевого запуска. Смысл имеет только вместе с --dry (см. index.ts/renderPost.ts); без --dry прод и так спрашивает модель по AI_ENABLED, флаг просто ничего не меняет. */
	ai: boolean;
	/** --fixture=<path> — путь к фикстуре снапшота вместо живого браузера. Допустим только вместе с --dry. */
	fixture: string | null;
};

const FIXTURE_PREFIX = "--fixture=";

/**
 * Бросает обычный Error с перечнем допустимых флагов на первом же
 * нераспознанном аргументе — раньше неизвестный флаг просто молча
 * игнорировался. Не трогает process/console: вызывающий (index.ts) сам
 * решает, как показать ошибку и завершиться, это делает функцию пригодной
 * для прямого юнит-теста через `expect(...).toThrow(...)`.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
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
		throw new Error(`unknown argument: "${arg}"\nallowed: --dry, --fixture=<path> (only with --dry), --ai (only with --dry), --force`);
	}

	// Боевой пост на выдуманных данных невозможен по построению — проверять
	// нечего, поэтому это ошибка запуска, а не тихий откат к браузеру.
	if (fixture !== null && !dry) {
		throw new Error("--fixture is only allowed together with --dry: a production run cannot use a fixture.");
	}

	return { dry, force, ai, fixture };
}
