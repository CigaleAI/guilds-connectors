import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { decodeMasterKey } from "@guildsrun/orchestrator/config/index.js";
import { loadConnector } from "@guildsrun/orchestrator/connectors/servers.js";
import { ConnectorRegistry, folderEntry } from "@guildsrun/orchestrator/connectors/registry.js";
import { ConnectorError } from "@guildsrun/orchestrator/connectors/types.js";
import { encryptPayload } from "@guildsrun/orchestrator/credentials/crypto.js";
import type { McpConnectionRow } from "@guildsrun/orchestrator/db/mcp.js";
import { McpError } from "@guildsrun/orchestrator/mcp/errors.js";
import { McpPool, OPERATOR_CALLER } from "@guildsrun/orchestrator/mcp/pool.js";
import { HEX_MASTER_KEY } from "@guildsrun/orchestrator/test/helpers/env.js";
import { mockFetch } from "@guildsrun/orchestrator/test/helpers/http.js";
import { restoreConnectorsAfterEach, runConnectors } from "@guildsrun/orchestrator/test/helpers/installed.js";
import { MemoryMcpDatabase } from "@guildsrun/orchestrator/test/helpers/mcp-database.js";
import adapter from "../connectors/wallet/adapter.js";
import {
  WalletError,
  accountHint,
  callTool,
  EVM_CHAINS,
  evmAddress,
  evmCall,
  evmRpc,
  formatUnits,
  getAddress,
  getBalance,
  openseaBuy,
  parseCredentials,
  parseUnits,
  ping,
  resolveAsset,
  resolveChain,
  resolveToken,
  send,
  slippageBps,
  solanaAddress,
  submit,
  swap,
  uniswapSwap,
} from "../connectors/wallet/client.js";

const FOLDER = fileURLToPath(new URL("../connectors/wallet", import.meta.url));
const CONNECTORS = new ConnectorRegistry([
  folderEntry(JSON.parse(readFileSync(`${FOLDER}/connector.json`, "utf8")), adapter, FOLDER, "guilds"),
]);
const MANIFEST = CONNECTORS.bySlug("wallet")!.manifest;
const TOOLS = MANIFEST.tools!;
const STAMP = "2026-10-12T09:00:00.000Z";
/** The wallet connector as `getMcpServer` loads it: installed on the platform, with no overrides. */
const SERVER = loadConnector({
  id: "mcp_wallet",
  slug: "wallet",
  tool_prefix: "wallet",
  owner_org_id: null,
  manifest: MANIFEST,
  source: "registry",
  version: "",
  verified: true,
  experimental: false,
  publisher: "guilds",
  enabled: true,
  oauth_client: null,
  overrides: {},
  installed_at: STAMP,
  updated_at: STAMP,
});

const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SOLANA_KEYPAIR = Keypair.generate();
const SOLANA_KEY = bs58.encode(SOLANA_KEYPAIR.secretKey);
const ALCHEMY = "alc-test";
const OPENSEA = "os-test";
const UNISWAP = "uni-test";
const UNISWAP_API = "https://trade-api.gateway.uniswap.org/v1";
const KEY = decodeMasterKey(HEX_MASTER_KEY);
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ZERO_BLOCKHASH = "11111111111111111111111111111111";

function creds() {
  return parseCredentials(ANVIL_KEY, SOLANA_KEY, ALCHEMY, OPENSEA);
}

function rpcBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function rpcOk(result: unknown) {
  return { status: 200, json: { jsonrpc: "2.0", id: 1, result } };
}

function header(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) {
    return null;
  }
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1] ?? null;
  }
  const record = headers as Record<string, string>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return value;
    }
  }
  return null;
}

function evmOk(method: string, sent?: string[]) {
  const results: Record<string, unknown> = {
    eth_getTransactionCount: "0x1",
    eth_maxPriorityFeePerGas: "0x3b9aca00",
    eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" },
    eth_estimateGas: "0x5208",
    eth_sendRawTransaction: "0xabc123",
    eth_getTransactionReceipt: { status: "0x1", transactionHash: "0xabc123" },
    eth_call: "0x0",
  };
  if (sent !== undefined && method === "eth_sendRawTransaction") {
    sent.push(method);
  }
  return rpcOk(results[method]);
}

function solanaSendOk(payload: Record<string, unknown>) {
  const method = payload.method;
  if (method === "getRecentPrioritizationFees") {
    return rpcOk([]);
  }
  if (method === "getLatestBlockhash") {
    return rpcOk({ value: { blockhash: ZERO_BLOCKHASH } });
  }
  if (method === "sendTransaction") {
    return rpcOk("sig111");
  }
  if (method === "getSignatureStatuses") {
    return rpcOk({ value: [{ confirmationStatus: "confirmed", err: null }] });
  }
  return null;
}

function mintData(): Buffer {
  return Buffer.concat([Buffer.alloc(44), Buffer.from([6]), Buffer.alloc(40)]);
}

function tokenAccountData(amount: bigint): Buffer {
  const body = Buffer.concat([Buffer.alloc(64), Buffer.alloc(8), Buffer.alloc(20)]);
  body.writeBigUInt64LE(amount, 64);
  return body;
}

function accountInfo(data: Buffer) {
  return rpcOk({ value: { data: [data.toString("base64"), "base64"] } });
}

function signedVersionedTx(): string {
  const message = new TransactionMessage({
    payerKey: SOLANA_KEYPAIR.publicKey,
    recentBlockhash: ZERO_BLOCKHASH,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: SOLANA_KEYPAIR.publicKey,
        toPubkey: SOLANA_KEYPAIR.publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([SOLANA_KEYPAIR]);
  return Buffer.from(tx.serialize()).toString("base64");
}

restoreConnectorsAfterEach();

function walletConnection(extra: Record<string, string> = {}): McpConnectionRow {
  const [ciphertext, nonce] = encryptPayload(
    {
      evm_private_key: ANVIL_KEY,
      solana_private_key: SOLANA_KEY,
      alchemy_key: ALCHEMY,
      opensea_key: OPENSEA,
      ...extra,
    },
    KEY,
  );
  return {
    id: "conn_w",
    mcp_server_id: "mcp_wallet",
    owner_scope: "guild",
    owner_id: "guild_1",
    account_hint: "",
    status: "connected",
    ciphertext,
    nonce,
    oauth_state: null,
    settings: {},
    created_at: STAMP,
    updated_at: STAMP,
    rotated_at: STAMP,
  };
}

test("parse and format units", () => {
  assert.equal(parseUnits("1.5", 6), 1_500_000n);
  assert.equal(parseUnits("0.5", 18), 5n * 10n ** 17n);
  assert.equal(formatUnits(1_500_000n, 6), "1.5");
  assert.equal(formatUnits(10n ** 18n, 18), "1");
  assert.throws(() => parseUnits("1e2", 18), (error: unknown) => {
    return error instanceof WalletError && /positive decimal/.test(error.message);
  });
  assert.throws(() => parseUnits("0", 18), (error: unknown) => {
    return error instanceof WalletError && /greater than 0/.test(error.message);
  });
});

test("parse credentials and addresses", () => {
  const parsed = creds();
  assert.equal(parsed.uniswap_key, "");
  assert.equal(evmAddress(parsed), ANVIL_ADDR);
  assert.equal(solanaAddress(parsed), SOLANA_KEYPAIR.publicKey.toBase58());
  assert.equal(parseCredentials(ANVIL_KEY, SOLANA_KEY, ALCHEMY, OPENSEA, UNISWAP).uniswap_key, UNISWAP);
  const hint = accountHint(parsed);
  assert.ok(hint.includes(ANVIL_ADDR.slice(0, 6)));
  assert.ok(hint.includes("…"));
  assert.throws(
    () => parseCredentials("0x11", SOLANA_KEY, ALCHEMY, OPENSEA),
    /evm_private_key is invalid/,
  );
  assert.throws(
    () => parseCredentials(ANVIL_KEY, "nope", ALCHEMY, OPENSEA),
    /solana_private_key is invalid/,
  );
  assert.throws(
    () => parseCredentials(ANVIL_KEY, SOLANA_KEY, "", OPENSEA),
    /alchemy_key is required/,
  );
  assert.throws(
    () => parseCredentials(ANVIL_KEY, SOLANA_KEY, ALCHEMY, ""),
    /opensea_key is required/,
  );
  const asJson = JSON.stringify(Array.from(SOLANA_KEYPAIR.secretKey));
  const fromArray = parseCredentials(ANVIL_KEY, asJson, ALCHEMY, OPENSEA);
  assert.equal(solanaAddress(fromArray), SOLANA_KEYPAIR.publicKey.toBase58());
  const seed = JSON.stringify(Array.from(SOLANA_KEYPAIR.secretKey.slice(0, 32)));
  const fromSeed = parseCredentials(ANVIL_KEY, seed, ALCHEMY, OPENSEA);
  assert.equal(solanaAddress(fromSeed), SOLANA_KEYPAIR.publicKey.toBase58());
});

test("get address and resolve token", () => {
  const parsed = creds();
  assert.equal(getAddress(parsed, "ethereum"), ANVIL_ADDR);
  assert.equal(getAddress(parsed, "solana"), SOLANA_KEYPAIR.publicKey.toBase58());
  assert.equal(resolveToken("ethereum", "usdc"), "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  const raw = "0x2D270e6886d130D724215A266106e6832161EAEd";
  assert.equal(resolveToken("ink", raw), raw);
  assert.equal(resolveToken("ink", "usdc"), raw);
  assert.equal(resolveToken("solana", "USDC"), USDC);
  assert.equal(resolveToken("robinhood", "usdg"), "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  assert.throws(() => resolveToken("robinhood", "USDT"), /Unknown token/);
  assert.equal(resolveToken("base", "usdc"), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(resolveToken("bsc", "usdc"), "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d");
  assert.equal(resolveToken("bsc", "usdt"), "0x55d398326f99059fF775485246999027B3197955");
  assert.equal(resolveChain("arc-mainnet"), "arc");
  assert.equal(resolveChain("bnb"), "bsc");
  assert.equal(resolveChain("binance-smart-chain"), "bsc");
  assert.equal(EVM_CHAINS.arc?.chain_id, 5042);
  assert.equal(EVM_CHAINS.bsc?.chain_id, 56);
  assert.equal(evmRpc("arc", ALCHEMY), "https://rpc.mainnet.arc.io");
  assert.ok(evmRpc("polygon", ALCHEMY).startsWith("https://polygon-mainnet.g.alchemy.com/v2/"));
  assert.ok(evmRpc("arbitrum", ALCHEMY).startsWith("https://arb-mainnet.g.alchemy.com/v2/"));
  assert.ok(evmRpc("optimism", ALCHEMY).startsWith("https://opt-mainnet.g.alchemy.com/v2/"));
  assert.ok(evmRpc("bsc", ALCHEMY).startsWith("https://bnb-mainnet.g.alchemy.com/v2/"));
  assert.equal(resolveToken("arc", "usdc"), "0x3600000000000000000000000000000000000000");
  assert.equal(resolveToken("arc", "eurc"), "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1");
  assert.equal(resolveAsset("arc", "USDC"), null);
  assert.equal(resolveAsset("ethereum", "ETH"), null);
  assert.equal(resolveAsset("solana", "SOL"), null);
  assert.equal(resolveAsset("base", "USDC"), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(resolveAsset("bsc", "BNB"), null);
  assert.equal(resolveAsset("bsc", "WBNB"), "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
  assert.equal(slippageBps(null), 100);
  assert.equal(slippageBps("0.5"), 50);
  assert.throws(() => slippageBps("51"), /at most 50/);
});

test("ping hits ethereum solana and opensea", async () => {
  const seen: Array<[string, string]> = [];
  const client = mockFetch((url, init) => {
    if (url.includes("api.opensea.io")) {
      seen.push([url, init?.method ?? "GET"]);
      assert.equal(header(init, "x-api-key"), OPENSEA);
      return { status: 200, json: { chains: [{ chain: "ethereum" }] } };
    }
    const payload = rpcBody(init);
    seen.push([url, String(payload.method)]);
    return rpcOk("0x1");
  });
  await ping(ALCHEMY, OPENSEA, { client });
  assert.ok(seen[0]?.[0].startsWith("https://eth-mainnet.g.alchemy.com/v2/"));
  assert.equal(seen[0]?.[1], "eth_blockNumber");
  assert.ok(seen[1]?.[0].startsWith("https://solana-mainnet.g.alchemy.com/v2/"));
  assert.equal(seen[1]?.[1], "getSlot");
  assert.equal(seen[2]?.[0], "https://api.opensea.io/api/v2/chains");
  assert.equal(seen[2]?.[1], "GET");
  assert.equal(seen.length, 3);
});

test("ping with uniswap key hits supported chains", async () => {
  const seen: string[] = [];
  const client = mockFetch((url, init) => {
    seen.push(url);
    if (url.includes("api.opensea.io")) {
      return { status: 200, json: { chains: [{ chain: "ethereum" }] } };
    }
    if (url === `${UNISWAP_API}/supported_chains`) {
      assert.equal(header(init, "x-api-key"), UNISWAP);
      assert.equal(header(init, "accept"), "application/json");
      return { status: 200, json: { chains: [] } };
    }
    return rpcOk("0x1");
  });
  await ping(ALCHEMY, OPENSEA, { client, uniswapKey: UNISWAP });
  assert.equal(seen[3], `${UNISWAP_API}/supported_chains`);
});

test("ping rejects uniswap unauthorized", async () => {
  const client = mockFetch((url) => {
    if (url.includes("api.opensea.io")) {
      return { status: 200, json: { chains: [{ chain: "ethereum" }] } };
    }
    if (url.includes("uniswap.org")) {
      return { status: 401, json: { error: "invalid key" } };
    }
    return rpcOk("0x1");
  });
  await assert.rejects(
    () => ping(ALCHEMY, OPENSEA, { client, uniswapKey: "bad-uni" }),
    (error: unknown) =>
      error instanceof WalletError &&
      error.status === 401 &&
      error.message === "Uniswap API key was rejected",
  );
});

test("ping rejects unauthorized", async () => {
  const client = mockFetch(() => ({ status: 401, json: { error: "invalid key" } }));
  await assert.rejects(
    () => ping("bad", OPENSEA, { client }),
    (error: unknown) => error instanceof WalletError && error.status === 401 && /rejected/.test(error.message),
  );
});

test("ping rejects opensea unauthorized", async () => {
  const client = mockFetch((url) => {
    if (url.includes("api.opensea.io")) {
      return { status: 401, json: { error: "invalid key" } };
    }
    return rpcOk("0x1");
  });
  await assert.rejects(
    () => ping(ALCHEMY, "bad-sea", { client }),
    (error: unknown) =>
      error instanceof WalletError &&
      error.status === 401 &&
      error.message === "OpenSea API key was rejected",
  );
});

test("polygon balance falls back to public rpc", async () => {
  const seen: string[] = [];
  const client = mockFetch((url, init) => {
    seen.push(url);
    if (url.includes("alchemy.com")) {
      return { status: 401, json: { error: "Must be authenticated" } };
    }
    const method = String(rpcBody(init).method);
    if (method === "eth_getBalance") {
      return rpcOk(`0x${(10n ** 18n).toString(16)}`);
    }
    throw new Error(method);
  });
  assert.equal(await getBalance(creds(), "polygon", null, { client }), "1");
  assert.ok(seen[0]?.startsWith("https://polygon-mainnet.g.alchemy.com/v2/"));
  assert.equal(seen[1], "https://polygon-bor-rpc.publicnode.com");
});

test("bsc balance falls back to public rpc", async () => {
  const seen: string[] = [];
  const client = mockFetch((url, init) => {
    seen.push(url);
    if (url.includes("alchemy.com")) {
      return { status: 401, json: { error: "Must be authenticated" } };
    }
    const method = String(rpcBody(init).method);
    if (method === "eth_getBalance") {
      return rpcOk(`0x${(10n ** 18n).toString(16)}`);
    }
    throw new Error(method);
  });
  assert.equal(await getBalance(creds(), "bsc", null, { client }), "1");
  assert.ok(seen[0]?.startsWith("https://bnb-mainnet.g.alchemy.com/v2/"));
  assert.equal(seen[1], "https://bsc-rpc.publicnode.com");
});

test("evm native and token balance", async () => {
  const client = mockFetch((_url, init) => {
    const method = String(rpcBody(init).method);
    if (method === "eth_getBalance") {
      return rpcOk(`0x${(3n * 10n ** 18n / 2n).toString(16)}`);
    }
    if (method === "eth_call") {
      const params = rpcBody(init).params as Array<{ data?: string }>;
      const data = params[0]?.data ?? "";
      if (data.startsWith("0x313ce567")) {
        return rpcOk("0x6");
      }
      return rpcOk(`0x${(2_500_000).toString(16)}`);
    }
    throw new Error(method);
  });
  assert.equal(await getBalance(creds(), "ethereum", null, { client }), "1.5");
  assert.equal(
    await getBalance(creds(), "ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", { client }),
    "2.5",
  );
});

test("solana balance missing ata is zero", async () => {
  const client = mockFetch((_url, init) => {
    const payload = rpcBody(init);
    const method = String(payload.method);
    if (method === "getBalance") {
      return rpcOk({ value: 2_000_000_000 });
    }
    if (method === "getAccountInfo") {
      const target = (payload.params as unknown[])[0];
      if (target === USDC) {
        return accountInfo(mintData());
      }
      return rpcOk({ value: null });
    }
    throw new Error(method);
  });
  assert.equal(await getBalance(creds(), "solana", null, { client }), "2");
  assert.equal(await getBalance(creds(), "solana", USDC, { client }), "0");
});

test("solana token balance", async () => {
  const client = mockFetch((_url, init) => {
    const payload = rpcBody(init);
    const target = (payload.params as unknown[])[0];
    if (target === USDC) {
      return accountInfo(mintData());
    }
    return accountInfo(tokenAccountData(1_500_000n));
  });
  assert.equal(await getBalance(creds(), "solana", USDC, { client }), "1.5");
});

test("send evm native", async () => {
  const seen: string[] = [];
  const client = mockFetch((_url, init) => {
    const method = String(rpcBody(init).method);
    seen.push(method);
    return evmOk(method);
  });
  const stored = await send(
    creds(),
    { chain: "ink", to: ANVIL_ADDR, amount: "0.5" },
    { connectionId: "conn_w", client },
  );
  assert.ok(stored.startsWith("0xabc123  ink  https://explorer.inkonchain.com/tx/"));
  assert.ok(seen.includes("eth_sendRawTransaction"));
});

test("send arc native uses public rpc", async () => {
  const seen: string[] = [];
  const client = mockFetch((url, init) => {
    seen.push(url);
    return evmOk(String(rpcBody(init).method));
  });
  const stored = await send(
    creds(),
    { chain: "arc", to: ANVIL_ADDR, amount: "1" },
    { connectionId: "conn_w", client },
  );
  assert.ok(stored.startsWith("0xabc123  arc  https://explorer.arc.io/tx/"));
  assert.ok(seen.every((url) => url === "https://rpc.mainnet.arc.io"));
});

test("swap robinhood quotes lifi", async () => {
  const quotes: string[] = [];
  const client = mockFetch((url, init) => {
    if (url.startsWith("https://li.quest/v1/quote")) {
      quotes.push(url);
      return {
        status: 200,
        json: {
          transactionRequest: {
            to: "0xB477751B76CF82d00a686A1232f5fCD772414Af3",
            data: "0xdead",
            value: "0x0",
          },
        },
      };
    }
    return evmOk(String(rpcBody(init).method));
  });
  const result = await swap(
    creds(),
    {
      chain: "robinhood",
      buy: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      amount: "0.001",
    },
    { connectionId: "conn_w", client },
  );
  assert.ok(result.startsWith("0xabc123  robinhood  https://robinhoodchain.blockscout.com/tx/"));
  assert.equal(quotes.length, 1);
  const params = new URL(quotes[0]!).searchParams;
  assert.equal(params.get("fromChain"), "4663");
  assert.equal(params.get("toChain"), "4663");
  assert.equal(params.get("fromToken"), "0x0000000000000000000000000000000000000000");
  assert.equal(params.get("toToken"), "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
});

test("swap on arc is not supported", async () => {
  await assert.rejects(
    () =>
      swap(
        creds(),
        { chain: "arc", buy: "EURC", amount: "1" },
        { connectionId: "conn_w", client: mockFetch(() => ({ status: 200, json: {} })) },
      ),
    /swap on arc is not supported/,
  );
});

test("send solana native", async () => {
  const client = mockFetch((_url, init) => {
    const stored = solanaSendOk(rpcBody(init));
    if (stored === null) {
      throw new Error(String(rpcBody(init).method));
    }
    return stored;
  });
  const stored = await send(
    creds(),
    {
      chain: "solana",
      to: SOLANA_KEYPAIR.publicKey.toBase58(),
      amount: "0.1",
    },
    { connectionId: "conn_w", client },
  );
  assert.equal(stored, "sig111  solana  https://solscan.io/tx/sig111");
});

test("call tool unknown name", async () => {
  await assert.rejects(
    () => callTool("foo", {}, { creds: creds(), connectionId: "conn_w" }),
    /unknown Wallet tool/,
  );
});

test("evm call rejects odd-length hex data", async () => {
  await assert.rejects(
    () =>
      evmCall(
        creds(),
        { chain: "arc", to: ANVIL_ADDR, data: "0x095ea7b30", value: "0.0" },
        { connectionId: "conn_w" },
      ),
    /data must be 0x-prefixed hex bytes/,
  );
});

test("evm call sends calldata", async () => {
  const sent: string[] = [];
  const client = mockFetch((_url, init) => evmOk(String(rpcBody(init).method), sent));
  const stored = await evmCall(
    creds(),
    { chain: "base", to: ANVIL_ADDR, data: "0xa9059cbb", value: "0" },
    { connectionId: "conn_w", client },
  );
  assert.ok(stored.startsWith("0xabc123  base  https://basescan.org/tx/"));
  assert.deepEqual(sent, ["eth_sendRawTransaction"]);
});

test("submit signs versioned solana tx", async () => {
  const encoded = signedVersionedTx();
  const client = mockFetch((_url, init) => {
    const stored = solanaSendOk(rpcBody(init));
    assert.ok(stored);
    return stored!;
  });
  const result = await submit(creds(), { transaction: encoded }, { connectionId: "conn_w", client });
  assert.equal(result, "sig111  solana  https://solscan.io/tx/sig111");
});

test("swap solana uses jupiter", async () => {
  const encoded = signedVersionedTx();
  const client = mockFetch((url, init) => {
    if (url.startsWith("https://lite-api.jup.ag/swap/v1/quote")) {
      return { status: 200, json: { outAmount: "10", inAmount: "100000" } };
    }
    if (url.startsWith("https://lite-api.jup.ag/swap/v1/swap")) {
      return { status: 200, json: { swapTransaction: encoded } };
    }
    const payload = rpcBody(init);
    if (payload.method === "getAccountInfo") {
      return accountInfo(mintData());
    }
    const stored = solanaSendOk(payload);
    assert.ok(stored);
    return stored!;
  });
  const result = await swap(
    creds(),
    { chain: "solana", buy: "USDC", amount: "0.1" },
    { connectionId: "conn_w", client },
  );
  assert.equal(result, "sig111  solana  https://solscan.io/tx/sig111");
});

test("swap evm approves then broadcasts", async () => {
  const sent: string[] = [];
  const allowanceCalls = { n: 0 };
  const client = mockFetch((url, init) => {
    if (url.startsWith("https://li.quest/v1/quote")) {
      return {
        status: 200,
        json: {
          transactionRequest: {
            to: "0x1111111111111111111111111111111111111111",
            data: "0xdead",
            value: "0x0",
          },
          estimate: {
            approvalAddress: "0x1111111111111111111111111111111111111111",
          },
        },
      };
    }
    const payload = rpcBody(init);
    const method = String(payload.method);
    if (method === "eth_call") {
      const data = (payload.params as Array<{ data?: string }>)[0]?.data ?? "";
      if (data.startsWith("0x313ce567")) {
        return rpcOk("0x6");
      }
      allowanceCalls.n += 1;
      return rpcOk("0x0");
    }
    return evmOk(method, sent);
  });
  const result = await swap(
    creds(),
    { chain: "ethereum", sell: "USDC", buy: "ETH", amount: "1.5" },
    { connectionId: "conn_w", client },
  );
  assert.ok(result.startsWith("0xabc123  ethereum  "));
  assert.equal(allowanceCalls.n, 1);
  assert.deepEqual(sent, ["eth_sendRawTransaction", "eth_sendRawTransaction"]);
});

test("uniswap swap requires key", async () => {
  await assert.rejects(
    () =>
      uniswapSwap(
        creds(),
        { chain: "ethereum", buy: "USDC", amount: "0.1" },
        { connectionId: "conn_w", client: mockFetch(() => ({ status: 200, json: {} })) },
      ),
    /Uniswap API key is missing/,
  );
});

test("uniswap swap rejects unsupported chain", async () => {
  await assert.rejects(
    () =>
      uniswapSwap(
        { ...creds(), uniswap_key: UNISWAP },
        { chain: "hyperevm", buy: "USDC", amount: "0.1" },
        { connectionId: "conn_w", client: mockFetch(() => ({ status: 200, json: {} })) },
      ),
    /Uniswap swap on hyperevm is not supported/,
  );
});

test("uniswap swap approves then broadcasts quote", async () => {
  const sent: string[] = [];
  const seen: string[] = [];
  const client = mockFetch((url, init) => {
    seen.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `${UNISWAP_API}/check_approval`) {
      assert.equal(header(init, "x-api-key"), UNISWAP);
      assert.equal(header(init, "x-permit2-disabled"), "true");
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      assert.equal(body.token, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
      assert.equal(body.amount, "1500000");
      return {
        status: 200,
        json: {
          requestId: "1",
          approval: {
            to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            data: "0x095ea7b3",
            value: "0x0",
            chainId: 1,
          },
          cancel: null,
        },
      };
    }
    if (url === `${UNISWAP_API}/quote`) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      assert.deepEqual(body.protocols, ["V2", "V3", "V4"]);
      assert.equal(body.slippageTolerance, 1);
      return {
        status: 200,
        json: {
          requestId: "2",
          routing: "CLASSIC",
          quote: { chainId: 1 },
          permitData: null,
          swapTransaction: {
            to: "0x1111111111111111111111111111111111111111",
            data: "0xdead",
            value: "0x0",
            chainId: 1,
          },
        },
      };
    }
    const payload = rpcBody(init);
    const method = String(payload.method);
    if (method === "eth_call") {
      return rpcOk("0x6");
    }
    return evmOk(method, sent);
  });
  const result = await uniswapSwap(
    { ...creds(), uniswap_key: UNISWAP },
    { chain: "ethereum", sell: "USDC", buy: "ETH", amount: "1.5" },
    { connectionId: "conn_w", client },
  );
  assert.ok(result.startsWith("0xabc123  ethereum  "));
  assert.ok(seen.includes(`POST ${UNISWAP_API}/check_approval`));
  assert.ok(seen.includes(`POST ${UNISWAP_API}/quote`));
  assert.ok(!seen.some((row) => row.includes("/swap")));
  assert.deepEqual(sent, ["eth_sendRawTransaction", "eth_sendRawTransaction"]);
});

test("uniswap swap native uses swap endpoint", async () => {
  const sent: string[] = [];
  const client = mockFetch((url, init) => {
    if (url === `${UNISWAP_API}/quote`) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      assert.equal(body.tokenIn, "0x0000000000000000000000000000000000000000");
      return {
        status: 200,
        json: {
          requestId: "2",
          routing: "CLASSIC",
          quote: { chainId: 1, input: { amount: "1" } },
          permitData: null,
        },
      };
    }
    if (url === `${UNISWAP_API}/swap`) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      assert.deepEqual(body.quote, { chainId: 1, input: { amount: "1" } });
      return {
        status: 200,
        json: {
          requestId: "3",
          swap: {
            to: "0x2222222222222222222222222222222222222222",
            data: "0xbeef",
            value: "0x0",
            chainId: 1,
          },
        },
      };
    }
    if (url === `${UNISWAP_API}/check_approval`) {
      throw new Error("native sell should not check approval");
    }
    return evmOk(String(rpcBody(init).method), sent);
  });
  const result = await uniswapSwap(
    { ...creds(), uniswap_key: UNISWAP },
    { chain: "base", buy: "USDC", amount: "0.1" },
    { connectionId: "conn_w", client },
  );
  assert.ok(result.startsWith("0xabc123  base  "));
  assert.deepEqual(sent, ["eth_sendRawTransaction"]);
});

test("call tool uniswap swap", async () => {
  await assert.rejects(
    () =>
      callTool(
        "uniswap_swap",
        { chain: "ethereum", buy: "USDC", amount: "0.1" },
        { creds: creds(), connectionId: "conn_w" },
      ),
    /Uniswap API key is missing/,
  );
});

const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395";
const BAYC = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";

function listingJson(tokenId: string) {
  return {
    order_hash: "0xorder",
    protocol_address: SEAPORT,
    asset: { identifier: tokenId, contract: BAYC },
    price: { current: { currency: "ETH", decimals: 18, value: "1000000000000000000" } },
  };
}

function fulfillmentJson() {
  return {
    fulfillment_data: {
      transaction: {
        to: SEAPORT,
        function: "deposit()",
        input_data: {},
        value: "0xde0b6b3a7640000",
      },
    },
  };
}

function openseaBuyClient(onGet: (url: string) => unknown) {
  return mockFetch((url, init) => {
    if (url.includes("api.opensea.io")) {
      if ((init?.method ?? "GET") === "GET") {
        return { status: 200, json: onGet(url) };
      }
      if (url.includes("/listings/fulfillment_data")) {
        return { status: 200, json: fulfillmentJson() };
      }
    }
    return evmOk(String(rpcBody(init).method));
  });
}

test("opensea buy fulfills listing", async () => {
  const seen: string[] = [];
  const client = openseaBuyClient((url) => {
    seen.push(url);
    if (url.includes("/nfts/") && url.includes("/best")) {
      return listingJson("1");
    }
    if (url.includes("/nfts/")) {
      return { nft: { collection: "boredapeyachtclub" } };
    }
    return { chains: [{ chain: "ethereum" }] };
  });
  const result = await openseaBuy(
    creds(),
    {
      chain: "ethereum",
      contract: BAYC,
      token_id: "1",
    },
    { connectionId: "conn_w", openseaKey: OPENSEA, client },
  );
  assert.ok(result.startsWith("0xabc123  ethereum  "));
  assert.match(result, /bought #1 for 1 ETH/);
  assert.ok(seen.some((url) => url.includes("/listings/collection/boredapeyachtclub/nfts/1/best")));
  assert.ok(seen.every((url) => !url.includes("/seaport/listings")));
});

test("opensea buy takes collection floor", async () => {
  const seen: string[] = [];
  const client = openseaBuyClient((url) => {
    seen.push(url);
    if (url.includes("/listings/collection/") && url.includes("/best")) {
      return { listings: [listingJson("6390")] };
    }
    return { chains: [{ chain: "ethereum" }] };
  });
  const result = await openseaBuy(
    creds(),
    { chain: "ethereum", slug: "traceart" },
    { connectionId: "conn_w", openseaKey: OPENSEA, client },
  );
  assert.match(result, /bought #6390 for 1 ETH/);
  assert.ok(seen.some((url) => url.includes("/listings/collection/traceart/best")));
  assert.ok(seen.every((url) => !url.includes("/nfts/")));
});

test("opensea buy floor from contract", async () => {
  const seen: string[] = [];
  const client = openseaBuyClient((url) => {
    seen.push(url);
    if (url.includes("/contract/")) {
      return { collection: "traceart" };
    }
    if (url.includes("/listings/collection/") && url.includes("/best")) {
      return { listings: [listingJson("3612")] };
    }
    return { chains: [{ chain: "ethereum" }] };
  });
  const result = await openseaBuy(
    creds(),
    { chain: "ethereum", contract: BAYC },
    { connectionId: "conn_w", openseaKey: OPENSEA, client },
  );
  assert.match(result, /bought #3612 for 1 ETH/);
  assert.ok(seen.some((url) => url.includes("/listings/collection/traceart/best")));
});

test("opensea buy requires slug or contract", async () => {
  await assert.rejects(
    () =>
      openseaBuy(
        creds(),
        { chain: "ethereum" },
        {
          connectionId: "conn_w",
          openseaKey: OPENSEA,
          client: openseaBuyClient(() => ({ chains: [{ chain: "ethereum" }] })),
        },
      ),
    /slug or contract is required/,
  );
});

test("opensea buy requires opensea key", async () => {
  const previousKey = process.env.OPENSEA_API_KEY;
  const previousAuto = process.env.OPENSEA_AUTO_KEY;
  delete process.env.OPENSEA_API_KEY;
  delete process.env.OPENSEA_AUTO_KEY;
  try {
    const empty = { ...creds(), opensea_key: "" };
    await assert.rejects(
      () =>
        openseaBuy(
          empty,
          { chain: "ethereum", contract: ANVIL_ADDR, token_id: "1" },
          { connectionId: "conn_w", openseaKey: null, client: mockFetch(() => ({ status: 200, json: {} })) },
        ),
      /no OpenSea API key/,
    );
  } finally {
    if (previousKey !== undefined) {
      process.env.OPENSEA_API_KEY = previousKey;
    }
    if (previousAuto !== undefined) {
      process.env.OPENSEA_AUTO_KEY = previousAuto;
    }
  }
});

test("sync wallet writes catalog and send off", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const pinged = { n: 0 };
  const db = new MemoryMcpDatabase();
  const pool = new McpPool(db, 10 * 60 * 1000);
  runConnectors(CONNECTORS.withAdapter("wallet", {
    async validate(stored) {
      pinged.n += 1;
      assert.equal(stored.alchemy_key, ALCHEMY);
      assert.equal(stored.opensea_key, OPENSEA);
      return "";
    },
  }));
  const connection = walletConnection();
  const first = await pool.syncTools(connection, SERVER, { force: true });
  const second = await pool.syncTools(connection, SERVER);
  assert.equal(pinged.n, 1);
  const expected = TOOLS.filter((spec) => spec.name !== "uniswap_swap");
  assert.deepEqual(
    first.map((tool) => tool.namespaced_name),
    expected.map((spec) => `wallet_${spec.name}`),
  );
  assert.ok(!first.some((tool) => tool.remote_name === "uniswap_swap"));
  assert.deepEqual(first, second);
  assert.deepEqual(
    first[0],
    {
      remote_name: "get_address",
      namespaced_name: "wallet_get_address",
      description: TOOLS[0]!.description,
      input_schema: TOOLS[0]!.input_schema,
      read_only_hint: null,
      destructive_hint: null,
    },
  );
  for (const spec of expected) {
    if (!spec.mutating) {
      continue;
    }
    const row = db.bindings.get(`mcp_tool:wallet_${spec.name}:guild_1`);
    assert.equal(row?.enabled, false);
  }
  const sendRow = db.bindings.get("mcp_tool:wallet_send:guild_1");
  assert.ok(sendRow);
  sendRow.enabled = true;
  pool.forget("conn_w");
  await pool.syncTools(connection, SERVER);
  assert.equal(db.bindings.get("mcp_tool:wallet_send:guild_1")?.enabled, true);
  assert.equal(db.bindings.get("mcp_tool:wallet_swap:guild_1")?.enabled, false);
});

test("sync wallet lists uniswap swap when keyed", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const seen: Array<string | null | undefined> = [];
  const db = new MemoryMcpDatabase();
  const pool = new McpPool(db, 10 * 60 * 1000);
  runConnectors(CONNECTORS.withAdapter("wallet", {
    async validate(stored) {
      seen.push(stored.uniswap_key);
      return "";
    },
  }));
  const first = await pool.syncTools(walletConnection({ uniswap_key: UNISWAP }), SERVER, { force: true });
  assert.deepEqual(seen, [UNISWAP]);
  assert.ok(first.some((tool) => tool.remote_name === "uniswap_swap"));
  assert.equal(db.bindings.get("mcp_tool:wallet_uniswap_swap:guild_1")?.enabled, false);
});

test("sync wallet rejects bad key", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const pool = new McpPool(new MemoryMcpDatabase());
  runConnectors(CONNECTORS.withAdapter("wallet", {
    async validate() {
      throw new ConnectorError("Alchemy API key was rejected", 401);
    },
  }));
  await assert.rejects(
    () =>
      pool.syncTools(walletConnection(), SERVER, { force: true }),
    (error: unknown) => error instanceof McpError && error.status === 401 && /rejected/.test(error.message),
  );
});

test("call wallet dispatches", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const seen: Record<string, unknown> = {};
  const pool = new McpPool(new MemoryMcpDatabase());
  runConnectors(CONNECTORS.withAdapter("wallet", {
    async call(name, arguments_, stored, ctx) {
      seen.name = name;
      seen.arguments = arguments_;
      seen.connection_id = ctx.connection_id;
      seen.alchemy = stored.alchemy_key;
      seen.opensea = stored.opensea_key;
      return ANVIL_ADDR;
    },
  }));
  const stored = await pool.call(walletConnection(), SERVER, {
    tool: "get_address",
    arguments: { chain: "ethereum" },
    caller: OPERATOR_CALLER,
  });
  assert.equal(stored, ANVIL_ADDR);
  assert.deepEqual(seen, {
    name: "get_address",
    arguments: { chain: "ethereum" },
    connection_id: "conn_w",
    alchemy: ALCHEMY,
    opensea: OPENSEA,
  });
});

test("validate pings with the login's keys and translates a rejected key", async () => {
  const pool = new McpPool(new MemoryMcpDatabase());
  runConnectors(CONNECTORS);
  const stored = {
    evm_private_key: ANVIL_KEY,
    solana_private_key: SOLANA_KEY,
    alchemy_key: ALCHEMY,
    opensea_key: OPENSEA,
  };
  pool.fetchFn = mockFetch((url) =>
    url.includes("api.opensea.io") ? { status: 200, json: { chains: [{ chain: "ethereum" }] } } : rpcOk("0x1"),
  );
  assert.equal(await pool.validate(SERVER, stored), "");
  await assert.rejects(
    () => pool.validate(SERVER, { ...stored, evm_private_key: "0x11" }),
    (error: unknown) =>
      error instanceof McpError && error.status === 401 && error.message === "wallet credentials are required",
  );
  pool.fetchFn = mockFetch((url) =>
    url.includes("api.opensea.io") ? { status: 401, json: { error: "invalid key" } } : rpcOk("0x1"),
  );
  await assert.rejects(
    () => pool.validate(SERVER, stored),
    (error: unknown) =>
      error instanceof McpError && error.status === 401 && error.message === "OpenSea API key was rejected",
  );
});

test("call runs the wallet tool on the login's keys", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const pool = new McpPool(new MemoryMcpDatabase());
  runConnectors(CONNECTORS);
  assert.equal(await pool.call(walletConnection(), SERVER, { tool: "get_address", arguments: { chain: "ethereum" }, caller: OPERATOR_CALLER }), ANVIL_ADDR);
  assert.equal(
    await pool.call(walletConnection(), SERVER, { tool: "get_address", arguments: { chain: "solana" }, caller: OPERATOR_CALLER }),
    SOLANA_KEYPAIR.publicKey.toBase58(),
  );
});
