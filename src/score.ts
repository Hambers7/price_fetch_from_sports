import { fetchScoresByMarketSlugs } from "./espnScoreService";

type CliOptions = {
  marketSlugs: string[];
  intervalMs: number;
};

function parseCliArgs(defaultIntervalMs = 1000): CliOptions {
  const args = process.argv.slice(2);
  const slugs: string[] = [];
  let intervalMs = defaultIntervalMs;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith("--interval-ms=")) {
      const raw = arg.slice("--interval-ms=".length).trim();
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        intervalMs = Math.floor(parsed);
      }
      continue;
    }

    if (arg === "--interval-ms") {
      const raw = args[i + 1]?.trim();
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        intervalMs = Math.floor(parsed);
      }
      i += 1;
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
    intervalMs,
  };
}

async function main(): Promise<void> {
  const { marketSlugs, intervalMs } = parseCliArgs();
  if (marketSlugs.length === 0) {
    console.error(
      "Missing market slugs. Run: yarn run score --market-slug <slug> [--market-slug <slug>]",
    );
    process.exit(1);
  }
  let isRunning = false;
  let tickCount = 0;

  const renderOnce = async (): Promise<void> => {
    if (isRunning) return;
    isRunning = true;
    try {
      const rows = await fetchScoresByMarketSlugs(marketSlugs);
      tickCount += 1;

      console.clear();
      // console.log(
      //   `ESPN live scores | markets=${rows.length} | refresh=${intervalMs}ms | updates=${tickCount} | at=${new Date().toLocaleTimeString("en-US", { hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
      // );
      const maxLength = Math.max(rows[0].team1.length, rows[0].team2.length);
      console.log(`${rows[0].marketSlug} => ${rows[0].team1.padEnd(maxLength)} => ${rows[0].score1}`);
      console.log(`${rows[0].marketSlug} => ${rows[0].team2.padEnd(maxLength)} => ${rows[0].score2}`);
      // console.table(
      //   rows.flatMap((row) => [
      //     {
      //       Market: row.marketSlug,
      //       Team: row.team1,
      //       Scores: row.score1,
      //     },
      //     {
      //       Market: row.marketSlug,
      //       Team: row.team2,
      //       Scores: row.score2,
      //     },
      //   ]),
      // );
    } catch (err) {
      console.error("Failed to refresh ESPN scores:", err);
    } finally {
      isRunning = false;
    }
  };

  await renderOnce();
  const timer = setInterval(() => {
    void renderOnce();
  }, intervalMs);

  process.on("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to fetch ESPN scores:", err);
  process.exit(1);
});
