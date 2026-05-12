# price_fetch (Polymarket sports prices + hotkey trading)

Small TypeScript tooling to follow **Polymarket** sports markets: live **order-book style** prices (best bid / ask) for **two-outcome CLOB markets** (shown in the CLI as UP/DOWN from the first and second outcome, often Yes/No), with optional in-process **CLOB v2** trading driven by keyboard hotkeys.

Sports coverage depends on what Polymarket lists (tennis, basketball, football, soccer, and so on). The app does not call Polymarket “sports odds” APIs separately; it uses **Gamma** (market metadata) plus the **CLOB market WebSocket** for token prices.

## What is included

| Piece | Role |
|--------|------|
| `npm run dev` (`src/server.ts`) | Real-time prices + interactive hotkey trading on the focused market |
| `npm run dev:watch` | Same, but with `tsx watch` (hotkeys disabled — restarts break raw stdin) |
| `npm run score` (`src/score.ts`) | Optional **ESPN** scoreboard lines matched to a **market** slug |
| `src/polymarketService.ts` | Gamma fetch, WebSocket lifecycle, refresh loop |
| `src/polymarketTradeService.ts` | CLOB **v2** client wrapper — limit BUY, market SELL all, cancel all |
| `src/gammaSports.ts` | Resolve **event** slugs to child **market** slugs; `--soccer-matches` discovery |
| `src/espnScoreService.ts` | Map market slug prefix → ESPN route and pull scores |

## Requirements

- Node.js 18+ (project uses Node 22 in dev; adjust if needed)
- Network access to `gamma-api.polymarket.com`, `ws-subscriptions-clob.polymarket.com`, and `clob.polymarket.com`
- A funded Polymarket wallet (proxy / Safe / EOA / 1271) if you want to trade. CLOB **V2** went live April 28 2026 and uses **pUSD** as collateral; legacy V1 SDK orders no longer match.

## Setup

```bash
npm install
cp .env.sample .env
# fill in MARKET_SLUG, SHARES, POLYMARKET_PRIVATE_KEY, POLYMARKET_FUNDER_ADDRESS
```

## Polymarket slugs (important)

- **Market slug**: a single tradable market (one row on Polymarket). Example: `ucl-…-2026-05-05-ars`.
- **Event slug**: the parent match or card (e.g. `ucl-…-2026-05-05`). Gamma’s `/markets?slug=` does **not** return the parent; this project **expands** event slugs by loading `/events?slug=` and subscribing to each **active** binary child market.

Slugs are easiest to copy from the Polymarket URL path after `/event/` or from the market page.

## Live prices + trading

Always pass script arguments **after** `--` when using `npm run`, so they reach Node and not npm:

```bash
npm run dev -- --market-slug <slug>
npm run dev -- <slug>[,<slug2>...]          # positional slugs
npm run dev -- --soccer-matches             # discover soccer fixture lines (capped by MAX_MARKETS)
```

Examples:

```bash
npm run dev -- --market-slug nba-lal-bos-2026-01-15-lal
npm run dev -- atp-example-slug-2026-01-01
npm run dev -- ucl-ars-atm1-2026-05-05      # event slug → all linked binary markets
```

### Hotkeys (CLOB v2)

When `POLYMARKET_PRIVATE_KEY` and `POLYMARKET_FUNDER_ADDRESS` are set, the CLI accepts the following keys while `npm run dev` is running. `1` / `2` / `7` / `8` act on the **active market** — marked with `>` in the price table — using the **current best bid/ask** in the snapshot:

| Key | Action |
|-----|--------|
| `1` | Limit BUY **YES** at current best ask on the **active market**, size = `SHARES` env (GTC) |
| `2` | Limit BUY **NO**  at current best ask on the **active market**, size = `SHARES` env (GTC) |
| `7` | Market SELL **all YES** on the active market (FAK) — uses on-chain CTF balance via `getBalanceAllowance` |
| `8` | Market SELL **all NO**  on the active market (FAK) |
| `0` | `cancelAll()` — cancel **every** open order on your account, across all markets |
| `[` / `]` | Cycle the active market backward / forward through the tracked list |
| `a`, `b`, `c`, … | Jump directly to that market row (each row is labeled `[a]`, `[b]`, `[c]`, …) |
| `r` | Refresh on-chain positions immediately |
| `q` / `Ctrl+C` | Quit |

**3-way / soccer markets:** A soccer fixture like `spl-kho-okh-2026-05-12` lists three sibling **binary** CLOB markets — one per outcome (`-kho`, `-draw`, `-okh`). Pass the event slug (or all three child slugs) and the bot tracks them as separate rows. Use `[` / `]` (or `a` / `b` / `c`) to make the side you want to trade the **active** row, then `1` / `2` / `7` / `8` as usual. Each market keeps its own session ledger, so switching rows does not wipe pending lots, and the `Position` block lists holdings across **every** tracked market simultaneously.

Notes:

- `SHARES` is read once at startup. Change the value in `.env` and **restart** the dev process to pick it up.
- BUY orders are **resting limits** at the live best ask. If the ask moves up before you fill, the order rests on the book — press `0` to clear it.
- **Session position & PNL:** After each buy that fills (or matches and is queued for settlement), the console shows a **Session position** block with share count, **weighted average entry** (multiple `1` / `2` presses combine), **mark** price (mid of best bid/ask when both exist, else last trade, else one side), and **unrealized PNL** in USD, e.g. `PNL: + 2.00` (green) / `PNL: - 2.00` (red). The block stays visible until you **sell all** (`7` / `8`) for that side.
- **Position block (Polymarket-driven):** A unified `--- Position (YES = UP / NO = DOWN, polymarket ~Ns ago) ---` block reads the **public Polymarket Data API** (`https://data-api.polymarket.com/positions?user=<funder>&market=<conditionId>`). It returns **shares + weighted average entry** for each side you actually hold — regardless of whether the buy was made via this app, an earlier session, or directly on Polymarket. The block survives restarts and **doesn't disappear when one side is sold** (e.g. selling all NO leaves the YES line + its PNL intact). Auto-polled every ~7s; press **`r`** for an instant refresh. While the API hasn't picked up a fresh fill yet, the in-session ledger is shown with a `[pending]` tag so you still see the just-entered lot until the API catches up.
- **Order status semantics:**
  - `live` / `open` / `pending` → the order is **resting on the order book**. Nothing is added to the ledger until a fill is reported. `0` (cancel all) **will** cancel it.
  - `matched` / `delayed` / `filled` / `complete` → the order **already matched** at the exchange and (for `delayed`) is awaiting on-chain settlement. The ledger is updated immediately. `0` **cannot** unwind these — use `7` / `8` to sell the resulting position.
- **Minimum order size:** Polymarket rejects orders below **$1 notional** (price × shares). The CLI enforces this **before** sending: e.g. `BUY 10 sh @ 0.030` ($0.30) prints a loud `!!! ORDER REJECTED LOCALLY !!!` banner and the status line shows `BUY ... BLOCKED: Order too small …`. Bump `SHARES` (or override `MIN_ORDER_USD`) so `price × shares ≥ $1`.
- `7`/`8` exit your on-chain position for that outcome and shrink the session ledger by the sold size. The price hint passed to the FAK is the current best bid; any unfilled portion is auto-cancelled.
- Hotkeys only work in `npm run dev` (no watch). `npm run dev:watch` restarts the script on save, which tears down raw stdin and would orphan keypresses.
- Trading is **disabled** automatically if either `POLYMARKET_PRIVATE_KEY` or `POLYMARKET_FUNDER_ADDRESS` is empty; the price stream still runs.
- Event slugs (multi-market) work end-to-end: every active child market shows as its own row, the row prefixed `>` is the active one, and `[` / `]` / `a` / `b` / `c` switch which one `1` / `2` / `7` / `8` operate on.

### Scores (ESPN), market slug only

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
| `SHARES` | Fixed share count used by hotkeys `1` / `2`. Restart required to change. |
| `MIN_ORDER_USD` | Polymarket-enforced minimum order notional. Defaults to `1`. Orders below this (price × shares) are blocked locally before any network call. |
| `POLYMARKET_PRIVATE_KEY` | EOA private key used to sign CLOB orders. **Never commit.** |
| `POLYMARKET_FUNDER_ADDRESS` | The proxy / Safe / deposit wallet address that holds your pUSD + positions. |
| `POLYMARKET_CLOB_HOST` | Defaults to `https://clob.polymarket.com` (CLOB v2 production). |
| `POLYMARKET_RPC_URL` | Polygon RPC used by viem to derive accounts. Defaults to `https://polygon-rpc.com`. |
| `POLYMARKET_SIGNATURE_TYPE` | `0`=EOA, `1`=POLY_PROXY, `2`=POLY_GNOSIS_SAFE, `3`=POLY_1271. Match this to your wallet type. |

## Build

```bash
npm run build
npm start   # runs compiled dist/server.js — still needs CLI args; use node dist/server.js -- ...
```

## License

Private project (`"private": true` in `package.json`); add a license file if you open-source it.
