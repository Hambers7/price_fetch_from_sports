import WebSocket from "ws";
import { config } from "./config";
import {
  buildUpDownSlugs,
  UP_DOWN_WINDOW_SECONDS,
  type UpDownConfig,
} from "./cryptoUpDown";
import {
  discoverSoccerMatchMarketSlugs,
  resolveProvidedSlugsToMarketSlugs,
} from "./gammaSports";
import { GammaMarket, TickSize, TokenPriceState, TrackedMarket } from "./types";

type PolymarketRealtimeServiceOptions = {
  gammaBaseUrl?: string;
  marketWsUrl?: string;
  marketSlugs?: string[];
  marketSlug?: string;
  updownMarketSymbol?: string;
  maxMarkets?: number;
  refreshMarketsMs?: number;
  /** When true, ignore slug list and scan Gamma for live soccer match markets (UCL, EPL, etc.). */
  discoverSoccerMatches?: boolean;
  /**
   * When set, the service auto-tracks Polymarket "<symbol>-updown-<duration>"
   * binary markets (e.g. BTC 5-minute). Slugs rotate every refresh tick so as
   * windows close the next one slides in.
   */
  cryptoUpDown?: UpDownConfig;
  discoverEventsPageSize?: number;
  discoverMaxPages?: number;
};

type ResolvedOptions = {
  gammaBaseUrl: string;
  marketWsUrl: string;
  marketSlugs: string[];
  marketSlug: string;
  updownMarketSymbol: string;
  maxMarkets: number;
  refreshMarketsMs: number;
  discoverSoccerMatches: boolean;
  cryptoUpDown: UpDownConfig | null;
  discoverEventsPageSize: number;
  discoverMaxPages: number;
};

type PriceUpdateListener = (assetId: string, state: TokenPriceState) => void;

function parseJsonArray(input?: string): string[] {
  if (!input) return [];
  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function isSportsMarket(market: GammaMarket): boolean {
  return (market.tags ?? []).some((tag) =>
    tag.toLowerCase().includes("sports"),
  );
}

const ALLOWED_TICK_SIZES: ReadonlySet<TickSize> = new Set([
  "0.1",
  "0.01",
  "0.001",
  "0.0001",
]);

function normalizeTickSize(raw: number | string | undefined): TickSize {
  if (raw == null) return "0.01";
  const asStr = typeof raw === "number" ? String(raw) : raw.trim();
  if ((ALLOWED_TICK_SIZES as Set<string>).has(asStr)) {
    return asStr as TickSize;
  }
  const asNum = Number(asStr);
  if (Number.isFinite(asNum)) {
    if (asNum >= 0.1) return "0.1";
    if (asNum >= 0.01) return "0.01";
    if (asNum >= 0.001) return "0.001";
    return "0.0001";
  }
  return "0.01";
}


function getCurrent15mWindowUnix(nowMs = Date.now()): number {
  const nowSec = Math.floor(nowMs / 1000);
  const windowSec = 15 * 60;
  return Math.floor(nowSec / windowSec) * windowSec;
}

export class PolymarketRealtimeService {
  private readonly options: ResolvedOptions;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 3000;

  private trackedMarkets: TrackedMarket[] = [];
  private pricesByAssetId = new Map<string, TokenPriceState>();
  private listeners = new Set<PriceUpdateListener>();
  private assetLookup = new Map<
    string,
    {
      marketSlug: string;
      marketQuestion: string;
      sideAlias: "UP" | "DOWN";
      outcomeLabel: string;
    }
  >();

  constructor(options: PolymarketRealtimeServiceOptions = {}) {
    const marketSlugs = (options.marketSlugs ?? [])
      .map((slug) => slug.trim())
      .filter(Boolean);

    const cryptoUpDown = options.cryptoUpDown ?? null;
    // Up/down windows expire every few minutes; a 10-minute refresh is too
    // slow to rotate the active row before its market resolves. Default to
    // 60s when this mode is enabled (caller can still override).
    const defaultRefreshMs = cryptoUpDown ? 60_000 : config.refreshMarketsMs;

    this.options = {
      gammaBaseUrl: options.gammaBaseUrl ?? config.gammaBaseUrl,
      marketWsUrl: options.marketWsUrl ?? config.marketWsUrl,
      marketSlugs,
      marketSlug: options.marketSlug ?? config.marketSlug,
      updownMarketSymbol:
        options.updownMarketSymbol ?? config.updownMarketSymbol,
      maxMarkets: options.maxMarkets ?? config.maxMarkets,
      refreshMarketsMs: options.refreshMarketsMs ?? defaultRefreshMs,
      discoverSoccerMatches: options.discoverSoccerMatches ?? false,
      cryptoUpDown,
      discoverEventsPageSize:
        options.discoverEventsPageSize ?? config.discoverEventsPageSize,
      discoverMaxPages: options.discoverMaxPages ?? config.discoverMaxPages,
    };
  }

  public async start(): Promise<void> {
    await this.refreshTrackedMarkets();
    this.connectWebsocket();
    this.scheduleNextRefresh();
  }

  public stop(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }

  /**
   * Chained setTimeout instead of setInterval so we can use a boundary-aligned
   * delay in cryptoUpDown mode — i.e. fire a refresh ~3s after each 5m
   * boundary so the next window slides in promptly.
   */
  private scheduleNextRefresh(): void {
    const delay = this.computeRefreshDelayMs();
    this.refreshTimer = setTimeout(async () => {
      try {
        await this.refreshTrackedMarkets();
        this.reconnectWebsocket();
      } finally {
        this.scheduleNextRefresh();
      }
    }, delay);
  }

  private computeRefreshDelayMs(): number {
    const base = this.options.refreshMarketsMs;
    const cu = this.options.cryptoUpDown;
    if (!cu) return base;
    // ms until the next aligned window boundary, plus a small buffer so Gamma
    // has rotated the new window into "active" state before we re-fetch.
    const windowMs = UP_DOWN_WINDOW_SECONDS[cu.duration] * 1000;
    const now = Date.now();
    const msUntilBoundary = windowMs - (now % windowMs) + 3000;
    return Math.min(base, msUntilBoundary);
  }

  public getSnapshot(): {
    markets: TrackedMarket[];
    prices: Record<string, TokenPriceState>;
    tokenCount: number;
    marketCount: number;
  } {
    return {
      markets: this.trackedMarkets,
      prices: Object.fromEntries(this.pricesByAssetId.entries()),
      tokenCount: this.assetLookup.size,
      marketCount: this.trackedMarkets.length,
    };
  }

  public onPriceUpdate(listener: PriceUpdateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async refreshTrackedMarkets(): Promise<void> {
    const markets = await this.fetchSportsUpDownMarkets();
    this.trackedMarkets = markets;
    this.assetLookup.clear();

    for (const market of markets) {
      for (const token of market.tokens) {
        this.assetLookup.set(token.assetId, {
          marketSlug: market.marketSlug,
          marketQuestion: market.marketQuestion,
          sideAlias: token.sideAlias,
          outcomeLabel: token.outcomeLabel,
        });
      }
    }
  }

  private async fetchSportsUpDownMarkets(): Promise<TrackedMarket[]> {
    let targetSlugs: string[] = [];

    if (this.options.cryptoUpDown) {
      // Generate slugs from the wall clock — re-runs each refresh, so as
      // 5-minute windows close the next one rotates in automatically.
      targetSlugs = buildUpDownSlugs(this.options.cryptoUpDown);
    } else if (this.options.discoverSoccerMatches) {
      targetSlugs = await discoverSoccerMatchMarketSlugs(
        this.options.gammaBaseUrl,
        {
          maxMarkets: this.options.maxMarkets,
          pageSize: this.options.discoverEventsPageSize,
          maxPages: this.options.discoverMaxPages,
        },
      );
    } else {
      targetSlugs =
        this.options.marketSlugs.length > 0
          ? this.options.marketSlugs
          : this.options.marketSlug
            ? [this.options.marketSlug]
            : this.getDynamicUpdownSlug()
              ? [this.getDynamicUpdownSlug()]
              : [];

      if (targetSlugs.length > 0) {
        targetSlugs = await resolveProvidedSlugsToMarketSlugs(
          this.options.gammaBaseUrl,
          targetSlugs,
        );
      }
    }

    const selectedMarkets = targetSlugs.length
      ? await this.fetchMarketsBySlugs(targetSlugs)
      : await this.fetchDefaultMarkets();

    console.log(
      `Market selection: targetSlugs=${targetSlugs.length ? targetSlugs.join(",") : "(none)"} candidates=${selectedMarkets.length}`,
    );

    const tracked: TrackedMarket[] = [];

    for (const market of selectedMarkets) {
      const tokenIds = parseJsonArray(market.clobTokenIds);
      const outcomes = parseJsonArray(market.outcomes);
      if (tokenIds.length !== 2 || outcomes.length !== 2) continue;

      tracked.push({
        marketQuestion: market.question ?? "Unknown question",
        marketSlug: market.slug ?? "unknown-slug",
        conditionId: market.conditionId ?? "",
        negRisk: Boolean(market.negRisk),
        tickSize: normalizeTickSize(market.orderPriceMinTickSize),
        tokens: [
          {
            assetId: tokenIds[0],
            sideAlias: "UP",
            outcomeLabel: outcomes[0] ?? "Outcome 1",
          },
          {
            assetId: tokenIds[1],
            sideAlias: "DOWN",
            outcomeLabel: outcomes[1] ?? "Outcome 2",
          },
        ],
      });
    }

    if (targetSlugs.length > 0 && tracked.length === 0) {
      console.warn(
        `No active 2-outcome market found for requested slugs: ${targetSlugs.join(", ")}`,
      );
    }

    return tracked;
  }

  private async fetchMarketsBySlugs(slugs: string[]): Promise<GammaMarket[]> {
    const uniqueSlugs = Array.from(new Set(slugs.map((slug) => slug.toLowerCase())));
    const responses = await Promise.all(
      uniqueSlugs.map(async (slug) => {
        const response = await fetch(
          `${this.options.gammaBaseUrl}/markets?slug=${encodeURIComponent(slug)}`,
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch market slug "${slug}" (${response.status})`,
          );
        }
        return (await response.json()) as GammaMarket[];
      }),
    );

    const bySlug = new Map<string, GammaMarket>();
    for (const markets of responses) {
      for (const market of markets) {
        const slug = (market.slug ?? "").toLowerCase();
        if (!slug) continue;
        bySlug.set(slug, market);
      }
    }

    return uniqueSlugs
      .map((slug) => bySlug.get(slug))
      .filter((market): market is GammaMarket => Boolean(market))
      .filter((m) => m.active && !m.closed);
  }

  private async fetchDefaultMarkets(): Promise<GammaMarket[]> {
    const response = await fetch(
      `${this.options.gammaBaseUrl}/markets?active=true&closed=false&limit=200`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch markets (${response.status})`);
    }
    const allMarkets = (await response.json()) as GammaMarket[];
    return allMarkets
      .filter((m) => m.active && !m.closed && isSportsMarket(m))
      .slice(0, this.options.maxMarkets);
  }

  private getDynamicUpdownSlug(): string {
    if (!this.options.updownMarketSymbol) return "";
    const windowStartUnix = getCurrent15mWindowUnix();
    return `${this.options.updownMarketSymbol}-updown-15m-${windowStartUnix}`;
  }

  private connectWebsocket(): void {
    const assetIds = Array.from(this.assetLookup.keys());
    if (!assetIds.length) {
      console.warn(
        "No tokens for websocket subscription. Pass market/event slug args, use --soccer-matches, or set UPDOWN_MARKET_SYMBOL in .env.",
      );
      return;
    }

    this.ws = new WebSocket(this.options.marketWsUrl);

    this.ws.on("open", () => {
      this.ws?.send(
        JSON.stringify({
          assets_ids: assetIds,
          type: "market",
          custom_feature_enabled: true,
        }),
      );
      console.log(`Subscribed to ${assetIds.length} up/down tokens.`);
    });

    this.ws.on("message", (raw) => {
      this.handleWsMessage(raw.toString());
    });

    this.ws.on("close", () => {
      this.scheduleReconnect();
    });

    this.ws.on("error", () => {
      this.scheduleReconnect();
    });
  }

  private reconnectWebsocket(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.connectWebsocket();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectWebsocket();
    }, this.reconnectDelayMs);
  }

  private handleWsMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (
      msg?.event_type === "best_bid_ask" &&
      typeof msg.asset_id === "string"
    ) {
      this.upsertState(msg.asset_id, {
        bestBid: msg.best_bid,
        bestAsk: msg.best_ask,
        spread: msg.spread,
      });
      return;
    }

    if (
      msg?.event_type === "last_trade_price" &&
      typeof msg.asset_id === "string"
    ) {
      this.upsertState(msg.asset_id, {
        lastTradePrice: msg.price,
        lastTradeSide: msg.side,
        lastTradeSize: msg.size,
      });
      return;
    }

    if (
      msg?.event_type === "price_change" &&
      Array.isArray(msg.price_changes)
    ) {
      for (const change of msg.price_changes) {
        if (!change?.asset_id) continue;
        this.upsertState(change.asset_id, {
          bestBid: change.best_bid,
          bestAsk: change.best_ask,
        });
      }
    }
  }

  private upsertState(
    assetId: string,
    patch: Partial<
      Pick<
        TokenPriceState,
        | "bestBid"
        | "bestAsk"
        | "spread"
        | "lastTradePrice"
        | "lastTradeSide"
        | "lastTradeSize"
      >
    >,
  ): void {
    const token = this.assetLookup.get(assetId);
    if (!token) return;

    const prev = this.pricesByAssetId.get(assetId);
    const nextState: TokenPriceState = {
      marketSlug: token.marketSlug,
      marketQuestion: token.marketQuestion,
      sideAlias: token.sideAlias,
      outcomeLabel: token.outcomeLabel,
      bestBid: patch.bestBid ?? prev?.bestBid,
      bestAsk: patch.bestAsk ?? prev?.bestAsk,
      spread: patch.spread ?? prev?.spread,
      lastTradePrice: patch.lastTradePrice ?? prev?.lastTradePrice,
      lastTradeSide: patch.lastTradeSide ?? prev?.lastTradeSide,
      lastTradeSize: patch.lastTradeSize ?? prev?.lastTradeSize,
      updatedAt: Date.now(),
    };
    this.pricesByAssetId.set(assetId, nextState);
    for (const listener of this.listeners) {
      listener(assetId, nextState);
    }
  }
}
