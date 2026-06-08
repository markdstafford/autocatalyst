# Code map

Last updated: 2026-06-08

> How agents navigate the codebase. Keep this current: whenever you add, move, or significantly
> change a module, update the relevant section in the same change.

## Source tree

- `apps/control-plane/` — bootable headless Fastify control-plane service. `src/config.ts` reads `CONTROL_PLANE_PORT`/`CONTROL_PLANE_DATABASE_PATH` or `--port`/`--database-path`; `src/server.ts` composes core routes with persistence; `src/main.ts` is the executable entrypoint; `src/integration.spec.ts` proves health, probe-resource persistence across restart, SSE, and degraded database health.
- `packages/api-contract/` — shared API contract package. `src/health.ts`, `src/probe-resource.ts`, `src/errors.ts`, and `src/sse.ts` own Zod schemas, inferred types, route constants, and status constants. `src/openapi.ts` generates OpenAPI from those schemas and constants. Public entry point: `packages/api-contract/src/index.ts`.
- `packages/core/` — control-plane core package. `src/health.ts` owns dependency health behavior, `src/probe-resource.ts` owns proof-resource use cases and repository interfaces, and `src/routes.ts` registers Fastify routes using contract schemas. Public entry point: `packages/core/src/index.ts`. It may import the execution package through `@autocatalyst/execution` but must not import execution internals.
- `packages/execution/` — execution-plane package. Public entry point: `packages/execution/src/index.ts`.
  Internal files such as `packages/execution/src/internal/workspace-driver.ts` are not importable by control-plane code.
- `packages/persistence/` — persistence package. `src/sqlite.ts` owns the opaque SQLite handle, migrations, and reachability; `src/schema.ts` is the internal Drizzle schema; `src/probe-resource-repository.ts` implements the core repository. Committed migrations live under `packages/persistence/drizzle/`. Public entry point: `packages/persistence/src/index.ts`.
- `packages/sdk/` — SDK package. `src/client.ts` exposes typed health and probe-resource calls derived from `@autocatalyst/api-contract`. Public entry point: `packages/sdk/src/index.ts`.
- `tools/boundary-tests/` — committed lint-level boundary assertions. The invalid fixture is excluded from normal
  package lint and is checked only by `pnpm test:boundaries`.

## Key entry points

- Root workspace metadata: `package.json`, `pnpm-workspace.yaml`, `.npmrc`.
- Nx task graph and cache defaults: `nx.json`.
- Shared TypeScript paths and compiler settings: `tsconfig.base.json`.
- Lint and module-boundary rules: `eslint.config.mjs`.
- Package project metadata and tags: `packages/*/project.json`.

## Build / test / run commands

Run these from the repository root on Node.js 22+:

```bash
pnpm install
pnpm nx show projects
pnpm nx run-many -t build
pnpm nx run-many -t lint
pnpm nx run-many -t test
pnpm test:boundaries
pnpm validate
```

`pnpm validate` runs build, lint, test, then the committed execution-boundary test.

## Control-plane service envelope commands

```bash
# Start the service
CONTROL_PLANE_PORT=3000 CONTROL_PLANE_DATABASE_PATH=.data/control-plane.sqlite pnpm nx serve control-plane

# Run tests
pnpm nx test control-plane
pnpm nx test api-contract
pnpm nx test core
pnpm nx test persistence
pnpm nx test sdk

# Generate future migrations from schema (do not run before adding new schema changes)
pnpm drizzle-kit generate --config packages/persistence/drizzle.config.ts

# Full validation
pnpm validate
```

Runtime startup applies committed migrations with `migrateSqliteDatabase(database)`. Use the Drizzle Kit command only to generate future migrations from `packages/persistence/src/schema.ts`; do not require migration generation before running tests or the app.

## Package generation path

Use the built-in Nx JavaScript library generator. This concrete example creates an adapter-scoped package named `example-provider`; use the same command shape for each future package and change only the two shell variable values before running it:

```bash
PACKAGE_NAME=example-provider
PACKAGE_SCOPE=adapter
pnpm nx g @nx/js:library "packages/${PACKAGE_NAME}" \
  --bundler=tsc \
  --unitTestRunner=vitest \
  --linter=eslint \
  --importPath="@autocatalyst/${PACKAGE_NAME}" \
  --strict=true \
  --minimal=true
```

After generation, verify or add these concrete fields for the `example-provider` package in `packages/example-provider/project.json`:

```json
{
  "projectType": "library",
  "tags": ["type:lib", "scope:adapter"],
  "targets": {
    "build": {},
    "lint": {},
    "test": {}
  }
}
```

Use the established initial tags as examples:

- `api-contract`: `type:lib`, `scope:contract`
- `core`: `type:lib`, `scope:core`, `plane:control`
- `control-plane`: `type:app`, `scope:control-plane`, `plane:control`
- `execution`: `type:lib`, `scope:execution`, `plane:execution`
- `persistence`: `type:lib`, `scope:persistence`, `plane:control`
- `sdk`: `type:lib`, `scope:sdk`

## Boundary enforcement

- `@nx/enforce-module-boundaries` is active in `eslint.config.mjs` for TypeScript files.
- `no-restricted-imports` blocks `@autocatalyst/execution/src/*` and relative execution `src/*` patterns.
- `pnpm test:boundaries` lints two committed fixtures:
  - `tools/boundary-tests/fixtures/valid-control-plane-import.ts` must pass with `@autocatalyst/execution`.
  - `tools/boundary-tests/fixtures/invalid-execution-internal-import.ts` must fail with `no-restricted-imports`.
