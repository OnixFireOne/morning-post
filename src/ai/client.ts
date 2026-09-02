// Thin OpenAI-compatible transport (section 2 of the v2 spec). One request in,
// one structured result out — retries, model fallback, budget, and the
// validator all live above this file and never see the provider's raw shape.
// Never logs `apiKey` or an unmasked `proxyUrl`; on any network-level failure
// the underlying error text is discarded entirely (not scrubbed) and replaced
// with a message built only from known-safe parts (host, masked proxy).
import { ProxyAgent } from "undici";
import { getHost, maskProxyUrl } from "./mask.js";

export type AiUsage = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** null when the provider doesn't report cache stats — distinct from 0 cached tokens. */
	cachedTokens: number | null;
};

export type AiGenerateParams = {
	model: string;
	system: string;
	user: string;
	timeoutMs: number;
	/**
	 * Passed straight through as `response_format` when set. The transport
	 * doesn't know or care about AI_STRUCTURED_OUTPUT or the JSON schema shape
	 * — that decision belongs to the caller building the payload/prompt.
	 */
	responseFormat?: unknown;
};

export type AiErrorKind = "timeout" | "network" | "http_error" | null;

export type AiGenerateResult = {
	ok: boolean;
	content: string | null;
	finishReason: string | null;
	usage: AiUsage | null;
	/** false when the provider omitted the usage block entirely — a real 0 is never invented. */
	usageReported: boolean;
	httpStatus: number | null;
	durationMs: number;
	errorKind: AiErrorKind;
	/** Sanitized — never contains the API key or an unmasked proxy URL. null on success. */
	errorMessage: string | null;
	/**
	 * The provider's own `usage` object, exactly as received — no field
	 * renaming, no derived values, none of this client's own interpretation.
	 * providers.ts's computeAttemptCost reads this directly for a "provider"
	 * costSource (OpenRouter's usage.cost); production code otherwise only
	 * reads the normalized `usage` above. null whenever there's no parsed
	 * body at all (any transport-level failure) or the provider omitted
	 * usage.
	 */
	rawUsage: unknown;
	/** Which upstream inference backend actually answered — OpenRouter-specific top-level response field, distinct from the `usage` object above. null when the response doesn't carry one (any transport failure, or a provider that doesn't report it). */
	responseProvider: string | null;
	/** The model id the response itself echoes back — can differ from the requested model under routing/aliasing. null on any transport failure. */
	responseModel: string | null;
	/** OpenRouter's own richer model/provider identification, present only when the request carried X-OpenRouter-Metadata: enabled (see OpenAiChatCompletion.openrouter_metadata's own comment) — only ever read by tools/ai-compare.ts's report header, never on the production path. null on any transport failure, when the provider doesn't report it, or when the field's shape doesn't match what's expected (never thrown over — a report header line degrades, nothing more). */
	openrouterMetadata: { model: string | null; provider: string | null } | null;
};

export type AiModel = {
	id: string;
};

/**
 * Minimal shape this module actually calls, not the full DOM RequestInit —
 * lets the injected mock in tests be a plain function, and lets `dispatcher`
 * (undici's proxy hook, not part of the standard Fetch API) through cleanly.
 */
export type FetchInit = {
	method: string;
	headers: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
	dispatcher?: unknown;
};

export type FetchResponseLike = {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
};

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export type AiClientOptions = {
	baseUrl: string;
	apiKey: string;
	/** HTTPS_PROXY/HTTP_PROXY, if set — respected via undici's ProxyAgent. */
	proxyUrl?: string;
	/** "bearer" (default, `Authorization: Bearer <key>`) or "x-api-key" (`x-api-key: <key>`, Anthropic's own native header name) — src/ai/providers.ts's AiProviderProfile.authStyle. */
	authStyle?: "bearer" | "x-api-key";
	/** Static headers merged into every request on top of Content-Type/auth — src/ai/providers.ts's AiProviderProfile.extraHeaders. Never used to carry a secret; the API key only ever goes through authStyle above. */
	extraHeaders?: Record<string, string>;
	/** Injectable for tests — defaults to the global fetch. Tests never hit the network. */
	fetchImpl?: FetchLike;
};

export type AiClient = {
	/** Host of baseUrl only — safe to put in usage records and logs as "provider". */
	readonly providerHost: string;
	generate(params: AiGenerateParams): Promise<AiGenerateResult>;
	listModels(): Promise<AiModel[]>;
};

type OpenAiChatCompletion = {
	choices?: { message?: { content?: string }; finish_reason?: string }[];
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
		prompt_tokens_details?: { cached_tokens?: number };
	};
	/** OpenRouter-specific top-level fields — absent from other OpenAI-compatible providers, which is fine: both simply come back undefined below. */
	provider?: string;
	model?: string;
	/**
	 * OpenRouter-specific, present only when the request carried
	 * `X-OpenRouter-Metadata: enabled` (src/ai/providers.ts's OPENROUTER
	 * profile sets it on every request via extraHeaders) — the exact upstream
	 * model/provider variant that answered, more precise than the plain
	 * `model`/`provider` fields above (which can be the requested slug
	 * unchanged, not what actually routed). 02.09: replaces the old
	 * GET /api/v1/generation?id=<id> lookup (tools/ai-compare.ts) — that was a
	 * second network round trip after the fact, and its 404s turned out to be
	 * genuine ("not found", not "not ready yet" — OpenRouter's own docs; a
	 * live rerun with a retry+pause still 404'd). This rides on the same
	 * response the request already got, no second call needed. Shape is this
	 * project's best reading of OpenRouter's docs, not independently verified
	 * against a live response (zero network calls this session) — every
	 * reader of this field treats a missing/malformed value as absent and
	 * falls back, never throws, exactly because that shape isn't guaranteed.
	 */
	openrouter_metadata?: { model?: string; provider?: string };
};

type OpenAiModelList = {
	data?: { id: string }[];
};

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** Defensive on purpose (see OpenAiChatCompletion.openrouter_metadata's own comment) — a missing field, or one with neither sub-field a usable string, comes back null rather than `{model: null, provider: null}`: the caller (tools/ai-compare.ts) treats null as "try the next fallback tier", and an object with two nulls would look like a confirmed-empty answer instead. */
function extractOpenrouterMetadata(data: OpenAiChatCompletion): { model: string | null; provider: string | null } | null {
	const raw = data.openrouter_metadata;
	if (!raw || typeof raw !== "object") return null;
	const model = typeof raw.model === "string" && raw.model ? raw.model : null;
	const provider = typeof raw.provider === "string" && raw.provider ? raw.provider : null;
	if (!model && !provider) return null;
	return { model, provider };
}

/** The raw error is discarded on purpose — it can embed the proxy URL with credentials. */
function sanitizeNetworkError(baseUrl: string, proxyUrl: string | undefined): string {
	const parts = ["network error calling", getHost(baseUrl)];
	if (proxyUrl) parts.push(`via proxy ${maskProxyUrl(proxyUrl)}`);
	return parts.join(" ");
}

export function createAiClient(opts: AiClientOptions): AiClient {
	const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
	const dispatcher = opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : undefined;
	const providerHost = getHost(opts.baseUrl);

	function authHeaders(): Record<string, string> {
		const auth: Record<string, string> = opts.authStyle === "x-api-key" ? { "x-api-key": opts.apiKey } : { Authorization: `Bearer ${opts.apiKey}` };
		return { "Content-Type": "application/json", ...auth, ...opts.extraHeaders };
	}

	async function generate(params: AiGenerateParams): Promise<AiGenerateResult> {
		const startedAt = Date.now();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), params.timeoutMs);

		const body: Record<string, unknown> = {
			model: params.model,
			messages: [
				{ role: "system", content: params.system },
				{ role: "user", content: params.user },
			],
		};
		if (params.responseFormat) body.response_format = params.responseFormat;

		let response: FetchResponseLike;
		try {
			response = await fetchImpl(joinUrl(opts.baseUrl, "/chat/completions"), {
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

		let data: OpenAiChatCompletion;
		try {
			data = (await response.json()) as OpenAiChatCompletion;
		} catch {
			// A 2xx with a body that isn't valid JSON at all (some proxies return an
			// HTML error page with 200) — still a transport-level problem, not one
			// the validator should have to guess at.
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

		const choice = data.choices?.[0];
		const usage = data.usage
			? {
					promptTokens: data.usage.prompt_tokens,
					completionTokens: data.usage.completion_tokens,
					totalTokens: data.usage.total_tokens,
					cachedTokens: data.usage.prompt_tokens_details?.cached_tokens ?? null,
				}
			: null;

		return {
			ok: true,
			content: choice?.message?.content ?? null,
			finishReason: choice?.finish_reason ?? null,
			usage,
			usageReported: usage !== null,
			httpStatus: response.status,
			durationMs,
			errorKind: null,
			errorMessage: null,
			// The parsed OpenAiChatCompletion type only names the fields this
			// client interprets — a real response can carry more (provider-specific
			// cost/cache fields), and JSON.parse() keeps them at runtime even though
			// the type above doesn't name them. data.usage as-is, unlike `usage`.
			rawUsage: data.usage ?? null,
			responseProvider: data.provider ?? null,
			responseModel: data.model ?? null,
			openrouterMetadata: extractOpenrouterMetadata(data),
		};
	}

	// Unlike generate(), this throws — it's only ever called from the manual
	// `ai:models` CLI (section 2), where a plain try/catch at the call site is
	// simpler than a parallel result-object contract nothing else needs.
	async function listModels(): Promise<AiModel[]> {
		const response = await fetchImpl(joinUrl(opts.baseUrl, "/models"), {
			method: "GET",
			headers: authHeaders(),
			...(dispatcher ? { dispatcher } : {}),
		});
		if (!response.ok) {
			throw new Error(`GET /models failed: HTTP ${response.status}`);
		}
		const data = (await response.json()) as OpenAiModelList;
		return (data.data ?? []).map((m) => ({ id: m.id }));
	}

	return { providerHost, generate, listModels };
}
