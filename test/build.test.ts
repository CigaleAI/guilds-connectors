import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseRecipe } from "@guildsrun/orchestrator/recipes/parse.js";
import { RegistryClient } from "@guildsrun/orchestrator/registry/client.js";
import { buildRegistry, coreSlugs, sourceDigest } from "../scripts/build.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function servedBy(built: Awaited<ReturnType<typeof buildRegistry>>): RegistryClient {
  const base = "https://registry.test";
  return new RegistryClient(base, async (url) => {
    const relative = url.slice(base.length + 1);
    const body = relative === "index.json" ? Buffer.from(JSON.stringify(built.index)) : built.files.get(relative);
    return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response("missing", { status: 404 });
  });
}

function connectorFolder(manifest: Record<string, unknown>, release: Record<string, unknown> = {}): { root: string; folder: string } {
  const root = mkdtempSync(path.join(tmpdir(), "guilds-connectors-"));
  const folder = path.join(root, "connectors", String(manifest.slug));
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "registry.json"), JSON.stringify({ version: "1.0.0", publisher: "acme", ...release }));
  writeFileSync(path.join(folder, "connector.json"), JSON.stringify(manifest));
  return { root, folder };
}

const ACME = {
  slug: "acme",
  display_name: "Acme",
  endpoint: { url: "https://mcp.acme.example.com/mcp" },
  auth: { kind: "token" },
  description: "",
};

test("every connector and recipe in this repository builds, unverified, and core's client reads each package back", async () => {
  const built = await buildRegistry(ROOT);
  assert.ok(built.index.connectors.length > 0);
  assert.equal(built.index.signature, undefined);
  const client = servedBy(built);
  for (const entry of (await client.index()).connectors) {
    assert.equal(entry.verified, false);
    const pkg = await client.connectorPackage(entry);
    assert.equal(pkg.manifest.slug, entry.slug);
    assert.equal(built.sources.get(`connectors/${entry.slug}`)?.version, entry.version);
  }
  for (const entry of (await client.index()).recipes) {
    parseRecipe(JSON.parse((await client.recipeFile(entry)).toString("utf8")));
  }
});

test("a connector that claims the box's credentials or ships unbundled code is refused", async () => {
  const { root, folder } = connectorFolder({ ...ACME, auth: { kind: "token", instance: { integration: "web-search", field: "api_key" } } });
  await assert.rejects(() => buildRegistry(root), /asks for the box's web-search key/);
  writeFileSync(
    path.join(folder, "connector.json"),
    JSON.stringify({ ...ACME, auth: { kind: "oauth", oauth: { strategy: "configured", provider: "google-connectors" } } }),
  );
  await assert.rejects(() => buildRegistry(root), /signs in with the box's google-connectors client/);
  writeFileSync(path.join(folder, "connector.json"), JSON.stringify(ACME));
  assert.equal((await buildRegistry(root)).index.connectors[0]?.slug, "acme");
  writeFileSync(path.join(folder, "adapter.js"), "export default {}");
  await assert.rejects(() => buildRegistry(root), /adapter\.js cannot be published/);
});

test("a connector may declare a key or an OAuth client of its own", async () => {
  const { root, folder } = connectorFolder({
    ...ACME,
    auth: { kind: "token", fields: [{ name: "api_key", label: "Acme key" }], instance: { own: true } },
  });
  assert.equal((await buildRegistry(root)).index.connectors[0]?.slug, "acme");
  writeFileSync(path.join(folder, "connector.json"), JSON.stringify({ ...ACME, auth: { kind: "oauth", oauth: { strategy: "configured" } } }));
  assert.equal((await buildRegistry(root)).index.connectors[0]?.slug, "acme");
});

test("a release cannot mark itself verified, and a slug core ships is refused", async () => {
  const { root } = connectorFolder(ACME, { verified: true });
  await assert.rejects(() => buildRegistry(root), /verified is not a release field/);
  const [shipped] = [...coreSlugs()];
  assert.ok(shipped);
  const taken = connectorFolder({ ...ACME, slug: shipped });
  await assert.rejects(() => buildRegistry(taken.root), /core ships a connector with this slug/);
});

test("a connector with code is bundled into one adapter", async () => {
  const { root, folder } = connectorFolder({
    slug: "echo",
    display_name: "Echo",
    auth: { kind: "none" },
    description: "",
    tools: [{ name: "say", description: "Says it back.", input_schema: { type: "object" } }],
  });
  writeFileSync(path.join(folder, "words.ts"), "export const prefix = 'echo: ';\n");
  writeFileSync(
    path.join(folder, "adapter.ts"),
    "import { prefix } from './words.ts';\nexport default { async call(_name: string, args: Record<string, unknown>) { return prefix + String(args.text); } };\n",
  );
  const built = await buildRegistry(root);
  assert.equal(built.sources.get("connectors/echo")?.code, true);
  const pkg = await servedBy(built).connectorPackage(built.index.connectors[0]!);
  assert.match(String(pkg.adapter), /echo: /);
  assert.doesNotMatch(String(pkg.adapter), /from ['"]\.\/words/);
});

test("the source digest changes with any file in the folder", () => {
  const { folder } = connectorFolder(ACME);
  const before = sourceDigest(folder);
  assert.equal(sourceDigest(folder), before);
  writeFileSync(path.join(folder, "logo.svg"), "<svg/>");
  const withLogo = sourceDigest(folder);
  assert.notEqual(withLogo, before);
  writeFileSync(path.join(folder, "connector.json"), JSON.stringify({ ...ACME, description: "Changed." }));
  assert.notEqual(sourceDigest(folder), withLogo);
});
