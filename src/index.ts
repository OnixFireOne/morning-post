import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { captureSnapshotAndScreenshot } from "./capture.js";
import { computeFacts, type StateHistory } from "./facts.js";
import { buildCaption } from "./render.js";
import { loadSnapshotFromFile } from "./snapshot.js";

function readEnv() {
	// Позиционный аргумент — обход .env для разовых прогонов на фикстуре, без
	// префиксов вида `SNAPSHOT_FILE=... npm run dry`, которые не работают в
	// PowerShell/cmd (раздел 6): `npm run dry:fixture -- fixtures/green.json`.
	const snapshotFileOverride = process.argv.slice(2).find((a) => !a.startsWith("--"));
	return {
		siteUrl: process.env.SITE_URL ?? "",
		// `||`, not `??`, everywhere below: an empty string in .env (e.g. a value
		// swallowed by an unquoted `#` comment) must fall back too, not become 0/"".
		chartSelector: process.env.CHART_SELECTOR || "#hot-coins-chart",
		snapshotFile: snapshotFileOverride || process.env.SNAPSHOT_FILE || "",
		minSwarmSize: Number(process.env.MIN_SWARM_SIZE || 20),
		dryRun: process.env.DRY_RUN === "1",
		outDir: path.resolve(process.env.OUT_DIR || "out"),
	};
}

async function main() {
	const env = readEnv();

	let snapshot;
	let png: Buffer | null = null;
	let stabilizationReads = 0;

	if (env.snapshotFile) {
		snapshot = loadSnapshotFromFile(env.snapshotFile);
		console.log(`[capture] snapshot from file: ${env.snapshotFile}`);
	} else {
		if (!env.siteUrl) throw new Error("SITE_URL is not set (.env)");
		const result = await captureSnapshotAndScreenshot({
			siteUrl: env.siteUrl,
			chartSelector: env.chartSelector,
			minSwarmSize: env.minSwarmSize,
		});
		snapshot = result.snapshot;
		png = result.png;
		stabilizationReads = result.stabilizationReads;
	}

	console.log(
		`[capture] mainSwarm=${snapshot.mainSwarm.length} edgePins=${snapshot.edgePins.length} stabilizationReads=${stabilizationReads}`,
	);

	// Реальный state.json подключается в шаге 5 (telegram.ts + state.ts) — до тех
	// пор история всегда пустая, streak в фактах всегда 1.
	const history: StateHistory = { days: [] };
	const facts = computeFacts(snapshot, history);
	const caption = buildCaption(facts);

	console.log(caption);

	if (env.dryRun) {
		mkdirSync(env.outDir, { recursive: true });
		if (png) writeFileSync(path.join(env.outDir, `${facts.dateKey}.png`), png);
		writeFileSync(path.join(env.outDir, `${facts.dateKey}.facts.json`), JSON.stringify(facts, null, 2));
		console.log(`[dry-run] wrote ${env.outDir}`);
		return;
	}

	throw new Error("publishing to Telegram is not implemented yet (шаг 5)");
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exitCode = 1;
});
