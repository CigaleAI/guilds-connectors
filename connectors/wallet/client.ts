import { randomBytes } from "node:crypto";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  concat,
  encodeAbiParameters,
  getAddress as checksumAddress,
  isAddress,
  keccak256,
  parseAbiParameters,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AsyncLock } from "@guildsrun/orchestrator/lib/lock.js";
import { proxyFetch, withQuery, type FetchFn } from "@guildsrun/orchestrator/net/http.js";

const AMOUNT = /^\d+(\.\d+)?$/;
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const RECEIPT_SECONDS = 120;
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const NATIVE_EVM = "0x0000000000000000000000000000000000000000";
const JUPITER_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP = "https://lite-api.jup.ag/swap/v1/swap";
const LIFI_QUOTE = "https://li.quest/v1/quote";
const UNISWAP_API = "https://trade-api.gateway.uniswap.org/v1";
const UNISWAP_CHAINS_URL = `${UNISWAP_API}/supported_chains`;
const UNISWAP_APPROVAL = `${UNISWAP_API}/check_approval`;
const UNISWAP_QUOTE = `${UNISWAP_API}/quote`;
const UNISWAP_SWAP = `${UNISWAP_API}/swap`;
const OPENSEA_API = "https://api.opensea.io/api/v2";
const OPENSEA_SITE = "https://opensea.io";
// Authoritative OpenSea coverage comes from GET /api/v2/chains at call
// time (see _opensea_slug). OPENSEA_CHAINS below is only the local gate:
// "chains this wallet holds an RPC and explorer for".
const OPENSEA_CHAINS_URL = `${OPENSEA_API}/chains`;
const OPENSEA_KEYS_URL = `${OPENSEA_API}/auth/keys`;
// These tools authenticate with an API key in the X-API-KEY header. There is
// no browser-login concept for the REST API. (A few wallet-scoped endpoints
// want a bearer token as well, but none that this file calls: order
// cancellation here is on-chain.)
const OPENSEA_KEY_ENV = "OPENSEA_API_KEY";
const OPENSEA_AUTO_KEY_ENV = "OPENSEA_AUTO_KEY";
const OPENSEA_AUTO_KEY_TTL = 6 * 3600.0;
const OPENSEA_CHAINS_TTL = 3600.0;
// OpenSea's path slug for a chain is usually our key. Known divergences go
// here; anything else is resolved against the live list.
const OPENSEA_SLUG_ALIASES: Record<string, string> = { polygon: "matic", bsc: "bnb" };
// LI.FI routes same-chain swaps. HyperEVM goes through Hyperswap /
// Kittenswap. Robinhood Chain is chain id 4663.
const SWAP_EVM = new Set([
  "ethereum",
  "polygon",
  "base",
  "arbitrum",
  "bsc",
  "optimism",
  "hyperevm",
  "robinhood",
]);
// Uniswap Trading API same-chain AMMs (v2/v3/v4). HyperEVM is not listed.
const SWAP_UNISWAP = new Set([
  "ethereum",
  "polygon",
  "base",
  "arbitrum",
  "bsc",
  "optimism",
  "ink",
  "robinhood",
  "arc",
]);
const UNISWAP_ROUTES = new Set(["CLASSIC", "WRAP", "UNWRAP"]);
const NATIVE_SYMBOLS: Record<string, Set<string>> = {
  ethereum: new Set(["ETH"]),
  polygon: new Set(["POL", "MATIC"]),
  base: new Set(["ETH"]),
  arbitrum: new Set(["ETH"]),
  bsc: new Set(["BNB"]),
  optimism: new Set(["ETH"]),
  ink: new Set(["ETH"]),
  robinhood: new Set(["ETH"]),
  hyperevm: new Set(["HYPE"]),
  arc: new Set(["USDC"]),
  solana: new Set(["SOL"]),
};

type EvmChainSpec = {
  chain_id: number;
  alchemy?: string;
  rpc?: string;
  explorer: string;
  decimals: number;
  small_block_gas?: number;
};

export const EVM_CHAINS: Record<string, EvmChainSpec> = {
  ethereum: {
    chain_id: 1,
    alchemy: "eth-mainnet",
    explorer: "https://etherscan.io",
    decimals: 18,
  },
  polygon: {
    chain_id: 137,
    alchemy: "polygon-mainnet",
    rpc: "https://polygon-bor-rpc.publicnode.com",
    explorer: "https://polygonscan.com",
    decimals: 18,
  },
  base: {
    chain_id: 8453,
    alchemy: "base-mainnet",
    explorer: "https://basescan.org",
    decimals: 18,
  },
  arbitrum: {
    chain_id: 42161,
    alchemy: "arb-mainnet",
    rpc: "https://arb1.arbitrum.io/rpc",
    explorer: "https://arbiscan.io",
    decimals: 18,
  },
  bsc: {
    chain_id: 56,
    alchemy: "bnb-mainnet",
    rpc: "https://bsc-rpc.publicnode.com",
    explorer: "https://bscscan.com",
    decimals: 18,
  },
  optimism: {
    chain_id: 10,
    alchemy: "opt-mainnet",
    rpc: "https://mainnet.optimism.io",
    explorer: "https://optimistic.etherscan.io",
    decimals: 18,
  },
  ink: {
    chain_id: 57073,
    alchemy: "ink-mainnet",
    explorer: "https://explorer.inkonchain.com",
    decimals: 18,
  },
  robinhood: {
    chain_id: 4663,
    alchemy: "robinhood-mainnet",
    explorer: "https://robinhoodchain.blockscout.com",
    decimals: 18,
  },
  hyperevm: {
    chain_id: 999,
    alchemy: "hyperliquid-mainnet",
    explorer: "https://hyperevmscan.io",
    decimals: 18,
    // HyperEVM interleaves 1s "small" blocks with 1m "big" blocks. A
    // transaction above this limit can never land in a small block; the
    // wallet has to opt into big blocks first. Official docs currently
    // say 3M and the figure has been raised over time, so this is the
    // conservative bound -- raise it if legitimate calls get rejected.
    small_block_gas: 2_000_000,
  },
  // Circle Arc. Native gas is USDC at 18 decimals (msg.value / eth_getBalance).
  // The ERC-20 interface at 0x3600… shares that balance but reports 6 decimals.
  arc: {
    chain_id: 5042,
    rpc: "https://rpc.mainnet.arc.io",
    explorer: "https://explorer.arc.io",
    decimals: 18,
  },
};
// Aliases people and models actually type. HYPE is the gas token; hyperevm
// is the chain.
const CHAIN_ALIASES: Record<string, string> = {
  hype: "hyperevm",
  hl: "hyperevm",
  hyperliquid: "hyperevm",
  "hyperliquid-evm": "hyperevm",
  "arc-mainnet": "arc",
  bnb: "bsc",
  binance: "bsc",
  "bnb-chain": "bsc",
  bnbchain: "bsc",
  "binance-smart-chain": "bsc",
  "bnb-smart-chain": "bsc",
};
export const CHAIN_NAMES = [...Object.keys(EVM_CHAINS), "solana"] as const;
// Every EVM chain here is one OpenSea indexes, ink and robinhood included.
// Solana is excluded: OpenSea lists it, but these tools sign Seaport orders.
const OPENSEA_CHAINS = new Set(Object.keys(EVM_CHAINS));
const OPENSEA_CHAIN_LIST = [...OPENSEA_CHAINS].sort().join(", ");

const TOKENS: Record<string, Record<string, string>> = {
  ethereum: {
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  },
  polygon: { USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
  base: { USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  arbitrum: { USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  bsc: {
    USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    USDT: "0x55d398326f99059fF775485246999027B3197955",
    WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  },
  optimism: { USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  ink: { USDC: "0x2D270e6886d130D724215A266106e6832161EAEd" },
  robinhood: { USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" },
  hyperevm: {
    USDC: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
    USDT0: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb",
    USDT: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb",
    WHYPE: "0x5555555555555555555555555555555555555555",
  },
  arc: {
    USDC: "0x3600000000000000000000000000000000000000",
    EURC: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
    USYC: "0x8a5D989Bbb96929F689B0200f435f53dA42bF490",
  },
  solana: {
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

// --------------------------------------------------------------------------
// Seaport / OpenSea marketplace constants
// --------------------------------------------------------------------------

const SEAPORT = checksumAddress("0x0000000000000068F116a894984e2DB1123eB395");
const SEAPORT_VERSION = "1.6";
const SEAPORT_ADDRESSES = new Set([
  SEAPORT,
  checksumAddress("0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC"), // 1.5
]);
const OPENSEA_CONDUIT = checksumAddress("0x1E0049783F008A0085193E00003D00cd54003c71");
const CONDUIT_KEY = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000";
const ZERO_HASH = `0x${"00".repeat(32)}`;
const ORDER_DEFAULT_DAYS = 7;
const ORDER_MAX_DAYS = 30;

const ITEM_NATIVE = 0;
const ITEM_ERC20 = 1;
const ITEM_ERC721 = 2;
const ITEM_ERC1155 = 3;

const ORDER_FULL_OPEN = 0;
const ORDER_PARTIAL_OPEN = 1;
const ORDER_PARTIAL_RESTRICTED = 3;

const WETH: Record<string, string> = {
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  polygon: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  base: "0x4200000000000000000000000000000000000006",
  arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  bsc: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  optimism: "0x4200000000000000000000000000000000000006",
};

const ORDER_COMPONENTS_TUPLE =
  "(address,address," +
  "(uint8,address,uint256,uint256,uint256)[]," +
  "(uint8,address,uint256,uint256,uint256,address)[]," +
  "uint8,uint256,uint256,bytes32,uint256,bytes32,uint256)";

const SEAPORT_TYPES = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
} as const;

// Field order for every Seaport struct that can appear inside OpenSea
// fulfillment data. Used to turn a JSON object into an ABI tuple.
const STRUCT_LAYOUTS = [
  [
    "offerer",
    "zone",
    "offer",
    "consideration",
    "orderType",
    "startTime",
    "endTime",
    "zoneHash",
    "salt",
    "conduitKey",
    "totalOriginalConsiderationItems",
  ],
  [
    "offerer",
    "zone",
    "offer",
    "consideration",
    "orderType",
    "startTime",
    "endTime",
    "zoneHash",
    "salt",
    "conduitKey",
    "counter",
  ],
  ["itemType", "token", "identifierOrCriteria", "startAmount", "endAmount"],
  ["itemType", "token", "identifierOrCriteria", "startAmount", "endAmount", "recipient"],
  ["parameters", "numerator", "denominator", "signature", "extraData"],
  ["parameters", "signature"],
  ["orderIndex", "side", "index", "identifier", "criteriaProof"],
  ["orderIndex", "itemIndex"],
  ["offerComponents", "considerationComponents"],
  ["amount", "recipient"],
  [
    "considerationToken",
    "considerationIdentifier",
    "considerationAmount",
    "offerer",
    "zone",
    "offerToken",
    "offerIdentifier",
    "offerAmount",
    "basicOrderType",
    "startTime",
    "endTime",
    "zoneHash",
    "salt",
    "offererConduitKey",
    "fulfillerConduitKey",
    "totalOriginalAdditionalRecipients",
    "additionalRecipients",
    "signature",
  ],
] as const;
const STRUCT_FIELDS = new Map<string, readonly string[]>(
  STRUCT_LAYOUTS.map((names) => [frozensetKey(names), names]),
);

function frozensetKey(names: readonly string[]): string {
  return [...names].sort().join("\0");
}

const locks = new Map<string, AsyncLock>();

export class WalletError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "WalletError";
    this.status = status;
  }
}

export type Credentials = {
  evm_private_key: string;
  solana_private_key: string;
  alchemy_key: string;
  opensea_key: string;
  uniswap_key: string;
};

type ClientOptions = { client?: FetchFn; proxyUrl?: string };
type ConnectionOptions = ClientOptions & { connectionId: string };
type OpenSeaOptions = ConnectionOptions & { openseaKey?: string | null };

export function parseUnits(amount: string, decimals: number): bigint {
  if (typeof amount !== "string" || AMOUNT.exec(amount.trim())?.[0] !== amount.trim()) {
    throw new WalletError(`amount must be a positive decimal string, got "${amount}"`);
  }
  const text = amount.trim();
  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  const frac = dot === -1 ? "" : text.slice(dot + 1);
  if (frac.length > decimals) {
    throw new WalletError(`amount has more than ${decimals} decimal places`);
  }
  const padded = frac.padEnd(decimals, "0");
  const value = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
  if (value <= 0n) {
    throw new WalletError("amount must be greater than 0");
  }
  return value;
}

export function formatUnits(raw: bigint | number, decimals: number): string {
  const value = typeof raw === "number" ? BigInt(raw) : raw;
  if (decimals <= 0) {
    return String(value);
  }
  const quantum = 10n ** BigInt(decimals);
  const whole = value / quantum;
  const frac = value % quantum;
  if (frac === 0n) {
    return String(whole);
  }
  return `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

export function parseCredentials(
  evmPrivateKey: unknown,
  solanaPrivateKey: unknown,
  alchemyKey: unknown,
  openseaKey: unknown,
  uniswapKey?: unknown,
): Credentials {
  const evm = requireStr(evmPrivateKey, "evm_private_key");
  const sol = requireStr(solanaPrivateKey, "solana_private_key");
  const alchemy = requireStr(alchemyKey, "alchemy_key");
  const sea = requireStr(openseaKey, "opensea_key");
  const evmKey = normalizedEvmKey(evm);
  return {
    evm_private_key: evmKey,
    solana_private_key: bs58.encode(solanaKeypair(sol).secretKey),
    alchemy_key: alchemy,
    opensea_key: sea,
    uniswap_key: optionalStr(uniswapKey),
  };
}

export function accountHint(creds: Credentials): string {
  return `${shortAddr(evmAddress(creds))} · ${shortAddr(solanaAddress(creds))}`;
}

export function evmAddress(creds: Credentials): string {
  return privateKeyToAccount(creds.evm_private_key as Hex).address;
}

export function solanaAddress(creds: Credentials): string {
  return Keypair.fromSecretKey(bs58.decode(creds.solana_private_key)).publicKey.toBase58();
}

export function evmRpc(chain: string, alchemyKey: string): string {
  const spec = EVM_CHAINS[chain];
  if (!spec) {
    throw new WalletError(`unknown chain '${chain}'. Known: ${CHAIN_NAMES.join(", ")}`);
  }
  if (spec.alchemy) {
    return `https://${spec.alchemy}.g.alchemy.com/v2/${alchemyKey}`;
  }
  if (spec.rpc) {
    return spec.rpc;
  }
  throw new WalletError(`unknown chain '${chain}'. Known: ${CHAIN_NAMES.join(", ")}`);
}

export function solanaRpc(alchemyKey: string): string {
  return `https://solana-mainnet.g.alchemy.com/v2/${alchemyKey}`;
}

export function resolveChain(value: unknown): string {
  let chain = String(value || "")
    .trim()
    .toLowerCase();
  chain = CHAIN_ALIASES[chain] ?? chain;
  if (!(CHAIN_NAMES as readonly string[]).includes(chain)) {
    throw new WalletError(`unknown chain ${pythonRepr(value)}. Known: ${CHAIN_NAMES.join(", ")}`);
  }
  return chain;
}

export function resolveOpenseaChain(value: unknown): string {
  const chain = resolveChain(value);
  if (!OPENSEA_CHAINS.has(chain)) {
    throw new WalletError(
      `the OpenSea tools cannot sign on ${chain}. They are EVM only: ` +
        `${OPENSEA_CHAIN_LIST}. Whether OpenSea currently indexes a given ` +
        "chain is checked against its live chain list at call time.",
    );
  }
  return chain;
}

export function resolveToken(chain: string, token: unknown): string | null {
  if (token === null || token === undefined) {
    return null;
  }
  const text = String(token).trim();
  if (!text) {
    return null;
  }
  const known = (TOKENS[chain] ?? {})[text.toUpperCase()];
  if (known) {
    return known;
  }
  if (chain !== "solana" && evmIsAddress(text)) {
    return checksum(text);
  }
  if (chain === "solana") {
    try {
      return new PublicKey(text).toBase58();
    } catch {
      // fall through
    }
  }
  const names = Object.keys(TOKENS[chain] ?? {}).join(", ") || "none";
  throw new WalletError(`Unknown token "${text}" on ${chain}. Known: ${names}`);
}

export function resolveAsset(chain: string, token: unknown): string | null {
  if (token === null || token === undefined) {
    return null;
  }
  const text = String(token).trim();
  if (!text) {
    return null;
  }
  if ((NATIVE_SYMBOLS[chain] ?? new Set()).has(text.toUpperCase())) {
    return null;
  }
  return resolveToken(chain, text);
}

export function parseZeroUnits(amount: unknown, decimals: number): bigint {
  if (amount === null || amount === undefined) {
    return 0n;
  }
  const text = String(amount).trim();
  if (text === "" || text === "0" || text === "0.0") {
    return 0n;
  }
  return parseUnits(text, decimals);
}

export function slippageBps(value: unknown): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    return 100;
  }
  const text = String(value).trim();
  if (AMOUNT.exec(text)?.[0] !== text) {
    throw new WalletError(`slippage must be a percent, got "${value}"`);
  }
  const bps = parseZeroUnits(text, 2);
  if (bps <= 0n) {
    throw new WalletError("slippage must be greater than 0");
  }
  if (bps > 5000n) {
    throw new WalletError("slippage must be at most 50");
  }
  return Number(bps);
}

function httpClient(options: ClientOptions = {}): FetchFn {
  return options.client ?? proxyFetch(options.proxyUrl ?? "");
}

export async function ping(
  alchemyKey: string,
  openseaKey: string,
  options: ClientOptions & { uniswapKey?: string | null } = {},
): Promise<void> {
  const key = requireStr(alchemyKey, "alchemy_key");
  const sea = requireStr(openseaKey, "opensea_key");
  const fetchFn = httpClient(options);
  await evmRpcCall(fetchFn, evmRpc("ethereum", key), "eth_blockNumber", []);
  await solRpcCall(fetchFn, solanaRpc(key), "getSlot", []);
  await httpJson(fetchFn, "GET", OPENSEA_CHAINS_URL, {
    headers: openseaHeaders(sea),
    error: "OpenSea",
  });
  const uni = optionalStr(options.uniswapKey);
  if (uni) {
    await httpJson(fetchFn, "GET", UNISWAP_CHAINS_URL, {
      headers: uniswapHeaders(uni),
      error: "Uniswap",
    });
  }
}

export async function callTool(
  name: string,
  arguments_: Record<string, unknown>,
  options: {
    creds: Credentials;
    connectionId: string;
    client?: FetchFn;
    proxyUrl?: string;
    openseaKey?: string | null;
  },
): Promise<string> {
  const run = async (action: (fetchFn: FetchFn) => Promise<string>): Promise<string> =>
    action(httpClient(options));
  if (name === "get_address") {
    return getAddress(options.creds, resolveChain(arguments_.chain));
  }
  if (name === "get_balance") {
    const chain = resolveChain(arguments_.chain);
    const token = resolveToken(chain, arguments_.token);
    return run((fetchFn) => getBalance(options.creds, chain, token, { client: fetchFn }));
  }
  if (name === "send") {
    return run((fetchFn) =>
      send(options.creds, arguments_, { connectionId: options.connectionId, client: fetchFn }),
    );
  }
  if (name === "call") {
    return run((fetchFn) =>
      evmCall(options.creds, arguments_, { connectionId: options.connectionId, client: fetchFn }),
    );
  }
  if (name === "submit") {
    return run((fetchFn) =>
      submit(options.creds, arguments_, { connectionId: options.connectionId, client: fetchFn }),
    );
  }
  if (name === "swap") {
    return run((fetchFn) =>
      swap(options.creds, arguments_, { connectionId: options.connectionId, client: fetchFn }),
    );
  }
  if (name === "uniswap_swap") {
    return run((fetchFn) =>
      uniswapSwap(options.creds, arguments_, { connectionId: options.connectionId, client: fetchFn }),
    );
  }
  if (
    name === "opensea_buy" ||
    name === "opensea_list" ||
    name === "opensea_accept_offer" ||
    name === "opensea_collection_offer" ||
    name === "opensea_cancel_order"
  ) {
    const handler = {
      opensea_buy: openseaBuy,
      opensea_list: openseaList,
      opensea_accept_offer: openseaAcceptOffer,
      opensea_collection_offer: openseaCollectionOffer,
      opensea_cancel_order: openseaCancelOrder,
    }[name];
    return run((fetchFn) => {
      const seaOptions: OpenSeaOptions = {
        connectionId: options.connectionId,
        client: fetchFn,
      };
      if (options.openseaKey !== undefined) {
        seaOptions.openseaKey = options.openseaKey;
      }
      return handler(options.creds, arguments_, seaOptions);
    });
  }
  throw new WalletError(`unknown Wallet tool ${name}`);
}

export function getAddress(creds: Credentials, chain: string): string {
  return chain !== "solana" ? evmAddress(creds) : solanaAddress(creds);
}

export async function getBalance(
  creds: Credentials,
  chain: string,
  token: string | null,
  options: ClientOptions = {},
): Promise<string> {
  const fetchFn = httpClient(options);
  if (chain === "solana") {
    return solanaBalance(creds, token, fetchFn);
  }
  return evmBalance(creds, chain, token, fetchFn);
}

export async function send(
  creds: Credentials,
  arguments_: Record<string, unknown>,
  options: ConnectionOptions,
): Promise<string> {
  const fetchFn = httpClient(options);
  const chain = resolveChain(arguments_.chain);
  const to = String(arguments_.to || "").trim();
  const amount = String(arguments_.amount || "").trim();
  const token = resolveToken(chain, arguments_.token);
  const result =
    chain === "solana"
      ? await sendSolana(creds, to, amount, token, fetchFn)
      : await lockedEvm(options.connectionId, chain, () =>
          sendEvm(creds, chain, to, amount, token, fetchFn),
        );
  return txLine(result);
}

export async function evmCall(
  creds: Credentials,
  arguments_: Record<string, unknown>,
  options: ConnectionOptions,
): Promise<string> {
  const fetchFn = httpClient(options);
  const chain = resolveChain(arguments_.chain);
  if (chain === "solana") {
    throw new WalletError("call is EVM only; use submit for Solana");
  }
  const to = String(arguments_.to || "").trim();
  const data = String(arguments_.data || "").trim();
  if (!evmIsAddress(to)) {
    throw new WalletError(`Invalid EVM address: ${to}`);
  }
  if (HEX_DATA.exec(data)?.[0] !== data) {
    throw new WalletError("data must be 0x-prefixed hex bytes");
  }
  const spec = mustEvm(chain);
  const value = parseZeroUnits(arguments_.value, spec.decimals);
  const result = await lockedEvm(options.connectionId, chain, () =>
    broadcastEvm(creds, chain, checksum(to), value, data, fetchFn),
  );
  return txLine(result);
}

export async function submit(
  creds: Credentials,
  arguments_: Record<string, unknown>,
  options: ConnectionOptions,
): Promise<string> {
  const fetchFn = httpClient(options);
  const encoded = String(arguments_.transaction || "").trim();
  if (!encoded) {
    throw new WalletError("transaction is required");
  }
  const result = await submitSolana(creds, encoded, fetchFn);
  return txLine(result);
}

export async function swap(
  creds: Credentials,
  arguments_: Record<string, unknown>,
  options: ConnectionOptions,
): Promise<string> {
  const fetchFn = httpClient(options);
  const chain = resolveChain(arguments_.chain);
  const sell = resolveAsset(chain, arguments_.sell);
  const buy = resolveAsset(chain, arguments_.buy);
  const amount = String(arguments_.amount || "").trim();
  const bps = slippageBps(arguments_.slippage);
  if (buy === null && sell === null) {
    throw new WalletError("sell and buy cannot both be the native coin");
  }
  if (buy !== null && sell !== null && buy === sell) {
    throw new WalletError("sell and buy must differ");
  }
  if (chain === "solana") {
    const result = await swapSolana(creds, sell, buy, amount, bps, fetchFn);
    return txLine(result);
  }
  if (!SWAP_EVM.has(chain)) {
    throw new WalletError(`swap on ${chain} is not supported`);
  }
  const result = await lockedEvm(options.connectionId, chain, () =>
    swapEvm(creds, chain, sell, buy, amount, bps, fetchFn),
  );
  return txLine(result);
}

export async function uniswapSwap(
  creds: Credentials,
  arguments_: Record<string, unknown>,
  options: ConnectionOptions,
): Promise<string> {
  const key = creds.uniswap_key.trim();
  if (!key) {
    throw new WalletError("Uniswap API key is missing");
  }
  const fetchFn = httpClient(options);
  const chain = resolveChain(arguments_.chain);
  const sell = resolveAsset(chain, arguments_.sell);
  const buy = resolveAsset(chain, arguments_.buy);
  const amount = String(arguments_.amount || "").trim();
  const bps = slippageBps(arguments_.slippage);
  if (buy === null && sell === null) {
    throw new WalletError("sell and buy cannot both be the native coin");
  }
  if (buy !== null && sell !== null && buy === sell) {
    throw new WalletError("sell and buy must differ");
  }
  if (!SWAP_UNISWAP.has(chain)) {
    throw new WalletError(`Uniswap swap on ${chain} is not supported`);
  }
  const result = await lockedEvm(options.connectionId, chain, () =>
    swapUniswap(creds, chain, sell, buy, amount, bps, key, fetchFn),
  );
  return txLine(result);
}

export async function openseaBuy(
  creds: Credentials,
  arguments_: Record<string, unknown>,
  options: OpenSeaOptions,
): Promise<string> {
  const fetchFn = httpClient(options);
  const key = await openseaAuth(options.openseaKey, creds, fetchFn);
  const headers = openseaHeaders(key);
  const chain = resolveOpenseaChain(arguments_.chain);
  const slugChain = await openseaSlug(fetchFn, headers, chain);
  const listing = await pickListing(fetchFn, headers, slugChain, arguments_);
  const result = await lockedEvm(options.connectionId, chain, () =>
    fillListing(creds, chain, slugChain, listing, key, fetchFn),
  );
  const line = txLine(result);
  if (!listing.label) {
    return line;
  }
  return listing.tokenId
    ? `${line}  bought #${listing.tokenId} for ${listing.label}`
    : `${line}  bought for ${listing.label}`;
}

// --------------------------------------------------------------------------
// OpenSea marketplace (EVM chains only -- not Solana, ink, robinhood or
// hyperevm, none of which OpenSea indexes)
// --------------------------------------------------------------------------

export async function openseaList(
  creds: Credentials,
  arguments_: Record<string, unknown>,
  options: OpenSeaOptions,
): Promise<string> {
  const fetchFn = httpClient(options);
  const key = await openseaAuth(options.openseaKey, creds, fetchFn);
  const headers = openseaHeaders(key);
  const chain = resolveOpenseaChain(arguments_.chain);
  const contract = nftContract(arguments_.contract);
  const tokenId = tokenIdArg(arguments_.token_id);
  const quantity = countArg(arguments_.quantity, "quantity");
  const optionalFees = flagArg(arguments_.include_optional_fees);
  const duration = durationSeconds(arguments_.duration_days);

  const currency = String(arguments_.currency || "").trim();
  let payType: number;
  let payToken: string;
  let payDecimals: number;
  let payLabel: string;
  if (currency === "" || (NATIVE_SYMBOLS[chain] ?? new Set()).has(currency.toUpperCase())) {
    payType = ITEM_NATIVE;
    payToken = NATIVE_EVM;
    payDecimals = mustEvm(chain).decimals;
    payLabel = [...(NATIVE_SYMBOLS[chain] ?? new Set())].sort()[0] ?? "ETH";
  } else {
    payType = ITEM_ERC20;
    payToken = paymentToken(chain, currency);
    // Read decimals rather than assuming 18. USDG-priced listings on
    // robinhood are 6, and assuming 18 misprices them by 1e12.
    payDecimals = await erc20Decimals(creds, chain, payToken, fetchFn);
    payLabel = /^[A-Za-z]+$/.test(currency) ? currency.toUpperCase() : shortAddr(payToken);
  }

  const price = parseUnits(String(arguments_.price || "").trim(), payDecimals);

  const slugChain = await openseaSlug(fetchFn, headers, chain);
  const nft = await openseaNft(fetchFn, headers, slugChain, contract, tokenId);
  const standard = String(nft.token_standard || "erc721").toLowerCase();
  const itemType = standard.includes("1155") ? ITEM_ERC1155 : ITEM_ERC721;
  if (itemType === ITEM_ERC721 && quantity !== 1) {
    throw new WalletError("quantity must be 1 for an ERC-721");
  }
  const slug = String(nft.collection || "").trim();

  const collection = slug ? await openseaCollection(fetchFn, headers, slug) : {};
  const fees = collectionFees(collection, price, optionalFees);
  const totalFees = fees.reduce((sum, [value]) => sum + value, 0n);
  if (totalFees >= price) {
    throw new WalletError("marketplace and creator fees exceed the listing price");
  }

  const me = evmAddress(creds);
  const offer = [offerItem(itemType, contract, BigInt(tokenId), BigInt(quantity))];
  const consideration = [
    considerationItem(payType, payToken, 0n, price - totalFees, me),
    ...fees.map(([value, recipient]) => considerationItem(payType, payToken, 0n, value, recipient)),
  ];

  const start = Math.trunc(Date.now() / 1000);
  const order = seaportOrder({
    offerer: me,
    offer,
    consideration,
    orderType: ORDER_FULL_OPEN,
    start,
    end: start + duration,
  });

  // Approve before signing: an unapproved listing is un-fillable, and the
  // approval is the only step here that costs gas.
  await lockedEvm(options.connectionId, chain, () =>
    ensureNftApproval(creds, chain, contract, fetchFn),
  );
  const counter = await seaportCounter(creds, chain, fetchFn);
  const signature = await signOrder(creds, chain, order, counter);
  const posted = await httpJson(
    fetchFn,
    "POST",
    `${OPENSEA_API}/orders/${slugChain}/seaport/listings`,
    {
      payload: {
        parameters: orderParameters(order, counter),
        signature,
        protocol_address: SEAPORT,
      },
      headers,
      error: "OpenSea",
    },
  );
  const orderHash = orderHashOf(posted) || "unknown";
  return orderLine(
    orderHash,
    chain,
    `listed ${quantity}x #${tokenId} for ${formatUnits(price, payDecimals)} ${payLabel}`,
    `${OPENSEA_SITE}/assets/${slugChain}/${contract}/${tokenId}`,
  );
}

export async function openseaAcceptOffer(
  creds: Credentials,
  arguments_: Record<string, unknown>,
  options: OpenSeaOptions,
): Promise<string> {
  const fetchFn = httpClient(options);
  const key = await openseaAuth(options.openseaKey, creds, fetchFn);
  const headers = openseaHeaders(key);
  const chain = resolveOpenseaChain(arguments_.chain);
  const contract = nftContract(arguments_.contract);
  const tokenId = tokenIdArg(arguments_.token_id);
  const optionalFees = flagArg(arguments_.include_optional_fees);
  const me = evmAddress(creds);

  const slugChain = await openseaSlug(fetchFn, headers, chain);
  const nft = await openseaNft(fetchFn, headers, slugChain, contract, tokenId);
  const slug = String(nft.collection || "").trim();
  const offer = await bestOffer(fetchFn, headers, slugChain, slug, contract, tokenId);
  checkMinPrice(offer, arguments_.min_price);

  const fulfillment = await httpJson(fetchFn, "POST", `${OPENSEA_API}/offers/fulfillment_data`, {
    payload: {
      offer: {
        hash: offer.hash,
        chain: slugChain,
        protocol_address: offer.protocol_address || SEAPORT,
      },
      fulfiller: { address: me },
      consideration: {
        asset_contract_address: contract,
        token_id: tokenId,
      },
      include_optional_creator_fees: optionalFees,
    },
    headers,
    error: "OpenSea",
  });
  const transaction = fulfillmentTransaction(fulfillment);
  const dest = checksum(String(transaction.to));
  if (!SEAPORT_ADDRESSES.has(dest)) {
    throw new WalletError(`OpenSea returned an unexpected fulfillment target: ${dest}`);
  }
  const fn = String(transaction.function || "").trim();
  if (!fn) {
    throw new WalletError("OpenSea fulfillment is missing a function signature");
  }
  const data = encodeCall(fn, transaction.input_data);
  const value = hexInt(transaction.value);

  const fill = async (): Promise<TxResult> => {
    // Every free check has already run; only now do we spend gas.
    await ensureNftApproval(creds, chain, contract, fetchFn);
    return broadcastEvm(creds, chain, dest, value, data, fetchFn);
  };

  const result = await lockedEvm(options.connectionId, chain, fill);
  const line = txLine(result);
  const price = offer.label;
  return price ? `${line}  sold #${tokenId} for ${price}` : line;
}

export async function openseaCollectionOffer(
  creds: Credentials,
  arguments_: Record<string, unknown>,
  options: OpenSeaOptions,
): Promise<string> {
  const fetchFn = httpClient(options);
  const key = await openseaAuth(options.openseaKey, creds, fetchFn);
  const headers = openseaHeaders(key);
  const chain = resolveOpenseaChain(arguments_.chain);
  const slug = String(arguments_.slug || "").trim();
  if (!slug) {
    throw new WalletError("slug is required");
  }
  const quantity = countArg(arguments_.quantity, "quantity");
  const duration = durationSeconds(arguments_.duration_days);
  const wrap = flagArg(arguments_.wrap);
  const optionalFees = flagArg(arguments_.include_optional_fees);
  const currency = String(arguments_.currency || "").trim();
  let bidToken: string;
  if (currency) {
    bidToken = paymentToken(chain, currency);
  } else {
    const defaultWeth = WETH[chain];
    if (!defaultWeth) {
      throw new WalletError(
        `collection offers on ${chain} need an explicit currency: the ` +
          "wrapped-native or stablecoin contract address to bid with",
      );
    }
    bidToken = checksum(defaultWeth);
  }
  const bidDecimals = await erc20Decimals(creds, chain, bidToken, fetchFn);
  const bidLabel = /^[A-Za-z]+$/.test(currency) ? currency.toUpperCase() : shortAddr(bidToken);
  const unitPrice = parseUnits(String(arguments_.price || "").trim(), bidDecimals);
  const total = unitPrice * BigInt(quantity);
  const me = evmAddress(creds);

  const built = await httpJson(fetchFn, "POST", `${OPENSEA_API}/offers/build`, {
    payload: {
      offerer: me,
      quantity,
      criteria: { collection: { slug } },
      protocol_address: SEAPORT,
      offer_protection_enabled: true,
    },
    headers,
    error: "OpenSea",
  });
  const partial =
    built && typeof built === "object" && !Array.isArray(built)
      ? (built as { partialParameters?: unknown }).partialParameters
      : undefined;
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
    throw new WalletError(httpMessage(built, "OpenSea offer build failed"));
  }
  const criteriaItems = (partial as { consideration?: unknown }).consideration;
  if (!Array.isArray(criteriaItems) || !criteriaItems.length) {
    throw new WalletError("OpenSea offer build returned no consideration");
  }

  const collection = await openseaCollection(fetchFn, headers, slug);
  const fees = collectionFees(collection, total, optionalFees);

  // consideration[0..n] is what the build endpoint gave us (the criteria
  // item carrying the merkle root); fee items follow. Whatever the offer
  // does not spend on consideration goes to the seller who fills it.
  const consideration = [
    ...criteriaItems.map((item) => normalizeItem(item, true)),
    ...fees.map(([value, recipient]) =>
      considerationItem(ITEM_ERC20, bidToken, 0n, value, recipient),
    ),
  ];
  const spent = consideration.reduce(
    (sum, item) => (item.itemType === ITEM_ERC20 ? sum + item.startAmount : sum),
    0n,
  );
  if (spent >= total) {
    throw new WalletError("fees consume the whole offer; raise the price");
  }

  const offer = [offerItem(ITEM_ERC20, bidToken, 0n, total)];
  const zone = String((partial as { zone?: unknown }).zone || NATIVE_EVM);
  const zoneHash = String((partial as { zoneHash?: unknown }).zoneHash || ZERO_HASH);
  const restricted = BigInt(zone) !== 0n;
  const start = Math.trunc(Date.now() / 1000);
  const order = seaportOrder({
    offerer: me,
    offer,
    consideration,
    orderType: restricted ? ORDER_PARTIAL_RESTRICTED : ORDER_PARTIAL_OPEN,
    start,
    end: start + duration,
    zone,
    zoneHash,
  });

  await lockedEvm(options.connectionId, chain, () =>
    fundBidToken(creds, chain, bidToken, total, wrap, bidDecimals, fetchFn),
  );
  const counter = await seaportCounter(creds, chain, fetchFn);
  const signature = await signOrder(creds, chain, order, counter);
  const posted = await httpJson(fetchFn, "POST", `${OPENSEA_API}/offers`, {
    payload: {
      criteria: { collection: { slug } },
      protocol_data: {
        parameters: orderParameters(order, counter),
        signature,
      },
      protocol_address: SEAPORT,
    },
    headers,
    error: "OpenSea",
  });
  const orderHash = orderHashOf(posted) || "unknown";
  return orderLine(
    orderHash,
    chain,
    `bid ${formatUnits(unitPrice, bidDecimals)} ${bidLabel} each on ${quantity}x ${slug}`,
    `${OPENSEA_SITE}/collection/${slug}/offers`,
  );
}

export async function openseaCancelOrder(
  creds: Credentials,
  arguments_: Record<string, unknown>,
  options: OpenSeaOptions,
): Promise<string> {
  const fetchFn = httpClient(options);
  const key = await openseaAuth(options.openseaKey, creds, fetchFn);
  const headers = openseaHeaders(key);
  const chain = resolveOpenseaChain(arguments_.chain);
  const orderHash = String(arguments_.order_hash || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(orderHash)) {
    throw new WalletError("order_hash must be a 0x-prefixed 32-byte hash");
  }

  const payload = await httpJson(
    fetchFn,
    "GET",
    `${OPENSEA_API}/orders/chain/${await openseaSlug(fetchFn, headers, chain)}/protocol/${SEAPORT}/${orderHash}`,
    { headers, error: "OpenSea" },
  );
  const parameters = protocolParameters(payload);
  const me = evmAddress(creds);
  const offerer = String(parameters.offerer || "");
  if (!evmIsAddress(offerer) || checksum(offerer) !== me) {
    throw new WalletError("that order was not signed by this wallet");
  }
  let counter = parameters.counter;
  if (counter === null || counter === undefined) {
    counter = await seaportCounter(creds, chain, fetchFn);
  }
  const components = {
    offerer: parameters.offerer,
    zone: parameters.zone || NATIVE_EVM,
    offer: parameters.offer || [],
    consideration: parameters.consideration || [],
    orderType: parameters.orderType ?? 0,
    startTime: parameters.startTime ?? 0,
    endTime: parameters.endTime ?? 0,
    zoneHash: parameters.zoneHash || ZERO_HASH,
    salt: parameters.salt ?? 0,
    conduitKey: parameters.conduitKey || ZERO_HASH,
    counter,
  };
  const data = encodeCall(`cancel(${ORDER_COMPONENTS_TUPLE}[])`, { orders: [components] });
  const result = await lockedEvm(options.connectionId, chain, () =>
    broadcastEvm(creds, chain, SEAPORT, 0n, data, fetchFn),
  );
  return `${txLine(result)}  cancelled ${orderHash}`;
}

// --------------------------------------------------------------------------
// Seaport order construction and signing
// --------------------------------------------------------------------------

type OrderItem = {
  itemType: number;
  token: string;
  identifierOrCriteria: bigint;
  startAmount: bigint;
  endAmount: bigint;
  recipient?: string;
};

type SeaportOrder = {
  offerer: string;
  zone: string;
  offer: OrderItem[];
  consideration: OrderItem[];
  orderType: number;
  startTime: number;
  endTime: number;
  zoneHash: string;
  salt: bigint;
  conduitKey: string;
};

type TxResult = { hash: string; chain: string; explorer: string };

function seaportOrder(args: {
  offerer: string;
  offer: OrderItem[];
  consideration: OrderItem[];
  orderType: number;
  start: number;
  end: number;
  zone?: string;
  zoneHash?: string;
}): SeaportOrder {
  return {
    offerer: checksum(args.offerer),
    zone: checksum(args.zone ?? NATIVE_EVM),
    offer: args.offer,
    consideration: args.consideration,
    orderType: Number(args.orderType),
    startTime: Math.trunc(args.start),
    endTime: Math.trunc(args.end),
    zoneHash: args.zoneHash ?? ZERO_HASH,
    salt: randBits96(),
    conduitKey: CONDUIT_KEY,
  };
}

function offerItem(
  itemType: number,
  token: string,
  identifier: bigint,
  start: bigint,
  end?: bigint,
): OrderItem {
  return {
    itemType: Number(itemType),
    token: checksum(token),
    identifierOrCriteria: identifier,
    startAmount: start,
    endAmount: end === undefined ? start : end,
  };
}

function considerationItem(
  itemType: number,
  token: string,
  identifier: bigint,
  start: bigint,
  recipient: string,
  end?: bigint,
): OrderItem {
  const item = offerItem(itemType, token, identifier, start, end);
  item.recipient = checksum(recipient);
  return item;
}

function normalizeItem(raw: unknown, consideration: boolean): OrderItem {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WalletError("OpenSea returned a malformed order item");
  }
  const row = raw as Record<string, unknown>;
  const item: OrderItem = {
    itemType: Number(hexInt(row.itemType)),
    token: checksum(String(row.token || NATIVE_EVM)),
    identifierOrCriteria: hexInt(row.identifierOrCriteria),
    startAmount: hexInt(row.startAmount),
    endAmount: hexInt(row.endAmount),
  };
  if (consideration) {
    item.recipient = checksum(String(row.recipient || NATIVE_EVM));
  }
  return item;
}

async function signOrder(
  creds: Credentials,
  chain: string,
  order: SeaportOrder,
  counter: bigint | number,
): Promise<string> {
  const account = privateKeyToAccount(creds.evm_private_key as Hex);
  const message = {
    offerer: order.offerer as Address,
    zone: order.zone as Address,
    offer: order.offer.map((item) => ({
      itemType: item.itemType,
      token: item.token as Address,
      identifierOrCriteria: item.identifierOrCriteria,
      startAmount: item.startAmount,
      endAmount: item.endAmount,
    })),
    consideration: order.consideration.map((item) => ({
      itemType: item.itemType,
      token: item.token as Address,
      identifierOrCriteria: item.identifierOrCriteria,
      startAmount: item.startAmount,
      endAmount: item.endAmount,
      recipient: (item.recipient ?? NATIVE_EVM) as Address,
    })),
    orderType: order.orderType,
    startTime: BigInt(order.startTime),
    endTime: BigInt(order.endTime),
    zoneHash: bytes32Hex(order.zoneHash),
    salt: order.salt,
    conduitKey: bytes32Hex(order.conduitKey),
    counter: BigInt(counter),
  };
  return account.signTypedData({
    types: SEAPORT_TYPES,
    primaryType: "OrderComponents",
    domain: {
      name: "Seaport",
      version: SEAPORT_VERSION,
      chainId: mustEvm(chain).chain_id,
      verifyingContract: SEAPORT,
    },
    message,
  });
}

function orderParameters(order: SeaportOrder, counter: bigint | number): Record<string, unknown> {
  return {
    offerer: order.offerer,
    zone: order.zone,
    offer: order.offer.map(jsonItem),
    consideration: order.consideration.map(jsonItem),
    orderType: order.orderType,
    startTime: String(order.startTime),
    endTime: String(order.endTime),
    zoneHash: hexStr(bytes32Hex(order.zoneHash)),
    salt: String(order.salt),
    conduitKey: hexStr(bytes32Hex(order.conduitKey)),
    totalOriginalConsiderationItems: order.consideration.length,
    counter: String(BigInt(counter)),
  };
}

function jsonItem(item: OrderItem): Record<string, unknown> {
  const out: Record<string, unknown> = {
    itemType: Number(item.itemType),
    token: item.token,
    identifierOrCriteria: String(item.identifierOrCriteria),
    startAmount: String(item.startAmount),
    endAmount: String(item.endAmount),
  };
  if (item.recipient !== undefined) {
    out.recipient = item.recipient;
  }
  return out;
}

async function seaportCounter(
  creds: Credentials,
  chain: string,
  fetchFn: FetchFn,
): Promise<bigint> {
  const raw = await evmRpcCall(fetchFn, evmRpc(chain, creds.alchemy_key), "eth_call", [
    {
      to: SEAPORT,
      data: calldata("getCounter(address)", ["address"], [evmAddress(creds)]),
    },
    "latest",
  ]);
  return hexInt(raw);
}

async function ensureNftApproval(
  creds: Credentials,
  chain: string,
  contract: string,
  fetchFn: FetchFn,
): Promise<void> {
  const url = evmRpc(chain, creds.alchemy_key);
  const data = calldata(
    "isApprovedForAll(address,address)",
    ["address", "address"],
    [evmAddress(creds), OPENSEA_CONDUIT],
  );
  const raw = await evmRpcCall(fetchFn, url, "eth_call", [{ to: contract, data }, "latest"]);
  if (hexInt(raw) !== 0n) {
    return;
  }
  const approve = calldata(
    "setApprovalForAll(address,bool)",
    ["address", "bool"],
    [OPENSEA_CONDUIT, true],
  );
  await broadcastEvm(creds, chain, contract, 0n, approve, fetchFn);
}

async function fundBidToken(
  creds: Credentials,
  chain: string,
  weth: string,
  amount: bigint,
  wrap: boolean,
  decimals: number,
  fetchFn: FetchFn,
): Promise<void> {
  const url = evmRpc(chain, creds.alchemy_key);
  const me = evmAddress(creds);
  const raw = await evmRpcCall(fetchFn, url, "eth_call", [
    { to: weth, data: calldata("balanceOf(address)", ["address"], [me]) },
    "latest",
  ]);
  const balance = hexInt(raw);
  if (balance < amount) {
    const shortfall = amount - balance;
    const wrappedNative = WETH[chain];
    const canWrap = wrappedNative !== undefined && checksum(wrappedNative) === checksum(weth);
    if (!wrap || !canWrap) {
      const hint = canWrap
        ? 'Pass wrap="true" to wrap the difference from the native coin.'
        : "Fund the wallet with that token first.";
      throw new WalletError(
        `balance of ${shortAddr(weth)} is ${formatUnits(balance, decimals)}, ` +
          `need ${formatUnits(amount, decimals)}. ${hint}`,
      );
    }
    await broadcastEvm(creds, chain, weth, shortfall, calldata("deposit()", [], []), fetchFn);
  }
  await ensureAllowance(creds, chain, weth, OPENSEA_CONDUIT, amount, fetchFn);
}

// --------------------------------------------------------------------------
// OpenSea reads
// --------------------------------------------------------------------------

const openseaAutoKey: { key: string; at: number } = { key: "", at: 0 };

function openseaKeyOf(openseaKey: unknown, creds: Credentials | null): string {
  // First key found among the argument, the credentials, the environment.
  for (const candidate of [openseaKey, creds?.opensea_key, process.env[OPENSEA_KEY_ENV]]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  const cached = openseaAutoKey;
  if (cached.key && monotonicSeconds() - cached.at < OPENSEA_AUTO_KEY_TTL) {
    return String(cached.key);
  }
  return "";
}

async function openseaInstantKey(fetchFn: FetchFn): Promise<string> {
  // Free-tier key, no signup. Opt-in: it mints a credential as a side
  // effect, so the operator has to ask for it. Low write limits and a short
  // expiry -- fine to unblock an agent, not a substitute for a real key.
  let payload: unknown;
  try {
    payload = await httpJson(fetchFn, "POST", OPENSEA_KEYS_URL, { error: "OpenSea" });
  } catch (error) {
    if (error instanceof WalletError) {
      return "";
    }
    throw error;
  }
  const key =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { api_key?: unknown }).api_key
      : undefined;
  if (typeof key !== "string" || !key.trim()) {
    return "";
  }
  openseaAutoKey.key = key.trim();
  openseaAutoKey.at = monotonicSeconds();
  return key.trim();
}

async function openseaAuth(
  openseaKey: string | null | undefined,
  creds: Credentials | null,
  fetchFn?: FetchFn,
): Promise<string> {
  let key = openseaKeyOf(openseaKey, creds);
  if (key) {
    return key;
  }
  const wantsAuto = ["1", "true", "yes"].includes(
    String(process.env[OPENSEA_AUTO_KEY_ENV] || "")
      .trim()
      .toLowerCase(),
  );
  if (wantsAuto && fetchFn) {
    key = await openseaInstantKey(fetchFn);
    if (key) {
      return key;
    }
  }
  throw new WalletError(
    "no OpenSea API key. These tools authenticate with an API key in the " +
      "X-API-KEY header, not a browser login. Checked, in order: the " +
      "opensea_key argument to call_tool, Credentials.opensea_key, and the " +
      `${OPENSEA_KEY_ENV} environment variable -- all empty. Set one of ` +
      `them, or set ${OPENSEA_AUTO_KEY_ENV}=true to mint a free-tier key ` +
      "automatically. Permanent keys: opensea.io/settings/developer",
  );
}

const openseaChainsCache: { at: number; slugs: Set<string> } = { at: 0, slugs: new Set() };

async function openseaChainSlugs(
  fetchFn: FetchFn,
  headers: Record<string, string>,
): Promise<Set<string>> {
  const now = monotonicSeconds();
  const cached = openseaChainsCache.slugs;
  if (cached.size && now - openseaChainsCache.at < OPENSEA_CHAINS_TTL) {
    return cached;
  }
  let payload: unknown;
  try {
    payload = await httpJson(fetchFn, "GET", OPENSEA_CHAINS_URL, { headers, error: "OpenSea" });
  } catch (error) {
    if (error instanceof WalletError) {
      return new Set();
    }
    throw error;
  }
  const rows =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { chains?: unknown }).chains
      : undefined;
  const slugs = new Set(
    (Array.isArray(rows) ? rows : [])
      .filter(
        (row): row is Record<string, unknown> =>
          Boolean(row) && typeof row === "object" && !Array.isArray(row),
      )
      .map((row) => row.chain)
      .filter((chain): chain is string => typeof chain === "string" && Boolean(chain)),
  );
  if (slugs.size) {
    openseaChainsCache.slugs = slugs;
    openseaChainsCache.at = now;
  }
  return slugs;
}

async function openseaSlug(
  fetchFn: FetchFn,
  headers: Record<string, string>,
  chain: string,
): Promise<string> {
  // Our chain key -> the slug OpenSea wants in its URLs.
  //
  // Resolved against the live list so chains OpenSea adds after this file
  // was written just work. If the list can't be fetched we pass the key
  // through and let OpenSea answer, rather than refusing locally on a
  // hardcoded set that is guaranteed to go stale.
  const slugs = await openseaChainSlugs(fetchFn, headers);
  if (!slugs.size) {
    return chain;
  }
  for (const candidate of [chain, OPENSEA_SLUG_ALIASES[chain]]) {
    if (candidate && slugs.has(candidate)) {
      return candidate;
    }
  }
  throw new WalletError(
    `OpenSea does not currently list ${chain}. It covers: ${[...slugs].sort().join(", ")}`,
  );
}

function paymentToken(chain: string, currency: unknown): string {
  const text = String(currency || "").trim();
  if (text.toUpperCase() === "WETH") {
    const weth = WETH[chain];
    if (!weth) {
      throw new WalletError(
        `no known WETH address on ${chain}; pass the ERC-20 contract ` +
          "address as currency instead",
      );
    }
    return checksum(weth);
  }
  const token = resolveToken(chain, text);
  if (token === null) {
    throw new WalletError("currency is required");
  }
  return checksum(token);
}

async function erc20Decimals(
  creds: Credentials,
  chain: string,
  token: string,
  fetchFn: FetchFn,
): Promise<number> {
  const raw = await evmRpcCall(fetchFn, evmRpc(chain, creds.alchemy_key), "eth_call", [
    { to: token, data: calldata("decimals()", [], []) },
    "latest",
  ]);
  return Number(hexInt(raw));
}

function openseaHeaders(key: string): Record<string, string> {
  return {
    "X-API-KEY": key,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function openseaContractCollection(
  fetchFn: FetchFn,
  headers: Record<string, string>,
  chain: string,
  contract: string,
): Promise<string> {
  const payload = await httpJson(
    fetchFn,
    "GET",
    `${OPENSEA_API}/chain/${chain}/contract/${contract}`,
    { headers, error: "OpenSea" },
  );
  const slug =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { collection?: unknown }).collection
      : undefined;
  if (typeof slug !== "string" || !slug.trim()) {
    throw new WalletError(httpMessage(payload, "OpenSea does not know that contract"));
  }
  return slug.trim();
}

async function openseaNft(
  fetchFn: FetchFn,
  headers: Record<string, string>,
  chain: string,
  contract: string,
  tokenId: string,
): Promise<Record<string, unknown>> {
  const payload = await httpJson(
    fetchFn,
    "GET",
    `${OPENSEA_API}/chain/${chain}/contract/${contract}/nfts/${tokenId}`,
    { headers, error: "OpenSea" },
  );
  const nft =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { nft?: unknown }).nft
      : undefined;
  if (!nft || typeof nft !== "object" || Array.isArray(nft)) {
    throw new WalletError(httpMessage(payload, "OpenSea does not know that NFT"));
  }
  return nft as Record<string, unknown>;
}

async function openseaCollection(
  fetchFn: FetchFn,
  headers: Record<string, string>,
  slug: string,
): Promise<Record<string, unknown>> {
  if (!slug) {
    return {};
  }
  const payload = await httpJson(fetchFn, "GET", `${OPENSEA_API}/collections/${slug}`, {
    headers,
    error: "OpenSea",
  });
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function collectionFees(
  collection: unknown,
  amount: bigint,
  optional: boolean,
): Array<[bigint, string]> {
  const rows =
    collection && typeof collection === "object" && !Array.isArray(collection)
      ? (collection as { fees?: unknown }).fees
      : undefined;
  const out: Array<[bigint, string]> = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const item = row as Record<string, unknown>;
    const recipient = item.recipient;
    if (typeof recipient !== "string" || !evmIsAddress(recipient)) {
      continue;
    }
    if (!item.required && !optional) {
      continue;
    }
    let bps: number;
    try {
      bps = Math.round(Number(item.fee || 0) * 100);
    } catch {
      continue;
    }
    if (!Number.isFinite(bps) || bps <= 0) {
      continue;
    }
    const value = (amount * BigInt(bps)) / 10_000n;
    if (value > 0n) {
      out.push([value, checksum(recipient)]);
    }
  }
  return out;
}

async function bestOffer(
  fetchFn: FetchFn,
  headers: Record<string, string>,
  chain: string,
  slug: string,
  contract: string,
  tokenId: string,
): Promise<
  Record<string, unknown> & {
    hash: string;
    protocol_address: string;
    label: string;
    value: bigint | null;
    decimals: number;
    symbol: string;
  }
> {
  // The per-NFT "best" endpoint is the only one that surfaces
  // collection-wide offers, which are most of the real bids.
  if (slug) {
    try {
      const payload = await httpJson(
        fetchFn,
        "GET",
        `${OPENSEA_API}/offers/collection/${slug}/nfts/${tokenId}/best`,
        { headers, error: "OpenSea" },
      );
      const row = offerRow(payload);
      if (row !== null) {
        return row;
      }
    } catch (error) {
      if (!(error instanceof WalletError)) {
        throw error;
      }
    }
  }
  const payload = await httpJson(fetchFn, "GET", `${OPENSEA_API}/orders/${chain}/seaport/offers`, {
    params: {
      asset_contract_address: contract,
      token_ids: tokenId,
      order_by: "eth_price",
      order_direction: "desc",
      limit: "1",
    },
    headers,
    error: "OpenSea",
  });
  const row = offerRow(payload);
  if (row !== null) {
    return row;
  }
  throw new WalletError("no active offer for that NFT");
}

function offerRow(
  payload: unknown,
):
  | (Record<string, unknown> & {
      hash: string;
      protocol_address: string;
      label: string;
      value: bigint | null;
      decimals: number;
      symbol: string;
    })
  | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  let candidate: unknown = payload;
  const body = payload as Record<string, unknown>;
  if (!body.order_hash && !body.hash) {
    for (const key of ["orders", "offers", "order", "offer"]) {
      const nested = body[key];
      if (Array.isArray(nested) && nested.length) {
        candidate = nested[0];
        break;
      }
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        candidate = nested;
        break;
      }
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const row = candidate as Record<string, unknown>;
  const orderHash = row.order_hash || row.hash;
  if (typeof orderHash !== "string" || !orderHash) {
    return null;
  }
  const protocol = row.protocol_address;
  const price = row.price;
  let raw: unknown;
  let decimals = 18;
  let symbol = "WETH";
  if (price && typeof price === "object" && !Array.isArray(price)) {
    const priced = price as Record<string, unknown>;
    raw = priced.value;
    decimals = Number(hexInt(priced.decimals)) || 18;
    symbol = String(priced.currency || symbol);
  } else if (row.current_price !== null && row.current_price !== undefined) {
    raw = row.current_price;
  }
  const value = raw !== null && raw !== undefined ? hexInt(raw) : null;
  return {
    hash: orderHash,
    protocol_address: typeof protocol === "string" && evmIsAddress(protocol) ? protocol : "",
    value,
    decimals,
    symbol,
    label: value !== null ? `${formatUnits(value, decimals)} ${symbol}` : "",
  };
}

function checkMinPrice(
  offer: { value: bigint | null; decimals: number; symbol: string },
  minimum: unknown,
): void {
  if (minimum === null || minimum === undefined || String(minimum).trim() === "") {
    return;
  }
  const decimals = Number(offer.decimals || 18);
  const floor = parseUnits(String(minimum).trim(), decimals);
  const value = offer.value;
  if (typeof value !== "bigint") {
    throw new WalletError("cannot verify the offer price; refusing to accept");
  }
  if (value < floor) {
    throw new WalletError(
      `best offer is ${formatUnits(value, decimals)} ${String(offer.symbol || "").trim()}` +
        `, below the ${String(minimum).trim()} minimum`,
    );
  }
}

function fulfillmentTransaction(payload: unknown): Record<string, unknown> {
  const data =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { fulfillment_data?: unknown }).fulfillment_data
      : undefined;
  const transaction =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as { transaction?: unknown }).transaction
      : undefined;
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
    throw new WalletError(httpMessage(payload, "OpenSea fulfillment failed"));
  }
  if (typeof (transaction as { to?: unknown }).to !== "string") {
    throw new WalletError("OpenSea fulfillment is missing a target address");
  }
  return transaction as Record<string, unknown>;
}

function protocolParameters(payload: unknown): Record<string, unknown> {
  let order: unknown = payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const nested = (payload as { order?: unknown }).order;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      order = nested;
    }
  }
  const protocol =
    order && typeof order === "object" && !Array.isArray(order)
      ? (order as { protocol_data?: unknown }).protocol_data
      : undefined;
  const parameters =
    protocol && typeof protocol === "object" && !Array.isArray(protocol)
      ? (protocol as { parameters?: unknown }).parameters
      : undefined;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new WalletError(httpMessage(payload, "OpenSea does not know that order"));
  }
  return parameters as Record<string, unknown>;
}

// --------------------------------------------------------------------------
// ABI encoding of OpenSea fulfillment data
// --------------------------------------------------------------------------

function encodeCall(functionSig: string, inputData: unknown): string {
  const signature = String(functionSig).replace(/\s+/g, "");
  const nameEnd = signature.indexOf("(");
  const name = nameEnd >= 0 ? signature.slice(0, nameEnd) : "";
  const rest = nameEnd >= 0 ? signature.slice(nameEnd + 1) : "";
  if (!name || !rest.endsWith(")")) {
    throw new WalletError(`unparseable function signature: ${functionSig}`);
  }
  const types = splitTypes(rest.slice(0, -1));
  const values = tupleValues(inputData, types);
  if (values.length !== types.length) {
    throw new WalletError("fulfillment argument count does not match the signature");
  }
  const encoded = types.map((kind, index) => abiValue(kind ?? "", values[index]));
  return concat([selector(signature), abiEncode(types, encoded)]);
}

function splitTypes(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current: string[] = [];
  for (const char of text) {
    if (char === "(" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth -= 1;
    }
    if (char === "," && depth === 0) {
      parts.push(current.join("").trim());
      current = [];
      continue;
    }
    current.push(char);
  }
  const tail = current.join("").trim();
  if (tail) {
    parts.push(tail);
  }
  return parts;
}

function tupleValues(value: unknown, types: string[]): unknown[] {
  if (Array.isArray(value)) {
    return [...value];
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const order = STRUCT_FIELDS.get(frozensetKey(Object.keys(row)));
    if (order !== undefined) {
      return order.map((name) => row[name]);
    }
    if (Object.keys(row).length === types.length) {
      // JSON preserves the order OpenSea emitted, which is ABI order.
      return Object.values(row);
    }
  }
  throw new WalletError("unexpected fulfillment data shape");
}

function abiValue(kind: string, value: unknown): unknown {
  const trimmed = kind.trim();
  if (trimmed.endsWith("]")) {
    const base = trimmed.slice(0, trimmed.lastIndexOf("["));
    return [...(Array.isArray(value) ? value : [])].map((item) => abiValue(base, item));
  }
  if (trimmed.startsWith("(")) {
    const inner = splitTypes(trimmed.slice(1, -1));
    const items = tupleValues(value, inner);
    if (items.length !== inner.length) {
      throw new WalletError("fulfillment struct does not match the signature");
    }
    return inner.map((sub, index) => abiValue(sub ?? "", items[index]));
  }
  if (trimmed.startsWith("uint") || trimmed.startsWith("int")) {
    return hexInt(value);
  }
  if (trimmed === "address") {
    return checksum(String(value));
  }
  if (trimmed === "bool") {
    return Boolean(value);
  }
  if (trimmed === "bytes" || /^bytes\d+$/.test(trimmed)) {
    let raw = toBytes(value);
    const match = /^bytes(\d+)$/.exec(trimmed);
    if (match) {
      const width = Number(match[1]);
      if (raw.length > width) {
        throw new WalletError(`value overflows ${trimmed}`);
      }
      raw = Buffer.concat([Buffer.alloc(width - raw.length), raw]);
    }
    return toHex(raw);
  }
  if (trimmed === "string") {
    return String(value);
  }
  throw new WalletError(`unsupported ABI type: ${trimmed}`);
}

function abiEncode(types: string[], values: unknown[]): Hex {
  if (!types.length) {
    return "0x";
  }
  return encodeAbiParameters(parseAbiParameters(types.join(",")), values as never);
}

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

function requireStr(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WalletError(`${name} is required`);
  }
  return value.trim();
}

function optionalStr(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function uniswapHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function uniswapTradeHeaders(apiKey: string): Record<string, string> {
  return {
    ...uniswapHeaders(apiKey),
    "x-permit2-disabled": "true",
  };
}

function nftContract(value: unknown): string {
  const text = String(value || "").trim();
  if (!evmIsAddress(text)) {
    throw new WalletError(`Invalid NFT contract: ${text}`);
  }
  return checksum(text);
}

function tokenIdArg(value: unknown): string {
  const text = String(value || "").trim();
  if (!/^\d+$/.test(text)) {
    throw new WalletError("token_id must be a decimal integer");
  }
  return text;
}

function countArg(value: unknown, name: string, defaultValue = 1): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    return defaultValue;
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text) || Number.parseInt(text, 10) <= 0) {
    throw new WalletError(`${name} must be a positive integer`);
  }
  return Number.parseInt(text, 10);
}

function flagArg(value: unknown, defaultValue = false): boolean {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const text = String(value).trim().toLowerCase();
  if (text === "") {
    return defaultValue;
  }
  if (text === "true" || text === "1" || text === "yes") {
    return true;
  }
  if (text === "false" || text === "0" || text === "no") {
    return false;
  }
  throw new WalletError(`expected true or false, got "${value}"`);
}

function durationSeconds(value: unknown): number {
  let days: number;
  if (value === null || value === undefined || String(value).trim() === "") {
    days = ORDER_DEFAULT_DAYS;
  } else {
    const text = String(value).trim();
    if (AMOUNT.exec(text)?.[0] !== text) {
      throw new WalletError(`duration_days must be a number, got "${value}"`);
    }
    days = Number(text);
  }
  if (days <= 0) {
    throw new WalletError("duration_days must be greater than 0");
  }
  if (days > ORDER_MAX_DAYS) {
    throw new WalletError(`duration_days must be at most ${ORDER_MAX_DAYS}`);
  }
  return Math.max(60, Math.trunc(days * 86_400));
}

function toBytes(value: unknown): Buffer {
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  let text = String(value !== null && value !== undefined ? value : "0x").trim();
  if (text.startsWith("0x") || text.startsWith("0X")) {
    text = text.slice(2);
  }
  if (!text) {
    return Buffer.alloc(0);
  }
  if (text.length % 2) {
    text = `0${text}`;
  }
  try {
    return Buffer.from(text, "hex");
  } catch {
    throw new WalletError("expected hex bytes");
  }
}

function bytes32Hex(value: unknown): Hex {
  const raw = toBytes(value);
  if (raw.length > 32) {
    throw new WalletError("value overflows bytes32");
  }
  return toHex(Buffer.concat([Buffer.alloc(32 - raw.length), raw]));
}

function hexStr(value: unknown): string {
  if (typeof value === "string") {
    return value.startsWith("0x") ? value : `0x${value}`;
  }
  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString("hex")}`;
  }
  const text = String(value);
  return text.startsWith("0x") ? text : `0x${text}`;
}

function orderHashOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const body = payload as Record<string, unknown>;
  for (const key of ["order_hash", "hash"]) {
    const value = body[key];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  for (const key of ["order", "offer", "listing", "protocol_data"]) {
    const found = orderHashOf(body[key]);
    if (found) {
      return found;
    }
  }
  return null;
}

function orderLine(orderHash: string, chain: string, detail: string, url: string): string {
  return `${orderHash}  ${chain}  ${detail}  ${url}`;
}

function solanaKeypair(value: string): Keypair {
  const text = value.trim();
  if (text.startsWith("[")) {
    let loaded: unknown;
    try {
      loaded = JSON.parse(text.replace(/,\s*]/, "]"));
    } catch {
      throw new WalletError("solana_private_key is invalid");
    }
    if (!Array.isArray(loaded) || !loaded.length) {
      throw new WalletError("solana_private_key is invalid");
    }
    if (
      !loaded.every(
        (item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255,
      )
    ) {
      throw new WalletError("solana_private_key is invalid");
    }
    const raw = Buffer.from(loaded);
    try {
      if (raw.length === 64) {
        return Keypair.fromSecretKey(raw);
      }
      if (raw.length === 32) {
        return Keypair.fromSeed(raw);
      }
    } catch {
      throw new WalletError("solana_private_key is invalid");
    }
    throw new WalletError("solana_private_key is invalid");
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(text));
  } catch {
    throw new WalletError("solana_private_key is invalid");
  }
}

function normalizedEvmKey(value: string): Hex {
  const text = value.trim();
  const hex = (text.startsWith("0x") || text.startsWith("0X") ? text : `0x${text}`) as Hex;
  try {
    privateKeyToAccount(hex);
  } catch {
    throw new WalletError("evm_private_key is invalid");
  }
  return hex.toLowerCase() as Hex;
}

function shortAddr(address: string): string {
  if (address.length <= 12) {
    return address;
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function lockFor(key: string): AsyncLock {
  let lock = locks.get(key);
  if (!lock) {
    lock = new AsyncLock();
    locks.set(key, lock);
  }
  return lock;
}

function lockedEvm<T>(connectionId: string, chain: string, action: () => Promise<T>): Promise<T> {
  return lockFor(`${connectionId}:${chain}`).run(action);
}

function txLine(result: TxResult): string {
  return `${result.hash}  ${result.chain}  ${result.explorer}`;
}

function selector(signature: string): Hex {
  return keccak256(stringToHex(signature)).slice(0, 10) as Hex;
}

function calldata(signature: string, types: string[], values: unknown[]): string {
  const encoded = types.length ? abiEncode(types, values) : "0x";
  return concat([selector(signature), encoded]);
}

function mustEvm(chain: string): EvmChainSpec {
  const spec = EVM_CHAINS[chain];
  if (!spec) {
    throw new WalletError(`unknown chain '${chain}'. Known: ${CHAIN_NAMES.join(", ")}`);
  }
  return spec;
}

function evmIsAddress(text: string): boolean {
  const value = text.startsWith("0x") || text.startsWith("0X") ? text : `0x${text}`;
  return isAddress(value, { strict: false });
}

function checksum(text: string): Address {
  const value = text.startsWith("0x") || text.startsWith("0X") ? text : `0x${text}`;
  return checksumAddress(value);
}

function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "string") {
    return `'${value}'`;
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  return String(value);
}

function monotonicSeconds(): number {
  return performance.now() / 1000;
}

function randBits96(): bigint {
  return BigInt(`0x${randomBytes(12).toString("hex")}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function intToHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

async function evmBalance(
  creds: Credentials,
  chain: string,
  token: string | null,
  fetchFn: FetchFn,
): Promise<string> {
  const url = evmRpc(chain, creds.alchemy_key);
  const me = evmAddress(creds);
  if (token === null) {
    const raw = await evmRpcCall(fetchFn, url, "eth_getBalance", [me, "latest"]);
    return formatUnits(hexInt(raw), mustEvm(chain).decimals);
  }
  const checksummed = checksum(token);
  const balanceData = calldata("balanceOf(address)", ["address"], [me]);
  const decimalsData = calldata("decimals()", [], []);
  const [raw, decimalsHex] = await Promise.all([
    evmRpcCall(fetchFn, url, "eth_call", [{ to: checksummed, data: balanceData }, "latest"]),
    evmRpcCall(fetchFn, url, "eth_call", [{ to: checksummed, data: decimalsData }, "latest"]),
  ]);
  return formatUnits(hexInt(raw), Number(hexInt(decimalsHex)));
}

async function sendEvm(
  creds: Credentials,
  chain: string,
  to: string,
  amount: string,
  token: string | null,
  fetchFn: FetchFn,
): Promise<TxResult> {
  if (!evmIsAddress(to)) {
    throw new WalletError(`Invalid EVM address: ${to}`);
  }
  const destTo = checksum(to);
  const url = evmRpc(chain, creds.alchemy_key);
  const spec = mustEvm(chain);
  let value: bigint;
  let data: string;
  let dest: string;
  if (token === null) {
    value = parseUnits(amount, spec.decimals);
    data = "0x";
    dest = destTo;
  } else {
    const checksummed = checksum(token);
    const decimalsHex = await evmRpcCall(fetchFn, url, "eth_call", [
      { to: checksummed, data: calldata("decimals()", [], []) },
      "latest",
    ]);
    value = parseUnits(amount, Number(hexInt(decimalsHex)));
    data = calldata("transfer(address,uint256)", ["address", "uint256"], [destTo, value]);
    dest = checksummed;
    value = 0n;
  }
  return broadcastEvm(creds, chain, dest, value, data, fetchFn);
}

async function broadcastEvm(
  creds: Credentials,
  chain: string,
  dest: string,
  value: bigint,
  data: string,
  fetchFn: FetchFn,
): Promise<TxResult> {
  const checksummed = checksum(dest);
  const url = evmRpc(chain, creds.alchemy_key);
  const account = privateKeyToAccount(creds.evm_private_key as Hex);
  const me = account.address;
  const spec = mustEvm(chain);
  const [nonceHex, priorityHex, block, gasHex] = await Promise.all([
    evmRpcCall(fetchFn, url, "eth_getTransactionCount", [me, "pending"]),
    evmRpcCall(fetchFn, url, "eth_maxPriorityFeePerGas", []),
    evmRpcCall(fetchFn, url, "eth_getBlockByNumber", ["latest", false]),
    evmRpcCall(fetchFn, url, "eth_estimateGas", [
      { from: me, to: checksummed, value: intToHex(value), data },
    ]),
  ]);
  if (
    !block ||
    typeof block !== "object" ||
    Array.isArray(block) ||
    !(block as { baseFeePerGas?: unknown }).baseFeePerGas
  ) {
    throw new WalletError("latest block is missing baseFeePerGas");
  }
  const priority = hexInt(priorityHex);
  const baseFee = hexInt((block as { baseFeePerGas: unknown }).baseFeePerGas);
  const gas = hexInt(gasHex);
  const smallBlockGas = spec.small_block_gas;
  if (smallBlockGas !== undefined && gas > BigInt(smallBlockGas)) {
    throw new WalletError(
      `this call needs ${gas} gas, above the ${chain} small-block limit of ` +
        `${smallBlockGas}. Switch the wallet to big blocks first with the ` +
        'HyperCore action {"type": "evmUserModify", "usingBigBlocks": true}.',
    );
  }
  const signed = await account.signTransaction({
    type: "eip1559",
    chainId: spec.chain_id,
    nonce: Number(hexInt(nonceHex)),
    maxFeePerGas: baseFee * 2n + priority,
    maxPriorityFeePerGas: priority,
    gas,
    to: checksummed,
    value,
    data: data as Hex,
  });
  const txHash = String(await evmRpcCall(fetchFn, url, "eth_sendRawTransaction", [signed]));
  const receipt = await waitEvmReceipt(fetchFn, url, txHash);
  const status = receipt.status;
  if (status === "0x0" || status === 0) {
    throw new WalletError(`Transaction reverted: ${txHash}`);
  }
  return {
    hash: txHash,
    chain,
    explorer: `${spec.explorer}/tx/${txHash}`,
  };
}

async function waitEvmReceipt(
  fetchFn: FetchFn,
  url: string,
  txHash: string,
): Promise<Record<string, unknown>> {
  const deadline = monotonicSeconds() + RECEIPT_SECONDS;
  while (monotonicSeconds() < deadline) {
    const receipt = await evmRpcCall(fetchFn, url, "eth_getTransactionReceipt", [txHash]);
    if (receipt && typeof receipt === "object" && !Array.isArray(receipt)) {
      return receipt as Record<string, unknown>;
    }
    await sleep(2000);
  }
  throw new WalletError(`timed out waiting for ${txHash}`);
}

async function solanaBalance(
  creds: Credentials,
  mint: string | null,
  fetchFn: FetchFn,
): Promise<string> {
  const url = solanaRpc(creds.alchemy_key);
  const me = Keypair.fromSecretKey(bs58.decode(creds.solana_private_key)).publicKey;
  if (mint === null) {
    const raw = await solRpcCall(fetchFn, url, "getBalance", [
      me.toBase58(),
      { commitment: "confirmed" },
    ]);
    const lamports =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as { value?: unknown }).value
        : raw;
    return formatUnits(hexInt(lamports), 9);
  }
  const mintPk = new PublicKey(mint);
  const ata = associatedToken(me, mintPk);
  const [info, mintInfo] = await Promise.all([
    solRpcCall(fetchFn, url, "getAccountInfo", [
      ata.toBase58(),
      { encoding: "base64", commitment: "confirmed" },
    ]),
    solRpcCall(fetchFn, url, "getAccountInfo", [
      mintPk.toBase58(),
      { encoding: "base64", commitment: "confirmed" },
    ]),
  ]);
  const mintData = accountBytes(mintInfo);
  if (mintData === null || mintData.length <= 44) {
    throw new WalletError(`mint not found: ${mint}`);
  }
  const decimals = mintData[44] ?? 0;
  const tokenData = accountBytes(info);
  if (tokenData === null) {
    return "0";
  }
  const amount = tokenData.length >= 72 ? tokenData.readBigUInt64LE(64) : 0n;
  return formatUnits(amount, decimals);
}

async function sendSolana(
  creds: Credentials,
  to: string,
  amount: string,
  mint: string | null,
  fetchFn: FetchFn,
): Promise<TxResult> {
  let recipient: PublicKey;
  try {
    recipient = new PublicKey(to);
  } catch {
    throw new WalletError(`Invalid Solana address: ${to}`);
  }
  const url = solanaRpc(creds.alchemy_key);
  const payer = Keypair.fromSecretKey(bs58.decode(creds.solana_private_key));
  let ixs: TransactionInstruction[];
  if (mint === null) {
    const lamports = parseUnits(amount, 9);
    ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await priorityFee(fetchFn, url) }),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports,
      }),
    ];
  } else {
    const mintPk = new PublicKey(mint);
    const mintInfo = await solRpcCall(fetchFn, url, "getAccountInfo", [
      mintPk.toBase58(),
      { encoding: "base64", commitment: "confirmed" },
    ]);
    const mintData = accountBytes(mintInfo);
    if (mintData === null || mintData.length <= 44) {
      throw new WalletError(`mint not found: ${mint}`);
    }
    const decimals = mintData[44] ?? 0;
    const raw = parseUnits(amount, decimals);
    const source = associatedToken(payer.publicKey, mintPk);
    const dest = associatedToken(recipient, mintPk);
    ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await priorityFee(fetchFn, url) }),
      createAtaIdempotent(payer.publicKey, dest, recipient, mintPk),
      transferChecked(source, mintPk, dest, payer.publicKey, raw, decimals),
    ];
  }
  const blockhashRaw = await solRpcCall(fetchFn, url, "getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);
  const tx = new Transaction();
  tx.recentBlockhash = blockhashOf(blockhashRaw);
  tx.feePayer = payer.publicKey;
  tx.add(...ixs);
  tx.sign(payer);
  const encoded = Buffer.from(tx.serialize()).toString("base64");
  return broadcastSolana(fetchFn, url, encoded);
}

async function broadcastSolana(fetchFn: FetchFn, url: string, encoded: string): Promise<TxResult> {
  const sig = await solRpcCall(fetchFn, url, "sendTransaction", [
    encoded,
    {
      encoding: "base64",
      preflightCommitment: "confirmed",
      maxRetries: 3,
    },
  ]);
  await waitSolana(fetchFn, url, String(sig));
  return {
    hash: String(sig),
    chain: "solana",
    explorer: `https://solscan.io/tx/${sig}`,
  };
}

async function submitSolana(
  creds: Credentials,
  encoded: string,
  fetchFn: FetchFn,
): Promise<TxResult> {
  let raw: Buffer;
  try {
    raw = decodeBase64Strict(encoded);
  } catch {
    throw new WalletError("transaction must be base64");
  }
  const payer = Keypair.fromSecretKey(bs58.decode(creds.solana_private_key));
  let signed: Buffer;
  try {
    const vtx = VersionedTransaction.deserialize(raw);
    vtx.sign([payer]);
    signed = Buffer.from(vtx.serialize());
  } catch {
    try {
      const tx = Transaction.from(raw);
      const rebuilt = new Transaction();
      if (!tx.recentBlockhash) {
        throw new WalletError("transaction is not a valid Solana transaction");
      }
      rebuilt.recentBlockhash = tx.recentBlockhash;
      rebuilt.feePayer = payer.publicKey;
      rebuilt.add(...tx.instructions);
      rebuilt.sign(payer);
      signed = Buffer.from(rebuilt.serialize());
    } catch {
      throw new WalletError("transaction is not a valid Solana transaction");
    }
  }
  const url = solanaRpc(creds.alchemy_key);
  return broadcastSolana(fetchFn, url, signed.toString("base64"));
}

async function swapSolana(
  creds: Credentials,
  sell: string | null,
  buy: string | null,
  amount: string,
  bps: number,
  fetchFn: FetchFn,
): Promise<TxResult> {
  const me = Keypair.fromSecretKey(bs58.decode(creds.solana_private_key)).publicKey;
  const sellMint = sell || SOL_MINT;
  const buyMint = buy || SOL_MINT;
  const raw = await solanaAmount(creds, sell, amount, fetchFn);
  const quote = await httpJson(fetchFn, "GET", JUPITER_QUOTE, {
    params: {
      inputMint: sellMint,
      outputMint: buyMint,
      amount: String(raw),
      slippageBps: String(bps),
    },
    error: "Jupiter",
  });
  if (
    !quote ||
    typeof quote !== "object" ||
    Array.isArray(quote) ||
    !(quote as { outAmount?: unknown }).outAmount
  ) {
    throw new WalletError(httpMessage(quote, "Jupiter quote failed"));
  }
  const swapTx = await httpJson(fetchFn, "POST", JUPITER_SWAP, {
    payload: {
      quoteResponse: quote,
      userPublicKey: me.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    },
    error: "Jupiter",
  });
  const encoded =
    swapTx && typeof swapTx === "object" && !Array.isArray(swapTx)
      ? (swapTx as { swapTransaction?: unknown }).swapTransaction
      : undefined;
  if (typeof encoded !== "string" || !encoded) {
    throw new WalletError(httpMessage(swapTx, "Jupiter swap failed"));
  }
  return submitSolana(creds, encoded, fetchFn);
}

async function solanaAmount(
  creds: Credentials,
  mint: string | null,
  amount: string,
  fetchFn: FetchFn,
): Promise<bigint> {
  if (mint === null) {
    return parseUnits(amount, 9);
  }
  const url = solanaRpc(creds.alchemy_key);
  const mintInfo = await solRpcCall(fetchFn, url, "getAccountInfo", [
    mint,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const mintData = accountBytes(mintInfo);
  if (mintData === null || mintData.length <= 44) {
    throw new WalletError(`mint not found: ${mint}`);
  }
  return parseUnits(amount, mintData[44] ?? 0);
}

async function swapEvm(
  creds: Credentials,
  chain: string,
  sell: string | null,
  buy: string | null,
  amount: string,
  bps: number,
  fetchFn: FetchFn,
): Promise<TxResult> {
  const url = evmRpc(chain, creds.alchemy_key);
  const me = evmAddress(creds);
  const spec = mustEvm(chain);
  const sellAddr = sell || NATIVE_EVM;
  const buyAddr = buy || NATIVE_EVM;
  let raw: bigint;
  if (sell === null) {
    raw = parseUnits(amount, spec.decimals);
  } else {
    const decimalsHex = await evmRpcCall(fetchFn, url, "eth_call", [
      { to: sell, data: calldata("decimals()", [], []) },
      "latest",
    ]);
    raw = parseUnits(amount, Number(hexInt(decimalsHex)));
  }
  const quote = await httpJson(fetchFn, "GET", LIFI_QUOTE, {
    params: {
      fromChain: String(spec.chain_id),
      toChain: String(spec.chain_id),
      fromToken: sellAddr,
      toToken: buyAddr,
      fromAmount: String(raw),
      fromAddress: me,
      slippage: String(bps / 10_000),
    },
    error: "LiFi",
  });
  const request =
    quote && typeof quote === "object" && !Array.isArray(quote)
      ? (quote as { transactionRequest?: unknown }).transactionRequest
      : undefined;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new WalletError(httpMessage(quote, "LiFi quote failed"));
  }
  const dest = (request as { to?: unknown }).to;
  const data = (request as { data?: unknown }).data;
  if (typeof dest !== "string" || HEX_DATA.exec(String(data || ""))?.[0] !== String(data || "")) {
    throw new WalletError("LiFi quote is missing transaction data");
  }
  if (sell !== null) {
    const spender = lifiSpender(quote as Record<string, unknown>, dest);
    await ensureAllowance(creds, chain, sell, spender, raw, fetchFn);
  }
  const value = hexInt((request as { value?: unknown }).value);
  return broadcastEvm(creds, chain, dest, value, String(data), fetchFn);
}

async function swapUniswap(
  creds: Credentials,
  chain: string,
  sell: string | null,
  buy: string | null,
  amount: string,
  bps: number,
  apiKey: string,
  fetchFn: FetchFn,
): Promise<TxResult> {
  const url = evmRpc(chain, creds.alchemy_key);
  const me = evmAddress(creds);
  const spec = mustEvm(chain);
  const sellAddr = sell || NATIVE_EVM;
  const buyAddr = buy || NATIVE_EVM;
  let raw: bigint;
  if (sell === null) {
    raw = parseUnits(amount, spec.decimals);
  } else {
    const decimalsHex = await evmRpcCall(fetchFn, url, "eth_call", [
      { to: sell, data: calldata("decimals()", [], []) },
      "latest",
    ]);
    raw = parseUnits(amount, Number(hexInt(decimalsHex)));
  }
  const headers = uniswapTradeHeaders(apiKey);
  if (sell !== null) {
    const approval = await httpJson(fetchFn, "POST", UNISWAP_APPROVAL, {
      headers,
      payload: {
        walletAddress: me,
        token: sellAddr,
        amount: String(raw),
        chainId: spec.chain_id,
      },
      error: "Uniswap",
    });
    await broadcastUniswapApproval(creds, chain, approval, fetchFn);
  }
  const quoted = await httpJson(fetchFn, "POST", UNISWAP_QUOTE, {
    headers,
    payload: {
      type: "EXACT_INPUT",
      tokenIn: sellAddr,
      tokenOut: buyAddr,
      tokenInChainId: spec.chain_id,
      tokenOutChainId: spec.chain_id,
      amount: String(raw),
      swapper: me,
      slippageTolerance: bps / 100,
      protocols: ["V2", "V3", "V4"],
      routingPreference: "BEST_PRICE",
    },
    error: "Uniswap",
  });
  const quoteBody =
    quoted && typeof quoted === "object" && !Array.isArray(quoted)
      ? (quoted as Record<string, unknown>)
      : null;
  if (quoteBody === null) {
    throw new WalletError("Uniswap quote failed");
  }
  const routing = String(quoteBody.routing || "");
  if (!UNISWAP_ROUTES.has(routing)) {
    throw new WalletError(
      routing ? `Uniswap quote routing ${routing} is not supported` : "Uniswap quote failed",
    );
  }
  const ready = quoteBody.swapTransaction;
  if (ready) {
    const tx = evmTxRequest(ready, "Uniswap quote");
    return broadcastEvm(creds, chain, tx.to, tx.value, tx.data, fetchFn);
  }
  const quote = quoteBody.quote;
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
    throw new WalletError("Uniswap quote is missing route data");
  }
  const swapped = await httpJson(fetchFn, "POST", UNISWAP_SWAP, {
    headers,
    payload: { quote },
    error: "Uniswap",
  });
  const swapBody =
    swapped && typeof swapped === "object" && !Array.isArray(swapped)
      ? (swapped as { swap?: unknown }).swap
      : undefined;
  const tx = evmTxRequest(swapBody, "Uniswap swap");
  return broadcastEvm(creds, chain, tx.to, tx.value, tx.data, fetchFn);
}

async function broadcastUniswapApproval(
  creds: Credentials,
  chain: string,
  payload: unknown,
  fetchFn: FetchFn,
): Promise<void> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WalletError("Uniswap approval check failed");
  }
  const body = payload as { cancel?: unknown; approval?: unknown };
  if (body.cancel) {
    const cancel = evmTxRequest(body.cancel, "Uniswap approval reset");
    await broadcastEvm(creds, chain, cancel.to, cancel.value, cancel.data, fetchFn);
  }
  if (body.approval) {
    const approval = evmTxRequest(body.approval, "Uniswap approval");
    await broadcastEvm(creds, chain, approval.to, approval.value, approval.data, fetchFn);
  }
}

function evmTxRequest(value: unknown, label: string): { to: string; data: string; value: bigint } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalletError(`${label} is missing transaction data`);
  }
  const dest = (value as { to?: unknown }).to;
  const data = (value as { data?: unknown }).data;
  if (typeof dest !== "string" || HEX_DATA.exec(String(data || ""))?.[0] !== String(data || "")) {
    throw new WalletError(`${label} is missing transaction data`);
  }
  return { to: dest, data: String(data), value: hexInt((value as { value?: unknown }).value) };
}

function lifiSpender(quote: Record<string, unknown>, dest: string): string {
  const estimate = quote.estimate;
  if (estimate && typeof estimate === "object" && !Array.isArray(estimate)) {
    const spender = (estimate as { approvalAddress?: unknown }).approvalAddress;
    if (typeof spender === "string" && evmIsAddress(spender)) {
      return checksum(spender);
    }
  }
  return checksum(dest);
}

async function ensureAllowance(
  creds: Credentials,
  chain: string,
  token: string,
  spender: string,
  amount: bigint,
  fetchFn: FetchFn,
): Promise<void> {
  const url = evmRpc(chain, creds.alchemy_key);
  const me = evmAddress(creds);
  const data = calldata("allowance(address,address)", ["address", "address"], [me, spender]);
  const raw = await evmRpcCall(fetchFn, url, "eth_call", [{ to: token, data }, "latest"]);
  if (hexInt(raw) >= amount) {
    return;
  }
  const approve = calldata("approve(address,uint256)", ["address", "uint256"], [spender, amount]);
  await broadcastEvm(creds, chain, token, 0n, approve, fetchFn);
}

type OpenSeaListing = {
  hash: string;
  protocol_address: string;
  currency: string;
  total: bigint;
  tokenId: string;
  label: string;
};

async function pickListing(
  fetchFn: FetchFn,
  headers: Record<string, string>,
  slugChain: string,
  arguments_: Record<string, unknown>,
): Promise<OpenSeaListing> {
  const slugArg = String(arguments_.slug || "").trim();
  const tokenText = String(arguments_.token_id || "").trim();
  const contractText = String(arguments_.contract || "").trim();
  if (tokenText) {
    const tokenId = tokenIdArg(arguments_.token_id);
    let slug = slugArg;
    if (!slug) {
      if (!contractText) {
        throw new WalletError("contract or slug is required to buy a specific token");
      }
      const nft = await openseaNft(fetchFn, headers, slugChain, nftContract(arguments_.contract), tokenId);
      slug = String(nft.collection || "").trim();
      if (!slug) {
        throw new WalletError("OpenSea does not know that NFT's collection");
      }
    }
    return listingFrom(
      await httpJson(
        fetchFn,
        "GET",
        `${OPENSEA_API}/listings/collection/${encodeURIComponent(slug)}/nfts/${encodeURIComponent(tokenId)}/best`,
        { headers, error: "OpenSea" },
      ),
      "no OpenSea listing for that NFT",
    );
  }
  let slug = slugArg;
  if (!slug) {
    if (!contractText) {
      throw new WalletError("slug or contract is required");
    }
    slug = await openseaContractCollection(
      fetchFn,
      headers,
      slugChain,
      nftContract(arguments_.contract),
    );
  }
  return listingFrom(
    await httpJson(
      fetchFn,
      "GET",
      `${OPENSEA_API}/listings/collection/${encodeURIComponent(slug)}/best`,
      { params: { limit: "1" }, headers, error: "OpenSea" },
    ),
    "no OpenSea listing on that collection floor",
  );
}

async function fillListing(
  creds: Credentials,
  chain: string,
  slugChain: string,
  listing: OpenSeaListing,
  openseaKey: string,
  fetchFn: FetchFn,
): Promise<TxResult> {
  const me = evmAddress(creds);
  const headers = openseaHeaders(openseaKey);
  let protocol = listing.protocol_address;
  if (typeof protocol !== "string" || !evmIsAddress(protocol)) {
    protocol = SEAPORT;
  }
  const fulfillment = await httpJson(fetchFn, "POST", `${OPENSEA_API}/listings/fulfillment_data`, {
    payload: {
      listing: {
        hash: listing.hash,
        chain: slugChain,
        protocol_address: protocol,
      },
      fulfiller: { address: me },
    },
    headers,
    error: "OpenSea",
  });
  const transaction = fulfillmentTransaction(fulfillment);
  const dest = checksum(String(transaction.to));
  if (!SEAPORT_ADDRESSES.has(dest)) {
    throw new WalletError(`OpenSea returned an unexpected fulfillment target: ${dest}`);
  }
  const fn = String(transaction.function || "").trim();
  if (!fn) {
    throw new WalletError("OpenSea fulfillment is missing a function signature");
  }
  const data = encodeCall(fn, transaction.input_data);
  const value = hexInt(transaction.value);
  if (listing.currency !== NATIVE_EVM && listing.total > 0n) {
    await ensureAllowance(creds, chain, listing.currency, OPENSEA_CONDUIT, listing.total, fetchFn);
  }
  return broadcastEvm(creds, chain, dest, value, data, fetchFn);
}

function listingFrom(payload: unknown, empty: string): OpenSeaListing {
  let row: unknown = payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const listings = (payload as { listings?: unknown }).listings;
    if (Array.isArray(listings)) {
      row = listings[0];
    }
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new WalletError(empty);
  }
  const body = row as Record<string, unknown>;
  const hash = body.order_hash || body.hash;
  if (typeof hash !== "string" || !hash) {
    throw new WalletError("OpenSea listing is missing an order hash");
  }
  const protocol = body.protocol_address;
  const [currency, total] = listingPayment(body);
  const asset =
    body.asset && typeof body.asset === "object" && !Array.isArray(body.asset)
      ? (body.asset as { identifier?: unknown }).identifier
      : undefined;
  const tokenId = asset === null || asset === undefined ? "" : String(asset);
  return {
    hash,
    protocol_address: typeof protocol === "string" ? protocol : "",
    currency,
    total,
    tokenId,
    label: listingLabel(body, total),
  };
}

function listingLabel(row: Record<string, unknown>, total: bigint): string {
  const price = row.price;
  const current =
    price && typeof price === "object" && !Array.isArray(price)
      ? (price as { current?: unknown }).current
      : undefined;
  if (current && typeof current === "object" && !Array.isArray(current)) {
    const priced = current as { value?: unknown; decimals?: unknown; currency?: unknown };
    const raw = priced.value;
    if (raw !== null && raw !== undefined) {
      const decimals = Number(hexInt(priced.decimals)) || 18;
      const symbol = String(priced.currency || "").trim() || "ETH";
      return `${formatUnits(hexInt(raw), decimals)} ${symbol}`;
    }
  }
  if (total > 0n) {
    return `${formatUnits(total, 18)} ETH`;
  }
  return "";
}

function listingPayment(row: unknown): [string, bigint] {
  // The token a listing is priced in, and the total the buyer pays.
  const protocolData =
    row && typeof row === "object" && !Array.isArray(row)
      ? (row as { protocol_data?: unknown }).protocol_data
      : undefined;
  const parameters =
    protocolData && typeof protocolData === "object" && !Array.isArray(protocolData)
      ? (protocolData as { parameters?: unknown }).parameters
      : undefined;
  const items =
    parameters && typeof parameters === "object" && !Array.isArray(parameters)
      ? (parameters as { consideration?: unknown }).consideration
      : undefined;
  let token = NATIVE_EVM;
  let total = 0n;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const rowItem = item as Record<string, unknown>;
    const itemType = Number(hexInt(rowItem.itemType));
    if (itemType !== ITEM_NATIVE && itemType !== ITEM_ERC20) {
      continue;
    }
    token = checksum(String(rowItem.token || NATIVE_EVM));
    total += hexInt(rowItem.startAmount);
  }
  return [token, total];
}

function hexInt(value: unknown): bigint {
  if (value === null || value === undefined) {
    return 0n;
  }
  if (typeof value === "boolean") {
    return value ? 1n : 0n;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  const text = String(value).trim();
  if (!text) {
    return 0n;
  }
  if (text.startsWith("0x") || text.startsWith("0X")) {
    return BigInt(text);
  }
  return BigInt(text);
}

async function httpJson(
  fetchFn: FetchFn,
  method: string,
  url: string,
  options: {
    params?: Record<string, string>;
    payload?: unknown;
    headers?: Record<string, string>;
    error: string;
  },
): Promise<unknown> {
  const target = options.params ? withQuery(url, options.params) : url;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const init: RequestInit = { method, headers };
  if (options.payload !== undefined) {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    init.body = JSON.stringify(options.payload);
  }
  let response: Response;
  try {
    response = await fetchFn(target, init);
  } catch (error) {
    if (error instanceof WalletError) {
      throw error;
    }
    throw new WalletError(`${options.error} request failed`, 502);
  }
  if (response.status === 401 || response.status === 403) {
    throw new WalletError(`${options.error} API key was rejected`, response.status);
  }
  let body: unknown;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (response.status >= 400) {
    throw new WalletError(httpMessage(body, `${options.error} HTTP ${response.status}`));
  }
  return body;
}

function httpMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const body = payload as Record<string, unknown>;
    for (const key of ["message", "error", "msg", "detail", "errors"]) {
      const value = body[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const nested = (value as { message?: unknown }).message;
        if (typeof nested === "string" && nested.trim()) {
          return nested.trim();
        }
      }
      if (Array.isArray(value) && value.length) {
        const first = value[0];
        if (typeof first === "string" && first.trim()) {
          return first.trim();
        }
      }
    }
  }
  return fallback;
}

async function priorityFee(fetchFn: FetchFn, url: string): Promise<number> {
  let recent: unknown;
  try {
    recent = await solRpcCall(fetchFn, url, "getRecentPrioritizationFees", []);
  } catch (error) {
    if (error instanceof WalletError) {
      return 50_000;
    }
    throw error;
  }
  if (!Array.isArray(recent)) {
    return 50_000;
  }
  const fees = recent
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .map((item) => item.prioritizationFee)
    .filter((fee): fee is number => typeof fee === "number" && fee > 0)
    .sort((left, right) => left - right);
  if (!fees.length) {
    return 50_000;
  }
  const index = Math.min(fees.length - 1, Math.trunc((fees.length * 3) / 4));
  return Math.max(50_000, fees[index] ?? 50_000);
}

async function waitSolana(fetchFn: FetchFn, url: string, sig: string): Promise<void> {
  const deadline = monotonicSeconds() + RECEIPT_SECONDS;
  while (monotonicSeconds() < deadline) {
    const status = await solRpcCall(fetchFn, url, "getSignatureStatuses", [
      [sig],
      { searchTransactionHistory: true },
    ]);
    const value =
      status && typeof status === "object" && !Array.isArray(status)
        ? (status as { value?: unknown }).value
        : undefined;
    const row = Array.isArray(value) && value.length ? value[0] : undefined;
    if (row && typeof row === "object" && !Array.isArray(row)) {
      const body = row as Record<string, unknown>;
      if (body.err) {
        throw new WalletError(`Transaction failed: ${sig}`);
      }
      const confirmation = body.confirmationStatus;
      if (confirmation === "confirmed" || confirmation === "finalized") {
        return;
      }
    }
    await sleep(2000);
  }
  throw new WalletError(`timed out waiting for ${sig}`);
}

function associatedToken(owner: PublicKey, mint: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  );
  return address;
}

function createAtaIdempotent(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

function transferChecked(
  source: PublicKey,
  mint: PublicKey,
  dest: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
): TransactionInstruction {
  const packed = Buffer.alloc(8);
  packed.writeBigUInt64LE(amount);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([12]), packed, Buffer.from([decimals])]),
  });
}

function accountBytes(payload: unknown): Buffer | null {
  const value =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { value?: unknown }).value
      : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const data = (value as { data?: unknown }).data;
  if (Array.isArray(data) && data.length && typeof data[0] === "string") {
    return Buffer.from(data[0], "base64");
  }
  if (typeof data === "string") {
    return Buffer.from(data, "base64");
  }
  return null;
}

function blockhashOf(payload: unknown): string {
  const value =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { value?: unknown }).value
      : undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const blockhash = (value as { blockhash?: unknown }).blockhash;
    if (typeof blockhash === "string" && blockhash) {
      return blockhash;
    }
  }
  throw new WalletError("latest blockhash is missing");
}

function decodeBase64Strict(encoded: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error("invalid base64");
  }
  return Buffer.from(encoded, "base64");
}

async function evmRpcCall(
  fetchFn: FetchFn,
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  try {
    return await jsonRpc(fetchFn, url, method, params);
  } catch (error) {
    const fallback = publicRpcForAlchemyUrl(url);
    if (
      !fallback ||
      !(error instanceof WalletError) ||
      (error.status !== 401 && error.status !== 403)
    ) {
      throw error;
    }
    return jsonRpc(fetchFn, fallback, method, params);
  }
}

function publicRpcForAlchemyUrl(url: string): string | undefined {
  const match = /^https:\/\/([a-z0-9-]+)\.g\.alchemy\.com\//.exec(url);
  if (!match) {
    return undefined;
  }
  const slug = match[1];
  for (const spec of Object.values(EVM_CHAINS)) {
    if (spec.alchemy === slug) {
      return spec.rpc;
    }
  }
  return undefined;
}

async function solRpcCall(
  fetchFn: FetchFn,
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  return jsonRpc(fetchFn, url, method, params);
}

function rpcLabel(url: string): string {
  return url.includes(".g.alchemy.com") ? "Alchemy" : "RPC";
}

async function jsonRpc(
  fetchFn: FetchFn,
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const label = rpcLabel(url);
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (error) {
    if (error instanceof WalletError) {
      throw error;
    }
    throw new WalletError(`${label} request failed`, 502);
  }
  if (response.status === 401 || response.status === 403) {
    throw new WalletError(
      label === "Alchemy" ? "Alchemy API key was rejected" : "RPC request was rejected",
      response.status,
    );
  }
  if (response.status >= 400) {
    throw new WalletError(`${label} HTTP ${response.status}`, response.status);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new WalletError(`${label} returned a non-JSON body`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WalletError(`${label} returned a non-object`);
  }
  const error = (payload as { error?: unknown }).error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message || `${label} RPC error`;
    throw new WalletError(String(message));
  }
  return (payload as { result?: unknown }).result;
}
