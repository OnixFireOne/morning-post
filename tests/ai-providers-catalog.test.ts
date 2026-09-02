// The provider catalog moved from TypeScript literals (src/ai/providers.ts)
// to data (config/providers.json, or AI_PROVIDERS_FILE for an out-of-repo
// alternative — see providers.ts's own top comment). This file covers what
// tests/ai-providers.test.ts's existing profile-shape/cost-computation
// coverage doesn't: that the real committed file actually loads and passes
// its own validator, that nothing secret-shaped ended up in it, and that
// every listed validation failure actually fails loudly, naming the
// provider and field. No real network call anywhere — everything here is
// either the real local config/providers.json or an ad-hoc temp file.
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROVIDER_NAME, listProviderNames, resolveProviderProfile, validateProviderProfile } from "../src/ai/providers.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_FILE = path.join(REPO_ROOT, "config", "providers.json");

describe("config/providers.json: the real committed catalog", () => {
	it("loads and resolves the default provider profile", () => {
		const profile = resolveProviderProfile(undefined);
		expect(profile.name).toBe(DEFAULT_PROVIDER_NAME);
		expect(profile.baseUrl).toBeTruthy();
		expect(profile.apiKeyVar).toBeTruthy();
	});

	it("every entry round-trips through validateProviderProfile without throwing", () => {
		const raw = JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as Record<string, unknown>;
		expect(Object.keys(raw).length).toBeGreaterThan(0);
		for (const [key, value] of Object.entries(raw)) {
			expect(() => validateProviderProfile(key, value)).not.toThrow();
		}
	});

	it("listProviderNames matches the file's own keys", () => {
		const raw = JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as Record<string, unknown>;
		expect(listProviderNames().sort()).toEqual(Object.keys(raw).sort());
	});

	// apiKeyVar holds a variable *name* ("AI_API_KEY"), never a value — the
	// whole point of this field (see providers.ts's own comment, the LiteLLM
	// os.environ/VAR and llm-env api_key_var= pattern) is that no secret ever
	// has to live in a file that gets committed to git. This is the guard that
	// actually proves it, against the real file, not just against the type.
	it("no field in the raw JSON looks like a real secret value (sk-... or similar)", () => {
		const text = readFileSync(CATALOG_FILE, "utf8");
		expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
		expect(text).not.toMatch(/"apiKey"\s*:/); // the field must be apiKeyVar, never a literal apiKey
	});
});

describe("validateProviderProfile: negative cases — each names the provider and the specific field", () => {
	function validProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			name: "test",
			baseUrl: "https://example.com/v1",
			authStyle: "bearer",
			apiKeyVar: "TEST_API_KEY",
			extraHeaders: {},
			primaryModel: "m",
			fallbackModel: "m",
			costSource: "provider",
			priceTable: {},
			inputOverhead: 0,
			balanceSource: "api",
			unitRate: 1,
			...overrides,
		};
	}

	it("accepts a well-formed profile as a sanity baseline", () => {
		expect(() => validateProviderProfile("test", validProfile())).not.toThrow();
	});

	it("rejects a raw value that isn't an object", () => {
		expect(() => validateProviderProfile("test", "not an object")).toThrow(/must be an object/);
		expect(() => validateProviderProfile("test", null)).toThrow(/must be an object/);
		expect(() => validateProviderProfile("test", [1, 2])).toThrow(/must be an object/);
	});

	it("unknown field — named specifically, not a generic 'invalid config'", () => {
		expect(() => validateProviderProfile("test", validProfile({ unexpectedField: "x" }))).toThrow(/provider "test": unexpectedField.*not a recognized field/);
	});

	it("missing baseUrl", () => {
		const { baseUrl: _baseUrl, ...rest } = validProfile();
		expect(() => validateProviderProfile("test", rest)).toThrow(/provider "test": baseUrl.*non-empty string/);
	});

	it("empty-string baseUrl is rejected the same as missing — no field is a valid empty string", () => {
		expect(() => validateProviderProfile("test", validProfile({ baseUrl: "" }))).toThrow(/baseUrl.*non-empty string/);
		expect(() => validateProviderProfile("test", validProfile({ baseUrl: "   " }))).toThrow(/baseUrl.*non-empty string/);
	});

	it("costSource: table without priceTable", () => {
		const { priceTable: _priceTable, ...rest } = validProfile({ costSource: "table" });
		expect(() => validateProviderProfile("test", rest)).toThrow(/provider "test": priceTable.*object/);
	});

	it("costSource: table with an empty priceTable — same practical trap as no priceTable at all", () => {
		expect(() => validateProviderProfile("test", validProfile({ costSource: "table", priceTable: {} }))).toThrow(/priceTable.*at least one entry.*costSource is "table"/);
	});

	it("costSource: provider is fine with an empty priceTable — it's never consulted", () => {
		expect(() => validateProviderProfile("test", validProfile({ costSource: "provider", priceTable: {} }))).not.toThrow();
	});

	it("empty apiKeyVar", () => {
		expect(() => validateProviderProfile("test", validProfile({ apiKeyVar: "" }))).toThrow(/provider "test": apiKeyVar.*non-empty string/);
	});

	it("missing apiKeyVar", () => {
		const { apiKeyVar: _apiKeyVar, ...rest } = validProfile();
		expect(() => validateProviderProfile("test", rest)).toThrow(/apiKeyVar.*non-empty string/);
	});

	it("invalid authStyle", () => {
		expect(() => validateProviderProfile("test", validProfile({ authStyle: "basic" }))).toThrow(/authStyle.*"bearer" or "x-api-key"/);
	});

	it("invalid costSource", () => {
		expect(() => validateProviderProfile("test", validProfile({ costSource: "estimate" }))).toThrow(/costSource.*"provider" or "table"/);
	});

	it("invalid balanceSource", () => {
		expect(() => validateProviderProfile("test", validProfile({ balanceSource: "auto" }))).toThrow(/balanceSource.*"api" or "manual"/);
	});

	it("name field must match the provider's own key — catches a copy-paste mistake in the JSON", () => {
		expect(() => validateProviderProfile("openrouter", validProfile({ name: "anthropic" }))).toThrow(/name.*match the provider's own key.*"openrouter"/);
	});

	it("priceTable entry missing priceInPerMillion/priceOutPerMillion", () => {
		expect(() => validateProviderProfile("test", validProfile({ costSource: "table", priceTable: { m: { priceInPerMillion: 1 } } }))).toThrow(/priceTable.*priceOutPerMillion.*number/);
	});

	it("inputOverhead must be a non-negative number", () => {
		expect(() => validateProviderProfile("test", validProfile({ inputOverhead: -1 }))).toThrow(/inputOverhead.*>= 0/);
		expect(() => validateProviderProfile("test", validProfile({ inputOverhead: "0" }))).toThrow(/inputOverhead.*>= 0/);
	});

	it("unitRate must be a positive number", () => {
		expect(() => validateProviderProfile("test", validProfile({ unitRate: 0 }))).toThrow(/unitRate.*positive number/);
		expect(() => validateProviderProfile("test", validProfile({ unitRate: -1 }))).toThrow(/unitRate.*positive number/);
	});

	it("extraHeaders must be an object of strings", () => {
		expect(() => validateProviderProfile("test", validProfile({ extraHeaders: "none" }))).toThrow(/extraHeaders.*object of string headers/);
		expect(() => validateProviderProfile("test", validProfile({ extraHeaders: { X: 5 } }))).toThrow(/extraHeaders.*"X".*string/);
	});
});

describe("AI_PROVIDERS_FILE: an alternative catalog outside the repo", () => {
	let tmpDir: string;

	afterEach(() => {
		delete process.env.AI_PROVIDERS_FILE;
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeCatalog(contents: string): string {
		tmpDir = mkdtempSync(path.join(tmpdir(), "morning-post-providers-"));
		const file = path.join(tmpDir, "providers.json");
		writeFileSync(file, contents);
		return file;
	}

	it("a valid custom catalog is used instead of the built-in one", () => {
		const file = writeCatalog(
			JSON.stringify({
				custom: {
					name: "custom",
					baseUrl: "https://custom.example.com/v1",
					authStyle: "bearer",
					apiKeyVar: "CUSTOM_API_KEY",
					extraHeaders: {},
					primaryModel: "m",
					fallbackModel: "m",
					costSource: "provider",
					priceTable: {},
					inputOverhead: 0,
					balanceSource: "api",
					unitRate: 1,
				},
			}),
		);
		process.env.AI_PROVIDERS_FILE = file;

		expect(listProviderNames()).toEqual(["custom"]);
		const profile = resolveProviderProfile("custom");
		expect(profile.baseUrl).toBe("https://custom.example.com/v1");
		expect(profile.apiKeyVar).toBe("CUSTOM_API_KEY");
	});

	it("resolving a name not in the custom catalog lists the custom catalog's own names, not the built-in ones", () => {
		const file = writeCatalog(
			JSON.stringify({
				custom: {
					name: "custom",
					baseUrl: "https://custom.example.com/v1",
					authStyle: "bearer",
					apiKeyVar: "CUSTOM_API_KEY",
					extraHeaders: {},
					primaryModel: "m",
					fallbackModel: "m",
					costSource: "provider",
					priceTable: {},
					inputOverhead: 0,
					balanceSource: "api",
					unitRate: 1,
				},
			}),
		);
		process.env.AI_PROVIDERS_FILE = file;

		expect(() => resolveProviderProfile("openrouter")).toThrow(/unknown AI_PROVIDER: "openrouter" — expected one of: custom/);
	});

	it("a path that doesn't exist throws — never silently falls back to the built-in catalog", () => {
		process.env.AI_PROVIDERS_FILE = path.join(tmpdir(), "morning-post-does-not-exist", "providers.json");
		expect(() => resolveProviderProfile(undefined)).toThrow(/cannot read/);
		expect(() => resolveProviderProfile(undefined)).toThrow(/AI_PROVIDERS_FILE/);
	});

	it("a file that isn't valid JSON throws — never silently falls back", () => {
		const file = writeCatalog("this is not json {{{");
		process.env.AI_PROVIDERS_FILE = file;
		expect(() => resolveProviderProfile(undefined)).toThrow(/not valid JSON/);
	});

	it("a file that fails schema validation throws, naming the provider and field — never silently falls back to the default openrouter profile", () => {
		const file = writeCatalog(JSON.stringify({ custom: { name: "custom" /* missing everything else */ } }));
		process.env.AI_PROVIDERS_FILE = file;
		expect(() => resolveProviderProfile(undefined)).toThrow(/provider "custom": baseUrl/);
	});

	it("an empty AI_PROVIDERS_FILE (whitespace only) is treated as unset — falls through to config/providers.json", () => {
		process.env.AI_PROVIDERS_FILE = "   ";
		expect(resolveProviderProfile(undefined).name).toBe(DEFAULT_PROVIDER_NAME);
	});
});
