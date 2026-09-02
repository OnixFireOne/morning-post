// The eternal daily log — one line per published day, append-only, never
// rotated (unlike state.json, which keeps only the last ~60 days). Same
// safe technique as usage.jsonl (mkdirSync + appendFileSync, one write per
// call) — not state.json's atomic-rename technique, which exists for a
// whole-file rewrite this file never does. Nobody reads this yet; it's
// written for future analysis, not for anything the app itself consumes.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Facts } from "./facts.js";

export type FactsLogEntry = {
	date: string;
	facts: Facts;
	/** Denormalized from facts.winners[0]/losers[0] — same data, just not requiring a reader to re-derive "who actually led" from the full leaderboard arrays every time. */
	topGainer: { ticker: string; change24h: number } | null;
	topLoser: { ticker: string; change24h: number } | null;
	source: "ai" | "ai_trimmed" | "template";
	model: string | null;
	/** The upstream inference backend that actually answered (RenderedPost.responseProvider) — null on "template", or when the provider doesn't report one. Section 5 of the 26.08 provider migration: "provider и model из ответа" recorded here alongside model, not just model as before. */
	provider: string | null;
	promptVersion: number | null;
	/**
	 * How many requests this day's AI attempt took, null when AI was never
	 * attempted at all (AI_ENABLED=0) — mirrors RenderedPost.attempts. Added
	 * 02.09: without this, a day recovered by a same-model retry (e.g. a
	 * malformed invalid_json first response) is indistinguishable here from a
	 * clean first-try success — both show source: "ai" and no failureReason.
	 * usage.jsonl already has this per-attempt, but only facts.jsonl carries
	 * it alongside the day's own facts for at-a-glance reading.
	 */
	attempts: number | null;
};

export function formatFactsLogLine(entry: FactsLogEntry): string {
	return JSON.stringify(entry);
}

export function appendFactsLogLine(filePath: string, entry: FactsLogEntry): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	appendFileSync(filePath, `${formatFactsLogLine(entry)}\n`);
}
