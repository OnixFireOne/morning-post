// Append-only accounting for every AI attempt (section 3.2) — one line per
// attempt, successful or not, never rewritten. Kept separate from generate.ts
// so the pricing rule (tariff by the model that actually answered *this*
// attempt, not the primary) is a small, independently testable pure function
// rather than buried in the orchestration loop.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AiUsage } from "./client.js";

export type UsageRecord = {
	timestamp: string;
	attempt: number;
	provider: string;
	model: string;
	promptVersion: number;
	tokensIn: number | null;
	tokensOut: number | null;
	tokensTotal: number | null;
	/** null when the provider doesn't report cache stats — distinct from 0 cached tokens. */
	cachedTokens: number | null;
	/** false when the provider omitted the usage block entirely for this attempt. */
	usageReported: boolean;
	durationMs: number;
	/** "ok" | "invalid_json" | "validator:<reason>" | "timeout" | "http_<code>" | "network_error". */
	outcome: string;
	finishReason: string | null;
	/** null unless both AI_PRICE_IN/AI_PRICE_OUT (for whichever model answered) are set AND usage was reported. */
	costEstimate: number | null;
	/** true only when DRY_RUN=1 and the request was explicitly allowed via AI_ALLOW_REAL_IN_DRY=1 (section 3.4) — a manual obkatka spend, not a real morning post. Records from before this field existed have no key at all; readers must treat a missing value as false (production), never rewrite the line to add it. */
	dryRun: boolean;
};

/**
 * Priced by the model that actually produced *this* attempt — call with that
 * model's own price knobs (AI_PRICE_IN/OUT for the primary, AI_FALLBACK_PRICE_IN/OUT
 * for the fallback), never the primary's unconditionally. A fallback attempt
 * costed at the primary's (usually cheaper) rate would understate exactly the
 * days that actually cost the most — the ones where the fallback had to run.
 */
export function computeCost(usage: AiUsage | null, priceInPerMillion: number | null, priceOutPerMillion: number | null): number | null {
	if (!usage || priceInPerMillion === null || priceOutPerMillion === null) return null;
	return (usage.promptTokens / 1_000_000) * priceInPerMillion + (usage.completionTokens / 1_000_000) * priceOutPerMillion;
}

export function formatUsageLine(record: UsageRecord): string {
	return JSON.stringify(record);
}

export function appendUsageLine(filePath: string, record: UsageRecord): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	appendFileSync(filePath, `${formatUsageLine(record)}\n`);
}
