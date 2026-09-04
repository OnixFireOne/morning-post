// The one switch on AiProviderProfile.protocol in the whole project (plan/
// ai-providering.md §4). Everything above this point (generate.ts,
// tools/ai-compare.ts, src/ai/listModels.ts) calls createTransport() and
// never asks which protocol answered; everything below it (client.ts,
// clientMessages.ts) never asks who's calling. A third protocol later is a
// new file plus one more branch here — nothing above or below this file
// changes.
import { createChatCompletionsClient, type AiClient, type AiClientOptions, type FetchLike } from "./client.js";
import { createMessagesClient } from "./clientMessages.js";
import type { AiProviderProfile } from "./providers.js";

export type CreateTransportOptions = {
	apiKey: string;
	/** HTTPS_PROXY/HTTP_PROXY, if set. */
	proxyUrl?: string;
	/** Injectable for tests — defaults to the global fetch when omitted, same as both underlying clients. */
	fetchImpl?: FetchLike;
};

export function createTransport(profile: AiProviderProfile, opts: CreateTransportOptions): AiClient {
	const common: AiClientOptions = {
		baseUrl: profile.baseUrl,
		apiKey: opts.apiKey,
		proxyUrl: opts.proxyUrl,
		authStyle: profile.authStyle,
		extraHeaders: profile.extraHeaders,
		fetchImpl: opts.fetchImpl,
	};

	// The validator always resolves protocol (default "chat_completions" —
	// see providers.ts's own comment on AiProviderProfile.protocol), so this
	// only matters for a profile object built by hand, bypassing validation
	// (a test, most likely) — the described factory behavior still holds.
	const protocol = profile.protocol ?? "chat_completions";

	switch (protocol) {
		case "chat_completions":
			return createChatCompletionsClient(common);
		case "messages": {
			if (profile.maxTokens === undefined) {
				// validateProviderProfile already guarantees this for anything that
				// actually loaded through the catalog — this only fires for a
				// hand-built profile that skipped validation.
				throw new Error(`provider "${profile.name}": maxTokens is required at protocol "messages"`);
			}
			return createMessagesClient({ ...common, name: profile.name, apiVersion: profile.apiVersion, maxTokens: profile.maxTokens, modelsPath: profile.modelsPath });
		}
		default: {
			const exhaustive: never = protocol;
			throw new Error(`unknown protocol: ${JSON.stringify(exhaustive)}`);
		}
	}
}
