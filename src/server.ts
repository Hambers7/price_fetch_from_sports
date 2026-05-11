import { PolymarketRealtimeService } from "./polymarketService";

type ServerCli = {
  marketSlugs: string[];
  discoverSoccerMatches: boolean;
};

function parseServerCli(): ServerCli {
  const args = process.argv.slice(2);
  const slugs: string[] = [];
  let discoverSoccerMatches = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === "--soccer-matches") {
      discoverSoccerMatches = true;
      continue;
    }

    if (arg.startsWith("--soccer-matches=")) {
      const raw = arg.slice("--soccer-matches=".length).trim().toLowerCase();
      discoverSoccerMatches =
        raw === "" || raw === "1" || raw === "true" || raw === "yes";
      continue;
    }

    if (arg.startsWith("--market-slug=")) {
      const value = arg.slice("--market-slug=".length).trim();
      if (value) slugs.push(value);
      continue;
    }

    if (arg === "--market-slug" && args[i + 1]) {
      const value = args[i + 1].trim();
      if (value) slugs.push(value);
      i += 1;
      continue;
    }

    if (!arg.startsWith("--")) {
      const values = arg
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      slugs.push(...values);
    }
  }

  return {
    marketSlugs: Array.from(new Set(slugs.map((slug) => slug.toLowerCase()))),
    discoverSoccerMatches,
  };
}

const { marketSlugs, discoverSoccerMatches } = parseServerCli();

const service = new PolymarketRealtimeService({
  marketSlugs,
  discoverSoccerMatches,
});

async function main(): Promise<void> {
  if (!discoverSoccerMatches && marketSlugs.length === 0) {
    console.error(
      'Missing input. Use "--market-slug <slug>" or positional slug(s). Event slugs (e.g. ucl-...) expand to all match markets. Or pass --soccer-matches to discover active soccer fixtures.',
    );
    process.exit(1);
  }

  let renderScheduled = false;
  let updateCount = 0;

  const renderTable = (): void => {
    const snapshot = service.getSnapshot();
    const prices = Object.values(snapshot.prices);
    if (prices.length === 0) return;

    const formatCents = (value?: string): string => {
      const n = Number(value);
      return Number.isFinite(n) ? `${(n * 100).toFixed(1)}c` : "-";
    };

    console.clear();
    console.log(
      `Polymarket live prices | ${snapshot.marketCount} market(s), ${snapshot.tokenCount} token(s) | updates=${updateCount} | at=${new Date().toLocaleTimeString("en-US", { hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
    );

    const slugsOrdered = [
      ...new Set(snapshot.markets.map((m) => m.marketSlug)),
    ];
    for (const marketSlug of slugsOrdered) {
      const marketPrices = prices.filter((p) => p.marketSlug === marketSlug);
      if (marketPrices.length === 0) continue;

      const up = marketPrices.find((p) => p.sideAlias === "UP");
      const down = marketPrices.find((p) => p.sideAlias === "DOWN");
      const latestMs = Math.max(...marketPrices.map((p) => p.updatedAt));

      const question =
        snapshot.markets.find((m) => m.marketSlug === marketSlug)
          ?.marketQuestion ?? "-";

      const upHeader = `UP(${up?.outcomeLabel ?? "-"})`;
      const downHeader = `DOWN(${down?.outcomeLabel ?? "-"})`;
      const rows = [
        {
          Market: marketSlug,
          "Buy/Sell": "Buyy",
          [upHeader]: formatCents(up?.bestAsk),
          [downHeader]: formatCents(down?.bestAsk),
        },
        {
          Market: marketSlug,
          "Buy/Sell": "Sell",
          [upHeader]: formatCents(up?.bestBid),
          [downHeader]: formatCents(down?.bestBid),
        },
      ];
      const maxLength = Math.max(upHeader.length, downHeader.length);
      console.log(`${marketSlug} => Buy/Sell => ${upHeader.padEnd(maxLength)} => ${downHeader.padEnd(maxLength)}`);
      console.log(`${rows[0].Market} => ${rows[0]["Buy/Sell"].padEnd(8)} => ${rows[0][upHeader].padEnd(maxLength)} => ${rows[0][downHeader].padEnd(maxLength)}`);
      console.log(`${rows[1].Market} => ${rows[1]["Buy/Sell"].padEnd(8)} => ${rows[1][upHeader].padEnd(maxLength)} => ${rows[1][downHeader].padEnd(maxLength)}`);
    }
  };

  const scheduleRender = (): void => {
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      renderTable();
    }, 100);
  };

  service.onPriceUpdate(() => {
    updateCount += 1;
    scheduleRender();
  });

  await service.start();
  console.log("Polymarket real-time up/down price stream started.");
  renderTable();
}

main().catch((err) => {
  console.error("Failed to start realtime stream:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  service.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  service.stop();
  process.exit(0);
});
