import { describe, expect, it } from "vitest";
import { getHost, maskProxyUrl, maskSecret, redactSecret } from "../src/ai/mask.js";

describe("maskProxyUrl", () => {
	it("masks the password and drops path/query, keeping protocol/user/host/port", () => {
		expect(maskProxyUrl("http://alice:s3cr3t@proxy.example.com:8080/some/path?x=1")).toBe("http://alice:***@proxy.example.com:8080");
	});

	it("leaves a proxy URL with no credentials untouched apart from dropping the path", () => {
		expect(maskProxyUrl("http://proxy.example.com:8080/")).toBe("http://proxy.example.com:8080");
	});

	it("never includes the real password in the output", () => {
		const masked = maskProxyUrl("https://bob:hunter2@proxy.internal:3128");
		expect(masked).not.toContain("hunter2");
	});

	it("returns a safe placeholder for an unparsable URL instead of throwing", () => {
		expect(() => maskProxyUrl("not a url")).not.toThrow();
		expect(maskProxyUrl("not a url")).toBe("(invalid url)");
	});
});

describe("getHost", () => {
	it("returns host:port for the base URL, nothing else", () => {
		expect(getHost("https://proxy.example.com:8443/v1")).toBe("proxy.example.com:8443");
	});

	it("drops credentials too, if a base URL somehow carried them", () => {
		expect(getHost("https://user:pass@proxy.example.com/v1")).toBe("proxy.example.com");
	});

	it("returns a safe placeholder for an unparsable URL instead of throwing", () => {
		expect(() => getHost("not a url")).not.toThrow();
		expect(getHost("not a url")).toBe("(invalid url)");
	});
});

describe("maskSecret", () => {
	it("keeps the first 4 and last 2 characters, never the middle", () => {
		expect(maskSecret("sk-ant-api03-realvalue")).toBe("sk-a...ue");
	});

	it("returns a fixed placeholder for empty/short input, containing none of it", () => {
		expect(maskSecret("")).toBe("***");
		expect(maskSecret("short")).toBe("***");
	});
});

describe("redactSecret", () => {
	it("replaces every occurrence of the secret in the text with ***", () => {
		const text = "error: bad key sk-real-key in request, retried with sk-real-key again";
		const redacted = redactSecret(text, "sk-real-key");
		expect(redacted).not.toContain("sk-real-key");
		expect(redacted).toBe("error: bad key *** in request, retried with *** again");
	});

	it("is a no-op when the secret is empty — an unset key can't redact every empty string", () => {
		expect(redactSecret("some text", "")).toBe("some text");
	});
});
