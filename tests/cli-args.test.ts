import { describe, expect, it } from "vitest";
import { formatHelpText, parseArgs } from "../src/cliArgs.js";

describe("parseArgs: mode is decided exclusively by CLI flags", () => {
	it("no flags — the real (non-dry) baseline: not dry, no force, no ai flag, no fixture", () => {
		expect(parseArgs([])).toEqual({ help: false, dry: false, force: false, ai: false, fixture: null });
	});

	it("--dry alone", () => {
		expect(parseArgs(["--dry"])).toEqual({ help: false, dry: true, force: false, ai: false, fixture: null });
	});

	it("--dry --fixture=<path>", () => {
		expect(parseArgs(["--dry", "--fixture=./fixtures/green.json"])).toEqual({
			help: false,
			dry: true,
			force: false,
			ai: false,
			fixture: "./fixtures/green.json",
		});
	});

	it("--dry --ai", () => {
		expect(parseArgs(["--dry", "--ai"])).toEqual({ help: false, dry: true, force: false, ai: true, fixture: null });
	});

	it("--force alone", () => {
		expect(parseArgs(["--force"])).toEqual({ help: false, dry: false, force: true, ai: false, fixture: null });
	});

	it("order of flags doesn't matter", () => {
		expect(parseArgs(["--ai", "--fixture=./fixtures/green.json", "--dry"])).toEqual({
			help: false,
			dry: true,
			force: false,
			ai: true,
			fixture: "./fixtures/green.json",
		});
	});

	it("--fixture= with nothing after it still parses as an (empty) string, not null — resolveSnapshotSource's own job to treat that as unset", () => {
		expect(parseArgs(["--dry", "--fixture="])).toEqual({ help: false, dry: true, force: false, ai: false, fixture: "" });
	});

	it("--fixture without --dry is a startup error — a real post on made-up data is impossible by construction", () => {
		expect(() => parseArgs(["--fixture=./fixtures/green.json"])).toThrow(/--dry/);
	});

	it("--fixture without --dry is still an error even alongside --force", () => {
		expect(() => parseArgs(["--force", "--fixture=./fixtures/green.json"])).toThrow(/--dry/);
	});

	it("an unknown flag fails with the list of allowed ones, not a silent ignore", () => {
		expect(() => parseArgs(["--publish"])).toThrow(/unknown argument.*--publish/);
		expect(() => parseArgs(["--publish"])).toThrow(/--dry/);
		expect(() => parseArgs(["--publish"])).toThrow(/--fixture/);
		expect(() => parseArgs(["--publish"])).toThrow(/--ai/);
		expect(() => parseArgs(["--publish"])).toThrow(/--force/);
	});

	it("a bare positional argument (no leading --) is also an unknown argument — --fixture=<path> is the only way to pass a path now", () => {
		expect(() => parseArgs(["fixtures/green.json"])).toThrow(/unknown argument/);
	});

	it("an unknown flag is caught even mixed in with valid ones", () => {
		expect(() => parseArgs(["--dry", "--typo", "--ai"])).toThrow(/unknown argument.*--typo/);
	});
});

// 02.09: the error text already claimed "--ai (only with --dry)", but
// nothing actually checked it — --ai alone in a production run was silently
// ignored, letting the flag lie about what it does. Now it's an honest
// startup error, matching --fixture's own (already-enforced) rule.
describe("parseArgs: --ai without --dry is a startup error, not a silent no-op", () => {
	it("--ai alone (no --dry) fails, explaining that AI_ENABLED controls a production run instead", () => {
		expect(() => parseArgs(["--ai"])).toThrow(/--ai/);
		expect(() => parseArgs(["--ai"])).toThrow(/--dry/);
		expect(() => parseArgs(["--ai"])).toThrow(/AI_ENABLED/);
	});

	it("--ai without --dry is still an error even alongside --force", () => {
		expect(() => parseArgs(["--force", "--ai"])).toThrow(/--dry/);
	});

	it("--dry --ai together is fine — this is the one legitimate use", () => {
		expect(() => parseArgs(["--dry", "--ai"])).not.toThrow();
	});
});

describe("parseArgs: --help / -h", () => {
	it("--help alone returns help: true and doesn't throw", () => {
		expect(parseArgs(["--help"])).toEqual({ help: true, dry: false, force: false, ai: false, fixture: null });
	});

	it("-h alone returns help: true too", () => {
		expect(parseArgs(["-h"])).toEqual({ help: true, dry: false, force: false, ai: false, fixture: null });
	});

	it("--help short-circuits before any other validation — an otherwise-invalid combination never throws when --help is present", () => {
		// --fixture without --dry would normally throw; --ai without --dry too;
		// an unknown flag would normally throw — none of that matters once
		// --help is in argv at all, standard CLI convention (e.g. `git commit
		// --help --nonsense` still shows help).
		expect(() => parseArgs(["--help", "--fixture=./x.json"])).not.toThrow();
		expect(() => parseArgs(["--ai", "--help"])).not.toThrow();
		expect(() => parseArgs(["--nonsense", "-h"])).not.toThrow();
		expect(parseArgs(["--nonsense", "-h"]).help).toBe(true);
	});
});

// The unknown-argument error and --help must never drift apart — both read
// FLAG_HELP through the same formatFlagHelp() (see cliArgs.ts). This checks
// the observable consequence: every flag documented in --help's own output
// also appears in the unknown-argument error text.
describe("formatHelpText and the unknown-argument error share one source, not two hand-kept lists", () => {
	it("formatHelpText lists every real flag with a description, plus a usage line", () => {
		const help = formatHelpText();
		expect(help).toMatch(/usage:/);
		expect(help).toContain("--dry");
		expect(help).toContain("--force");
		expect(help).toContain("--ai");
		expect(help).toContain("--fixture=<path>");
		expect(help).toContain("--help, -h");
		// every flag line pairs the flag with a one-line explanation, not a bare name
		expect(help).toMatch(/--dry —.+\n/);
	});

	it("every flag named in --help's output also appears in the unknown-argument error", () => {
		const help = formatHelpText();
		let unknownArgError = "";
		try {
			parseArgs(["--definitely-not-a-real-flag"]);
		} catch (err) {
			unknownArgError = err instanceof Error ? err.message : String(err);
		}
		for (const flag of ["--dry", "--force", "--ai", "--fixture=<path>", "--help, -h"]) {
			expect(help, `--help is missing ${flag}`).toContain(flag);
			expect(unknownArgError, `unknown-argument error is missing ${flag}`).toContain(flag);
		}
	});
});
