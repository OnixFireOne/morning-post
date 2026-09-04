// Manual command: `npm run ai:models`. This is the one place in the project
// allowed to hit the real network on purpose, and only when a human runs it —
// never invoked by index.ts, never invoked by a test. Goes through the same
// createTransport() factory the real publish path uses (plan/ai-providering.md
// §8), selected by AI_PROVIDER — no separate baseUrl/model config of its
// own, so this always asks the exact endpoint/protocol a real run would.
import "dotenv/config";
import { resolveProviderProfile } from "./providers.js";
import { createTransport } from "./transport.js";
import { maskProxyUrl } from "./mask.js";

function readEnv() {
	const provider = resolveProviderProfile(process.env.AI_PROVIDER);
	return {
		provider,
		apiKey: process.env[provider.apiKeyVar] || "",
		proxyUrl: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",
	};
}

async function main() {
	const env = readEnv();
	if (!env.apiKey) {
		console.error(`[ai:models] ${env.provider.apiKeyVar} must be set in .env.`);
		process.exitCode = 1;
		return;
	}

	const client = createTransport(env.provider, { apiKey: env.apiKey, proxyUrl: env.proxyUrl || undefined });
	console.log(`[ai:models] fetching from ${client.providerHost}${env.proxyUrl ? ` via ${maskProxyUrl(env.proxyUrl)}` : ""}`);

	try {
		const models = await client.listModels();
		if (models.length === 0) {
			console.log("[ai:models] no models returned.");
			return;
		}
		console.log(`[ai:models] ${models.length} model(s):`);
		for (const model of models) console.log(`  ${model.id}`);
	} catch (err) {
		// "listing not supported by profile ..." (clientMessages.ts, modelsPath:
		// null) and a real transport failure both land here — the plan's own
		// requirement is the same for either: one line, no stack, exit 1.
		console.error("[ai:models] failed:", err instanceof Error ? err.message : err);
		process.exitCode = 1;
	}
}

main();
