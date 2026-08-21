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

/** `SNAPSHOT_FILE` debug mode (раздел 6): load a snapshot from disk instead of a live browser. */
export function loadSnapshotFromFile(filePath: string): HotCoinsSnapshot {
	const raw = JSON.parse(readFileSync(filePath, "utf8"));
	return parseSnapshot(raw);
}
