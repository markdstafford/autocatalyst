---
created: 2026-06-08
last_updated: 2026-06-08
status: complete
issue: 7
specced_by: markdstafford
---
# Feature: Principal seam, service-owned config, and secret store

## Product requirements

### What

Add the first authentication-ready and configuration-ready control-plane foundation. Every protected `/v1` API request carries a resolved `Principal`, passes through a policy-decision point, and is authenticated with a bearer token. `GET /health` remains an explicitly public operational endpoint and does not resolve a `Principal` or consult policy. The policy point allows every valid protected request for now, but it must be present and observable in tests.
Move operational configuration into the database and expose it through `/v1` CRUD endpoints. Configuration writes are validated at the API boundary before data reaches persistence. A configuration record can reference a secret by handle, while the secret value lives only in a separate secret store unlocked by the bootstrap master secret.
This feature builds on the control-plane service envelope from issue 5. It extends the existing Fastify app, `packages/core` route registration, `packages/api-contract` schemas, `packages/persistence` repository pattern, and app bootstrap config reader.
### Why

Autocatalyst needs stable seams for identity, authorization, configuration, and secrets before domain resources and provider wiring land. Adding those seams now prevents later features from writing unauthenticated handlers, storing operational settings in ad hoc files, or passing tokens through ordinary config records.
The feature deliberately does not build full sign-in, RBAC, provider resolution, or per-run secret injection. It makes the control plane behave as if those future systems exist: handlers see who is acting, policy checks have one home, configuration is API-editable data, and secrets are referenced rather than exposed.
### Goals

- Resolve a `Principal` on every protected `/v1` API request through a hook registered from `packages/core`.
- Represent principal kind as `human`, `model`, or `system`.
- Thread one hardcoded principal through the stack so the seam is exercised end to end.
- Require a bearer token for protected `/v1` API calls and reject missing or invalid tokens through the shared error envelope.
- Consult one policy-decision point in the API layer for every protected `/v1` route, with permissive allow behavior for this feature.
- Store operational configuration in SQLite through the existing persistence pattern.
- Expose configuration CRUD endpoints under `/v1` with Zod schemas in `packages/api-contract` as the source of truth.
- Validate configuration writes at the boundary and reject invalid records before persistence.
- Add a migration for the new configuration and secret-store tables.
- Extend the app bootstrap loader to read only the database location, listen port, bearer token, and master secret before database access.
- Add a secret store that unlocks from the bootstrap master secret.
- Store secret values only in the secret store and expose only handles from configuration records.
- Prove the end state with integration tests that boot the real app.
- Update agent navigation docs with the new principal, policy, config, secret-store, and bootstrap locations.
### Non-goals

- Interactive sign-in, sessions, OAuth, or user management.
- Real RBAC, tenant enforcement, per-repository policy enforcement, or deny decisions beyond invalid/missing bearer tokens.
- Domain entities such as projects, conversations, topics, runs, messages, artifacts, feedback, or PR records.
- Owner and tenant columns on domain entities; this feature only provides the principal seam later entities attribute to.
- Extension registry catalog behavior, provider composition, provider runtime resolution, or registry warnings. Those are split to issue 8.
- Per-run secret injection into execution contexts.
- Desktop, mobile, or settings UI work.
- Configuration change events, audit history, optimistic concurrency, or multi-editor conflict handling.
### Personas

- **Enzo (Engineer)** needs each new handler to receive a principal, call policy through one seam, and read/write configuration through stable repositories and contracts.
- **Phoebe (PM)** needs confidence that configuration and secrets are durable, API-driven product capabilities rather than temporary local files.
- **Dani (Designer)** is not a direct user of this backend-only feature, but benefits because future settings screens can rely on safe config records and secret handles.
- **Opal (Operator)** needs startup behavior that makes the required bootstrap secret explicit and avoids exposing secret values through ordinary API reads.
### User stories

- As Enzo, I can call a protected test or diagnostic route with a valid bearer token and know the handler sees a `Principal` so future domain code can attribute actions.
- As Enzo, I can verify a policy-decision point was consulted for a protected `/v1` API request so authorization has one place to grow later.
- As Enzo, I can create, read, update, list, and delete a configuration record through `/v1` so operational configuration lives in the service store.
- As Enzo, I can submit invalid configuration and receive a validation error from the API boundary so bad settings do not fail later inside a run.
- As Opal, I can start the service only when the minimal bootstrap values are present: port, database path, bearer token, and master secret.
- As Opal, I can store a secret value and reference it from a configuration record by handle, then read the configuration record without seeing the secret value.
- As Phoebe, I can see the feature working in one integration test that boots the real app and proves principal, policy, configuration, and secret behavior together.
### Acceptance criteria

#### Identity and policy seam

- A `Principal` type includes identity, tenant, and `kind` where `kind` is `human`, `model`, or `system`.
- A request hook registered from `packages/core` resolves a hardcoded principal for every authenticated protected `/v1` API request.
- Handlers can read the resolved principal from request context without reconstructing it.
- A single policy-decision point in the API layer is called for every protected `/v1` route.
- The policy-decision point always allows for now, but tests can prove it was consulted.
- Requests to protected `/v1` routes without a valid bearer token are rejected before handler behavior runs.
- Auth failures use the shared JSON error envelope.
- `GET /health` is explicitly public and does not require bearer auth, attach a principal, or consult policy.
#### Service-owned configuration

- Configuration schemas live in `packages/api-contract` and infer TypeScript types from Zod schemas.
- Configuration records are stored in SQLite through a repository interface and Drizzle implementation.
- A migration creates the configuration table or tables.
- `/v1` exposes CRUD behavior for configuration records.
- Invalid configuration writes return a validation error at the API boundary.
- Reads never expose secret values, even when a configuration record references a secret.
#### Secret store and bootstrap

- The app bootstrap loader reads database path, listen port, bearer token, and master secret from environment variables or launch flags.
- The service refuses to start when the master secret is missing or empty.
- A secret store has an explicit unlock step keyed by the master secret.
- Secret values are written only to the secret store.
- Configuration records reference secrets by handle.
- Reading a configuration record returns the secret handle, not the secret value.
#### End to end

- An integration test boots the real app and asserts a handler sees the hardcoded `Principal`.
- An integration test asserts the policy-decision point is consulted for an authenticated protected `/v1` request.
- An integration test creates, reads, and updates a configuration record through `/v1`.
- An integration test proves invalid configuration is rejected.
- An integration test proves a configuration record can reference a secret handle while the secret value stays out of the record body.
- `context-agent/wiki/code-map.md` records the principal hook, policy seam, configuration repository and endpoints, secret store, and bootstrap loader.
## Design spec

### Design scope

This is a backend-only feature. There is no human-facing screen, visual layout, or desktop interaction to design in this pass. The design work is the service-facing experience for developers, operators, and future clients.
### Service experience

The service should make required security and configuration seams clear without pretending full auth exists.
1. An operator starts the control-plane app with a port, database path, bearer token, and master secret.
2. The app validates the bootstrap inputs during startup.
3. A client sends protected `/v1` API requests with `Authorization: Bearer `.
4. Core resolves the hardcoded principal after token validation.
5. The API layer asks the policy-decision point whether the principal can perform the requested action.
6. The protected `/v1` handler runs only after token validation, principal resolution, and the permissive policy check complete.
Startup logs may say which port and database path the service uses. They must not print the bearer token, master secret, raw secret values, or derived secret material.
### Authentication and authorization behavior

The feature should be honest about its security level. Bearer-token auth proves the transport seam, but the principal is still hardcoded and the policy point still allows every authenticated protected `/v1` request.
Scope rule:
- All `/v1` routes are protected by bearer auth, principal resolution, and policy consultation.
- `GET /health` is explicitly public, unversioned, and operational; it does not resolve a `Principal` and does not consult policy.
Expected client behavior:
- Missing `Authorization` header returns `401` with the shared error envelope.
- Malformed or wrong bearer token returns `401` with the shared error envelope.
- Valid bearer token lets the request continue to principal resolution.
- Policy allow behavior is invisible to the normal client response but visible to tests through an injectable policy decision implementation.
The hardcoded principal should be stable and clearly marked as a placeholder. Its tenant and identity values should look synthetic, not like a real user account.
### Configuration API behavior

Configuration records should feel like normal `/v1` resources. The exact path can be `configs` or `configuration-records`, but it should be plural, lowercase, and kebab-case. A clear path such as `/v1/configuration-records` is preferred because it signals these are stored records, not the bootstrap config itself.
A record should include enough shape to prove the pattern without implementing the full provider registry:
```json
{
  "id": "cfg_...",
  "kind": "provider_profile",
  "providerKind": "model_runner",
  "adapterId": "openai",
  "settings": {
    "profileName": "default",
    "credentialSecretHandle": "sec_..."
  },
  "createdAt": "2026-06-08T00:00:00.000Z",
  "updatedAt": "2026-06-08T00:00:00.000Z"
}
```
`providerKind` and `adapterId` are stored and schema-validated as data only. This feature does not resolve them to runtime providers and does not consult the extension registry. That split keeps issue 8 clean.
### Secret handling behavior

Secrets should be addressed by opaque handles, not by meaningful names that invite clients to infer secret contents. Secret handles must match the exact format `^sec_[A-Za-z0-9_-]{32}$`: the literal `sec_` prefix followed by 32 unpadded base64url characters generated from at least 24 cryptographically secure random bytes. If handle generation collides with an existing row, the secret store must retry with fresh random bytes; if a bounded retry loop is exhausted, creation fails with a non-secret internal error rather than overwriting an existing secret. The API may expose a minimal create-secret operation if needed to prove the full flow, but reading a secret value back over the API is out of scope.
The demonstration flow is:
1. Client creates or seeds a secret value after the store is unlocked.
2. Service returns a secret handle.
3. Client creates a configuration record that references the handle.
4. Client reads the configuration record.
5. Response includes the handle and excludes the secret value.
The service must fail startup when the master secret is missing or empty. Locked-mode startup is out of scope for this feature; locked-store errors are only for defensive handling if secret operations are invoked before a successful unlock inside tests or lower-level components.
### Error and empty-state design

- Auth failures return `401` with a stable code such as `unauthorized`.
- Validation failures return `400` with `validation_error` and Zod issue details when useful.
- Missing configuration records return `404` with `not_found`.
- Locked or unavailable secret-store operations, when reached through lower-level defensive paths, return a clear error code that does not mention secret values.
- Secret-related errors must never echo the submitted secret value.
## Tech spec

### Current state

The repository already has a bootable TypeScript/Nx control-plane service from issue 5:
- `apps/control-plane/src/config.ts` reads `CONTROL_PLANE_PORT`/`--port` and `CONTROL_PLANE_DATABASE_PATH`/`--database-path`.
- `apps/control-plane/src/server.ts` creates Fastify, opens SQLite, applies migrations, and registers core routes.
- `packages/core/src/routes.ts` registers `GET /health`, probe-resource routes under `/v1`, and an SSE scaffold.
- `packages/api-contract` owns Zod schemas, inferred types, route constants, status constants, and OpenAPI generation.
- `packages/persistence` owns the SQLite handle, Drizzle schema, migrations, reachability checks, and repository implementations.
- `packages/sdk` exposes a typed client for health and probe resources.
- K3 committed regression coverage includes degraded `/health` behavior when the database dependency is unreachable, plus unauthenticated probe-resource and SDK tests that must be migrated instead of weakened.
The existing feature explicitly left identity, service-owned configuration, master-secret unlock, and secret storage out of scope. This feature fills those seams using the same package boundaries.
### Proposed package shape

- `apps/control-plane/` stays a thin composition shell. It reads bootstrap config, creates the SQLite database, unlocks the secret store, creates auth/policy dependencies, registers core routes, and owns process start/stop.
- `packages/api-contract/` adds schemas, inferred types, route constants, status constants, and OpenAPI registration for principals where exposed for tests, configuration records, secret handles, and auth/secret error envelopes.
- `packages/core/` owns Fastify hooks for bearer auth and principal resolution, the policy-decision interface, configuration route registration, and use-case interfaces.
- `packages/persistence/` owns Drizzle tables, migrations, and concrete repositories for configuration records and secrets.
- `packages/sdk/` may add typed methods for configuration CRUD and any minimal secret-handle creation endpoint used to prove the flow.
Core should depend on repository and policy interfaces. Persistence should implement repositories. The app should wire concrete implementations together.
### Server composition and health dependency seam

`createControlPlaneServer` should move to an options-based composition surface while preserving test seams that issue 5 already committed. The app may own opening SQLite and applying migrations, but health reachability must remain injectable so tests can exercise degraded operational behavior without a caller-owned database handle.
Recommended shape:
```typescript
interface HealthDependencyChecker {
  check(): Promise;
}

interface ControlPlaneServerOptions {
  readonly databasePath: string;
  readonly bearerToken: string;
  readonly masterSecret: string;
  readonly policy?: PolicyDecisionPoint;
  readonly health?: HealthDependencyChecker;
}
```
When `health` is not supplied, server composition should use the normal SQLite reachability checker for the opened database. When an injected checker reports unavailable or throws, `GET /health` must return degraded health with HTTP `503`, matching the existing operational contract.
### Bootstrap configuration

Extend `ControlPlaneAppConfig` with:
- `port`
- `databasePath`
- `bearerToken`
- `masterSecret`
Recommended environment variables and flags:
- `CONTROL_PLANE_PORT` / `--port`
- `CONTROL_PLANE_DATABASE_PATH` / `--database-path`
- `CONTROL_PLANE_BEARER_TOKEN` / `--bearer-token`
- `CONTROL_PLANE_MASTER_SECRET` / `--master-secret`
Validation should reject missing or empty values. The master secret and bearer token must not be logged. If tests need deterministic values, pass explicit env and argv objects into `readControlPlaneAppConfig` instead of mutating global process state unnecessarily.
### Principal and policy model

Add a contract/core principal model with fields similar to:
```typescript
type PrincipalKind = 'human' | 'model' | 'system';

interface Principal {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly tenantId: string;
  readonly displayName?: string;
}
```
The hardcoded principal can live in core as a clearly named default, for example `hardcodedDevelopmentPrincipal`. It should use synthetic values such as `principal_dev_human` and `tenant_dev`.
Add a Fastify request augmentation or internal request-context helper so handlers can read the principal without reparsing headers. Keep the augmentation in one place. Route code should fail fast if a protected handler somehow runs without a principal.
Define one policy seam, for example:
```typescript
interface PolicyDecisionPoint {
  authorize(input: PolicyDecisionInput): Promise;
}
```
`PolicyDecisionInput` should include the principal, action, and resource kind or path-level resource descriptor. The default implementation returns allow. Tests should inject a spy or recording implementation to prove `authorize` was called.
Protected routes must use the following policy action names and resource descriptor shapes. Tests that use a recording policy should assert these exact values for the routes they exercise. Future `/v1` routes must add a row here before implementation.

Route or route group
Policy action
Resource descriptor

`POST /v1/probe-resources`
`probe_resource.create`
`{ kind: 'probe_resource_collection', path: '/v1/probe-resources' }`

`GET /v1/probe-resources/:id`
`probe_resource.read`
`{ kind: 'probe_resource', id: params.id, path: '/v1/probe-resources/:id' }`

`GET /v1/events`
`events.stream`
`{ kind: 'event_stream', path: '/v1/events' }`

Principal diagnostic route, if added under `/v1`
`principal.diagnostic.read`
`{ kind: 'principal_diagnostic', path: '' }`

`POST /v1/configuration-records`
`configuration_record.create`
`{ kind: 'configuration_record_collection', path: '/v1/configuration-records' }`

`GET /v1/configuration-records`
`configuration_record.list`
`{ kind: 'configuration_record_collection', path: '/v1/configuration-records' }`

`GET /v1/configuration-records/:id`
`configuration_record.read`
`{ kind: 'configuration_record', id: params.id, path: '/v1/configuration-records/:id' }`

`PATCH /v1/configuration-records/:id`
`configuration_record.update`
`{ kind: 'configuration_record', id: params.id, path: '/v1/configuration-records/:id' }`

`DELETE /v1/configuration-records/:id`
`configuration_record.delete`
`{ kind: 'configuration_record', id: params.id, path: '/v1/configuration-records/:id' }`

`POST /v1/secrets`
`secret.create`
`{ kind: 'secret_collection', path: '/v1/secrets' }`

### Bearer-token authentication

Register auth and principal hooks before protected `/v1` routes. `GET /health` remains unauthenticated by design as the public operational endpoint; document that choice in code comments or tests so it is not mistaken for an omitted auth check.
Token comparison must avoid logging or echoing token values and must use constant-time comparison for the supplied bearer token, even though this is not full production auth. Missing, malformed, or wrong credentials should return the shared error envelope with HTTP `401`.
Recommended auth contract:
```typescript
interface BearerAuthOptions {
  readonly bearerToken: string;
  readonly resolvePrincipal?: () => Principal | Promise;
}
```
The `resolvePrincipal` type should allow either synchronous or asynchronous resolution now so future real identity providers do not require a breaking API change.
The hook sequence should be:
1. Check bearer token.
2. Attach hardcoded principal to request context.
3. Allow route handler or pre-handler policy checks to continue.
Policy can be a pre-handler applied to protected routes, or a helper called by each protected route. Prefer a shared pre-handler or route wrapper so future routes cannot easily forget it.
### Configuration contract and API

Add Zod schemas in `packages/api-contract` for:
- Configuration id params.
- Configuration record kind.
- Configuration create request.
- Configuration update request.
- Configuration response.
- Configuration list response.
- Secret handle references used inside configuration settings.
The configuration schema should be intentionally narrow but representative. A provider configuration record with `providerKind`, `adapterId`, and JSON settings that include an optional secret handle is enough. Avoid inventing the whole future settings model.
Specific schema requirements:
- `settings.profileName` must be `z.string().min(1)` so the documented non-empty requirement is enforced.
- `createdAt` and `updatedAt` response fields must use `.datetime()` validation rather than accepting arbitrary strings.
Recommended routes:
- `POST /v1/configuration-records` creates a record.
- `GET /v1/configuration-records` lists records.
- `GET /v1/configuration-records/:id` reads one record.
- `PATCH /v1/configuration-records/:id` updates mutable fields.
- `DELETE /v1/configuration-records/:id` deletes one record.
PATCH semantics are intentionally narrow and must be reflected in the Zod update schema and route tests:
- Mutable fields are `providerKind`, `adapterId`, and `settings`; `id`, `kind`, `createdAt`, and `updatedAt` are server-owned and cannot be patched.
- A PATCH body must include at least one mutable field.
- `settings` is a partial object patch for the supported settings fields. Omitting a settings field retains the existing value. Providing `settings.profileName` replaces the profile name and must still be a non-empty string. Providing `settings.credentialSecretHandle` as a valid handle sets or replaces the reference; omitting it retains the existing reference; providing `settings.credentialSecretHandle: null` clears the reference.
- A successful PATCH updates `updatedAt` and leaves `createdAt` unchanged. Failed validation or not-found responses must not update persistence.
DELETE `/v1/configuration-records/:id` returns HTTP `204 No Content` with an empty response body when a record is deleted. Deleting a missing record returns `404 not_found`.
All request bodies and params should parse through contract schemas. Responses should parse through contract schemas before being sent, matching the existing route style.
### Persistence model

Add Drizzle schema and migrations for configuration records and secrets. A simple SQLite design is enough:
- `configuration_records`
	- `id` primary key
	- `kind` text
	- `provider_kind` text nullable or required depending on schema
	- `adapter_id` text nullable or required depending on schema
	- `settings_json` text containing validated JSON data
	- `created_at` text
	- `updated_at` text
- `secret_store_metadata`
	- `id` primary key, using a singleton value such as `default`
	- `encryption_version` text, initially `v1`
	- `kdf_name` text, initially `scrypt`
	- `kdf_params_json` text containing the scrypt parameters used for this store
	- `kdf_salt` text containing a base64-encoded random salt
	- `sentinel_nonce` text containing a base64-encoded random AES-GCM nonce
	- `sentinel_ciphertext` text or blob containing an encrypted fixed sentinel value
	- `sentinel_auth_tag` text containing the base64-encoded AES-GCM authentication tag
	- `created_at` text
	- `updated_at` text
- `secrets`
	- `handle` primary key
	- `ciphertext` text or blob
	- `nonce` text containing a base64-encoded random AES-GCM nonce
	- `auth_tag` text containing the base64-encoded AES-GCM authentication tag
	- `encryption_version` text matching the store metadata version used for the row
	- `created_at` text
Encryption is required in this pass. Derive a 256-bit encryption key from the master secret with Node `crypto.scrypt` using the persisted store salt and parameters, then encrypt secret values with authenticated encryption such as AES-256-GCM. Store the nonce, authentication tag, ciphertext, encryption version, KDF salt, and KDF parameters needed to decrypt later. Do not store plaintext secret values in SQLite and call it a secret store.
Repositories should include:
- `ConfigurationRepository` for create, list, find by id, update, and delete.
- `SecretStore` or `SecretRepository` with unlock/create behavior and handle-based storage.
Use repository interfaces from core call sites. Keep Drizzle details inside `packages/persistence`.
### Secret-store unlock

The app should construct and unlock the secret store during startup with `masterSecret`. Startup failure is required when `masterSecret` is missing or empty because it is easiest to reason about and matches the bootstrap contract. Locked-mode startup is explicitly deferred from this feature.
Unlock semantics:
- On first unlock for a new database, initialize the singleton `secret_store_metadata` row by deriving the store key, encrypting a fixed non-secret sentinel value, and storing the version, KDF parameters, salt, nonce, ciphertext, and authentication tag.
- On unlock for an existing database, derive the key from the supplied master secret and stored metadata, then authenticate/decrypt the sentinel. If authentication fails, throw `SecretStoreUnlockError`, leave the store locked, do not register protected secret operations as usable, and do not rewrite existing metadata or secret rows.
- Unlock is idempotent after one successful unlock in the same process and must not rederive keys, rotate metadata, rewrite rows, or log the supplied master secret.
- Master-secret rotation and re-encryption of existing secret rows are explicitly out of scope for this feature.
The secret-store API should separate secret value operations from configuration record operations:
- Secret create returns a handle.
- Configuration create/update accepts a handle.
- Configuration read/list returns a handle.
- No configuration response returns plaintext.
If a minimal secret-create endpoint is added for integration testing, keep it under `/v1` and protect it with the same auth and policy seam. Do not add a secret-read endpoint unless a later feature needs it. Returned handles must use the exact `^sec_[A-Za-z0-9_-]{32}$` format described above.
### SDK

Extend the SDK only where it proves contract consumption:
- Add authorization header support to the client options.
- Send the bearer token on protected calls.
- Add configuration CRUD methods if the API routes are public in this feature.
- Add a minimal create-secret method only if the service exposes a minimal create-secret endpoint.
The SDK should continue parsing responses through `packages/api-contract` schemas and throwing `ControlPlaneClientError` for shared error envelopes.
### OpenAPI

Update `packages/api-contract/src/openapi.ts` so new routes are registered from the same schemas and constants used by core and SDK. Do not hand-author independent path objects or duplicate request/response shapes.
Mark bearer-token auth in the generated document if the current OpenAPI generator setup supports security schemes cleanly. If not, include route responses for `401` and leave a small documented follow-up rather than adding a second OpenAPI authoring pattern.
### Testing

Add or update tests at these layers:
- Config tests for `CONTROL_PLANE_BEARER_TOKEN`, `--bearer-token`, `CONTROL_PLANE_MASTER_SECRET`, and `--master-secret` parsing and validation.
- Contract tests for principal, configuration, secret-handle, and error schemas.
- Core route tests for missing token, invalid token, principal availability, policy consultation, config CRUD validation, not-found behavior, and no secret value in config responses.
- Persistence tests for configuration repository CRUD and secret store handle/value separation.
- App integration tests that boot the real service with a temporary SQLite file and deterministic bootstrap token/master secret.
- SDK tests for auth header behavior and configuration methods if added.
Use isolated temporary database files in tests. Avoid assertions that depend on exact generated ids except for prefixes or schema validity.
### Documentation updates

Update `context-agent/wiki/code-map.md` with:
- Where the bootstrap loader reads bearer token and master secret.
- Where auth hooks and principal request context are registered.
- Where the policy-decision interface and permissive implementation live.
- Where configuration contract schemas, routes, repositories, and migrations live.
- Where the secret store, secret-store metadata table, and secret table live.
- New local run commands or environment variables.
Human-owned concept docs and ADRs already describe the target architecture. Do not edit them unless implementation discovers a mismatch.
### Risks and open decisions

- **Encryption detail:** the issue requires a secret store unlocked by a master secret. Implementation must not store plaintext secret values in ordinary configuration records or API responses. The required minimum format is a local SQLite encrypted store with persisted encryption version, KDF salt/parameters, nonce, authentication tag, ciphertext, and a metadata sentinel that detects a wrong master secret during unlock.
- **Locked mode versus startup failure:** startup failure when the master secret is absent is required for this feature. Locked-mode startup is explicitly deferred.
- **Configuration schema breadth:** keep the record schema narrow enough to prove the storage pattern without implementing the full settings model or provider registry.
- **Health auth scope:** `GET /health` remains public as an operational endpoint and does not resolve a principal or consult policy, while all `/v1` routes must use bearer auth, principal resolution, and policy checks.
- **Provider behavior:** `providerKind` and `adapterId` are stored as validated fields only. This feature does not resolve provider ids, consult the extension registry, or produce registry warnings; issue 8 owns that behavior.
## Task list

### Story 1: Bootstrap config and server composition

Prepare the control-plane app to start with the minimal service-owned bootstrap values and wire the new runtime dependencies. This intentionally changes `createControlPlaneServer` from the issue 5 caller-owned database composition helper into an options-based composition function while preserving the health-check failure seam that K3 tests rely on. The stable lifecycle surface that must be preserved is `startControlPlaneServer(config)`, `ControlPlaneServerHandle.close()`, and the invariant that `createControlPlaneServer` composes but does not call `listen()`.
#### Task 1.1: Extend bootstrap config parsing

- **Description:** Update `apps/control-plane/src/config.ts` so `ControlPlaneAppConfig` includes `bearerToken` and `masterSecret`, and `readControlPlaneAppConfig` reads `CONTROL_PLANE_BEARER_TOKEN`, `CONTROL_PLANE_MASTER_SECRET`, `--bearer-token`, and `--master-secret`.
- **Acceptance criteria:**
	- `readControlPlaneAppConfig` returns `port`, `databasePath`, `bearerToken`, and `masterSecret`.
	- Launch flags override environment values using the existing config precedence.
	- Missing or empty bearer token and master secret values throw startup validation errors.
	- Tests cover env and argv parsing for the new values and confirm secret values are not included in error messages.
- **Dependencies:** Existing `apps/control-plane/src/config.ts` behavior from issue 5.
#### Task 1.2: Update server options and app composition

- **Description:** Change `apps/control-plane/src/server.ts` to accept `ControlPlaneServerOptions` with `databasePath`, `bearerToken`, `masterSecret`, optional `policy`, and optional `health`, then open SQLite, apply migrations, unlock the secret store, create repositories, and register routes.
- **Acceptance criteria:**
	- `createControlPlaneServer(options)` owns database open, migrations, secret-store unlock, dependency construction, route registration, and cleanup on Fastify close.
	- `startControlPlaneServer(config)` preserves the existing listen/close lifecycle and delegates composition to `createControlPlaneServer`.
	- Direct calls with empty required options fail before route registration.
	- Tests or integration setup can inject a policy decision point through server options.
	- Tests or integration setup can inject a `HealthDependencyChecker` through server options to force healthy and degraded `/health` responses without a caller-owned database handle.
- **Dependencies:** Task 1.1, Story 4 repository and secret-store implementations, Story 5 route dependency shape.
#### Task 1.3: Keep public health behavior explicit

- **Description:** Preserve `GET /health` as the public operational endpoint unless implementation discovers a reason to protect it, keep degraded-health behavior testable through the injected health checker, and document that choice in code comments or tests.
- **Acceptance criteria:**
	- Health checks still work without an authorization header.
	- When the configured health checker reports an unreachable dependency or throws, `GET /health` returns degraded health with HTTP `503`.
	- `apps/control-plane/src/integration.spec.ts` ports the K3 closed caller-owned database regression to the new `health?: HealthDependencyChecker` seam instead of deleting the degraded-health coverage.
	- `/v1` routes remain protected by auth, principal resolution, and policy checks.
	- A test or clear comment makes the health exception intentional.
- **Dependencies:** Story 5 protected route registration.
### Story 2: Shared contracts and OpenAPI

Add the API-contract schemas, types, route constants, status constants, and OpenAPI registration required by the agreed public API.
#### Task 2.1: Add principal contract schemas

- **Description:** Create `packages/api-contract/src/principal.ts` with `principalKindSchema`, `principalSchema`, `principalDiagnosticResponseSchema`, and inferred types.
- **Acceptance criteria:**
	- `PrincipalKind` accepts only `human`, `model`, and `system`.
	- `Principal` includes `id`, `kind`, `tenantId`, and optional `displayName`.
	- Contract tests parse a valid diagnostic response and reject invalid principal kinds.
	- Package exports expose the new schemas and types.
- **Dependencies:** None.
#### Task 2.2: Add configuration-record contract schemas

- **Description:** Create `packages/api-contract/src/configuration-record.ts` with route constants, status constants, id params, record kind, settings, create, update, response, and list schemas.
- **Acceptance criteria:**
	- `configurationRecordCollectionPath` is `/v1/configuration-records`.
	- Create and update request schemas validate `provider_profile`, `providerKind`, `adapterId`, and non-empty `settings.profileName` with `z.string().min(1)`.
	- Update request schemas accept only mutable fields, reject empty patch bodies, and allow `settings.credentialSecretHandle: null` only as the explicit clear operation.
	- `settings.credentialSecretHandle` validates through the shared secret handle schema when present.
	- Response schemas validate `createdAt` and `updatedAt` with `.datetime()`.
	- Response schemas include secret handles but no secret value field.
	- Contract tests cover valid create/update/list payloads and invalid settings.
- **Dependencies:** Task 2.3 for shared secret handle schema.
#### Task 2.3: Add secret contract schemas

- **Description:** Create `packages/api-contract/src/secret.ts` with the minimal protected secret-create endpoint contract and `sec_`-prefixed handle validation.
- **Acceptance criteria:**
	- `secretCollectionPath` is `/v1/secrets`.
	- `createSecretRequestSchema` rejects empty secret values.
	- `createSecretResponseSchema` returns only `{ handle }`.
	- `secretHandleSchema` accepts only handles matching `^sec_[A-Za-z0-9_-]{32}$`.
	- Tests prove handles must match the exact `sec_` URL-safe format and reject shorter, longer, padded, or non-URL-safe values.
- **Dependencies:** None.
#### Task 2.4: Extend shared error contract exports

- **Description:** Update `packages/api-contract/src/errors.ts` to export stable error-code constants for unauthorized, validation, not-found, and locked secret-store failures while preserving the shared error envelope.
- **Acceptance criteria:**
	- Existing error envelope behavior remains compatible.
	- New error code constants are exported from the package entrypoint.
	- Contract tests cover the new code constants where the project convention supports that.
- **Dependencies:** Existing error schema.
#### Task 2.5: Register new OpenAPI paths

- **Description:** Update `packages/api-contract/src/openapi.ts` to register principal diagnostic, configuration-record CRUD, minimal secret-create, and shared error responses from the same schemas and constants used by routes and SDK.
- **Acceptance criteria:**
	- Generated OpenAPI includes `/v1/configuration-records`, `/v1/configuration-records/{id}`, and `/v1/secrets`.
	- `DELETE /v1/configuration-records/{id}` documents `204 No Content` with an empty body for successful deletes.
	- New route docs include 401, validation, not-found, and secret-store locked responses where applicable.
	- Bearer-token security is documented if the existing generator supports it without a new authoring pattern.
	- OpenAPI tests or snapshots are updated.
- **Dependencies:** Tasks 2.1 through 2.4.
### Story 3: Principal, bearer auth, and policy seam

Make every protected API request authenticate with a bearer token, receive the hardcoded development principal, and pass through one policy-decision point.
#### Task 3.1: Add principal request-context helpers

- **Description:** Create `packages/core/src/principal.ts` with `hardcodedDevelopmentPrincipal`, `attachPrincipalToRequest`, `getPrincipalFromRequest`, and `requirePrincipalFromRequest`.
- **Acceptance criteria:**
	- The hardcoded principal uses synthetic values and kind `human`.
	- Helpers centralize request context access and avoid route-level casts where practical.
	- `requirePrincipalFromRequest` fails fast if a protected handler runs without a principal.
	- Unit tests cover attach, get, and require behavior.
- **Dependencies:** Task 2.1.
#### Task 3.2: Add bearer-token auth hook

- **Description:** Create `packages/core/src/auth.ts` with `BearerAuthOptions` and `registerBearerAuthHook` for protected `/v1` route scopes.
- **Acceptance criteria:**
	- `BearerAuthOptions.resolvePrincipal` is typed as `() => Principal | Promise` and defaults to the hardcoded development principal when omitted.
	- Missing, malformed, and wrong bearer tokens return `401` with the shared error envelope.
	- Valid tokens attach either `resolvePrincipal()` or `hardcodedDevelopmentPrincipal`.
	- Token comparison uses a constant-time comparison helper and avoids logging, echoing, or exposing token values.
	- Core tests prove protected handlers do not run on auth failure.
- **Dependencies:** Tasks 2.4 and 3.1.
#### Task 3.3: Add permissive policy-decision point

- **Description:** Create `packages/core/src/policy.ts` with `PolicyDecisionPoint`, `PolicyDecisionInput`, `PolicyDecision`, `permissivePolicyDecisionPoint`, and `authorizeRequest`.
- **Acceptance criteria:**
	- The default policy returns allow for every authenticated protected `/v1` request.
	- `PolicyDecisionInput` includes principal, action, and resource descriptor.
	- Tests can inject a recording policy and assert `authorize` was called.
	- Future deny behavior has one helper path without changing route handler signatures.
- **Dependencies:** Task 2.1.
#### Task 3.4: Add principal diagnostic route for tests

- **Description:** Register a protected diagnostic route only if needed to prove principal resolution through the real app, using `principalDiagnosticResponseSchema`.
- **Acceptance criteria:**
	- The route is under `/v1` and uses the same auth and policy seam as other protected routes.
	- The response includes the attached principal and parses through the contract schema.
	- Integration tests can prove an authenticated protected `/v1` request reaches a handler with the hardcoded principal.
- **Dependencies:** Tasks 2.1, 3.1, 3.2, and 3.3.
### Story 4: Persistence for configuration records and secrets

Persist service-owned configuration and encrypted secret values in SQLite behind core-owned interfaces.
#### Task 4.1: Add Drizzle schema and migration

- **Description:** Update `packages/persistence/src/schema.ts` and add `packages/persistence/drizzle/0001_create_configuration_and_secrets.sql` for `configuration_records`, `secret_store_metadata`, and `secrets`.
- **Acceptance criteria:**
	- `configuration_records` stores id, kind, provider kind, adapter id, settings JSON, created timestamp, and updated timestamp.
	- `secret_store_metadata` stores the encryption version, KDF salt/parameters, encrypted sentinel, sentinel nonce, sentinel authentication tag, and timestamps.
	- `secrets` stores opaque handle, ciphertext, nonce, authentication tag, encryption version, and created timestamp.
	- Migration runs in a fresh temporary SQLite database.
	- Existing probe-resource schema and migrations continue to work.
- **Dependencies:** Tasks 2.2 and 2.3.
#### Task 4.2: Define core configuration use cases and repository interface

- **Description:** Create `packages/core/src/configuration-record.ts` with `ConfigurationRecordRepository`, input aliases, and create/list/get/update/delete use-case functions.
- **Acceptance criteria:**
	- Core route code depends on the repository interface, not Drizzle.
	- Use-case inputs align with the agreed API request types for this feature.
	- Use cases preserve repository null/boolean not-found results for route error mapping.
	- Unit tests cover use-case delegation.
- **Dependencies:** Task 2.2.
#### Task 4.3: Implement Drizzle configuration repository

- **Description:** Create `packages/persistence/src/configuration-record-repository.ts` implementing the core repository interface with SQLite CRUD and JSON settings serialization.
- **Acceptance criteria:**
	- Create generates `cfg_` ids and ISO timestamps.
	- List, find, update, and delete work against isolated temporary databases.
	- Settings JSON round-trips through contract-compatible objects.
	- Repository responses never include secret values.
- **Dependencies:** Tasks 4.1 and 4.2.
#### Task 4.4: Define core secret-store interface and use case

- **Description:** Create `packages/core/src/secret.ts` with `SecretStore`, `CreateSecretInput`, `createSecret`, and core `SecretStoreLockedError`.
- **Acceptance criteria:**
	- Core routes can create secret handles without importing persistence.
	- `SecretStoreLockedError` messages do not include submitted secret values.
	- Unit tests cover use-case delegation and locked-store error propagation.
- **Dependencies:** Task 2.3.
#### Task 4.5: Implement SQLite-backed encrypted secret store

- **Description:** Create `packages/persistence/src/secret-store.ts` with `SqliteSecretStore`, unlock behavior, encryption/key derivation from the master secret, handle generation, and persistence of ciphertext only.
- **Acceptance criteria:**
	- `unlock(masterSecret)` is idempotent after the first successful unlock.
	- Unlocking an existing store with the wrong master secret throws `SecretStoreUnlockError`, leaves the store locked, and does not rewrite metadata or secret rows.
	- `createSecret` before unlock throws `SecretStoreLockedError`.
	- Created handles use the exact `^sec_[A-Za-z0-9_-]{32}$` format, are generated from at least 24 cryptographically secure random bytes, retry on database handle collisions with fresh random bytes, and stored rows contain ciphertext, not plaintext.
	- Tests prove plaintext secret values are absent from `configuration_records`, API responses, logs where captured, and the `secrets` stored payload, and prove the wrong-master unlock behavior.
- **Dependencies:** Tasks 4.1 and 4.4.
### Story 5: Protected `/v1` routes for configuration and secrets

Expose configuration CRUD and minimal secret creation through Fastify routes that use contract validation, auth, principal context, and policy checks.
#### Task 5.1: Update route dependency contract

- **Description:** Extend `ControlPlaneRouteDependencies` in `packages/core/src/routes.ts` to include auth options, policy, configuration-record repository, and secret store while preserving existing health and probe-resource dependencies.
- **Acceptance criteria:**
	- Route registration accepts the agreed dependency bag.
	- Existing health and probe-resource route behavior is preserved except for intended `/v1` protection.
	- Type exports match the task-local contracts for principal, bearer auth, policy, configuration records, secret store, and health checking.
- **Dependencies:** Tasks 3.2, 3.3, 4.2, and 4.4.
#### Task 5.2: Apply protected route scope

- **Description:** Register bearer auth, principal resolution, and policy authorization for protected `/v1` routes through a shared plugin, pre-handler, or route wrapper.
- **Acceptance criteria:**
	- Every `/v1` configuration, secret, probe-resource, and diagnostic route requires a valid bearer token.
	- Every protected route has an attached principal before handler logic runs.
	- Every protected route consults `PolicyDecisionPoint.authorize`.
	- Tests fail if a protected route bypasses auth or policy.
- **Dependencies:** Story 3 and Task 5.1.
#### Task 5.3: Implement configuration-record CRUD routes

- **Description:** Add `POST`, `GET` list, `GET` by id, `PATCH`, and `DELETE` handlers for `/v1/configuration-records`.
- **Acceptance criteria:**
	- Request params and bodies parse through `packages/api-contract` schemas before persistence calls.
	- Responses parse through response schemas before sending.
	- Invalid writes return `400 validation_error`.
	- Missing records return `404 not_found`.
	- PATCH accepts only `providerKind`, `adapterId`, and partial `settings` updates; rejects empty patch bodies; retains omitted fields; clears `settings.credentialSecretHandle` only when it is explicitly `null`; and updates `updatedAt` only after a successful persisted update.
	- Delete returns HTTP `204 No Content` with an empty response body, and no secret values are present in any response.
- **Dependencies:** Tasks 2.2, 2.4, 4.2, 4.3, and 5.2.
#### Task 5.4: Implement minimal create-secret route

- **Description:** Add `POST /v1/secrets` for creating an opaque secret handle from a submitted secret value.
- **Acceptance criteria:**
	- The route is protected by bearer auth, principal resolution, and policy.
	- Request and response bodies parse through secret contract schemas.
	- The response contains only a handle.
	- Locked-store errors return the shared locked error envelope and never echo the submitted value.
- **Dependencies:** Tasks 2.3, 2.4, 4.4, 4.5, and 5.2.
### Story 6: SDK support for protected calls

Extend the typed client so tests and future callers consume the new contracts instead of hand-written fetch calls.
#### Task 6.1: Add bearer-token client option

- **Description:** Update `packages/sdk/src/client.ts` so `ControlPlaneClientOptions` accepts optional `bearerToken` and protected calls send `Authorization: Bearer `.
- **Acceptance criteria:**
	- Existing health client behavior still works without a token.
	- Protected methods include the authorization header when a token is configured.
	- Tests confirm token values are not included in thrown client errors.
- **Dependencies:** Task 3.2.
#### Task 6.2: Add configuration-record SDK methods

- **Description:** Add `createConfigurationRecord`, `listConfigurationRecords`, `getConfigurationRecord`, `updateConfigurationRecord`, and `deleteConfigurationRecord` methods using contract paths and schemas.
- **Acceptance criteria:**
	- Methods parse successful responses through `packages/api-contract` schemas.
	- Shared error envelopes still throw `ControlPlaneClientError`.
	- Delete resolves to `void` on HTTP `204 No Content`.
	- SDK tests cover request shape, response parsing, and error mapping.
- **Dependencies:** Tasks 2.2, 2.4, 5.3, and 6.1.
#### Task 6.3: Add create-secret SDK method

- **Description:** Add `createSecret` using the minimal secret-create contract.
- **Acceptance criteria:**
	- The method posts to `/v1/secrets` with the bearer token when configured.
	- The method returns only the parsed handle response.
	- SDK tests cover validation and shared error handling.
- **Dependencies:** Tasks 2.3, 2.4, 5.4, and 6.1.
### Story 7: End-to-end behavior and documentation

Prove the complete behavior with real app integration tests and update agent navigation docs for future implementation work.
#### Task 7.1: Add real-app integration test for principal and policy

- **Description:** Boot the real control-plane app with a temporary SQLite database, deterministic bearer token, deterministic master secret, and recording policy implementation.
- **Acceptance criteria:**
	- An authenticated `/v1` request reaches a handler with the hardcoded principal.
	- The recording policy receives the expected principal, action, and resource descriptor.
	- Missing or invalid tokens return `401` before handler behavior runs.
	- Test cleanup closes the Fastify app and removes or isolates temporary files.
- **Dependencies:** Stories 1, 3, 4, and 5.
#### Task 7.2: Add real-app integration test for configuration CRUD

- **Description:** Exercise create, read, list, update, and delete behavior for `/v1/configuration-records` through the real app.
- **Acceptance criteria:**
	- Create/read/update responses match contract schemas.
	- Invalid configuration writes return `400 validation_error`.
	- Reading a deleted or missing record returns `404 not_found`.
	- The test uses only authenticated protected calls.
- **Dependencies:** Tasks 5.3 and 6.2 if the SDK is used in integration tests.
#### Task 7.3: Add real-app integration test for secret-handle separation

- **Description:** Create a secret, reference its handle from a configuration record, and read the record back through the real app.
- **Acceptance criteria:**
	- Secret creation returns a `sec_` handle.
	- The configuration record response contains the handle and excludes the submitted secret value.
	- The secret value is not stored in `configuration_records`.
	- The `secrets` table stores ciphertext rather than plaintext.
- **Dependencies:** Tasks 4.5, 5.3, and 5.4.
#### Task 7.4: Update agent navigation and decision docs

- **Description:** Update `context-agent/wiki/code-map.md` and add `context-agent/decisions/core-api-request-type-aliases.md` to record the new bootstrap, principal, policy, configuration, secret-store, SDK, and intentional input-alias locations.
- **Acceptance criteria:**
	- Code map points to the new files and route locations.
	- The decision file uses the repository’s terse decision format.
	- Documentation mentions new local environment variables and flags.
	- No human-owned concept docs or ADRs are changed unless a mismatch is discovered and approved.
- **Dependencies:** Stories 1 through 6.
#### Task 7.5: Migrate K3 regression tests to auth and server options

- **Description:** Update the existing K3 test files that are affected by options-based server composition and `/v1` bearer-token protection instead of weakening route protection to keep old tests green.
- **Acceptance criteria:**
	- `apps/control-plane/src/integration.spec.ts` calls `startControlPlaneServer`/`createControlPlaneServer` with `bearerToken`, `masterSecret`, and any required new options, sends `Authorization: Bearer ` on `/v1/probe-resources` and `/v1/events`, keeps unauthenticated `/health` coverage, and ports degraded `/health` coverage to the `health?: HealthDependencyChecker` seam.
	- `packages/core/src/routes.spec.ts` sends a valid bearer token for inject-based probe-resource tests that exercise protected `/v1` routes and adds or updates negative auth assertions without bypassing policy.
	- `packages/sdk/src/client.spec.ts` configures the client bearer token for `createProbeResource` and `getProbeResource` tests and asserts protected calls include the authorization header.
	- The migrated tests still prove missing or invalid tokens fail with `401`; no test-only route registration path disables `/v1` auth or policy.
- **Dependencies:** Stories 1, 3, 5, and 6.
#### Task 7.6: Run targeted and project validation

- **Description:** Run the smallest useful checks first, then the broader project checks available in `package.json` or Nx for changed packages.
- **Acceptance criteria:**
	- Contract, core, persistence, SDK, config, and app integration tests pass.
	- Lint and type checks pass for changed packages.
	- Generated OpenAPI output is current if the repository tracks it.
	- Any skipped check is recorded with the exact reason.
- **Dependencies:** Tasks 7.1 through 7.5.