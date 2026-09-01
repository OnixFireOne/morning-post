import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cliArgs.js";

describe("parseArgs: mode is decided exclusively by CLI flags", () => {
	it("no flags — the real (non-dry) baseline: not dry, no force, no ai flag, no fixture", () => {
		expect(parseArgs([])).toEqual({ dry: false, force: false, ai: false, fixture: null });
	});

	it("--dry alone", () => {
		expect(parseArgs(["--dry"])).toEqual({ dry: true, force: false, ai: false, fixture: null });
	});

	it("--dry --fixture=<path>", () => {
		expect(parseArgs(["--dry", "--fixture=./fixtures/green.json"])).toEqual({
			dry: true,
			force: false,
			ai: false,
			fixture: "./fixtures/green.json",
		});
	});

	it("--dry --ai", () => {
		expect(parseArgs(["--dry", "--ai"])).toEqual({ dry: true, force: false, ai: true, fixture: null });
	});

	it("--force alone", () => {
		expect(parseArgs(["--force"])).toEqual({ dry: false, force: true, ai: false, fixture: null });
	});

	it("order of flags doesn't matter", () => {
		expect(parseArgs(["--ai", "--fixture=./fixtures/green.json", "--dry"])).toEqual({
			dry: true,
			force: false,
			ai: true,
			fixture: "./fixtures/green.json",
		});
	});

	it("--fixture= with nothing after it still parses as an (empty) string, not null — resolveSnapshotSource's own job to treat that as unset", () => {
		expect(parseArgs(["--dry", "--fixture="])).toEqual({ dry: true, force: false, ai: false, fixture: "" });
	});

	it("--fixture without --dry is a startup error — a real post on made-up data is impossible by construction", () => {
		expect(() => parseArgs(["--fixture=./fixtures/green.json"])).toThrow(/--dry/);
	});

	it("--fixture without --dry is still an error even alongside --force/--ai", () => {
		expect(() => parseArgs(["--force", "--ai", "--fixture=./fixtures/green.json"])).toThrow(/--dry/);
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
