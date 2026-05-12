/**
 * Public Polymarket Data API client (no auth needed).
 * https://data-api.polymarket.com/positions?user=0x...
 */
export type PolyUserPosition = {
  proxyWallet: string;
  /** Token (CTF asset) id — decimal string identical to clobTokenIds entries. */
  asset: string;
  conditionId: string;
  /** Shares currently held. */
  size: number;
  /** Weighted average entry price ($/share) of the open lot. */
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  /** Last/mark price reported by the API. */
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  /** Display label for this side (e.g. "Yes", "Andrea Pellegrino"). */
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate?: string;
  negativeRisk: boolean;
};

export type FetchUserPositionsOptions = {
  /** Filter to a single market by condition id (recommended). */
  conditionId?: string;
  /** Hide tiny dust below this share count (default: 0.0001). */
  sizeThreshold?: number;
  /** Max rows to return (default: 100, max 500 per API). */
  limit?: number;
  /** Override the base URL (e.g. for tests). */
  baseUrl?: string;
};

const DEFAULT_BASE_URL = "https://data-api.polymarket.com";

export async function fetchUserPositions(
  funderAddress: string,
  options: FetchUserPositionsOptions = {},
): Promise<PolyUserPosition[]> {
  if (!funderAddress) return [];

  const base = options.baseUrl ?? DEFAULT_BASE_URL;
  const url = new URL(`${base}/positions`);
  url.searchParams.set("user", funderAddress);
  url.searchParams.set(
    "sizeThreshold",
    String(options.sizeThreshold ?? 0.0001),
  );
  url.searchParams.set("limit", String(options.limit ?? 100));
  if (options.conditionId) {
    url.searchParams.set("market", options.conditionId);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(
      `Polymarket data-api positions failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as PolyUserPosition[];
  return Array.isArray(data) ? data : [];
}
