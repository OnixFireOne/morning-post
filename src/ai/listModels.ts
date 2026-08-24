// Manual command: `npm run ai:models`. This is the one place in the project
// allowed to hit the real network on purpose, and only when a human runs it —
// never invoked by index.ts, never invoked by a test. First step of local
// rollout (section 2): fetch the provider's actual model ids instead of
// guessing them from Anthropic's own documentation.
import "dotenv/config";
import { createAiClient } from "./client.js";
import { maskProxyUrl } from "./mask.js";

function readEnv() {
	return {
		baseUrl: process.env.AI_BASE_URL || "",
		apiKey: process.env.AI_API_KEY || "",
		proxyUrl: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",
	};
}

async function main() {
	const env = readEnv();
	if (!env.baseUrl || !env.apiKey) {
		console.error("[ai:models] AI_BASE_URL and AI_API_KEY must both be set in .env.");
		process.exitCode = 1;
		return;
	}

	const client = createAiClient({ baseUrl: env.baseUrl, apiKey: env.apiKey, proxyUrl: env.proxyUrl || undefined });
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
		console.error("[ai:models] failed:", err instanceof Error ? err.message : err);
		process.exitCode = 1;
	}
}

main();
