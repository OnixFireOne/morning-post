import { describe, expect, it } from "vitest";
import { formatAlert } from "../src/alert.js";

describe("formatAlert", () => {
	it("includes the step, error type/message, and exit code", () => {
		const text = formatAlert({ step: "capture", error: new Error("boom"), exitCode: 1 });
		expect(text).toContain("Шаг: capture");
		expect(text).toContain("Ошибка: Error: boom");
		expect(text).toContain("Exit code: 1");
		expect(text).toMatch(/Время \(МСК\): \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2}/);
	});

	it("includes up to 10 stack lines for an Error", () => {
		const error = new Error("boom");
		error.stack = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		const text = formatAlert({ step: "capture", error, exitCode: 1 });
		expect(text).toContain("line 9");
		expect(text).not.toContain("line 10");
	});

	it("handles a non-Error thrown value without a stack", () => {
		const text = formatAlert({ step: "render", error: "just a string", exitCode: 1 });
		expect(text).toContain("Ошибка: string: just a string");
		expect(text).not.toContain("Стек:");
	});

	it("omits retriesExhausted and SITE_URL when not provided", () => {
		const text = formatAlert({ step: "facts", error: new Error("x"), exitCode: 1 });
		expect(text).not.toContain("Ретраев исчерпано");
		expect(text).not.toContain("SITE_URL");
	});

	it("includes retriesExhausted and SITE_URL when provided", () => {
		const text = formatAlert({ step: "capture", error: new Error("x"), retriesExhausted: 2, siteUrl: "http://localhost:3000/?snapshot=1", exitCode: 1 });
		expect(text).toContain("Ретраев исчерпано: 2");
		expect(text).toContain("SITE_URL: http://localhost:3000/?snapshot=1");
	});

	it("never includes a bot token — nothing in AlertContext carries one", () => {
		const text = formatAlert({ step: "telegram", error: new Error("telegram: sendPhoto failed (401): Unauthorized"), exitCode: 1 });
		expect(text).not.toMatch(/bot\d+:/);
	});
});
