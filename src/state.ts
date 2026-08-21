import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StateDay, StateHistory } from "./facts.js";

export type { StateDay, StateHistory };

const MAX_HISTORY_DAYS = 60;

export function readState(stateFile: string): StateHistory {
	if (!existsSync(stateFile)) return { days: [] };
	const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as StateHistory;
	return { days: Array.isArray(parsed.days) ? parsed.days : [] };
}

export function findPostedDay(history: StateHistory, dateKey: string): StateDay | undefined {
	return history.days.find((d) => d.date === dateKey);
}

/** Раздел 5: атомарная запись — во временный файл рядом, затем rename, чтобы падение не било историю. */
export function writeStateAtomic(stateFile: string, history: StateHistory): void {
	const dir = path.dirname(stateFile);
	mkdirSync(dir, { recursive: true });
	const tmpFile = path.join(dir, `.${path.basename(stateFile)}.${process.pid}.tmp`);
	writeFileSync(tmpFile, JSON.stringify(history, null, 2));
	renameSync(tmpFile, stateFile);
}

/** Заменяет запись за day.date (если уже была — например, при --force) и хранит только последние ~60 дней. */
export function appendDay(history: StateHistory, day: StateDay): StateHistory {
	const withoutSameDay = history.days.filter((d) => d.date !== day.date);
	const days = [...withoutSameDay, day].sort((a, b) => a.date.localeCompare(b.date));
	return { days: days.slice(-MAX_HISTORY_DAYS) };
}
