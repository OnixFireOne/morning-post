// Copy of the snapshot contract from `OnixFireOne/inp`'s `lib/hotCoinsSnapshot.ts`.
// The two repos are not linked by a dependency, only by this shared shape and
// the `version` field — bump it here (and check it at load time) whenever the
// site-side contract changes.

export type HotCoinsSnapshot = {
	version: 1;
	ts: string; // ISO, момент рендера
	btc: { price: number; change24h: number } | null;
	mainSwarm: SwarmCoin[]; // то, что в основном рое
	edgePins: SwarmCoin[]; // прижатые к краям
};

export type SwarmCoin = {
	id: string; // coingecko id
	ticker: string; // ВЕРСАЛЬНОЕ, как на графике
	change24h: number; // проценты, не доли
	price: number;
	marketCap: number | null;
};

// Where the snapshot actually lands in the page (раздел 2) — capture.ts reads
// this through page.evaluate(). Undefined without ?snapshot=1.
declare global {
	interface Window {
		__HOT_COINS_SNAPSHOT__?: HotCoinsSnapshot;
	}
}
