/** One outcome leg: shares held and total entry cost (USD, price × shares). */
export type SideLeg = {
  shares: number;
  cost: number;
};

export function emptyLeg(): SideLeg {
  return { shares: 0, cost: 0 };
}

export function addPurchase(
  leg: SideLeg,
  shares: number,
  pricePerShare: number,
): void {
  if (shares <= 0 || !Number.isFinite(pricePerShare) || pricePerShare <= 0) return;
  leg.shares += shares;
  leg.cost += shares * pricePerShare;
}

/** Remove `soldShares` at average cost (proportional cost basis). */
export function reduceOnSell(leg: SideLeg, soldShares: number): void {
  if (soldShares <= 0 || leg.shares <= 0) return;
  const sold = Math.min(soldShares, leg.shares);
  const avg = leg.shares > 0 ? leg.cost / leg.shares : 0;
  leg.cost -= sold * avg;
  leg.shares -= sold;
  if (leg.shares < 1e-8) {
    leg.shares = 0;
    leg.cost = 0;
  }
}

export function avgEntry(leg: SideLeg): number {
  return leg.shares > 0 ? leg.cost / leg.shares : 0;
}

/** Unrealized P&L in USD: (mark − avg) × shares. */
export function unrealizedPnlUsd(leg: SideLeg, markPerShare: number): number {
  if (leg.shares <= 0 || !Number.isFinite(markPerShare)) return 0;
  return (markPerShare - avgEntry(leg)) * leg.shares;
}

/** ANSI SGR — works in VS Code, Windows Terminal, Git Bash, most modern consoles. */
const SGR = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
} as const;

export type FormatPnlLineOptions = {
  /** When false, never emit color codes. Default: `process.stdout.isTTY`. */
  color?: boolean;
};

/** e.g. `PNL: + 2.00` / `PNL: - 2.00` (green if profit, red if loss, when TTY). */
export function formatPnlLine(
  pnl: number,
  options?: FormatPnlLineOptions,
): string {
  const sign = pnl >= 0 ? "+" : "-";
  const v = Math.abs(pnl).toFixed(2);
  const text = `PNL: ${sign} ${v}`;
  const useColor =
    options?.color ?? (typeof process !== "undefined" && process.stdout?.isTTY);
  if (!useColor || pnl === 0) return text;
  const open = pnl > 0 ? SGR.green : SGR.red;
  return `${open}${text}${SGR.reset}`;
}

export function midMark(
  bid: number | null,
  ask: number | null,
): number | null {
  const b = bid != null && Number.isFinite(bid) && bid > 0 ? bid : null;
  const a = ask != null && Number.isFinite(ask) && ask > 0 ? ask : null;
  if (b != null && a != null) return (b + a) / 2;
  if (b != null) return b;
  if (a != null) return a;
  return null;
}
