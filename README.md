# guilds.run connectors

The connectors and recipes published at `registry.guilds.run`, the
registry a guilds.run box reads unless its `REGISTRY_URL` names
another. A box's platform admin installs one under **Admin →
Connector catalog → Install from the registry**, and every
organisation on the box can then connect it.

Connectors that every box needs ship with core
([CigaleAI/guilds](https://github.com/CigaleAI/guilds)). This
repository holds the rest, and anyone may add one by pull request.

## Two kinds of connector

- **Endpoint-only.** A remote MCP server that already exists. The
  connector is a manifest that says where it is and how to sign in;
  the box's MCP client lists and calls its tools. Most connectors are
  this kind, and they are the quickest to add and to verify.
- **With code.** An adapter written in TypeScript that calls an API
  itself, or wraps an endpoint. Use it when there is no MCP server,
  or to add what one lacks: a curated tool list, a settings search
  box, or a value placed in every run's State. The code runs inside
  the box's orchestrator process, so it installs only once Guilds has
  verified it ([Verification](#verification)).

## Layout

Each connector is one folder under `connectors/`, named by its slug:

```text
connectors/<slug>/
  connector.json   the manifest: everything that is not code
  registry.json    the release: version and publisher
  logo.svg         optional: 24×24, drawn in currentColor
  adapter.ts       with code only: default-exports the adapter
  *.ts             with code only: the TypeScript adapter.ts imports
```

| Path | Holds |
| --- | --- |
| `connectors/<slug>/` | One connector, as above |
| `recipes/<name>/recipe.json` | A recipe, in core's format, beside its own `registry.json` |
| `test/` | Tests: one file per connector with code, and `build.test.ts` for the check itself |
| `scripts/build.ts` | The check: it builds every package the registry publishes |
| `package.json` | The packages an adapter may import, `@guildsrun/orchestrator` among them |

## The shape of a connector

### `registry.json`

```json
{ "version": "1.0.0", "publisher": "your-github-handle" }
```

| Key | Meaning |
| --- | --- |
| `version` | `major.minor.patch`. Every change to a published connector bumps it |
| `publisher` | Who publishes it: your GitHub handle or your organisation's |
| `experimental` | Optional, `true` while you are still trying it out. A box installs it only when its admin accepts that |

Nothing else goes in it. In particular, a connector cannot declare
itself verified.

### `connector.json`

The smallest connector is a public MCP server with no sign-in:

```json
{
  "slug": "context7",
  "display_name": "Context7",
  "endpoint": { "url": "https://mcp.context7.com/mcp" },
  "auth": { "kind": "none" },
  "description": "Up-to-date documentation and code examples for libraries and frameworks, looked up by library name."
}
```

One that each organisation signs into with an API key, sent in a
header of the service's choosing, whose writing tools start Off:

```json
{
  "slug": "acme",
  "display_name": "Acme",
  "endpoint": { "url": "https://mcp.acme.example.com/mcp" },
  "auth": {
    "kind": "token",
    "fields": [{ "name": "token", "label": "Acme API key", "secret": true }],
    "header": { "name": "x-api-key", "prefix": "" }
  },
  "description": "Tickets and customers in an Acme workspace.",
  "limitations": "Read and write within the key's workspace only.",
  "setup_hint": "Create an API key under Acme → Settings → API.",
  "policy": { "default_off": ["create_*", "update_*", "delete_*"] }
}
```

The keys:

| Key | Meaning |
| --- | --- |
| `slug` | Lowercase letters, digits, and `_`, starting with a letter; equal to the folder name. Agents see the tools as `<slug>_<tool>` |
| `display_name` | The name in the catalog |
| `description` | What it gives an agent, in one sentence. The guild builder reads it to decide when to use the connector |
| `limitations`, `setup_hint` | Optional operator copy: what it cannot do, and what to have ready before connecting |
| `endpoint.url` | The remote MCP server, public HTTPS. Required without code |
| `auth` | How a login signs in ([below](#signing-in)) |
| `tools[]` | Optional curated tools `{ name, description, input_schema, mutating }`. Without it the box lists the endpoint's own |
| `policy.default_off` | Tool name patterns (`*` matches anything) that start Off until the operator turns them on |
| `settings_schema` | With code: a JSON Schema for settings a login stores beside its credentials |
| `state` | With code: `{ key, intro }`, a value the adapter places in every run's State, and the sentence telling the agent what it is |
| `prompt.guidance` | A paragraph the agent's prompt adds when one of the connector's tools is offered |

Core documents every key in
[Access → Catalog](https://github.com/CigaleAI/guilds/blob/main/docs/concepts/access.md#catalog).

A tool also starts Off when the manifest marks it `mutating`, or,
for a tool listed from the endpoint, when the server flags it
destructive or its name carries a writing verb. Mark anything that
spends, sends, or deletes as Off.

### Signing in

| `auth` | Who signs in | Use it when |
| --- | --- | --- |
| `{ "kind": "none" }` | Nobody | The server is public |
| `{ "kind": "token" }` | Each organisation pastes a key | The service issues API keys. `fields` names the inputs (default: one secret field named `token`); `header` names the header the key travels in (default: `Authorization: Bearer`) |
| `{ "kind": "oauth", "oauth": { "strategy": "dynamic" } }` | Each organisation signs in in the browser | The server supports dynamic client registration, as Linear's does |
| `{ "kind": "oauth", "oauth": { "strategy": "configured" } }` | Each organisation signs in in the browser, with a client the box's admin registers once | The service needs a pre-registered OAuth app. The box's admin fills in its Client ID and secret under **Admin → Platform keys** as `connector:<slug>` |
| `{ "kind": "token", "instance": { "own": true } }` | The box's admin enters one key for every organisation | The service is paid for once per box. The admin fills it in under **Admin → Platform keys** as `connector:<slug>` |

A connector may not use the box's own wiring: one of core's
integration keys (`instance.integration`), a client the box holds
(`configured` with a `provider`), or the GitHub App.

### `adapter.ts`

A connector with code default-exports an adapter. Every method is
optional; a missing one falls back to the endpoint, or to nothing.

| Method | Runs | Returns |
| --- | --- | --- |
| `validate(creds, ctx)` | On Connect and when settings change | A short account hint shown on the login. Throw to refuse the credentials |
| `list(creds, ctx)` | When the box lists tools | The tools; without it, the endpoint's, else the manifest's `tools` |
| `call(name, args, creds, ctx)` | On each tool call | The result text |
| `lookup(property, query, creds, ctx)` | When a settings field marked `x-lookup` is searched | `{ value, label, detail?, image? }` options |
| `state(creds, ctx)` | At every run start | The value under the manifest's `state.key`, or `null` for none |

`creds` holds the login's fields by name, and `ctx.settings` its
settings. Make every HTTP request through `ctx.http`, which has the
box's proxy and timeout, and reach the connector's endpoint, when it
has one, through `ctx.remote`. Throw a `ConnectorError` with an HTTP
status for an error the operator should see.

A minimal adapter, with its tool listed in `connector.json`:

```ts
import { ConnectorError, requiredCredential, type Adapter } from "@guildsrun/orchestrator/connectors/types.js";

const API = "https://api.acme.example.com";

const adapter: Adapter = {
  async validate(creds, ctx) {
    const key = requiredCredential(creds, "token", "api key is required");
    const response = await ctx.http(`${API}/me`, { headers: { authorization: `Bearer ${key}` } });
    if (!response.ok) {
      throw new ConnectorError("Acme rejected the API key", 401);
    }
    const me = (await response.json()) as { email: string };
    return me.email;
  },
  async call(name, args, creds, ctx) {
    if (name !== "ticket") {
      throw new ConnectorError(`Acme has no tool ${name}`, 404);
    }
    const key = requiredCredential(creds, "token", "api key is required");
    const response = await ctx.http(`${API}/tickets/${encodeURIComponent(String(args.id))}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    return response.text();
  },
};

export default adapter;
```

The build bundles `adapter.ts` with what it imports into one
`adapter.js`. It may import core (`@guildsrun/orchestrator/...`), the
TypeScript beside it, and the packages in `package.json`; adding a
package means adding it there in the same pull request. Add tests
under `test/<slug>.test.ts`, with HTTP mocked:
`test/pinned_prices.test.ts` is a worked example, and
`connectors/pinned_prices/` one of a settings search box and a State
value.

## Submitting a pull request

1. **Fork and clone** this repository, and clone core into `core/`
   inside it, which the check builds against:

   ```bash
   git clone git@github.com:<you>/guilds-connectors.git
   cd guilds-connectors
   git clone https://github.com/CigaleAI/guilds.git core
   pnpm install
   ```

2. **Add the folder** `connectors/<slug>/` with `connector.json` and
   `registry.json`, plus `adapter.ts` and its tests for a connector
   with code. Check that core does not ship the slug already: it
   would be refused.

3. **Run the check**, the same one CI runs:

   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm check
   ```

   `pnpm check` builds every package and prints each with its version
   and source digest. A refused connector stops it with the reason.

4. **Try it on a box** if you run one. An endpoint-only connector can
   be added by hand under **Admin → Connector catalog** with the same
   endpoint and sign-in, then connected and its tools called.

5. **Open the pull request** against `main`, one connector per pull
   request. Say what the service is, how to get credentials for it,
   and which tools write. The check runs on it, against core's `main`.

6. **Review and merge.** A maintainer reviews it and merges it once
   the check passes. It goes live the next time Guilds publishes the
   registry: unverified, unless Guilds verified it in the same
   publish.

To change a published connector, open a pull request the same way
and bump `version` in `registry.json`.

## What the check refuses

- a manifest that does not validate against core's schema, or whose
  slug differs from its folder
- a slug core ships
- an endpoint that is not public HTTPS
- no endpoint and no `adapter.ts`, or a `state` without an adapter
- the box's own wiring: one of core's integration keys, a client the
  box holds, or the GitHub App
- a file a package cannot carry: anything beyond `connector.json`,
  `logo.svg`, and `registry.json`, and with code `adapter.ts` and the
  TypeScript beside it
- a `registry.json` with keys beyond the release, or a version that is
  not `major.minor.patch`

## Verification

A box installs an unverified connector without code when its admin
accepts that, and lists an unverified connector with code without
installing it.

Guilds verifies a connector by reviewing one version of its source.
The mark names that version and a digest of every file in the
folder, so any later change publishes unverified until Guilds reviews
it again. Verification is kept by the registry's publisher, not in
this repository.

## Licence

GNU Affero General Public License, version 3 only ([LICENSE](LICENSE)),
as core is. A contribution is licensed under the same terms by the act
of submitting it.
