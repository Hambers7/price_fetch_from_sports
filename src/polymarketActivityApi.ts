/**
 * Public Polymarket Data API — user activity (fills).
 * https://data-api.polymarket.com/activity?user=...
 */

export type PolyActivity = {
  proxyWallet: string;
  /** Unix seconds. */
  timestamp: number;
  conditionId: string;
  type: string;
  size: number;
  usdcSize: number;
  transactionHash: string;
  /** $/share. */
  price: number;
  /** CTF token id (decimal string). */
  asset: string;
  side?: "BUY" | "SELL";
  outcomeIndex: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
};

const DEFAULT_BASE_URL = "https://data-api.polymarket.com";

export type FetchActivityOptions = {
  conditionId?: string;
  limit?: number;
  baseUrl?: string;
};

/** TRADE rows for one market, newest first. */
export async function fetchActivityForMarket(
  wallet: string,
  conditionId: string,
  options: FetchActivityOptions = {},
): Promise<PolyActivity[]> {
  if (!wallet || !conditionId) return [];

  const base = options.baseUrl ?? DEFAULT_BASE_URL;
  const url = new URL(`${base}/activity`);
  url.searchParams.set("user", wallet);
  url.searchParams.set("market", conditionId);
  url.searchParams.set("type", "TRADE");
  url.searchParams.set("limit", String(options.limit ?? 100));
  url.searchParams.set("sortBy", "TIMESTAMP");
  url.searchParams.set("sortDirection", "DESC");

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(
      `Polymarket data-api activity failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as PolyActivity[];
  if (!Array.isArray(data)) return [];
  return data.filter((r) => r.type === "TRADE" && (r.side === "BUY" || r.side === "SELL"));
}
