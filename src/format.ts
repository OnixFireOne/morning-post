// Escaping and number formatting shared by phrases.ts and render.ts.
// Kept dependency-free (no Facts import) so it sits at the bottom of the
// import graph: format.ts <- phrases.ts <- render.ts, no cycles.

const TYPOGRAPHIC_MINUS = "−";

/** Escape before wrapping in `<b>` — tickers come straight from the site and can contain anything. */
export function escapeHtml(input: string): string {
	return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Раздел 4.2: round to an integer at |x| >= 10, to one decimal place below that. */
export function formatMagnitude(value: number): string {
	const abs = Math.abs(value);
	return abs >= 10 ? String(Math.round(abs)) : String(Math.round(abs * 10) / 10);
}

/** Signed percent for leader lines and prose mentions, e.g. "+25%", "−25%", "−5.5%". */
export function formatSignedPercent(value: number): string {
	const sign = value < 0 ? TYPOGRAPHIC_MINUS : "+";
	return `${sign}${formatMagnitude(value)}%`;
}

/** BTC header line only (раздел 1): always two decimals, e.g. "−0.59%". */
export function formatBtcPercent(value: number): string {
	const sign = value < 0 ? TYPOGRAPHIC_MINUS : "+";
	return `${sign}${Math.abs(value).toFixed(2)}%`;
}

/** BTC header line only: thousands separator, no cents at >= $1000. */
export function formatBtcPrice(price: number): string {
	const digits = price >= 1000 ? 0 : 2;
	return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(price);
}
