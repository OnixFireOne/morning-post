// Anthropic-native transport (protocol: "messages" — plan/ai-providering.md
// §4). Same AiClient contract as client.ts's createChatCompletionsClient
// (AiGenerateParams/AiGenerateResult/AiClient are unchanged, imported from
// there) — one request in, one normalized result out. Everything above the
// AiClient interface (generate.ts, tools/ai-compare.ts) calls this exactly
// the same way it calls createChatCompletionsClient; only src/ai/transport.ts
// knows which one it picked.
import { ProxyAgent } from "undici";
import { joinUrl, sanitizeNetworkError } from "./http.js";
import { getHost } from "./mask.js";
import type { AiClient, AiClientOptions, AiGenerateParams, AiGenerateResult, AiModel, FetchLike, FetchResponseLike } from "./client.js";

export type AiMessagesClientOptions = AiClientOptions & {
	/** `anthropic-version` header value — sent only when set. api.anthropic.com requires one; most proxies don't. */
	apiVersion?: string;
	/** Required — POST /messages' own required max_tokens field (src/ai/providers.ts's AiProviderProfile.maxTokens). */
	maxTokens: number;
	/** GET path for listModels() — undefined defaults to "/models"; null means the provider has no listing endpoint, and listModels() throws a distinct, recognizable error instead of making a request that can only 404. */
	modelsPath?: string | null;
	/** The catalog profile's own name (AiProviderProfile.name) — named in the "listing not supported" error so an operator reading it knows which profile to fix, not just which host answered. Falls back to the host when omitted (direct construction, e.g. a test). */
	name?: string;
};

type AnthropicContentBlock = { type: string; text?: string };

type AnthropicMessageResponse = {
	content?: AnthropicContentBlock[];
	stop_reason?: string;
	model?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
	};
};

type AnthropicModelList = {
	data?: { id: string }[];
};

/** Concatenates every `type: "text"` block's own text, in order; blocks of any other type (thinking, tool_use, ...) are skipped, never concatenated in. An empty result is "", never null — see AiGenerateResult.content's own contract, unchanged by protocol. */
function extractTextContent(blocks: AnthropicContentBlock[] | undefined): string {
	if (!blocks) return "";
	return blocks
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("");
}

/** plan/ai-providering.md §7.1: a usage block with only one of the two token counts is worse than none at all — see client.ts's own hasCompleteTokenCounts for the identical reasoning on the other protocol. */
function hasCompleteTokenCounts(usage: NonNullable<AnthropicMessageResponse["usage"]>): boolean {
	return typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number";
}

export function createMessagesClient(opts: AiMessagesClientOptions): AiClient {
	const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
	const dispatcher = opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : undefined;
	const providerHost = getHost(opts.baseUrl);
	const modelsPath = opts.modelsPath === undefined ? "/models" : opts.modelsPath;

	function authHeaders(): Record<string, string> {
		const auth: Record<string, string> = opts.authStyle === "bearer" ? { Authorization: `Bearer ${opts.apiKey}` } : { "x-api-key": opts.apiKey };
		const version: Record<string, string> = opts.apiVersion ? { "anthropic-version": opts.apiVersion } : {};
		return { "Content-Type": "application/json", ...auth, ...version, ...opts.extraHeaders };
	}

	async function generate(params: AiGenerateParams): Promise<AiGenerateResult> {
		const startedAt = Date.now();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), params.timeoutMs);

		// response_format has no equivalent in this protocol at all — the
		// transport silently ignoring it here would send an unlabeled request
		// nobody asked for; the actual guard is at startup (src/index.ts's
		// validateStartupConfig, plan §4), before this ever runs.
		const body = {
			model: params.model,
			max_tokens: opts.maxTokens,
			system: params.system,
			messages: [{ role: "user", content: params.user }],
		};

		let response: FetchResponseLike;
		try {
			response = await fetchImpl(joinUrl(opts.baseUrl, "/messages"), {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
				signal: controller.signal,
				...(dispatcher ? { dispatcher } : {}),
			});
		} catch (err) {
			const durationMs = Date.now() - startedAt;
			const aborted = err instanceof Error && err.name === "AbortError";
			return {
				ok: false,
				content: null,
				finishReason: null,
				usage: null,
				usageReported: false,
				httpStatus: null,
				durationMs,
				errorKind: aborted ? "timeout" : "network",
				errorMessage: aborted ? `request timed out after ${params.timeoutMs}ms` : sanitizeNetworkError(opts.baseUrl, opts.proxyUrl),
				rawUsage: null,
				responseProvider: null,
				responseModel: null,
				openrouterMetadata: null,
			};
		} finally {
			clearTimeout(timeout);
		}

		const durationMs = Date.now() - startedAt;

		if (!response.ok) {
			return {
				ok: false,
				content: null,
				finishReason: null,
				usage: null,
				usageReported: false,
				httpStatus: response.status,
				durationMs,
				errorKind: "http_error",
				errorMessage: `HTTP ${response.status}`,
				rawUsage: null,
				responseProvider: null,
				responseModel: null,
				openrouterMetadata: null,
			};
		}

		let data: AnthropicMessageResponse;
		try {
			data = (await response.json()) as AnthropicMessageResponse;
		} catch {
			// A 2xx with a body that isn't valid JSON — still a transport-level
			// problem, same treatment as client.ts's identical case.
			return {
				ok: false,
				content: null,
				finishReason: null,
				usage: null,
				usageReported: false,
				httpStatus: response.status,
				durationMs,
				errorKind: "http_error",
				errorMessage: "response body was not valid JSON",
				rawUsage: null,
				responseProvider: null,
				responseModel: null,
				openrouterMetadata: null,
			};
		}

		const usage =
			data.usage && hasCompleteTokenCounts(data.usage)
				? {
						promptTokens: data.usage.input_tokens!,
						completionTokens: data.usage.output_tokens!,
						// Not provided by this protocol — our own sum, not the
						// provider's own figure (unlike chat_completions' total_tokens).
						totalTokens: data.usage.input_tokens! + data.usage.output_tokens!,
						cachedTokens: data.usage.cache_read_input_tokens ?? null,
					}
				: null;

		const content = extractTextContent(data.content);

		// plan/ai-providering.md §6.1 fact 1, reproduced live against a real
		// proxy: max_tokens can be spent entirely on the provider's own
		// internal reasoning, leaving zero output text — content: "" with
		// stop_reason: "max_tokens" is a paid non-answer, not a terse valid
		// one. Every OTHER stop_reason still returns content: "" as usual (an
		// actually-empty completion is rare but not inherently wrong). usage/
		// rawUsage are still attached below despite ok:false — the request
		// was billed, so generate.ts still has to price and log this attempt,
		// unlike a genuine transport failure where nothing was ever parsed.
		if (content === "" && data.stop_reason === "max_tokens") {
			return {
				ok: false,
				content: null,
				finishReason: data.stop_reason,
				usage,
				usageReported: usage !== null,
				httpStatus: response.status,
				durationMs,
				errorKind: "empty_response",
				errorMessage: `empty response body at stop_reason "max_tokens" — the token limit (${opts.maxTokens}) was spent before any output text`,
				rawUsage: data.usage ?? null,
				responseModel: data.model ?? null,
				responseProvider: null,
				openrouterMetadata: null,
			};
		}

		return {
			ok: true,
			content,
			finishReason: data.stop_reason ?? null,
			usage,
			usageReported: usage !== null,
			httpStatus: response.status,
			durationMs,
			errorKind: null,
			errorMessage: null,
			// The provider's own usage object exactly as received, unrenamed —
			// same contract as client.ts's rawUsage, read by
			// providers.ts's computeAttemptCost for a "provider" costSource.
			rawUsage: data.usage ?? null,
			responseModel: data.model ?? null,
			// Neither field exists in this protocol at all.
			responseProvider: null,
			openrouterMetadata: null,
		};
	}

	async function listModels(): Promise<AiModel[]> {
		if (modelsPath === null) {
			throw new Error(`listing not supported by profile "${opts.name ?? providerHost}" (modelsPath: null)`);
		}
		const response = await fetchImpl(joinUrl(opts.baseUrl, modelsPath), {
			method: "GET",
			headers: authHeaders(),
			...(dispatcher ? { dispatcher } : {}),
		});
		if (!response.ok) {
			throw new Error(`GET ${modelsPath} failed: HTTP ${response.status}`);
		}
		const data = (await response.json()) as AnthropicModelList;
		return (data.data ?? []).map((m) => ({ id: m.id }));
	}

	return { providerHost, generate, listModels };
}
