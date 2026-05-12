import dotenv from "dotenv";

dotenv.config();

function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
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

/**
 * CLOB v2 trading config. Loaded once at process start; changes require a restart.
 * Trading is only enabled when both PRIVATE_KEY and FUNDER_ADDRESS are set.
 */
export const tradeConfig = {
  privateKey: (process.env.POLYMARKET_PRIVATE_KEY ?? "").trim(),
  funderAddress: (process.env.POLYMARKET_FUNDER_ADDRESS ?? "").trim(),
  clobHost:
    (process.env.POLYMARKET_CLOB_HOST ?? "").trim() ||
    "https://clob.polymarket.com",
  rpcUrl:
    (process.env.POLYMARKET_RPC_URL ?? "").trim() || "https://polygon-rpc.com",
  /** 0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE, 3=POLY_1271 */
  signatureType: getIntEnv("POLYMARKET_SIGNATURE_TYPE", 2),
  chainId: 137,
  shares: getNumberEnv("SHARES", 0),
};

export function isTradingEnabled(): boolean {
  return Boolean(tradeConfig.privateKey) && Boolean(tradeConfig.funderAddress);
}
