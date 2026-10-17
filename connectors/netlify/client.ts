import { createHash } from "node:crypto";
import type { FetchFn } from "@guildsrun/orchestrator/net/http.js";

export const NETLIFY_API = "https://api.netlify.com/api/v1";
const USER_AGENT = "Guilds (https://guilds.run)";

/** How often a deploy is checked while Netlify works on it, and how long one wait lasts. */
export const POLL_MS = 2_000;
export const WAIT_MS = 60_000;

export class NetlifyError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "NetlifyError";
    this.status = status;
  }
}

/** A site a login may deploy to, as its settings store it. */
export type Site = { id: string; name: string; url: string };

/** A deploy as Netlify reports it, reduced to what the connector reads. */
export type Deploy = {
  id: string;
  site_id: string;
  state: string;
  title?: string | null;
  deploy_ssl_url?: string | null;
  required?: string[] | null;
  error_message?: string | null;
  created_at?: string | null;
  published_at?: string | null;
};

type RawSite = { id: string; name: string; ssl_url?: string | null; url?: string | null; updated_at?: string | null; published_deploy?: { id?: string } | null };

export type Options = { token: string; client: FetchFn };

function message(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return "Netlify rejected the access token";
  }
  if (status === 404) {
    return "Netlify found no such site or deploy for this access token";
  }
  if (status === 429) {
    return "Netlify's rate limit was reached (deploys: 3 a minute, 100 a day); try again later";
  }
  let detail = body.slice(0, 200);
  try {
    const parsed = JSON.parse(body) as { message?: unknown; errors?: unknown };
    if (typeof parsed.message === "string") {
      detail = parsed.message;
    }
  } catch {
    // A body that is not JSON is quoted as it came.
  }
  return `Netlify answered ${status}${detail ? `: ${detail}` : ""}`;
}

async function request<T>(options: Options, method: string, path: string, body?: { json: unknown } | { bytes: Buffer }): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}`, "user-agent": USER_AGENT };
  let payload: string | Uint8Array | undefined;
  if (body && "json" in body) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body.json);
  } else if (body) {
    headers["content-type"] = "application/octet-stream";
    payload = new Uint8Array(body.bytes);
  }
  const response = await options.client(`${NETLIFY_API}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  const text = await response.text();
  if (!response.ok) {
    throw new NetlifyError(message(response.status, text), response.status);
  }
  return (text ? JSON.parse(text) : null) as T;
}

function site(raw: RawSite): Site {
  return { id: raw.id, name: raw.name, url: raw.ssl_url || raw.url || "" };
}

export async function currentUser(options: Options): Promise<{ email: string }> {
  const user = await request<{ email?: string | null; full_name?: string | null }>(options, "GET", "/user");
  return { email: user.email || user.full_name || "" };
}

/** The sites the token reaches whose name contains `query`. */
export async function searchSites(query: string, options: Options): Promise<Site[]> {
  const params = new URLSearchParams({ filter: "all", per_page: "20", ...(query.trim() ? { name: query.trim() } : {}) });
  return (await request<RawSite[]>(options, "GET", `/sites?${params}`)).map(site);
}

/** One site with the id of the deploy it serves. */
export async function getSite(siteId: string, options: Options): Promise<Site & { published_deploy_id: string | null; updated_at: string | null }> {
  const raw = await request<RawSite>(options, "GET", `/sites/${encodeURIComponent(siteId)}`);
  return { ...site(raw), published_deploy_id: raw.published_deploy?.id ?? null, updated_at: raw.updated_at ?? null };
}

export async function getDeploy(deployId: string, options: Options): Promise<Deploy> {
  return request<Deploy>(options, "GET", `/deploys/${encodeURIComponent(deployId)}`);
}

/** Makes a deploy the one its site serves: a draft goes live, an older deploy comes back. */
export async function publishDeploy(siteId: string, deployId: string, options: Options): Promise<Deploy> {
  return request<Deploy>(options, "POST", `/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}/restore`);
}

/** A file to deploy: its path in the site, with `/` between parts, and its bytes. */
export type SiteFile = { path: string; bytes: Buffer };

/** What Netlify's digest method sends: each file's SHA-1 by its path from the site's root. */
export function digest(files: SiteFile[]): { files: Record<string, string>; bySha: Map<string, SiteFile> } {
  const digests: Record<string, string> = {};
  const bySha = new Map<string, SiteFile>();
  for (const file of files) {
    if (/[#?]/.test(file.path)) {
      throw new NetlifyError(`${file.path}: Netlify refuses a file path holding # or ?`, 422);
    }
    const sha = createHash("sha1").update(file.bytes).digest("hex");
    digests[`/${file.path}`] = sha;
    if (!bySha.has(sha)) {
      bySha.set(sha, file);
    }
  }
  return { files: digests, bySha };
}

type Waiting = { sleep?: (ms: number) => Promise<void>; now?: () => number; waitMs?: number; pollMs?: number };

async function waitWhile(deployId: string, states: readonly string[], options: Options & Waiting): Promise<Deploy> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const until = now() + (options.waitMs ?? WAIT_MS);
  let deploy = await getDeploy(deployId, options);
  while (states.includes(deploy.state) && now() < until) {
    await sleep(options.pollMs ?? POLL_MS);
    deploy = await getDeploy(deployId, options);
  }
  if (deploy.state === "error") {
    throw new NetlifyError(`Netlify failed deploy ${deploy.id}: ${deploy.error_message || "no reason given"}`, 502);
  }
  return deploy;
}

/**
 * Deploys `files` to a site as a draft, which has a URL of its own and leaves the live site as
 * it is. Netlify's digest method sends every file's SHA-1, and the connector uploads only the
 * files Netlify does not hold yet. Waits a bounded time for the draft to be ready, and returns it
 * in whatever state it reached, with how many files went up.
 */
export async function deployDraft(
  siteId: string,
  files: SiteFile[],
  options: Options & Waiting & { title?: string },
): Promise<{ deploy: Deploy; uploaded: number }> {
  const { files: digests, bySha } = digest(files);
  const created = await request<Deploy>(options, "POST", `/sites/${encodeURIComponent(siteId)}/deploys`, {
    json: { files: digests, draft: true, async: true, ...(options.title ? { title: options.title } : {}) },
  });
  const prepared = await waitWhile(created.id, ["new", "preparing"], options);
  if (prepared.state === "preparing" || prepared.state === "new") {
    throw new NetlifyError(`Netlify is still preparing deploy ${created.id}; deploy again later`, 504);
  }
  const required = prepared.required ?? [];
  for (const sha of required) {
    const file = bySha.get(sha);
    if (!file) {
      throw new NetlifyError(`Netlify asked for a file this deploy does not hold (${sha})`, 502);
    }
    const path = file.path.split("/").map(encodeURIComponent).join("/");
    await request<unknown>(options, "PUT", `/deploys/${encodeURIComponent(created.id)}/files/${path}`, { bytes: file.bytes });
  }
  const deploy = await waitWhile(created.id, ["new", "preparing", "prepared", "uploading", "uploaded", "processing"], options);
  return { deploy, uploaded: required.length };
}
