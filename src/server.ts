import { isTradingEnabled, tradeConfig } from "./config";
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
};

function parseServerCli(): ServerCli {
  const args = process.argv.slice(2);
  const slugs: string[] = [];
  let discoverSoccerMatches = false;

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

  return {
    marketSlugs: Array.from(new Set(slugs.map((slug) => slug.toLowerCase()))),
    discoverSoccerMatches,
  };
}

const { marketSlugs, discoverSoccerMatches } = parseServerCli();

const service = new PolymarketRealtimeService({
  marketSlugs,
  discoverSoccerMatches,
});

const tradingEnabled = isTradingEnabled();
const tradeService = tradingEnabled ? new PolymarketTradeService() : null;

/** Session ledger for hotkey buys on the active market (weighted avg entry). */
const ledgerState: {
  marketKey: string;
  yes: SideLeg;
  no: SideLeg;
} = {
  marketKey: "",
  yes: emptyLeg(),
  no: emptyLeg(),
};

function ledgerMarketKey(t: ActiveTradingTarget): string {
  const { market, upToken, downToken } = t;
  return `${market.conditionId || market.marketSlug}:${upToken.assetId}:${downToken.assetId}`;
}

function resetLedgerIfMarketChanged(t: ActiveTradingTarget): void {
  const k = ledgerMarketKey(t);
  if (!k) return;
  if (ledgerState.marketKey !== k) {
    ledgerState.marketKey = k;
    ledgerState.yes = emptyLeg();
    ledgerState.no = emptyLeg();
  }
}

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
  const target = getActiveTradingTarget();
  if (!target) return;

  positionsInFlight = true;
  try {
    const conditionId = target.market.conditionId;
    const list = await fetchUserPositions(tradeConfig.funderAddress, {
      conditionId: conditionId || undefined,
      // Without a conditionId we'd fetch the whole portfolio; restrict to
      // the active market's two tokens by post-filtering.
      sizeThreshold: 0.0001,
      limit: 200,
    });

    const targetAssetIds = new Set([
      target.upToken.assetId,
      target.downToken.assetId,
    ]);

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
  if (!discoverSoccerMatches && marketSlugs.length === 0) {
    console.error(
      'Missing input. Use "--market-slug <slug>" or positional slug(s). Event slugs (e.g. ucl-...) expand to all match markets. Or pass --soccer-matches to discover active soccer fixtures.',
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
    console.log(
      `Polymarket live prices | ${snapshot.marketCount} market(s), ${snapshot.tokenCount} token(s) | updates=${updateCount} | ${tradingTag} | at=${new Date().toLocaleTimeString("en-US", { hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
    );

    const slugsOrdered = [
      ...new Set(snapshot.markets.map((m) => m.marketSlug)),
    ];
    for (const marketSlug of slugsOrdered) {
      const marketPrices = prices.filter((p) => p.marketSlug === marketSlug);
      if (marketPrices.length === 0) continue;

      const up = marketPrices.find((p) => p.sideAlias === "UP");
      const down = marketPrices.find((p) => p.sideAlias === "DOWN");

      const upHeader = `UP(${up?.outcomeLabel ?? "-"})`;
      const downHeader = `DOWN(${down?.outcomeLabel ?? "-"})`;
      const rows = [
        {
          Market: marketSlug,
          "Buy/Sell": "Buy",
          [upHeader]: formatCents(up?.bestAsk),
          [downHeader]: formatCents(down?.bestAsk),
        },
        {
          Market: marketSlug,
          "Buy/Sell": "Sell",
          [upHeader]: formatCents(up?.bestBid),
          [downHeader]: formatCents(down?.bestBid),
        },
      ];
      const maxLength = Math.max(upHeader.length, downHeader.length);
      console.log(`${marketSlug} => Buy/Sell => ${upHeader.padEnd(maxLength)} => ${downHeader.padEnd(maxLength)}`);
      console.log(`${rows[0].Market} => ${rows[0]["Buy/Sell"].padEnd(8)} => ${rows[0][upHeader].padEnd(maxLength)} => ${rows[0][downHeader].padEnd(maxLength)}`);
      console.log(`${rows[1].Market} => ${rows[1]["Buy/Sell"].padEnd(8)} => ${rows[1][upHeader].padEnd(maxLength)} => ${rows[1][downHeader].padEnd(maxLength)}`);
    }

    if (tradingEnabled) {
      const targetMkt = snapshot.markets[0];
      const upTok = targetMkt?.tokens.find((t) => t.sideAlias === "UP");
      const downTok = targetMkt?.tokens.find((t) => t.sideAlias === "DOWN");
      if (upTok && downTok) {
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

        const yesView = resolveSideView(upTok, ledgerState.yes);
        const noView = resolveSideView(downTok, ledgerState.no);

        if (yesView || noView) {
          const ageS =
            positionsLastFetchedAt > 0
              ? Math.round((Date.now() - positionsLastFetchedAt) / 1000)
              : null;
          const ageTag = ageS != null ? `polymarket ~${ageS}s ago` : "fetching…";
          console.log(`\n--- Position (YES = UP / NO = DOWN, ${ageTag}) ---`);

          if (yesView) {
            console.log(formatPositionLine("YES", upLabel, yesView, markY));
          }
          if (noView) {
            console.log(formatPositionLine("NO", downLabel, noView, markN));
          }
        }
      }

      const target = snapshot.markets[0];
      if (target) {
        console.log(
          `\nTrading market => ${target.marketSlug} | tickSize=${target.tickSize} negRisk=${target.negRisk}`,
        );
      }
      console.log(`${HOTKEYS_HINT}  [r]refresh positions`);
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

function getActiveTradingTarget(): ActiveTradingTarget | null {
  const snapshot = service.getSnapshot();
  const market = snapshot.markets[0];
  if (!market) return null;
  const upToken = market.tokens.find((t) => t.sideAlias === "UP");
  const downToken = market.tokens.find((t) => t.sideAlias === "DOWN");
  if (!upToken || !downToken) return null;
  return { market, upToken, downToken };
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
    const label = `BUY ${token.outcomeLabel} ${shares}@${ask.toFixed(3)}`;
    void guard(label, async () => {
      resetLedgerIfMarketChanged(target);
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
      // Re-entering this side: stop suppressing data-api updates for it.
      clearSellSuppression(token.assetId);
      const leg = isYes ? ledgerState.yes : ledgerState.no;
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
    const label = `SELL ALL ${token.outcomeLabel}`;
    void guard(label, async () => {
      resetLedgerIfMarketChanged(target);
      const sold = await trade.sellAll({
        marketSlug: market.marketSlug,
        tickSize: market.tickSize,
        negRisk: market.negRisk,
        tokenId: token.assetId,
        outcomeLabel: token.outcomeLabel,
        priceHint: bid,
      });
      if (sold > 0) {
        // Optimistic clear: hide the position immediately and ignore stale
        // data-api responses until the API confirms zero (or 45s expires).
        markAssetRecentlySold(token.assetId);
        const leg = isYes ? ledgerState.yes : ledgerState.no;
        reduceOnSell(leg, sold);
        triggerRender();
        triggerPositionsRefresh();
        return `sold ${sold} sh; ledger YES=${ledgerState.yes.shares.toFixed(2)} NO=${ledgerState.no.shares.toFixed(2)}`;
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
  process.exit(code);
}

main().catch((err) => {
  console.error("Failed to start realtime stream:", err);
  process.exit(1);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
