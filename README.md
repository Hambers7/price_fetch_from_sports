# price_fetch (Polymarket sports prices)

Small TypeScript tooling to follow **Polymarket** sports markets: live **order-book style** prices (best bid / ask) for **two-outcome CLOB markets** (shown in the CLI as UP/DOWN from the first and second outcome, often Yes/No).

Sports coverage depends on what Polymarket lists (tennis, basketball, football, soccer, and so on). The app does not call Polymarket “sports odds” APIs separately; it uses **Gamma** (market metadata) plus the **CLOB market WebSocket** for token prices.

## What is included

| Piece | Role |
|--------|------|
| `npm run dev` (`src/server.ts`) | Real-time prices for one or more slugs, optional **soccer match discovery**, WebSocket subscription, terminal UI |
| `npm run score` (`src/score.ts`) | Optional **ESPN** scoreboard lines matched to a **market** slug (separate from prices; limited slug prefixes) |
| `src/polymarketService.ts` | Gamma fetch, WebSocket lifecycle, refresh loop |
| `src/gammaSports.ts` | Resolve **event** slugs to child **market** slugs; `--soccer-matches` discovery |
| `src/espnScoreService.ts` | Map market slug prefix → ESPN route and pull scores |

## Requirements

- Node.js 18+ (project uses Node 22 in dev; adjust if needed)
- Network access to `gamma-api.polymarket.com` and `ws-subscriptions-clob.polymarket.com`

## Setup

```bash
npm install
cp .env.sample .env
# edit .env if you change URLs, caps, or refresh interval
```

## Polymarket slugs (important)

- **Market slug**: the identifier for a single tradable market (one row on Polymarket). Example: `ucl-…-2026-05-05-ars`.
- **Event slug**: the parent match or card (e.g. `ucl-…-2026-05-05`). Gamma’s `/markets?slug=` does **not** return the parent; this project **expands** event slugs by loading `/events?slug=` and subscribing to each **active** binary child market.

Slugs are easiest to copy from the Polymarket URL path after `/event/` or from the market page.

## Commands

Always pass script arguments **after** `--` when using `npm run`, so they reach Node and not npm:

```bash
npm run dev -- --market-slug <slug>
npm run dev -- <slug>[,<slug2>...]          # positional slugs
npm run dev -- --soccer-matches             # discover soccer fixture lines (capped by MAX_MARKETS)
```

Examples:

```bash
npm run dev -- atp-example-slug-2026-01-01
npm run dev -- --market-slug nba-lal-bos-2026-01-15-lal
npm run dev -- ucl-ars-atm1-2026-05-05      # event slug → all linked binary markets
```

Scores (ESPN), **market slug only** (no event expansion in this script today):

```bash
npm run score -- --market-slug atp-example-slug-2026-01-01
npm run score -- --market-slug nba-... --interval-ms 2000
```

Supported **prefix → ESPN** mappings today: `nba`, `nfl`, `mlb`, `nhl`, `ncaaf`, `ncaab`, `atp`, `wta`. Other sports (e.g. many soccer slugs) are not wired to ESPN in `espnScoreService.ts`.

## Environment variables

See `.env.sample`. Notable values:

| Variable | Purpose |
|----------|---------|
| `GAMMA_BASE_URL` | Gamma API base (default production) |
| `MARKET_WS_URL` | CLOB market WebSocket URL |
| `MAX_MARKETS` | Cap on how many **markets** to track (each has 2 tokens) |
| `REFRESH_MARKETS_MS` | How often to refresh Gamma metadata and reconnect if needed |
| `DISCOVER_EVENTS_PAGE_SIZE` / `DISCOVER_MAX_PAGES` | Pagination for `--soccer-matches` |
| `UPDOWN_MARKET_SYMBOL` | Used only by library-style flows that build dynamic 15m up/down slugs (not required for typical `server.ts` slug usage) |

## Build

```bash
npm run build
npm start   # runs compiled dist/server.js — still needs CLI args; use node dist/server.js -- ...
```

## License

Private project (`"private": true` in `package.json`); add a license file if you open-source it.
