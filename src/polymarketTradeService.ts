import {
  AssetType,
  Chain,
  ClobClient,
  CONDITIONAL_TOKEN_DECIMALS,
  OrderType,
  Side,
  SignatureTypeV2,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tradeConfig } from "./config";
import { TickSize } from "./types";

/** Thrown when an order is rejected before any network call. */
export class TradeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TradeValidationError";
  }
}

const TOKEN_UNIT = 10 ** CONDITIONAL_TOKEN_DECIMALS;

export type MarketContext = {
  marketSlug: string;
  tickSize: TickSize;
  negRisk: boolean;
};

/** What to record in the local PNL ledger after a limit BUY post. */
export type LimitBuyResult = {
  ok: boolean;
  status?: string;
  errorMsg?: string;
  /** Shares to add at `ledgerPrice` (0 if order is resting with no fill yet). */
  ledgerShares: number;
  /** $/share for this ledger lot (limit price used). */
  ledgerPrice: number;
};

export type LimitBuyArgs = MarketContext & {
  tokenId: string;
  outcomeLabel: string;
  price: number;
  size: number;
};

export type MarketSellAllArgs = MarketContext & {
  tokenId: string;
  outcomeLabel: string;
  /** Optional price hint to bound slippage; pass best bid if available. */
  priceHint?: number;
};

/** Result of a market SELL-all (FAK): shares cleared vs response-derived fill. */
export type SellAllResult = {
  sharesSold: number;
  /** Best bid passed into the order as the price bound (UI ~sell at). */
  priceHint?: number;
  /** $/share from CLOB `takingAmount` / `makingAmount` when parseable (actual avg execution). */
  avgFillPrice: number | null;
};

/**
 * Lazy-initialised CLOB v2 trading client. The first call obtains/derives an
 * API key (L1 auth) using the configured wallet and then keeps an
 * L2-authenticated client cached for the rest of the process lifetime.
 */
export class PolymarketTradeService {
  private clientPromise: Promise<ClobClient> | null = null;
  private signerAddress: string | null = null;

  public async getSignerAddress(): Promise<string> {
    if (this.signerAddress) return this.signerAddress;
    await this.getClient();
    return this.signerAddress ?? "";
  }

  private async createClient(): Promise<ClobClient> {
    const pk = tradeConfig.privateKey;
    if (!pk || !pk.startsWith("0x")) {
      throw new Error(
        "POLYMARKET_PRIVATE_KEY is missing or not a 0x-prefixed hex key.",
      );
    }
    if (!tradeConfig.funderAddress) {
      throw new Error("POLYMARKET_FUNDER_ADDRESS is required for trading.");
    }

    const account = privateKeyToAccount(pk as `0x${string}`);
    this.signerAddress = account.address;

    const signer = createWalletClient({
      account,
      transport: http(tradeConfig.rpcUrl),
    });

    const tempClient = new ClobClient({
      host: tradeConfig.clobHost,
      chain: tradeConfig.chainId as Chain,
      signer,
    });

    const apiCreds = await tempClient.createOrDeriveApiKey();

    return new ClobClient({
      host: tradeConfig.clobHost,
      chain: tradeConfig.chainId as Chain,
      signer,
      creds: apiCreds,
      signatureType: tradeConfig.signatureType as SignatureTypeV2,
      funderAddress: tradeConfig.funderAddress,
    });
  }

  private async getClient(): Promise<ClobClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.createClient().catch((err) => {
        this.clientPromise = null;
        throw err;
      });
    }
    return this.clientPromise;
  }

  /** Resting limit BUY (GTC) at `price`, size in CTF shares. */
  public async limitBuy(args: LimitBuyArgs): Promise<LimitBuyResult> {
    if (!Number.isFinite(args.price) || args.price <= 0) {
      throw new TradeValidationError(`Invalid price for BUY: ${args.price}`);
    }
    if (!Number.isFinite(args.size) || args.size <= 0) {
      throw new TradeValidationError(`Invalid size for BUY: ${args.size}`);
    }

    const price = roundToTick(args.price, args.tickSize);
    const notional = price * args.size;
    const minNotional = tradeConfig.minOrderUsd;
    if (notional + 1e-9 < minNotional) {
      throw new TradeValidationError(
        `Order too small: $${notional.toFixed(2)} < $${minNotional.toFixed(2)} min. Increase SHARES (${args.size} sh @ ${price.toFixed(3)} ⇒ raise SHARES to at least ${Math.ceil(minNotional / price)}).`,
      );
    }

    const client = await this.getClient();

    console.log(
      `[trade] BUY  ${args.outcomeLabel} | market=${args.marketSlug} | size=${args.size} @ ${price} | notional=$${notional.toFixed(2)} | token=${args.tokenId}`,
    );

    const resp = await client.createAndPostOrder(
      {
        tokenID: args.tokenId,
        side: Side.BUY,
        price,
        size: args.size,
      },
      { tickSize: args.tickSize, negRisk: args.negRisk },
      OrderType.GTC,
    );

    logOrderResponse("BUY", resp);
    return parseLimitBuyLedgerImpact(resp, args.size, price);
  }

  /**
   * Market SELL (FAK) of the entire current CTF balance for `tokenId`.
   * Returns sold share count and, when the CLOB response includes amounts,
   * an approximate average fill price (can differ from the bid hint used as cap).
   */
  public async sellAll(args: MarketSellAllArgs): Promise<SellAllResult> {
    const client = await this.getClient();

    const balance = await client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: args.tokenId,
    });

    const shares = parseRawBalanceToShares(balance.balance);
    if (shares <= 0) {
      console.log(
        `[trade] SELL ${args.outcomeLabel} | nothing to sell (balance=0) | market=${args.marketSlug}`,
      );
      return { sharesSold: 0, avgFillPrice: null };
    }

    const sharesRounded = floorToSizeStep(shares);
    if (sharesRounded <= 0) {
      console.log(
        `[trade] SELL ${args.outcomeLabel} | balance dust (${shares}) below min size; skipping`,
      );
      return { sharesSold: 0, avgFillPrice: null };
    }

    const priceHint =
      args.priceHint && Number.isFinite(args.priceHint) && args.priceHint > 0
        ? roundToTick(args.priceHint, args.tickSize)
        : undefined;

    if (priceHint !== undefined) {
      const sellNotional = priceHint * sharesRounded;
      const minNotional = tradeConfig.minOrderUsd;
      if (sellNotional + 1e-9 < minNotional) {
        throw new TradeValidationError(
          `SELL too small: ${sharesRounded} sh × ~${priceHint.toFixed(3)} = $${sellNotional.toFixed(2)} < $${minNotional.toFixed(2)} min. Position is below Polymarket's minimum order size — wait for a higher bid or merge with another lot.`,
        );
      }
    }

    console.log(
      `[trade] SELL ${args.outcomeLabel} ALL | market=${args.marketSlug} | shares=${sharesRounded}${priceHint ? ` priceHint=${priceHint}` : ""} | token=${args.tokenId}`,
    );

    const resp = await client.createAndPostMarketOrder(
      {
        tokenID: args.tokenId,
        side: Side.SELL,
        amount: sharesRounded,
        ...(priceHint !== undefined ? { price: priceHint } : {}),
      },
      { tickSize: args.tickSize, negRisk: args.negRisk },
      OrderType.FAK,
    );

    logOrderResponse("SELL", resp);

    if (orderPostLooksFailed(resp)) {
      const msg = extractPostOrderError(resp);
      console.log(`[trade] SELL not filled / rejected: ${msg}`);
      return { sharesSold: 0, priceHint, avgFillPrice: null };
    }

    const avgFillPrice = parseMarketSellAvgFill(resp, priceHint);
    if (avgFillPrice != null) {
      const hintPart =
        priceHint != null
          ? ` (bid hint ${formatPriceCents(priceHint)})`
          : "";
      console.log(
        `[trade] SELL avg fill ≈ ${formatPriceCents(avgFillPrice)} $/sh${hintPart}`,
      );
    }

    return {
      sharesSold: sharesRounded,
      priceHint,
      avgFillPrice,
    };
  }

  /** Live on-chain CTF balance (in shares, 6-dec scaled) for one token. */
  public async getTokenBalance(tokenId: string): Promise<number> {
    const client = await this.getClient();
    const balance = await client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    return parseRawBalanceToShares(balance.balance);
  }

  public async cancelAll(): Promise<void> {
    const client = await this.getClient();
    console.log(`[trade] CANCEL ALL`);
    const resp = await client.cancelAll();
    if (resp && typeof resp === "object") {
      const canceled = Array.isArray((resp as any).canceled)
        ? (resp as any).canceled
        : [];
      const notCanceled = (resp as any).not_canceled ?? {};
      console.log(
        `[trade] cancelled=${canceled.length} not_cancelled=${
          Object.keys(notCanceled).length
        }`,
      );
    }
  }
}

/** Cents-style display for Polymarket $/share prices (e.g. 0.62 → 62.0c). */
function formatPriceCents(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return "—";
  return `${(price * 100).toFixed(1)}c`;
}

function orderPostLooksFailed(resp: unknown): boolean {
  if (!resp || typeof resp !== "object") return true;
  const r = resp as Record<string, unknown>;
  if (r.success === false) return true;
  if ("error" in r && r.error != null && r.error !== "") return true;
  const stRaw = r.status;
  const st =
    typeof stRaw === "number"
      ? String(stRaw)
      : String(stRaw ?? "").trim();
  if (/^(400|401|403|422)$/.test(st)) return true;
  return false;
}

function extractPostOrderError(resp: unknown): string {
  if (!resp || typeof resp !== "object") return "empty response";
  const r = resp as Record<string, unknown>;
  if (typeof r.errorMsg === "string" && r.errorMsg.trim() !== "")
    return r.errorMsg.trim();
  if ("error" in r && r.error != null && r.error !== "") {
    return typeof r.error === "string" ? r.error : JSON.stringify(r.error);
  }
  return String(r.status ?? "unknown");
}

/**
 * Infer $/share for a matched SELL from `takingAmount` / `makingAmount`
 * (ratio is scale-free when both use the same token decimals).
 */
function parseMarketSellAvgFill(
  resp: unknown,
  priceHint?: number,
): number | null {
  if (!resp || typeof resp !== "object") return null;
  const r = resp as Record<string, unknown>;
  const take = parseHumanAmount(r.takingAmount);
  const make = parseHumanAmount(r.makingAmount);
  if (!Number.isFinite(take) || !Number.isFinite(make) || take <= 0 || make <= 0)
    return null;

  const pTakeMake = take / make;
  const pMakeTake = make / take;

  const inBand = (x: number) =>
    Number.isFinite(x) && x > 1e-6 && x <= 1.0001 + 1e-6;

  const c1 = inBand(pTakeMake) ? pTakeMake : NaN;
  const c2 = inBand(pMakeTake) ? pMakeTake : NaN;

  if (Number.isFinite(c1) && !Number.isFinite(c2)) return c1;
  if (!Number.isFinite(c1) && Number.isFinite(c2)) return c2;
  if (Number.isFinite(c1) && Number.isFinite(c2)) {
    if (
      priceHint != null &&
      Number.isFinite(priceHint) &&
      priceHint > 1e-9
    ) {
      return Math.abs(c1 - priceHint) <= Math.abs(c2 - priceHint) ? c1 : c2;
    }
    return Math.min(c1, c2);
  }
  return null;
}

function roundToTick(value: number, tickSize: TickSize): number {
  const tick = Number(tickSize);
  if (!Number.isFinite(tick) || tick <= 0) return value;
  const rounded = Math.round(value / tick) * tick;
  const decimals = tickSize.includes(".")
    ? tickSize.length - tickSize.indexOf(".") - 1
    : 0;
  return Number(rounded.toFixed(decimals));
}

function floorToSizeStep(shares: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.floor(shares * factor) / factor;
}

function parseRawBalanceToShares(raw: string | undefined): number {
  if (!raw) return 0;
  const asBig = Number(raw);
  if (!Number.isFinite(asBig)) return 0;
  return asBig / TOKEN_UNIT;
}

function parseLimitBuyLedgerImpact(
  resp: unknown,
  requestedSize: number,
  limitPrice: number,
): LimitBuyResult {
  const fail = (errorMsg: string): LimitBuyResult => ({
    ok: false,
    ledgerShares: 0,
    ledgerPrice: limitPrice,
    errorMsg,
  });

  if (!resp || typeof resp !== "object") {
    return fail("empty order response");
  }

  const r = resp as Record<string, unknown>;

  if ("error" in r && r.error != null && r.error !== "") {
    const msg =
      typeof r.error === "string" ? r.error : JSON.stringify(r.error);
    return fail(msg);
  }

  if (r.success === false) {
    return fail(String(r.errorMsg ?? "order rejected"));
  }

  const statusRaw = r.status != null ? String(r.status) : "";
  const st = statusRaw.toLowerCase();

  // Truly resting on the book: not yet filled, can be cancelled with cancelAll().
  // NOTE: "delayed" / "matched" are NOT resting — they are matched trades waiting
  // for on-chain settlement, and cancelAll() will not unwind them.
  const isResting = st === "live" || st === "open" || st === "pending";

  if (isResting) {
    return {
      ok: true,
      status: statusRaw,
      ledgerShares: 0,
      ledgerPrice: limitPrice,
    };
  }

  // For matched / delayed / filled / complete (or any non-resting success),
  // prefer takingAmount when it represents a share count smaller than requested
  // (i.e. partial fill before the rest was killed). Otherwise assume full size.
  const taking = parseHumanAmount(r.takingAmount);
  const making = parseHumanAmount(r.makingAmount);
  let filled = requestedSize;
  if (
    Number.isFinite(taking) &&
    taking > 0 &&
    taking + 1e-9 < requestedSize
  ) {
    filled = taking;
  } else if (
    Number.isFinite(making) &&
    making > 0 &&
    making + 1e-9 < requestedSize &&
    making < 1e3
  ) {
    filled = making;
  }

  filled = Math.min(Math.max(filled, 0), requestedSize);
  if (filled <= 0) {
    return {
      ok: true,
      status: statusRaw,
      ledgerShares: 0,
      ledgerPrice: limitPrice,
    };
  }

  return {
    ok: true,
    status: statusRaw,
    ledgerShares: filled,
    ledgerPrice: limitPrice,
  };
}

function parseHumanAmount(v: unknown): number {
  if (v == null) return NaN;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : NaN;
}

function logOrderResponse(label: string, resp: unknown): void {
  if (!resp || typeof resp !== "object") {
    console.log(`[trade] ${label} resp:`, resp);
    return;
  }
  const r = resp as {
    success?: boolean;
    errorMsg?: string;
    orderID?: string;
    status?: string;
    takingAmount?: string;
    makingAmount?: string;
  };
  console.log(
    `[trade] ${label} success=${r.success ?? "?"} status=${r.status ?? "-"} orderID=${
      r.orderID ?? "-"
    } taking=${r.takingAmount ?? "-"} making=${r.makingAmount ?? "-"}${
      r.errorMsg ? ` error="${r.errorMsg}"` : ""
    }`,
  );
}
