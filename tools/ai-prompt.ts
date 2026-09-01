// Prints exactly what would go to the model — no network call, ever. This is
// the one tool in tools/ that must be safe to run with a dead/misconfigured
// AI_BASE_URL, no AI_API_KEY, or even offline: it never imports client.ts
// (no createAiClient, no fetch), so there is no transport to accidentally
// exercise. Deliberately narrow: it only ever calls the exact same functions
// generate.ts calls (buildSystemPrompt/buildUserPrompt/buildRetryObservationPrompt,
// buildAiPayload, stateHistoryToAiHistory) — no reimplementation, no
// preview-only branch, so what this prints can never quietly diverge from
// what a real run would send.
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildAiPayload, stateHistoryToAiHistory } from "../src/ai/payload.js";
import { buildRetryObservationPrompt, buildSystemPrompt, buildUserPrompt } from "../src/ai/prompt.js";
import type { ObservationValidationFailureReason } from "../src/ai/validator.js";
import { computeFacts, type StateHistory } from "../src/facts.js";
import { loadSnapshotFromFile } from "../src/snapshot.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");
const HISTORY_PREVIEW_FILE = path.join(FIXTURES_DIR, "history", "prompt-preview.json");
const MAX_HISTORY_DAYS = 3; // matches payload.ts's own MAX_HISTORY_DAYS_FOR_AI — see loadHistoryDays below

// Record, not a bare array literal: TypeScript rejects this object if
// ObservationValidationFailureReason ever gains or loses a member without
// this list being updated to match — an exhaustiveness check, not just a
// list that happens to agree with the type today.
const RETRY_REASON_SET: Record<ObservationValidationFailureReason, true> = {
	invalid_json: true,
	"validator:length": true,
	"validator:forbidden_pattern": true,
	"validator:direction": true,
	"validator:empty_or_cutoff": true,
	"validator:language": true,
	"validator:observation_digit": true,
	"validator:observation_day_count": true,
	"validator:observation_ratio_mismatch": true,
};
const VALID_RETRY_REASONS = Object.keys(RETRY_REASON_SET) as ObservationValidationFailureReason[];

function isValidRetryReason(reason: string): reason is ObservationValidationFailureReason {
	return reason in RETRY_REASON_SET;
}

export type AiPromptOptions = {
	/** With or without ".json" — same convention as ai:compare's fixture argument. */
	fixtureName: string;
	/** 0..3 — how many of fixtures/history/prompt-preview.json's real days to feed through stateHistoryToAiHistory(). 0 (the default) means no history at all, the same as a brand-new channel's first day. */
	historyDays: number;
	/** null prints buildUserPrompt(payload) (the normal first-attempt user message); set prints buildRetryObservationPrompt(payload, reason) instead — the exact message a real retry would send. */
	retryReason: ObservationValidationFailureReason | null;
};

export type AiPromptOutput = {
	system: string;
	user: string;
	header: string;
	/** header + both blocks, separated by explicit banner lines — exactly what gets printed to stdout or written to --out. */
	fullText: string;
};

/**
 * Loads exactly N of fixtures/history/prompt-preview.json's three real,
 * verbatim-accepted days (see that file's own _note) — chronologically the
 * most recent N, since stateHistoryToAiHistory() itself already sorts
 * newest-first and would only ever look at the most recent ones anyway.
 * Picking *which* real days count toward N is the only preview-specific
 * decision this tool makes; the actual date-filter/redaction/cap logic is
 * 100% stateHistoryToAiHistory() and buildAiPayload(), imported unchanged.
 */
function loadHistoryDays(n: number): StateHistory {
	if (n === 0) return { days: [] };
	if (!Number.isInteger(n) || n < 0) {
		throw new Error(`--history must be a non-negative integer, got: ${n}`);
	}
	const full = JSON.parse(readFileSync(HISTORY_PREVIEW_FILE, "utf8")) as StateHistory;
	if (n > full.days.length) {
		throw new Error(`--history=${n} exceeds the ${full.days.length} real days available in fixtures/history/prompt-preview.json`);
	}
	const sortedChronological = [...full.days].sort((a, b) => a.date.localeCompare(b.date));
	return { days: sortedChronological.slice(sortedChronological.length - n) };
}

function normalizeFixtureName(name: string): string {
	return name.endsWith(".json") ? name : `${name}.json`;
}

export function buildAiPromptOutput(opts: AiPromptOptions): AiPromptOutput {
	const fixtureFileName = normalizeFixtureName(opts.fixtureName);
	const snapshot = loadSnapshotFromFile(path.join(FIXTURES_DIR, fixtureFileName));
	// Streak/prevState (the only Facts fields computeFacts derives from
	// history) never reach AiPayload — dropped from it in PROMPT_VERSION 8 —
	// so what history computeFacts sees has zero effect on anything printed
	// below; only stateHistoryToAiHistory's own input (loadHistoryDays)
	// controls the payload's `history` field.
	const facts = computeFacts(snapshot, { days: [] });

	const historySource = loadHistoryDays(opts.historyDays);
	const aiHistory = stateHistoryToAiHistory(historySource, facts.dateKey);
	const payload = buildAiPayload(facts, aiHistory);

	const system = buildSystemPrompt();
	const user = opts.retryReason ? buildRetryObservationPrompt(payload, opts.retryReason) : buildUserPrompt(payload);

	const promptVersion = process.env.PROMPT_VERSION || "(не задан в .env — печатается как есть, PROMPT_VERSION при этом не читается ни prompt.ts, ни этим инструментом)";
	const headerLines = [
		`PROMPT_VERSION: ${promptVersion}`,
		`Фикстура: ${fixtureFileName}`,
		`Дней истории: ${opts.historyDays}${opts.historyDays > 0 ? ` (${aiHistory.length} реально попали в payload после stateHistoryToAiHistory())` : ""}`,
		opts.retryReason ? `Ретрай: ${opts.retryReason}` : "Ретрай: нет — обычный первый запрос",
		`Длина system: ${system.length} знаков`,
		`Длина user: ${user.length} знаков`,
	];
	const header = headerLines.join("\n");

	const fullText = [`=== HEADER ===`, header, ``, `=== SYSTEM ===`, system, ``, `=== USER ===`, user].join("\n");

	return { system, user, header, fullText };
}

// --- CLI entry point ---

type CliArgs = { fixtureName: string; historyDays: number; retryReason: ObservationValidationFailureReason | null; outFile: string | null };

function parseCliArgs(argv: string[]): CliArgs {
	let fixtureName = "real-day";
	let historyDays = 0;
	let retryReason: ObservationValidationFailureReason | null = null;
	let outFile: string | null = null;

	for (const arg of argv) {
		if (arg.startsWith("--fixture=")) {
			fixtureName = arg.slice("--fixture=".length);
		} else if (arg.startsWith("--history=")) {
			historyDays = Number(arg.slice("--history=".length));
		} else if (arg.startsWith("--retry=")) {
			const reason = arg.slice("--retry=".length);
			if (!isValidRetryReason(reason)) {
				throw new Error(`--retry must be one of: ${VALID_RETRY_REASONS.join(", ")} — got: ${reason}`);
			}
			retryReason = reason;
		} else if (arg.startsWith("--out=")) {
			outFile = arg.slice("--out=".length);
		} else {
			throw new Error(`unrecognized flag: ${arg} — usage: npm run ai:prompt -- [--fixture=<name>] [--history=N] [--retry=<reason>] [--out=<file>]`);
		}
	}

	return { fixtureName, historyDays, retryReason, outFile };
}

function main() {
	const args = parseCliArgs(process.argv.slice(2));
	const output = buildAiPromptOutput(args);

	// Printed as-is — no JSON.stringify, no template-literal re-escaping —
	// exactly the caption-copy-into-any-chat requirement: what's on screen
	// (or in --out) is the literal string that would leave the process.
	console.log(output.fullText);

	if (args.outFile) {
		const outPath = path.resolve(args.outFile);
		mkdirSync(path.dirname(outPath), { recursive: true });
		writeFileSync(outPath, output.fullText);
		console.log(`\n[ai:prompt] wrote ${outPath}`);
	}
}

// Same guard as ai-compare.ts's — importing this module for buildAiPromptOutput()
// (e.g. from a test) must never also run the CLI against that test's own argv.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
	try {
		main();
	} catch (err) {
		console.error("[ai:prompt] failed:", err instanceof Error ? err.message : err);
		process.exitCode = 1;
	}
}
