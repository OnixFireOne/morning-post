import { describe, expect, it } from "vitest";
import { plural, verbForm } from "../src/format.js";

const COINS = ["монета", "монеты", "монет"] as const;
const DAYS = ["день", "дня", "дней"] as const;
const FALLS = ["падает", "падают"] as const;

describe("plural", () => {
	it.each([
		[1, "монета"],
		[2, "монеты"],
		[4, "монеты"],
		[5, "монет"],
		[11, "монет"],
		[12, "монет"],
		[14, "монет"],
		[21, "монета"],
		[22, "монеты"],
		[25, "монет"],
		[111, "монет"],
		[134, "монеты"],
	])("plural(%i, [монета, монеты, монет]) === %s", (n, expected) => {
		expect(plural(n, COINS)).toBe(expected);
	});

	it.each([
		[1, "день"],
		[2, "дня"],
		[4, "дня"],
		[5, "дней"],
		[11, "дней"],
		[12, "дней"],
		[14, "дней"],
		[21, "день"],
		[22, "дня"],
		[25, "дней"],
		[111, "дней"],
		[134, "дня"],
	])("plural(%i, [день, дня, дней]) === %s", (n, expected) => {
		expect(plural(n, DAYS)).toBe(expected);
	});

	it("treats negative numbers the same as their absolute value", () => {
		expect(plural(-1, COINS)).toBe("монета");
		expect(plural(-5, COINS)).toBe("монет");
	});
});

describe("verbForm", () => {
	it.each([
		[1, "падает"],
		[2, "падают"],
		[11, "падают"],
		[21, "падает"],
		[101, "падает"],
	])("verbForm(%i, [падает, падают]) === %s", (n, expected) => {
		expect(verbForm(n, FALLS)).toBe(expected);
	});

	it("21 is singular, 11 is plural — the two-form rule diverges from plural()'s three forms", () => {
		expect(verbForm(21, FALLS)).toBe("падает");
		expect(verbForm(11, FALLS)).toBe("падают");
	});

	it("treats negative numbers the same as their absolute value", () => {
		expect(verbForm(-1, FALLS)).toBe("падает");
		expect(verbForm(-2, FALLS)).toBe("падают");
	});
});
