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

    if (
      ledgerState.yes.shares > 0 ||
      ledgerState.no.shares > 0
    ) {
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

        console.log("\n--- Session position (YES = UP / NO = DOWN) ---");
        if (ledgerState.yes.shares > 0) {
          const avg = avgEntry(ledgerState.yes);
          const sh = ledgerState.yes.shares.toFixed(2);
          if (markY != null) {
            const pnl = unrealizedPnlUsd(ledgerState.yes, markY);
            console.log(
              `YES (${upLabel}): ${sh} sh @ avg ${avg.toFixed(3)} | mark ${markY.toFixed(3)} | ${formatPnlLine(pnl)}`,
            );
          } else {
            console.log(
              `YES (${upLabel}): ${sh} sh @ avg ${avg.toFixed(3)} | mark — | PNL: —`,
            );
          }
        }
        if (ledgerState.no.shares > 0) {
          const avg = avgEntry(ledgerState.no);
          const sh = ledgerState.no.shares.toFixed(2);
          if (markN != null) {
            const pnl = unrealizedPnlUsd(ledgerState.no, markN);
            console.log(
              `NO (${downLabel}): ${sh} sh @ avg ${avg.toFixed(3)} | mark ${markN.toFixed(3)} | ${formatPnlLine(pnl)}`,
            );
          } else {
            console.log(
              `NO (${downLabel}): ${sh} sh @ avg ${avg.toFixed(3)} | mark — | PNL: —`,
            );
          }
        }
      }
    }

    if (tradingEnabled) {
      const target = snapshot.markets[0];
      if (target) {
        console.log(
          `\nTrading market => ${target.marketSlug} | tickSize=${target.tickSize} negRisk=${target.negRisk}`,
        );
      }
      console.log(HOTKEYS_HINT);
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

  await service.start();
  console.log("Polymarket real-time up/down price stream started.");

  if (tradingEnabled && tradeService) {
    setupHotkeys(tradeService, setStatus);
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
      const leg = isYes ? ledgerState.yes : ledgerState.no;
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
        const leg = isYes ? ledgerState.yes : ledgerState.no;
        reduceOnSell(leg, sold);
        return `sold ${sold} sh; ledger YES=${ledgerState.yes.shares.toFixed(2)} NO=${ledgerState.no.shares.toFixed(2)}`;
      }
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
