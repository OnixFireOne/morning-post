import { readFileSync } from "node:fs";
import type { HotCoinsSnapshot } from "./types.js";

export const SNAPSHOT_CONTRACT_VERSION = 1;

/**
 * Distinct from a plain Error so capture.ts's retry wrapper can recognize it
 * and give up immediately (раздел 8) — a version mismatch is a permanent
 * contract break, not a transient failure retrying would fix.
 */
export class SnapshotContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SnapshotContractError";
	}
}

/**
 * Validates an arbitrary parsed JSON value against the snapshot contract.
 * Throws instead of returning `undefined`/partial data — a version mismatch
 * means the inp.one contract changed and every downstream number would be
 * unreliable, so callers should alert rather than silently degrade (раздел 8).
 */
export function parseSnapshot(raw: unknown): HotCoinsSnapshot {
	if (typeof raw !== "object" || raw === null) {
		throw new Error("snapshot: expected an object");
	}
	const snap = raw as Partial<HotCoinsSnapshot>;
	if (snap.version !== SNAPSHOT_CONTRACT_VERSION) {
		throw new SnapshotContractError(
			`snapshot: unsupported contract version ${JSON.stringify(snap.version)}, expected ${SNAPSHOT_CONTRACT_VERSION} (контракт снапшота изменился)`,
		);
	}
	return snap as HotCoinsSnapshot;
}

/** `--fixture=<path>` debug mode (раздел 6): load a snapshot from disk instead of a live browser. */
export function loadSnapshotFromFile(filePath: string): HotCoinsSnapshot {
	const raw = JSON.parse(readFileSync(filePath, "utf8"));
	return parseSnapshot(raw);
}

/**
 * Same as loadSnapshotFromFile, except a missing file gets a message with
 * the actual path instead of a bare ENOENT stack. A bare ENOENT here already
 * cost a real debugging session once, back when the path could come from
 * three different places at once (positional arg / `.env` / an npm script
 * default) and a stray inline `#` comment in `.env` had silently mangled it
 * — now there's exactly one source (`--fixture=<path>`), so the message just
 * needs the path itself, not a list of places to check. Only index.ts's
 * `--dry --fixture` entrypoint uses this wrapper; every other caller of
 * loadSnapshotFromFile (tools, tests) keeps the plain error.
 */
export function loadSnapshotFileOrThrow(filePath: string): HotCoinsSnapshot {
	try {
		return loadSnapshotFromFile(filePath);
	} catch (err) {
		if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
			throw new Error(`snapshot: fixture file not found: ${filePath}\nCheck the path passed via --fixture=<path>.`);
		}
		throw err;
	}
}

export type SnapshotSource = { mode: "file"; path: string } | { mode: "browser"; url: string };

/** An empty string, a whitespace-only string, and a missing/null value are all "not set" — none of them is a path/URL. `--fixture=` with nothing after the `=` must resolve exactly like the flag being absent, not like a path with zero characters. */
function isSet(value: string | null | undefined): value is string {
	return typeof value === "string" && value.trim() !== "";
}

/**
 * The one place that decides file-vs-browser. Pure and file-system-free on
 * purpose: `fixture` is the already-parsed `--fixture=<path>` value (see
 * cliArgs.ts's CliArgs.fixture — null when the flag wasn't passed), `siteUrl`
 * is `.env`'s own SITE_URL (an address, not a mode — stays in `.env`); this
 * function only ever answers "is that a real path or not".
 */
export function resolveSnapshotSource(input: { fixture: string | null; siteUrl?: string }): SnapshotSource {
	if (isSet(input.fixture)) return { mode: "file", path: input.fixture.trim() };
	return { mode: "browser", url: isSet(input.siteUrl) ? input.siteUrl.trim() : "" };
}
