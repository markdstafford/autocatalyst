# Code map

Last updated: 2026-06-07

> How agents navigate the codebase. Keep this current: whenever you add, move, or significantly
> change a module, update the relevant section in the same change.

## Source tree

- `apps/` — deployable application targets. The scaffold keeps this empty except for `apps/.gitkeep`;
  desktop, mobile, and service shells are outside the initial scaffold scope.
- `packages/api-contract/` — shared API contract package. Public entry point: `packages/api-contract/src/index.ts`.
  It owns Zod schemas and inferred types; later OpenAPI and SDK generation should derive from this package.
- `packages/core/` — control-plane core package. Public entry point: `packages/core/src/index.ts`.
  It may import the execution package through `@autocatalyst/execution` but must not import execution internals.
- `packages/execution/` — execution-plane package. Public entry point: `packages/execution/src/index.ts`.
  Internal files such as `packages/execution/src/internal/workspace-driver.ts` are not importable by control-plane code.
- `packages/persistence/` — persistence package. Public entry point: `packages/persistence/src/index.ts`.
  The scaffold records SQLite as the initial storage engine; real Drizzle repositories are later work.
- `packages/sdk/` — SDK package. Public entry point: `packages/sdk/src/index.ts`.
  The scaffold consumes types from `@autocatalyst/api-contract`.
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
- `execution`: `type:lib`, `scope:execution`, `plane:execution`
- `persistence`: `type:lib`, `scope:persistence`, `plane:control`
- `sdk`: `type:lib`, `scope:sdk`

## Boundary enforcement

- `@nx/enforce-module-boundaries` is active in `eslint.config.mjs` for TypeScript files.
- `no-restricted-imports` blocks `@autocatalyst/execution/src/*` and relative execution `src/*` patterns.
- `pnpm test:boundaries` lints two committed fixtures:
  - `tools/boundary-tests/fixtures/valid-control-plane-import.ts` must pass with `@autocatalyst/execution`.
  - `tools/boundary-tests/fixtures/invalid-execution-internal-import.ts` must fail with `no-restricted-imports`.
