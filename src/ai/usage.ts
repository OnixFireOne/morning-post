// Append-only accounting for every AI attempt (section 3.2) — one line per
// attempt, successful or not, never rewritten. Pricing itself lives in
// providers.ts's computeAttemptCost (the one function that reads costSource/
// priceTable/inputOverhead) — this file only shapes and writes the resulting
// record, it doesn't compute anything.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AiCostSource } from "./providers.js";

export type UsageRecord = {
	timestamp: string;
	attempt: number;
	/** Host actually called (client.ts's providerHost) — "openrouter.ai" today, not the AI_PROVIDER profile name (see providerName below) or the upstream backend OpenRouter itself routed to (see responseProvider). */
	provider: string;
	model: string;
	/** The AI_PROVIDER profile's own name field (see providers.ts) that produced this attempt — written so a day's line is self-describing without cross-referencing .env history. */
	providerName: string;
	/** Which upstream inference backend actually answered, straight from the response body (OpenRouter-specific; null for a provider that doesn't report it, or on any transport failure). Distinct from `provider` (the host we called) and `providerName` (which profile we're configured for). */
	responseProvider: string | null;
	/** The model id the response itself echoes back, which can differ from the requested `model` under routing/aliasing — null when the response doesn't carry one (e.g. any transport failure). */
	responseModel: string | null;
	promptVersion: number;
	tokensIn: number | null;
	tokensOut: number | null;
	tokensTotal: number | null;
	/** null when the provider doesn't report cache stats — distinct from 0 cached tokens. */
	cachedTokens: number | null;
	/** false when the provider omitted the usage block entirely for this attempt. */
	usageReported: boolean;
	durationMs: number;
	/** "ok" | "invalid_json" | "validator:<reason>" | "timeout" | "http_<code>" | "network_error" | "empty_response" (plan/ai-providering.md §6.1 fact 1 — a "messages" response that spent max_tokens on internal reasoning with zero output text; billed, so it still carries a real tokensIn/tokensOut/costEstimate above despite being a failure). */
	outcome: string;
	finishReason: string | null;
	/** null unless costEstimate was actually computable for this attempt — see providers.ts's computeAttemptCost for exactly when that is. Always USD now, for both costSource values. */
	costEstimate: number | null;
	/** Which pricing path produced costEstimate — "provider" (the response's own usage.cost, verbatim — exact) or "table" (computeAttemptCost's priceTable arithmetic — our own estimate). Describes accuracy, not a unit: both are already USD (see providers.ts's unitRate). A balance report may sum across mixed costSource values, but must say so when it does — see usageReport.ts's own mixedCostSource handling. */
	costSource: AiCostSource;
	/** true only when --dry was passed with --ai (section 3.4) — a manual obkatka spend, not a real morning post. Records from before this field existed have no key at all; readers must treat a missing value as false (production), never rewrite the line to add it. */
	dryRun: boolean;
};

export function formatUsageLine(record: UsageRecord): string {
	return JSON.stringify(record);
}

export function appendUsageLine(filePath: string, record: UsageRecord): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	appendFileSync(filePath, `${formatUsageLine(record)}\n`);
}
