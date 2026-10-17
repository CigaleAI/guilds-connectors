import { AgentFileError, readAgentFolder } from "@guildsrun/orchestrator/lib/agent-file.js";
import { ConnectorError, requiredCredential, translated, type Adapter, type ConnectorContext, type Credentials } from "@guildsrun/orchestrator/connectors/types.js";
import {
  currentUser,
  deployDraft,
  getDeploy,
  getSite,
  NetlifyError,
  publishDeploy,
  searchSites,
  type Deploy,
  type Options,
  type Site,
} from "./client.js";

/** The most a deploy reads from the workspace. */
export const MAX_FILES = 5_000;
export const MAX_BYTES = 100 * 1024 * 1024;

/** The states from which a deploy may become the live one. */
const PUBLISHABLE = ["ready", "current", "old"];

function options(creds: Credentials, ctx: ConnectorContext): Options {
  return { token: requiredCredential(creds, "token", "a Netlify access token is required"), client: ctx.http };
}

function allowedSites(ctx: ConnectorContext): Site[] {
  const sites = Array.isArray(ctx.settings.sites) ? (ctx.settings.sites as Partial<Site>[]) : [];
  return sites.flatMap((entry) => (typeof entry.id === "string" ? [{ id: entry.id, name: entry.name ?? entry.id, url: entry.url ?? "" }] : []));
}

function siteNamed(ctx: ConnectorContext, named: unknown): Site {
  const sites = allowedSites(ctx);
  const wanted = typeof named === "string" ? named.trim() : "";
  const found = sites.find((entry) => entry.id === wanted || entry.name === wanted);
  if (!found) {
    const names = sites.map((entry) => entry.name).join(", ") || "none";
    throw new ConnectorError(`${wanted || "site"} is not a site this login may deploy to; it may deploy to: ${names}`, 403);
  }
  return found;
}

function text(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConnectorError(`${name} is required`, 400);
  }
  return value.trim();
}

async function deployOfLogin(deployId: string, opts: Options, ctx: ConnectorContext): Promise<{ deploy: Deploy; site: Site }> {
  const deploy = await getDeploy(deployId, opts);
  const site = allowedSites(ctx).find((entry) => entry.id === deploy.site_id);
  if (!site) {
    throw new ConnectorError(`deploy ${deployId} belongs to a site this login may not deploy to`, 403);
  }
  return { deploy, site };
}

function described(deploy: Deploy, site: Site) {
  return {
    deploy_id: deploy.id,
    site: site.name,
    state: deploy.state,
    draft_url: deploy.deploy_ssl_url ?? null,
    ...(deploy.title ? { title: deploy.title } : {}),
    ...(deploy.error_message ? { error: deploy.error_message } : {}),
    ...(deploy.created_at ? { created_at: deploy.created_at } : {}),
    ...(deploy.published_at ? { published_at: deploy.published_at } : {}),
  };
}

const tools: Record<string, (args: Record<string, unknown>, opts: Options, ctx: ConnectorContext) => Promise<unknown>> = {
  async sites(_args, opts, ctx) {
    return Promise.all(
      allowedSites(ctx).map(async (entry) => {
        const current = await getSite(entry.id, opts);
        return { id: current.id, name: current.name, url: current.url, live_deploy_id: current.published_deploy_id, updated_at: current.updated_at };
      }),
    );
  },
  async deploy(args, opts, ctx) {
    const site = siteNamed(ctx, args.site);
    const folderPath = text("folder_path", args.folder_path);
    if (!ctx.workspace_dir) {
      throw new ConnectorError("deploy reads the agent's workspace, so it runs only from an agent's run", 400);
    }
    let folder;
    try {
      folder = await readAgentFolder(ctx.workspace_dir, folderPath, { maxFiles: MAX_FILES, maxBytes: MAX_BYTES });
    } catch (error) {
      if (error instanceof AgentFileError) {
        throw new ConnectorError(error.message, 422);
      }
      throw error;
    }
    if (!folder.files.length) {
      throw new ConnectorError("folder_path holds no files", 422);
    }
    const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
    const { deploy, uploaded } = await deployDraft(site.id, folder.files, { ...opts, ...(title ? { title } : {}) });
    return {
      ...described(deploy, site),
      files: folder.files.length,
      uploaded,
      ...(deploy.state === "ready" ? {} : { note: "Netlify is still processing this draft; check it with deploy_status." }),
    };
  },
  async deploy_status(args, opts, ctx) {
    const { deploy, site } = await deployOfLogin(text("deploy_id", args.deploy_id), opts, ctx);
    return described(deploy, site);
  },
  async publish(args, opts, ctx) {
    const site = siteNamed(ctx, args.site);
    const { deploy } = await deployOfLogin(text("deploy_id", args.deploy_id), opts, ctx);
    if (deploy.site_id !== site.id) {
      throw new ConnectorError(`deploy ${deploy.id} belongs to another site than ${site.name}`, 422);
    }
    if (!PUBLISHABLE.includes(deploy.state)) {
      throw new ConnectorError(`deploy ${deploy.id} is ${deploy.state}; only a ready deploy can be published`, 409);
    }
    const published = await publishDeploy(site.id, deploy.id, opts);
    const current = await getSite(site.id, opts);
    return { deploy_id: published.id, site: current.name, state: published.state, url: current.url };
  },
};

const adapter: Adapter = {
  async validate(creds, ctx) {
    const opts = options(creds, ctx);
    const user = await translated(NetlifyError, () => currentUser(opts));
    const sites = allowedSites(ctx);
    for (const entry of sites) {
      try {
        await getSite(entry.id, opts);
      } catch (error) {
        if (error instanceof NetlifyError && error.status === 404) {
          throw new ConnectorError(`site ${entry.name} is not reachable with this access token`, 422);
        }
        throw error instanceof NetlifyError ? new ConnectorError(error.message, error.status) : error;
      }
    }
    return sites.length ? `${user.email} · ${sites.length} site${sites.length === 1 ? "" : "s"}` : user.email;
  },
  async lookup(property, query, creds, ctx) {
    if (property !== "sites") {
      throw new ConnectorError(`Netlify has no lookup for ${property}`, 404);
    }
    const sites = await translated(NetlifyError, () => searchSites(query, options(creds, ctx)));
    return sites.map((entry) => ({ value: entry, label: entry.name, ...(entry.url ? { detail: entry.url } : {}) }));
  },
  async call(name, args, creds, ctx) {
    const tool = tools[name];
    if (!tool) {
      throw new ConnectorError(`Netlify has no tool ${name}`, 404);
    }
    const result = await translated(NetlifyError, () => tool(args, options(creds, ctx), ctx));
    return JSON.stringify(result, null, 2);
  },
};

export default adapter;
