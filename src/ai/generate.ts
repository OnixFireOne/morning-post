// The AI-generated replacement for buildParagraphs(facts) (section 1) — same
// two paragraphs in the returned shape, but only observation is ever the
// model's own text now (PROMPT_VERSION 7): picture is pickPicture(facts),
// code-generated, on every "ai" outcome, same as the template path. Never
// throws: every exit path, including a genuinely unexpected error, falls
// back to the untouched template buildParagraphs() and returns something
// the caller can publish. This is the last line before publish; a throw
// here means a sunk morning post.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Facts } from "../facts.js";
import { buildParagraphs, pickPicture } from "../render.js";
import type { AiClient } from "./client.js";
import { buildAiPayload, type AiHistoryEntry, type AiPayload } from "./payload.js";
import { buildRetryObservationPrompt, buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { appendUsageLine, computeCost, type UsageRecord } from "./usage.js";
import { validateAiObservation, type ObservationValidationFailureReason } from "./validator.js";

export type AiModelConfig = {
	model: string;
	/** This model's own price per 1M tokens — the fallback's, not the primary's, when it's the fallback answering. */
	priceInPerMillion: number | null;
	priceOutPerMillion: number | null;
};

export type BuildParagraphsAiOptions = {
	facts: Facts;
	history: AiHistoryEntry[];
	client: AiClient;
	primary: AiModelConfig;
	fallback: AiModelConfig;
	timeoutMs: number;
	totalBudgetMs: number;
	maxAttemptsPerModel: number;
	promptVersion: number;
	usageFile: string;
	aiJsonFile: string;
	/** Section 3.4: whether this call happened under DRY_RUN=1 (with AI_ALLOW_REAL_IN_DRY=1 — index.ts's dry-run gate never lets this function run otherwise). Written into every usage.jsonl line so a manual obkatka spend can be told apart from a real morning post. */
	dryRun: boolean;
};

export type AiGenerationResult = {
	source: "ai" | "template";
	picture: string;
	observation: string;
	model: string | null;
	provider: string | null;
	promptVersion: number | null;
	/** Human-readable summary for the "AI fell back to template" alert. null only when source is "ai". */
	failureReason: string | null;
	attempts: number;
	totalTokensIn: number;
	totalTokensOut: number;
	totalDurationMs: number;
	/** Sum of every attempt's own cost (each priced by whichever model answered it), null only when no attempt had a computable cost — a missing price for one model doesn't zero out another's real spend. */
	totalCost: number | null;
};

export type AiJsonAttempt = {
	attempt: number;
	model: string;
	/** The raw model text for this attempt, null for a transport-level failure — there was nothing to read. */
	rawResponse: string | null;
	tokensIn: number | null;
	tokensOut: number | null;
	tokensTotal: number | null;
	cachedTokens: number | null;
	usageReported: boolean;
	durationMs: number;
	outcome: string;
	finishReason: string | null;
	costEstimate: number | null;
};

export type AiJsonOutput = {
	dateKey: string;
	provider: string;
	payload: AiPayload;
	attempts: AiJsonAttempt[];
	result: {
		source: "ai" | "template";
		model: string | null;
		promptVersion: number | null;
		failureReason: string | null;
	};
};

function safeWriteAiJson(filePath: string, data: AiJsonOutput): void {
	try {
		mkdirSync(path.dirname(filePath), { recursive: true });
		writeFileSync(filePath, JSON.stringify(data, null, 2));
	} catch (err) {
		// The debug artifact failing to write must never take the post down with it.
		console.error("[ai] failed to write ai.json:", err instanceof Error ? err.message : err);
	}
}

function safeAppendUsage(filePath: string, record: UsageRecord): void {
	try {
		appendUsageLine(filePath, record);
	} catch (err) {
		console.error("[ai] failed to append usage.jsonl:", err instanceof Error ? err.message : err);
	}
}

export async function buildParagraphsAI(options: BuildParagraphsAiOptions): Promise<AiGenerationResult> {
	const payload = buildAiPayload(options.facts, options.history);
	const system = buildSystemPrompt();
	const startedAt = Date.now();

	const attempts: AiJsonAttempt[] = [];
	const failureSummary: string[] = [];
	let attemptCounter = 0;
	let totalTokensIn = 0;
	let totalTokensOut = 0;
	let totalCost = 0;
	let anyCostKnown = false;

	/** Shared exit for every failure path — the one place that falls back to the template and writes ai.json. */
	function finish(): AiGenerationResult {
		const template = buildParagraphs(options.facts);
		const failureReason = failureSummary.join("; ") || "no attempts were made";
		safeWriteAiJson(options.aiJsonFile, {
			dateKey: options.facts.dateKey,
			provider: options.client.providerHost,
			payload,
			attempts,
			result: { source: "template", model: null, promptVersion: null, failureReason },
		});
		return {
			source: "template",
			picture: template.picture,
			observation: template.observation,
			model: null,
			provider: null,
			promptVersion: null,
			failureReason,
			attempts: attemptCounter,
			totalTokensIn,
			totalTokensOut,
			totalDurationMs: Date.now() - startedAt,
			totalCost: anyCostKnown ? totalCost : null,
		};
	}

	try {
		for (const modelConfig of [options.primary, options.fallback]) {
			let lastReason: ObservationValidationFailureReason | null = null;

			for (let attemptOnModel = 1; attemptOnModel <= options.maxAttemptsPerModel; attemptOnModel++) {
				// Checked before every request, not after — a request that's
				// allowed to start could itself burn the rest of the budget, so
				// this has to gate the *next* attempt, not follow the last one.
				const remaining = options.totalBudgetMs - (Date.now() - startedAt);
				if (remaining < options.timeoutMs) {
					failureSummary.push(`budget exhausted before ${modelConfig.model} attempt ${attemptOnModel}`);
					return finish();
				}

				attemptCounter++;
				const user = lastReason ? buildRetryObservationPrompt(payload, lastReason) : buildUserPrompt(payload);
				const result = await options.client.generate({ model: modelConfig.model, system, user, timeoutMs: options.timeoutMs });

				if (!result.ok) {
					// result.content is never touched here — ok:false means there is
					// nothing trustworthy to read, only errorKind/httpStatus are.
					const outcome = result.errorKind === "timeout" ? "timeout" : result.errorKind === "http_error" ? `http_${result.httpStatus}` : "network_error";
					safeAppendUsage(options.usageFile, {
						timestamp: new Date().toISOString(),
						attempt: attemptCounter,
						provider: options.client.providerHost,
						model: modelConfig.model,
						promptVersion: options.promptVersion,
						tokensIn: null,
						tokensOut: null,
						tokensTotal: null,
						cachedTokens: null,
						usageReported: false,
						durationMs: result.durationMs,
						outcome,
						finishReason: null,
						costEstimate: null,
						dryRun: options.dryRun,
					});
					attempts.push({
						attempt: attemptCounter,
						model: modelConfig.model,
						rawResponse: null,
						tokensIn: null,
						tokensOut: null,
						tokensTotal: null,
						cachedTokens: null,
						usageReported: false,
						durationMs: result.durationMs,
						outcome,
						finishReason: null,
						costEstimate: null,
					});
					failureSummary.push(`${modelConfig.model} attempt ${attemptOnModel}: ${outcome}${result.errorMessage ? ` (${result.errorMessage})` : ""}`);
					// Transport-level failure: no retry on this model, straight to the next one.
					break;
				}

				// result.ok === true from here on — safe to read result.content.
				const rawText = result.content ?? "";
				const validation = validateAiObservation(rawText, payload);
				const outcome = validation.ok ? "ok" : validation.reason;
				const cost = computeCost(result.usage, modelConfig.priceInPerMillion, modelConfig.priceOutPerMillion);

				// Written immediately after classifying the outcome — before the
				// retry/accept decision, before anything else touches this result.
				// usage.jsonl is append-only, one line per attempt, so the outcome
				// has to be known before the line can be written at all; this is
				// the earliest point that's possible, and nothing riskier than a
				// pure classification happens between receiving the response and
				// this write. An attempt that already spent real tokens must never
				// be lost from accounting because something *later* in the run —
				// a retry, a crash, the publish step — didn't get that far.
				safeAppendUsage(options.usageFile, {
					timestamp: new Date().toISOString(),
					attempt: attemptCounter,
					provider: options.client.providerHost,
					model: modelConfig.model,
					promptVersion: options.promptVersion,
					tokensIn: result.usage?.promptTokens ?? null,
					tokensOut: result.usage?.completionTokens ?? null,
					tokensTotal: result.usage?.totalTokens ?? null,
					cachedTokens: result.usage?.cachedTokens ?? null,
					usageReported: result.usageReported,
					durationMs: result.durationMs,
					outcome,
					finishReason: result.finishReason,
					costEstimate: cost,
					dryRun: options.dryRun,
				});
				attempts.push({
					attempt: attemptCounter,
					model: modelConfig.model,
					rawResponse: rawText,
					tokensIn: result.usage?.promptTokens ?? null,
					tokensOut: result.usage?.completionTokens ?? null,
					tokensTotal: result.usage?.totalTokens ?? null,
					cachedTokens: result.usage?.cachedTokens ?? null,
					usageReported: result.usageReported,
					durationMs: result.durationMs,
					outcome,
					finishReason: result.finishReason,
					costEstimate: cost,
				});

				if (result.usage) {
					totalTokensIn += result.usage.promptTokens;
					totalTokensOut += result.usage.completionTokens;
				}
				if (cost !== null) {
					totalCost += cost;
					anyCostKnown = true;
				}

				if (validation.ok) {
					safeWriteAiJson(options.aiJsonFile, {
						dateKey: options.facts.dateKey,
						provider: options.client.providerHost,
						payload,
						attempts,
						result: { source: "ai", model: modelConfig.model, promptVersion: options.promptVersion, failureReason: null },
					});
					return {
						source: "ai",
						picture: pickPicture(options.facts),
						observation: validation.result.observation,
						model: modelConfig.model,
						provider: options.client.providerHost,
						promptVersion: options.promptVersion,
						failureReason: null,
						attempts: attemptCounter,
						totalTokensIn,
						totalTokensOut,
						totalDurationMs: Date.now() - startedAt,
						totalCost: anyCostKnown ? totalCost : null,
					};
				}

				// Content-level failure — retry the same model if attempts remain.
				lastReason = validation.reason;
				failureSummary.push(`${modelConfig.model} attempt ${attemptOnModel}: ${outcome}`);
			}
		}

		failureSummary.push("all models and retries exhausted");
		return finish();
	} catch (err) {
		// Absolute last resort — generate()/validateAiParagraphs() are designed
		// never to throw, but this function's own contract is stronger than
		// trusting that: nothing gets to sink the post, including a bug here.
		failureSummary.push(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
		return finish();
	}
}
