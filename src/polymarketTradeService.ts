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

const TOKEN_UNIT = 10 ** CONDITIONAL_TOKEN_DECIMALS;

export type MarketContext = {
  marketSlug: string;
  tickSize: TickSize;
  negRisk: boolean;
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
  public async limitBuy(args: LimitBuyArgs): Promise<void> {
    if (!Number.isFinite(args.price) || args.price <= 0) {
      throw new Error(`Invalid price for BUY: ${args.price}`);
    }
    if (!Number.isFinite(args.size) || args.size <= 0) {
      throw new Error(`Invalid size for BUY: ${args.size}`);
    }

    const client = await this.getClient();

    const price = roundToTick(args.price, args.tickSize);

    console.log(
      `[trade] BUY  ${args.outcomeLabel} | market=${args.marketSlug} | size=${args.size} @ ${price} | token=${args.tokenId}`,
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
  }

  /**
   * Market SELL (FAK) of the entire current CTF balance for `tokenId`.
   * Returns the share count we attempted to sell, or 0 if no balance.
   */
  public async sellAll(args: MarketSellAllArgs): Promise<number> {
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
      return 0;
    }

    const sharesRounded = floorToSizeStep(shares);
    if (sharesRounded <= 0) {
      console.log(
        `[trade] SELL ${args.outcomeLabel} | balance dust (${shares}) below min size; skipping`,
      );
      return 0;
    }

    const priceHint =
      args.priceHint && Number.isFinite(args.priceHint) && args.priceHint > 0
        ? roundToTick(args.priceHint, args.tickSize)
        : undefined;

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
    return sharesRounded;
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
