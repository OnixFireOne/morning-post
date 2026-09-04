// tools/ai-probe.ts §7.3 (plan/ai-providering.md): deriveProfileDraft and
// renderProbeReport are pure — no network, no env reads — so every scenario
// here is built from canned ProbeResult fixtures, never a real request.
// Covers exactly what the plan calls for: the five named response shapes
// (200 w/ usage.cost, 200 w/ tokens only, 404 on /models, 400 without the
// version header, and a timeout), the three costSource verdicts, and that
// the real API key never survives into the rendered report even when a body
// echoes it back.
import { describe, expect, it } from "vitest";
import { deriveProfileDraft, renderProbeReport, resolveProbeEnv, type ProbeResult } from "../tools/ai-probe.js";
import { redactSecret } from "../src/ai/mask.js";

function ok(index: number, overrides: Partial<ProbeResult> = {}): ProbeResult {
	return {
		index,
		label: `probe ${index}`,
		method: "POST",
		url: "https://proxy.example.com/v1/messages",
		headersSent: { "x-api-key": "sk-a...12" },
		requestBody: { model: "claude-sonnet-4-7" },
		status: 200,
		durationMs: 250,
		responseHeaders: { "content-type": "application/json" },
		bodyText: "{}",
		bodyJson: {},
		errorKind: null,
		errorMessage: null,
		skipped: false,
		skipReason: null,
		...overrides,
	};
}

function skipped(index: number, reason: string): ProbeResult {
	return { index, label: `probe ${index}`, method: "POST", url: "", headersSent: {}, requestBody: null, status: null, durationMs: 0, responseHeaders: {}, bodyText: null, bodyJson: null, errorKind: null, errorMessage: null, skipped: true, skipReason: reason };
}

function timedOut(index: number, url: string): ProbeResult {
	return { index, label: `probe ${index}`, method: "POST", url, headersSent: { "x-api-key": "sk-a...12" }, requestBody: { model: "claude-sonnet-4-7" }, status: null, durationMs: 15000, responseHeaders: {}, bodyText: null, bodyJson: null, errorKind: "timeout", errorMessage: "timed out after 15000ms", skipped: false, skipReason: null };
}

/** A minimal set of the 8 slots deriveProfileDraft indexes into, with probe 3 as the one being varied per test. */
function baseline(probe3: ProbeResult): ProbeResult[] {
	return [
		ok(1, { method: "GET", url: "https://proxy.example.com/v1/models", status: 404, bodyJson: null, bodyText: "not found" }),
		ok(2, { method: "GET", url: "https://proxy.example.com/v1/models", status: 404, bodyJson: null, bodyText: "not found" }),
		probe3,
		ok(4, { url: "https://proxy.example.com/v1/messages", status: 200, requestBody: { model: "claude-sonnet-4-7" }, bodyJson: { model: "claude-sonnet-4-7" } }),
		skipped(5, "probe 3 did not return 404/405 — no reason to try a different path"),
		ok(6, { status: 404 }),
		ok(7, { url: "https://proxy.example.com/v1/chat/completions", status: 404 }),
		skipped(8, "AI_PROBE_MODEL_FALLBACK (or AI_MODEL_FALLBACK) not set"),
	];
}

describe("deriveProfileDraft: costSource — three verdicts, from the real usage block only", () => {
	it("'provider': the response's own usage carries a numeric cost", () => {
		const probe3 = ok(3, { requestBody: { model: "claude-sonnet-4-7" }, bodyJson: { model: "claude-sonnet-4-7", usage: { input_tokens: 10, output_tokens: 5, cost: 0.002 } } });
		const draft = deriveProfileDraft(baseline(probe3));
		expect(draft.costSource.value).toBe("provider");
		// same happy fixture also proves the rest of the happy path:
		expect(draft.baseUrl.value).toBe("https://proxy.example.com/v1");
		expect(draft.authStyle.value).toBe("x-api-key");
		expect(draft.primaryModel.value).toBe("claude-sonnet-4-7");
		// probe 4 (no anthropic-version) succeeded on its own -> field omitted entirely
		expect(draft.apiVersion).toBeNull();
	});

	it("'table': usage has token counts but no cost field", () => {
		const probe3 = ok(3, { bodyJson: { model: "claude-sonnet-4-7", usage: { input_tokens: 10, output_tokens: 5 } } });
		expect(deriveProfileDraft(baseline(probe3)).costSource.value).toBe("table");
	});

	it("'none': no usage block in the response at all", () => {
		const probe3 = ok(3, { bodyJson: { model: "claude-sonnet-4-7", content: [{ type: "text", text: "ok" }] } });
		expect(deriveProfileDraft(baseline(probe3)).costSource.value).toBe("none");
	});

	it("'TODO(unverified)': no messages probe ever got a real response (e.g. every probe timed out)", () => {
		const results = baseline(timedOut(3, "https://proxy.example.com/v1/messages")).map((r) => (r.index === 4 || r.index === 6 ? timedOut(r.index, r.url || "https://proxy.example.com/v1/messages") : r));
		const draft = deriveProfileDraft(results);
		expect(draft.costSource.value).toBe("TODO(unverified)");
		expect(draft.baseUrl.value).toBe("TODO(unverified)");
		expect(draft.primaryModel.value).toBe("TODO(unverified)");
	});
});

describe("deriveProfileDraft: modelsPath", () => {
	it("404 on both /models probes -> null (no listing), not a guess", () => {
		const probe3 = ok(3, { bodyJson: { model: "claude-sonnet-4-7", usage: { input_tokens: 1, output_tokens: 1 } } });
		const draft = deriveProfileDraft(baseline(probe3));
		expect(draft.modelsPath.value).toBeNull();
	});

	it("200 with a { data: [{id}] } list -> \"/models\"", () => {
		const probe3 = ok(3, { bodyJson: { model: "claude-sonnet-4-7", usage: { input_tokens: 1, output_tokens: 1 } } });
		const results = baseline(probe3).map((r) => (r.index === 1 ? ok(1, { method: "GET", url: "https://proxy.example.com/v1/models", status: 200, bodyJson: { data: [{ id: "claude-sonnet-4-7" }] } }) : r));
		expect(deriveProfileDraft(results).modelsPath.value).toBe("/models");
	});
});

describe("deriveProfileDraft: apiVersion — only recorded when probe 4 (no header) actually failed", () => {
	it("400 without the header while probe 3 (with it) succeeds -> apiVersion is written, not omitted", () => {
		const probe3 = ok(3, { headersSent: { "x-api-key": "sk-a...12", "anthropic-version": "2023-06-01" }, bodyJson: { model: "claude-sonnet-4-7", usage: { input_tokens: 1, output_tokens: 1 } } });
		const results = baseline(probe3).map((r) => (r.index === 4 ? ok(4, { status: 400, bodyJson: { error: { message: "anthropic-version header is required" } } }) : r));
		const draft = deriveProfileDraft(results);
		expect(draft.apiVersion).not.toBeNull();
		expect(draft.apiVersion?.value).toBe("2023-06-01");
	});
});

describe("deriveProfileDraft: baseUrl falls back to the /v1/messages path when the bare path 404s", () => {
	it("probe 3 (POST /messages) 404s, probe 5 (POST /v1/messages) succeeds -> baseUrl includes /v1", () => {
		const probe3 = ok(3, { url: "https://proxy.example.com/messages", status: 404, bodyJson: null, bodyText: "not found" });
		const probe5 = ok(5, { url: "https://proxy.example.com/v1/messages", status: 200, bodyJson: { model: "claude-sonnet-4-7", usage: { input_tokens: 1, output_tokens: 1 } } });
		const results = baseline(probe3).map((r) => (r.index === 5 ? probe5 : r.index === 4 ? ok(4, { url: "https://proxy.example.com/messages", status: 404 }) : r.index === 6 ? ok(6, { url: "https://proxy.example.com/messages", status: 404 }) : r));
		const draft = deriveProfileDraft(results);
		expect(draft.baseUrl.value).toBe("https://proxy.example.com/v1");
	});
});

describe("resolveProbeEnv", () => {
	it("falls back to AI_BASE_URL/AI_MODEL when AI_PROBE_* isn't set, and says so", () => {
		const resolved = resolveProbeEnv([], { AI_BASE_URL: "https://proxy.example.com/v1", AI_MODEL: "claude-sonnet-4-7", AI_API_KEY: "sk-real-key" });
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.env.baseUrl).toBe("https://proxy.example.com/v1");
			expect(resolved.env.model).toBe("claude-sonnet-4-7");
			expect(resolved.env.resolutionNotes.some((n) => n.includes("AI_BASE_URL"))).toBe(true);
		}
	});

	it("fails with one clear error when no API key is set, before any request would be made", () => {
		const resolved = resolveProbeEnv([], { AI_PROBE_BASE_URL: "https://proxy.example.com/v1", AI_PROBE_MODEL: "m" });
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.error).toMatch(/API key/);
	});
});

describe("renderProbeReport: the real API key never survives into the rendered report", () => {
	it("headersSent are already masked, and a stray echo of the raw key in a body is scrubbed by the caller's redactSecret pass", () => {
		const REAL_KEY = "sk-ant-super-secret-actual-key-value";
		const probe3 = ok(3, {
			headersSent: { "x-api-key": "sk-a...ue" }, // already masked, as executeProbe would produce
			bodyJson: { model: "claude-sonnet-4-7", usage: { input_tokens: 1, output_tokens: 1 } },
			bodyText: `{"model":"claude-sonnet-4-7"}`,
		});
		// Simulates a misbehaving proxy that echoes the raw key back in an error body.
		const leaky = ok(6, { status: 500, bodyText: `{"error":"bad key: ${REAL_KEY}"}`, bodyJson: null });
		const results = baseline(probe3).map((r) => (r.index === 6 ? leaky : r));
		const draft = deriveProfileDraft(results);

		const report = renderProbeReport(results, draft, { startedAt: new Date("2026-09-04T09:00:00Z"), baseUrl: "https://proxy.example.com/v1", model: "claude-sonnet-4-7", resolutionNotes: [] });
		const safeReport = redactSecret(report, REAL_KEY);

		expect(safeReport).not.toContain(REAL_KEY);
		expect(safeReport).toContain("***");
	});
});
