import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CoinGeckoError } from "@guildsrun/orchestrator/connectors/coingecko/client.js";
import { loadConnector } from "@guildsrun/orchestrator/connectors/servers.js";
import { ConnectorRegistry, folderEntry, type ConnectorEntry } from "@guildsrun/orchestrator/connectors/registry.js";
import { ConnectorError } from "@guildsrun/orchestrator/connectors/types.js";
import { decodeMasterKey } from "@guildsrun/orchestrator/config/index.js";
import { encryptPayload } from "@guildsrun/orchestrator/credentials/crypto.js";
import type { McpConnectionRow } from "@guildsrun/orchestrator/db/mcp.js";
import { McpError } from "@guildsrun/orchestrator/mcp/errors.js";
import { McpPool, type ConnectorLogin } from "@guildsrun/orchestrator/mcp/pool.js";
import { HEX_MASTER_KEY } from "@guildsrun/orchestrator/test/helpers/env.js";
import { mockFetch } from "@guildsrun/orchestrator/test/helpers/http.js";
import { restoreConnectorsAfterEach, runConnectors } from "@guildsrun/orchestrator/test/helpers/installed.js";
import { MemoryMcpDatabase } from "@guildsrun/orchestrator/test/helpers/mcp-database.js";
import adapter from "../connectors/pinned_prices/adapter.js";
import {
  PINNED_PRICES_MAX,
  assertPinnedIdsQuoted,
  pinnedPriceEntries,
  validatePinnedPrices,
} from "../connectors/pinned_prices/client.js";

const FOLDER = fileURLToPath(new URL("../connectors/pinned_prices", import.meta.url));
const MANIFEST: unknown = JSON.parse(readFileSync(`${FOLDER}/connector.json`, "utf8"));
const ENTRY = folderEntry(MANIFEST, adapter, FOLDER, "guilds");
const CONNECTORS = new ConnectorRegistry([ENTRY]);
const SERVER = installedServer(ENTRY);
const KEY = decodeMasterKey(HEX_MASTER_KEY);
const PINNED = [
  { id: "ethereum", symbol: "ETH", name: "Ethereum" },
  { id: "tesla-xstock", symbol: "TSLAX", name: "Tesla xStock" },
];

/** The connector as `getMcpServer` loads it: the entry installed on the platform, with no overrides. */
function installedServer(entry: ConnectorEntry) {
  const stamp = "2026-10-12T09:00:00.000Z";
  return loadConnector({
    id: entry.id,
    slug: entry.manifest.slug,
    tool_prefix: entry.manifest.slug,
    owner_org_id: null,
    manifest: entry.manifest,
    source: entry.source,
    version: "",
    verified: entry.verified,
    experimental: false,
    publisher: entry.publisher,
    enabled: true,
    oauth_client: null,
    overrides: {},
    installed_at: stamp,
    updated_at: stamp,
  });
}

restoreConnectorsAfterEach();

/** A pool on a box that runs `connectors`, with nothing stored. */
function pool(connectors: ConnectorRegistry = CONNECTORS): McpPool {
  runConnectors(connectors);
  return new McpPool(new MemoryMcpDatabase());
}

/** An agent's one login: a token login to Pinned prices, with `connection` over it. */
function stateLogins(connection: Partial<McpConnectionRow> & Pick<McpConnectionRow, "ciphertext" | "nonce">): ConnectorLogin[] {
  const stamp = "2026-10-12T09:00:00.000Z";
  return [
    {
      connection: {
        id: "conn_pins",
        mcp_server_id: SERVER.id,
        owner_scope: "org",
        owner_id: "org_1",
        account_hint: "",
        status: "connected",
        oauth_state: null,
        settings: {},
        created_at: stamp,
        updated_at: stamp,
        rotated_at: stamp,
        ...connection,
      },
      server: SERVER,
    },
  ];
}

function sealed(token: string) {
  const [ciphertext, nonce] = encryptPayload({ token }, KEY);
  return { ciphertext, nonce };
}

test("the registry refuses Pinned prices without its state hook", () => {
  assert.equal(ENTRY.id, "mcp_pinned_prices");
  assert.equal(ENTRY.manifest.state?.key, "prices");
  assert.throws(() => new ConnectorRegistry([{ ...ENTRY, adapter: {} }]), /no state hook/);
});

test("pinned_prices normalizes symbol and name", () => {
  assert.deepEqual(validatePinnedPrices([{ id: " bitcoin ", symbol: "btc" }]), [
    { id: "bitcoin", symbol: "BTC", name: "bitcoin" },
  ]);
});

test("pinned_prices rejects bad shapes, ids, duplicates, and overflow", () => {
  assert.throws(() => validatePinnedPrices("ethereum"), /must be an array/);
  assert.throws(() => validatePinnedPrices(["ethereum"]), /entries must be objects/);
  assert.throws(() => validatePinnedPrices([{ id: "Ethereum/../x" }]), /CoinGecko coin id/);
  assert.throws(() => validatePinnedPrices([{ id: "ethereum" }, { id: "ethereum" }]), /twice/);
  const many = Array.from({ length: PINNED_PRICES_MAX + 1 }, (_, index) => ({ id: `coin-${index}` }));
  assert.throws(() => validatePinnedPrices(many), /at most/);
});

test("assertPinnedIdsQuoted rejects ids CoinGecko does not quote", async () => {
  await assert.rejects(
    () =>
      assertPinnedIdsQuoted(PINNED, async (ids) => {
        assert.deepEqual(ids, ["ethereum", "tesla-xstock"]);
        return { ethereum: { usd: 1, change_24h: null, updated_at: null } };
      }),
    /unknown CoinGecko ids: tesla-xstock/,
  );
  await assertPinnedIdsQuoted([], async () => {
    throw new Error("empty pins must not fetch");
  });
});

test("pinnedPriceEntries attaches quotes and explains missing ones", async () => {
  const entries = await pinnedPriceEntries(PINNED, {
    fetch: async (ids) => {
      assert.deepEqual(ids, ["ethereum", "tesla-xstock"]);
      return { ethereum: { usd: 3200.5, change_24h: -1.2345, updated_at: 1_790_000_000 } };
    },
  });
  assert.deepEqual(entries, [
    {
      id: "ethereum",
      symbol: "ETH",
      name: "Ethereum",
      usd: 3200.5,
      change_24h_pct: -1.23,
      updated_at: new Date(1_790_000_000 * 1000).toISOString(),
    },
    { id: "tesla-xstock", symbol: "TSLAX", name: "Tesla xStock", unavailable: "CoinGecko returned no price" },
  ]);
});

test("pinnedPriceEntries marks every coin when the fetch fails or is unavailable", async () => {
  const failed = await pinnedPriceEntries(PINNED, {
    fetch: async () => {
      throw new CoinGeckoError("rate limited", 429);
    },
  });
  assert.ok(failed.every((entry) => entry.unavailable === "CoinGecko: rate limited"));
  const offline = await pinnedPriceEntries(PINNED, { unavailable: "not connected" });
  assert.ok(offline.every((entry) => entry.unavailable === "not connected" && !("usd" in entry)));
  assert.deepEqual(await pinnedPriceEntries([], { unavailable: "unused" }), []);
});

test("validate pings CoinGecko, checks every pin is quoted, and hints the coin count", async () => {
  const paths: string[] = [];
  const prices = pool();
  prices.fetchFn = mockFetch((url) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    if (parsed.pathname.endsWith("/ping")) {
      return { status: 200, json: { gecko_says: "(V3) To the Moon!" } };
    }
    return { status: 200, json: { ethereum: { usd: 3200 }, "tesla-xstock": { usd: 410 } } };
  });
  assert.equal(await prices.validate(SERVER, { token: "cg" }, { coins: PINNED }), "2 coins");
  assert.deepEqual(paths, ["/api/v3/ping", "/api/v3/simple/price"]);
  assert.equal(await prices.validate(SERVER, { token: "cg" }, { coins: [PINNED[0]] }), "1 coin");
  paths.length = 0;
  assert.equal(await prices.validate(SERVER, { token: "cg" }), "");
  assert.deepEqual(paths, ["/api/v3/ping"]);
});

test("validate rejects a missing key, bad pins, unquoted pins, and a rejected key", async () => {
  const prices = pool();
  prices.fetchFn = mockFetch((url) =>
    url.includes("/ping") ? { status: 200, json: {} } : { status: 200, json: { ethereum: { usd: 3200 } } },
  );
  const status = (expected: number, message: RegExp) => (error: unknown) =>
    error instanceof McpError && error.status === expected && message.test(error.message);
  await assert.rejects(() => prices.validate(SERVER, {}, { coins: PINNED }), status(401, /api key is required/));
  await assert.rejects(() => prices.validate(SERVER, { token: "cg" }, { coins: "ethereum" }), status(422, /must be an array/));
  await assert.rejects(
    () => prices.validate(SERVER, { token: "cg" }, { coins: PINNED }),
    status(422, /unknown CoinGecko ids: tesla-xstock/),
  );
  prices.fetchFn = mockFetch(() => ({ status: 401, json: { error: "invalid key" } }));
  await assert.rejects(() => prices.validate(SERVER, { token: "bad" }, { coins: PINNED }), status(401, /./));
});

test("lookup searches CoinGecko coins with the form's credentials", async () => {
  const prices = pool();
  prices.fetchFn = mockFetch((url) => {
    assert.match(url, /\/search\?query=eth$/);
    return {
      status: 200,
      json: {
        coins: [
          { id: "ethereum", symbol: "eth", name: "Ethereum", market_cap_rank: 2, thumb: "t.png" },
          { id: "ethereum-classic", symbol: "etc", name: "Ethereum Classic" },
        ],
      },
    };
  });
  assert.deepEqual(await prices.lookup(SERVER, { property: "coins", q: "eth" }, { token: "cg" }), [
    { value: { id: "ethereum", symbol: "ETH", name: "Ethereum" }, label: "Ethereum (ETH)", detail: "#2", image: "t.png" },
    { value: { id: "ethereum-classic", symbol: "ETC", name: "Ethereum Classic" }, label: "Ethereum Classic (ETC)" },
  ]);
  await assert.rejects(
    () => prices.lookup(SERVER, { property: "chains", q: "eth" }, { token: "cg" }),
    (error: unknown) => error instanceof McpError && error.status === 404,
  );
});

test("state quotes the login's pinned coins under the manifest's key", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  let ids = "";
  const prices = pool();
  prices.fetchFn = mockFetch((url) => {
    ids = new URL(url).searchParams.get("ids") ?? "";
    return {
      status: 200,
      json: { ethereum: { usd: 3200, usd_24h_change: 1, last_updated_at: 1_790_000_000 } },
    };
  });
  const state = await prices.state(stateLogins({ ...sealed("cg-secret"), settings: { coins: PINNED } }));
  assert.equal(ids, "ethereum,tesla-xstock");
  assert.deepEqual(state, {
    prices: [
      {
        id: "ethereum",
        symbol: "ETH",
        name: "Ethereum",
        usd: 3200,
        change_24h_pct: 1,
        updated_at: new Date(1_790_000_000 * 1000).toISOString(),
      },
      { id: "tesla-xstock", symbol: "TSLAX", name: "Tesla xStock", unavailable: "CoinGecko returned no price" },
    ],
  });
});

test("state leaves out a login with no pins and redacts the key", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const prices = pool();
  prices.fetchFn = mockFetch(() => {
    throw new Error("no pins must not fetch");
  });
  assert.deepEqual(await prices.state(stateLogins(sealed("cg"))), {});
  const leaky = pool(CONNECTORS.withAdapter("pinned_prices", { state: async (creds) => ({ leaked: creds.token }) }));
  assert.deepEqual(await leaky.state(stateLogins(sealed("cg-secret"))), {
    prices: { leaked: "[REDACTED:token]" },
  });
});

test("state marks the prices unavailable when the hook fails", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const failing = pool(
    CONNECTORS.withAdapter("pinned_prices", {
      state: async () => {
        throw new ConnectorError("quota exhausted", 429);
      },
    }),
  );
  assert.deepEqual(await failing.state(stateLogins(sealed("cg"))), {
    prices: { unavailable: "quota exhausted" },
  });
});
