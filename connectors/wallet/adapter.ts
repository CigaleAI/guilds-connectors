import manifest from "./connector.json" with { type: "json" };
import {
  callTool,
  parseCredentials,
  ping,
  WalletError,
  type Credentials as WalletCredentials,
} from "./client.js";
import { ConnectorError, translated, type Adapter, type Credentials } from "@guildsrun/orchestrator/connectors/types.js";

/** Tools the wallet lists only to a login with a Uniswap API key. */
const UNISWAP_TOOLS = new Set(["uniswap_swap"]);

function walletCreds(creds: Credentials): WalletCredentials | null {
  try {
    return parseCredentials(
      creds.evm_private_key,
      creds.solana_private_key,
      creds.alchemy_key,
      creds.opensea_key,
      creds.uniswap_key,
    );
  } catch {
    return null;
  }
}

function requiredWallet(creds: Credentials, message: string): WalletCredentials {
  const wallet = walletCreds(creds);
  if (wallet === null) {
    throw new ConnectorError(message, 401);
  }
  return wallet;
}

const adapter: Adapter = {
  async validate(creds, ctx) {
    const wallet = requiredWallet(creds, "wallet credentials are required");
    await translated(WalletError, () =>
      ping(wallet.alchemy_key, wallet.opensea_key, { uniswapKey: wallet.uniswap_key, client: ctx.http }),
    );
    return "";
  },
  async list(creds) {
    const keyed = Boolean(walletCreds(creds)?.uniswap_key);
    return manifest.tools.filter((tool) => keyed || !UNISWAP_TOOLS.has(tool.name));
  },
  async call(name, args, creds, ctx) {
    const wallet = requiredWallet(creds, "wallet credentials are missing");
    return translated(WalletError, () =>
      callTool(name, args, {
        creds: wallet,
        connectionId: ctx.connection_id,
        openseaKey: wallet.opensea_key,
        client: ctx.http,
      }),
    );
  },
};

export default adapter;
