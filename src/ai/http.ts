// Shared between both wire-format transports (client.ts's chat_completions,
// clientMessages.ts's messages — plan/ai-providering.md §4) so neither one
// copy-pastes URL joining or error sanitizing. getHost/maskProxyUrl live in
// mask.ts, not here; this file is just the two request-building/error-text
// helpers both transports need identically.
import { getHost, maskProxyUrl } from "./mask.js";

export function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** The raw error is discarded on purpose — it can embed the proxy URL with credentials. */
export function sanitizeNetworkError(baseUrl: string, proxyUrl: string | undefined): string {
	const parts = ["network error calling", getHost(baseUrl)];
	if (proxyUrl) parts.push(`via proxy ${maskProxyUrl(proxyUrl)}`);
	return parts.join(" ");
}
