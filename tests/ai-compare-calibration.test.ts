import { describe, expect, it } from "vitest";
import { billedInputTokens, computeCost, PROXY_INPUT_TOKEN_OVERHEAD } from "../src/ai/usage.js";
import { formatCalibratedCostLine } from "../tools/ai-compare.js";

// The exact real numbers from the 2026-08-25 live run (see reports/) — this is the
// pre-migration reference value: PROXY_INPUT_TOKEN_OVERHEAD used to be ai-compare's
// own private copy of the constant; it now comes from src/ai/usage.js's single
// shared definition (billedInputTokens/PROXY_INPUT_TOKEN_OVERHEAD), used by both
// ai:compare's report and the daily usage-report's balance calibration.
const TOKENS_IN = 6158;
const TOKENS_OUT = 226;
const PRICE_IN = 14;
const PRICE_OUT = 42;

describe("formatCalibratedCostLine: same number as before the PROXY_INPUT_TOKEN_OVERHEAD migration", () => {
	it("matches the pre-migration formula exactly (tokensIn - 2539, same computeCost call)", () => {
		const preMigrationCalibratedTokensIn = Math.max(0, TOKENS_IN - 2539);
		const preMigrationCost = computeCost({ promptTokens: preMigrationCalibratedTokensIn, completionTokens: TOKENS_OUT, totalTokens: preMigrationCalibratedTokensIn + TOKENS_OUT, cachedTokens: null }, PRICE_IN, PRICE_OUT)!;

		const line = formatCalibratedCostLine(TOKENS_IN, TOKENS_OUT, PRICE_IN, PRICE_OUT);
		expect(line).toContain(preMigrationCost.toFixed(4));
	});

	it("PROXY_INPUT_TOKEN_OVERHEAD is still 2539 after moving to src/ai/usage.js", () => {
		expect(PROXY_INPUT_TOKEN_OVERHEAD).toBe(2539);
	});

	it("billedInputTokens matches the inline Math.max(0, tokensIn - overhead) the old code used", () => {
		expect(billedInputTokens(TOKENS_IN)).toBe(Math.max(0, TOKENS_IN - PROXY_INPUT_TOKEN_OVERHEAD));
	});

	it("returns null when either price knob is unset, same as before", () => {
		expect(formatCalibratedCostLine(TOKENS_IN, TOKENS_OUT, null, PRICE_OUT)).toBeNull();
		expect(formatCalibratedCostLine(TOKENS_IN, TOKENS_OUT, PRICE_IN, null)).toBeNull();
	});

	it("returns null when tokens are unknown, same as before", () => {
		expect(formatCalibratedCostLine(null, TOKENS_OUT, PRICE_IN, PRICE_OUT)).toBeNull();
		expect(formatCalibratedCostLine(TOKENS_IN, null, PRICE_IN, PRICE_OUT)).toBeNull();
	});
});
