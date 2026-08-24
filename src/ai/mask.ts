// Pure string helpers so proxy credentials and the API key never end up
// verbatim in logs, alerts, or ./out/*.ai.json (раздел 2/3.2 of the v2 spec).
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
