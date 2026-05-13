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
  return `${market.conditionId || market.marketSlug}:${upToken.assetId}:${downToken.assetId}`;
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

/** Index of the market that hotkeys 1/2/7/8 act on. Cycle with [ / ]. */
let activeMarketIndex = 0;

/** Polymarket Data API positions cache, keyed by CTF asset id. */
type PositionState = { position: PolyUserPosition; fetchedAt: number };
const positionsByAssetId = new Map<string, PositionState>();
let positionsLastFetchedAt = 0;
let positionsInFlight = false;
const POSITIONS_REFRESH_MS = 7000;

/**
 * Asset ids whose data-api position should be ignored after a successful sell,
 * until the API catches up to on-chain truth (eventually consistent, ~5-30s).
 * Map value = epoch ms after which we resume trusting the API for this asset.
 */
const recentlySoldAssets = new Map<string, number>();
const SOLD_IGNORE_MS = 45_000;

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

async function refreshPositions(): Promise<void> {
  if (!tradeConfig.funderAddress) return;
  if (positionsInFlight) return;
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
    if (changed) triggerRender();
  } catch (err) {
    // Network blips: keep the previous cache so the UI doesn't blank out.
    console.error(
      `[positions] refresh failed: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    positionsInFlight = false;
  }
}

const HOTKEYS_HINT =
  "[1]BUY YES  [2]BUY NO  [7]SELL ALL YES  [8]SELL ALL NO  [0]CANCEL ALL  [q]quit";

async function main(): Promise<void> {
  if (!discoverSoccerMatches && !cryptoUpDown && marketSlugs.length === 0) {
    console.error(
      'Missing input. Use "--market-slug <slug>" or positional slug(s). Event slugs (e.g. ucl-...) expand to all match markets. Or pass --soccer-matches / --btc-5m.',
    );
    process.exit(1);
  }

  let renderScheduled = false;
  let updateCount = 0;
  let lastStatus = "";

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
      ? `trading=ON shares=${tradeConfig.shares}`
      : "trading=OFF";
    const modeTag = cryptoUpDown
      ? ` | mode=${cryptoUpDown.symbol.toUpperCase()}-${cryptoUpDown.duration}`
      : "";
    console.log(
      `Polymarket live prices | ${snapshot.marketCount} market(s), ${snapshot.tokenCount} token(s) | updates=${updateCount} | ${tradingTag}${modeTag} | at=${new Date().toLocaleTimeString("en-US", { hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
    );

    clampActiveIndex();
    const orderedMarkets = snapshot.markets;
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
    lastStatus = line;
    scheduleRender();
  };

  const scheduleRender = (): void => {
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      renderTable();
    }, 100);
  };

  service.onPriceUpdate(() => {
    updateCount += 1;
    scheduleRender();
  });

  triggerRender = scheduleRender;
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

function resolveSideView(
  token: TrackedMarket["tokens"][number],
  ledger: SideLeg,
): SideView | null {
  const cached = positionsByAssetId.get(token.assetId);
  if (cached && cached.position.size > 0.0001) {
    return {
      shares: cached.position.size,
      avg: cached.position.avgPrice,
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
        console.error(`[hotkey] ${label} failed:`, err);
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

    if (key === "1" || key === "2" || key === "7" || key === "8" || key === "0") {
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
      triggerRender();
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
        triggerRender();
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
    const shares = tradeConfig.shares;
    if (!shares || shares <= 0) {
      setStatus("SHARES env var must be > 0 to BUY");
      return;
    }
    const isYes = key === "1";
    const token = isYes ? target.upToken : target.downToken;
    const ask = getBestAskFor(token.assetId);
    if (!ask) {
      setStatus(
        `no ask price for ${token.outcomeLabel} yet — try again in a moment`,
      );
      return;
    }
    const label = `BUY ${market.marketSlug} ${token.outcomeLabel} ${shares}@${ask.toFixed(3)}`;
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
      triggerPositionsRefresh();
      if (result.ledgerShares > 0) {
        addPurchase(leg, result.ledgerShares, result.ledgerPrice);
        const note = result.status
          ? `${result.status.toLowerCase()} — ledger +${result.ledgerShares} sh @ ${result.ledgerPrice.toFixed(3)} (avg ${avgEntry(leg).toFixed(3)})`
          : `ledger +${result.ledgerShares} sh @ ${result.ledgerPrice.toFixed(3)} (avg ${avgEntry(leg).toFixed(3)})`;
        return note;
      }
      return `resting on book (${result.status ?? "open"}) — press 0 to cancel; PNL updates only when filled`;
    });
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
      if (sold > 0) {
        markAssetRecentlySold(token.assetId);
        const leg = isYes ? ledger.yes : ledger.no;
        reduceOnSell(leg, sold);
        triggerRender();
        triggerPositionsRefresh();
        return `sold ${sold} sh; ledger YES=${ledger.yes.shares.toFixed(2)} NO=${ledger.no.shares.toFixed(2)}`;
      }
      triggerPositionsRefresh();
      return "nothing sold (0 balance)";
    });
  }
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
