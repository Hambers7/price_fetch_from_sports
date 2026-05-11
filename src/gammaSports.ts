import type { GammaEvent, GammaMarket } from "./types";

function parseJsonStringArray(raw?: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function tagSlugsFromEvent(event: GammaEvent): string[] {
  const tags = event.tags ?? [];
  return tags
    .map((t) => (t.slug ?? "").toLowerCase())
    .filter(Boolean);
}

/** Match-style soccer events: tagged games + soccer, a small bundle of CLOB markets. */
export function isSoccerMatchDiscoveryEvent(event: GammaEvent): boolean {
  if (!event.active || event.closed || event.archived) return false;
  const tags = new Set(tagSlugsFromEvent(event));
  if (!tags.has("soccer") || !tags.has("games")) return false;

  const markets = event.markets ?? [];
  if (markets.length < 2 || markets.length > 8) return false;

  return markets.some((m) => isBinaryClobMarket(m));
}

function isBinaryClobMarket(market: GammaMarket): boolean {
  if (!market.active || market.closed) return false;
  const tokenIds = parseJsonStringArray(market.clobTokenIds);
  const outcomes = parseJsonStringArray(market.outcomes);
  return tokenIds.length === 2 && outcomes.length === 2;
}

/** Prop / derivative lines we skip in bulk discovery (event slugs still return everything). */
function isPropishSoccerMarketSlug(slug: string): boolean {
  const s = slug.toLowerCase();
  const snippets = [
    "-total-",
    "-spread-",
    "btts",
    "-corner",
    "-booking",
    "-red-card",
    "-offsides",
    "-first-goal",
    "-anytime-",
    "-team-",
    "-handicap",
    "-clean-sheet",
    "-score-",
  ];
  return snippets.some((h) => s.includes(h));
}

export async function fetchMarketsBySlug(
  gammaBaseUrl: string,
  slug: string,
): Promise<GammaMarket[]> {
  const response = await fetch(
    `${gammaBaseUrl}/markets?slug=${encodeURIComponent(slug)}`,
  );
  if (!response.ok) {
    throw new Error(
      `Gamma markets fetch failed for slug "${slug}" (${response.status})`,
    );
  }
  return (await response.json()) as GammaMarket[];
}

export async function fetchEventsBySlug(
  gammaBaseUrl: string,
  slug: string,
): Promise<GammaEvent[]> {
  const response = await fetch(
    `${gammaBaseUrl}/events?slug=${encodeURIComponent(slug)}`,
  );
  if (!response.ok) {
    throw new Error(
      `Gamma events fetch failed for slug "${slug}" (${response.status})`,
    );
  }
  return (await response.json()) as GammaEvent[];
}

async function fetchEventsByTagPage(
  gammaBaseUrl: string,
  tagSlug: string,
  limit: number,
  offset: number,
): Promise<GammaEvent[]> {
  const params = new URLSearchParams({
    tag_slug: tagSlug,
    active: "true",
    closed: "false",
    limit: String(limit),
    offset: String(offset),
  });
  const response = await fetch(`${gammaBaseUrl}/events?${params.toString()}`);
  if (!response.ok) {
    throw new Error(
      `Gamma events list failed for tag "${tagSlug}" (${response.status})`,
    );
  }
  return (await response.json()) as GammaEvent[];
}

/**
 * Expand Polymarket "event" slugs (e.g. ucl-ars-atm1-2026-05-05) into underlying
 * CLOB market slugs. Leaves true market slugs unchanged.
 */
export async function resolveProvidedSlugsToMarketSlugs(
  gammaBaseUrl: string,
  slugs: string[],
): Promise<string[]> {
  const normalized = Array.from(
    new Set(slugs.map((s) => s.trim().toLowerCase()).filter(Boolean)),
  );
  const out: string[] = [];

  for (const slug of normalized) {
    const direct = await fetchMarketsBySlug(gammaBaseUrl, slug);
    const directHit = direct.find(
      (m) => (m.slug ?? "").toLowerCase() === slug && m.active && !m.closed,
    );
    if (directHit?.slug) {
      out.push(directHit.slug.toLowerCase());
      continue;
    }

    const events = await fetchEventsBySlug(gammaBaseUrl, slug);
    let added = false;
    for (const event of events) {
      if ((event.slug ?? "").toLowerCase() !== slug) continue;
      for (const market of event.markets ?? []) {
        if (!isBinaryClobMarket(market) || !market.slug) continue;
        out.push(market.slug.toLowerCase());
        added = true;
      }
    }
    if (!added) {
      console.warn(
        `Slug "${slug}" did not resolve to an active market or event with binary CLOB markets.`,
      );
    }
  }

  return Array.from(new Set(out));
}

export type DiscoverSoccerMatchesOptions = {
  maxMarkets: number;
  pageSize: number;
  maxPages: number;
};

/**
 * Paginate Gamma "games" events, keep soccer match cards (few linked markets),
 * return up to maxMarkets binary market slugs.
 */
export async function discoverSoccerMatchMarketSlugs(
  gammaBaseUrl: string,
  options: DiscoverSoccerMatchesOptions,
): Promise<string[]> {
  const slugs = new Set<string>();
  let offset = 0;

  for (let page = 0; page < options.maxPages; page += 1) {
    if (slugs.size >= options.maxMarkets) break;

    const events = await fetchEventsByTagPage(
      gammaBaseUrl,
      "games",
      options.pageSize,
      offset,
    );
    if (!events.length) break;

    for (const event of events) {
      if (!isSoccerMatchDiscoveryEvent(event)) continue;
      for (const market of event.markets ?? []) {
        if (!isBinaryClobMarket(market) || !market.slug) continue;
        if (isPropishSoccerMarketSlug(market.slug)) continue;
        slugs.add(market.slug.toLowerCase());
        if (slugs.size >= options.maxMarkets) break;
      }
      if (slugs.size >= options.maxMarkets) break;
    }

    offset += options.pageSize;
  }

  if (slugs.size >= options.maxMarkets) {
    console.warn(
      `Soccer match discovery hit MAX_MARKETS=${options.maxMarkets}; raise MAX_MARKETS or DISCOVER_MAX_PAGES for more.`,
    );
  }

  return Array.from(slugs);
}
