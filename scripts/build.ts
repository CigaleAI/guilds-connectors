import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { endpointOnlyProblem, loadManifest } from "@guildsrun/orchestrator/connectors/manifest.js";
import { parseRecipe } from "@guildsrun/orchestrator/recipes/schema.js";
import { codeManifestProblem } from "@guildsrun/orchestrator/registry/client.js";
import { parseIndex, type RegistryIndex } from "@guildsrun/orchestrator/registry/index.js";
import { packTarball } from "@guildsrun/orchestrator/registry/tar.js";
import { connectorFiles } from "@guildsrun/orchestrator/scripts/build-connector.js";

/** What `registry.json` beside a connector or recipe says about the version it publishes. */
export type Release = { version: string; publisher: string; experimental: boolean };

/** One published folder: the version it publishes, the digest of its source, and whether it carries code. */
export type Source = { version: string; sha256: string; code: boolean };

/** A built registry: its index, the files beside it by path, and each folder's source by `connectors/<slug>` or `recipes/<name>`. */
export type BuiltRegistry = { index: RegistryIndex; files: Map<string, Buffer>; sources: Map<string, Source> };

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const RELEASE_KEYS = ["version", "publisher", "experimental"];
const PACKAGE_FILES = ["connector.json", "logo.svg"];

/** Reads and checks the `registry.json` of a connector or recipe folder. */
export function readRelease(folder: string): Release {
  const file = path.join(folder, "registry.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !RELEASE_KEYS.includes(key));
  if (unknown.length) {
    throw new Error(`${file}: ${unknown.join(", ")} is not a release field; it holds ${RELEASE_KEYS.join(", ")}`);
  }
  if (typeof raw.version !== "string" || !VERSION.test(raw.version)) {
    throw new Error(`${file}: version must be major.minor.patch`);
  }
  if (typeof raw.publisher !== "string" || !raw.publisher) {
    throw new Error(`${file}: publisher is required`);
  }
  if (raw.experimental !== undefined && typeof raw.experimental !== "boolean") {
    throw new Error(`${file}: experimental must be true or false`);
  }
  return { version: raw.version, publisher: raw.publisher, experimental: raw.experimental === true };
}

function filesUnder(folder: string, prefix = ""): string[] {
  return readdirSync(path.join(folder, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? filesUnder(folder, relative) : [relative];
    })
    .sort();
}

/**
 * The SHA-256 of a folder's source: every file under it, by relative path, length, and bytes. Any
 * change to a file, a name, or the set of files changes it.
 */
export function sourceDigest(folder: string): string {
  const hash = createHash("sha256");
  for (const relative of filesUnder(folder)) {
    const body = readFileSync(path.join(folder, relative));
    hash.update(`${relative}\0${body.length}\0`);
    hash.update(body);
  }
  return hash.digest("hex");
}

/** The slugs of the connectors core ships: each folder beside core's manifest loader that holds a `connector.json`. */
export function coreSlugs(): Set<string> {
  const dir = path.dirname(fileURLToPath(import.meta.resolve("@guildsrun/orchestrator/connectors/manifest.js")));
  return new Set(
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, "connector.json")))
      .map((entry) => entry.name),
  );
}

function folders(root: string): string[] {
  return existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
}

function hashed(relative: string, body: Buffer) {
  return { path: relative, sha256: createHash("sha256").update(body).digest("hex"), size: body.length };
}

/**
 * Builds the registry from `root`. Each `connectors/<slug>/` holds `connector.json`, an optional
 * `logo.svg`, `registry.json`, and for a connector with code `adapter.ts` and the TypeScript it
 * imports; core's loader checks it (endpoint-only without code), and core's bundler packs it. A
 * slug core ships is refused. Each `recipes/<name>/` holds `recipe.json` and `registry.json`,
 * checked with core's parser. Every entry is unverified and the index is unsigned: the publisher
 * of the registry marks what it verified and signs the index.
 */
export async function buildRegistry(root: string, options: { now?: Date } = {}): Promise<BuiltRegistry> {
  const files = new Map<string, Buffer>();
  const sources = new Map<string, Source>();
  const index: RegistryIndex = { generated_at: (options.now ?? new Date()).toISOString(), connectors: [], recipes: [] };
  const shipped = coreSlugs();
  for (const slug of folders(path.join(root, "connectors"))) {
    const folder = path.join(root, "connectors", slug);
    if (shipped.has(slug)) {
      throw new Error(`connectors/${slug}: core ships a connector with this slug`);
    }
    const code = existsSync(path.join(folder, "adapter.ts"));
    const unknown = readdirSync(folder).filter(
      (name) => name !== "registry.json" && !PACKAGE_FILES.includes(name) && !(code && name.endsWith(".ts")),
    );
    if (unknown.length) {
      throw new Error(
        `connectors/${slug}: ${unknown.join(", ")} cannot be published; a package holds ${PACKAGE_FILES.join(" and ")}, and adapter.ts with the TypeScript it imports`,
      );
    }
    const manifest = loadManifest(JSON.parse(readFileSync(path.join(folder, "connector.json"), "utf8")), slug);
    const problem = code ? codeManifestProblem(manifest) : endpointOnlyProblem(manifest);
    if (problem !== null) {
      throw new Error(`connectors/${slug}: ${problem}`);
    }
    const { version, publisher, experimental } = readRelease(folder);
    const body = packTarball(await connectorFiles(folder));
    const relative = `connectors/${slug}/${version}.tgz`;
    files.set(relative, body);
    sources.set(`connectors/${slug}`, { version, sha256: sourceDigest(folder), code });
    index.connectors.push({
      slug,
      version,
      ...hashed(relative, body),
      publisher,
      verified: false,
      ...(experimental ? { experimental } : {}),
      display_name: manifest.display_name,
      description: manifest.description,
    });
  }
  for (const name of folders(path.join(root, "recipes"))) {
    const folder = path.join(root, "recipes", name);
    const body = readFileSync(path.join(folder, "recipe.json"));
    const recipe = parseRecipe(JSON.parse(body.toString("utf8")));
    const { version, publisher } = readRelease(folder);
    const relative = `recipes/${name}/${version}.json`;
    files.set(relative, body);
    sources.set(`recipes/${name}`, { version, sha256: sourceDigest(folder), code: false });
    index.recipes.push({
      name,
      version,
      ...hashed(relative, body),
      publisher,
      verified: false,
      display_name: recipe.meta.name,
      description: recipe.meta.description,
    });
  }
  return { index: parseIndex(index), files, sources };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ?? ".";
  const built = await buildRegistry(root);
  for (const [key, source] of built.sources) {
    console.log(`${key}@${source.version}${source.code ? " (code)" : ""}\tsource ${source.sha256}`);
  }
  console.log(`check: ${built.index.connectors.length} connectors, ${built.index.recipes.length} recipes`);
}
