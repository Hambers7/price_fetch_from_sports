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
npm run dev -- --btc-5m                     # auto-track the *current* BTC up/down 5m window; rotates as it closes
npm run dev -- --btc-5m --btc-5m-count=3    # also pre-track next 2 windows (15min of forward visibility)
```

Examples:

```bash
npm run dev -- --market-slug nba-lal-bos-2026-01-15-lal
npm run dev -- atp-example-slug-2026-01-01
npm run dev -- ucl-ars-atm1-2026-05-05      # event slug → all linked binary markets
npm run dev -- --btc-5m                     # crypto: BTC 5-minute up/down (binary, YES=Up / NO=Down)
```

### Crypto: BTC 5-minute up/down (`--btc-5m`)

Polymarket lists short binary markets that resolve every 5 minutes based on Chainlink BTC/USD: each one is a separate slug like `btc-updown-5m-<unix-window-start>`, where `<unix-window-start>` is the start of an aligned 5-minute window (e.g. `btc-updown-5m-1778660400` = the 4:20–4:25 ET window). Outcomes are `["Up", "Down"]` so they slot into the existing UP/DOWN price table and trading hotkeys with no extra changes.

`--btc-5m` automates the slug bookkeeping:

- **Default = current window only (count=1).** As soon as that window closes, the bot refreshes within ~3 seconds of the boundary and the next window slides into the same `[a]` row. You always see exactly one BTC 5m market trading live, no manual restart, no slug typing.
- **Boundary-aware refresh.** Instead of polling every N seconds, the service computes the time until the next 5-minute boundary and schedules a refresh ~3s after it. So you get one targeted re-fetch per window rotation rather than 5–10 wasted polls. The 60s periodic interval still applies as a safety cap mid-window.
- **Override with `--btc-5m-count=N`** to also pre-track the next `N-1` upcoming windows (e.g. `--btc-5m-count=3` shows current + next 2). Polymarket pre-lists windows ~8 hours in advance, so any reasonable `N` works.
- Header shows `mode=BTC-5m`. With `count>1`, each market gets its own row, its own `[a]`/`[b]`/`[c]` selector, its own session ledger, and its own line in the `Position` block.
- Trading is identical to sports: `1` = BUY YES (Up), `2` = BUY NO (Down), `7` / `8` = SELL ALL on the active market, `0` = cancel all open orders, `[` / `]` or `a`-`z` to switch which window is active.

#### Live BTC + target reference (synchronized with Polymarket resolution)

Each `btc-updown-*` row gets an extra line under the bid/ask block:

```text
> [a] btc-updown-5m-1778662200 => Buy      => 100.0c     => 1.0c
> [a] btc-updown-5m-1778662200 => Sell     => 99.0c      => 0.0c
> [a] BTC $81,138.82 (Coinbase) | target $81,106.25 @ 08:50 UTC | Δ +$32.57 (+0.040%) → UP wins | closes in 0:14
```

- **Live BTC** comes from the Coinbase Exchange public WebSocket (`ticker` channel for `BTC-USD`). Updates multiple times per second, no API key.
- **Target** is the open price of the 1-minute Coinbase candle at the window's start unix — i.e. the BTC price at the exact moment the window began. Fetched lazily from `/products/BTC-USD/candles?granularity=60` on first render and cached per window.
- **Δ** = `live − target`. Positive (green) ⇒ BTC has moved up since the window started, "Up" is winning. Negative (red) ⇒ "Down" is winning. The order-book pricing should track this delta closely.
- **Closes in M:SS** counts down to window resolution. A 1Hz heartbeat keeps the countdown smooth even when no Polymarket / Coinbase WS message arrives in that second.

Why Coinbase? Polymarket resolves these markets against the **Chainlink BTC/USD data stream**, which aggregates several CEX feeds (Coinbase, Binance, Kraken, …). Coinbase Spot is one of those contributors and is publicly streamable, so its price tracks Chainlink within ~$1 in normal conditions — close enough that the directional signal (Up vs Down) matches the resolution outcome 99.9%+ of the time. There is no public Chainlink Data Stream feed without an API key, so this is the most accurate free proxy.

If Coinbase's candle hasn't been indexed yet (can briefly happen in the first few seconds after a window boundary), the line shows `target fetching…` and retries every 5 seconds until the candle appears.

#### Caveats

- A 5-minute window resolves at its `endDate`. If you press `1` / `2` only seconds before resolution, the order may not have time to fill. With `count=1` you're always trading the live window, so practical advice is to use the early-to-mid portion of each window. Keep `MIN_ORDER_USD` in mind — `SHARES × price ≥ $1`.
- The Δ line tells you what the market **should** be priced at given the BTC move, but it doesn't predict where BTC will be at the **end** of the window — the resolution is decided by the price at the window's `endDate`, not now. Use it for situational awareness, not as a guaranteed signal.

The slug helper in `src/cryptoUpDown.ts` is generic — adding `--eth-5m`, `--btc-15m`, etc. is a one-line CLI change.

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
