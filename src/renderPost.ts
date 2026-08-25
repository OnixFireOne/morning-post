// The AI-vs-template publish decision (v2 step 6, section 3.4's dry-run
// gate). Split out of index.ts on purpose: index.ts has module-level side
// effects (loads .env, registers process signal handlers, calls main() at
// import time) that make it unsafe to import from a test — this file has
// none of that, so tests/render-post.test.ts can import renderPost()
// directly and inject a mocked fetchImpl, proving the gate never lets a
// real HTTP request through, instead of trusting the wiring by inspection.
import path from "node:path";
import { createAiClient, type FetchLike } from "./ai/client.js";
import { buildParagraphsAI, type AiModelConfig } from "./ai/generate.js";
import { stateHistoryToAiHistory } from "./ai/payload.js";
import type { Facts } from "./facts.js";
import { buildCaption, buildCaptionFromParagraphs, buildLeaderLines, buildParagraphs, CAPTION_LIMIT, type PostParagraphs } from "./render.js";
import type { StateHistory } from "./state.js";

export type RenderedPost = {
	caption: string;
	paragraphs: PostParagraphs;
	source: "ai" | "template";
	model: string | null;
	provider: string | null;
	promptVersion: number | null;
	/** null when AI was never attempted at all (AI_ENABLED=0) — omitted from StateDay rather than written as 0. */
	tokensIn: number | null;
	tokensOut: number | null;
	attempts: number | null;
	/** Sum of every attempt's own cost this run (see AiGenerationResult.totalCost) — null when AI was never attempted, or when no attempt had a computable price. */
	totalCost: number | null;
	/** Non-null exactly when the AI path was attempted and didn't produce what got published — drives the non-blocking fallback alert in main(). */
	failureReason: string | null;
};

/** Exactly the env fields renderPost() needs — index.ts's full Env satisfies this structurally, no cast required. */
export type RenderPostConfig = {
	aiEnabled: boolean;
	dryRun: boolean;
	aiAllowRealInDry: boolean;
	aiBaseUrl: string;
	aiApiKey: string;
	aiProxyUrl: string;
	aiModel: string;
	aiModelFallback: string;
	aiPriceIn: number | null;
	aiPriceOut: number | null;
	aiFallbackPriceIn: number | null;
	aiFallbackPriceOut: number | null;
	aiTimeoutMs: number;
	aiTotalBudgetMs: number;
	aiMaxAttempts: number;
	promptVersion: number;
	usageFile: string;
	outDir: string;
};

function templateResult(facts: Facts): RenderedPost {
	return {
		caption: buildCaption(facts),
		paragraphs: buildParagraphs(facts),
		source: "template",
		model: null,
		provider: null,
		promptVersion: null,
		tokensIn: null,
		tokensOut: null,
		attempts: null,
		totalCost: null,
		failureReason: null,
	};
}

/**
 * v2 step 6: when AI is disabled (or `skipAi` is set — see the call site in
 * index.ts's main()) this calls nothing but the untouched v1 buildCaption()/
 * buildParagraphs() — same functions, same facts, so the caption is
 * byte-for-byte what v1 always produced. AI_ENABLED=0 in .env/.env.example —
 * never flip this without a human running the full dry:fixture verification
 * first (plan/ai-start-integration.md, section 9).
 *
 * `fetchImpl` is optional and only ever passed by tests — production always
 * leaves it undefined, so createAiClient() falls through to the real global
 * fetch exactly as before this parameter existed.
 */
export async function renderPost(facts: Facts, history: StateHistory, skipAi: boolean, config: RenderPostConfig, fetchImpl?: FetchLike): Promise<RenderedPost> {
	if (!config.aiEnabled || skipAi) {
		return templateResult(facts);
	}

	// Section 3.4: DRY_RUN=1 never spends a real request on its own — this is
	// a separate check from skipAi above, not an extension of it. skipAi is
	// about idempotency (don't re-spend on an already-published day); this is
	// about environment (don't spend during local/dry testing at all), and
	// the two have to stay distinguishable in the log rather than collapsing
	// into one silent "skipped" case — a forgotten AI_ENABLED=1 during dry
	// testing must cost nothing, not cost something quietly. Checked before
	// any network call and before buildAiPayload() ever runs, so it covers
	// dry:fixture, dry, and every other DRY_RUN=1 path uniformly — exactly
	// what the skipAi guard's `!dryRun` exemption missed on 24-25.08.
	if (config.dryRun && !config.aiAllowRealInDry) {
		console.log("[ai] skipped: DRY_RUN=1 without AI_ALLOW_REAL_IN_DRY=1 — using template path, no request sent");
		return templateResult(facts);
	}

	const aiHistory = stateHistoryToAiHistory(history, facts.dateKey);
	const client = createAiClient({ baseUrl: config.aiBaseUrl, apiKey: config.aiApiKey, proxyUrl: config.aiProxyUrl || undefined, fetchImpl });
	const primary: AiModelConfig = { model: config.aiModel, priceInPerMillion: config.aiPriceIn, priceOutPerMillion: config.aiPriceOut };
	const fallback: AiModelConfig = { model: config.aiModelFallback, priceInPerMillion: config.aiFallbackPriceIn, priceOutPerMillion: config.aiFallbackPriceOut };

	const result = await buildParagraphsAI({
		facts,
		history: aiHistory,
		client,
		primary,
		fallback,
		timeoutMs: config.aiTimeoutMs,
		totalBudgetMs: config.aiTotalBudgetMs,
		maxAttemptsPerModel: config.aiMaxAttempts,
		promptVersion: config.promptVersion,
		usageFile: config.usageFile,
		aiJsonFile: path.join(config.outDir, `${facts.dateKey}.ai.json`),
		dryRun: config.dryRun,
	});

	if (result.source === "ai") {
		const { winnerLine, loserLine } = buildLeaderLines(facts);
		const paragraphs: PostParagraphs = { picture: result.picture, winnerLine, loserLine, observation: result.observation };
		const caption = buildCaptionFromParagraphs(facts, paragraphs); // no shortPicture: overflow here is a total AI-path failure, not a reason to graft template text on
		if (caption.length <= CAPTION_LIMIT) {
			return {
				caption,
				paragraphs,
				source: "ai",
				model: result.model,
				provider: result.provider,
				promptVersion: result.promptVersion,
				tokensIn: result.totalTokensIn,
				tokensOut: result.totalTokensOut,
				attempts: result.attempts,
				totalCost: result.totalCost,
				failureReason: null,
			};
		}
		return {
			caption: buildCaption(facts),
			paragraphs: buildParagraphs(facts),
			source: "template",
			model: null,
			provider: null,
			promptVersion: null,
			tokensIn: result.totalTokensIn,
			tokensOut: result.totalTokensOut,
			attempts: result.attempts,
			totalCost: result.totalCost,
			failureReason: "AI paragraphs were valid but the caption still exceeded CAPTION_LIMIT after dropping the observation paragraph",
		};
	}

	// buildParagraphsAI() never throws — it already fell back to the template internally.
	return {
		caption: buildCaption(facts),
		paragraphs: buildParagraphs(facts),
		source: "template",
		model: null,
		provider: null,
		promptVersion: null,
		tokensIn: result.totalTokensIn,
		tokensOut: result.totalTokensOut,
		attempts: result.attempts,
		totalCost: result.totalCost,
		failureReason: result.failureReason,
	};
}
