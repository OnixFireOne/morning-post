import { describe, expect, it } from "vitest";
import { plural } from "../src/format.js";

const COINS = ["монета", "монеты", "монет"] as const;
const DAYS = ["день", "дня", "дней"] as const;

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
