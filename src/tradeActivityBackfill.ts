import {
  fetchActivityForMarket,
  type PolyActivity,
} from "./polymarketActivityApi";

/** Journal / closed-trade shapes used by server.ts (minimal for backfill). */
export type BackfillJournalEntry = {
  atMs: number;
  marketKey?: string;
  marketSlug: string;
  kind: "BUY" | "SELL";
  side: "YES" | "NO";
  outcomeLabel: string;
  shares: number;
  price: number;
  priceKind: "limit" | "fill" | "hint";
  notionalUsd?: number;
  realizedPnlUsd: number | null;
  cumulativeRealizedAfter?: number;
};

export type BackfillClosedTrade = {
  atMs: number;
  marketKey?: string;
  marketSlug: string;
  side: "YES" | "NO";
  outcomeLabel: string;
  shares: number;
  avgBuy: number;
  sellFill: number | null;
  sellHint: number | null;
  realizedPnlUsd: number | null;
};

export type BackfillMarketTarget = {
  marketSlug: string;
  conditionId: string;
  marketKey: string;
  upAssetId: string;
  downAssetId: string;
  upOutcomeLabel: string;
  downOutcomeLabel: string;
};

/** When matching journal rows to activity fills (hotkey time ≠ on-chain time). */
const MATCH_MS = 30 * 60 * 1000;
/** Only treat two SELL lines as duplicates if recorded within this window. */
const DEDUPE_SELL_MS = 2 * 60 * 1000;
const SIZE_EPS = 0.05;

function activityMs(a: PolyActivity): number {
  return a.timestamp * 1000;
}

function sizeMatches(a: number, b: number): boolean {
  return Math.abs(a - b) <= SIZE_EPS;
}

function sideForAsset(
  target: BackfillMarketTarget,
  assetId: string,
): "YES" | "NO" | null {
  if (assetId === target.upAssetId) return "YES";
  if (assetId === target.downAssetId) return "NO";
  return null;
}

function assetForSide(
  target: BackfillMarketTarget,
  side: "YES" | "NO",
): string {
  return side === "YES" ? target.upAssetId : target.downAssetId;
}

function outcomeLabelForSide(
  target: BackfillMarketTarget,
  side: "YES" | "NO",
): string {
  return side === "YES" ? target.upOutcomeLabel : target.downOutcomeLabel;
}

/** Closest activity row to `atMs` among candidates. */
function pickClosest(
  candidates: PolyActivity[],
  atMs: number,
): PolyActivity | null {
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  let bestD = Math.abs(activityMs(best) - atMs);
  for (let i = 1; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    const d = Math.abs(activityMs(c) - atMs);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

function findActivityMatch(
  activity: PolyActivity[],
  assetId: string,
  side: "BUY" | "SELL",
  shares: number,
  atMs: number,
): PolyActivity | null {
  const candidates = activity.filter(
    (a) =>
      a.asset === assetId &&
      a.side === side &&
      sizeMatches(a.size, shares) &&
      Math.abs(activityMs(a) - atMs) <= MATCH_MS,
  );
  return pickClosest(candidates, atMs);
}

/** Nearest prior BUY on same asset before a SELL timestamp. */
function findBuyBeforeSell(
  activity: PolyActivity[],
  assetId: string,
  sellMs: number,
  shares: number,
): PolyActivity | null {
  const candidates = activity.filter(
    (a) =>
      a.asset === assetId &&
      a.side === "BUY" &&
      sizeMatches(a.size, shares) &&
      activityMs(a) <= sellMs + 5000 &&
      sellMs - activityMs(a) <= 45 * 60 * 1000,
  );
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  let bestD = sellMs - activityMs(best);
  for (let i = 1; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    const d = sellMs - activityMs(c);
    if (d >= 0 && d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

function journalSellMatchesActivity(
  journal: BackfillJournalEntry[],
  sellAct: PolyActivity,
  side: "YES" | "NO",
  slug: string,
): boolean {
  const ms = activityMs(sellAct);
  return journal.some(
    (j) =>
      j.kind === "SELL" &&
      j.side === side &&
      j.marketSlug.toLowerCase() === slug.toLowerCase() &&
      sizeMatches(j.shares, sellAct.size) &&
      Math.abs(j.atMs - ms) <= MATCH_MS,
  );
}

type ActivityPair = { buy: PolyActivity; sell: PolyActivity };

/** FIFO round-trips from Polymarket activity (oldest first). */
function buildActivityPairs(
  activity: PolyActivity[],
  assetId: string,
): ActivityPair[] {
  const rows = activity
    .filter((a) => a.asset === assetId && (a.side === "BUY" || a.side === "SELL"))
    .sort((a, b) => activityMs(a) - activityMs(b));

  const pairs: ActivityPair[] = [];
  const pendingBuys: PolyActivity[] = [];

  for (const row of rows) {
    if (row.side === "BUY") {
      pendingBuys.push(row);
      continue;
    }
    if (row.side !== "SELL" || pendingBuys.length === 0) continue;
    let buyIdx = pendingBuys.findIndex((b) => sizeMatches(b.size, row.size));
    if (buyIdx < 0) buyIdx = 0;
    const buy = pendingBuys.splice(buyIdx, 1)[0]!;
    pairs.push({ buy, sell: row });
  }
  return pairs;
}

function dedupeJournalForSlug(
  journal: BackfillJournalEntry[],
  slug: string,
): void {
  const lower = slug.toLowerCase();
  const keep: BackfillJournalEntry[] = [];
  const drop = new Set<BackfillJournalEntry>();

  const sells = journal
    .filter((j) => j.marketSlug.toLowerCase() === lower && j.kind === "SELL")
    .sort((a, b) => a.atMs - b.atMs);

  for (let i = 0; i < sells.length; i += 1) {
    for (let k = i + 1; k < sells.length; k += 1) {
      const a = sells[i]!;
      const b = sells[k]!;
      if (
        a.side !== b.side ||
        !sizeMatches(a.shares, b.shares) ||
        Math.abs(a.atMs - b.atMs) > DEDUPE_SELL_MS
      ) {
        continue;
      }
      const keepRow =
        a.priceKind === "fill"
          ? a
          : b.priceKind === "fill"
            ? b
            : a.atMs >= b.atMs
              ? a
              : b;
      const dropRow = keepRow === a ? b : a;
      drop.add(dropRow);
    }
  }

  for (const j of journal) {
    if (j.marketSlug.toLowerCase() === lower && drop.has(j)) continue;
    keep.push(j);
  }
  journal.length = 0;
  journal.push(...keep);
}

export function recalculateCumulativeRealized(
  journal: BackfillJournalEntry[],
  marketSlug: string,
): void {
  const slug = marketSlug.toLowerCase();
  const bySide: Record<"YES" | "NO", number> = { YES: 0, NO: 0 };
  const sorted = [...journal]
    .filter((j) => j.marketSlug.toLowerCase() === slug)
    .sort((a, b) => a.atMs - b.atMs);
  for (const j of sorted) {
    if (j.kind !== "SELL" || j.realizedPnlUsd == null) continue;
    bySide[j.side] += j.realizedPnlUsd;
    j.cumulativeRealizedAfter = bySide[j.side];
  }
}

export type BackfillResult = {
  /** SELL rows updated with Polymarket fill prices. */
  fixed: number;
  /** New BUY+SELL pairs added from activity not in journal. */
  added: number;
};

/**
 * Align local trade journal / closed-trade PNL with Polymarket activity fills.
 * Fixes bid-hint sells that under-report exit price and inserts missing round-trips.
 */
export async function backfillTradeHistoryFromActivity(
  wallet: string,
  target: BackfillMarketTarget,
  journal: BackfillJournalEntry[],
  closed: BackfillClosedTrade[],
): Promise<BackfillResult> {
  if (!wallet || !target.conditionId) {
    return { fixed: 0, added: 0 };
  }

  let activity: PolyActivity[];
  try {
    activity = await fetchActivityForMarket(wallet, target.conditionId, {
      limit: 100,
    });
  } catch {
    return { fixed: 0, added: 0 };
  }

  const slug = target.marketSlug;
  let fixed = 0;
  let added = 0;

  const journalHere = journal.filter(
    (j) => j.marketSlug.toLowerCase() === slug.toLowerCase(),
  );

  const usedSellTx = new Set<string>();

  type JournalTrip = { buy: BackfillJournalEntry; sell: BackfillJournalEntry };

  function buildJournalTrips(side: "YES" | "NO"): JournalTrip[] {
    const rows = journalHere
      .filter((j) => j.side === side)
      .sort((a, b) => a.atMs - b.atMs);
    const pending: BackfillJournalEntry[] = [];
    const trips: JournalTrip[] = [];
    for (const row of rows) {
      if (row.kind === "BUY") {
        pending.push(row);
        continue;
      }
      let idx = pending.findIndex((b) => sizeMatches(b.shares, row.shares));
      if (idx < 0 && pending.length > 0) idx = 0;
      if (idx < 0) continue;
      const buy = pending.splice(idx, 1)[0]!;
      trips.push({ buy, sell: row });
    }
    return trips;
  }

  function applyActivityPairToJournal(
    trip: JournalTrip | null,
    buyAct: PolyActivity,
    sellAct: PolyActivity,
  ): boolean {
    if (!(sellAct.price > 1e-9)) return false;
    const sellPx = sellAct.price;
    const buyPx = buyAct.price > 1e-9 ? buyAct.price : NaN;

    if (trip) {
      const { buy: buyJ, sell: sellJ } = trip;
      const hintPx = sellJ.priceKind === "hint" ? sellJ.price : null;
      const needsSellFix =
        sellJ.priceKind !== "fill" ||
        Math.abs(sellJ.price - sellPx) > 0.002 ||
        (sellJ.realizedPnlUsd != null &&
          sellJ.realizedPnlUsd < 0 &&
          buyPx > 1e-9 &&
          sellPx > buyPx + 0.002);

      if (
        !needsSellFix &&
        hintPx != null &&
        Math.abs(hintPx - sellPx) < 0.002
      ) {
        return false;
      }

      sellJ.price = sellPx;
      sellJ.priceKind = "fill";
      sellJ.atMs = activityMs(sellAct);
      if (buyPx > 1e-9) {
        sellJ.realizedPnlUsd = (sellPx - buyPx) * sellJ.shares;
        if (Math.abs(buyJ.price - buyPx) > 0.002) {
          buyJ.price = buyPx;
          buyJ.priceKind = "fill";
          if (buyAct.usdcSize > 0) buyJ.notionalUsd = buyAct.usdcSize;
        }
        buyJ.atMs = activityMs(buyAct);
      }

      const closedRow = closed.find(
        (c) =>
          c.marketSlug.toLowerCase() === slug.toLowerCase() &&
          c.side === sellJ.side &&
          sizeMatches(c.shares, sellJ.shares) &&
          (Math.abs(c.atMs - sellJ.atMs) <= MATCH_MS ||
            Math.abs(c.atMs - activityMs(sellAct)) <= MATCH_MS),
      );
      if (closedRow) {
        closedRow.sellFill = sellPx;
        closedRow.sellHint = hintPx ?? closedRow.sellHint;
        if (buyPx > 1e-9) closedRow.avgBuy = buyPx;
        closedRow.realizedPnlUsd = sellJ.realizedPnlUsd;
        closedRow.atMs = activityMs(sellAct);
      }
      return true;
    }

    const side = sideForAsset(target, sellAct.asset);
    if (!side) return false;
    const label = outcomeLabelForSide(target, side);
    const pnl =
      buyPx > 1e-9 ? (sellPx - buyPx) * sellAct.size : null;

    journal.push({
      atMs: activityMs(buyAct),
      marketKey: target.marketKey,
      marketSlug: slug,
      kind: "BUY",
      side,
      outcomeLabel: label,
      shares: buyAct.size,
      price: buyPx > 1e-9 ? buyPx : buyAct.price,
      priceKind: "fill",
      notionalUsd: buyAct.usdcSize,
      realizedPnlUsd: null,
    });
    journal.push({
      atMs: activityMs(sellAct),
      marketKey: target.marketKey,
      marketSlug: slug,
      kind: "SELL",
      side,
      outcomeLabel: label,
      shares: sellAct.size,
      price: sellPx,
      priceKind: "fill",
      realizedPnlUsd: pnl,
    });
    closed.unshift({
      atMs: activityMs(sellAct),
      marketKey: target.marketKey,
      marketSlug: slug,
      side,
      outcomeLabel: label,
      shares: sellAct.size,
      avgBuy: buyPx > 1e-9 ? buyPx : buyAct.price,
      sellFill: sellPx,
      sellHint: null,
      realizedPnlUsd: pnl,
    });
    return true;
  }

  function takeMatchingJournalTrip(
    pool: JournalTrip[],
    buyAct: PolyActivity,
    sellAct: PolyActivity,
  ): JournalTrip | null {
    const buyPx = buyAct.price;
    let idx = pool.findIndex(
      (t) =>
        sizeMatches(t.buy.shares, buyAct.size) &&
        Math.abs(t.buy.price - buyPx) <= 0.03,
    );
    if (idx < 0) {
      idx = pool.findIndex((t) => sizeMatches(t.sell.shares, sellAct.size));
    }
    if (idx < 0) return null;
    return pool.splice(idx, 1)[0] ?? null;
  }

  for (const side of ["YES", "NO"] as const) {
    const assetId = assetForSide(target, side);
    const actPairs = buildActivityPairs(activity, assetId);
    const journalPool = buildJournalTrips(side);

    for (const { buy: buyAct, sell: sellAct } of actPairs) {
      usedSellTx.add(sellAct.transactionHash);
      const trip = takeMatchingJournalTrip(journalPool, buyAct, sellAct);
      if (applyActivityPairToJournal(trip, buyAct, sellAct)) {
        if (trip) fixed += 1;
        else added += 1;
      }
    }
  }

  dedupeJournalForSlug(journal, slug);
  journal.sort((a, b) => a.atMs - b.atMs);
  recalculateCumulativeRealized(journal, slug);

  return { fixed, added };
}
