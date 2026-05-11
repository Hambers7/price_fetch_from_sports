import dotenv from "dotenv";

dotenv.config();

function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  gammaBaseUrl:
    process.env.GAMMA_BASE_URL ?? "https://gamma-api.polymarket.com",
  marketWsUrl:
    process.env.MARKET_WS_URL ??
    "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  sportsWsUrl:
    process.env.SPORTS_WS_URL ?? "wss://sports-api.polymarket.com/ws",
  marketSlug: process.env.MARKET_SLUG?.trim() || "",
  updownMarketSymbol:
    process.env.UPDOWN_MARKET_SYMBOL?.trim().toLowerCase() || "",
  maxMarkets: getNumberEnv("MAX_MARKETS", 10),
  /** Page size when scanning Gamma /events for --soccer-matches discovery. */
  discoverEventsPageSize: getNumberEnv("DISCOVER_EVENTS_PAGE_SIZE", 100),
  /** Max Gamma /events pages to scan per refresh (safety cap). */
  discoverMaxPages: getNumberEnv("DISCOVER_MAX_PAGES", 30),
  refreshMarketsMs: getNumberEnv("REFRESH_MARKETS_MS", 10 * 60 * 1000),
};
