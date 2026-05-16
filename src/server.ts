import {
  BtcPriceService,
  fetchBtcPriceAtUnix,
  type BtcSnapshot,
} from "./btcPriceService";
import { isTradingEnabled, tradeConfig } from "./config";
import {
  UP_DOWN_WINDOW_SECONDS,
  type UpDownConfig,
} from "./cryptoUpDown";
import {
  addPurchase,
  avgEntry,
  emptyLeg,
  formatPnlLine,
  midMark,
  reduceOnSell,
  type SideLeg,
  unrealizedPnlUsd,
} from "./positionLedger";
import {
  fetchUserPositions,
  type PolyUserPosition,
} from "./polymarketDataApi";
import { PolymarketRealtimeService } from "./polymarketService";
import {
  PolymarketTradeService,
  TradeValidationError,
} from "./polymarketTradeService";
import type { TrackedMarket } from "./types";
import {
  createDebouncedTradeHistoryWriter,
  loadTradeHistoryFile,
  resolveTradeHistoryPath,
  type TradeHistoryFileV1,
} from "./tradeHistoryPersistence";

type ActiveTradingTarget = {
  market: TrackedMarket;
  upToken: TrackedMarket["tokens"][number];
  downToken: TrackedMarket["tokens"][number];
};

type ServerCli = {
  marketSlugs: string[];
  discoverSoccerMatches: boolean;
  cryptoUpDown: UpDownConfig | null;
};

function parseServerCli(): ServerCli {
  const args = process.argv.slice(2);
  const slugs: string[] = [];
  let discoverSoccerMatches = false;
  let btc5mEnabled = false;
  // Default: only the current 5-minute window. When it resolves the service
  // refreshes shortly after the boundary and the next window slides in.
  let btc5mCount = 1;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === "--soccer-matches") {
      discoverSoccerMatches = true;
      continue;
    }

    if (arg.startsWith("--soccer-matches=")) {
      const raw = arg.slice("--soccer-matches=".length).trim().toLowerCase();
      discoverSoccerMatches =
        raw === "" || raw === "1" || raw === "true" || raw === "yes";
      continue;
    }

    if (arg === "--btc-5m") {
      btc5mEnabled = true;
      continue;
    }

    if (arg.startsWith("--btc-5m=")) {
      const raw = arg.slice("--btc-5m=".length).trim().toLowerCase();
      btc5mEnabled =
        raw === "" || raw === "1" || raw === "true" || raw === "yes";
      continue;
    }

    if (arg.startsWith("--btc-5m-count=")) {
      const raw = arg.slice("--btc-5m-count=".length).trim();
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) {
        btc5mEnabled = true;
        btc5mCount = n;
      }
      continue;
    }

    if (arg.startsWith("--market-slug=")) {
      const value = arg.slice("--market-slug=".length).trim();
      if (value) slugs.push(value);
      continue;
    }

    if (arg === "--market-slug" && args[i + 1]) {
      const value = args[i + 1].trim();
      if (value) slugs.push(value);
      i += 1;
      continue;
    }

    if (!arg.startsWith("--")) {
      const values = arg
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      slugs.push(...values);
    }
  }

  const cryptoUpDown: UpDownConfig | null = btc5mEnabled
    ? { symbol: "btc", duration: "5m", count: btc5mCount }
    : null;

  return {
    marketSlugs: Array.from(new Set(slugs.map((slug) => slug.toLowerCase()))),
    discoverSoccerMatches,
    cryptoUpDown,
  };
}

const { marketSlugs, discoverSoccerMatches, cryptoUpDown } = parseServerCli();

const service = new PolymarketRealtimeService({
  marketSlugs,
  discoverSoccerMatches,
  cryptoUpDown: cryptoUpDown ?? undefined,
});

/**
 * Live BTC/USD spot from Coinbase, used as the live mark + the source of
 * "target" prices (open of the 1-minute candle at each window's start).
 * Only spun up in cryptoUpDown mode.
 */
const btcPriceService =
  cryptoUpDown && cryptoUpDown.symbol.toLowerCase() === "btc"
    ? new BtcPriceService()
    : null;

/** Canonical target price (open of 1-min Coinbase candle at window start). */
const btcTargetPriceByWindow = new Map<number, number>();
/**
 * Approximate target snapshotted from live BTC WS at the moment a window
 * rotation is first observed. Used when the canonical REST candle hasn't been
 * indexed yet (boundary first ~30s). Overwritten by REST when it lands.
 */
const btcTargetSnapshotByWindow = new Map<number, number>();
/** Windows currently being fetched, to avoid duplicate REST calls. */
const btcTargetFetchInFlight = new Set<number>();
/** Windows we've tried but Coinbase had no candle yet (don't spam retries). */
const btcTargetMissAt = new Map<number, number>();
const TARGET_RETRY_AFTER_MS = 5_000;

const tradingEnabled = isTradingEnabled();
const tradeService = tradingEnabled ? new PolymarketTradeService() : null;

/**
 * Per-market session ledger of hotkey buys (weighted avg entry).
 * Keyed by `marketKey(t)` — one entry per market the user has traded this run.
 * Survives switching the active market (so [pending] lots don't disappear).
 */
type MarketLedger = { yes: SideLeg; no: SideLeg };
const marketLedgers = new Map<string, MarketLedger>();

function marketKey(t: ActiveTradingTarget): string {
  const { market, upToken, downToken } = t;
  // Slug first — each Polymarket row (incl. rolling btc-updown-5m-<unix>) is unique.
  return `${market.marketSlug}:${market.conditionId || ""}:${upToken.assetId}:${downToken.assetId}`;
}

/** Trade log / closed trades: exact slug only (never bleed across rows or 5m windows). */
function historyMatchesRow(
  entry: { marketSlug: string },
  rowSlug: string,
): boolean {
  return entry.marketSlug.toLowerCase() === rowSlug.toLowerCase();
}

function getOrCreateLedger(t: ActiveTradingTarget): MarketLedger {
  const k = marketKey(t);
  let entry = marketLedgers.get(k);
  if (!entry) {
    entry = { yes: emptyLeg(), no: emptyLeg() };
    marketLedgers.set(k, entry);
  }
  return entry;
}

/** One completed sell — scoped by `marketKey` so logs never mix across rows. */
type ClosedTradeEntry = {
  atMs: number;
  /** Same as hotkey ledger key: conditionId + token ids (unique per row). */
  marketKey?: string;
  marketSlug: string;
  side: "YES" | "NO";
  outcomeLabel: string;
  shares: number;
  /** Weighted avg entry from session ledger immediately before sell. */
  avgBuy: number;
  sellFill: number | null;
  sellHint: number | null;
  /** (effective sell $/sh − avg buy) × shares; sell uses fill or hint. */
  realizedPnlUsd: number | null;
};

const closedTradeHistory: ClosedTradeEntry[] = [];
const MAX_CLOSED_TRADE_HISTORY = 20;

function pushClosedTrade(entry: ClosedTradeEntry): void {
  closedTradeHistory.unshift(entry);
  while (closedTradeHistory.length > MAX_CLOSED_TRADE_HISTORY) {
    closedTradeHistory.pop();
  }
  schedulePersistTradeHistory();
}

function formatClosedTradeHistoryLine(
  t: ClosedTradeEntry,
  opts?: { omitSlug?: boolean },
): string {
  const time = new Date(t.atMs).toLocaleTimeString("en-US", {
    hour12: true,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const buyStr =
    t.avgBuy > 1e-12 ? `${(t.avgBuy * 100).toFixed(1)}c` : "—";
  let sellStr = "—";
  if (t.sellFill != null && t.sellFill > 1e-12) {
    sellStr = `${(t.sellFill * 100).toFixed(1)}c fill`;
    if (
      t.sellHint != null &&
      t.sellHint > 1e-12 &&
      Math.abs(t.sellHint - t.sellFill) > 1e-6
    ) {
      sellStr += ` (hint ${(t.sellHint * 100).toFixed(1)}c)`;
    }
  } else if (t.sellHint != null && t.sellHint > 1e-12) {
    sellStr = `~${(t.sellHint * 100).toFixed(1)}c (hint only)`;
  }
  const pnlStr =
    t.realizedPnlUsd != null
      ? formatPnlLine(t.realizedPnlUsd)
      : "PNL: —";
  const slugPart = opts?.omitSlug ? "" : `${t.marketSlug} `;
  return `  ${time} ${slugPart}${t.side} (${t.outcomeLabel}) | ${t.shares.toFixed(2)} sh | buy avg ${buyStr} → sell ${sellStr} | ${pnlStr}`;
}

/** Every hotkey BUY (filled) / SELL — `marketKey` ties rows to Gamma condition + tokens (never mix slugs). */
type TradeJournalEntry = {
  atMs: number;
  marketKey?: string;
  marketSlug: string;
  kind: "BUY" | "SELL";
  side: "YES" | "NO";
  outcomeLabel: string;
  shares: number;
  /** Limit price (BUY) or effective sell $/share for display. */
  price: number;
  priceKind: "limit" | "fill" | "hint";
  notionalUsd?: number;
  realizedPnlUsd: number | null;
  /** Running realized PNL on this market+side after this SELL (null for BUY). */
  cumulativeRealizedAfter?: number;
};

const tradeJournal: TradeJournalEntry[] = [];
const MAX_TRADE_JOURNAL = 400;

function cumulativeRealizedForMarketSide(
  slug: string,
  side: "YES" | "NO",
): number {
  let s = 0;
  for (const j of tradeJournal) {
    if (j.side !== side || j.kind !== "SELL") continue;
    if (j.realizedPnlUsd == null || !Number.isFinite(j.realizedPnlUsd)) continue;
    if (!historyMatchesRow(j, slug)) continue;
    s += j.realizedPnlUsd;
  }
  return s;
}

function pushTradeJournal(entry: TradeJournalEntry): void {
  tradeJournal.push(entry);
  while (tradeJournal.length > MAX_TRADE_JOURNAL) {
    tradeJournal.shift();
  }
  schedulePersistTradeHistory();
}

function formatJournalTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString("en-US", {
    hour12: true,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTradeJournalLine(j: TradeJournalEntry): string {
  const t = formatJournalTime(j.atMs);
  const side = `${j.side} (${j.outcomeLabel})`;
  const px = (j.price * 100).toFixed(1);
  const priceNote =
    j.priceKind === "limit"
      ? `${px}c limit`
      : j.priceKind === "fill"
        ? `${px}c fill`
        : `${px}c hint`;
  if (j.kind === "BUY") {
    const notl =
      j.notionalUsd != null &&
      Number.isFinite(j.notionalUsd) &&
      j.notionalUsd > 0
        ? ` | notional ~$${j.notionalUsd.toFixed(2)}`
        : "";
    return `  ${t}  BUY  ${side}  ${j.shares.toFixed(2)} sh @ ${priceNote}${notl}`;
  }
  const pnlStr =
    j.realizedPnlUsd != null
      ? formatPnlLine(j.realizedPnlUsd)
      : "PNL —";
  const cumStr =
    j.cumulativeRealizedAfter != null &&
    Number.isFinite(j.cumulativeRealizedAfter)
      ? ` | cum ${j.cumulativeRealizedAfter >= 0 ? "+" : ""}${j.cumulativeRealizedAfter.toFixed(2)}`
      : "";
  return `  ${t}  SELL ${side}  ${j.shares.toFixed(2)} sh @ ${priceNote}  |  ${pnlStr}${cumStr}`;
}

/** Multiple consecutive BUY rows → one line with weighted-average entry. */
function formatWeightedBuyClusterLine(run: TradeJournalEntry[]): string {
  const head = run[0];
  let sh = 0;
  let cost = 0;
  let notion = 0;
  for (const e of run) {
    sh += e.shares;
    cost += e.shares * e.price;
    if (e.notionalUsd != null && Number.isFinite(e.notionalUsd))
      notion += e.notionalUsd;
  }
  const t =
    run.length > 1
      ? `${formatJournalTime(run[0].atMs)}–${formatJournalTime(
          run[run.length - 1].atMs,
        )}`
      : formatJournalTime(head.atMs);
  const side = `${head.side} (${head.outcomeLabel})`;
  const wavg = sh > 1e-9 ? cost / sh : head.price;
  const px = (wavg * 100).toFixed(1);
  const notl =
    notion > 1e-6 ? ` | notional ~$${notion.toFixed(2)}` : "";
  const n = run.length;
  return `  ${t}  BUY  ${side}  ${sh.toFixed(
    2,
  )} sh @ ${px}c wavg (${n} fills)${notl}`;
}

function formatTradeJournalLinesGrouped(entries: TradeJournalEntry[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    if (e.kind !== "BUY") {
      out.push(formatTradeJournalLine(e));
      i += 1;
      continue;
    }
    const run: TradeJournalEntry[] = [e];
    let j = i + 1;
    while (
      j < entries.length &&
      entries[j].kind === "BUY" &&
      entries[j].side === run[0].side &&
      entries[j].outcomeLabel === run[0].outcomeLabel
    ) {
      run.push(entries[j]);
      j += 1;
    }
    if (run.length === 1) {
      out.push(formatTradeJournalLine(run[0]));
    } else {
      out.push(formatWeightedBuyClusterLine(run));
    }
    i = j;
  }
  return out;
}

function buildTradeHistorySnapshot(): TradeHistoryFileV1 {
  const sliceJ = tradeJournal.slice(-MAX_TRADE_JOURNAL);
  const sliceC = closedTradeHistory.slice(0, MAX_CLOSED_TRADE_HISTORY);
  return {
    version: 1,
    tradeJournal: sliceJ.map((j) => ({ ...j })),
    closedTradeHistory: sliceC.map((c) => ({ ...c })),
    marketLedgers: Object.fromEntries(
      [...marketLedgers.entries()].map(([k, v]) => [
        k,
        {
          yes: { shares: v.yes.shares, cost: v.yes.cost },
          no: { shares: v.no.shares, cost: v.no.cost },
        },
      ]),
    ),
  };
}

const tradeHistoryWriter = createDebouncedTradeHistoryWriter(
  400,
  buildTradeHistorySnapshot,
);

function schedulePersistTradeHistory(): void {
  tradeHistoryWriter.schedule();
}

/** Drop journal / closed / ledger rows for slugs no longer in the price table. */
function pruneTradeHistoryToTrackedSlugs(trackedLower: Set<string>): boolean {
  const keep = (slug: string) => trackedLower.has(slug.toLowerCase());
  let changed = false;

  for (let i = tradeJournal.length - 1; i >= 0; i -= 1) {
    if (!keep(tradeJournal[i].marketSlug)) {
      tradeJournal.splice(i, 1);
      changed = true;
    }
  }
  for (let i = closedTradeHistory.length - 1; i >= 0; i -= 1) {
    if (!keep(closedTradeHistory[i].marketSlug)) {
      closedTradeHistory.splice(i, 1);
      changed = true;
    }
  }
  for (const key of [...marketLedgers.keys()]) {
    const slug = key.split(":")[0] ?? "";
    if (!keep(slug)) {
      marketLedgers.delete(key);
      changed = true;
    }
  }
  if (changed) schedulePersistTradeHistory();
  return changed;
}

function hydrateTradeHistoryFromDisk(): void {
  const restored = loadTradeHistoryFile();
  if (!restored) return;
  tradeJournal.length = 0;
  tradeJournal.push(...restored.tradeJournal.slice(-MAX_TRADE_JOURNAL));
  closedTradeHistory.length = 0;
  closedTradeHistory.push(
    ...restored.closedTradeHistory.slice(0, MAX_CLOSED_TRADE_HISTORY),
  );
  marketLedgers.clear();
  for (const [k, v] of Object.entries(restored.marketLedgers)) {
    marketLedgers.set(k, {
      yes: { shares: v.yes.shares, cost: v.yes.cost },
      no: { shares: v.no.shares, cost: v.no.cost },
    });
  }
  console.log(
    `[history] restored ${tradeJournal.length} journal + ${closedTradeHistory.length} closed + ${marketLedgers.size} ledger(s) ← ${resolveTradeHistoryPath()}`,
  );
}

/** Index of the market that hotkeys 1/2/7/8 act on. Cycle with [ / ]. */
let activeMarketIndex = 0;

/** Polymarket Data API positions cache, keyed by CTF asset id. */
type PositionState = { position: PolyUserPosition; fetchedAt: number };
const positionsByAssetId = new Map<string, PositionState>();
let positionsLastFetchedAt = 0;
let positionsInFlight = false;
/** When true, another refresh was requested while in-flight; run again after finish. */
let positionsRefreshPending = false;
/** Background Polymarket positions poll; shorter in crypto up/down mode so fills show sooner. */
const POSITIONS_REFRESH_MS = cryptoUpDown != null ? 2000 : 7000;

/**
 * Asset ids whose data-api position should be ignored after a successful sell,
 * until the API catches up to on-chain truth (eventually consistent, ~5-30s).
 * Map value = epoch ms after which we resume trusting the API for this asset.
 */
const recentlySoldAssets = new Map<string, number>();
const SOLD_IGNORE_MS = 45_000;

/** Data API reported size > 0 for this CTF asset this session. */
const apiConfirmedHoldingByAssetId = new Set<string>();
/** Consecutive position polls with flat API while session ledger still has shares. */
const flatApiStreakByAssetId = new Map<string, number>();
/**
 * Require this many consecutive position polls showing flat WHILE ledger still has
 * shares, and only AFTER the Data API has reported a non‑zero holding for this
 * asset (`apiConfirmedHoldingByAssetId`). Otherwise we falsely log “SELL” when the
 * API is simply slow after a BUY.
 */
const FLAT_WHILE_LEDGER_CONFIRM_POLLS = 3;

let triggerRender: () => void = () => {};
let triggerPositionsRefresh: () => void = () => {};

function markAssetRecentlySold(assetId: string): void {
  positionsByAssetId.delete(assetId);
  recentlySoldAssets.set(assetId, Date.now() + SOLD_IGNORE_MS);
}

function isAssetSellSuppressed(assetId: string): boolean {
  const until = recentlySoldAssets.get(assetId);
  if (until == null) return false;
  if (Date.now() >= until) {
    recentlySoldAssets.delete(assetId);
    return false;
  }
  return true;
}

/** Buys cancel the suppression for that asset (we're back in long territory). */
function clearSellSuppression(assetId: string): void {
  recentlySoldAssets.delete(assetId);
}

/**
 * Polymarket balance is flat but the hotkey session ledger still has shares
 * (manual sell on the website, or missed hotkey SELL). Clear ledger and log SELL.
 */
function clearStaleSessionLeg(
  target: ActiveTradingTarget,
  token: TrackedMarket["tokens"][number],
  isYes: boolean,
  sellPriceHint: number | null | undefined,
): boolean {
  const ledger = marketLedgers.get(marketKey(target));
  if (!ledger) return false;
  const leg = isYes ? ledger.yes : ledger.no;
  if (leg.shares <= 1e-6) return false;

  const sharesCleared = leg.shares;
  const avgBuy = avgEntry(leg);
  const sellPx =
    sellPriceHint != null && Number.isFinite(sellPriceHint) && sellPriceHint > 0
      ? sellPriceHint
      : null;
  const realizedPnl =
    sellPx != null && avgBuy > 1e-12
      ? (sellPx - avgBuy) * sharesCleared
      : null;

  reduceOnSell(leg, sharesCleared);
  apiConfirmedHoldingByAssetId.delete(token.assetId);
  flatApiStreakByAssetId.delete(token.assetId);

  const { market } = target;
  const sideTag = isYes ? "YES" : "NO";
  const mk = marketKey(target);
  const priorCum = cumulativeRealizedForMarketSide(market.marketSlug, sideTag);
  const cumAfter = priorCum + (realizedPnl ?? 0);

  pushClosedTrade({
    atMs: Date.now(),
    marketKey: mk,
    marketSlug: market.marketSlug,
    side: sideTag,
    outcomeLabel: token.outcomeLabel,
    shares: sharesCleared,
    avgBuy,
    sellFill: null,
    sellHint: sellPx,
    realizedPnlUsd: realizedPnl,
  });
  pushTradeJournal({
    atMs: Date.now(),
    marketKey: mk,
    marketSlug: market.marketSlug,
    kind: "SELL",
    side: sideTag,
    outcomeLabel: token.outcomeLabel,
    shares: sharesCleared,
    price: sellPx ?? 0,
    priceKind: "hint",
    realizedPnlUsd: realizedPnl,
    cumulativeRealizedAfter: cumAfter,
  });
  schedulePersistTradeHistory();
  return true;
}

function reconcileSessionLedgerWithApi(markets: TrackedMarket[]): boolean {
  if (positionsLastFetchedAt <= 0) return false;
  let changed = false;

  for (const m of markets) {
    const tgt = buildTargetForMarket(m);
    if (!tgt) continue;
    const ledger = marketLedgers.get(marketKey(tgt));
    if (!ledger) continue;

    const legs: Array<{
      token: TrackedMarket["tokens"][number];
      leg: SideLeg;
      isYes: boolean;
    }> = [
      { token: tgt.upToken, leg: ledger.yes, isYes: true },
      { token: tgt.downToken, leg: ledger.no, isYes: false },
    ];

    for (const { token, leg, isYes } of legs) {
      if (leg.shares <= 1e-6) continue;
      if (isAssetSellSuppressed(token.assetId)) continue;

      const cached = positionsByAssetId.get(token.assetId);
      if (cached && cached.position.size > 0.0001) {
        flatApiStreakByAssetId.delete(token.assetId);
        continue;
      }

      const hadApi = apiConfirmedHoldingByAssetId.has(token.assetId);

      const streak = (flatApiStreakByAssetId.get(token.assetId) ?? 0) + 1;
      flatApiStreakByAssetId.set(token.assetId, streak);

      /** Only reconcile when Polymarket once confirmed you held this outcome, then went flat — e.g. sold on web. Never infer from ledger alone + stale API lag. */
      const shouldClear =
        hadApi && streak >= FLAT_WHILE_LEDGER_CONFIRM_POLLS;

      if (!shouldClear) continue;

      if (
        clearStaleSessionLeg(
          tgt,
          token,
          isYes,
          getBestBidFor(token.assetId),
        )
      ) {
        changed = true;
      }
    }
  }
  return changed;
}

/** Data API often lags fills by hundreds of ms–s; re-poll a few times after a trade. */
function scheduleBurstPositionRefreshes(): void {
  for (const ms of [350, 900, 2200, 5000]) {
    setTimeout(() => {
      void refreshPositions();
    }, ms).unref();
  }
}

async function refreshPositions(): Promise<void> {
  if (!tradeConfig.funderAddress) return;
  if (positionsInFlight) {
    positionsRefreshPending = true;
    return;
  }
  const markets = getOrderedMarkets();
  if (markets.length === 0) return;

  positionsInFlight = true;
  try {
    const conditionIds = markets
      .map((m) => m.conditionId)
      .filter((id): id is string => Boolean(id));

    const list = await fetchUserPositions(tradeConfig.funderAddress, {
      conditionIds,
      sizeThreshold: 0.0001,
      limit: 200,
    });

    const targetAssetIds = new Set<string>();
    for (const m of markets) {
      for (const t of m.tokens) targetAssetIds.add(t.assetId);
    }

    let changed = false;
    const seen = new Set<string>();
    for (const pos of list) {
      if (!targetAssetIds.has(pos.asset)) continue;

      // After a successful sell the data API can lag for tens of seconds.
      // While suppressed, ignore stale "still holding" entries; only let the
      // suppression drop when the API finally reports zero (i.e. drops the row).
      if (isAssetSellSuppressed(pos.asset) && pos.size > 0.0001) {
        seen.add(pos.asset);
        continue;
      }
      // API caught up — clear any leftover suppression flag for this asset.
      clearSellSuppression(pos.asset);
      if (pos.size > 0.0001) {
        apiConfirmedHoldingByAssetId.add(pos.asset);
      }

      seen.add(pos.asset);
      const prev = positionsByAssetId.get(pos.asset);
      if (
        !prev ||
        prev.position.size !== pos.size ||
        prev.position.avgPrice !== pos.avgPrice
      ) {
        changed = true;
      }
      positionsByAssetId.set(pos.asset, { position: pos, fetchedAt: Date.now() });
    }
    // Drop entries the API no longer reports (sold to zero) for tracked tokens.
    for (const id of Array.from(positionsByAssetId.keys())) {
      if (targetAssetIds.has(id) && !seen.has(id)) {
        positionsByAssetId.delete(id);
        changed = true;
      }
    }
    positionsLastFetchedAt = Date.now();
    if (reconcileSessionLedgerWithApi(markets)) {
      changed = true;
    }
    if (changed) triggerRender();
  } catch (err) {
    // Network blips: keep the previous cache so the UI doesn't blank out.
    console.error(
      `[positions] refresh failed: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    positionsInFlight = false;
    if (positionsRefreshPending) {
      positionsRefreshPending = false;
      void refreshPositions();
    }
  }
}

const HOTKEYS_HINT =
  "[1/2]BUY {YES,NO} (SHARES sh)  [4/5]BUY {YES,NO} (~$BUY_USD)  [7/8]SELL ALL {YES,NO}  [0]CANCEL ALL  [q]quit";

async function main(): Promise<void> {
  if (!discoverSoccerMatches && !cryptoUpDown && marketSlugs.length === 0) {
    console.error(
      'Missing input. Use "--market-slug <slug>" or positional slug(s). Event slugs (e.g. ucl-...) expand to all match markets. Or pass --soccer-matches / --btc-5m.',
    );
    process.exit(1);
  }

  hydrateTradeHistoryFromDisk();

  let renderScheduled = false;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let updateCount = 0;
  let lastStatus = "";
  /** Detects btc-updown window roll so we clear stale status + on-disk history. */
  let lastCryptoTrackedSlugKey = "";

  const renderImmediate = (): void => {
    if (renderTimer != null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    renderScheduled = false;
    renderTable();
  };

  /** Coalesce rapid WS price ticks; do not use for hotkey / trade feedback. */
  const scheduleRender = (): void => {
    if (renderScheduled) return;
    renderScheduled = true;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderScheduled = false;
      renderTable();
    }, 50);
  };

  const renderTable = (): void => {
    const snapshot = service.getSnapshot();
    const prices = Object.values(snapshot.prices);
    if (prices.length === 0) return;

    const formatCents = (value?: string): string => {
      const n = Number(value);
      return Number.isFinite(n) ? `${(n * 100).toFixed(1)}c` : "-";
    };

    console.clear();
    const tradingTag = tradingEnabled
      ? `trading=ON shares=${tradeConfig.shares} buy=$${tradeConfig.buyUsd}`
      : "trading=OFF";
    const modeTag = cryptoUpDown
      ? ` | mode=${cryptoUpDown.symbol.toUpperCase()}-${cryptoUpDown.duration}`
      : "";
    console.log(
      `Polymarket live prices | ${snapshot.marketCount} market(s), ${snapshot.tokenCount} token(s) | updates=${updateCount} | ${tradingTag}${modeTag} | at=${new Date().toLocaleTimeString("en-US", { hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
    );

    clampActiveIndex();
    const orderedMarkets = snapshot.markets;

    if (cryptoUpDown && orderedMarkets.length > 0) {
      const slugKey = orderedMarkets
        .map((m) => m.marketSlug.toLowerCase())
        .sort()
        .join("|");
      if (slugKey !== lastCryptoTrackedSlugKey) {
        const tracked = new Set(
          orderedMarkets.map((m) => m.marketSlug.toLowerCase()),
        );
        pruneTradeHistoryToTrackedSlugs(tracked);
        if (lastCryptoTrackedSlugKey !== "") {
          lastStatus = "";
        }
        lastCryptoTrackedSlugKey = slugKey;
      }
    }

    orderedMarkets.forEach((mkt, idx) => {
      const marketPrices = prices.filter((p) => p.marketSlug === mkt.marketSlug);
      if (marketPrices.length === 0) return;

      const up = marketPrices.find((p) => p.sideAlias === "UP");
      const down = marketPrices.find((p) => p.sideAlias === "DOWN");

      const upHeader = `UP(${up?.outcomeLabel ?? "-"})`;
      const downHeader = `DOWN(${down?.outcomeLabel ?? "-"})`;
      const isActive = tradingEnabled && idx === activeMarketIndex;
      const cursor = tradingEnabled ? (isActive ? "> " : "  ") : "";
      const tag = tradingEnabled
        ? `[${idx < 26 ? String.fromCharCode(97 + idx) : "?"}] `
        : "";

      const maxLen = Math.max(upHeader.length, downHeader.length);
      console.log(
        `${cursor}${tag}${mkt.marketSlug} => Buy/Sell => ${upHeader.padEnd(maxLen)} => ${downHeader.padEnd(maxLen)}`,
      );
      console.log(
        `${cursor}${tag}${mkt.marketSlug} => ${"Buy".padEnd(8)} => ${formatCents(up?.bestAsk).padEnd(maxLen)} => ${formatCents(down?.bestAsk).padEnd(maxLen)}`,
      );
      console.log(
        `${cursor}${tag}${mkt.marketSlug} => ${"Sell".padEnd(8)} => ${formatCents(up?.bestBid).padEnd(maxLen)} => ${formatCents(down?.bestBid).padEnd(maxLen)}`,
      );

      // For btc-updown-*, append a synchronized live BTC + target reference line.
      if (cryptoUpDown) {
        const info = formatBtcUpDownInfoLine(mkt.marketSlug);
        if (info) {
          console.log(`${cursor}${tag}${info}`);
        }
      }
    });

    if (tradingEnabled) {
      const ageS =
        positionsLastFetchedAt > 0
          ? Math.round((Date.now() - positionsLastFetchedAt) / 1000)
          : null;
      const ageTag = ageS != null ? `polymarket ~${ageS}s ago` : "fetching…";

      type Row = { line: string };
      const rows: Row[] = [];
      orderedMarkets.forEach((mkt, idx) => {
        const upTok = mkt.tokens.find((t) => t.sideAlias === "UP");
        const downTok = mkt.tokens.find((t) => t.sideAlias === "DOWN");
        if (!upTok || !downTok) return;

        const bidY = getBestBidFor(upTok.assetId);
        const askY = getBestAskFor(upTok.assetId);
        const bidN = getBestBidFor(downTok.assetId);
        const askN = getBestAskFor(downTok.assetId);
        const markY =
          midMark(bidY, askY) ??
          lastTradeMark(snapshot.prices[upTok.assetId]?.lastTradePrice);
        const markN =
          midMark(bidN, askN) ??
          lastTradeMark(snapshot.prices[downTok.assetId]?.lastTradePrice);
        const upLabel =
          snapshot.prices[upTok.assetId]?.outcomeLabel ?? upTok.outcomeLabel;
        const downLabel =
          snapshot.prices[downTok.assetId]?.outcomeLabel ?? downTok.outcomeLabel;

        const target = buildTargetForMarket(mkt);
        const ledger = target ? marketLedgers.get(marketKey(target)) : undefined;
        const yesView = resolveSideView(upTok, ledger?.yes ?? emptyLeg());
        const noView = resolveSideView(downTok, ledger?.no ?? emptyLeg());
        if (!yesView && !noView) return;

        const letter = idx < 26 ? String.fromCharCode(97 + idx) : "?";
        const prefix = `[${letter}] ${mkt.marketSlug}:`;
        if (yesView) {
          rows.push({
            line: `${prefix} ${formatPositionLine("YES", upLabel, yesView, markY)}`,
          });
        }
        if (noView) {
          rows.push({
            line: `${prefix} ${formatPositionLine("NO", downLabel, noView, markN)}`,
          });
        }
      });

      if (rows.length > 0) {
        console.log(`\n--- Position (${ageTag}) ---`);
        for (const r of rows) console.log(r.line);
      }

      orderedMarkets.forEach((mkt) => {
        const tgt = buildTargetForMarket(mkt);
        if (!tgt) return;
        const entries = tradeJournal
          .filter((j) => historyMatchesRow(j, mkt.marketSlug))
          .sort((a, b) => a.atMs - b.atMs);

        const closedHere = closedTradeHistory.filter((c) =>
          historyMatchesRow(c, mkt.marketSlug),
        );

        if (entries.length === 0 && closedHere.length === 0) return;

        console.log(
          `\n--- Trade log (${mkt.marketSlug}) — BUY/SELL for this market row only (disk) ---`,
        );
        for (const line of formatTradeJournalLinesGrouped(entries)) {
          console.log(line);
        }

        if (closedHere.length > 0) {
          const chrono = [...closedHere].sort((a, b) => a.atMs - b.atMs);
          console.log(`\n  Full exits (closed round-trip PNL, this row only):`);
          for (const c of chrono) {
            console.log(formatClosedTradeHistoryLine(c, { omitSlug: true }));
          }
        }

        const upTok = mkt.tokens.find((t) => t.sideAlias === "UP");
        const downTok = mkt.tokens.find((t) => t.sideAlias === "DOWN");
        if (!upTok || !downTok) return;

        const jbY = getBestBidFor(upTok.assetId);
        const jaY = getBestAskFor(upTok.assetId);
        const jbN = getBestBidFor(downTok.assetId);
        const jaN = getBestAskFor(downTok.assetId);
        const jmY =
          midMark(jbY, jaY) ??
          lastTradeMark(snapshot.prices[upTok.assetId]?.lastTradePrice);
        const jmN =
          midMark(jbN, jaN) ??
          lastTradeMark(snapshot.prices[downTok.assetId]?.lastTradePrice);
        const juLabel =
          snapshot.prices[upTok.assetId]?.outcomeLabel ?? upTok.outcomeLabel;
        const jdLabel =
          snapshot.prices[downTok.assetId]?.outcomeLabel ?? downTok.outcomeLabel;

        const jLedger =
          marketLedgers.get(marketKey(tgt)) ?? {
            yes: emptyLeg(),
            no: emptyLeg(),
          };
        const openParts: string[] = [];
        if (jLedger.yes.shares > 1e-6 && jmY != null) {
          openParts.push(
            `YES (${juLabel}): ${jLedger.yes.shares.toFixed(2)} sh | ${formatPnlLine(unrealizedPnlUsd(jLedger.yes, jmY))} unrealized (mark)`,
          );
        }
        if (jLedger.no.shares > 1e-6 && jmN != null) {
          openParts.push(
            `NO (${jdLabel}): ${jLedger.no.shares.toFixed(2)} sh | ${formatPnlLine(unrealizedPnlUsd(jLedger.no, jmN))} unrealized (mark)`,
          );
        }
        if (openParts.length > 0) {
          console.log(`  Open (mark): ${openParts.join("  ·  ")}`);
        }
      });

      const active = orderedMarkets[activeMarketIndex];
      if (active) {
        const letter =
          activeMarketIndex < 26
            ? String.fromCharCode(97 + activeMarketIndex)
            : "?";
        console.log(
          `\nActive market => [${letter}] ${active.marketSlug} | tickSize=${active.tickSize} negRisk=${active.negRisk}`,
        );
      }
      console.log(
        `${HOTKEYS_HINT}  [r]refresh  [[/]]cycle market  [a-z]select market`,
      );
    } else {
      console.log(
        "\nTrading disabled. Set POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS in .env to enable hotkeys.",
      );
    }

    if (lastStatus) console.log(`> ${lastStatus}`);
  };

  const setStatus = (line: string): void => {
    if (cryptoUpDown && line) {
      const tracked = new Set(
        getOrderedMarkets().map((m) => m.marketSlug.toLowerCase()),
      );
      const slugsInLine = line.match(/[a-z0-9]+-updown-(?:5m|15m|1h)-\d+/gi) ?? [];
      if (
        slugsInLine.some((s) => !tracked.has(s.toLowerCase())) &&
        slugsInLine.length > 0
      ) {
        return;
      }
    }
    lastStatus = line;
    renderImmediate();
  };

  service.onPriceUpdate(() => {
    updateCount += 1;
    scheduleRender();
  });

  triggerRender = renderImmediate;
  triggerPositionsRefresh = () => {
    void refreshPositions();
  };

  if (btcPriceService) {
    btcPriceService.onPriceUpdate(() => scheduleRender());
    btcPriceService.start();
    // 1Hz heartbeat so the "closes in M:SS" countdown stays smooth even when
    // no Polymarket / Coinbase WS update arrives in that second.
    setInterval(() => scheduleRender(), 1000).unref();
  }

  await service.start();
  console.log("Polymarket real-time up/down price stream started.");

  if (tradingEnabled && tradeService) {
    setupHotkeys(tradeService, setStatus);
    void refreshPositions();
    setInterval(() => {
      void refreshPositions();
    }, POSITIONS_REFRESH_MS).unref();
  } else if (tradeConfig.shares > 0 && !isTradingEnabled()) {
    console.warn(
      "SHARES is set but trading is disabled (need POLYMARKET_PRIVATE_KEY + POLYMARKET_FUNDER_ADDRESS).",
    );
  }

  renderTable();
}

/** Tracked markets, in display order (matches the price table rows). */
function getOrderedMarkets(): TrackedMarket[] {
  return service.getSnapshot().markets;
}

function clampActiveIndex(): void {
  const n = getOrderedMarkets().length;
  if (n === 0) {
    activeMarketIndex = 0;
    return;
  }
  if (activeMarketIndex < 0) activeMarketIndex = 0;
  if (activeMarketIndex >= n) activeMarketIndex = n - 1;
}

function buildTargetForMarket(
  market: TrackedMarket | undefined,
): ActiveTradingTarget | null {
  if (!market) return null;
  const upToken = market.tokens.find((t) => t.sideAlias === "UP");
  const downToken = market.tokens.find((t) => t.sideAlias === "DOWN");
  if (!upToken || !downToken) return null;
  return { market, upToken, downToken };
}

function getActiveTradingTarget(): ActiveTradingTarget | null {
  clampActiveIndex();
  return buildTargetForMarket(getOrderedMarkets()[activeMarketIndex]);
}

function getBestAskFor(assetId: string): number | null {
  const snapshot = service.getSnapshot();
  const state = snapshot.prices[assetId];
  const ask = Number(state?.bestAsk);
  return Number.isFinite(ask) && ask > 0 ? ask : null;
}

function getBestBidFor(assetId: string): number | null {
  const snapshot = service.getSnapshot();
  const state = snapshot.prices[assetId];
  const bid = Number(state?.bestBid);
  return Number.isFinite(bid) && bid > 0 ? bid : null;
}

function lastTradeMark(raw?: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

type SideView = {
  shares: number;
  avg: number;
  source: "polymarket" | "session";
};

/**
 * Polymarket `/positions` sometimes returns `size` before `avgPrice` is filled
 * (avg stays 0 for a short window after a fill). Prefer a real API avg; else
 * session ledger; else cost basis from `initialValue` / size.
 */
function readPositionsApiAvgPrice(pos: PolyUserPosition): number {
  const r = pos as unknown as Record<string, unknown>;
  const v = r.avgPrice ?? r.avg_price;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function effectiveDisplayAvg(pos: PolyUserPosition, ledger: SideLeg): number {
  const apiAvg = readPositionsApiAvgPrice(pos);
  if (apiAvg > 1e-9) return apiAvg;
  const fromLedger = avgEntry(ledger);
  if (fromLedger > 1e-9 && ledger.shares > 1e-9) return fromLedger;
  const sz = Number(pos.size);
  const init = Number(pos.initialValue);
  if (
    Number.isFinite(sz) &&
    sz > 1e-9 &&
    Number.isFinite(init) &&
    init > 1e-9
  ) {
    const implied = init / sz;
    if (Number.isFinite(implied) && implied > 1e-9) return implied;
  }
  return Number.isFinite(apiAvg) ? apiAvg : 0;
}

/**
 * Effective $/share cost basis for a SELL sized `sharesSelling` shares.
 * Prefers fully-tracked session ledger when it covers the exit; otherwise uses Polymarket
 * `/positions` avg (captures stacked buys whether or not hotkey buys were recorded).
 */
function blendedBuyAvgForSell(
  token: TrackedMarket["tokens"][number],
  leg: SideLeg,
  sharesSelling: number,
): number {
  if (sharesSelling <= 1e-9) return 0;
  const ledgerAvg = avgEntry(leg);
  const ledgerSz = leg.shares;
  if (
    ledgerSz + 1e-6 >= sharesSelling &&
    ledgerAvg > 1e-12
  ) {
    return ledgerAvg;
  }

  const cached = positionsByAssetId.get(token.assetId);
  const pos = cached?.position;
  if (!pos) {
    return ledgerAvg > 1e-12 ? ledgerAvg : 0;
  }
  const apiSz = Number(pos.size);
  const apiAvg = readPositionsApiAvgPrice(pos);
  const IMPLIED_EPS = 1e-9;
  if (
    Number.isFinite(apiSz) &&
    apiSz + IMPLIED_EPS >= sharesSelling &&
    Number.isFinite(apiAvg) &&
    apiAvg > 1e-12
  ) {
    return apiAvg;
  }
  const init = Number(pos.initialValue);
  if (
    Number.isFinite(apiSz) &&
    apiSz + IMPLIED_EPS >= sharesSelling &&
    Number.isFinite(init) &&
    init > IMPLIED_EPS &&
    apiSz > IMPLIED_EPS
  ) {
    const impliedAvg = init / apiSz;
    if (Number.isFinite(impliedAvg) && impliedAvg > 1e-12) {
      return impliedAvg;
    }
  }
  return ledgerAvg > 1e-12 ? ledgerAvg : 0;
}

function resolveSideView(
  token: TrackedMarket["tokens"][number],
  ledger: SideLeg,
): SideView | null {
  const cached = positionsByAssetId.get(token.assetId);
  if (cached && cached.position.size > 0.0001) {
    return {
      shares: cached.position.size,
      avg: effectiveDisplayAvg(cached.position, ledger),
      source: "polymarket",
    };
  }
  if (ledger.shares > 0) {
    return {
      shares: ledger.shares,
      avg: avgEntry(ledger),
      source: "session",
    };
  }
  return null;
}

function formatPositionLine(
  sideTag: "YES" | "NO",
  outcomeLabel: string,
  view: SideView,
  mark: number | null,
): string {
  const sh = view.shares.toFixed(2);
  const avg = view.avg.toFixed(3);
  const tag = view.source === "session" ? " [pending]" : "";
  if (mark == null) {
    return `${sideTag} (${outcomeLabel}): ${sh} sh @ avg ${avg} | mark — | PNL: —${tag}`;
  }
  const pnl = (mark - view.avg) * view.shares;
  return `${sideTag} (${outcomeLabel}): ${sh} sh @ avg ${avg} | mark ${mark.toFixed(3)} | ${formatPnlLine(pnl)}${tag}`;
}

const ANSI_GREEN = "\x1b[32m";
const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Parse `btc-updown-5m-<unix>` (or any `<sym>-updown-<dur>-<unix>`) and return
 * `{ windowStartUnix, windowSeconds }`. Returns null for non-matching slugs.
 */
function parseUpDownSlug(
  slug: string,
): { windowStartUnix: number; windowSeconds: number } | null {
  const m = slug.match(/^[a-z0-9]+-updown-(5m|15m|1h)-(\d+)$/);
  if (!m) return null;
  const dur = m[1] as keyof typeof UP_DOWN_WINDOW_SECONDS;
  const ts = Number(m[2]);
  if (!Number.isFinite(ts)) return null;
  return { windowStartUnix: ts, windowSeconds: UP_DOWN_WINDOW_SECONDS[dur] };
}

/**
 * Lazily ensure we have a target (= window-start) BTC price for `unix`.
 * If the candle isn't available yet (window in the future) we record the miss
 * timestamp and retry after `TARGET_RETRY_AFTER_MS` so we don't hammer Coinbase.
 */
function ensureBtcTargetPrice(unix: number): void {
  if (btcTargetPriceByWindow.has(unix)) return;
  if (btcTargetFetchInFlight.has(unix)) return;
  const lastMiss = btcTargetMissAt.get(unix);
  if (lastMiss && Date.now() - lastMiss < TARGET_RETRY_AFTER_MS) return;

  btcTargetFetchInFlight.add(unix);
  void fetchBtcPriceAtUnix(unix)
    .then((price) => {
      if (price != null) {
        btcTargetPriceByWindow.set(unix, price);
        btcTargetMissAt.delete(unix);
        triggerRender();
      } else {
        btcTargetMissAt.set(unix, Date.now());
      }
    })
    .catch(() => {
      btcTargetMissAt.set(unix, Date.now());
    })
    .finally(() => {
      btcTargetFetchInFlight.delete(unix);
    });
}

function formatHmsClock(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m} UTC`;
}

function formatMmSs(seconds: number): string {
  if (seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Build the "BTC: $X | target $Y | Δ ... | closes in M:SS" line shown under
 * each btc-updown-*m market. Returns null if the slug isn't a btc-updown
 * market or there's nothing useful to show yet.
 */
function formatBtcUpDownInfoLine(slug: string): string | null {
  const parsed = parseUpDownSlug(slug);
  if (!parsed) return null;
  const { windowStartUnix, windowSeconds } = parsed;
  const windowEndUnix = windowStartUnix + windowSeconds;
  const nowSec = Math.floor(Date.now() / 1000);

  const live = btcPriceService?.getLatest() ?? null;
  // Trigger the lazy fetch every render — no-op if cached or already in flight.
  if (nowSec >= windowStartUnix) ensureBtcTargetPrice(windowStartUnix);

  // Fast-path: when a window has just rotated (≤30s old) and Coinbase hasn't
  // indexed its 1-minute candle yet, snapshot the current live BTC price as
  // an immediate target. The REST result still overwrites this with the
  // canonical candle open when it becomes available.
  if (
    nowSec >= windowStartUnix &&
    nowSec - windowStartUnix <= 30 &&
    !btcTargetPriceByWindow.has(windowStartUnix) &&
    !btcTargetSnapshotByWindow.has(windowStartUnix) &&
    live != null
  ) {
    btcTargetSnapshotByWindow.set(windowStartUnix, live.price);
  }

  const target =
    btcTargetPriceByWindow.get(windowStartUnix) ??
    btcTargetSnapshotByWindow.get(windowStartUnix);
  const targetIsApprox =
    !btcTargetPriceByWindow.has(windowStartUnix) &&
    btcTargetSnapshotByWindow.has(windowStartUnix);

  const livePart = live
    ? `BTC ${usdFormatter.format(live.price)} (Coinbase)`
    : `BTC fetching…`;

  const targetPart =
    target != null
      ? `target ${usdFormatter.format(target)}${targetIsApprox ? " ~live" : ""} @ ${formatHmsClock(windowStartUnix)}`
      : nowSec < windowStartUnix
        ? `target pending (window starts in ${formatMmSs(windowStartUnix - nowSec)})`
        : `target fetching…`;

  let deltaPart = "";
  if (live && target != null) {
    const delta = live.price - target;
    const pct = (delta / target) * 100;
    const sign = delta >= 0 ? "+" : "−";
    const dir = delta > 0 ? "UP wins" : delta < 0 ? "DOWN wins" : "flat";
    const text = `Δ ${sign}${usdFormatter.format(Math.abs(delta))} (${sign}${Math.abs(pct).toFixed(3)}%) → ${dir}`;
    const useColor = process.stdout.isTTY && delta !== 0;
    const color = delta > 0 ? ANSI_GREEN : delta < 0 ? ANSI_RED : "";
    deltaPart = useColor ? `${color}${text}${ANSI_RESET}` : text;
  }

  let countdownPart = "";
  if (nowSec < windowEndUnix) {
    countdownPart = `closes in ${formatMmSs(windowEndUnix - nowSec)}`;
  } else {
    countdownPart = "resolving…";
  }

  const parts = [livePart, targetPart];
  if (deltaPart) parts.push(deltaPart);
  parts.push(countdownPart);
  return parts.join(" | ");
}

function setupHotkeys(
  trade: PolymarketTradeService,
  setStatus: (line: string) => void,
): void {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    console.warn(
      "stdin is not a TTY; hotkeys disabled. Run from an interactive terminal (not piped).",
    );
    return;
  }

  let busy = false;
  const guard = async (label: string, fn: () => Promise<string | void>) => {
    if (busy) {
      setStatus(`busy — ignored ${label}`);
      return;
    }
    busy = true;
    setStatus(`${label} in progress…`);
    try {
      const detail = await fn();
      setStatus(detail ? `${label} done — ${detail}` : `${label} done`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof TradeValidationError) {
        // Loud banner — no stack trace needed, this is a user input issue.
        console.error("\n!!! ORDER REJECTED LOCALLY !!!");
        console.error(`!!! ${msg}`);
        console.error("!!! Nothing was sent to Polymarket.\n");
        setStatus(`${label} BLOCKED: ${msg}`);
      } else {
        setStatus(`${label} failed: ${msg}`);
        const polyWalletConfigReject =
          /maker address not allowed|deposit wallet flow/i.test(msg);
        if (polyWalletConfigReject) {
          console.error(
            `[hotkey] ${label} failed: ${msg}\n` +
              "Polymarket rejected the maker/funder combo. Set POLYMARKET_FUNDER_ADDRESS to the address that holds your balance in the Polymarket UI (often a proxy or deposit wallet, not your raw EOA). Set POLYMARKET_SIGNATURE_TYPE to match (0=EOA, 1=PROXY, 2=SAFE, 3=1271). Many new accounts cannot use 0+funder=EOA; complete deposit-wallet onboarding on polymarket.com if prompted. Restart after .env changes. See README trading env table.\n",
          );
        } else {
          console.error(`[hotkey] ${label} failed:`, err);
        }
      }
    } finally {
      busy = false;
    }
  };

  const onKey = (chunk: Buffer): void => {
    const key = chunk.toString("utf8");
    if (!key) return;

    // Ctrl+C / Ctrl+D / q exit
    if (key === "\u0003" || key === "\u0004" || key.toLowerCase() === "q") {
      console.log("\nexiting…");
      shutdown(0);
      return;
    }

    if (
      key === "1" ||
      key === "2" ||
      key === "4" ||
      key === "5" ||
      key === "7" ||
      key === "8" ||
      key === "0"
    ) {
      handleHotkey(key, trade, guard, setStatus);
      return;
    }

    if (key === "[" || key === "]") {
      const markets = getOrderedMarkets();
      if (markets.length === 0) {
        setStatus("no tracked market yet");
        return;
      }
      const dir = key === "]" ? 1 : -1;
      activeMarketIndex =
        (activeMarketIndex + dir + markets.length) % markets.length;
      const m = markets[activeMarketIndex];
      const letter = String.fromCharCode(97 + activeMarketIndex);
      setStatus(`active market => [${letter}] ${m.marketSlug}`);
      return;
    }

    // Direct selection: a/b/c/… picks the corresponding market row.
    if (/^[a-z]$/.test(key) && key !== "q" && key !== "r") {
      const markets = getOrderedMarkets();
      const idx = key.charCodeAt(0) - 97;
      if (idx >= 0 && idx < markets.length) {
        activeMarketIndex = idx;
        const m = markets[activeMarketIndex];
        setStatus(`active market => [${key}] ${m.marketSlug}`);
      }
      return;
    }

    if (key === "r" || key === "R") {
      setStatus("refreshing positions…");
      void refreshPositions().then(() => setStatus("positions refreshed"));
      return;
    }
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onKey);
}

function handleHotkey(
  key: string,
  trade: PolymarketTradeService,
  guard: (label: string, fn: () => Promise<string | void>) => Promise<void>,
  setStatus: (line: string) => void,
): void {
  if (key === "0") {
    void guard("CANCEL ALL", async () => {
      await trade.cancelAll();
    });
    return;
  }

  const target = getActiveTradingTarget();
  if (!target) {
    setStatus("no tracked market yet — wait for prices");
    return;
  }
  const { market } = target;

  if (key === "1" || key === "2") {
    placeFixedShareBuy(key === "1", target, trade, guard, setStatus);
    return;
  }

  if (key === "4" || key === "5") {
    placeFixedUsdBuy(key === "4", target, trade, guard, setStatus);
    return;
  }

  if (key === "7" || key === "8") {
    const isYes = key === "7";
    const token = isYes ? target.upToken : target.downToken;
    const bid = getBestBidFor(token.assetId) ?? undefined;
    const label = `SELL ALL ${market.marketSlug} ${token.outcomeLabel}`;
    void guard(label, async () => {
      const ledger = getOrCreateLedger(target);
      const sold = await trade.sellAll({
        marketSlug: market.marketSlug,
        tickSize: market.tickSize,
        negRisk: market.negRisk,
        tokenId: token.assetId,
        outcomeLabel: token.outcomeLabel,
        priceHint: bid,
      });
      if (sold.sharesSold > 0) {
        const leg = isYes ? ledger.yes : ledger.no;
        // Snapshot entry price BEFORE we drop API cache (markAssetRecentlySold
        // deletes positionsByAssetId — that used to wipe buy avg for PNL).
        const avgBuyBefore = blendedBuyAvgForSell(
          token,
          leg,
          sold.sharesSold,
        );
        const sellPxForPnl =
          sold.avgFillPrice ??
          (sold.priceHint != null && Number.isFinite(sold.priceHint)
            ? sold.priceHint
            : null);
        const realizedPnl =
          sellPxForPnl != null && avgBuyBefore > 1e-12
            ? (sellPxForPnl - avgBuyBefore) * sold.sharesSold
            : null;

        markAssetRecentlySold(token.assetId);

        pushClosedTrade({
          atMs: Date.now(),
          marketKey: marketKey(target),
          marketSlug: market.marketSlug,
          side: isYes ? "YES" : "NO",
          outcomeLabel: token.outcomeLabel,
          shares: sold.sharesSold,
          avgBuy: avgBuyBefore,
          sellFill: sold.avgFillPrice ?? null,
          sellHint:
            sold.priceHint != null && Number.isFinite(sold.priceHint)
              ? sold.priceHint
              : null,
          realizedPnlUsd: realizedPnl,
        });

        const mk = marketKey(target);
        const sideTag = isYes ? "YES" : "NO";
        const priorCum = cumulativeRealizedForMarketSide(
          market.marketSlug,
          sideTag,
        );
        const sellDisplayPx =
          sellPxForPnl ??
          (sold.priceHint != null && Number.isFinite(sold.priceHint)
            ? sold.priceHint
            : 0);
        const priceKind: "fill" | "hint" =
          sold.avgFillPrice != null && sold.avgFillPrice > 1e-12
            ? "fill"
            : "hint";
        const cumAfter = priorCum + (realizedPnl ?? 0);
        pushTradeJournal({
          atMs: Date.now(),
          marketKey: mk,
          marketSlug: market.marketSlug,
          kind: "SELL",
          side: sideTag,
          outcomeLabel: token.outcomeLabel,
          shares: sold.sharesSold,
          price: sellDisplayPx > 1e-12 ? sellDisplayPx : 0,
          priceKind,
          realizedPnlUsd: realizedPnl,
          cumulativeRealizedAfter: cumAfter,
        });

        reduceOnSell(leg, sold.sharesSold);
        triggerRender();
        triggerPositionsRefresh();
        scheduleBurstPositionRefreshes();
        const cents = (p: number) => `${(p * 100).toFixed(1)}c`;
        let pricePart = "";
        if (sold.avgFillPrice != null && sold.priceHint != null) {
          pricePart = ` @ ~${cents(sold.avgFillPrice)} fill (bid hint ${cents(sold.priceHint)})`;
        } else if (sold.avgFillPrice != null) {
          pricePart = ` @ ~${cents(sold.avgFillPrice)} fill`;
        } else if (sold.priceHint != null) {
          pricePart = ` (bid hint ${cents(sold.priceHint)} — CLOB response did not include fill amounts)`;
        }
        const entryPart =
          avgBuyBefore > 1e-12 ? ` | buy avg ${cents(avgBuyBefore)}` : " | buy avg —";
        const pnlPart =
          realizedPnl != null ? ` | ${formatPnlLine(realizedPnl)}` : " | PNL: —";
        return `sold ${sold.sharesSold} sh${pricePart}${entryPart}${pnlPart}; ledger YES=${ledger.yes.shares.toFixed(2)} NO=${ledger.no.shares.toFixed(2)}`;
      }
      triggerPositionsRefresh();
      const leg = isYes ? ledger.yes : ledger.no;
      if (leg.shares > 1e-6) {
        clearStaleSessionLeg(target, token, isYes, bid ?? null);
        triggerRender();
        return "0 balance on Polymarket — cleared session ledger (sold elsewhere?)";
      }
      return "nothing sold (0 balance)";
    });
  }
}

type MinNotionalBumpInfo = {
  baseShares: number;
  effectiveShares: number;
  minUsd: number;
};

/** Hotkeys "1" / "2": BUY {YES,NO} at best ask, size = SHARES env. */
function placeFixedShareBuy(
  isYes: boolean,
  target: ActiveTradingTarget,
  trade: PolymarketTradeService,
  guard: (label: string, fn: () => Promise<string | void>) => Promise<void>,
  setStatus: (line: string) => void,
): void {
  const baseShares = tradeConfig.shares;
  if (!baseShares || baseShares <= 0) {
    setStatus("SHARES env var must be > 0 to BUY (1/2)");
    return;
  }
  const token = isYes ? target.upToken : target.downToken;
  const ask = getBestAskFor(token.assetId);
  if (!ask) {
    setStatus(
      `no ask price for ${token.outcomeLabel} yet — try again in a moment`,
    );
    return;
  }
  // Polymarket rejects orders below MIN_ORDER_USD notional. For hotkeys 1/2
  // we auto-bump share count up (never down) so low-priced tokens still work.
  const minUsd = tradeConfig.minOrderUsd;
  let effectiveShares = baseShares;
  let bumpInfo: MinNotionalBumpInfo | undefined;
  if (minUsd > 0) {
    const minSharesForNotional = Math.ceil((minUsd - 1e-9) / ask);
    effectiveShares = Math.max(baseShares, minSharesForNotional);
    if (effectiveShares > baseShares) {
      bumpInfo = { baseShares, effectiveShares, minUsd };
    }
  }
  submitBuy(target, isYes, ask, effectiveShares, "fixed-shares", trade, guard, bumpInfo);
}

/**
 * Hotkeys "4" / "5": BUY {YES,NO} for ~$BUY_USD notional at the current best
 * ask. Shares are computed at trade time so a price move between the last
 * render and the keypress is reflected. We floor() to whole shares (Polymarket
 * orders integer share counts) and refuse if it would round down to zero.
 */
function placeFixedUsdBuy(
  isYes: boolean,
  target: ActiveTradingTarget,
  trade: PolymarketTradeService,
  guard: (label: string, fn: () => Promise<string | void>) => Promise<void>,
  setStatus: (line: string) => void,
): void {
  const usd = tradeConfig.buyUsd;
  if (!usd || usd <= 0) {
    setStatus("BUY_USD env var must be > 0 to BUY (4/5)");
    return;
  }
  const token = isYes ? target.upToken : target.downToken;
  const ask = getBestAskFor(token.assetId);
  if (!ask) {
    setStatus(
      `no ask price for ${token.outcomeLabel} yet — try again in a moment`,
    );
    return;
  }
  // Derive integer share count. floor() so we never exceed the budget; if
  // ask is so high that floor(usd/ask) === 0 we refuse with a clear message.
  const shares = Math.floor(usd / ask);
  if (shares <= 0) {
    setStatus(
      `$${usd.toFixed(2)} too small at ask ${ask.toFixed(3)} (need ≥ 1 share). Raise BUY_USD or wait for a lower ask.`,
    );
    return;
  }
  submitBuy(target, isYes, ask, shares, "fixed-usd", trade, guard);
}

/** Common limit-buy submission + ledger update + status formatting. */
function submitBuy(
  target: ActiveTradingTarget,
  isYes: boolean,
  ask: number,
  shares: number,
  mode: "fixed-shares" | "fixed-usd",
  trade: PolymarketTradeService,
  guard: (label: string, fn: () => Promise<string | void>) => Promise<void>,
  minNotionalBump?: MinNotionalBumpInfo,
): void {
  const { market } = target;
  const token = isYes ? target.upToken : target.downToken;
  const notional = ask * shares;
  const tag = mode === "fixed-usd" ? `~$${notional.toFixed(2)}` : "";
  const bumpSuffix = minNotionalBump
    ? ` [min $${minNotionalBump.minUsd.toFixed(2)}: ${minNotionalBump.baseShares}→${minNotionalBump.effectiveShares} sh]`
    : "";
  const label =
    `BUY ${market.marketSlug} ${token.outcomeLabel} ${shares}@${ask.toFixed(3)}` +
    (tag ? ` (${tag})` : "") +
    bumpSuffix;
  void guard(label, async () => {
    const ledger = getOrCreateLedger(target);
    const result = await trade.limitBuy({
      marketSlug: market.marketSlug,
      tickSize: market.tickSize,
      negRisk: market.negRisk,
      tokenId: token.assetId,
      outcomeLabel: token.outcomeLabel,
      price: ask,
      size: shares,
    });
    if (!result.ok) {
      throw new Error(result.errorMsg || "BUY rejected");
    }
    clearSellSuppression(token.assetId);
    const leg = isYes ? ledger.yes : ledger.no;
    if (result.ledgerShares > 0) {
      addPurchase(leg, result.ledgerShares, result.ledgerPrice);
      const mk = marketKey(target);
      pushTradeJournal({
        atMs: Date.now(),
        marketKey: mk,
        marketSlug: market.marketSlug,
        kind: "BUY",
        side: isYes ? "YES" : "NO",
        outcomeLabel: token.outcomeLabel,
        shares: result.ledgerShares,
        price: result.ledgerPrice,
        priceKind: "limit",
        notionalUsd: result.ledgerShares * result.ledgerPrice,
        realizedPnlUsd: null,
      });
    }
    triggerPositionsRefresh();
    scheduleBurstPositionRefreshes();
    triggerRender();
    const bumpPrefix = minNotionalBump
      ? `min-order bump ${minNotionalBump.baseShares}→${minNotionalBump.effectiveShares} sh ($${minNotionalBump.minUsd.toFixed(2)} floor) — `
      : "";
    if (result.ledgerShares > 0) {
      const note = result.status
        ? `${bumpPrefix}${result.status.toLowerCase()} — ledger +${result.ledgerShares} sh @ ${result.ledgerPrice.toFixed(3)} (avg ${avgEntry(leg).toFixed(3)})`
        : `${bumpPrefix}ledger +${result.ledgerShares} sh @ ${result.ledgerPrice.toFixed(3)} (avg ${avgEntry(leg).toFixed(3)})`;
      return note;
    }
    return `${bumpPrefix}resting on book (${result.status ?? "open"}) — press 0 to cancel; PNL updates only when filled`;
  });
}

function shutdown(code: number): void {
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  } catch {
    // ignore
  }
  tradeHistoryWriter.flushSync();
  service.stop();
  btcPriceService?.stop();
  process.exit(code);
}

main().catch((err) => {
  console.error("Failed to start realtime stream:", err);
  process.exit(1);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
