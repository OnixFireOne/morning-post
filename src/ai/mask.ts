// Pure string helpers so proxy credentials and the API key never end up
// verbatim in logs, alerts, or ./out/*.ai.json (sections 2/3.2 of the v2 spec).
// Both functions are total: an unparsable URL returns a safe placeholder
// instead of throwing, since callers use these specifically when something
// has already gone wrong and building an error message must not itself fail.

/** `http://user:pass@host:port/path?query` -> `http://user:***@host:port` — password always masked, path/query always dropped. */
export function maskProxyUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "(invalid url)";
	}
	const auth = parsed.username ? `${parsed.username}:***@` : "";
	return `${parsed.protocol}//${auth}${parsed.host}`;
}

/** Just the host (with port if present) — safe to log as "provider" in usage records. */
export function getHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "(invalid url)";
	}
}

/** `sk-ant-...` -> `sk-a...12` — enough to tell two keys apart in a report without exposing either. A secret of 8 chars or less returns a fixed placeholder that contains none of it, since a short prefix+suffix would be most or all of the value. */
export function maskSecret(secret: string): string {
	if (!secret || secret.length <= 8) return "***";
	return `${secret.slice(0, 4)}...${secret.slice(-2)}`;
}

/** Last-resort scrub: replaces every literal occurrence of `secret` in `text` with `***`, for text that isn't built from known-safe parts (e.g. a proxy's own response body echoing the key back in an error message). A no-op when secret is empty, so an unset key can't turn this into "mask every empty string". */
export function redactSecret(text: string, secret: string): string {
	if (!secret) return text;
	return text.split(secret).join("***");
}
