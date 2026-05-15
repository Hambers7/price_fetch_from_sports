import * as fs from "fs";
import * as path from "path";

/** On-disk format v1 — keep in sync with server.ts journal / ledger shapes. */
export type PersistedSideLeg = { shares: number; cost: number };

export type PersistedMarketLedger = {
  yes: PersistedSideLeg;
  no: PersistedSideLeg;
};

export type PersistedClosedTrade = {
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

export type PersistedJournalEntry = {
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

export type TradeHistoryFileV1 = {
  version: 1;
  tradeJournal: PersistedJournalEntry[];
  closedTradeHistory: PersistedClosedTrade[];
  marketLedgers: Record<string, PersistedMarketLedger>;
};

const FILE_VERSION = 1 as const;

export function resolveTradeHistoryPath(): string {
  const fromEnv = process.env.TRADE_HISTORY_FILE?.trim();
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(process.cwd(), fromEnv);
  return path.join(process.cwd(), ".price-fetch-trade-history.json");
}

function isSideLeg(x: unknown): x is PersistedSideLeg {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.shares === "number" &&
    typeof o.cost === "number" &&
    Number.isFinite(o.shares) &&
    Number.isFinite(o.cost)
  );
}

function isLedger(x: unknown): x is PersistedMarketLedger {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return isSideLeg(o.yes) && isSideLeg(o.no);
}

export function loadTradeHistoryFile(): TradeHistoryFileV1 | null {
  const file = resolveTradeHistoryPath();
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return null;
    const d = data as Record<string, unknown>;
    if (d.version !== FILE_VERSION) return null;
    if (!Array.isArray(d.tradeJournal) || !Array.isArray(d.closedTradeHistory)) return null;
    if (!d.marketLedgers || typeof d.marketLedgers !== "object") return null;

    const marketLedgers: Record<string, PersistedMarketLedger> = {};
    for (const [k, v] of Object.entries(d.marketLedgers as Record<string, unknown>)) {
      if (typeof k === "string" && k.length > 0 && isLedger(v)) {
        marketLedgers[k] = v;
      }
    }

    return {
      version: 1,
      tradeJournal: d.tradeJournal as PersistedJournalEntry[],
      closedTradeHistory: d.closedTradeHistory as PersistedClosedTrade[],
      marketLedgers,
    };
  } catch {
    return null;
  }
}

export function writeTradeHistoryFileSync(state: TradeHistoryFileV1): void {
  const file = resolveTradeHistoryPath();
  const payload: TradeHistoryFileV1 = {
    version: 1,
    tradeJournal: state.tradeJournal,
    closedTradeHistory: state.closedTradeHistory,
    marketLedgers: state.marketLedgers,
  };
  const body = `${JSON.stringify(payload, null, 0)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

export function createDebouncedTradeHistoryWriter(
  delayMs: number,
  getState: () => TradeHistoryFileV1,
): { schedule: () => void; flushSync: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flushSync = (): void => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      writeTradeHistoryFileSync(getState());
    } catch (err) {
      console.error(
        `[history] failed to write ${resolveTradeHistoryPath()}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  };

  const schedule = (): void => {
    if (timer != null) clearTimeout(timer);
    const t = setTimeout(() => {
      timer = null;
      flushSync();
    }, delayMs);
    timer = t;
    t.unref();
  };

  return { schedule, flushSync };
}
