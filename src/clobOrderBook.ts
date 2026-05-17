/** One price level from `GET /book?token_id=…`. */
export type BookLevel = { price: number; size: number };

export type ParsedOrderBook = {
  bids: BookLevel[];
  asks: BookLevel[];
  tickSize: string;
};

export type BookDepthMetrics = {
  bestBid: number | null;
  bestAsk: number | null;
  /** Sum(price × size) over every bid level in the book. */
  totalBidNotionalUsd: number;
  /** Sum(price × size) over every ask level in the book. */
  totalAskNotionalUsd: number;
  bidLevelCount: number;
  askLevelCount: number;
};

function parseLevels(raw: unknown): BookLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: BookLevel[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const price = Number((row as { price?: string }).price);
    const size = Number((row as { size?: string }).size);
    if (
      !Number.isFinite(price) ||
      !Number.isFinite(size) ||
      price <= 0 ||
      size <= 0
    ) {
      continue;
    }
    out.push({ price, size });
  }
  return out;
}

export async function fetchOrderBook(
  clobHost: string,
  tokenId: string,
): Promise<ParsedOrderBook | null> {
  const base = clobHost.replace(/\/$/, "");
  const url = `${base}/book?token_id=${encodeURIComponent(tokenId)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return {
      bids: parseLevels(data.bids),
      asks: parseLevels(data.asks),
      tickSize: String(data.tick_size ?? "0.01"),
    };
  } catch {
    return null;
  }
}

/** Sum $ notional across every level in the book (full depth). */
export function sumTotalBookNotional(levels: BookLevel[]): number {
  let sum = 0;
  for (const lvl of levels) {
    sum += lvl.price * lvl.size;
  }
  return sum;
}

/** Full CLOB book totals — used for YES/NO display at market open and on each poll. */
export function computeBookDepthMetrics(book: ParsedOrderBook): BookDepthMetrics {
  return {
    bestBid: book.bids.length > 0 ? book.bids[0].price : null,
    bestAsk: book.asks.length > 0 ? book.asks[0].price : null,
    totalBidNotionalUsd: sumTotalBookNotional(book.bids),
    totalAskNotionalUsd: sumTotalBookNotional(book.asks),
    bidLevelCount: book.bids.length,
    askLevelCount: book.asks.length,
  };
}

export function formatDepthUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 10_000) return `$${(usd / 1000).toFixed(1)}k`;
  return `$${Math.round(usd)}`;
}
