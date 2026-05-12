export type GammaMarketEvent = {
  score?: string;
  period?: string;
  elapsed?: string;
  live?: boolean;
  status?: string;
  homeTeam?: string;
  awayTeam?: string;
};

export type GammaEventTag = {
  id?: string;
  slug?: string;
  label?: string;
};

export type GammaMarket = {
  question?: string;
  slug?: string;
  conditionId?: string;
  active?: boolean;
  closed?: boolean;
  negRisk?: boolean;
  /** Gamma returns this as a number (e.g. 0.01) but older payloads have used a string. */
  orderPriceMinTickSize?: number | string;
  tags?: string[];
  clobTokenIds?: string; // JSON encoded array
  outcomes?: string; // JSON encoded array
  events?: GammaMarketEvent[];
};

export type GammaEvent = {
  slug?: string;
  ticker?: string;
  title?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  markets?: GammaMarket[];
  tags?: GammaEventTag[];
};

export type TrackedToken = {
  assetId: string;
  sideAlias: "UP" | "DOWN";
  outcomeLabel: string;
};

export type TickSize = "0.1" | "0.01" | "0.001" | "0.0001";

export type TrackedMarket = {
  marketQuestion: string;
  marketSlug: string;
  conditionId: string;
  negRisk: boolean;
  tickSize: TickSize;
  tokens: TrackedToken[];
};

export type TokenPriceState = {
  marketSlug: string;
  marketQuestion: string;
  sideAlias: "UP" | "DOWN";
  outcomeLabel: string;
  bestBid?: string;
  bestAsk?: string;
  spread?: string;
  lastTradePrice?: string;
  lastTradeSide?: string;
  lastTradeSize?: string;
  updatedAt: number;
};
