import {
  computeBookDepthMetrics,
  fetchOrderBook,
  type BookDepthMetrics,
} from "./clobOrderBook";
import type { TrackedMarket } from "./types";

/** Per market: live book + session cumulative bid $ (market start → now). */
export type MarketBookDepth = {
  marketSlug: string;
  yesLabel: string;
  noLabel: string;
  yes: BookDepthMetrics;
  no: BookDepthMetrics;
  /** Live snapshot: all resting bids right now (changes as book moves). */
  liveYesBidUsd: number;
  liveNoBidUsd: number;
  /**
   * Session total from market open: starts at $0, then adds only increases in
   * resting bid $ vs the previous poll (never reduced when book shrinks).
   */
  sessionYesBidUsd: number;
  sessionNoBidUsd: number;
  sessionStartedAt: number;
  fetchedAt: number;
};

const cacheBySlug = new Map<string, MarketBookDepth>();

type SessionAccumulator = {
  cumYesBidUsd: number;
  cumNoBidUsd: number;
  lastYesBidUsd: number;
  lastNoBidUsd: number;
  startedAt: number;
};

const sessionBySlug = new Map<string, SessionAccumulator>();

let refreshInFlight = false;
let refreshQueued = false;

function updateSessionTotals(
  slug: string,
  liveYes: number,
  liveNo: number,
): SessionAccumulator {
  const key = slug.toLowerCase();
  let s = sessionBySlug.get(key);
  if (!s) {
    // New market row: start at $0; first poll only records baseline (no seed).
    s = {
      cumYesBidUsd: 0,
      cumNoBidUsd: 0,
      lastYesBidUsd: liveYes,
      lastNoBidUsd: liveNo,
      startedAt: Date.now(),
    };
    sessionBySlug.set(key, s);
    return s;
  }

  if (liveYes > s.lastYesBidUsd) {
    s.cumYesBidUsd += liveYes - s.lastYesBidUsd;
  }
  if (liveNo > s.lastNoBidUsd) {
    s.cumNoBidUsd += liveNo - s.lastNoBidUsd;
  }
  s.lastYesBidUsd = liveYes;
  s.lastNoBidUsd = liveNo;
  return s;
}

export function getBookDepthForMarket(
  marketSlug: string,
): MarketBookDepth | undefined {
  return cacheBySlug.get(marketSlug.toLowerCase());
}

/** Drop session/cache for slugs no longer in the price table (e.g. after 5m roll). */
export function pruneBookDepthToTrackedSlugs(trackedLower: Set<string>): void {
  for (const key of [...sessionBySlug.keys()]) {
    if (!trackedLower.has(key)) sessionBySlug.delete(key);
  }
  for (const key of [...cacheBySlug.keys()]) {
    if (!trackedLower.has(key)) cacheBySlug.delete(key);
  }
}

export async function refreshBookDepths(
  markets: TrackedMarket[],
  clobHost: string,
): Promise<boolean> {
  if (markets.length === 0) return false;
  const tracked = new Set(markets.map((m) => m.marketSlug.toLowerCase()));
  pruneBookDepthToTrackedSlugs(tracked);

  if (refreshInFlight) {
    refreshQueued = true;
    return false;
  }
  refreshInFlight = true;
  let any = false;
  try {
    for (const m of markets) {
      const up = m.tokens.find((t) => t.sideAlias === "UP");
      const down = m.tokens.find((t) => t.sideAlias === "DOWN");
      if (!up || !down) continue;

      const [bookY, bookN] = await Promise.all([
        fetchOrderBook(clobHost, up.assetId),
        fetchOrderBook(clobHost, down.assetId),
      ]);
      if (!bookY || !bookN) continue;

      const yes = computeBookDepthMetrics(bookY);
      const no = computeBookDepthMetrics(bookN);
      const liveYes = yes.totalBidNotionalUsd;
      const liveNo = no.totalBidNotionalUsd;
      const session = updateSessionTotals(m.marketSlug, liveYes, liveNo);

      cacheBySlug.set(m.marketSlug.toLowerCase(), {
        marketSlug: m.marketSlug,
        yesLabel: up.outcomeLabel,
        noLabel: down.outcomeLabel,
        yes,
        no,
        liveYesBidUsd: liveYes,
        liveNoBidUsd: liveNo,
        sessionYesBidUsd: session.cumYesBidUsd,
        sessionNoBidUsd: session.cumNoBidUsd,
        sessionStartedAt: session.startedAt,
        fetchedAt: Date.now(),
      });
      any = true;
    }
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      void refreshBookDepths(markets, clobHost);
    }
  }
  return any;
}

export function clearBookDepthCache(): void {
  cacheBySlug.clear();
  sessionBySlug.clear();
}
