// Tests for tools/ai-prompt.ts (the `npm run ai:prompt` CLI). Not to be
// confused with tests/ai-prompt.test.ts, which tests src/ai/prompt.ts itself
// — a pre-existing, unrelated file with a name that collides on "ai-prompt"
// only by coincidence.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAiPayload, stateHistoryToAiHistory } from "../src/ai/payload.js";
import { buildRetryObservationPrompt, buildSystemPrompt, buildUserPrompt } from "../src/ai/prompt.js";
import { computeFacts, type StateHistory } from "../src/facts.js";
import { loadSnapshotFromFile } from "../src/snapshot.js";
import { buildAiPromptOutput } from "../tools/ai-prompt.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");

function realDayPayload(historyEntries: string[] = []) {
	const snapshot = loadSnapshotFromFile(path.join(FIXTURES_DIR, "real-day.json"));
	const facts = computeFacts(snapshot, { days: [] });
	return buildAiPayload(facts, historyEntries);
}

describe("buildAiPromptOutput: never shows anything other than what generate.ts would actually send", () => {
	it("on real-day with no flags, system length matches buildSystemPrompt().length exactly", () => {
		const output = buildAiPromptOutput({ fixtureName: "real-day", historyDays: 0, retryReason: null });
		expect(output.system.length).toBe(buildSystemPrompt().length);
		expect(output.system).toBe(buildSystemPrompt());
	});

	it("on real-day with no flags, user matches buildUserPrompt(payload) verbatim", () => {
		const output = buildAiPromptOutput({ fixtureName: "real-day", historyDays: 0, retryReason: null });
		const payload = realDayPayload([]);
		expect(output.user).toBe(buildUserPrompt(payload));
	});

	it("accepts the fixture name with or without the .json suffix, identically", () => {
		const withSuffix = buildAiPromptOutput({ fixtureName: "real-day.json", historyDays: 0, retryReason: null });
		const withoutSuffix = buildAiPromptOutput({ fixtureName: "real-day", historyDays: 0, retryReason: null });
		expect(withSuffix.user).toBe(withoutSuffix.user);
		expect(withSuffix.system).toBe(withoutSuffix.system);
	});
});

describe("buildAiPromptOutput: --history=N goes through the exact same stateHistoryToAiHistory()/buildAiPayload() production calls", () => {
	it("--history=2 produces the same user JSON as manually calling stateHistoryToAiHistory on the same 2 most recent real days", () => {
		const previewFile = path.join(FIXTURES_DIR, "history", "prompt-preview.json");
		const full = JSON.parse(readFileSync(previewFile, "utf8")) as StateHistory;
		const twoMostRecent = [...full.days].sort((a, b) => a.date.localeCompare(b.date)).slice(-2);

		const snapshot = loadSnapshotFromFile(path.join(FIXTURES_DIR, "real-day.json"));
		const facts = computeFacts(snapshot, { days: [] });
		const expectedHistory = stateHistoryToAiHistory({ days: twoMostRecent }, facts.dateKey);
		const expectedPayload = buildAiPayload(facts, expectedHistory);

		const output = buildAiPromptOutput({ fixtureName: "real-day", historyDays: 2, retryReason: null });
		expect(output.user).toBe(buildUserPrompt(expectedPayload));
	});

	it("--history=0 (the default) sends an empty history array, same as a brand-new channel's first day", () => {
		const output = buildAiPromptOutput({ fixtureName: "real-day", historyDays: 0, retryReason: null });
		expect(JSON.parse(output.user).history).toEqual([]);
	});

	it("--history=3 (the max available) includes all three real days, newest first", () => {
		const output = buildAiPromptOutput({ fixtureName: "real-day", historyDays: 3, retryReason: null });
		const history = JSON.parse(output.user).history as string[];
		expect(history).toHaveLength(3);
	});

	it("rejects --history=N beyond the real days available, rather than silently truncating", () => {
		expect(() => buildAiPromptOutput({ fixtureName: "real-day", historyDays: 4, retryReason: null })).toThrow(/exceeds the 3 real days available/);
	});
});

describe("buildAiPromptOutput: --retry=<reason> prints buildRetryObservationPrompt's own output, not a hand-rolled approximation", () => {
	it("matches buildRetryObservationPrompt(payload, reason) verbatim for validator:observation_day_count", () => {
		const output = buildAiPromptOutput({ fixtureName: "real-day", historyDays: 0, retryReason: "validator:observation_day_count" });
		const payload = realDayPayload([]);
		expect(output.user).toBe(buildRetryObservationPrompt(payload, "validator:observation_day_count"));
	});

	it("matches buildRetryObservationPrompt(payload, reason) verbatim for validator:observation_ratio_mismatch too — not just the one reason tested above", () => {
		const output = buildAiPromptOutput({ fixtureName: "real-day", historyDays: 0, retryReason: "validator:observation_ratio_mismatch" });
		const payload = realDayPayload([]);
		expect(output.user).toBe(buildRetryObservationPrompt(payload, "validator:observation_ratio_mismatch"));
	});

	it("system is unaffected by --retry — only the user message changes on retry, same as production", () => {
		const plain = buildAiPromptOutput({ fixtureName: "real-day", historyDays: 0, retryReason: null });
		const retried = buildAiPromptOutput({ fixtureName: "real-day", historyDays: 0, retryReason: "validator:observation_digit" });
		expect(retried.system).toBe(plain.system);
	});
});

describe("buildAiPromptOutput: header and full text", () => {
	it("the header names the fixture and both block lengths, and fullText contains explicit SYSTEM/USER banners with no re-escaping", () => {
		const output = buildAiPromptOutput({ fixtureName: "real-day", historyDays: 0, retryReason: null });
		expect(output.header).toContain("Фикстура: real-day.json");
		expect(output.header).toContain(`Длина system: ${output.system.length} знаков`);
		expect(output.header).toContain(`Длина user: ${output.user.length} знаков`);
		expect(output.fullText).toContain("=== SYSTEM ===");
		expect(output.fullText).toContain("=== USER ===");
		// no re-escaping: the raw JSON text (with its own real quotes) appears
		// verbatim in fullText, not wrapped in an extra layer of JSON.stringify
		expect(output.fullText).toContain(output.user);
		expect(output.fullText).not.toContain(JSON.stringify(output.user));
	});
});
