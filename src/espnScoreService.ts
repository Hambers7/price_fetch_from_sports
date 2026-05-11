import { config } from "./config";
import { GammaMarket } from "./types";

type SportRoute = {
  sport: string;
  league: string;
};

type ScoreQuery = {
  marketSlug: string;
  marketQuestion: string;
  outcomes: [string, string];
  route: SportRoute;
  date: string;
};

export type MarketScoreRow = {
  marketSlug: string;
  marketQuestion: string;
  team1: string;
  score1: string;
  team2: string;
  score2: string;
  status: string;
  source: string;
};

type EspnCompetitor = {
  displayName?: string;
  shortDisplayName?: string;
  abbreviation?: string;
  team?: {
    displayName?: string;
    shortDisplayName?: string;
    abbreviation?: string;
    name?: string;
    location?: string;
  };
  score?: string;
};

type EspnEvent = {
  competitions?: Array<{
    competitors?: EspnCompetitor[];
  }>;
  status?: {
    type?: {
      description?: string;
      detail?: string;
      shortDetail?: string;
    };
  };
};

const ESPN_BASE_URL = "https://site.api.espn.com/apis/site/v2/sports";

const SPORT_ROUTE_BY_PREFIX: Record<string, SportRoute> = {
  nba: { sport: "basketball", league: "nba" },
  nfl: { sport: "football", league: "nfl" },
  mlb: { sport: "baseball", league: "mlb" },
  nhl: { sport: "hockey", league: "nhl" },
  ncaaf: { sport: "football", league: "college-football" },
  ncaab: { sport: "basketball", league: "mens-college-basketball" },
  atp: { sport: "tennis", league: "atp" },
  wta: { sport: "tennis", league: "wta" },
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function nameTokens(name: string): string[] {
  const chunks = name
    .split(/[\s\-_.]+/)
    .map((part) => normalize(part))
    .filter((part) => part.length >= 2);
  if (chunks.length === 0) return [];
  const last = chunks[chunks.length - 1];
  return Array.from(new Set([normalize(name), ...chunks, last]));
}

function toDateFromSlug(slug: string): string {
  const match = slug.match(/(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }
  return `${match[1]}${match[2]}${match[3]}`;
}

function routeForSlug(slug: string): SportRoute | undefined {
  const prefix = slug.toLowerCase().split("-")[0] ?? "";
  return SPORT_ROUTE_BY_PREFIX[prefix];
}

function competitorNamePool(c: EspnCompetitor): string[] {
  const rawNames = [
    c.displayName,
    c.shortDisplayName,
    c.abbreviation,
    c.team?.displayName,
    c.team?.shortDisplayName,
    c.team?.abbreviation,
    c.team?.name,
    c.team?.location,
  ].filter((v): v is string => Boolean(v && v.trim().length > 0));

  return Array.from(new Set(rawNames.map(normalize).filter(Boolean)));
}

function isSameName(outcome: string, competitor: EspnCompetitor): boolean {
  const outcomeName = normalize(outcome);
  if (!outcomeName) return false;
  return competitorNamePool(competitor).includes(outcomeName);
}

function matchEvent(
  outcomes: [string, string],
  events: EspnEvent[],
): { event: EspnEvent; teamA: EspnCompetitor; teamB: EspnCompetitor } | undefined {
  for (const event of events) {
    const competitors = event.competitions?.[0]?.competitors ?? [];
    if (competitors.length < 2) continue;

    const outcome1Index = competitors.findIndex((c) => isSameName(outcomes[0], c));
    const outcome2Index = competitors.findIndex(
      (c, idx) => idx !== outcome1Index && isSameName(outcomes[1], c),
    );
    if (outcome1Index < 0 || outcome2Index < 0) continue;

    return {
      event,
      teamA: competitors[outcome1Index],
      teamB: competitors[outcome2Index],
    };
  }

  return undefined;
}

async function fetchMarketBySlug(slug: string): Promise<GammaMarket | undefined> {
  const response = await fetch(
    `${config.gammaBaseUrl}/markets?slug=${encodeURIComponent(slug)}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch Gamma market "${slug}" (${response.status})`);
  }
  const markets = (await response.json()) as GammaMarket[];
  return markets.find((market) => (market.slug ?? "").toLowerCase() === slug);
}

function parseOutcomes(raw?: string): [string, string] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    return [String(parsed[0]), String(parsed[1])];
  } catch {
    return undefined;
  }
}

export async function fetchScoresByMarketSlugs(
  marketSlugs: string[],
): Promise<MarketScoreRow[]> {
  const queries: ScoreQuery[] = [];

  for (const marketSlug of marketSlugs) {
    const market = await fetchMarketBySlug(marketSlug);
    if (!market) {
      queries.push({
        marketSlug,
        marketQuestion: "Market not found",
        outcomes: ["-", "-"],
        route: { sport: "-", league: "-" },
        date: "-",
      });
      continue;
    }

    const outcomes = parseOutcomes(market.outcomes);
    const route = routeForSlug(marketSlug);
    if (!outcomes || !route) {
      queries.push({
        marketSlug,
        marketQuestion: market.question ?? "-",
        outcomes: outcomes ?? ["-", "-"],
        route: route ?? { sport: "-", league: "-" },
        date: "-",
      });
      continue;
    }

    queries.push({
      marketSlug,
      marketQuestion: market.question ?? "-",
      outcomes,
      route,
      date: toDateFromSlug(marketSlug),
    });
  }

  const rows: MarketScoreRow[] = [];
  const cache = new Map<string, EspnEvent[]>();

  for (const query of queries) {
    if (query.route.sport === "-" || query.route.league === "-" || query.date === "-") {
      rows.push({
        marketSlug: query.marketSlug,
        marketQuestion: query.marketQuestion,
        team1: query.outcomes[0],
        score1: "-",
        team2: query.outcomes[1],
        score2: "-",
        status: "Unsupported slug for ESPN mapping",
        source: "N/A",
      });
      continue;
    }

    const key = `${query.route.sport}/${query.route.league}/${query.date}`;
    if (!cache.has(key)) {
      const url = `${ESPN_BASE_URL}/${query.route.sport}/${query.route.league}/scoreboard?dates=${query.date}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed ESPN scoreboard fetch (${response.status}) for ${key}`);
      }
      const payload = (await response.json()) as { events?: EspnEvent[] };
      cache.set(key, payload.events ?? []);
    }

    const events = cache.get(key) ?? [];
    const matched = matchEvent(query.outcomes, events);
    if (!matched) {
      rows.push({
        marketSlug: query.marketSlug,
        marketQuestion: query.marketQuestion,
        team1: query.outcomes[0],
        score1: "-",
        team2: query.outcomes[1],
        score2: "-",
        status: "No matching ESPN event",
        source: `ESPN ${query.route.league}`,
      });
      continue;
    }

    const status =
      matched.event.status?.type?.shortDetail ??
      matched.event.status?.type?.detail ??
      matched.event.status?.type?.description ??
      "-";

    rows.push({
      marketSlug: query.marketSlug,
      marketQuestion: query.marketQuestion,
      team1: query.outcomes[0],
      score1: matched.teamA.score ?? "-",
      team2: query.outcomes[1],
      score2: matched.teamB.score ?? "-",
      status,
      source: `ESPN ${query.route.league}`,
    });
  }

  return rows;
}
