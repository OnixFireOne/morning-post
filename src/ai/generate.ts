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
import { computeAttemptCost, type AiCostSource, type AiProviderProfile } from "./providers.js";
import { appendUsageLine, type UsageRecord } from "./usage.js";
import { attemptObservationTrim, isTrimmableReason, validateAiObservation, type ObservationValidationFailureReason } from "./validator.js";

export type AiModelConfig = {
	model: string;
};

export type BuildParagraphsAiOptions = {
	facts: Facts;
	history: AiHistoryEntry[];
	client: AiClient;
	primary: AiModelConfig;
	fallback: AiModelConfig;
	/** Drives cost computation (costSource/priceTable/inputOverhead — see providers.ts's computeAttemptCost) and is recorded verbatim (providerName) on every usage.jsonl line. */
	provider: AiProviderProfile;
	timeoutMs: number;
	totalBudgetMs: number;
	maxAttemptsPerModel: number;
	promptVersion: number;
	usageFile: string;
	aiJsonFile: string;
	/** Section 3.4: whether this call happened under --dry (with --ai — renderPost.ts's dry-run gate never lets this function run otherwise). Written into every usage.jsonl line so a manual obkatka spend can be told apart from a real morning post. */
	dryRun: boolean;
};

export type AiGenerationResult = {
	/** "ai_trimmed": the model's response would otherwise have been rejected for a trimmable reason (see validator.ts's TRIMMABLE_REASONS) — one sentence was cut and the remainder passed validateAiObservation whole (see validator.ts's attemptObservationTrim). */
	source: "ai" | "ai_trimmed" | "template";
	picture: string;
	observation: string;
	model: string | null;
	provider: string | null;
	/** The upstream inference backend that actually answered (straight from the winning attempt's response) — distinct from `provider` above (the host we called). null on "template" (nothing answered) or when the provider doesn't report one. Recorded in facts.jsonl (see factsLog.ts's FactsLogEntry.provider) — section 5 of the 26.08 provider migration. */
	responseProvider: string | null;
	promptVersion: number | null;
	/** Human-readable summary for the "AI fell back to template" alert. null only when source is "ai"/"ai_trimmed". */
	failureReason: string | null;
	/** Non-null only when source is "ai_trimmed" — the exact sentence that was cut, for the admin-chat trim alert. */
	trimmedSentence: string | null;
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
	/** Same closed-in-practice set as UsageRecord.outcome (usage.ts) — see its own doc comment. */
	outcome: string;
	finishReason: string | null;
	costEstimate: number | null;
	costSource: AiCostSource;
	/** Straight from the response (client.ts's AiGenerateResult.responseProvider/responseModel) — null on any transport failure. */
	responseProvider: string | null;
	responseModel: string | null;
};

export type AiJsonOutput = {
	dateKey: string;
	provider: string;
	payload: AiPayload;
	attempts: AiJsonAttempt[];
	result: {
		source: "ai" | "ai_trimmed" | "template";
		model: string | null;
		promptVersion: number | null;
		failureReason: string | null;
		/** Non-null only when source is "ai_trimmed" — see AiGenerationResult.trimmedSentence. */
		trimmedSentence: string | null;
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
			result: { source: "template", model: null, promptVersion: null, failureReason, trimmedSentence: null },
		});
		return {
			source: "template",
			picture: template.picture,
			observation: template.observation,
			model: null,
			provider: null,
			responseProvider: null,
			promptVersion: null,
			failureReason,
			trimmedSentence: null,
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
					// usage/rawUsage/responseModel/finishReason, however, are read
					// from the result exactly like the ok:true branch below — for a
					// genuine transport failure (timeout/network/http_error) they're
					// always null/false anyway (see client.ts/clientMessages.ts), but
					// "empty_response" (plan §6.1 fact 1: max_tokens spent with no
					// output text) is a real, billed attempt that still has to be
					// priced and logged, not silently dropped from the day's spend.
					const outcome =
						result.errorKind === "timeout"
							? "timeout"
							: result.errorKind === "http_error"
								? `http_${result.httpStatus}`
								: result.errorKind === "empty_response"
									? "empty_response"
									: "network_error";
					const cost = computeAttemptCost(options.provider, modelConfig.model, result.usage, result.rawUsage);
					safeAppendUsage(options.usageFile, {
						timestamp: new Date().toISOString(),
						attempt: attemptCounter,
						provider: options.client.providerHost,
						providerName: options.provider.name,
						responseProvider: result.responseProvider,
						responseModel: result.responseModel,
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
						costSource: options.provider.costSource,
						dryRun: options.dryRun,
					});
					attempts.push({
						attempt: attemptCounter,
						model: modelConfig.model,
						rawResponse: result.content,
						tokensIn: result.usage?.promptTokens ?? null,
						tokensOut: result.usage?.completionTokens ?? null,
						tokensTotal: result.usage?.totalTokens ?? null,
						cachedTokens: result.usage?.cachedTokens ?? null,
						usageReported: result.usageReported,
						durationMs: result.durationMs,
						outcome,
						finishReason: result.finishReason,
						costEstimate: cost,
						costSource: options.provider.costSource,
						responseProvider: result.responseProvider,
						responseModel: result.responseModel,
					});
					if (result.usage) {
						totalTokensIn += result.usage.promptTokens;
						totalTokensOut += result.usage.completionTokens;
					}
					if (cost !== null) {
						totalCost += cost;
						anyCostKnown = true;
					}
					failureSummary.push(`${modelConfig.model} attempt ${attemptOnModel}: ${outcome}${result.errorMessage ? ` (${result.errorMessage})` : ""}`);
					// Transport-level failure: no retry on this model, straight to the next one.
					break;
				}

				// result.ok === true from here on — safe to read result.content.
				const rawText = result.content ?? "";
				const validation = validateAiObservation(rawText, payload);
				const outcome = validation.ok ? "ok" : validation.reason;
				const cost = computeAttemptCost(options.provider, modelConfig.model, result.usage, result.rawUsage);

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
					providerName: options.provider.name,
					responseProvider: result.responseProvider,
					responseModel: result.responseModel,
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
					costSource: options.provider.costSource,
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
					costSource: options.provider.costSource,
					responseProvider: result.responseProvider,
					responseModel: result.responseModel,
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
						result: { source: "ai", model: modelConfig.model, promptVersion: options.promptVersion, failureReason: null, trimmedSentence: null },
					});
					return {
						source: "ai",
						picture: pickPicture(options.facts),
						observation: validation.result.observation,
						model: modelConfig.model,
						provider: options.client.providerHost,
						responseProvider: result.responseProvider,
						promptVersion: options.promptVersion,
						failureReason: null,
						trimmedSentence: null,
						attempts: attemptCounter,
						totalTokensIn,
						totalTokensOut,
						totalDurationMs: Date.now() - startedAt,
						totalCost: anyCostKnown ? totalCost : null,
					};
				}

				// Third outcome: a trimmable rejection (validator:observation_day_count
				// or validator:length — see validator.ts's TRIMMABLE_REASONS) gets one
				// narrow chance to be fixed by cutting a single sentence — see
				// validator.ts's attemptObservationTrim for the full eligibility/
				// re-validation rules. Neither failure branch of attemptObservationTrim
				// retries the model: "not_eligible" (can't safely cut — too few
				// sentences, or day-count wording spans more than one) and
				// "trim_failed" (cut attempted, the remainder didn't hold up) both go
				// straight to the template. A same-model retry on either of these
				// exact reasons has no realistic upside — buildRetryObservationPrompt's
				// own instruction for the reason is already what produced the text
				// attemptObservationTrim just failed to salvage — so it's not worth a
				// second paid request. Every *other* rejection reason is untouched
				// below: AI_MAX_ATTEMPTS still governs its own retry exactly as before
				// this outcome existed.
				if (isTrimmableReason(validation.reason)) {
					const trim = attemptObservationTrim(rawText, payload, validation.reason);
					if (trim.ok) {
						safeWriteAiJson(options.aiJsonFile, {
							dateKey: options.facts.dateKey,
							provider: options.client.providerHost,
							payload,
							attempts,
							result: { source: "ai_trimmed", model: modelConfig.model, promptVersion: options.promptVersion, failureReason: null, trimmedSentence: trim.removedSentence },
						});
						return {
							source: "ai_trimmed",
							picture: pickPicture(options.facts),
							observation: trim.observation,
							model: modelConfig.model,
							provider: options.client.providerHost,
							responseProvider: result.responseProvider,
							promptVersion: options.promptVersion,
							failureReason: null,
							trimmedSentence: trim.removedSentence,
							attempts: attemptCounter,
							totalTokensIn,
							totalTokensOut,
							totalDurationMs: Date.now() - startedAt,
							totalCost: anyCostKnown ? totalCost : null,
						};
					}
					const trimFailureLabel = trim.stage === "not_eligible" ? "not eligible for trim" : "trim attempted but failed";
					failureSummary.push(`${modelConfig.model} attempt ${attemptOnModel}: ${outcome}, ${trimFailureLabel} (${trim.detail})`);
					return finish();
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
