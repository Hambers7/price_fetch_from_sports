/**
 * Helpers for Polymarket "<symbol>-updown-<duration>-<unix>" markets — short
 * binary CLOB markets where YES = "Up" and NO = "Down" over a fixed window.
 *
 * Currently used by `--btc-5m` mode in server.ts. The shape is generic so
 * additional symbols (eth, sol) and durations (1m, 15m, 1h) can be plugged in
 * without changing the realtime service.
 */

export type UpDownDuration = "5m" | "15m" | "1h";

export const UP_DOWN_WINDOW_SECONDS: Record<UpDownDuration, number> = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
};

/** Symbol of the underlying as it appears in the slug (lower-case). */
export type UpDownSymbol = string;

export type UpDownConfig = {
  symbol: UpDownSymbol;
  duration: UpDownDuration;
  /** How many consecutive windows to keep tracked (current + next N-1). */
  count: number;
};

/**
 * Unix timestamp (seconds) of the **current** aligned window start.
 * E.g. for "5m" at 12:07:34 returns 12:05:00 unix.
 */
export function alignedWindowStartUnix(
  duration: UpDownDuration,
  nowMs: number = Date.now(),
): number {
  const windowSec = UP_DOWN_WINDOW_SECONDS[duration];
  const nowSec = Math.floor(nowMs / 1000);
  return Math.floor(nowSec / windowSec) * windowSec;
}

/**
 * Generate the next `count` Polymarket up/down slugs starting from the current
 * aligned window. e.g. `buildUpDownSlugs("btc", "5m", 3)` →
 * `["btc-updown-5m-<currentStart>", "btc-updown-5m-<currentStart+300>", ...]`.
 *
 * Caller is responsible for fetching them via Gamma; some far-future windows
 * may not yet be listed (Polymarket pre-lists ~8h of 5m windows).
 */
export function buildUpDownSlugs(
  config: UpDownConfig,
  nowMs: number = Date.now(),
): string[] {
  if (config.count <= 0) return [];
  const sym = config.symbol.trim().toLowerCase();
  if (!sym) return [];
  const windowSec = UP_DOWN_WINDOW_SECONDS[config.duration];
  const start = alignedWindowStartUnix(config.duration, nowMs);
  const slugs: string[] = [];
  for (let i = 0; i < config.count; i += 1) {
    slugs.push(`${sym}-updown-${config.duration}-${start + i * windowSec}`);
  }
  return slugs;
}
