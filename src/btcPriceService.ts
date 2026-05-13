/**
 * Real-time BTC/USD price for the BTC up/down markets.
 *
 * Source: **Coinbase Exchange** public WebSocket (`ticker` channel) for live
 * spot, plus a REST `/candles` lookup for historical reference prices used as
 * "target" values at the start of each 5-minute window.
 *
 * Why Coinbase? Polymarket resolves BTC up/down markets against the Chainlink
 * BTC/USD data stream. Coinbase Pro is one of the major feeds Chainlink
 * aggregates and is publicly streamable without an API key, so its spot price
 * tracks Chainlink within ~$1 in normal conditions — close enough that the
 * directional signal (Up vs Down) matches the resolution outcome.
 */

import WebSocket from "ws";

const COINBASE_WS_URL = "wss://ws-feed.exchange.coinbase.com";
const COINBASE_REST_BASE = "https://api.exchange.coinbase.com";

export type BtcSnapshot = {
  price: number;
  /** epoch ms when we received this update */
  receivedAtMs: number;
  /** ISO timestamp from Coinbase (when the trade matched) */
  tradedAtIso?: string;
};

type BtcPriceListener = (snapshot: BtcSnapshot) => void;

export class BtcPriceService {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private latest: BtcSnapshot | null = null;
  private listeners = new Set<BtcPriceListener>();
  private stopped = false;

  public start(): void {
    this.stopped = false;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  public getLatest(): BtcSnapshot | null {
    return this.latest;
  }

  public onPriceUpdate(listener: BtcPriceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private connect(): void {
    if (this.stopped) return;
    this.ws = new WebSocket(COINBASE_WS_URL);

    this.ws.on("open", () => {
      this.ws?.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: ["BTC-USD"],
          channels: ["ticker"],
        }),
      );
    });

    this.ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (
        typeof msg === "object" &&
        msg !== null &&
        "type" in msg &&
        (msg as { type?: unknown }).type === "ticker" &&
        "product_id" in msg &&
        (msg as { product_id?: unknown }).product_id === "BTC-USD"
      ) {
        const m = msg as { price?: unknown; time?: unknown };
        const price = Number(m.price);
        if (!Number.isFinite(price) || price <= 0) return;
        const snapshot: BtcSnapshot = {
          price,
          receivedAtMs: Date.now(),
          tradedAtIso: typeof m.time === "string" ? m.time : undefined,
        };
        this.latest = snapshot;
        for (const l of this.listeners) l(snapshot);
      }
    });

    this.ws.on("close", () => this.scheduleReconnect());
    this.ws.on("error", () => this.scheduleReconnect());
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}

/**
 * Fetch the **open** price of the 1-minute Coinbase BTC-USD candle that
 * starts at `unixSec`. This is the BTC/USD reference price exactly at the
 * start of a Polymarket up/down window — i.e. the "target" the market
 * resolves against.
 *
 * Returns `null` if the candle isn't available yet (e.g. the boundary is in
 * the future or Coinbase hasn't indexed it).
 */
export async function fetchBtcPriceAtUnix(
  unixSec: number,
): Promise<number | null> {
  // Coinbase's [start, end] window is finicky on narrow ranges (a 60-second
  // window often returns 0 rows). Pad ±2 minutes around the target candle
  // and pick the row whose `time` matches exactly.
  const startIso = new Date((unixSec - 60) * 1000).toISOString();
  const endIso = new Date((unixSec + 120) * 1000).toISOString();
  // Cache-bust: Coinbase fronts /candles with Cloudflare and `cache-control:
  // public, max-age=300`. If the very first fetch (right after a window
  // boundary) sees an empty array because the new candle isn't indexed yet,
  // that empty response sticks in the edge cache for 5 minutes — every retry
  // returns the same stale `[]` and the target stays "fetching…" forever.
  // A unique query param defeats the cache; Coinbase ignores unknown params.
  const cacheBust = `&_=${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const url = `${COINBASE_REST_BASE}/products/BTC-USD/candles?granularity=60&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}${cacheBust}`;
  let resp: Response;
  try {
    resp = await fetch(url, { cache: "no-store" });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  // Coinbase candle: [time, low, high, open, close, volume]
  for (const row of data) {
    if (Array.isArray(row) && row.length >= 4 && row[0] === unixSec) {
      const open = Number(row[3]);
      return Number.isFinite(open) && open > 0 ? open : null;
    }
  }
  return null;
}
