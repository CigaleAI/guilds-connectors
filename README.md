# guilds.run connectors

The connectors and recipes published at `registry.guilds.run`, the
registry a guilds.run box reads unless its `REGISTRY_URL` names
another. A box's platform admin installs one under **Admin →
Connector catalog → Install from the registry**. The format and the
install are core's
([Registry](https://github.com/CigaleAI/guilds/blob/main/docs/tools-and-connectors/registry.md),
[Connectors](https://github.com/CigaleAI/guilds/blob/main/docs/tools-and-connectors/connectors.md)).

Connectors that every box needs ship with core. This repository holds
the rest, and anyone may add one by pull request.

## Layout

| Path | Holds |
| --- | --- |
| `connectors/<slug>/connector.json` | The connector's manifest, in core's format. The folder name is its slug |
| `connectors/<slug>/registry.json` | The release: `version` (`major.minor.patch`), `publisher`, and `experimental` when the publisher is still trying it out |
| `connectors/<slug>/logo.svg` | Optional |
| `connectors/<slug>/adapter.ts` | For a connector with code: the adapter, and beside it the TypeScript it imports |
| `recipes/<name>/recipe.json` | A recipe, in core's format |
| `recipes/<name>/registry.json` | As for a connector, without `experimental` |
| `test/` | Tests, one file per connector with code, and `build.test.ts` for the check itself |
| `scripts/build.ts` | The check: it builds every package the registry publishes |
| `package.json` | The packages an adapter imports, `@guildsrun/orchestrator` among them |

## Adding a connector

A connector is either endpoint-only or has code.

- **Endpoint-only.** A remote MCP server: `connector.json` with an
  `endpoint`, signing in with a token, dynamic OAuth, an OAuth client
  of its own, or nothing. It may not declare a `state` hook.
- **With code.** `adapter.ts` default-exports the adapter. The build
  bundles it with what it imports into one `adapter.js`. It runs
  inside the box's orchestrator process, so it installs only once
  verified (below). Add its tests under `test/`.

The check refuses a connector that:

- reuses a slug core ships
- reaches for the box's own wiring: a shipped integration's key, the
  box's OAuth client, or the GitHub App. A key or an OAuth client of
  its own (`auth.instance: { "own": true }`, or `configured` with no
  provider) is fine. The box's admin fills it in for that connector
- holds files a package cannot carry
- has a `registry.json` with fields beyond the release

A change to a published connector bumps its `version`.

## Verification

A merged connector is published as unverified. A box installs an
unverified endpoint-only connector when its admin accepts that. A
connector with code is listed but does not install until verified.

Guilds verifies a connector by reviewing one version of its source. The
mark names that version and a digest of every file in the folder, so
any later change publishes unverified until Guilds reviews it again.
Verification is kept by the registry's publisher, not in this
repository, and a `registry.json` cannot claim it.

## Running the check

The check runs against core, checked out into `core/`:

```bash
git clone https://github.com/CigaleAI/guilds.git core
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm check
```

`pnpm check` prints each package with its version and source digest.
CI runs the same steps on every pull request against core's `main`.

## Licence

GNU Affero General Public License, version 3 only ([LICENSE](LICENSE)),
as core is. A contribution is licensed under the same terms by the act
of submitting it.
