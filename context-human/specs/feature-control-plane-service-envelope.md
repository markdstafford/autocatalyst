---
created: 2026-06-07
last_updated: 2026-06-08
status: implementing
issue: 5
specced_by: markdstafford
---
# Feature: Control-plane service envelope

## Product requirements

### What

Build the first bootable headless control-plane service for Autocatalyst. The service starts as a thin application target under `apps/`, mounts control-plane logic from `packages/core`, exposes a minimal HTTP surface, and proves one request path from contract to persisted response.
The feature proves the envelope future product capabilities use:
- `GET /health` reports process liveness and database reachability.
- Versioned `/v1` routes validate requests and responses from Zod schemas in `packages/api-contract`.
- One trivial throwaway resource can be created, read back, and survive a service restart because it is stored in SQLite.
- A Server-Sent Events route exists and can hold a connection open, without producing real run events yet.
- The SDK can call the health endpoint and the trivial resource through typed contract-derived shapes.
The trivial resource is not a domain entity. It exists only to prove that the request -\> contract validation -\> repository -\> SQLite -\> response path works end to end.
### Why

Autocatalyst is designed as a headless service that owns state and exposes a typed network API. The repository currently has the monorepo packages and architectural decisions, but no bootable service that proves the control plane can receive validated API requests, touch durable storage, and respond through the same contract future clients will use.
This feature creates that foundation. Later domain endpoints, run execution, feedback, configuration, and operator actions can fill the same envelope instead of inventing their own API, persistence, and app boot patterns.
### Goals

- Start the control-plane service with a documented command.
- Serve an unversioned operational health endpoint at `GET /health`.
- Serve application routes under `/v1`, following the additive versioning rule.
- Declare API shapes once as Zod schemas in `packages/api-contract` and derive TypeScript types, runtime validation, OpenAPI, and SDK calls from them.
- Persist the trivial resource in SQLite through Drizzle and a repository abstraction.
- Keep control-plane logic in `packages/core`; keep the app target thin.
- Scaffold the SSE route shape so later run event production has a concrete transport seam.
- Prove the behavior with an integration test that boots the real app, checks health, writes and reads the trivial resource, and verifies persistence across restart.
- Update agent navigation docs with the new app target, run/test commands, and persistence/contract wiring.
### Non-goals

- Real Autocatalyst domain resources such as projects, conversations, topics, runs, messages, artifacts, feedback, or PR records.
- Identity, bearer-token authentication, real `Principal` handling, or policy enforcement.
- Service-owned configuration stored in the database, the structured bootstrap loader, master-secret unlock, or secret storage.
- Runner execution, workspace provisioning, real agent events, or real SSE event production.
- Desktop, mobile, chat, or tracker UI work.
- Rich operational visibility such as queue depth, running agents, token totals, traces, or metrics.
- Postgres support beyond preserving the repository abstraction and Drizzle schema path that keep the upgrade cheap.
### Personas

- **Enzo (Engineer)** needs a concrete service skeleton he can run, test, and extend without re-deciding the API and persistence envelope.
- **Phoebe (PM)** needs confidence that future product endpoints mount into a stable service path instead of remaining isolated library code.
- **Dani (Designer)** is not a direct user of this backend-only feature, but benefits when later client surfaces can rely on a typed API and health signal.
### User stories

- As Enzo, I can start the control-plane service from the repository root so I can verify there is a real process behind the architecture.
- As Enzo, I can call `GET /health` and see both process liveness and database reachability so I know the service and persistence layer are usable.
- As Enzo, I can create a trivial resource through `/v1`, read it back, restart the service, and read it again so I know data survives in SQLite.
- As Enzo, I can inspect contract schemas in `packages/api-contract` and see derived types/OpenAPI/SDK behavior so I know the API shape has one source of truth.
- As a future client author, I can connect to the SSE route and receive a valid open stream so I know where live run events will later appear.
### Acceptance criteria

#### Contract and code generation

- `packages/api-contract` owns Zod schemas for health, the trivial resource, and the SSE route surface where a schema applies.
- TypeScript request and response types are inferred from Zod schemas, not hand-written alongside them.
- The OpenAPI document is generated from schemas rather than authored by hand.
- `packages/sdk` exposes typed calls for `GET /health` and the trivial resource.
- API shapes are not duplicated across contract, core, app, SDK, and tests.
#### Versioning

- Application routes are mounted under `/v1`.
- `GET /health` remains unversioned and outside `/v1`.
- The additive-only-within-a-version rule is documented in `packages/api-contract` so future API additions see it in the package they edit.
#### Persistence

- SQLite is accessed through Drizzle.
- The trivial resource uses a repository interface from its call sites; Fastify handlers and core logic do not reach directly into the Drizzle client.
- Migration tooling is present, and a migration creates the trivial resource table.
- The database location comes from an environment variable or launch flag.
- The persistence code keeps the engine choice isolated so a later Postgres move does not require call-site changes.
#### Service

- A thin app target under `apps/` boots a Fastify control-plane service.
- Control-plane route logic and service behavior live in `packages/core` rather than the app shell.
- `GET /health` returns a minimal status that distinguishes process liveness from database reachability.
- The service reads its listen port from an environment variable or launch flag.
- An SSE endpoint exists, responds with the correct event-stream headers, and holds a connection open without real event production.
#### End to end

- One trivial resource round-trips through request validation, repository persistence, SQLite storage, and response validation.
- The trivial resource value survives a service restart.
- An integration test boots the real app and asserts health plus the persisted round-trip.
- Tests resolve workspace packages from source on a clean checkout without requiring a prior build.
- `context-agent/wiki/code-map.md` records the new app target, contract and persistence wiring, and run/test commands.
## Design spec

### Design scope

This is a backend-only feature. There is no user interface, visual design, or interaction design for a human-facing screen. The design work is the service-facing experience: how developers and future clients experience the first API envelope.
### Service experience

The service should feel boring and predictable to run:
1. A developer starts the control-plane app with a documented command and supplies a port and database path through environment variables or launch flags.
2. The service logs enough startup information to confirm which port and database file it is using, without printing secrets or noisy internals.
3. `GET /health` gives a compact machine-readable answer that can be used by a script, local developer, or future deployment health check.
4. `/v1` routes behave consistently: JSON requests in, JSON responses out, validation errors at the boundary, and no unversioned product route leakage.
### API shape

The first product route is intentionally trivial. Its naming should make clear it is a proof resource, not a domain concept. A name such as `/v1/probe-resources` or `/v1/examples` is acceptable if the code and docs mark it as temporary scaffolding. It should not be named after a real Autocatalyst noun.
The route flow is:
1. Client sends a create request with a simple value.
2. Fastify validates the request against the contract schema.
3. Core calls a repository interface to persist the value.
4. The service responds with HTTP `201 Created` and the created record.
5. Client reads the record by id and receives the same value.
The health response should separate liveness from dependency status. A healthy response can use fields such as:
```json
{
  "status": "ok",
  "database": { "status": "reachable" }
}
```
If the database check fails, the endpoint should return a non-2xx status and a body that still follows the health response schema, with the database marked unreachable.
### SSE shape

The SSE endpoint is a transport seam, not a feature-complete event stream. It should:
- Live under `/v1` because it is part of the API surface.
- Use `text/event-stream` and no-cache headers.
- Keep the connection open until the client disconnects or the server shuts down.
- Optionally send a harmless initial comment or heartbeat if needed to prove the stream is alive.
- Avoid inventing real run event payloads before `execution-runtime` event production exists.
- Tests should assert SSE behavior in HTTP terms rather than exact header literals: the `content-type` header starts with `text/event-stream`, `cache-control` includes `no-cache`, and the HTTP/1.1 stream remains open until the test closes it.
### Error and empty-state design

- Validation failures should use a consistent JSON error shape. If the project already has a Fastify validation error pattern by implementation time, use it; otherwise keep the shape small and document it in the contract package.
- Missing trivial resources should return `404` with the same error envelope.
- Database-unreachable health should be explicit instead of pretending the process is healthy.
## Tech spec

### Current state

The repository has an Nx/pnpm TypeScript monorepo with these relevant packages:
- `packages/api-contract` contains the shared contract package and a placeholder health schema.
- `packages/core` is the control-plane core package.
- `packages/persistence` is the persistence package and records SQLite as the initial storage engine.
- `packages/sdk` consumes contract types.
- `apps/` is empty except for `.gitkeep`.
The accepted architecture requires a standalone Fastify service, contract-first REST plus SSE, `/v1` versioning, Zod schemas as the source of truth, and SQLite via Drizzle behind repositories.
### Proposed package shape

- `apps/control-plane/` boots the process and owns only composition concerns: reading bootstrap options, constructing dependencies, registering routes from core, and starting/stopping Fastify.
- `packages/api-contract/` owns schemas, inferred types, OpenAPI generation entry points, and the visible versioning rule.
- `packages/core/` owns route registration or route modules, health behavior, trivial-resource use cases, and the SSE scaffold behavior.
- `packages/persistence/` owns Drizzle schema, migrations, database connection setup, and concrete repository implementations.
- `packages/sdk/` exposes typed client calls derived from the contract package.
The app shell should stay thin. Business behavior should be testable through core and persistence without requiring process boot, while at least one integration test should boot the real app to prove wiring.
### Contract model

`packages/api-contract` should define schemas for:
- Health response and dependency status values.
- Trivial resource create request.
- Trivial resource response.
- Trivial resource id/path parameter, if route helpers use schema validation for params.
- Shared error response, if the implementation introduces one for validation, not-found, or database errors.
Types should be exported with `z.infer` or equivalent inference from the schema values. OpenAPI generation should consume those same schemas. Use `@asteasolutions/zod-to-openapi` or an equivalent Zod registry-based generator: schemas remain the source of truth for request and response shapes, while each route's method, path, status codes, tags, and operation metadata may be registered once in `packages/api-contract/src/openapi.ts` using the contract route/status constants. Do not hand-author OpenAPI path objects independently from those schemas and constants. The SDK should consume contract-derived types and route metadata rather than restating request and response shapes.
The package should include a short `README` or source-level document that states the ADR-006 rule: `/v1` evolves additively; future changes add endpoints or optional fields only.
### HTTP service

Fastify should register:
- `GET /health` outside `/v1`.
- `POST /v1/` to create the proof resource.
- `GET /v1//:id` to read the proof resource.
- `GET /v1/` to hold an SSE stream open.
Route handlers should validate through schemas sourced from `api-contract`. If Fastify requires JSON Schema, derive that representation from the Zod schemas rather than hand-writing separate schemas.
The create route should return HTTP `201 Created` on success. The success status should be exported from the contract package as a route-level constant and asserted by core route, real-app integration, and SDK tests.
The service should expose a buildable app target and a documented local run command. It should support startup options for:
- Listen port.
- SQLite database file path.
The structured bootstrap loader, master secret, database-backed configuration, and auth are out of scope. Simple env/flag parsing is enough for this feature.
### Persistence

`packages/persistence` should provide:
- A Drizzle SQLite schema for the trivial resource table.
- Migration tooling and an initial migration for that table.
- Database connection creation from a file path.
- A repository interface for the trivial resource.
- A SQLite/Drizzle implementation of that repository.
- A lightweight health check operation that proves the database is reachable.
The trivial resource table only needs fields required to prove persistence, such as `id`, `value`, and timestamps if useful. It should not accrete domain fields. The repository boundary is the important part: core and route code depend on the interface, not on Drizzle details.
Migration tooling should include a Drizzle Kit config at `packages/persistence/drizzle.config.ts`. Future schema-to-SQL generation should use `pnpm drizzle-kit generate --config packages/persistence/drizzle.config.ts`; runtime application of committed migrations remains through `migrateSqliteDatabase(database)` during app startup and tests.
### SDK

`packages/sdk` should expose typed methods for:
- Reading health.
- Creating the trivial resource.
- Reading the trivial resource by id.
The SDK can be minimal. It should prove the contract package is consumable by clients and that request/response types flow from schemas through the client surface.
### Testing

Testing should include:
- Contract tests that prove inferred types and schemas accept the expected health and trivial-resource payloads.
- Repository tests that write and read the trivial resource against SQLite.
- Integration tests that boot the real app, call `GET /health`, create/read the trivial resource, restart the app, and read the same value again.
- SDK tests that call health and the trivial resource against the booted app or a test server.
- Existing build, lint, test, and boundary checks should continue to pass.
Tests should resolve workspace packages from source on a clean checkout. If Vitest needs path resolution help, configure it rather than requiring a prior package build.
### Documentation updates

Update `context-agent/wiki/code-map.md` with:
- The new control-plane app target.
- Where Fastify boot and route registration live.
- Where contract schemas and OpenAPI generation live.
- Where Drizzle schema, migrations, and repositories live.
- Local run commands and any database migration/test commands introduced by this feature.
Human-owned concept docs and ADRs already describe the target architecture and do not need changes for this feature unless implementation discovers a mismatch.
### Risks and open decisions

- **Temporary resource naming:** the implementation must choose a name that does not look like a real domain entity. The name should make the proof-only purpose clear.
- **OpenAPI tooling:** use a Zod registry-based generator such as `@asteasolutions/zod-to-openapi`; if implementation chooses an equivalent library, it must keep Zod schemas as request/response shape source and register route metadata only once.
- **Fastify validation bridge:** Fastify validates JSON Schema natively. The implementation must derive JSON Schema from Zod or use a Zod-aware bridge without duplicating shapes.
- **SSE test stability:** an endpoint that intentionally holds connections open needs tests that assert HTTP semantics, tolerate header normalization or parameters such as `charset`, and then close cleanly.
- **SQLite file lifecycle in tests:** integration tests should isolate database files so restart persistence is proven without leaking state between test runs.
## Converged API

### Files

Path
Purpose
Exports

`apps/control-plane/project.json`
Nx project definition for the bootable control-plane app with build, lint, test, and serve targets. The serve target runs the built app and reads CONTROL_PLANE_PORT/CONTROL_PLANE_DATABASE_PATH from the environment, with equivalent --port/--database-path launch flags handled by the app config reader.

`apps/control-plane/package.json`
App package metadata declaring the private control-plane app entry and workspace dependencies on core, persistence, api-contract, and SDK-facing packages as needed by the app target.

`apps/control-plane/tsconfig.json`
Composite TypeScript project configuration for the control-plane app, referencing app and spec configs in the same style as repository packages.

`apps/control-plane/tsconfig.app.json`
TypeScript build configuration used by the control-plane Nx build target for src/main.ts and app-shell modules.

`apps/control-plane/tsconfig.spec.json`
TypeScript configuration for Vitest integration specs, including app source and test files.

`apps/control-plane/vite.config.ts`
Vitest configuration for the control-plane app integration tests, including source aliases for @autocatalyst/\* workspace packages so tests run on a clean checkout without prior package builds.

`apps/control-plane/src/config.ts`
Thin app-shell configuration reader for listen port and SQLite database path from environment variables or launch flags.
`ControlPlaneAppConfig`, `readControlPlaneAppConfig`

`apps/control-plane/src/server.ts`
Composes Fastify with core route registration and persistence dependencies. createControlPlaneServer accepts one caller-owned SqliteDatabase and does not migrate, listen, or close it; startControlPlaneServer creates one database, migrates it, delegates to createControlPlaneServer, listens, and returns a lifecycle handle that exposes port/databasePath plus close(), without exposing the raw Fastify instance.
`createControlPlaneServer`, `startControlPlaneServer`, `ControlPlaneServerHandle`

`apps/control-plane/src/main.ts`
Executable entrypoint that reads configuration, starts the Fastify service through startControlPlaneServer, logs selected port/database path, and handles shutdown without owning route behavior.
`main`

`apps/control-plane/src/integration.spec.ts`
Real app integration tests. Key assertions: boot the actual Fastify app via startControlPlaneServer with a temporary SQLite file; GET /health returns 200 and the contract health body when the database is reachable; POST /v1/probe-resources returns 201, validates, persists, and returns a contract-valid resource; GET /v1/probe-resources/:id returns the same value; after handle.close() and restart against the same database path the resource is still readable; GET /v1/events returns HTTP SSE behavior where content-type starts with text/event-stream, cache-control includes no-cache, and the test closes the still-open connection cleanly; a forced unreachable-database health-check path uses createControlPlaneServer with a caller-owned SqliteDatabase, closes that database before calling GET /health, and asserts the degraded health body with HTTP 503.

`packages/api-contract/vite.config.ts`
Updated Vitest config for contract tests, retaining existing test options and adding resolve.alias entries for workspace package imports from source.

`packages/api-contract/src/health.ts`
Zod source of truth for the unversioned health endpoint response contract plus the route-level degraded health status-code constant.
`degradedHealthStatusCode`, `dependencyStatusSchema`, `healthResponseSchema`, `DependencyStatus`, `HealthResponse`

`packages/api-contract/src/health.spec.ts`
Contract tests for health schemas and constants. Key assertions: healthy and degraded payloads parse; invalid dependency/status values are rejected; inferred HealthResponse accepts the parsed shape; degradedHealthStatusCode is 503 and is the route-level source of truth for non-2xx degraded health.

`packages/api-contract/src/probe-resource.ts`
Zod source of truth for the temporary proof-only resource create/read contracts and route constants.
`probeResourceCollectionPath`, `createProbeResourceSuccessStatusCode`, `probeResourceIdParamsSchema`, `createProbeResourceRequestSchema`, `probeResourceSchema`, `ProbeResourceIdParams`, `CreateProbeResourceRequest`, `ProbeResource`

`packages/api-contract/src/probe-resource.spec.ts`
Contract tests for the proof-only resource. Key assertions: probeResourceCollectionPath is the versioned /v1/probe-resources path; createProbeResourceSuccessStatusCode is 201; create requests with a string value parse and invalid bodies fail; id params parse only non-empty string ids; resource responses with id/value/ISO createdAt parse; inferred types are accepted without duplicating shapes.

`packages/api-contract/src/errors.ts`
Shared JSON error envelope used for validation, not-found, SDK non-2xx errors, and dependency failures.
`errorResponseSchema`, `ErrorResponse`

`packages/api-contract/src/sse.ts`
Contract-owned route constant and broad documentation schema/type for observed SSE response headers; tests assert HTTP semantics instead of exact literal values.
`eventsStreamPath`, `sseHeadersSchema`, `SseHeaders`

`packages/api-contract/src/openapi.ts`
Generates an OpenAPI document with `@asteasolutions/zod-to-openapi` or an equivalent Zod registry-based generator from the same Zod schemas used by runtime validation and TypeScript inference. Route metadata such as method/path/status is registered once here from contract constants instead of hand-authored OpenAPI path objects.
`OpenApiDocument`, `generateOpenApiDocument`

`packages/api-contract/src/index.ts`
Barrel export for all control-plane API schemas, inferred types, route/status constants, and OpenAPI generation.
`degradedHealthStatusCode`, `dependencyStatusSchema`, `healthResponseSchema`, `probeResourceCollectionPath`, `createProbeResourceSuccessStatusCode`, `probeResourceIdParamsSchema`, `createProbeResourceRequestSchema`, `probeResourceSchema`, `errorResponseSchema`, `eventsStreamPath`, `sseHeadersSchema`, `generateOpenApiDocument`, `DependencyStatus`, `HealthResponse`, `ProbeResourceIdParams`, `CreateProbeResourceRequest`, `ProbeResource`, `ErrorResponse`, `SseHeaders`, `OpenApiDocument`

`packages/api-contract/README.md`
Documents the contract source-of-truth rule, the temporary nature of probe resources, and ADR-006 additive-only evolution within /v1.

`packages/core/vite.config.ts`
Updated Vitest config for core tests, retaining existing test options and adding resolve.alias entries for @autocatalyst/api-contract and other workspace imports from source.

`packages/core/src/health.ts`
Core health behavior that checks process liveness and database reachability through an injected dependency checker and converts checker failures into degraded health instead of propagating them.
`HealthDependencyChecker`, `getHealth`

`packages/core/src/probe-resource.ts`
Use cases for creating and reading the temporary proof resource through a repository interface.
`ProbeResourceRepository`, `createProbeResource`, `getProbeResource`

`packages/core/src/routes.ts`
Fastify route registration for GET /health, versioned probe-resource routes, validation/error mapping, 503 degraded-health mapping, and SSE scaffold.
`ControlPlaneRouteDependencies`, `registerControlPlaneRoutes`

`packages/core/src/routes.spec.ts`
Core route tests using injected fakes. Key assertions: GET /health is unversioned; degraded health uses degradedHealthStatusCode (503); /v1 probe resource create/read calls the repository and validates requests/responses through contract schemas; POST /v1/probe-resources returns createProbeResourceSuccessStatusCode (201); POST /v1/probe-resources with a missing or invalid body returns 400 with a body matching errorResponseSchema; missing resources return 404 with ErrorResponse; SSE route uses eventsStreamPath and expected HTTP behavior without inventing run event payloads.

`packages/core/src/index.ts`
Public core package barrel for dependency interfaces, use cases, and Fastify route registration.
`HealthDependencyChecker`, `getHealth`, `ProbeResourceRepository`, `createProbeResource`, `getProbeResource`, `ControlPlaneRouteDependencies`, `registerControlPlaneRoutes`

`packages/persistence/vite.config.ts`
Updated Vitest config for persistence tests, retaining existing test options and adding resolve.alias entries for workspace imports from source.

`packages/persistence/src/schema.ts`
Internal Drizzle SQLite table definition for the proof-only probe resource table, isolated inside the persistence package and intentionally not re-exported from the package barrel.
`probeResources`

`packages/persistence/src/sqlite.ts`
SQLite connection factory, migration runner, database close operation, and database reachability check. The public SqliteDatabase handle is opaque and exposes no raw Drizzle or better-sqlite3 client.
`SqliteDatabase`, `createSqliteDatabase`, `migrateSqliteDatabase`, `checkSqliteDatabaseReachability`

`packages/persistence/src/probe-resource-repository.ts`
Drizzle-backed implementation of the core ProbeResourceRepository interface, with all Drizzle/SQLite calls kept behind the repository boundary.
`DrizzleProbeResourceRepository`

`packages/persistence/src/probe-resource-repository.spec.ts`
SQLite repository tests. Key assertions: createSqliteDatabase opens an isolated temporary SQLite file; migrateSqliteDatabase creates the probe_resources table; DrizzleProbeResourceRepository.create writes id/value/createdAt; findById reads the same record; findById returns null for missing ids; data remains readable after closing and reopening the same database path; checkSqliteDatabaseReachability returns true for the open database and false/handles failure without leaking raw engine types.

`packages/persistence/src/index.ts`
Public persistence package barrel for opaque SQLite setup, migrations, health check, and repository implementations. Drizzle table definitions remain internal implementation details and are not re-exported here.
`SqliteDatabase`, `createSqliteDatabase`, `migrateSqliteDatabase`, `checkSqliteDatabaseReachability`, `DrizzleProbeResourceRepository`

`packages/persistence/drizzle.config.ts`
Drizzle Kit configuration for generating future SQLite migrations from `packages/persistence/src/schema.ts` into `packages/persistence/drizzle`; generation command is `pnpm drizzle-kit generate --config packages/persistence/drizzle.config.ts`.

`packages/persistence/drizzle/0000_create_probe_resources.sql`
Initial SQLite migration creating the proof-only probe_resources table.

`packages/sdk/vite.config.ts`
Updated Vitest config for SDK tests, retaining existing test options and adding resolve.alias entries for @autocatalyst/api-contract and other workspace imports from source.

`packages/sdk/src/client.ts`
Typed SDK client using contract-derived request and response types for health and probe-resource endpoints. Non-2xx JSON error envelopes are surfaced as ControlPlaneClientError, including 404 from getProbeResource instead of returning null.
`ControlPlaneClientOptions`, `ControlPlaneClient`, `ControlPlaneClientError`, `createControlPlaneClient`

`packages/sdk/src/client.spec.ts`
SDK tests using a booted app or test HTTP server. Key assertions: getHealth calls GET /health and returns a HealthResponse; createProbeResource posts the contract-derived body, observes/asserts the 201 create status through the test server or injected fetch, and parses a ProbeResource; getProbeResource returns the resource on 200; getProbeResource throws ControlPlaneClientError containing the ErrorResponse envelope on 404; the SDK uses probeResourceCollectionPath rather than restating /v1/probe-resources; tests run without a prior package build.

`packages/sdk/src/index.ts`
Public SDK package barrel for the control-plane client, client error, and option types.
`ControlPlaneClientOptions`, `ControlPlaneClient`, `ControlPlaneClientError`, `createControlPlaneClient`

`package.json`
Workspace dependency/script update for the control-plane envelope: adds runtime dependencies such as Fastify, Drizzle SQLite support, better-sqlite3, OpenAPI schema generation support, and any required dev typings; existing validate/build/lint/test scripts continue to run all Nx targets.

`context-agent/wiki/code-map.md`
Agent navigation documentation update required with the module changes. Adds apps/control-plane under the source tree, records Fastify boot in apps/control-plane/src/server.ts and route registration in packages/core/src/routes.ts, records contract schemas/OpenAPI in packages/api-contract/src, records Drizzle schema/migrations/repository in packages/persistence, and documents local commands such as pnpm nx serve control-plane with CONTROL_PLANE_PORT and CONTROL_PLANE_DATABASE_PATH, pnpm nx test control-plane, package test targets, migration behavior, and pnpm validate.

### Public API

#### `readControlPlaneAppConfig`

```typescript
export function readControlPlaneAppConfig(argv?: readonly string[], env?: NodeJS.ProcessEnv): ControlPlaneAppConfig
```
- Parameters:
	- `argv: readonly string[] | undefined` — Optional process arguments used to read launch flags such as --port and --database-path. Flags take precedence over environment variables.
	- `env: NodeJS.ProcessEnv | undefined` — Optional environment source; CONTROL_PLANE_PORT and CONTROL_PLANE_DATABASE_PATH are recognized.
- Returns: `ControlPlaneAppConfig`
- Errors:
	- `Throws Error when the configured port is missing, non-numeric, or outside the TCP port range.`
	- `Throws Error when the SQLite database path is missing or empty.`
#### `createControlPlaneServer`

```typescript
export async function createControlPlaneServer(database: SqliteDatabase): Promise
```
- Parameters:
	- `database: SqliteDatabase` — Opaque persistence handle used to construct the health checker and probe-resource repository. The caller owns migration, listen, and close lifecycle.
- Returns: `Promise`
- Errors:
	- `Rejects when repository construction or Fastify route registration fails.`
	- `Does not open, migrate, listen on, or close the database; startControlPlaneServer owns those steps for production boot.`
#### `startControlPlaneServer`

```typescript
export async function startControlPlaneServer(config: ControlPlaneAppConfig): Promise
```
- Parameters:
	- `config: ControlPlaneAppConfig` — Runtime configuration for server listen port and persistence location.
- Returns: `Promise`
- Errors:
	- `Rejects when database creation, migrations, createControlPlaneServer delegation, dependency construction, or Fastify listen fails.`
	- `Creates exactly one SqliteDatabase, passes that same handle into createControlPlaneServer, and the returned close() method closes Fastify before closing the database.`
#### `main`

```typescript
export async function main(argv?: readonly string[], env?: NodeJS.ProcessEnv): Promise
```
- Parameters:
	- `argv: readonly string[] | undefined` — Optional command-line arguments for tests or alternate launchers.
	- `env: NodeJS.ProcessEnv | undefined` — Optional environment source for tests or alternate launchers.
- Returns: `Promise`
- Errors:
	- `Rejects when configuration parsing, migration, or service startup fails.`
#### `degradedHealthStatusCode`

```typescript
export const degradedHealthStatusCode: 503
```
- Returns: `503`
#### `dependencyStatusSchema`

```typescript
export const dependencyStatusSchema: z.ZodEnum
```
- Returns: `z.ZodEnum dependency status schema`
#### `healthResponseSchema`

```typescript
export const healthResponseSchema: z.ZodObject; database: z.ZodObject }> }>
```
- Returns: `z.ZodObject health response schema`
#### `probeResourceCollectionPath`

```typescript
export const probeResourceCollectionPath: "/v1/probe-resources"
```
- Returns: `"/v1/probe-resources"`
#### `createProbeResourceSuccessStatusCode`

```typescript
export const createProbeResourceSuccessStatusCode: 201
```
- Returns: `201`
#### `createProbeResourceRequestSchema`

```typescript
export const createProbeResourceRequestSchema: z.ZodObject
```
- Returns: `z.ZodObject create request schema`
#### `probeResourceIdParamsSchema`

```typescript
export const probeResourceIdParamsSchema: z.ZodObject
```
- Returns: `z.ZodObject path parameter schema`
#### `probeResourceSchema`

```typescript
export const probeResourceSchema: z.ZodObject
```
- Returns: `z.ZodObject probe resource response schema`
#### `errorResponseSchema`

```typescript
export const errorResponseSchema: z.ZodObject }> }>
```
- Returns: `z.ZodObject shared error envelope schema`
#### `eventsStreamPath`

```typescript
export const eventsStreamPath: "/v1/events"
```
- Returns: `"/v1/events"`
#### `sseHeadersSchema`

```typescript
export const sseHeadersSchema: z.ZodObject }>
```
- Returns: `z.ZodObject SSE observed-header documentation schema; tests assert content-type starts with text/event-stream, cache-control includes no-cache, and the connection remains open rather than exact literal header values.`
#### `generateOpenApiDocument`

```typescript
export function generateOpenApiDocument(): OpenApiDocument
```
- Returns: `OpenApiDocument`
- Errors:
	- `Throws Error if schema-to-OpenAPI registration fails during document construction.`
#### `getHealth`

```typescript
export async function getHealth(checker: HealthDependencyChecker): Promise
```
- Parameters:
	- `checker: HealthDependencyChecker` — Injected dependency checker used to test database reachability without coupling core to SQLite.
- Returns: `Promise`
- Errors:
	- `Always resolves for dependency-check failures: false results or unexpected checker errors are converted to { status: "degraded", database: { status: "unreachable" } } rather than propagated.`
#### `createProbeResource`

```typescript
export async function createProbeResource(repository: ProbeResourceRepository, request: CreateProbeResourceRequest): Promise
```
- Parameters:
	- `repository: ProbeResourceRepository` — Repository abstraction used to persist the proof-only resource.
	- `request: CreateProbeResourceRequest` — Contract-derived request body containing the resource value.
- Returns: `Promise`
- Errors:
	- `Rejects when the repository cannot persist the resource.`
#### `getProbeResource`

```typescript
export async function getProbeResource(repository: ProbeResourceRepository, id: string): Promise
```
- Parameters:
	- `repository: ProbeResourceRepository` — Repository abstraction used to fetch the proof-only resource.
	- `id: string` — Probe resource identifier from the validated route parameter.
- Returns: `Promise`
- Errors:
	- `Rejects when the repository read operation fails. Returns null for not-found so route handlers can map it to 404 and SDK clients can throw a client error.`
#### `registerControlPlaneRoutes`

```typescript
export async function registerControlPlaneRoutes(app: FastifyInstance, dependencies: ControlPlaneRouteDependencies): Promise
```
- Parameters:
	- `app: FastifyInstance` — Fastify server that receives GET /health outside /v1 and all application/SSE routes under /v1.
	- `dependencies: ControlPlaneRouteDependencies` — Injected health checker and probe resource repository.
- Returns: `Promise`
- Errors:
	- `Rejects when Fastify route registration fails.`
	- `GET /health returns HTTP 200 when getHealth resolves status ok and HTTP degradedHealthStatusCode (503) when it resolves degraded. The body follows healthResponseSchema in both cases.`
	- `POST /v1/probe-resources returns HTTP createProbeResourceSuccessStatusCode (201) on success.`
	- `GET /v1/events sets SSE headers whose HTTP semantics match sseHeadersSchema documentation and holds the connection open until client disconnect or server shutdown.`
#### `createSqliteDatabase`

```typescript
export function createSqliteDatabase(options: { path: string }): SqliteDatabase
```
- Parameters:
	- `options: { path: string }` — SQLite database file path.
- Returns: `SqliteDatabase`
- Errors:
	- `Throws Error when the SQLite database cannot be opened.`
#### `migrateSqliteDatabase`

```typescript
export async function migrateSqliteDatabase(database: SqliteDatabase): Promise
```
- Parameters:
	- `database: SqliteDatabase` — Opaque SQLite database handle returned by createSqliteDatabase.
- Returns: `Promise`
- Errors:
	- `Rejects when Drizzle migrations fail.`
#### `checkSqliteDatabaseReachability`

```typescript
export async function checkSqliteDatabaseReachability(database: SqliteDatabase): Promise
```
- Parameters:
	- `database: SqliteDatabase` — Opaque SQLite database handle to query with a lightweight reachability check.
- Returns: `Promise`
- Errors:
	- `Does not expose raw driver errors to callers; returns false when the lightweight reachability query fails.`
#### `DrizzleProbeResourceRepository`

```typescript
export class DrizzleProbeResourceRepository implements ProbeResourceRepository
```
- Parameters:
	- `database: SqliteDatabase` — Opaque SQLite database handle used internally by the Drizzle repository implementation; no raw Drizzle client is exposed to call sites.
- Returns: `DrizzleProbeResourceRepository`
- Errors:
	- `Repository methods reject when the underlying SQLite file becomes inaccessible or a query fails.`
#### `ControlPlaneClientError`

```typescript
export class ControlPlaneClientError extends Error { readonly status: number; readonly response: ErrorResponse; }
```
- Parameters:
	- `status: number` — HTTP status returned by the control-plane service.
	- `response: ErrorResponse` — Parsed contract error envelope from the service response.
- Returns: `ControlPlaneClientError`
#### `createControlPlaneClient`

```typescript
export function createControlPlaneClient(options: ControlPlaneClientOptions): ControlPlaneClient
```
- Parameters:
	- `options: ControlPlaneClientOptions` — SDK configuration including the service base URL and optional fetch implementation.
- Returns: `ControlPlaneClient`
- Errors:
	- `Throws Error when baseUrl is missing or invalid.`
	- `Methods throw ControlPlaneClientError for non-2xx responses that carry ErrorResponse; in particular getProbeResource throws on 404 rather than returning null.`
### Types

#### `ControlPlaneAppConfig`

```typescript
interface ControlPlaneAppConfig { port: number; databasePath: string; }
```
#### `ControlPlaneServerHandle`

```typescript
interface ControlPlaneServerHandle { port: number; databasePath: string; close(): Promise; }
```
#### `DependencyStatus`

```typescript
type DependencyStatus = z.infer; // "reachable" | "unreachable"
```
#### `HealthResponse`

```typescript
type HealthResponse = z.infer; // { status: "ok" | "degraded"; database: { status: "reachable" | "unreachable" } }
```
#### `ProbeResourceIdParams`

```typescript
type ProbeResourceIdParams = z.infer; // { id: string }
```
#### `CreateProbeResourceRequest`

```typescript
type CreateProbeResourceRequest = z.infer; // { value: string }
```
#### `ProbeResource`

```typescript
type ProbeResource = z.infer; // { id: string; value: string; createdAt: string }
```
#### `ErrorResponse`

```typescript
type ErrorResponse = z.infer; // { error: { code: string; message: string; details?: unknown } }
```
#### `SseHeaders`

```typescript
type SseHeaders = z.infer; // { "content-type": string; "cache-control": string; connection?: string }
```
#### `OpenApiDocument`

```typescript
interface OpenApiDocument { openapi: string; info: { title: string; version: string }; paths: Record; components?: Record; }
```
#### `HealthDependencyChecker`

```typescript
interface HealthDependencyChecker { isDatabaseReachable(): Promise; }
```
#### `ProbeResourceRepository`

```typescript
interface ProbeResourceRepository { create(input: CreateProbeResourceRequest): Promise; findById(id: string): Promise; }
```
#### `ControlPlaneRouteDependencies`

```typescript
interface ControlPlaneRouteDependencies { health: HealthDependencyChecker; probeResources: ProbeResourceRepository; }
```
#### `SqliteDatabase`

```typescript
interface SqliteDatabase { readonly path: string; close(): void; readonly _brand: 'SqliteDatabase'; }
```
#### `ControlPlaneClientOptions`

```typescript
interface ControlPlaneClientOptions { baseUrl: string | URL; fetch?: typeof globalThis.fetch; }
```
#### `ControlPlaneClientError`

```typescript
class ControlPlaneClientError extends Error { readonly status: number; readonly response: ErrorResponse; }
```
#### `ControlPlaneClient`

```typescript
interface ControlPlaneClient { getHealth(): Promise; createProbeResource(request: CreateProbeResourceRequest): Promise; getProbeResource(id: string): Promise; }
```
### Notes

Proposed temporary resource path is /v1/probe-resources to avoid domain-entity naming; probeResourceCollectionPath carries the /v1 prefix and is the SDK URL source, and successful creates return createProbeResourceSuccessStatusCode (201). GET /health remains unversioned and returns 200 for ok or degradedHealthStatusCode (503) for degraded/unreachable database, with both bodies matching healthResponseSchema. The SSE endpoint is GET /v1/events and intentionally has no event payload schema until real run event production exists; only route path and headers/transport behavior are contract-adjacent, and tests assert HTTP semantics rather than exact literal header strings. OpenAPI generation is schema-derived with `@asteasolutions/zod-to-openapi` or an equivalent Zod registry pattern and returns a minimal OpenApiDocument type rather than Record\; route metadata is registered once from contract constants. createControlPlaneServer and startControlPlaneServer have an explicit lifecycle boundary: start creates/migrates/listens/closes one database and returns only port/databasePath/close(), while create only registers routes against a caller-owned opaque SqliteDatabase and returns the FastifyInstance for tests that need direct server access, including the forced unreachable-database health test. Tests are part of the artifact: contract schema/type tests, persistence read/write/reopen tests, real-app restart persistence integration tests, core route status/SSE tests, and SDK client/error tests. Existing tsconfig.base.json workspace paths point to source, and the revised Vitest configs add explicit Vite resolve.alias entries for @autocatalyst/\* source imports so clean-checkout tests do not require prior builds. context-agent/wiki/[code-map.md](http://code-map.md) must be updated with the new app target, route/contract/persistence locations, and commands including CONTROL_PLANE_PORT=3000 CONTROL_PLANE_DATABASE_PATH=.data/control-plane.sqlite pnpm nx serve control-plane, pnpm nx test control-plane, pnpm nx test api-contract, pnpm nx test persistence, pnpm nx test sdk, pnpm drizzle-kit generate --config packages/persistence/drizzle.config.ts for future migration generation, and pnpm validate. Remaining provider behavior: SQLite is the only implemented engine in this artifact, but public call sites only receive repository interfaces or opaque SqliteDatabase handles to keep a later Postgres move isolated inside persistence/app composition. Drizzle table definitions are internal to packages/persistence and are not exported from its public barrel.
## Task list

### Story 1: Contract package owns the API source of truth

Enzo can inspect `packages/api-contract` and see one set of Zod schemas, route constants, inferred types, and generated OpenAPI inputs for the control-plane envelope.
#### Task 1.1: Add health contract schemas and tests

- **Description:** Replace the placeholder health contract with `dependencyStatusSchema`, `healthResponseSchema`, `degradedHealthStatusCode`, inferred types, and focused schema tests.
- **Acceptance criteria:**
	- `packages/api-contract/src/health.ts` exports the schemas, inferred `DependencyStatus`/`HealthResponse` types, and `degradedHealthStatusCode`.
	- `packages/api-contract/src/health.spec.ts` proves healthy and degraded payloads parse, invalid status values fail, and the degraded status code is `503`.
	- No health request or response type is hand-written separately from the Zod schemas.
- **Dependencies:** None.
#### Task 1.2: Add probe-resource, error, and SSE contract modules

- **Description:** Add the temporary proof-resource schemas, shared error envelope, SSE route/header contract, and route constants agreed in the Converged API.
- **Acceptance criteria:**
	- `probeResourceCollectionPath` is exactly `"/v1/probe-resources"`.
	- `createProbeResourceSuccessStatusCode` is exactly `201`.
	- `eventsStreamPath` is exactly `"/v1/events"`.
	- Create request, id params, probe-resource response, error response, and SSE header schemas export inferred TypeScript types.
	- Contract tests cover valid and invalid create bodies, id params, response payloads, and route constants.
- **Dependencies:** Task 1.1.
#### Task 1.3: Add schema-derived OpenAPI generation and package documentation

- **Description:** Add `generateOpenApiDocument`, update contract barrel exports, and document the source-of-truth and additive-versioning rules.
- **Acceptance criteria:**
	- `packages/api-contract/src/openapi.ts` builds an OpenAPI-shaped document using `@asteasolutions/zod-to-openapi` or an equivalent Zod registry-based generator; Zod schemas are the request/response shape source, and route method/path/status metadata is registered once from contract constants rather than hand-authored OpenAPI path objects.
	- `packages/api-contract/src/index.ts` exports all public schemas, route constants, status constants, types, and OpenAPI generation.
	- `packages/api-contract/README.md` states that `/v1` evolves additively and that probe resources are temporary proof-only scaffolding.
	- Contract package tests pass without requiring a prior workspace build.
- **Dependencies:** Task 1.2.
#### Task 1.4: Configure contract-package test resolution from source

- **Description:** Update `packages/api-contract/vite.config.ts` only as needed so Vitest resolves workspace source imports on a clean checkout.
- **Acceptance criteria:**
	- Existing Vitest options remain intact.
	- Any added aliases point to source files, not built `dist` output.
	- `pnpm nx test api-contract` runs from a clean checkout after dependencies are installed.
- **Dependencies:** Task 1.3.
### Story 2: Persistence isolates SQLite behind repositories

Enzo can write and read the proof resource through a repository while SQLite and Drizzle details stay inside `packages/persistence`.
#### Task 2.1: Add SQLite dependencies and migration tooling

- **Description:** Add the workspace dependencies and package configuration needed for Drizzle with SQLite and create the initial migration path.
- **Acceptance criteria:**
	- `package.json` includes the runtime and dev dependencies needed for Fastify, Drizzle SQLite, `better-sqlite3`, OpenAPI generation, and typings.
	- `packages/persistence/drizzle.config.ts` configures Drizzle Kit schema input and migration output for future migration generation.
	- `packages/persistence/drizzle/0000_create_probe_resources.sql` creates the proof-only `probe_resources` table.
	- Migration paths are documented or encoded so tests and app startup can run the committed migration against a supplied SQLite file, and future generation is documented as `pnpm drizzle-kit generate --config packages/persistence/drizzle.config.ts`.
- **Dependencies:** Task 1.2.
#### Task 2.2: Implement opaque SQLite database lifecycle helpers

- **Description:** Implement `SqliteDatabase`, database creation, migration execution, close behavior, and reachability checks.
- **Acceptance criteria:**
	- `createSqliteDatabase({ path })` opens the configured SQLite file and returns an opaque handle.
	- `migrateSqliteDatabase(database)` applies the migration without exposing Drizzle internals to callers.
	- `checkSqliteDatabaseReachability(database)` returns `true` for an open reachable database and `false` for query failures.
	- `packages/persistence/src/index.ts` exports only the public persistence API from the Converged API.
- **Dependencies:** Task 2.1.
#### Task 2.3: Implement the Drizzle probe-resource repository

- **Description:** Add the internal Drizzle schema and repository implementation for `ProbeResourceRepository`.
- **Acceptance criteria:**
	- `packages/persistence/src/schema.ts` defines the `probeResources` table and is not re-exported from the persistence barrel.
	- `DrizzleProbeResourceRepository.create` writes `id`, `value`, and `createdAt`.
	- `DrizzleProbeResourceRepository.findById` returns the stored record or `null` for missing ids.
	- Core-facing code depends on `ProbeResourceRepository`, not on Drizzle table or client types.
- **Dependencies:** Task 2.2.
#### Task 2.4: Add persistence tests for write/read/reopen behavior

- **Description:** Add repository and SQLite lifecycle tests that use isolated temporary database files.
- **Acceptance criteria:**
	- Tests create a temporary SQLite file, migrate it, create a probe resource, read it back, close the database, reopen the same file, and read the same resource again.
	- Tests assert missing ids return `null`.
	- Tests cover database reachability behavior.
	- `packages/persistence/vite.config.ts` resolves workspace imports from source when needed.
- **Dependencies:** Task 2.3.
### Story 3: Core registers validated routes and service behavior

Enzo can test route behavior in `packages/core` with fake dependencies before booting the real app.
#### Task 3.1: Implement core health behavior

- **Description:** Add `HealthDependencyChecker` and `getHealth` so dependency failures become contract-valid degraded responses.
- **Acceptance criteria:**
	- `getHealth` returns `{ status: "ok", database: { status: "reachable" } }` when the checker returns `true`.
	- `getHealth` returns `{ status: "degraded", database: { status: "unreachable" } }` when the checker returns `false`.
	- `getHealth` catches unexpected checker errors and returns the same degraded response instead of throwing.
- **Dependencies:** Task 1.1.
#### Task 3.2: Implement probe-resource use cases

- **Description:** Add `ProbeResourceRepository`, `createProbeResource`, and `getProbeResource` in `packages/core`.
- **Acceptance criteria:**
	- Use cases accept and return contract-derived types.
	- `createProbeResource` delegates persistence to the repository interface.
	- `getProbeResource` returns `ProbeResource | null` so route handlers can map not-found to `404`.
- **Dependencies:** Task 1.2.
#### Task 3.3: Register Fastify routes through contract schemas

- **Description:** Implement `registerControlPlaneRoutes` for health, probe-resource create/read, validation/error mapping, and the SSE scaffold.
- **Acceptance criteria:**
	- `GET /health` is registered outside `/v1` and returns `200` for healthy responses or `degradedHealthStatusCode` for degraded responses.
	- `POST /v1/probe-resources` returns `createProbeResourceSuccessStatusCode` (`201`) on success.
	- `POST /v1/probe-resources` and `GET /v1/probe-resources/:id` validate request and response shapes through contract schemas.
	- Invalid requests return `400` with `ErrorResponse`.
	- Missing probe resources return `404` with `ErrorResponse`.
	- `GET /v1/events` sets SSE headers whose content-type starts with `text/event-stream` and cache-control includes `no-cache`, then keeps the connection open until client disconnect or server shutdown.
- **Dependencies:** Tasks 3.1 and 3.2.
#### Task 3.4: Add core route tests with injected fakes

- **Description:** Add tests for all route behavior without using real SQLite.
- **Acceptance criteria:**
	- Tests prove `GET /health` is unversioned and degraded health uses status `503`.
	- Tests prove successful `POST /v1/probe-resources` uses status `201`.
	- Tests prove probe-resource routes call the repository and reject invalid request bodies.
	- Tests prove not-found responses match `errorResponseSchema`.
	- Tests assert SSE header semantics and close the stream cleanly without expecting run event payloads or exact header literals.
	- `packages/core/vite.config.ts` resolves `@autocatalyst/api-contract` and other workspace imports from source.
- **Dependencies:** Task 3.3.
### Story 4: Control-plane app boots the real service envelope

Enzo can start a thin app target under `apps/control-plane` and use a documented command to run the service against a configured SQLite file.
#### Task 4.1: Add the Nx app project scaffold

- **Description:** Create `apps/control-plane` project files, TypeScript configs, package metadata, and Vitest config in the existing repository style.
- **Acceptance criteria:**
	- `apps/control-plane/project.json` defines build, lint, test, and serve targets.
	- App TypeScript and Vitest configs include the source and integration test files.
	- Workspace source aliases let app tests run without a prior package build.
	- The app package is private and depends on workspace packages rather than duplicating code.
- **Dependencies:** Tasks 1.3, 2.2, and 3.3.
#### Task 4.2: Implement app configuration parsing

- **Description:** Add `readControlPlaneAppConfig` for port and database path from launch flags or environment variables.
- **Acceptance criteria:**
	- `--port` and `--database-path` flags take precedence over `CONTROL_PLANE_PORT` and `CONTROL_PLANE_DATABASE_PATH`.
	- Missing, non-numeric, or out-of-range ports throw clear errors.
	- Missing or empty database paths throw clear errors.
	- Unit coverage or integration coverage proves flag and environment behavior.
- **Dependencies:** Task 4.1.
#### Task 4.3: Implement server composition and lifecycle

- **Description:** Add `createControlPlaneServer` and `startControlPlaneServer` to compose Fastify, core routes, persistence dependencies, migration, listen, and shutdown.
- **Acceptance criteria:**
	- `createControlPlaneServer(database)` registers routes against a caller-owned `SqliteDatabase` and does not migrate, listen, or close it.
	- `startControlPlaneServer(config)` creates exactly one database handle, migrates it, starts Fastify, and returns `port`, `databasePath`, and `close()`.
	- `close()` closes Fastify before closing the database.
	- The lifecycle handle does not expose the raw Fastify instance.
- **Dependencies:** Tasks 2.3 and 3.3.
#### Task 4.4: Implement executable startup

- **Description:** Add `main` so the app can run as a process using the config parser and server lifecycle.
- **Acceptance criteria:**
	- Startup logs include the selected port and database path without printing secrets.
	- Shutdown handlers close the server cleanly.
	- Startup failures reject or exit with a clear error path appropriate for the existing app conventions.
	- The documented serve command works with `CONTROL_PLANE_PORT` and `CONTROL_PLANE_DATABASE_PATH`.
- **Dependencies:** Tasks 4.2 and 4.3.
#### Task 4.5: Add real-app integration tests

- **Description:** Add integration tests that boot the real app against a temporary SQLite file and exercise the envelope end to end.
- **Acceptance criteria:**
	- Test boots with `startControlPlaneServer`, calls `GET /health`, and receives a contract-valid healthy body.
	- Test creates a probe resource through HTTP with status `201`, reads it, closes the server, restarts with the same database path, and reads the same resource again.
	- Test verifies `GET /v1/events` returns HTTP SSE behavior where content-type starts with `text/event-stream`, cache-control includes `no-cache`, and the stream remains open until the test closes it.
	- Test covers a forced database-unreachable health path by using `createControlPlaneServer` with a caller-owned `SqliteDatabase`, closing that database before calling `GET /health`, and asserting `503` plus a degraded health body.
	- Temporary database files do not leak state between test runs.
- **Dependencies:** Task 4.4.
### Story 5: SDK proves typed client consumption

A future client author can call health and probe-resource routes through `packages/sdk` with contract-derived request and response shapes.
#### Task 5.1: Implement the control-plane SDK client

- **Description:** Add `createControlPlaneClient`, `ControlPlaneClient`, and `ControlPlaneClientError` with methods for health and probe resources.
- **Acceptance criteria:**
	- `getHealth` calls `GET /health` and parses `HealthResponse`.
	- `createProbeResource` posts `CreateProbeResourceRequest` to `probeResourceCollectionPath` and parses `ProbeResource`.
	- `getProbeResource` reads by id and parses `ProbeResource`.
	- Non-2xx responses with `ErrorResponse` throw `ControlPlaneClientError`; `404` from `getProbeResource` throws instead of returning `null`.
	- The SDK uses contract route constants and types rather than restating paths or shapes.
- **Dependencies:** Tasks 1.3 and 3.3.
#### Task 5.2: Add SDK tests against a booted app or test server

- **Description:** Add client tests for success and error paths using a real or test HTTP server.
- **Acceptance criteria:**
	- Tests prove `getHealth`, `createProbeResource`, and `getProbeResource` return contract-valid values.
	- Tests prove `createProbeResource` observes/asserts HTTP status `201` through the test server or injected fetch.
	- Tests prove `getProbeResource` throws `ControlPlaneClientError` with the parsed error envelope on `404`.
	- Tests prove the client accepts an injected `fetch` implementation.
	- `packages/sdk/vite.config.ts` resolves workspace imports from source.
- **Dependencies:** Task 5.1.
### Story 6: Workspace validation and agent navigation stay current

Enzo and the next agent can find the new app, understand the contract/persistence wiring, and run the expected checks.
#### Task 6.1: Update workspace scripts and dependency metadata

- **Description:** Ensure package metadata and Nx targets include the new app and package test/build/lint paths without weakening existing validation.
- **Acceptance criteria:**
	- Existing `validate`, build, lint, test, and boundary scripts continue to include all relevant projects.
	- New dependencies are scoped as runtime or dev dependencies according to how they are used.
	- No generated build output or local SQLite data file is committed.
- **Dependencies:** Tasks 4.1 and 5.1.
#### Task 6.2: Update `context-agent/wiki/code-map.md`

- **Description:** Record the new service envelope layout, route/contract/persistence seams, and local commands for future agents.
- **Acceptance criteria:**
	- Code map lists `apps/control-plane` and points to `src/config.ts`, `src/server.ts`, and `src/main.ts`.
	- Code map records route registration in `packages/core/src/routes.ts`.
	- Code map records contract schemas/OpenAPI in `packages/api-contract/src`.
	- Code map records Drizzle schema, migrations, SQLite lifecycle helpers, and repository implementation in `packages/persistence`.
	- Code map includes commands for serving the app, running app/package tests, migration behavior, and `pnpm validate`.
- **Dependencies:** Tasks 2.4, 3.4, 4.5, and 5.2.
#### Task 6.3: Run targeted and full validation

- **Description:** Run the checks needed to prove the implementation is complete and document any environment-specific skips.
- **Acceptance criteria:**
	- Targeted package tests pass for `api-contract`, `persistence`, `core`, `sdk`, and `control-plane`.
	- The real-app integration test proves restart persistence using the same SQLite file.
	- `pnpm validate` passes, or any failure is documented with the exact command, failure, and follow-up needed.
	- Unsupported provider behavior is clear: only SQLite is implemented, with Postgres isolated behind future persistence changes.
- **Dependencies:** Task 6.2.