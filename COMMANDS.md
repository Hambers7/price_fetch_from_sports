# Market Price Fetch Commands

This project provides two main runtime commands:

- Real-time Polymarket price stream
- Real-time ESPN score table by market slug

## Install

```bash
yarn install
```

## Price Stream Command

Runs the Polymarket up/down price stream.

```bash
yarn run dev --market-slug <market-slug>
```

Examples:

```bash
yarn run dev --market-slug atp-cilic-altmaie-2026-04-13
yarn run dev --market-slug nba-por-phx-2026-04-14
```

You can also pass multiple slugs as positional values:

```bash
yarn run dev nba-por-phx-2026-04-14,atp-cilic-altmaie-2026-04-13
```

## ESPN Score Command

Runs a live-refresh score table from ESPN endpoints and maps scores to the provided market slug(s).

```bash
yarn run score --market-slug <market-slug>
```

Examples:

```bash
yarn run score --market-slug nba-por-phx-2026-04-14
yarn run score --market-slug atp-cilic-altmaie-2026-04-13
```

Multiple slugs:

```bash
yarn run score --market-slug nba-por-phx-2026-04-14 --market-slug atp-cilic-altmaie-2026-04-13
```

Custom refresh interval (milliseconds):

```bash
yarn run score --market-slug nba-por-phx-2026-04-14 --interval-ms 1000
```

Default refresh interval is `1000ms`.

## Score Console Format

`yarn run score` prints one row per team using:

- `Market`
- `Team`
- `Scores`

For each market, you will see two rows (one for each team).

## Build and Start

Build:

```bash
yarn run build
```

Run built output:

```bash
yarn run start
```
