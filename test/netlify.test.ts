import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isConnectorError, type ConnectorContext } from "@guildsrun/orchestrator/connectors/types.js";
import adapter from "../connectors/netlify/adapter.js";
import { deployDraft, NETLIFY_API, NetlifyError, type Deploy } from "../connectors/netlify/client.js";

const SITE = { id: "site-1", name: "launch", url: "https://launch.netlify.app" };
const OTHER = "site-2";
const CREDS = { token: "nfp_test" };

type Call = { method: string; path: string; body: string | Uint8Array | undefined; headers: Record<string, string> };

/** A Netlify stand-in: one site, and deploys that become ready once every required file is up. */
function netlify(options: { deployState?: string; deploySite?: string; status?: number } = {}) {
  const calls: Call[] = [];
  let required: string[] = [];
  const uploaded = new Set<string>();
  let digests: Record<string, string> = {};
  const deploy = (): Deploy => ({
    id: "deploy-1",
    site_id: options.deploySite ?? SITE.id,
    state: options.deployState ?? (required.every((sha) => uploaded.has(sha)) ? "ready" : "prepared"),
    required,
    deploy_ssl_url: "https://deploy-1--launch.netlify.app",
  });
  const http = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const pathname = url.slice(NETLIFY_API.length);
    calls.push({ method, path: pathname, body: init.body as string | Uint8Array | undefined, headers: init.headers as Record<string, string> });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (options.status) {
      return json({ message: "nope" }, options.status);
    }
    if (method === "GET" && pathname === "/user") {
      return json({ email: "ops@example.com" });
    }
    if (method === "GET" && pathname.startsWith("/sites?")) {
      return json([{ id: SITE.id, name: SITE.name, ssl_url: SITE.url }]);
    }
    if (method === "GET" && pathname === `/sites/${SITE.id}`) {
      return json({ id: SITE.id, name: SITE.name, ssl_url: SITE.url, published_deploy: { id: "deploy-0" } });
    }
    if (method === "POST" && pathname === `/sites/${SITE.id}/deploys`) {
      digests = (JSON.parse(String(init.body)) as { files: Record<string, string> }).files;
      required = [...new Set(Object.values(digests))].filter((sha) => sha !== digests["/cached.txt"]);
      return json({ id: "deploy-1", site_id: SITE.id, state: "preparing" });
    }
    if (method === "GET" && pathname === "/deploys/deploy-1") {
      return json(deploy());
    }
    if (method === "PUT" && pathname.startsWith("/deploys/deploy-1/files/")) {
      const file = `/${decodeURIComponent(pathname.slice("/deploys/deploy-1/files/".length))}`;
      uploaded.add(createHash("sha1").update(init.body as Uint8Array).digest("hex"));
      assert.equal(createHash("sha1").update(init.body as Uint8Array).digest("hex"), digests[file]);
      return json({});
    }
    if (method === "POST" && pathname === `/sites/${SITE.id}/deploys/deploy-1/restore`) {
      return json({ id: "deploy-1", site_id: SITE.id, state: "current" });
    }
    return json({ message: "not found" }, 404);
  };
  return { http, calls };
}

function context(http: ConnectorContext["http"], extra: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    http,
    remote: {
      initialize: () => Promise.reject(new Error("no endpoint")),
      list: () => Promise.reject(new Error("no endpoint")),
      call: () => Promise.reject(new Error("no endpoint")),
    },
    connection_id: "conn_1",
    settings: { sites: [SITE] },
    ...extra,
  };
}

function workspace(): string {
  const base = mkdtempSync(path.join(tmpdir(), "guilds-netlify-"));
  const home = path.join(base, "a_1");
  mkdirSync(path.join(home, "app", "dist", "assets"), { recursive: true });
  writeFileSync(path.join(home, "app", "dist", "index.html"), "<h1>Launch</h1>");
  writeFileSync(path.join(home, "app", "dist", "assets", "site.css"), "h1{}");
  writeFileSync(path.join(home, "app", "dist", "assets", "copy of site.css"), "h1{}");
  writeFileSync(path.join(home, "app", "dist", "cached.txt"), "already on Netlify");
  return home;
}

async function refusedWith(run: () => Promise<unknown>, status: number, pattern: RegExp) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(isConnectorError(error), String(error));
    assert.equal(error.status, status);
    assert.match(error.message, pattern);
    return true;
  });
}

test("deploy uploads a workspace folder as a draft, sending only the files Netlify asks for, once per content", async () => {
  const { http, calls } = netlify();
  const ctx = context(http, { workspace_dir: workspace() });
  const result = JSON.parse(await adapter.call!("deploy", { site: "launch", folder_path: "/home/a_1/app/dist", title: "First cut" }, CREDS, ctx)) as Record<string, unknown>;
  assert.deepEqual(result, {
    deploy_id: "deploy-1",
    site: "launch",
    state: "ready",
    draft_url: "https://deploy-1--launch.netlify.app",
    files: 4,
    uploaded: 2,
  });
  const created = calls.find((call) => call.method === "POST");
  const body = JSON.parse(String(created?.body)) as { files: Record<string, string>; draft: boolean; async: boolean; title: string };
  assert.deepEqual(Object.keys(body.files).sort(), ["/assets/copy of site.css", "/assets/site.css", "/cached.txt", "/index.html"]);
  assert.equal(body.draft, true);
  assert.equal(body.async, true);
  assert.equal(body.title, "First cut");
  const puts = calls.filter((call) => call.method === "PUT").map((call) => call.path);
  assert.equal(puts.length, 2);
  assert.ok(puts.includes("/deploys/deploy-1/files/index.html"));
  assert.equal(created?.headers.authorization, "Bearer nfp_test");
  assert.ok(!calls.some((call) => call.path.includes("restore")), "a deploy never goes live by itself");
});

test("deploy refuses a site the login was not given, a folder outside the workspace, and a call from outside a run", async () => {
  const { http, calls } = netlify();
  const ctx = context(http, { workspace_dir: workspace() });
  await refusedWith(() => adapter.call!("deploy", { site: OTHER, folder_path: "app/dist" }, CREDS, ctx), 403, /may deploy to: launch/);
  await refusedWith(() => adapter.call!("deploy", { site: "launch", folder_path: "../" }, CREDS, ctx), 422, /must be under/);
  await refusedWith(() => adapter.call!("deploy", { site: "launch", folder_path: "app/dist/index.html" }, CREDS, ctx), 422, /must be a folder/);
  await refusedWith(() => adapter.call!("deploy", { site: "launch", folder_path: "app/dist" }, CREDS, context(http)), 400, /agent's run/);
  assert.equal(calls.length, 0);
});

test("publish makes a ready deploy of an allowed site live, and refuses one that is not ready or not the site's", async () => {
  const ready = netlify();
  const result = JSON.parse(await adapter.call!("publish", { site: SITE.id, deploy_id: "deploy-1" }, CREDS, context(ready.http))) as Record<string, unknown>;
  assert.deepEqual(result, { deploy_id: "deploy-1", site: "launch", state: "current", url: SITE.url });
  assert.ok(ready.calls.some((call) => call.method === "POST" && call.path === `/sites/${SITE.id}/deploys/deploy-1/restore`));

  const failed = netlify({ deployState: "error" });
  await refusedWith(() => adapter.call!("publish", { site: "launch", deploy_id: "deploy-1" }, CREDS, context(failed.http)), 409, /is error/);
  const elsewhere = netlify({ deploySite: OTHER });
  await refusedWith(() => adapter.call!("publish", { site: "launch", deploy_id: "deploy-1" }, CREDS, context(elsewhere.http)), 403, /may not deploy to/);
  await refusedWith(() => adapter.call!("deploy_status", { deploy_id: "deploy-1" }, CREDS, context(elsewhere.http)), 403, /may not deploy to/);
  assert.ok(![...failed.calls, ...elsewhere.calls].some((call) => call.path.includes("restore")));
});

test("validate names the account and checks every allowed site; lookup searches the token's sites", async () => {
  const { http } = netlify();
  assert.equal(await adapter.validate!(CREDS, context(http)), "ops@example.com · 1 site");
  await refusedWith(
    () => adapter.validate!(CREDS, context(http, { settings: { sites: [{ id: "gone", name: "gone" }] } })),
    422,
    /site gone is not reachable/,
  );
  await refusedWith(() => adapter.validate!(CREDS, context(netlify({ status: 401 }).http)), 401, /rejected the access token/);
  await refusedWith(() => adapter.validate!({}, context(http)), 401, /token is required/);
  assert.deepEqual(await adapter.lookup!("sites", "lau", CREDS, context(http)), [{ value: SITE, label: "launch", detail: SITE.url }]);
  await refusedWith(() => adapter.call!("sites", {}, CREDS, context(netlify({ status: 429 }).http)), 429, /rate limit/);
});

test("a draft Netlify keeps preparing past the wait, or fails, is an error, and a path with # is refused before any call", async () => {
  let clock = 0;
  const waiting = { sleep: async (ms: number) => void (clock += ms), now: () => clock, waitMs: 10_000, pollMs: 2_000 };
  const stuck = netlify({ deployState: "preparing" });
  await assert.rejects(
    () => deployDraft(SITE.id, [{ path: "index.html", bytes: Buffer.from("x") }], { token: "t", client: stuck.http, ...waiting }),
    (error: unknown) => error instanceof NetlifyError && error.status === 504,
  );
  const failed = netlify({ deployState: "error" });
  await assert.rejects(
    () => deployDraft(SITE.id, [{ path: "index.html", bytes: Buffer.from("x") }], { token: "t", client: failed.http, ...waiting }),
    (error: unknown) => error instanceof NetlifyError && error.status === 502,
  );
  const none = netlify();
  await assert.rejects(
    () => deployDraft(SITE.id, [{ path: "a#b.html", bytes: Buffer.from("x") }], { token: "t", client: none.http }),
    /# or \?/,
  );
  assert.equal(none.calls.length, 0);
});
