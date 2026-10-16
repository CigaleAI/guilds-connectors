import type { CoinPrice } from "@guildsrun/orchestrator/connectors/coingecko/client.js";

export const PINNED_PRICES_MAX = 20;
export const PINNED_PRICE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export class PinnedPricesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinnedPricesError";
  }
}

/** A CoinGecko coin whose USD price is hydrated into every run's State. */
export type PinnedPrice = {
  id: string;
  symbol: string;
  name: string;
};

export type PriceSource =
  | { fetch: (ids: string[]) => Promise<Record<string, CoinPrice>> }
  | { unavailable: string };

/** One State `prices` row: the pinned coin plus its USD quote, or why there is none. */
export type PriceEntry = {
  id: string;
  symbol: string;
  name: string;
  usd?: number;
  change_24h_pct?: number | null;
  updated_at?: string | null;
  unavailable?: string;
};

export function validatePinnedPrices(value: unknown): PinnedPrice[] {
  if (!Array.isArray(value)) {
    throw new PinnedPricesError("coins must be an array");
  }
  if (value.length > PINNED_PRICES_MAX) {
    throw new PinnedPricesError(`coins must have at most ${PINNED_PRICES_MAX} entries`);
  }
  const seen = new Set<string>();
  const pinned: PinnedPrice[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new PinnedPricesError("coins entries must be objects");
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!PINNED_PRICE_ID_RE.test(id)) {
      throw new PinnedPricesError("coins id must be a CoinGecko coin id");
    }
    if (seen.has(id)) {
      throw new PinnedPricesError(`coins lists ${id} twice`);
    }
    seen.add(id);
    const symbol = (typeof record.symbol === "string" ? record.symbol : "").trim().toUpperCase().slice(0, 32);
    const name = (typeof record.name === "string" ? record.name : "").trim().slice(0, 100);
    pinned.push({ id, symbol: symbol || id.toUpperCase(), name: name || id });
  }
  return pinned;
}

export async function assertPinnedIdsQuoted(
  pinned: PinnedPrice[],
  fetch: (ids: string[]) => Promise<Record<string, CoinPrice>>,
): Promise<void> {
  if (!pinned.length) {
    return;
  }
  const prices = await fetch(pinned.map((coin) => coin.id));
  const missing = pinned.filter((coin) => !prices[coin.id]).map((coin) => coin.id);
  if (missing.length) {
    throw new PinnedPricesError(`unknown CoinGecko ids: ${missing.join(", ")}`);
  }
}

function isoSeconds(value: number | null): string | null {
  return value === null ? null : new Date(value * 1000).toISOString();
}

function roundPct(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

export async function pinnedPriceEntries(
  pinned: PinnedPrice[],
  source: PriceSource,
): Promise<PriceEntry[]> {
  if (!pinned.length) {
    return [];
  }
  const base = (coin: PinnedPrice): PriceEntry => ({ id: coin.id, symbol: coin.symbol, name: coin.name });
  if ("unavailable" in source) {
    return pinned.map((coin) => ({ ...base(coin), unavailable: source.unavailable }));
  }
  let prices: Record<string, CoinPrice>;
  try {
    prices = await source.fetch(pinned.map((coin) => coin.id));
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message : "request failed";
    return pinned.map((coin) => ({ ...base(coin), unavailable: `CoinGecko: ${reason}` }));
  }
  return pinned.map((coin) => {
    const quote = prices[coin.id];
    if (!quote) {
      return { ...base(coin), unavailable: "CoinGecko returned no price" };
    }
    return {
      ...base(coin),
      usd: quote.usd,
      change_24h_pct: roundPct(quote.change_24h),
      updated_at: isoSeconds(quote.updated_at),
    };
  });
}
