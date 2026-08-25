import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildReportBaseName, resolveUniqueReportPath } from "../tools/ai-compare.js";

function withTmpDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(path.join(tmpdir(), "morning-post-report-name-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("buildReportBaseName", () => {
	const startedAt = new Date("2026-08-25T09:45:45.987Z");

	it("formats as compare-<date>-<HHMM>-<model>-<fixture>.md, HHMM sliced from the same instant", () => {
		expect(buildReportBaseName(startedAt, "claude-sonnet-4-7", "green", null)).toBe("compare-2026-08-25-0945-claude-sonnet-4-7-green.md");
	});

	it("uses 'all' as the fixture label for an --all run", () => {
		expect(buildReportBaseName(startedAt, "claude-sonnet-4-7", "all", null)).toBe("compare-2026-08-25-0945-claude-sonnet-4-7-all.md");
	});

	it("appends -chainN when a chain length is given", () => {
		expect(buildReportBaseName(startedAt, "claude-sonnet-4-7", "green", 3)).toBe("compare-2026-08-25-0945-claude-sonnet-4-7-green-chain3.md");
	});

	it("sanitizes unsafe characters in the model id, same as the old filename scheme did", () => {
		expect(buildReportBaseName(startedAt, "some/weird:model id", "green", null)).toBe("compare-2026-08-25-0945-some_weird_model_id-green.md");
	});

	it("two runs a minute apart get different HHMM, and thus different base names, without needing the collision suffix at all", () => {
		const later = new Date("2026-08-25T09:46:45.987Z");
		expect(buildReportBaseName(startedAt, "m", "green", null)).not.toBe(buildReportBaseName(later, "m", "green", null));
	});
});

describe("resolveUniqueReportPath", () => {
	it("returns dir/baseName unchanged when nothing is there yet", () => {
		withTmpDir((dir) => {
			const resolved = resolveUniqueReportPath(dir, "compare-2026-08-25-0945-m-green.md");
			expect(resolved).toBe(path.join(dir, "compare-2026-08-25-0945-m-green.md"));
		});
	});

	it("returns a -2 suffixed name when the base path is already taken, and never touches the existing file", () => {
		withTmpDir((dir) => {
			const baseName = "compare-2026-08-25-0945-m-green.md";
			const original = path.join(dir, baseName);
			writeFileSync(original, "first run's real report — must survive");

			const resolved = resolveUniqueReportPath(dir, baseName);

			expect(resolved).toBe(path.join(dir, "compare-2026-08-25-0945-m-green-2.md"));
			expect(existsSync(resolved)).toBe(false); // resolver only picks a name, never writes
			expect(readFileSync(original, "utf8")).toBe("first run's real report — must survive");
		});
	});

	it("keeps incrementing (-2, -3, ...) past however many suffixed names are already taken", () => {
		withTmpDir((dir) => {
			const baseName = "compare-2026-08-25-0945-m-green.md";
			writeFileSync(path.join(dir, baseName), "run 1");
			writeFileSync(path.join(dir, "compare-2026-08-25-0945-m-green-2.md"), "run 2");
			writeFileSync(path.join(dir, "compare-2026-08-25-0945-m-green-3.md"), "run 3");

			const resolved = resolveUniqueReportPath(dir, baseName);

			expect(resolved).toBe(path.join(dir, "compare-2026-08-25-0945-m-green-4.md"));
			// none of the three pre-existing runs got clobbered by the search itself
			expect(readFileSync(path.join(dir, baseName), "utf8")).toBe("run 1");
			expect(readFileSync(path.join(dir, "compare-2026-08-25-0945-m-green-2.md"), "utf8")).toBe("run 2");
			expect(readFileSync(path.join(dir, "compare-2026-08-25-0945-m-green-3.md"), "utf8")).toBe("run 3");
		});
	});

	it("full round-trip: writing to the resolved path never overwrites the original occupied file", () => {
		withTmpDir((dir) => {
			const baseName = "compare-2026-08-25-0945-m-green.md";
			const original = path.join(dir, baseName);
			writeFileSync(original, "the paid run this test must not lose");

			const resolved = resolveUniqueReportPath(dir, baseName);
			writeFileSync(resolved, "second run, different content");

			expect(readFileSync(original, "utf8")).toBe("the paid run this test must not lose");
			expect(readFileSync(resolved, "utf8")).toBe("second run, different content");
		});
	});
});
