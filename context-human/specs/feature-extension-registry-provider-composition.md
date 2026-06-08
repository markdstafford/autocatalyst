---
created: 2026-06-08
last_updated: 2026-06-08
status: complete
issue: 8
specced_by: markdstafford
---
# Feature: Extension registry catalog and provider composition root

## Product requirements

### What

Add the first runtime seam for Autocatalyst provider extensibility. The service gains a descriptive extension-registry catalog that lists provider kinds, implementation ids, and declared capabilities. The catalog supports discovery and advisory validation, but it does not decide whether a provider can run.
Add a startup composition root that reads stored provider configuration records, resolves each configured `providerKind` and `adapterId` against an explicit adapter map, and composes every resolvable provider behind its provider port. A configured adapter that is absent from the registry produces a warning only. A configured adapter that has no resolving code is reported as unresolved and is not treated as runnable.
This feature builds on issue 7. Issue 7 stores `providerKind` and `adapterId` as validated configuration data. This feature gives those fields runtime meaning without making registry membership a permission gate.
### Why

Autocatalyst will support several pluggable provider kinds: model and agent runners, issue trackers, code hosts, channels, and publishers. The core service needs one clear rule for how those providers are discovered, described, and wired. ADR-011 makes that rule explicit: the registry is metadata, while runtime composition is explicit code resolution.
Adding this seam now prevents later provider work from coupling configuration validity to registry entries. It also gives future settings and diagnostics surfaces a stable source for available provider metadata while keeping the runnable provider set tied to concrete adapter code.
### Goals

- Add an extension-registry catalog that declares provider kinds, implementation ids, display metadata, and declared capabilities.
- Keep the registry descriptive and non-gating for every provider kind.
- Add advisory validation for configured providers using registry metadata only.
- Emit a warning when a configured adapter id is absent from the registry.
- Ensure registry warnings never prevent configuration validity, startup, or adapter composition.
- Add an explicit startup composition root that reads stored provider configuration records.
- Resolve configured providers against an explicit adapter map, not against the registry.
- Compose every resolvable configured provider behind its provider-kind port.
- Report configured providers that have no resolving adapter code as unresolved and exclude them from runnable bindings.
- Prove the distinction between registry metadata and runtime resolution with fake adapters in tests.
- Record the registry catalog and composition root locations in `context-agent/wiki/code-map.md` during implementation.
### Non-goals

- Concrete provider adapters for AI models, trackers, code hosts, channels, publishers, or runners.
- Runtime model routing or per-run provider selection.
- Per-run provider resolution into the Execution Context.
- Dynamic third-party plugin loading, sandboxing, marketplace behavior, or registry-as-permission-gate behavior.
- Desktop, mobile, or settings UI for browsing the registry.
- API endpoints for registry discovery unless implementation needs a narrow diagnostic route to prove behavior.
- Live re-composition when configuration changes after startup.
- Secret injection into provider adapters beyond passing existing secret handles as configuration data.
### Personas

- **Enzo (Engineer)** needs a clear composition seam so future provider adapters can be added without leaking provider-specific code into core route handlers.
- **Phoebe (PM)** needs confidence that provider extensibility is real service behavior, not just stored configuration fields.
- **Dani (Designer)** is not a direct user of this backend-only feature, but future settings screens benefit from stable registry metadata for discovery and capability labels.
- **Opal (Operator)** needs startup diagnostics that distinguish warnings from unresolved provider wiring.
### User stories

- As Enzo, I can register descriptive metadata for a provider kind and adapter id so future settings and diagnostics can show what providers exist.
- As Enzo, I can wire a fake provider adapter in the startup adapter map and see a matching stored configuration compose behind its provider port.
- As Enzo, I can configure an adapter id that resolves to code but is absent from the registry and see it compose with a warning, proving the registry is not a gate.
- As Enzo, I can configure an adapter id that is listed in the registry but absent from the adapter map and see it reported unresolved, proving registry metadata does not imply runnable code.
- As Opal, I can read startup diagnostics and tell which provider records composed, which produced registry warnings, and which are unresolved.
- As Phoebe, I can see tests cover the three important cases: registered and resolvable, unregistered but resolvable, and registry-listed but unresolved.
### Acceptance criteria

#### Registry catalog

- An extension-registry catalog declares provider kinds, implementation ids, display metadata, and declared capabilities.
- Registry lookup can find metadata by `(providerKind, adapterId)`.
- Registry metadata is typed and exported from one clear package entrypoint.
- The registry can represent provider kinds that do not yet have concrete adapters.
- The registry is never used as a permission gate.
#### Advisory validation

- Configuration validation uses registry metadata for warnings only.
- Registry warnings are derived from registry metadata, never from adapter-code resolution alone.
- A configured adapter id absent from the registry produces a warning.
- A configured adapter id absent from the registry remains valid configuration.
- A configured adapter id absent from the registry still composes when it resolves to adapter code.
- Capability warnings apply only when the configured provider has registry metadata with declared capabilities relevant to the validation being performed.
#### Startup composition

- A startup composition root reads stored provider configuration records from the existing configuration repository.
- The composition root resolves each configured `(providerKind, adapterId)` against an explicit adapter map.
- The composition root composes resolved providers behind provider-kind ports.
- A configured adapter id that resolves to code is valid whether or not it appears in the registry.
- A configured adapter id with no resolving code is reported unresolved and is not exposed as a runnable binding.
- Registry membership alone never creates a runnable binding.
- Startup diagnostics distinguish composed providers, registry warnings, and unresolved providers.
#### Tests and documentation

- Tests cover the registered-and-resolvable case with a fake adapter.
- Tests cover the unregistered-but-resolvable case and assert the warning does not block composition.
- Tests cover the registry-listed-but-unresolved case and assert no runnable binding is created.
- Tests prove warning generation comes from registry metadata and not from adapter-map membership alone.
- Integration or server-composition tests prove startup invokes provider composition with stored configuration records.
- `context-agent/wiki/code-map.md` records the registry catalog and composition root locations during implementation.
## Design spec

### Design scope

This is a backend-only foundation feature. There is no visual UI or human-facing settings flow in this pass. The design work is the service-facing and developer-facing experience: how configuration records become adapter bindings, and how diagnostics explain non-gating registry warnings versus unresolved code.
### Service experience

The service should make provider startup behavior easy to reason about.
1. The control-plane app starts with the existing bootstrap config, database, auth, policy, and secret-store setup.
2. The app creates or receives an extension-registry catalog.
3. The app creates or receives an explicit provider adapter map.
4. The app reads persisted configuration records where `kind` is `provider_profile`.
5. The composition root checks registry metadata for advisory diagnostics.
6. The composition root resolves each provider profile against the adapter map.
7. Resolved providers are composed behind provider-kind ports.
8. Unresolved providers are reported as diagnostics and are not runnable.
9. Startup continues with a composition result available to tests and startup diagnostics through the explicit callback seam.
The important distinction is visible in diagnostics: “not in the registry” is a warning about metadata, while “no adapter code resolved” is an unresolved runtime composition result.
This feature does not store the composition result on `ControlPlaneServerHandle` or create a general runtime lookup API. Future runtime routing work that needs composed bindings must introduce an explicit storage or injection path instead of relying on this startup callback.
### Registry behavior

The registry is a descriptive catalog. It answers questions such as:
- What provider kinds does the service know how to describe?
- Which implementation ids are documented for each provider kind?
- What capabilities does an implementation claim?
- What labels or descriptions could a future settings UI show?
The registry does not answer “can this configured provider run?” Runtime code resolution answers that question through the adapter map.
A registry entry should be small and explicit. A representative shape is:
```json
{
  "providerKind": "model_runner",
  "adapterId": "fake-registered-model",
  "displayName": "Fake registered model runner",
  "capabilities": ["agent_session", "direct_completion"]
}
```
The catalog may include entries for providers that are not yet implemented. Those entries are useful metadata, but they must not create runnable bindings.
### Composition behavior

Composition is explicit and startup-owned. It reads stored provider profiles and resolves them against an adapter map keyed by `providerKind` and `adapterId`.
Expected cases:

Stored configuration
Registry entry
Adapter code
Result

`model_runner` / `fake-registered`
Present
Present
Provider composes without registry warning.

`model_runner` / `fake-unregistered`
Absent
Present
Provider composes with an advisory registry warning.

`model_runner` / `fake-unresolved`
Present
Absent
Provider is reported unresolved and no runnable binding is created.

`model_runner` / `fake-missing`
Absent
Absent
Provider has a registry warning and an unresolved result.

Unresolved providers should not crash startup in this feature because no runtime routing consumes them yet. They should be absent from runnable bindings and present in the composition diagnostics. A later routing feature can decide whether selecting an unresolved provider fails a run, blocks a configuration save, or triggers an operator-facing repair flow.
### Diagnostic design

Diagnostics should be structured, not only log lines. Logs are useful for operators, but tests and future API surfaces need typed results.
A composition result should include:
- `composed`: provider profiles that resolved to adapter code and produced runnable bindings.
- `warnings`: advisory validation warnings such as `adapter_not_registered`.
- `unresolved`: provider profiles that did not resolve to adapter code.
Warnings must not include secret values. They should identify records by configuration record id, provider kind, adapter id, and stable warning code.
### Empty state

If no provider configuration records exist, startup composition should succeed with empty `composed`, `warnings`, and `unresolved` arrays. This should be the common state for a fresh database.
### Error handling

- Invalid configuration records should still be rejected by the existing configuration API schemas before persistence.
- Registry warnings should not be returned as validation errors.
- Adapter factory failures have one deterministic policy: any exception thrown by a factory or promise rejection returned by a factory is caught by `composeConfiguredProviders` and reported as an unresolved `adapter_factory_failed` diagnostic. Startup errors outside adapter factory invocation, such as database, migration, repository-read, route-registration, duplicate-registry-construction, or callback failures, may still reject startup.
- Diagnostics must never echo bearer tokens, master secrets, or plaintext secret values.
- The registry must not read from the secret store.
## Tech spec

### Current state

Issue 7 has implemented the control-plane foundation this feature builds on:
- `apps/control-plane/src/config.ts` reads the bootstrap port, database path, bearer token, and master secret.
- `apps/control-plane/src/server.ts` composes Fastify, SQLite, migrations, the secret store, bearer auth, permissive policy, repositories, and routes.
- `packages/api-contract/src/configuration-record.ts` defines the `provider_profile` configuration record with `providerKind`, `adapterId`, and `settings.profileName` plus an optional secret handle.
- `packages/core/src/configuration-record.ts` owns configuration-record use cases and the repository interface.
- `packages/core/src/routes.ts` registers protected `/v1` routes and uses the existing policy seam.
- `packages/persistence/src/configuration-record-repository.ts` implements persisted configuration records.
- `packages/persistence/src/secret-store.ts` stores encrypted secrets behind opaque handles.
- `packages/sdk/src/client.ts` includes authenticated configuration and secret calls.
- `context-agent/wiki/code-map.md` records the current module layout.
There is not yet an extension registry, provider adapter map, or startup provider composition result. The existing configuration API stores provider identity as data only.
### Proposed package shape

Keep this feature in the existing packages unless implementation discovers a boundary that needs a new library.
- `packages/core/` owns the registry types, advisory validation helpers, provider adapter map types, composition result types, and the provider composition root.
- `apps/control-plane/` remains the thin composition shell. It creates or accepts the registry and adapter map, invokes the composition root during startup, and exposes the composition result through server options or a test seam.
- `packages/api-contract/` may add shared diagnostic schemas only if a route response needs to expose warnings. Avoid adding a registry API surface in this feature unless needed for tests.
- `packages/persistence/` should not know about registry metadata or adapter code. It continues to store and return configuration records.
- `packages/sdk/` should not change unless a new diagnostic endpoint is added.
Recommended new core files:
- `packages/core/src/extension-registry.ts`
- `packages/core/src/provider-composition.ts`
Both should be exported from `packages/core/src/index.ts`.
### Registry model

Add typed registry structures in core. Keep `providerKind` and `adapterId` as non-empty strings to match the current configuration-record contract and avoid inventing a full provider taxonomy in this feature.
Representative TypeScript shape:
```typescript
export interface ExtensionRegistryEntry {
  readonly providerKind: string;
  readonly adapterId: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly description?: string;
}

export interface ExtensionRegistryCatalog {
  list(): readonly ExtensionRegistryEntry[];
  findProvider(providerKind: string, adapterId: string): ExtensionRegistryEntry | undefined;
}
```
Provide a simple in-memory implementation and a default catalog export. The default catalog may start empty or include fake/test-only entries only in tests. Do not add real provider entries until concrete adapters exist.
The catalog should validate duplicate `(providerKind, adapterId)` pairs at construction time. Duplicate entries should fail fast because they make warnings and discovery ambiguous.
### Advisory validation model

Add a helper that compares a configuration record to registry metadata and returns warnings. It must not inspect the adapter map.
Representative shape:
```typescript
export type ProviderConfigurationWarningCode = 'adapter_not_registered';

export interface ProviderConfigurationWarning {
  readonly code: ProviderConfigurationWarningCode;
  readonly configurationRecordId: string;
  readonly providerKind: string;
  readonly adapterId: string;
  readonly message: string;
}
```
`adapter_not_registered` is emitted when `registry.findProvider(providerKind, adapterId)` returns `undefined`. The warning does not affect the record's validity and does not stop composition.
If capability validation is added in this feature, it must run only from registry metadata. For example, if a future caller asks for `agent_session` and a registered provider lacks that declared capability, the helper may emit a capability warning. Do not infer capability support from the adapter map in this feature.
### Adapter map and port bindings

Add a provider adapter map that is explicit code, not registry data. The map should be injectable so tests can register fake adapters without creating concrete provider packages.
Representative shape:
```typescript
export interface ProviderAdapterFactoryInput {
  readonly configurationRecord: ConfigurationRecord;
}

export interface ProviderPortBinding {
  readonly providerKind: string;
  readonly adapterId: string;
  readonly configurationRecordId: string;
  readonly adapter: unknown;
}

export type ProviderAdapterFactory = (
  input: ProviderAdapterFactoryInput
) => unknown | Promise;

export type ProviderAdapterMap = ReadonlyMap;
```
Use a small helper to build the adapter-map key, for example `${providerKind}:${adapterId}`. Keep the key helper in one place so future provider kinds do not duplicate string construction.
The adapter factory returns only the adapter object. The composition root constructs `ProviderPortBinding` itself from the persisted provider-profile record and the returned adapter object, so `providerKind`, `adapterId`, and `configurationRecordId` always match the stored configuration record being composed. If a returned adapter object happens to contain similarly named fields, they are adapter implementation details and must not override binding identity. The binding uses `unknown` for the adapter object in this foundation feature because no concrete provider port exists yet. Tests can assert that the fake adapter object is wrapped in a binding with identity fields from the configuration record. Later features should narrow the adapter type by provider kind when real ports exist.
### Composition root

Add a `composeConfiguredProviders` function in core. It should accept configuration records, a registry, and an adapter map. It should return a structured result.
Representative shape:
```typescript
export interface ProviderCompositionResult {
  readonly composed: readonly ProviderPortBinding[];
  readonly warnings: readonly ProviderConfigurationWarning[];
  readonly unresolved: readonly ProviderCompositionUnresolved[];
}

export interface ProviderCompositionUnresolved {
  readonly configurationRecordId: string;
  readonly providerKind: string;
  readonly adapterId: string;
  readonly reason: 'adapter_not_found' | 'adapter_factory_failed';
  readonly message: string;
}
```
Behavior:
1. Filter configuration records to provider records. Today that means `kind === 'provider_profile'`.
2. Generate registry warnings for each provider record.
3. Resolve adapter code through the adapter map.
4. If a factory exists, call it, await/unwrap the returned adapter object, construct a `ProviderPortBinding` from the configuration record identity plus that adapter object, and add the constructed binding to `composed`.
5. If no factory exists, add an `adapter_not_found` item to `unresolved`.
6. If a factory throws or rejects for any reason, add `adapter_factory_failed` to `unresolved` without leaking secret values.
7. Do not use the registry to decide whether a factory may run.
The function should be deterministic for stable test assertions. Iterate records in repository order and preserve that order in diagnostics.
### Control-plane startup integration

Extend `ControlPlaneServerOptions` in `apps/control-plane/src/server.ts` with optional provider-composition inputs and a way for tests to inspect the result.
Representative shape:
```typescript
interface ControlPlaneServerOptions {
  readonly databasePath: string;
  readonly bearerToken: string;
  readonly masterSecret: string;
  readonly policy?: PolicyDecisionPoint;
  readonly health?: HealthDependencyChecker;
  readonly extensionRegistry?: ExtensionRegistryCatalog;
  readonly providerAdapters?: ProviderAdapterMap;
  readonly onProviderComposition?: (result: ProviderCompositionResult) => void | Promise;
}
```
Startup should:
1. Open SQLite and apply migrations as it does today.
2. Unlock the secret store as it does today.
3. Create the configuration repository.
4. Read existing configuration records.
5. Invoke `composeConfiguredProviders` with `options.extensionRegistry ?? defaultExtensionRegistryCatalog` and `options.providerAdapters ?? emptyProviderAdapterMap`.
6. Call `onProviderComposition` if provided.
7. Register routes and finish server composition.
If the database has provider records but no adapter map entries, startup should produce unresolved diagnostics. It should not crash solely because a provider is unresolved in this feature.
### Configuration API interaction

The existing configuration API can remain unchanged for persisted record shape. If implementation chooses to surface advisory warnings on create, update, read, or list responses, add optional warning fields through `packages/api-contract` schemas and keep the change additive.
Do not make `POST /v1/configuration-records` or `PATCH /v1/configuration-records/:id` reject a provider solely because it is absent from the registry. Do not consult adapter-code resolution inside request validation. The only hard validation at the API boundary remains schema validation of the submitted record.
A narrow option is to keep warning generation entirely in core composition for this issue. That satisfies startup behavior and avoids changing the public API before a settings UI needs warnings. If warnings are not added to API responses, tests should cover the advisory helper and startup composition result directly.
### OpenAPI and SDK

No OpenAPI or SDK changes are required if this feature keeps registry diagnostics internal to startup composition. If a diagnostic route or warning field is added, update OpenAPI and SDK from the same `packages/api-contract` schemas and route constants used by core. Do not hand-author duplicate response shapes.
### Testing

Add targeted tests at these layers:
- Core registry tests for lookup, duplicate entry rejection, and empty catalog behavior.
- Core advisory validation tests for registered and unregistered provider records.
- Core composition tests for registered-and-resolvable, unregistered-but-resolvable, registry-listed-but-unresolved, and absent-registry-plus-absent-code cases.
- Core tests proving warnings are derived from registry metadata and not from adapter-map membership alone.
- Control-plane server composition tests that seed provider configuration records in a temporary SQLite database, inject fake registry and adapter map entries, start composition, and assert the structured result.
- Regression tests proving `GET /health` remains public and existing protected `/v1` routes still require auth after composition is added.
Use fake adapters only. A fake adapter can be an object such as `{ kind: 'fake-adapter' }` returned from an injected factory.
### Documentation updates

Update `context-agent/wiki/code-map.md` during implementation with:
- The registry catalog file and exported types.
- The provider composition root file.
- The server startup wiring that invokes composition.
- The test seam for inspecting composition results.
- Any new commands or route contracts if implementation adds a diagnostic API.
Human-owned concept docs and ADRs already describe the target architecture and ADR-011. Do not edit them unless implementation discovers a mismatch between the docs and the agreed behavior.
### Risks and open decisions

- **Unresolved provider startup policy:** This spec keeps startup non-crashing for unresolved providers because no runtime routing consumes them yet. A later routing feature must decide how unresolved selected providers fail at run time.
- **Adapter typing:** The initial binding uses `unknown` for fake adapters. Real provider work should narrow adapters behind provider-kind-specific ports.
- **Warning API surface:** This spec does not require public warning fields or registry endpoints. Future settings UI work can expose registry discovery and warnings through additive API changes.
- **Default catalog contents:** The default catalog should avoid claiming real providers exist before concrete adapters land. Tests should inject fake catalog entries.
- **Provider behavior:** Registry membership remains metadata only. Adapter-code resolution controls runnable composition, and unsupported concrete providers remain out of scope.
## Converged API

### Files

Path
Purpose
Exports

`packages/core/src/extension-registry.ts`
Defines the descriptive extension-registry catalog, in-memory catalog implementation, default catalog, and advisory registry-warning helper. The registry is metadata-only and is not used as a runnable-provider gate.
`ExtensionRegistryEntry`, `ExtensionRegistryCatalog`, `InMemoryExtensionRegistryCatalog`, `createExtensionRegistryCatalog`, `defaultExtensionRegistryCatalog`, `ProviderConfigurationWarningCode`, `ProviderConfigurationWarning`, `validateProviderConfigurationAgainstRegistry`

`packages/core/src/provider-composition.ts`
Defines explicit provider adapter-map types and the startup composition root that turns already-read persisted provider-profile configuration records into runnable provider-kind bindings plus structured diagnostics. The composition root accepts a record array, not a repository reference, handles both synchronous and asynchronous adapter factories uniformly, and preserves input record order in composed bindings and diagnostics for deterministic tests.
`ProviderAdapterFactoryInput`, `ProviderPortBinding`, `ProviderAdapterFactory`, `ProviderAdapterMap`, `ProviderCompositionUnresolvedReason`, `ProviderCompositionUnresolved`, `ProviderCompositionResult`, `ComposeConfiguredProvidersInput`, `buildProviderAdapterKey`, `emptyProviderAdapterMap`, `composeConfiguredProviders`

`packages/core/src/index.ts`
Core package entrypoint re-exporting the registry and provider-composition APIs from one clear package surface, while retaining existing named core exports such as HealthDependencyChecker for startup option contracts.
`HealthDependencyChecker`, `ExtensionRegistryEntry`, `ExtensionRegistryCatalog`, `InMemoryExtensionRegistryCatalog`, `createExtensionRegistryCatalog`, `defaultExtensionRegistryCatalog`, `ProviderConfigurationWarningCode`, `ProviderConfigurationWarning`, `validateProviderConfigurationAgainstRegistry`, `ProviderAdapterFactoryInput`, `ProviderPortBinding`, `ProviderAdapterFactory`, `ProviderAdapterMap`, `ProviderCompositionUnresolvedReason`, `ProviderCompositionUnresolved`, `ProviderCompositionResult`, `ComposeConfiguredProvidersInput`, `buildProviderAdapterKey`, `emptyProviderAdapterMap`, `composeConfiguredProviders`

`apps/control-plane/src/server.ts`
Extends startup options with injectable extension-registry and provider-adapter inputs, reads stored configuration records during startup before route registration, invokes provider composition after repository setup, exposes the structured composition result through a test/startup callback seam, and logs sanitized composition diagnostics in the production start path so operator-readable startup diagnostics are not silently discarded.
`ControlPlaneServerOptions`, `ControlPlaneServerHandle`, `ProviderCompositionDiagnosticLogger`, `logProviderCompositionDiagnostics`, `createControlPlaneServer`, `startControlPlaneServer`

### Public API

#### `InMemoryExtensionRegistryCatalog`

```typescript
export class InMemoryExtensionRegistryCatalog implements ExtensionRegistryCatalog
```
- Parameters:
	- `entries: readonly ExtensionRegistryEntry[]` — Descriptive registry entries to store in memory. Duplicate providerKind/adapterId pairs are rejected at construction time. Registry membership is metadata only and never creates runnable bindings.
- Returns: `ExtensionRegistryCatalog`
- Errors:
	- `Error when two or more entries share the same providerKind and adapterId pair.`
#### `createExtensionRegistryCatalog`

```typescript
export function createExtensionRegistryCatalog(entries?: readonly ExtensionRegistryEntry[]): ExtensionRegistryCatalog
```
- Parameters:
	- `entries: readonly ExtensionRegistryEntry[] | undefined` — Optional descriptive provider metadata entries. Defaults to an empty catalog.
- Returns: `ExtensionRegistryCatalog`
- Errors:
	- `Error when duplicate providerKind/adapterId entries are provided.`
#### `defaultExtensionRegistryCatalog`

```typescript
export const defaultExtensionRegistryCatalog: ExtensionRegistryCatalog
```
- Returns: `ExtensionRegistryCatalog`
#### `validateProviderConfigurationAgainstRegistry`

```typescript
export function validateProviderConfigurationAgainstRegistry(configurationRecord: ConfigurationRecord, registry: ExtensionRegistryCatalog): readonly ProviderConfigurationWarning[]
```
- Parameters:
	- `configurationRecord: ConfigurationRecord` — Persisted configuration record to evaluate. Provider-profile records are checked by providerKind and adapterId.
	- `registry: ExtensionRegistryCatalog` — Descriptive metadata catalog used only for advisory warning generation. Adapter-code resolution is not consulted.
- Returns: `readonly ProviderConfigurationWarning[]`
#### `buildProviderAdapterKey`

```typescript
export function buildProviderAdapterKey(providerKind: string, adapterId: string): string
```
- Parameters:
	- `providerKind: string` — Provider kind from a provider-profile configuration record.
	- `adapterId: string` — Adapter implementation id from a provider-profile configuration record.
- Returns: `string`
#### `emptyProviderAdapterMap`

```typescript
export const emptyProviderAdapterMap: ProviderAdapterMap
```
- Returns: `ProviderAdapterMap`
#### `composeConfiguredProviders`

```typescript
export function composeConfiguredProviders(input: ComposeConfiguredProvidersInput): Promise
```
- Parameters:
	- `input: ComposeConfiguredProvidersInput` — Already-read provider configuration records, descriptive registry, and explicit adapter map to use for startup composition. Callers must pass the awaited record array from the configuration repository; this API intentionally does not accept a repository reference. The function iterates configurationRecords in their provided order and preserves that order independently in composed, warnings, and unresolved result arrays for stable assertions.
- Returns: `Promise`
- Errors:
	- `All adapter factory throws and promise rejections are captured as unresolved diagnostics with reason adapter_factory_failed.`
	- `Adapter factory invocation must support both synchronous and asynchronous factories by wrapping factory(input) with Promise.resolve before awaiting/catching the result.`
	- `The composition root constructs ProviderPortBinding identity fields from the provider-profile configuration record and must not accept providerKind, adapterId, or configurationRecordId from factory output.`
#### `createControlPlaneServer`

```typescript
export async function createControlPlaneServer(options: ControlPlaneServerOptions): Promise
```
- Parameters:
	- `options: ControlPlaneServerOptions` — Control-plane startup options, now including optional extensionRegistry, providerAdapters, and onProviderComposition for provider startup composition. Startup must call repository.list() after repository setup and before route registration, then pass the resulting ConfigurationRecord\[\] into composeConfiguredProviders rather than passing the repository itself.
- Returns: `Promise`
- Errors:
	- `Error when bearerToken is blank.`
	- `Error when masterSecret is blank.`
	- `Database, migration, secret-store unlock, startup repository read, route registration, duplicate-registry construction, or onProviderComposition callback failures may reject startup. Adapter factory failures and unresolved providers alone do not reject startup.`
#### `startControlPlaneServer`

```typescript
export async function startControlPlaneServer(config: ControlPlaneAppConfig): Promise
```
- Parameters:
	- `config: ControlPlaneAppConfig` — Environment/CLI-derived control-plane app config. This type intentionally does not include onProviderComposition; the production start path must install its own composition-result handler by calling `logProviderCompositionDiagnostics(result, console)`. Logging the composition result must not include bearer tokens, master secrets, plaintext secret values, or provider settings payloads.
- Returns: `Promise`
- Errors:
	- `Propagates createControlPlaneServer startup errors and Fastify listen errors.`
#### `logProviderCompositionDiagnostics`

```typescript
export function logProviderCompositionDiagnostics(result: ProviderCompositionResult, logger?: ProviderCompositionDiagnosticLogger): void
```
- Parameters:
	- `result: ProviderCompositionResult` — Structured provider composition result to summarize.
	- `logger: ProviderCompositionDiagnosticLogger | undefined` — Optional injectable logger for tests. Defaults to `console`.
- Returns: `void`
- Behavior:
	- Writes one sanitized summary line with composed, warning, and unresolved counts using `logger.info`.
	- Writes per-composed binding diagnostics with configuration record id, provider kind, and adapter id using `logger.info`.
	- Writes per-warning and per-unresolved diagnostics with configuration record id, provider kind, adapter id, warning code, and unresolved reason as applicable using `logger.warn`.
	- Never logs bearer tokens, master secrets, plaintext secret values, provider settings payloads, or adapter object contents.
### Types

#### `ExtensionRegistryEntry`

```typescript
export interface ExtensionRegistryEntry { readonly providerKind: string; readonly adapterId: string; readonly displayName: string; readonly capabilities: readonly string[]; readonly description?: string; }
```
#### `ExtensionRegistryCatalog`

```typescript
export interface ExtensionRegistryCatalog { list(): readonly ExtensionRegistryEntry[]; findProvider(providerKind: string, adapterId: string): ExtensionRegistryEntry | undefined; }
```
#### `ProviderConfigurationWarningCode`

```typescript
export type ProviderConfigurationWarningCode = 'adapter_not_registered';
```
#### `ProviderConfigurationWarning`

```typescript
export interface ProviderConfigurationWarning { readonly code: ProviderConfigurationWarningCode; readonly configurationRecordId: string; readonly providerKind: string; readonly adapterId: string; readonly message: string; }
```
#### `ProviderAdapterFactoryInput`

```typescript
export interface ProviderAdapterFactoryInput { readonly configurationRecord: ConfigurationRecord; }
```
#### `ProviderPortBinding`

```typescript
export interface ProviderPortBinding { readonly providerKind: string; readonly adapterId: string; readonly configurationRecordId: string; readonly adapter: unknown; }
```
#### `ProviderAdapterFactory`

```typescript
export type ProviderAdapterFactory = (input: ProviderAdapterFactoryInput) => unknown | Promise;
```
#### `ProviderAdapterMap`

```typescript
export type ProviderAdapterMap = ReadonlyMap;
```
#### `ProviderCompositionUnresolvedReason`

```typescript
export type ProviderCompositionUnresolvedReason = 'adapter_not_found' | 'adapter_factory_failed';
```
#### `ProviderCompositionUnresolved`

```typescript
export interface ProviderCompositionUnresolved { readonly configurationRecordId: string; readonly providerKind: string; readonly adapterId: string; readonly reason: ProviderCompositionUnresolvedReason; readonly message: string; }
```
#### `ProviderCompositionResult`

```typescript
export interface ProviderCompositionResult { readonly composed: readonly ProviderPortBinding[]; readonly warnings: readonly ProviderConfigurationWarning[]; readonly unresolved: readonly ProviderCompositionUnresolved[]; }
```
#### `ComposeConfiguredProvidersInput`

```typescript
export interface ComposeConfiguredProvidersInput { readonly configurationRecords: readonly ConfigurationRecord[]; readonly registry: ExtensionRegistryCatalog; readonly providerAdapters: ProviderAdapterMap; }
```
#### `ControlPlaneServerOptions`

```typescript
export interface ControlPlaneServerOptions { readonly databasePath: string; readonly bearerToken: string; readonly masterSecret: string; readonly policy?: PolicyDecisionPoint; readonly health?: HealthDependencyChecker; readonly extensionRegistry?: ExtensionRegistryCatalog; readonly providerAdapters?: ProviderAdapterMap; readonly onProviderComposition?: (result: ProviderCompositionResult) => void | Promise; }
```
#### `ControlPlaneServerHandle`

```typescript
export interface ControlPlaneServerHandle { readonly port: number; readonly databasePath: string; close(): Promise; }
```
#### `ProviderCompositionDiagnosticLogger`

```typescript
export interface ProviderCompositionDiagnosticLogger { info(message: string): void; warn(message: string): void; }
```
### Notes

No public API-contract, OpenAPI, or SDK changes are proposed for round 2 because the spec allows registry diagnostics to remain internal to startup composition. The default registry should avoid real provider claims before concrete adapters exist; tests should inject fake catalog entries and fake adapter factories. To satisfy the operator diagnostics story in the production path, startControlPlaneServer must install a default onProviderComposition handler that calls `logProviderCompositionDiagnostics(result, console)` and emits a sanitized composition summary plus per-record composed/warning/unresolved diagnostics; that logging must not include bearer tokens, master secrets, plaintext secret values, provider settings payloads, or adapter object contents. Tests should cover logging through `logProviderCompositionDiagnostics` with an injected fake logger rather than by scraping process stdout. createControlPlaneServer exposes the structured callback seam for tests and startup diagnostics only; future runtime routing work that needs access to runnable bindings must add an explicit storage or injection path. Startup composition intentionally adds a startup-time configuration repository read: createControlPlaneServer should await repository.list(), pass the resulting array to composeConfiguredProviders before route registration, and continue startup when providers are unresolved. composeConfiguredProviders must be deterministic: iterate the provided configurationRecords array in order and preserve that order independently in composed, warnings, and unresolved arrays. Adapter factories may return either an adapter object or Promise of an adapter object; the composition root must normalize with Promise.resolve so both sync fake adapters and async real adapters compose consistently, and it must construct ProviderPortBinding identity from the configuration record rather than trusting factory output. ControlPlaneServerHandle remains the existing shape with port, databasePath, and close; this feature does not replace those fields with a FastifyInstance.
## Task list

### Story 1: Core registry catalog and advisory validation

Build the metadata-only registry surface in `packages/core` so provider metadata can be discovered and used for warnings without becoming a runtime gate.
#### Task 1.1: Add the extension registry module

- **Description:** Create `packages/core/src/extension-registry.ts` with the `ExtensionRegistryEntry` and `ExtensionRegistryCatalog` types from the Converged API.
- **Acceptance criteria:**
	- The module exports the agreed `ExtensionRegistryEntry` and `ExtensionRegistryCatalog` shapes.
	- `providerKind`, `adapterId`, `displayName`, `capabilities`, and optional `description` are represented exactly as agreed.
	- The module does not import adapter-map or provider-composition code.
- **Dependencies:** None.
#### Task 1.2: Implement the in-memory catalog and default catalog

- **Description:** Add `InMemoryExtensionRegistryCatalog`, `createExtensionRegistryCatalog`, and `defaultExtensionRegistryCatalog` to the registry module.
- **Acceptance criteria:**
	- `list()` returns the configured entries.
	- `findProvider(providerKind, adapterId)` returns only the matching metadata entry.
	- Duplicate `(providerKind, adapterId)` entries throw during catalog construction.
	- `createExtensionRegistryCatalog()` defaults to an empty catalog.
	- `defaultExtensionRegistryCatalog` does not claim real provider implementations exist before concrete adapters land.
- **Dependencies:** Task 1.1.
#### Task 1.3: Add advisory registry validation

- **Description:** Implement `ProviderConfigurationWarningCode`, `ProviderConfigurationWarning`, and `validateProviderConfigurationAgainstRegistry`.
- **Acceptance criteria:**
	- Provider-profile records with no matching registry entry return one `adapter_not_registered` warning.
	- Registered provider-profile records return no warning.
	- Non-provider-profile records return no registry warning.
	- The helper consults only the registry catalog and never consults adapter-map membership.
	- Warning messages include record id, provider kind, and adapter id, but no secrets or provider settings payloads.
- **Dependencies:** Task 1.2.
#### Task 1.4: Export and test the registry surface

- **Description:** Re-export the registry APIs from `packages/core/src/index.ts` and add focused tests for the registry module and entrypoint exports.
- **Acceptance criteria:**
	- `packages/core/src/index.ts` exports all Converged API registry names.
	- Tests cover empty catalog behavior, lookup, duplicate rejection, registered validation, unregistered validation, and the "warnings are metadata-only" rule.
	- Existing core entrypoint tests still pass.
- **Dependencies:** Tasks 1.2 and 1.3.
### Story 2: Provider adapter map and composition root

Compose persisted provider-profile records into runnable provider-kind bindings through explicit adapter factories, while preserving registry warnings and unresolved diagnostics as separate structured results.
#### Task 2.1: Add provider-composition types and adapter key helpers

- **Description:** Create `packages/core/src/provider-composition.ts` with the Converged API adapter factory, binding, unresolved, result, input, key-helper, and empty-map exports.
- **Acceptance criteria:**
	- The module exports `ProviderAdapterFactoryInput`, `ProviderPortBinding`, `ProviderAdapterFactory`, `ProviderAdapterMap`, `ProviderCompositionUnresolvedReason`, `ProviderCompositionUnresolved`, `ProviderCompositionResult`, `ComposeConfiguredProvidersInput`, `buildProviderAdapterKey`, and `emptyProviderAdapterMap`.
	- `buildProviderAdapterKey(providerKind, adapterId)` is the only key-construction helper used by composition code and tests.
	- `emptyProviderAdapterMap` is immutable from the public API perspective.
- **Dependencies:** Story 1 registry types may exist, but this task can be started after Task 1.1.
#### Task 2.2: Implement `composeConfiguredProviders`

- **Description:** Implement the startup composition function according to the Converged API behavior.
- **Acceptance criteria:**
	- The function filters the input array to records with `kind === 'provider_profile'`.
	- It calls `validateProviderConfigurationAgainstRegistry` for each provider-profile record.
	- It resolves factories only through `providerAdapters.get(buildProviderAdapterKey(providerKind, adapterId))`.
	- Registered-but-unmapped providers produce `adapter_not_found` unresolved diagnostics and no runnable binding.
	- Unregistered-but-mapped providers compose successfully and retain the advisory registry warning.
	- All factory throws and promise rejections are captured as `adapter_factory_failed` unresolved diagnostics.
	- Adapter factories may be synchronous or asynchronous and are normalized with `Promise.resolve`.
	- Factories return adapter objects only; composed `ProviderPortBinding` identity fields are constructed from the stored configuration record and cannot be overridden by factory output.
	- The function preserves input record order independently in `composed`, `warnings`, and `unresolved`.
	- Diagnostics do not include bearer tokens, master secrets, plaintext secret values, or provider settings payloads.
- **Dependencies:** Tasks 1.3 and 2.1.
#### Task 2.3: Export and test provider composition

- **Description:** Re-export provider-composition APIs from `packages/core/src/index.ts` and add focused composition tests.
- **Acceptance criteria:**
	- `packages/core/src/index.ts` exports all Converged API provider-composition names.
	- Tests cover registered-and-resolvable, unregistered-but-resolvable, registry-listed-but-unresolved, and absent-registry-plus-absent-code cases.
	- Tests prove warning generation comes from registry metadata and not from adapter-map membership.
	- Tests cover empty input, non-provider-profile records, synchronous factories, asynchronous factories, and factory failure diagnostics.
	- Existing core test suites continue to pass.
- **Dependencies:** Task 2.2.
### Story 3: Control-plane startup integration

Wire provider composition into server startup so persisted provider profiles are composed once during startup and the result is observable without changing the public configuration API.
#### Task 3.1: Extend server startup options with provider composition inputs

- **Description:** Update `apps/control-plane/src/server.ts` so `ControlPlaneServerOptions` accepts optional `extensionRegistry`, `providerAdapters`, and `onProviderComposition`.
- **Acceptance criteria:**
	- The option names and types match the Converged API.
	- Defaults are `defaultExtensionRegistryCatalog` and `emptyProviderAdapterMap`.
	- Existing server callers compile without passing the new options.
	- `ControlPlaneServerHandle` remains unchanged.
- **Dependencies:** Story 2 exported core APIs.
#### Task 3.2: Invoke composition during `createControlPlaneServer`

- **Description:** Read existing configuration records after repository setup and invoke `composeConfiguredProviders` before route registration completes.
- **Acceptance criteria:**
	- Startup awaits `repository.list()` and passes the resulting array to `composeConfiguredProviders`.
	- Startup does not pass the repository object into `composeConfiguredProviders`.
	- `onProviderComposition` is awaited when provided.
	- Unresolved providers alone do not reject startup.
	- Existing auth, health, policy, routes, migrations, and secret-store startup behavior remain intact.
- **Dependencies:** Task 3.1.
#### Task 3.3: Add sanitized production startup diagnostics

- **Description:** Update `startControlPlaneServer` to install a default composition-result handler that logs sanitized diagnostics for production startup.
- **Acceptance criteria:**
	- Logs include a summary count for composed bindings, warnings, and unresolved providers.
	- Per-record diagnostics identify configuration record id, provider kind, adapter id, warning code, and unresolved reason where applicable.
	- Logs do not include bearer tokens, master secrets, plaintext secret values, or provider settings payloads.
	- `logProviderCompositionDiagnostics` accepts an injected `ProviderCompositionDiagnosticLogger`, defaults to `console`, uses `info` for summary/composed diagnostics and `warn` for warning/unresolved diagnostics, and is the only helper used by `startControlPlaneServer` for provider-composition startup logging.
	- Tests or targeted assertions cover the logging behavior through an injected logger without scraping stdout and without making log text a public route/API contract.
- **Dependencies:** Task 3.2.
#### Task 3.4: Add control-plane integration tests for startup composition

- **Description:** Add or extend control-plane tests that seed temporary SQLite configuration records, inject fake registry and adapter map entries, start the server, and inspect the structured composition callback result.
- **Acceptance criteria:**
	- Tests prove startup composes a registered-and-resolvable fake provider.
	- Tests prove startup composes an unregistered-but-resolvable fake provider while reporting the advisory warning.
	- Tests prove startup reports registry-listed-but-unresolved providers without creating a runnable binding.
	- Tests prove startup with no provider records returns empty composition arrays.
	- Regression tests confirm `GET /health` remains public and protected `/v1` routes still require auth after the composition wiring is added.
- **Dependencies:** Task 3.2.
### Story 4: Documentation and validation

Keep implementation-facing documentation accurate and run targeted validation before handoff.
#### Task 4.1: Update the agent code map

- **Description:** Update `context-agent/wiki/code-map.md` with the new registry, composition root, startup wiring, and test seam locations.
- **Acceptance criteria:**
	- The code map lists `packages/core/src/extension-registry.ts`.
	- The code map lists `packages/core/src/provider-composition.ts`.
	- The code map describes the server startup composition wiring in `apps/control-plane/src/server.ts`.
	- The code map notes how tests inspect provider-composition results.
- **Dependencies:** Stories 1 through 3.
#### Task 4.2: Run targeted and broad validation

- **Description:** Run the project checks needed to prove the feature is safe and document any checks that cannot be run.
- **Acceptance criteria:**
	- Targeted core tests for registry and provider composition pass.
	- Targeted control-plane tests for startup composition pass.
	- Existing package tests touched by the feature pass.
	- The repository validation command, `pnpm validate`, passes or any failure is documented with the exact command, failure, and suspected cause.
- **Dependencies:** Task 4.1.