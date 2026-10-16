import { CoinGeckoError, ping, searchCoins, simplePrices } from "@guildsrun/orchestrator/connectors/coingecko/client.js";
import {
  assertPinnedIdsQuoted,
  pinnedPriceEntries,
  PinnedPricesError,
  validatePinnedPrices,
  type PinnedPrice,
} from "./client.js";
import { ConnectorError, requiredCredential, translated, type Adapter, type ConnectorContext } from "@guildsrun/orchestrator/connectors/types.js";

function pinnedCoins(ctx: ConnectorContext): PinnedPrice[] {
  try {
    return validatePinnedPrices(ctx.settings.coins ?? []);
  } catch (error) {
    if (error instanceof PinnedPricesError) {
      throw new ConnectorError(error.message, 422);
    }
    throw error;
  }
}

const adapter: Adapter = {
  async validate(creds, ctx) {
    const apiKey = requiredCredential(creds, "token", "api key is required");
    const pinned = pinnedCoins(ctx);
    await translated(CoinGeckoError, () => ping(apiKey, { client: ctx.http }));
    try {
      await translated(CoinGeckoError, () =>
        assertPinnedIdsQuoted(pinned, (ids) => simplePrices(ids, { apiKey, client: ctx.http })),
      );
    } catch (error) {
      if (error instanceof PinnedPricesError) {
        throw new ConnectorError(error.message, 422);
      }
      throw error;
    }
    return pinned.length ? `${pinned.length} coin${pinned.length === 1 ? "" : "s"}` : "";
  },
  async lookup(property, query, creds, ctx) {
    if (property !== "coins") {
      throw new ConnectorError(`Pinned prices has no lookup for ${property}`, 404);
    }
    const apiKey = requiredCredential(creds, "token", "api key is required");
    const coins = await translated(CoinGeckoError, () => searchCoins(query, { apiKey, client: ctx.http }));
    return coins.map((coin) => ({
      value: { id: coin.id, symbol: coin.symbol, name: coin.name },
      label: `${coin.name} (${coin.symbol})`,
      ...(coin.market_cap_rank !== null ? { detail: `#${coin.market_cap_rank}` } : {}),
      ...(coin.thumb ? { image: coin.thumb } : {}),
    }));
  },
  async state(creds, ctx) {
    const pinned = validatePinnedPrices(ctx.settings.coins ?? []);
    if (!pinned.length) {
      return null;
    }
    const apiKey = requiredCredential(creds, "token", "api key is required");
    return pinnedPriceEntries(pinned, { fetch: (ids) => simplePrices(ids, { apiKey, client: ctx.http }) });
  },
};

export default adapter;
