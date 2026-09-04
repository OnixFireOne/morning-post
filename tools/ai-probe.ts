// Diagnostic tool: `npm run ai:probe`. One-shot report of how a given
// proxy/provider actually behaves against Anthropic's native `/messages`
// protocol (and, for comparison, `/chat/completions`) — see
// plan/ai-providering.md §7.3. Fills config/providers.json profiles from a
// real response instead of a guess. Diagnostics only: never invoked by src/,
// never invoked in production, and this commit's author does not run it
// against a real proxy — no key was available. Whoever holds the real key
// runs `npm run ai:probe` and reports the output back (see §0/§8 of the plan).
//
// Every probe is isolated: a network error or timeout on one never stops the
// rest (try/catch per probe, sequential). deriveProfileDraft/renderProbeReport
// are pure functions — no network, no env reads — so tests/ai-probe-derive.test.ts
// can cover them on canned fixtures with zero real requests.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProxyAgent } from "undici";
import { maskSecret, redactSecret } from "../src/ai/mask.js";
import { resolveUniqueReportPath } from "./ai-compare.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_API_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 15000;
const BODY_TRUNCATE_CHARS = 2000;

/** Exact allowlist plus any header starting with "ratelimit-" — everything else from a response is dropped before it ever reaches the report file. */
const RESPONSE_HEADER_ALLOWLIST = ["content-type", "anthropic-version", "x-request-id", "retry-after"];

function isAllowlistedResponseHeader(name: string): boolean {
	const lower = name.toLowerCase();
	return RESPONSE_HEADER_ALLOWLIST.includes(lower) || lower.startsWith("ratelimit-");
}

// --- probe execution -------------------------------------------------------

export type ProbeResult = {
	index: number;
	label: string;
	method: "GET" | "POST";
	url: string;
	/** Already masked (see maskSecret) — safe to render as-is. */
	headersSent: Record<string, string>;
	requestBody: unknown | null;
	/** null when the request never produced a status at all (network error/timeout). */
	status: number | null;
	durationMs: number;
	/** Whitelisted response headers only — see RESPONSE_HEADER_ALLOWLIST. */
	responseHeaders: Record<string, string>;
	/** Truncated to BODY_TRUNCATE_CHARS. null only when no body was ever read (network failure). */
	bodyText: string | null;
	/** Parsed JSON when bodyText parses; null otherwise (including "wasn't JSON at all"). */
	bodyJson: unknown | null;
	errorKind: "timeout" | "network" | null;
	errorMessage: string | null;
	skipped: boolean;
	skipReason: string | null;
};

type ProbeEnv = {
	baseUrl: string;
	model: string;
	modelFallback: string | null;
	apiVersion: string;
	timeoutMs: number;
	apiKey: string;
	proxyUrl: string | null;
	/** How each value was resolved (flag / AI_PROBE_* / fallback to the runtime var) — printed as the report's first lines. */
	resolutionNotes: string[];
};

function messagesBody(model: string): unknown {
	return { model, max_tokens: 32, system: "probe", messages: [{ role: "user", content: "reply with ok" }] };
}

function chatCompletionsBody(model: string): unknown {
	return {
		model,
		messages: [
			{ role: "system", content: "probe" },
			{ role: "user", content: "reply with ok" },
		],
		max_tokens: 32,
	};
}

function parseFlags(argv: string[]): Record<string, string> {
	const flags: Record<string, string> = {};
	for (const arg of argv) {
		const m = /^--(base|model|version|timeout-ms)=(.*)$/.exec(arg);
		if (m) flags[m[1]!] = m[2]!;
	}
	return flags;
}

export function resolveProbeEnv(argv: string[], env: NodeJS.ProcessEnv): { ok: true; env: ProbeEnv } | { ok: false; error: string } {
	const flags = parseFlags(argv);
	const notes: string[] = [];

	let baseUrl = flags.base ?? env.AI_PROBE_BASE_URL?.trim() ?? "";
	if (baseUrl) {
		notes.push(`baseUrl: ${flags.base ? "from --base" : "from AI_PROBE_BASE_URL"}`);
	} else {
		baseUrl = env.AI_BASE_URL?.trim() ?? "";
		if (baseUrl) notes.push("baseUrl: from AI_BASE_URL (AI_PROBE_BASE_URL not set)");
	}

	let model = flags.model ?? env.AI_PROBE_MODEL?.trim() ?? "";
	if (model) {
		notes.push(`model: ${flags.model ? "from --model" : "from AI_PROBE_MODEL"}`);
	} else {
		model = env.AI_MODEL?.trim() ?? "";
		if (model) notes.push("model: from AI_MODEL (AI_PROBE_MODEL not set)");
	}

	let modelFallback = env.AI_PROBE_MODEL_FALLBACK?.trim() || "";
	if (modelFallback) {
		notes.push("modelFallback: from AI_PROBE_MODEL_FALLBACK");
	} else {
		modelFallback = env.AI_MODEL_FALLBACK?.trim() || "";
		if (modelFallback) notes.push("modelFallback: from AI_MODEL_FALLBACK (AI_PROBE_MODEL_FALLBACK not set)");
	}

	const apiVersion = flags.version ?? env.AI_PROBE_API_VERSION?.trim() ?? DEFAULT_API_VERSION;
	const timeoutMs = Number(flags["timeout-ms"] ?? env.AI_PROBE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
	const apiKey = env.AI_API_KEY?.trim() ?? "";
	const proxyUrl = env.HTTPS_PROXY || env.HTTP_PROXY || null;

	if (!baseUrl) return { ok: false, error: "no base URL — set AI_PROBE_BASE_URL (or AI_BASE_URL) in .env, or pass --base=" };
	if (!model) return { ok: false, error: "no model — set AI_PROBE_MODEL (or AI_MODEL) in .env, or pass --model=" };
	if (!apiKey) return { ok: false, error: "no API key — set AI_API_KEY in .env" };
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { ok: false, error: `invalid timeout: ${flags["timeout-ms"] ?? env.AI_PROBE_TIMEOUT_MS}` };

	return { ok: true, env: { baseUrl: baseUrl.replace(/\/+$/, ""), model, modelFallback: modelFallback || null, apiVersion, timeoutMs, apiKey, proxyUrl, resolutionNotes: notes } };
}

async function executeProbe(opts: {
	index: number;
	label: string;
	method: "GET" | "POST";
	url: string;
	headers: Record<string, string>;
	apiKey: string;
	body?: unknown;
	timeoutMs: number;
	proxyUrl: string | null;
}): Promise<ProbeResult> {
	const maskedHeaders: Record<string, string> = {};
	for (const [name, value] of Object.entries(opts.headers)) {
		maskedHeaders[name] = value === opts.apiKey ? maskSecret(value) : value;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
	const dispatcher = opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : undefined;
	const startedAt = Date.now();

	try {
		const response = await fetch(opts.url, {
			method: opts.method,
			headers: opts.headers,
			...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
			signal: controller.signal,
			...(dispatcher ? { dispatcher } : {}),
		} as RequestInit);
		const durationMs = Date.now() - startedAt;

		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, name) => {
			if (isAllowlistedResponseHeader(name)) responseHeaders[name.toLowerCase()] = value;
		});

		const rawText = await response.text();
		const bodyText = rawText.length > BODY_TRUNCATE_CHARS ? `${rawText.slice(0, BODY_TRUNCATE_CHARS)}… (truncated)` : rawText;
		let bodyJson: unknown | null = null;
		try {
			bodyJson = rawText ? JSON.parse(rawText) : null;
		} catch {
			bodyJson = null;
		}

		return {
			index: opts.index,
			label: opts.label,
			method: opts.method,
			url: opts.url,
			headersSent: maskedHeaders,
			requestBody: opts.body ?? null,
			status: response.status,
			durationMs,
			responseHeaders,
			bodyText,
			bodyJson,
			errorKind: null,
			errorMessage: null,
			skipped: false,
			skipReason: null,
		};
	} catch (err) {
		const durationMs = Date.now() - startedAt;
		const aborted = err instanceof Error && err.name === "AbortError";
		return {
			index: opts.index,
			label: opts.label,
			method: opts.method,
			url: opts.url,
			headersSent: maskedHeaders,
			requestBody: opts.body ?? null,
			status: null,
			durationMs,
			responseHeaders: {},
			bodyText: null,
			bodyJson: null,
			errorKind: aborted ? "timeout" : "network",
			errorMessage: aborted ? `timed out after ${opts.timeoutMs}ms` : err instanceof Error ? err.message : String(err),
			skipped: false,
			skipReason: null,
		};
	} finally {
		clearTimeout(timeout);
	}
}

function skippedProbe(index: number, label: string, reason: string): ProbeResult {
	return {
		index,
		label,
		method: "POST",
		url: "",
		headersSent: {},
		requestBody: null,
		status: null,
		durationMs: 0,
		responseHeaders: {},
		bodyText: null,
		bodyJson: null,
		errorKind: null,
		errorMessage: null,
		skipped: true,
		skipReason: reason,
	};
}

export async function runProbes(env: ProbeEnv): Promise<ProbeResult[]> {
	const results: ProbeResult[] = [];
	const common = { apiKey: env.apiKey, timeoutMs: env.timeoutMs, proxyUrl: env.proxyUrl };

	results.push(
		await executeProbe({ ...common, index: 1, label: "GET /models, x-api-key", method: "GET", url: `${env.baseUrl}/models`, headers: { "x-api-key": env.apiKey } }),
	);
	results.push(
		await executeProbe({ ...common, index: 2, label: "GET /models, Bearer", method: "GET", url: `${env.baseUrl}/models`, headers: { Authorization: `Bearer ${env.apiKey}` } }),
	);

	const probe3 = await executeProbe({
		...common,
		index: 3,
		label: "POST /messages, x-api-key + anthropic-version",
		method: "POST",
		url: `${env.baseUrl}/messages`,
		headers: { "Content-Type": "application/json", "x-api-key": env.apiKey, "anthropic-version": env.apiVersion },
		body: messagesBody(env.model),
	});
	results.push(probe3);

	results.push(
		await executeProbe({
			...common,
			index: 4,
			label: "POST /messages, x-api-key, no anthropic-version",
			method: "POST",
			url: `${env.baseUrl}/messages`,
			headers: { "Content-Type": "application/json", "x-api-key": env.apiKey },
			body: messagesBody(env.model),
		}),
	);

	if (probe3.status === 404 || probe3.status === 405) {
		results.push(
			await executeProbe({
				...common,
				index: 5,
				label: "POST /v1/messages (probe 3 was 404/405)",
				method: "POST",
				url: `${env.baseUrl}/v1/messages`,
				headers: { "Content-Type": "application/json", "x-api-key": env.apiKey, "anthropic-version": env.apiVersion },
				body: messagesBody(env.model),
			}),
		);
	} else {
		results.push(skippedProbe(5, "POST /v1/messages", "probe 3 did not return 404/405 — no reason to try a different path"));
	}

	results.push(
		await executeProbe({
			...common,
			index: 6,
			label: "POST /messages, Bearer instead of x-api-key",
			method: "POST",
			url: `${env.baseUrl}/messages`,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.apiKey}`, "anthropic-version": env.apiVersion },
			body: messagesBody(env.model),
		}),
	);

	results.push(
		await executeProbe({
			...common,
			index: 7,
			label: "POST /chat/completions, Bearer, OpenAI body",
			method: "POST",
			url: `${env.baseUrl}/chat/completions`,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.apiKey}` },
			body: chatCompletionsBody(env.model),
		}),
	);

	if (env.modelFallback) {
		results.push(
			await executeProbe({
				...common,
				index: 8,
				label: `POST /messages, fallback model (${env.modelFallback})`,
				method: "POST",
				url: `${env.baseUrl}/messages`,
				headers: { "Content-Type": "application/json", "x-api-key": env.apiKey, "anthropic-version": env.apiVersion },
				body: messagesBody(env.modelFallback),
			}),
		);
	} else {
		results.push(skippedProbe(8, "POST /messages, fallback model", "AI_PROBE_MODEL_FALLBACK (or AI_MODEL_FALLBACK) not set"));
	}

	return results;
}

// --- deriveProfileDraft: pure, no network, no env reads ---------------------

export type DraftField<T> = { value: T; source: string };

export type ProfileDraft = {
	baseUrl: DraftField<string | "TODO(unverified)">;
	modelsPath: DraftField<"/models" | null | "TODO(unverified)">;
	authStyle: DraftField<"bearer" | "x-api-key" | "TODO(unverified)">;
	/** null means "field not written at all" (probe 4 succeeded without it) — distinct from an unresolved TODO. */
	apiVersion: DraftField<string> | null;
	primaryModel: DraftField<string | "TODO(unverified)">;
	modelMismatchNote: string | null;
	costSource: DraftField<"provider" | "table" | "none" | "TODO(unverified)">;
	maxTokens: DraftField<"TODO(unverified)">;
	priceTable: DraftField<"TODO(unverified)">;
	fallbackModelVerified: boolean | null;
	secondProfileSuggested: boolean;
};

function byIndex(results: ProbeResult[]): Map<number, ProbeResult> {
	return new Map(results.map((r) => [r.index, r]));
}

/** Strips only the trailing "/messages" — createMessagesClient (src/ai/clientMessages.ts) always POSTs to `{baseUrl}/messages`, so whatever came before that segment (including a "/v1" that only probe 5's URL carries) is the baseUrl the profile needs, not the whole request path. */
function baseUrlFromRequestUrl(url: string): string {
	const suffix = "/messages";
	return url.endsWith(suffix) ? url.slice(0, -suffix.length) : url;
}

function isModelListShape(body: unknown): boolean {
	if (!body || typeof body !== "object") return false;
	const data = (body as Record<string, unknown>).data;
	return Array.isArray(data) && (data.length === 0 || (typeof data[0] === "object" && data[0] !== null && "id" in (data[0] as object)));
}

function extractUsage(body: unknown): Record<string, unknown> | null {
	if (!body || typeof body !== "object") return null;
	const usage = (body as Record<string, unknown>).usage;
	return usage && typeof usage === "object" ? (usage as Record<string, unknown>) : null;
}

export function deriveProfileDraft(results: ProbeResult[]): ProfileDraft {
	const p = byIndex(results);
	const p1 = p.get(1);
	const p2 = p.get(2);
	const p3 = p.get(3);
	const p4 = p.get(4);
	const p5 = p.get(5);
	const p6 = p.get(6);
	const p7 = p.get(7);
	const p8 = p.get(8);

	// baseUrl
	let baseUrl: ProfileDraft["baseUrl"];
	if (p3?.status === 200) {
		baseUrl = { value: baseUrlFromRequestUrl(p3.url), source: "probe 3 (POST /messages) returned 200" };
	} else if (p5 && !p5.skipped && p5.status === 200) {
		baseUrl = { value: baseUrlFromRequestUrl(p5.url), source: "probe 5 (POST /v1/messages) returned 200 — probe 3 did not" };
	} else {
		baseUrl = { value: "TODO(unverified)", source: "neither probe 3 nor probe 5 returned 200" };
	}

	// modelsPath
	let modelsPath: ProfileDraft["modelsPath"];
	const modelsOk = (r: ProbeResult | undefined) => r?.status === 200 && isModelListShape(r.bodyJson);
	if (modelsOk(p1)) {
		modelsPath = { value: "/models", source: "probe 1 (GET /models, x-api-key) returned 200 with a { data: [{id}] } list" };
	} else if (modelsOk(p2)) {
		modelsPath = { value: "/models", source: "probe 2 (GET /models, Bearer) returned 200 with a { data: [{id}] } list" };
	} else if ((p1?.status === 404 || p1?.status === 405) && (p2?.status === 404 || p2?.status === 405)) {
		modelsPath = { value: null, source: "both probe 1 and probe 2 returned 404/405 — no model listing endpoint" };
	} else if (p1?.status === 401 || p1?.status === 403 || p2?.status === 401 || p2?.status === 403) {
		modelsPath = { value: "TODO(unverified)", source: "probe 1/2 returned 401/403 — can't tell 'no such path' from 'no permission' apart" };
	} else {
		modelsPath = { value: "TODO(unverified)", source: "probe 1/2 gave an unexpected result" };
	}

	// authStyle
	const p3ok = p3?.status === 200;
	const p6ok = p6?.status === 200;
	let authStyle: ProfileDraft["authStyle"];
	if (p3ok && p6ok) {
		authStyle = { value: "x-api-key", source: "both probe 3 (x-api-key) and probe 6 (Bearer) returned 200 — x-api-key recorded as the protocol default, Bearer also works" };
	} else if (p3ok) {
		authStyle = { value: "x-api-key", source: "probe 3 (x-api-key) returned 200, probe 6 (Bearer) did not" };
	} else if (p6ok) {
		authStyle = { value: "bearer", source: "probe 6 (Bearer) returned 200, probe 3 (x-api-key) did not" };
	} else {
		authStyle = { value: "TODO(unverified)", source: "neither probe 3 nor probe 6 returned 200" };
	}

	// apiVersion
	let apiVersion: ProfileDraft["apiVersion"];
	if (p4?.status === 200) {
		apiVersion = null; // field omitted entirely — header isn't required
	} else if (p3?.status === 200) {
		apiVersion = { value: p3.headersSent["anthropic-version"] ?? "TODO(unverified)", source: "probe 4 (no header) failed while probe 3 (with header) succeeded — header required" };
	} else {
		apiVersion = { value: "TODO(unverified)", source: "neither probe 3 nor probe 4 succeeded — can't tell whether the header is required" };
	}

	// primaryModel + mismatch note
	const winningMessagesProbe = p3?.status === 200 ? p3 : p5 && !p5.skipped && p5.status === 200 ? p5 : p6?.status === 200 ? p6 : undefined;
	let primaryModel: ProfileDraft["primaryModel"];
	let modelMismatchNote: string | null;
	if (winningMessagesProbe) {
		const sentModel = winningMessagesProbe.requestBody && typeof winningMessagesProbe.requestBody === "object" ? (winningMessagesProbe.requestBody as Record<string, unknown>).model : undefined;
		const sentModelStr = typeof sentModel === "string" ? sentModel : "TODO(unverified)";
		primaryModel = { value: sentModelStr, source: `probe ${winningMessagesProbe.index} returned 200 for this model id, sent as-is` };
		const responseModel = winningMessagesProbe.bodyJson && typeof winningMessagesProbe.bodyJson === "object" ? (winningMessagesProbe.bodyJson as Record<string, unknown>).model : undefined;
		if (typeof responseModel === "string" && responseModel !== sentModelStr) {
			modelMismatchNote = `sent "${sentModelStr}", response echoed "${responseModel}" — a mismatch is normal for a proxy, just confirm it's the intended model`;
		} else if (typeof responseModel === "string") {
			modelMismatchNote = `response echoed the same model id ("${responseModel}")`;
		} else {
			modelMismatchNote = "response did not echo a model field";
		}
	} else {
		primaryModel = { value: "TODO(unverified)", source: "no messages probe (3/5/6) returned 200" };
		modelMismatchNote = null;
	}

	// costSource
	let costSource: ProfileDraft["costSource"];
	if (winningMessagesProbe) {
		const usage = extractUsage(winningMessagesProbe.bodyJson);
		if (!usage) {
			costSource = { value: "none", source: `probe ${winningMessagesProbe.index}'s response had no usage block at all` };
		} else if ("cost" in usage && typeof usage.cost === "number") {
			costSource = { value: "provider", source: `probe ${winningMessagesProbe.index}'s usage block carries a numeric cost field` };
		} else {
			costSource = { value: "table", source: `probe ${winningMessagesProbe.index}'s usage block has token counts but no cost field` };
		}
	} else {
		costSource = { value: "TODO(unverified)", source: "no messages probe returned a real response to read usage from" };
	}

	return {
		baseUrl,
		modelsPath,
		authStyle,
		apiVersion,
		primaryModel,
		modelMismatchNote,
		costSource,
		maxTokens: { value: "TODO(unverified)", source: "never derivable from a probe response — max_tokens is a request field, not something the provider reports back" },
		priceTable: { value: "TODO(unverified)", source: "never derivable from a probe response — pricing isn't part of the /messages payload" },
		fallbackModelVerified: p8 && !p8.skipped ? p8.status === 200 : null,
		secondProfileSuggested: p7?.status === 200,
	};
}

// --- rendering ---------------------------------------------------------------

function formatHeadersBlock(headers: Record<string, string>): string {
	const entries = Object.entries(headers);
	if (entries.length === 0) return "(none)";
	return entries.map(([k, v]) => `  ${k}: ${v}`).join("\n");
}

function formatProbeSection(r: ProbeResult): string {
	if (r.skipped) {
		return [`### Probe ${r.index}: ${r.label}`, "", `Skipped — ${r.skipReason}`].join("\n");
	}
	const lines = [
		`### Probe ${r.index}: ${r.label}`,
		"",
		`- ${r.method} ${r.url}`,
		`- Headers sent:`,
		formatHeadersBlock(r.headersSent),
		`- Status: ${r.status ?? `ERROR (${r.errorKind}: ${r.errorMessage})`}`,
		`- Duration: ${r.durationMs}ms`,
	];
	if (r.status !== null) {
		lines.push(`- Response headers (allowlisted):`, formatHeadersBlock(r.responseHeaders));
		lines.push("- Body (truncated):", "```json", r.bodyText ?? "(empty)", "```");
	}
	return lines.join("\n");
}

function formatDraftField(name: string, field: { value: unknown; source: string } | null, note?: string): string {
	if (field === null) return `  // ${name}: not written — see report notes`;
	const valueStr = typeof field.value === "string" ? `"${field.value}"` : JSON.stringify(field.value);
	return `  "${name}": ${valueStr}, // ${field.source}${note ? ` — ${note}` : ""}`;
}

export function renderProbeReport(results: ProbeResult[], draft: ProfileDraft, meta: { startedAt: Date; baseUrl: string; model: string; resolutionNotes: string[] }): string {
	const usageVerdictLines = [
		"## Usage / cost verdict",
		"",
		`- costSource: ${draft.costSource.value} (${draft.costSource.source})`,
		draft.costSource.value === "none" ? "- No usage block was returned at all — costEstimate will always be null for this profile." : "",
	].filter(Boolean);

	const draftLines = [
		"## Draft profile (config/providers.json)",
		"",
		"```jsonc",
		"{",
		formatDraftField("baseUrl", draft.baseUrl),
		`  "protocol": "messages",`,
		draft.apiVersion ? formatDraftField("apiVersion", draft.apiVersion) : `  // apiVersion: omitted — probe 4 (no header) succeeded on its own`,
		formatDraftField("modelsPath", draft.modelsPath),
		formatDraftField("authStyle", draft.authStyle),
		formatDraftField("primaryModel", draft.primaryModel, draft.modelMismatchNote ?? undefined),
		formatDraftField("costSource", draft.costSource),
		formatDraftField("maxTokens", draft.maxTokens),
		formatDraftField("priceTable", draft.priceTable, "keys must match the model id sent, character-for-character"),
		"}",
		"```",
		"",
		draft.fallbackModelVerified === null ? "- Fallback model: not probed (AI_PROBE_MODEL_FALLBACK not set)." : `- Fallback model: ${draft.fallbackModelVerified ? "responded 200 (probe 8)." : "did NOT respond 200 (probe 8) — check the id."}`,
		draft.secondProfileSuggested ? "- Probe 7 (/chat/completions) returned 200 — a second `*.chat_completions` profile on the same key is possible." : "- Probe 7 (/chat/completions) did not return 200 — no second protocol on this key/endpoint.",
	];

	const report = [
		`# ai:probe report`,
		"",
		`- Started: ${meta.startedAt.toISOString()}`,
		`- Base URL: ${meta.baseUrl}`,
		`- Model: ${meta.model}`,
		...meta.resolutionNotes.map((n) => `- ${n}`),
		"",
		"## Probe results",
		"",
		...results.map(formatProbeSection),
		"",
		...usageVerdictLines,
		"",
		...draftLines,
	].join("\n");

	return report;
}

function buildProbeReportBaseName(startedAt: Date): string {
	const iso = startedAt.toISOString();
	const datePart = iso.slice(0, 10);
	const timePart = iso.slice(11, 16).replace(":", "");
	return `probe-${datePart}-${timePart}.md`;
}

function formatSummaryTable(results: ProbeResult[], draft: ProfileDraft): string {
	const lines = ["probe -> status -> verdict"];
	for (const r of results) {
		const status = r.skipped ? "skipped" : r.status !== null ? String(r.status) : `ERROR (${r.errorKind})`;
		lines.push(`  ${r.index}. ${r.label} -> ${status}`);
	}
	lines.push(`costSource: ${draft.costSource.value}`);
	return lines.join("\n");
}

async function main() {
	const resolved = resolveProbeEnv(process.argv.slice(2), process.env);
	if (!resolved.ok) {
		console.error(`[ai:probe] ${resolved.error}`);
		process.exitCode = 1;
		return;
	}
	const env = resolved.env;
	const startedAt = new Date();

	console.log(`[ai:probe] probing ${env.baseUrl} ...`);
	const results = await runProbes(env);
	const draft = deriveProfileDraft(results);

	const report = renderProbeReport(results, draft, { startedAt, baseUrl: env.baseUrl, model: env.model, resolutionNotes: env.resolutionNotes });
	// Last-resort scrub, on top of headersSent already being masked at the
	// source — a proxy could echo the raw key back in a body/error somewhere
	// this report didn't anticipate.
	const safeReport = redactSecret(report, env.apiKey);

	const reportsDir = path.join(REPO_ROOT, "reports", "probe");
	mkdirSync(reportsDir, { recursive: true });
	const outFile = resolveUniqueReportPath(reportsDir, buildProbeReportBaseName(startedAt));
	writeFileSync(outFile, safeReport);

	console.log(formatSummaryTable(results, draft));
	console.log(`[ai:probe] wrote ${outFile}`);
}

// Guarded the same way tools/ai-compare.ts is — importing this module for its
// exported pure functions (tests) must not also run the CLI against argv.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
	main().catch((err: unknown) => {
		console.error("[ai:probe] failed:", err instanceof Error ? err.message : err);
		process.exitCode = 1;
	});
}
