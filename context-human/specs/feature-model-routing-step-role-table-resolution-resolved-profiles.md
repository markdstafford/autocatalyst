---
created: 2026-06-10
last_updated: 2026-06-10
status: implementing
issue: 29
specced_by: autocatalyst
---
# Feature: Model routing table, role-aware resolution, and resolved profiles

## Product requirements

### What

Add the model-routing layer that turns a unit of work into the self-contained provider profile used by the runner dispatch path. Agent work resolves by `(step, role)`. Bounded direct calls resolve by `(step)`. Resolution is specificity-ordered, with a route-specific entry first, a step-level default second, and a typed configuration miss when neither exists.
The routing table is service-owned configuration data stored in the database, managed through the API, and validated by shared schemas. It must carry routes for all four runner cells already present in the codebase: Claude agent, OpenAI agent, Anthropic direct, and OpenAI direct. The resolved profile must be the one dispatch consumes, not a test-only or parallel profile shape.
The feature also adds role-distinct resolution. A workflow or caller can require a step's roles to use distinct models. When configuration can satisfy that requirement, `implementer` and `reviewer` for the same step resolve to different profiles and can dispatch to different agent cells, for example Claude agent and OpenAI agent. When configuration cannot satisfy the requirement, routing returns a typed can't-satisfy signal rather than silently collapsing both roles onto one model.
### Why

The runner layer now has the cells needed to run agent and direct work across Anthropic and OpenAI. Dispatch still depends on explicit profile construction, which prevents the workflow from choosing models by step and role as data. Model routing is the configuration boundary between workflows and runner cells: it lets operators decide which model serves each step and role without adding provider-specific branches to orchestrators or control-plane lifecycle code.
Role-aware routing is also the substrate for convergence review. Review can only compare independent model judgment if the same step can run an `implementer` and `reviewer` on distinct resolved profiles. This issue does not implement the convergence loop, but it must provide the route resolution and typed failure modes that loop will depend on.
### Goals

- Store a per-tenant model-routing table as service-owned configuration data in the database, with tenant ownership enforced by the configuration-record storage and repository/API contract.
- Expose routing-table read and write through the existing configuration API surface and shared Zod schemas.
- Support agent routes keyed by `(step, role)` and bounded direct routes keyed by `(step)`.
- Preserve roles as data-defined snake_case identifiers compatible with the existing `SessionRole` shape.
- Resolve routes with explicit specificity: exact `(step, role)` first, step-level default second, typed miss third.
- Assemble a self-contained resolved profile with model, explicit inference settings, endpoint settings, credential reference, runner kind, mode, adapter id, and connection mechanism.
- Dispatch the resolved profile through the existing provider-and-mode lookup paths for both agent and direct cells.
- Keep provider-specific behavior in adapters and existing dispatch factories, not in the resolver.
- Validate routing configuration before a session starts, including route references, endpoint references, credential references, mode compatibility, and distinct-role requirements.
- Surface typed signals for a genuine route miss and for an unsatisfiable role-distinct requirement.
- Prove end-to-end behavior with mocked backends through the production dispatch seams, including both agent providers and at least one direct provider.
- Update `context-agent/wiki/code-map.md` during implementation to record the routing table, resolver, resolved-profile type, and production dispatch wiring.
### Non-goals

- Per-run or per-user override layers over the base routing table.
- The desktop or in-application routing-management surface.
- Assigning review roles, running convergence rounds, or deciding how a workflow degrades after a can't-satisfy signal.
- Cost accounting, durable session-grain telemetry archive, or model-rate-table implementation beyond preserving the resolved profile metadata that those systems consume.
- Route-to-skill mapping, runtime skill materialization changes, or tool-policy routing.
- New provider cells or new model SDK integrations.
- Branch creation, worktree management, push, merge, or PR opening.
### Personas

- **Enzo (Engineer)** needs one resolver and one profile contract that work for all runner cells without provider-specific branches in core orchestration.
- **Opal (Operator)** needs model and endpoint selection to be configuration data that validates before a run starts and fails safely when misconfigured.
- **Phoebe (PM)** needs proof that a reviewer and implementer can run on different model providers for the same step before convergence review is built on top.
- **Dani (Designer)** is not directly affected by this backend feature, but future progress and review surfaces depend on stable role and model attribution.
### User stories

- As Enzo, I can add a route for `implementation.author` and `implementer` that resolves to the Claude agent cell without changing the agent orchestrator.
- As Enzo, I can add a route for the same step and `reviewer` that resolves to the OpenAI agent cell through the same factory path.
- As Enzo, I can add a direct route for an intake or classification step that resolves by step only and dispatches to an Anthropic or OpenAI direct cell.
- As Opal, I can write routing configuration through the API and receive validation errors for missing profiles, invalid roles, mode mismatches, unknown credentials, or unsupported adapter references.
- As Opal, I can rely on a genuine route miss returning a typed configuration error instead of falling back to an arbitrary default model.
- As Phoebe, I can see integration coverage where an implementer and reviewer for the same step resolve to different providers and both dispatch through existing runner cells.
- As Phoebe, I can see integration coverage where a role-distinct requirement fails safely when only one usable model is configured for the step.
### Acceptance criteria

#### Routing configuration

- A per-tenant routing table maps routes to provider-profile records and is stored as service-owned database configuration.
- Provider-profile and model-routing-table configuration records carry the owning tenant/owner id in storage, API responses, and repository calls. Routing must only resolve profile ids owned by the same tenant as the active routing table.
- Exactly one active model-routing-table record is allowed per tenant. A tenant with no active table returns `routing_table_missing`; a tenant with more than one active table returns a typed ambiguous-table configuration error instead of selecting by creation time or array order.
- The routing table is read and written through the API using shared schemas from `packages/api-contract`.
- Agent routing entries use `mode: 'agent'`, `step`, and either `role` or a step-level default marker.
- Direct routing entries use `mode: 'direct'` and `step` only. Direct routes do not accept or require a role.
- Roles validate with the existing snake_case `SessionRole` convention.
- Routing entries reference configured provider profiles by id. A missing referenced profile is a validation failure.
- Provider profiles used by routing must carry explicit model and inference-settings data. The resolver must not silently inherit model or inference defaults from an unrelated profile.
- Route writes validate that the referenced profile's mode and adapter are compatible with the route mode.
#### Resolved profile contract

- Resolving a route produces a self-contained profile containing model, explicit inference settings, endpoint settings, credential reference, runner kind, mode, adapter id, provider kind, profile id/name, and connection mechanism.
- The resolved profile shape is the dispatch input for agent and direct factories. It must not be a parallel test-only type.
- The provider is derived from the selected runner kind and configured adapter identity, then validated against the profile's model provider and endpoint data.
- Credential references stay connection-factory-only. Resolved profiles exposed to adapters and logs do not contain secret values.
- Endpoint and credential cross-references validate before any provider session or direct call starts.
#### Specificity and errors

- Agent resolution first checks an exact `(step, role)` entry.
- If no exact agent entry exists, resolution falls back to a step-level agent default for that step.
- If neither exact nor default route exists, resolution returns a typed route-miss error at the configuration boundary.
- Direct resolution checks the direct `(step)` route and returns a typed route-miss error when missing.
- Route misses, invalid profile references, adapter misses, credential misses, and mode mismatches use typed sanitized errors. They do not throw untyped errors with raw configuration or secret contents.
#### Dispatch across all cells

- The routing table can carry routes to the Claude agent cell, OpenAI agent cell, Anthropic direct cell, and OpenAI direct cell.
- Agent routes dispatch through the existing agent adapter registry and `createAgentRunnerFactory`-style provider-and-adapter lookup.
- Direct routes dispatch through the existing direct adapter registry and `createDirectCallFactory`-style provider-and-adapter lookup.
- Resolution does not special-case Claude, OpenAI, Anthropic, agent mode, or direct mode beyond mode-specific route-key validation.
- The production dispatch path takes the resolved profile from routing. Explicitly constructed profiles remain only for tests or compatibility seams that intentionally bypass routing.
#### Role-distinct selection

- A caller or workflow can request that a step's roles resolve to distinct models.
- Distinctness compares the resolved model/provider identity, and may also treat the same provider/model through the same profile id as not distinct.
- When distinct profiles exist, resolving `implementer` and `reviewer` for the same step can return different providers, for example Claude agent for `implementer` and OpenAI agent for `reviewer`.
- When configuration cannot satisfy the distinct-role requirement, routing returns a typed can't-satisfy signal with safe details about the step and roles.
- The resolver does not silently use a step-level default for a role when that fallback violates an active distinct-role requirement.
#### Integration coverage

- Integration coverage uses mocked backends or injected adapter seams and requires no live Anthropic or OpenAI credentials.
- A test writes routing and provider-profile configuration through the service-owned configuration path, then resolves and dispatches an agent `(step, role)` through the production path.
- A test proves a role with no exact entry falls back to the step-level default.
- A test proves a genuine route miss returns the typed route-miss error.
- A test proves a step configured with distinct `implementer` and `reviewer` profiles dispatches `implementer` to the Claude agent cell and `reviewer` to the OpenAI agent cell through the existing event consumer.
- A test proves a bounded direct `(step)` route resolves to and dispatches through an Anthropic or OpenAI direct cell.
- A test proves an unsatisfiable role-distinct requirement returns the typed can't-satisfy signal.
- The routing resolver is invoked in the production dispatch path, not only in isolated unit tests.
### References

- Issue: [https://github.com/markdstafford/autocatalyst/issues/29](https://github.com/markdstafford/autocatalyst/issues/29)
- `context-human/spec.md`
- `context-human/concepts/model-routing.md`
- `context-human/concepts/agent-runners.md`
- `context-human/concepts/settings.md`
- `context-human/concepts/api.md`
- `context-human/adrs/adr-024-role-aware-routing-key.md`
- `context-human/adrs/adr-008-config-model.md`
- `context-human/adrs/adr-007-shared-types.md`
- `context-agent/standards/api-conventions.md`
- `context-agent/standards/logging.md`
- `context-agent/standards/telemetry-conventions.md`
- Prior spec: `context-human/specs/feature-runner-connection-layer-claude-agent-adapter.md`
- Prior spec: `context-human/specs/feature-direct-orchestrator-anthropic-openai-direct-adapters.md`
- Prior spec: `context-human/specs/feature-openai-agent-runner-cell.md`
## Design spec

### Design scope

This is a backend control-plane and execution-dispatch feature. It does not add screens, visual components, or user-facing copy. The design work is the configuration model, resolver behavior, dispatch integration, and safe operator/developer feedback when routing is missing or invalid.
The product promise is that model selection becomes data. A route changes which profile is selected; it does not change the orchestrator, event consumer, direct-call port, or provider adapter code.
### Operator experience

An operator configures provider profiles for the four available cells and a routing table that points steps and roles at those profiles. The API should reject invalid configuration on write when possible: invalid role strings, duplicate routes, agent routes without profile references, direct routes with roles, mode mismatches, unknown profile ids, and role-distinct requirements that name unusable roles.
Before a run starts provider work, the system validates the effective routing table against configured provider profiles, endpoints, credentials, and registered adapters. A missing route should identify the missing step and role, not say a generic provider failed. A missing credential should identify credential resolution, not become a mid-session provider error. A role-distinct failure should identify the step and roles that cannot be made distinct without revealing prompts, secrets, or provider transcripts.
Safe diagnostics may include route id, step, role, mode, provider kind, adapter id, profile id/name, model identity, and sanitized error code. They must not include credential values, raw request bodies, full provider responses, prompt text, workspace file contents, or transcripts.
### Developer experience

A developer should find the model-routing feature in three seams:
1. **Routing contract schemas** in `packages/api-contract`, describing route keys, routing-table settings, distinct-role requirements, resolved-profile metadata, and typed error codes.
2. **Routing resolver** in control-plane/core code, reading service-owned configuration and returning existing execution dispatch profile types.
3. **Dispatch composition** in the control-plane service, replacing the current explicit default-profile resolver with routing-aware agent and direct resolvers.
The resolver should not know provider SDK names, event names, or request shapes. It chooses a profile and validates that the selected adapter/mode can consume it. Existing factories remain responsible for adapter lookup, connection creation, session orchestration, event streaming, and direct-call validation.
### Configuration authoring flow

The initial authoring flow uses the existing configuration-record API rather than a new bespoke routing endpoint:
1. Create provider-profile records for each usable runner cell.
2. Create or update one active model-routing-table record for the same tenant.
3. The routing-table record references provider-profile record ids owned by that tenant.
4. The API validates the table shape and references before persisting.
5. Service startup and dispatch composition validate effective routing against registered adapters and credentials before provider work starts.
Using configuration records keeps the surface aligned with ADR-008. The underlying `configuration_records` table stores generic `kind` and `settings_json`, so adding a new `model_routing_table` kind should not require a dedicated routing table. It does require tenant ownership on generic configuration records. Implement this slice with a schema migration that adds a non-null tenant/owner column to `configuration_records` and updates repository methods, API request/response types, and lookup helpers to scope every configuration-record operation by tenant. If implementation later moves routing into dedicated tables for stronger relational constraints, it must keep the API and route-resolution contract unchanged.
### Tenant ownership and active table selection

Configuration-record tenancy is part of this feature, not deferred work:
- Every persisted configuration record has exactly one owning tenant/owner id.
- Create/list/find/update/delete repository methods receive tenant explicitly and only read or mutate records for that tenant.
- API handlers derive tenant from the authenticated/control-plane context or validated request envelope, never from an untrusted route id alone. Responses include the owning tenant only when that is already allowed by the configuration-record API envelope.
- Provider-profile references in routing entries are tenant-local. A route that references a profile id owned by a different tenant behaves the same as a missing profile and returns `profile_not_found` with safe details.
- The model-routing-table settings include an `active` flag. Exactly one `model_routing_table` record with `active: true` is allowed per tenant for production routing.
- Write-time validation and repository transactions must reject a create or update that would leave multiple active routing tables for one tenant. If legacy/corrupt data still produces multiple active tables, resolver loading fails with `routing_table_ambiguous`.
- Records with `active: false` may exist as drafts or disabled operator edits, but the resolver never uses them unless a future feature adds an explicit table-id override.
### Route key design

Agent and direct routes use different key shapes because they select different work:
```typescript
type ModelRouteKey =
  | { mode: 'agent'; step: string; role: SessionRole }
  | { mode: 'agent'; step: string; defaultForStep: true }
  | { mode: 'direct'; step: string };
```
Agent routes are role-aware. The exact route has a role. The step-level default is agent-mode only and is explicit, not represented by a fake role. Direct routes have no role because bounded direct calls are not role sessions.
Route entries point to provider-profile configuration records:
```typescript
interface ModelRoutingEntry {
  readonly id: string;
  readonly route: ModelRouteKey;
  readonly profileId: string;
  readonly enabled?: boolean;
}
```
The table rejects duplicate enabled entries for the same route key. Disabled entries can remain for operator editing if the schema includes `enabled`; disabled entries are ignored by resolution and cannot be the only entry satisfying a required route.
### Role-distinct design

Role-distinct requirements live with the routing table because they constrain route resolution rather than provider sessions:
```typescript
interface RoleDistinctRequirement {
  readonly step: string;
  readonly mode: 'agent';
  readonly roles: readonly SessionRole[];
  readonly distinctBy: 'model' | 'profile';
}
```
`distinctBy: 'model'` compares provider and model identity. `distinctBy: 'profile'` compares provider-profile record id. The initial default should be model-level distinctness because the product goal is different model judgment; profile-level distinctness remains useful when the same model through two endpoints should count as separate operational capacity. If only one is implemented, use model-level distinctness and keep profile-level as a schema extension later.
When resolving a group under a distinct requirement, the resolver resolves each role through normal specificity. It then checks the resulting distinctness set. If the set is smaller than the required role count, it returns `role_distinct_unsatisfied` with safe details: step, roles, distinctBy, and the non-secret profile/model summaries that collided.
When a routing-table-defined `RoleDistinctRequirement` exists for a step, production pre-dispatch/session-start validation must call group resolution for the requirement's role set before dispatching any affected role. Single-role `resolveAgentRoute` remains valid only for ordinary agent work whose step has no matching active table-defined distinct requirement, or after the production caller has already completed group validation for the affected step in the same pre-dispatch flow.
### Resolution flow

Agent resolution follows this sequence:
1. Validate `step` and `role` inputs.
2. Load the tenant's active routing table.
3. Find an enabled exact route for `{ mode: 'agent', step, role }`.
4. If none exists, find an enabled default route for `{ mode: 'agent', step, defaultForStep: true }`.
5. If no route exists, return `route_not_found`.
6. Load the referenced provider-profile record.
7. Validate profile shape, model, explicit inference settings, endpoint settings, credential reference, adapter registration, and mode compatibility.
8. Assemble the resolved profile and credential reference.
9. If the caller requested role-distinct resolution, resolve the requested role group and apply distinctness validation before dispatch.
10. If the active table defines a `RoleDistinctRequirement` for this step and the production pre-dispatch flow has not already validated that role group, return a typed routing/configuration error directing the caller to group validation rather than silently dispatching one role and ignoring the table requirement.
Direct resolution follows this sequence:
1. Validate `step` input and reject any role input.
2. Load the tenant's active routing table.
3. Find an enabled route for `{ mode: 'direct', step }`.
4. If no route exists, return `route_not_found`.
5. Load and validate the referenced provider-profile record for direct mode.
6. Assemble the resolved profile and credential reference.
The resolver should be deterministic. If configuration has duplicate enabled entries for the same key despite write validation, startup validation or resolution should return a typed `duplicate_route` configuration error rather than picking one by array order.
### Dispatch flow

The production dispatch path should use routing instead of the current single `defaultProviderProfileId` behavior:
1. Core builds `RunWorkInput` with run id, tenant, current step, phase if available, and role when the caller is running an agent role.
2. Before dispatching agent work for a step with a routing-table-defined `RoleDistinctRequirement`, the production pre-dispatch/session-start flow calls `resolveDistinctAgentRoutes` for the requirement's role set and caches or passes the resulting role-specific resolutions for the affected dispatches.
3. Agent work without a table-defined distinct requirement asks the routing resolver for an agent profile using `(step, role)`.
4. Direct work asks the routing resolver for a direct profile using `(step)`.
5. The resolver returns the existing `ResolvedAgentRunnerProfile` plus `ResolvedAgentCredentialReference` or equivalent exported profile resolution type.
6. `createAgentRunnerFactory` and `createDirectCallFactory` keep their provider-and-adapter lookup responsibilities.
7. The connection layer resolves credentials and endpoint behavior from the resolved profile.
8. The selected agent or direct orchestrator dispatches through the existing cell.
This design keeps model routing out of provider adapters. Adapters only see the same profile, connection, and telemetry context they already consume.
### Error and signal design

Routing errors should be typed, sanitized, and close to the configuration boundary. Expected codes include:
- `routing_table_missing` — no active routing table exists for the tenant.
- `routing_table_ambiguous` — more than one active routing table exists for the tenant.
- `route_not_found` — no exact or default route exists for the requested route.
- `duplicate_route` — more than one enabled entry matches the same route key.
- `profile_not_found` — a route references a missing provider-profile record.
- `profile_incomplete` — a referenced profile lacks required model, inference settings, endpoint, or credential-reference shape.
- `route_mode_mismatch` — a route points at a profile/adapter that cannot serve that mode.
- `adapter_unavailable` — no registered adapter exists for the profile's provider and adapter id.
- `credential_reference_invalid` — endpoint/profile credential reference cannot be resolved before session start.
- `role_distinct_unsatisfied` — resolved roles do not meet a distinct-model requirement.
These may be represented by a new `ModelRoutingConfigurationError` in core or execution-adjacent code, then mapped into existing `ProviderConfigurationError` codes at dispatch if keeping public execution error types smaller is preferable. The important contract is typed code plus safe details, not the class name.
### Validation behavior

Validation has two layers:
- **Write-time schema validation** checks route-key shape, role format, duplicate keys inside the submitted table, and references to provider-profile ids visible to the tenant when the repository/API has access to those records.
- **Tenant and active-table validation** checks that all referenced provider profiles are owned by the same tenant as the routing table and that a write cannot create multiple active routing tables for that tenant.
- **Effective dispatch validation** checks registered adapters, connection mechanisms, credential references, and profile completeness. This runs before a session or direct call starts.
Provider-profile records currently allow optional `model`, `inferenceSettings`, and `endpoint`. Routing should treat these as required for a routable profile even if the base provider-profile API keeps them optional for compatibility. A route that points at a profile without explicit inference settings should fail validation rather than inherit `{}` silently, unless the profile itself explicitly stores `{}` as its chosen settings.
### Observability and attribution

The resolved profile should preserve the data needed for existing and future telemetry: run id, phase, step, role for agent work, no role for direct work, profile id/name, provider kind, adapter id, model identity, inference settings, endpoint id or endpoint summary, and mode. The resolver should not emit durable cost records. It should supply the profile metadata that runner telemetry and later cost accounting can use.
Logs should distinguish route resolution from provider execution. A route-resolution log can say which profile id was selected for a step and role. Provider execution logs remain owned by connection and runner code.
## Tech spec

### Current state

The codebase already has the pieces model routing should compose:
- `packages/api-contract/src/configuration-record.ts` defines a configuration-record API with a single current kind, `provider_profile`, plus provider profile settings for model, inference settings, endpoint settings, and credential secret handle.
- `packages/api-contract/src/domain-value-objects.ts` defines `SessionRole`, `ModelIdentity`, and `InferenceSettings` schemas.
- `packages/execution/src/agent-provider-adapter.ts` defines `ResolvedAgentRunnerProfile`, `ResolvedAgentCredentialReference`, runner profile mode, and provider connection mechanisms.
- `packages/execution/src/runner-dispatch.ts` resolves an agent profile through an injected seam, then looks up the adapter by provider kind and adapter id.
- `packages/execution/src/direct-runner-dispatch.ts` does the equivalent for direct calls.
- `apps/control-plane/src/server.ts` currently composes all four cells when real dispatch is enabled, but still resolves profiles through an explicit default-provider-profile id.
- `packages/core/src/execution-run-unit-of-work.ts` already has a direct execution port and execution-mode seam.
The implementation should preserve those seams and replace explicit default-profile resolution with routing-aware resolution.
### API contract changes

Extend `packages/api-contract/src/configuration-record.ts` so configuration records can represent routing tables:
- Change `configurationRecordKindSchema` from `z.literal('provider_profile')` to an enum or union that includes `provider_profile` and `model_routing_table`.
- Add the tenant/owner field required by the service-owned configuration-record contract. Create requests carry or are enriched with the owning tenant from the trusted API envelope; responses and repository-facing types include `tenant` so callers cannot accidentally perform tenantless lookups.
- Split settings schemas by kind if needed so provider-profile settings remain validated as today and routing-table settings get their own shape.
- Add route-key schemas:
	- `agentModelRouteKeySchema` with `mode: 'agent'`, `step`, and either `role` or `defaultForStep: true`.
	- `directModelRouteKeySchema` with `mode: 'direct'` and `step` only.
	- role fields reuse `sessionRoleSchema`.
- Add `modelRoutingEntrySchema` with stable `id`, route key, `profileId`, and optional enabled flag.
- Add `roleDistinctRequirementSchema` for step, agent mode, role list, and distinctness policy.
- Add `modelRoutingTableSettingsSchema` containing active flag, table name/version if useful, entries, and role-distinct requirements.
- Export inferred types for entries, route keys, table settings, role-distinct requirements, and routing error codes if represented at the contract layer.
Keep JSON casing aligned with existing API conventions: camelCase field names and snake_case enum values only where the field is an enum literal.
### Persistence changes

The existing `configuration_records` table can store the new kind in its `kind` text column and settings in `settings_json`, but it must gain tenant ownership for safe routing. Add a schema migration for a non-null tenant/owner column on `configuration_records`, backfill existing development records to the configured default/development tenant, and add an index supporting `(tenant, kind)` lookup. If the repository currently casts all settings as provider-profile settings, update `packages/persistence/src/configuration-record-repository.ts` row mapping to parse and validate by `kind` through the shared configuration-record response schema or a helper schema.
No dedicated routing SQL table is required if implementation keeps the generic configuration-record storage. The repository must still enforce tenant-scoped create/list/find/update behavior and reject writes that would leave more than one active `model_routing_table` for a tenant. If a dedicated routing table is introduced for stronger uniqueness later, it must keep the API contract unchanged and include repository tests.
### Routing-table PATCH semantics

PATCH behavior for `model_routing_table` settings is intentionally simple and deterministic:
- Omitted fields are unchanged.
- `active: true` activates the table only if no other table for the same tenant is active, or in the same repository transaction after deactivating the previous active table through an explicit update path. `active: false` deactivates the table. `active: null` is invalid because active state is not nullable.
- `tableName` with a string sets/replaces the table name; `tableName: null` clears the optional table name; omission preserves the current value.
- `version` with a number sets/replaces the version; `version: null` clears the optional version; omission preserves the current value.
- `entries` is a whole-array replacement when present. The submitted array becomes the complete entry set after validation; omitted entries are deleted, disabled entries are preserved only if they are included in the submitted array, and an empty array clears all entries. `entries: null` is invalid.
- `roleDistinctRequirements` is a whole-array replacement when present. A submitted array becomes the complete requirement set; an empty array clears all requirements; `roleDistinctRequirements: null` clears the optional field to absent; omission preserves the current value.
- Array elements are not merged by id in PATCH. Add/update/delete are represented by submitting the complete desired array for that field.
### Core routing resolver

Add a routing resolver module in core or a small control-plane-owned module. The resolver should depend on repository interfaces and adapter registries, not on provider packages.
Expected public shapes:
```typescript
interface ModelRoutingResolverInput {
  readonly tenant: string;
  readonly step: string;
  readonly role?: SessionRole;
  readonly mode: 'agent' | 'direct';
  readonly requireDistinctRoles?: readonly SessionRole[];
}

interface ModelRoutingResolution {
  readonly profile: ResolvedAgentRunnerProfile;
  readonly credentialReference: ResolvedAgentCredentialReference;
  readonly routeId: string;
  readonly profileId: string;
}
```
The resolver can expose separate methods for agent and direct resolution if that keeps invalid inputs unrepresentable:
```typescript
resolveAgentRoute({ tenant, runId, step, role, distinctRoles? })
resolveDirectRoute({ tenant, runId, step })
```
The resolver must:
- load the active routing table for the tenant;
- return `routing_table_missing` when zero active tables exist and `routing_table_ambiguous` when multiple active tables exist for the tenant;
- apply exact/default specificity rules;
- load referenced provider-profile records;
- validate model, explicit inference settings, endpoint settings, credential reference, adapter availability, mode, and connection mechanism;
- derive `ResolvedAgentRunnerProfile.connectionMechanism` from the selected adapter;
- derive `ResolvedAgentCredentialReference.authTarget` from the connection mechanism for agent profiles and from direct connection behavior for direct profiles;
- return typed sanitized errors for invalid or missing configuration.
### Resolved profile compatibility

Keep `ResolvedAgentRunnerProfile` as the dispatch profile shape unless implementation proves it needs a rename. The type already carries mode, provider kind, adapter id, profile name, configuration record id, model, inference settings, endpoint, and connection mechanism.
The routing resolver should tighten its construction rules:
- `model` must come from the referenced provider-profile record.
- `inferenceSettings` must come from the referenced provider-profile record, including an explicit empty object when the operator chooses provider defaults.
- `endpoint` must come from the referenced provider-profile record, even if it is an explicit empty endpoint object.
- `configurationRecordId` should be the provider-profile record id, not the routing-table record id.
- Safe route metadata such as `routeId` can be returned alongside the profile, not embedded into adapter-visible profile data unless telemetry needs it.
If `runnerKind` is introduced as a new field, keep it additive or derived so existing adapter factories do not need broad rewrites. The runner kind can be represented as `{ mode, providerKind, adapterId }` over the existing fields.
### Control-plane composition

Replace the current `createExplicitProfileResolver` usage in `apps/control-plane/src/server.ts` for real dispatch with a routing-aware resolver:
- Compose agent and direct adapter registries as today.
- Build a model-routing resolver from `configurationRecords.list()` plus those registries.
- Pass `resolveAgentRoute` to `createAgentRunnerFactory`.
- Pass `resolveDirectRoute` to `createDirectCallFactory`.
- Preserve `realRunnerDispatch.defaultProviderProfileId` only as a compatibility fallback if the implementation chooses to keep explicit-profile mode for tests or local development. Production real dispatch for this issue should use routing when a routing table exists.
The agent factory input currently carries `runId`, `phase`, `step`, and optional `role`. Ensure the production caller supplies role for agent role sessions. If the current entry point does not yet know role, add a small injected role selector or default role resolver for this slice, then keep that seam ready for the later convergence loop. The resolver must still support arbitrary snake_case roles even if tests use only `implementer` and `reviewer`.
### Direct-call integration

Direct routing resolves only by `step`. `createDirectCallFactory` already accepts `runId`, tenant optionally, phase optionally, step, and direct-call request. Ensure tenant is passed through from `DirectStepWorkInput` to route resolution so routing tables are scoped correctly.
The direct resolver should reject any route whose referenced adapter is not in the direct registry or whose resolved profile mode is not `direct`. It should not reuse the agent registry as a proxy for direct capability.
### Role-distinct API

Add a resolver method or option that resolves a role group for one step and validates distinctness before dispatch. A simple shape is enough:
```typescript
resolveDistinctAgentRoutes({ tenant, runId, step, roles, distinctBy })
```
It should return a map from role to routing resolution when satisfied. When unsatisfied, return or throw a typed `role_distinct_unsatisfied` error. The production dispatch path may call single-role resolution for ordinary sessions only when the active table has no matching `RoleDistinctRequirement` for the step, or after that requirement has already been validated through group resolution in the pre-dispatch/session-start path. Integration tests for this issue should call the group resolver or the workflow seam that uses it to prove distinctness behavior before the convergence loop exists.
### Error mapping

Implement typed errors in the layer that owns routing, then map them carefully at boundaries:
- API writes return validation errors using the existing API error envelope.
- Service startup or dispatch composition failures use configuration errors with safe details.
- Agent dispatch can map routing failures to `ProviderConfigurationError` only if the original routing code remains available to callers/tests.
- Direct dispatch failures should continue to map to sanitized `RunWorkResult` failure reasons like `Execution failed: ` when they occur inside `ExecutionRunUnitOfWork`.
Do not include raw `settings_json`, credential values, secret handles paired with resolved secret text, request bodies, prompts, provider responses, or transcripts in thrown error messages.
### Tests

Add focused schema and resolver tests first, then integration coverage through production seams:
- API-contract tests for valid and invalid routing-table records, role shape, direct route shape, duplicate keys if validation is local to schema, and discriminated settings by kind.
- Persistence tests proving `model_routing_table` records round-trip and provider-profile records still round-trip.
- Core resolver tests for exact match, step default fallback, direct match, typed miss, duplicate route, missing profile, mode mismatch, adapter unavailable, missing credential reference, and role-distinct unsatisfied.
- Control-plane integration tests that write provider-profile and routing-table records, enable real dispatch with mocked cells, and prove the resolver is used in the production dispatch path.
- End-to-end mocked dispatch test for Claude implementer and OpenAI reviewer on one step, with events passing through the existing event consumer.
- Direct dispatch integration for a direct `(step)` route resolving to Anthropic or OpenAI direct and returning a validated direct result.
Tests must not require live provider credentials or network calls.
### Documentation updates

During implementation, update `context-agent/wiki/code-map.md` to record:
- the routing-table contract schemas;
- the model-routing resolver module;
- the resolved-profile construction rules;
- the control-plane composition path that wires routing into agent and direct dispatch;
- targeted test commands for routing coverage.
Human-owned concept docs already describe the model-routing contract and do not need to change unless implementation discovers a substantive decision conflict.
## Converged API

### Files

Path
Purpose
Exports

`packages/api-contract/src/configuration-record.ts`
Extend the shared configuration-record contract so records can be either tenant-owned provider profiles or tenant-owned model routing tables; split provider-profile settings from the kind-tagged settings union; add route-key, routing-entry, role-distinct, routing-table settings with active flag, routing-table patch settings, and typed routing error-code schemas; update create/update/response schemas so the parent kind field selects the matching settings schema branch.
`configurationRecordKindSchema`, `providerProfileSettingsSchema`, `configurationRecordSettingsSchema`, `createConfigurationRecordRequestSchema`, `updateConfigurationRecordRequestSchema`, `configurationRecordResponseSchema`, `agentModelRouteKeySchema`, `directModelRouteKeySchema`, `modelRouteKeySchema`, `modelRoutingEntrySchema`, `roleDistinctRequirementSchema`, `modelRoutingTableSettingsSchema`, `updateModelRoutingTableSettingsSchema`, `modelRoutingErrorCodeSchema`, `ConfigurationRecordKind`, `ProviderProfileSettings`, `ConfigurationRecordSettings`, `CreateConfigurationRecordRequest`, `UpdateConfigurationRecordRequest`, `ConfigurationRecord`, `AgentModelRouteKey`, `DirectModelRouteKey`, `ModelRouteKey`, `ModelRoutingEntry`, `RoleDistinctRequirement`, `ModelRoutingTableSettings`, `UpdateModelRoutingTableSettings`, `ModelRoutingErrorCode`

`packages/api-contract/src/index.ts`
Re-export the provider-profile-specific settings schema and ProviderProfileSettings type, the routing schemas, patch schemas, kind-tagged configuration-record request/response schemas, and inferred types from the package root for API server, SDK, persistence, and tests.
`providerProfileSettingsSchema`, `ProviderProfileSettings`, `agentModelRouteKeySchema`, `directModelRouteKeySchema`, `modelRouteKeySchema`, `modelRoutingEntrySchema`, `roleDistinctRequirementSchema`, `modelRoutingTableSettingsSchema`, `updateModelRoutingTableSettingsSchema`, `modelRoutingErrorCodeSchema`, `AgentModelRouteKey`, `DirectModelRouteKey`, `ModelRouteKey`, `ModelRoutingEntry`, `RoleDistinctRequirement`, `ModelRoutingTableSettings`, `UpdateModelRoutingTableSettings`, `ModelRoutingErrorCode`

`packages/api-contract/src/configuration-record.spec.ts`
Add schema coverage for valid and invalid model_routing_table records, agent role-key shape, agent step-default shape, direct route shape, duplicate enabled route keys, role-distinct requirements, provider-profile records after the settings split, and create/update/response kind-settings coherence in both directions.

`packages/core/src/model-routing-resolver.ts`
New core resolver that lazily loads tenant routing configuration at resolve time, applies exact/default/direct specificity rules, validates referenced provider profiles against mode-specific adapter registries, constructs the existing resolved dispatch profile, validates role-distinct requirements only through group resolution, and returns typed sanitized routing failures.
`ModelRoutingConfigurationError`, `createModelRoutingResolver`, `ModelRoutingResolver`, `CreateModelRoutingResolverOptions`, `ModelRoutingConfigurationReader`, `ResolveAgentRouteInput`, `ResolveDirectRouteInput`, `ResolveDistinctAgentRoutesInput`, `ModelRoutingResolution`, `ModelRoutingDistinctResolution`, `ModelRoutingSafeDetails`

`packages/core/src/model-routing-resolver.spec.ts`
Add resolver unit coverage for exact agent match, agent step-default fallback, direct match, typed route miss, duplicate enabled routes, missing routing table, missing profile, incomplete profile, mode mismatch, unavailable adapter, invalid credential reference, and role_distinct_unsatisfied through resolveDistinctAgentRoutes for both caller-requested and routing-table-defined requirements.

`packages/core/src/index.ts`
Re-export the model-routing resolver factory, error class, and public resolver/input/result types from @autocatalyst/core.
`ModelRoutingConfigurationError`, `createModelRoutingResolver`, `ModelRoutingResolver`, `CreateModelRoutingResolverOptions`, `ModelRoutingConfigurationReader`, `ResolveAgentRouteInput`, `ResolveDirectRouteInput`, `ResolveDistinctAgentRoutesInput`, `ModelRoutingResolution`, `ModelRoutingDistinctResolution`, `ModelRoutingSafeDetails`

`packages/execution/src/agent-provider-adapter.ts`
Keep ResolvedAgentRunnerProfile and ResolvedAgentCredentialReference as the dispatch profile and credential-reference contracts returned by routing; no secret values are added to these adapter-visible types.
`ResolvedAgentRunnerProfile`, `ResolvedAgentCredentialReference`, `RunnerProfileMode`, `ProviderConnectionMechanism`

`packages/persistence/src/configuration-record-repository.ts`
Add tenant/owner storage for configuration_records, parse and persist records by parent kind so model_routing_table records and provider_profile records round-trip through the existing generic configuration-record storage with the matching settings schema for each kind, and enforce one active model-routing-table record per tenant.
`DrizzleConfigurationRecordRepository`

`packages/persistence/src/configuration-record-repository.spec.ts`
Add persistence round-trip coverage for provider_profile records after the settings split, model_routing_table create/list/find/update records, routing-table patch replacement/clear semantics for active/entries/roleDistinctRequirements/tableName/version, and rejection of kind/settings mismatches at the repository boundary.

`apps/control-plane/src/server.ts`
Compose the routing-aware profile resolver into real agent and direct dispatch, replacing explicit default-provider-profile resolution for production dispatch while retaining compatibility seams for tests/local explicit profile mode.
`createRoutingProfileResolver`, `createExplicitProfileResolver`

`apps/control-plane/src/model-routing.integration.spec.ts`
Add control-plane integration coverage that writes provider-profile and routing-table configuration through the service-owned configuration path, proves production agent dispatch invokes routing, verifies exact and step-default agent resolution, verifies typed route miss, verifies Claude implementer plus OpenAI reviewer dispatch through the existing event consumer with mocked cells, verifies unsatisfiable role-distinct failure, and verifies bounded direct route dispatch through an Anthropic or OpenAI direct cell without live credentials.

`context-agent/wiki/code-map.md`
Document the routing-table contract schemas, resolver module, resolved-profile construction rules, control-plane dispatch wiring, deliberate routingTableId metadata extension, explicit-profile fallback seams, and targeted routing test commands for future agents.

### Public API

#### `configurationRecordKindSchema`

```typescript
export const configurationRecordKindSchema: z.ZodEnum
```
- Returns: `Zod schema inferring ConfigurationRecordKind`
#### `providerProfileSettingsSchema`

```typescript
export const providerProfileSettingsSchema: z.ZodType
```
- Returns: `Zod schema for provider_profile settings only: profileName, credentialSecretHandle, model, inferenceSettings, and endpoint.`
- Errors:
	- `Zod validation error when provider-profile settings are malformed, profileName is empty, credentialSecretHandle is invalid, model identity is invalid, inference settings are invalid, or endpoint settings are invalid.`
#### `configurationRecordSettingsSchema`

```typescript
export const configurationRecordSettingsSchema: z.ZodUnion
```
- Returns: `Zod union for settings payloads. This schema is not internally discriminated; create/update/response record schemas select the correct branch using the parent record kind.`
- Errors:
	- `Zod validation error when the settings payload matches neither providerProfileSettingsSchema nor modelRoutingTableSettingsSchema. Use the top-level request/response schemas when kind-settings coherence matters.`
#### `createConfigurationRecordRequestSchema`

```typescript
export const createConfigurationRecordRequestSchema: z.ZodType
```
- Returns: `Kind-tagged create request schema: the provider_profile branch requires providerKind, adapterId, and providerProfileSettingsSchema; the model_routing_table branch requires modelRoutingTableSettingsSchema and rejects provider-profile settings.`
- Tenant: The request carries `tenant` when used at repository/internal service boundaries, or the API handler enriches the parsed request with tenant from the trusted request envelope before persistence. Implementations must not persist tenantless configuration records.
- Errors:
	- `Zod validation error when kind is unsupported.`
	- `Zod validation error when kind is provider_profile and settings do not satisfy providerProfileSettingsSchema.`
	- `Zod validation error when kind is model_routing_table and settings do not satisfy modelRoutingTableSettingsSchema.`
	- `Zod validation error when provider-only fields are missing from a provider_profile create request or are present in a model_routing_table create request if the implementation exposes routing tables as provider-neutral API records.`
#### `updateModelRoutingTableSettingsSchema`

```typescript
export const updateModelRoutingTableSettingsSchema: z.ZodType
```
- Returns: `Zod schema for PATCH settings on a model_routing_table record, allowing active, tableName, version, entries, and roleDistinctRequirements with at least one field present.`
- Patch semantics: `active` sets active/inactive state and is not nullable; tableName/version set values or clear with null; entries whole-array replace when present and reject null; roleDistinctRequirements whole-array replace when present and clear with null. Omitted fields are unchanged.`- Errors:  - `Zod validation error when no routing-table settings field is present.`  - `Zod validation error when entries contain invalid route keys, duplicate enabled route keys, empty profile ids, or malformed enabled flags.`  - `Zod validation error when roleDistinctRequirements contain invalid roles, duplicate roles, non-agent mode, or unsupported distinctBy values.`  - `Zod validation error when active is null, entries is null, or a patch attempts array merge/delete-by-id semantics instead of submitting a complete replacement array.`#### `updateConfigurationRecordRequestSchema\`
```typescript
export const updateConfigurationRecordRequestSchema: z.ZodType
```
- Returns: `Kind-tagged update request schema: the provider_profile branch accepts providerKind, adapterId, and updateConfigurationRecordSettingsSchema; the model_routing_table branch accepts updateModelRoutingTableSettingsSchema. The service must reject a body kind that does not match the existing record kind.`
- Errors:
	- `Zod validation error when kind is missing or unsupported.`
	- `Zod validation error when the provider_profile branch contains no mutable field or its settings patch is malformed.`
	- `Zod validation error when the model_routing_table branch contains no mutable routing-table field, uses provider-profile-only patch fields, or has invalid/duplicate routes.`
	- `API validation/configuration error when the requested kind differs from the persisted record's kind.`
#### `configurationRecordResponseSchema`

```typescript
export const configurationRecordResponseSchema: z.ZodType
```
- Returns: `Kind-tagged response schema that validates provider_profile responses with providerProfileSettingsSchema and model_routing_table responses with modelRoutingTableSettingsSchema.`
- Tenant: `ConfigurationRecord` responses include the owning tenant at service/repository boundaries so callers can assert tenant-local provider-profile references. If an external HTTP response envelope already carries tenant and intentionally redacts it from the body, the service-internal typed response still carries tenant before routing consumes it.`- Errors:  - `Zod validation error when a provider_profile response carries model-routing-table settings or lacks provider profile metadata required by the provider_profile branch.`  - `Zod validation error when a model_routing_table response carries provider-profile settings or includes fields rejected by the routing-table branch.`#### `agentModelRouteKeySchema\`
```typescript
export const agentModelRouteKeySchema: z.ZodType
```
- Returns: `Zod schema for agent route keys keyed by step plus either role or explicit step default`
- Errors:
	- `Zod validation error when mode is not agent, step is empty, role does not satisfy sessionRoleSchema, both role and defaultForStep are provided, or neither role nor defaultForStep is provided.`
#### `directModelRouteKeySchema`

```typescript
export const directModelRouteKeySchema: z.ZodType
```
- Returns: `Zod schema for direct route keys keyed by step only`
- Errors:
	- `Zod validation error when mode is not direct, step is empty, or a role/defaultForStep field is present.`
#### `modelRouteKeySchema`

```typescript
export const modelRouteKeySchema: z.ZodType
```
- Returns: `Zod union schema for agent exact routes, agent step defaults, and direct step routes`
- Errors:
	- `Zod validation error when the submitted route does not match exactly one supported route-key shape.`
#### `modelRoutingEntrySchema`

```typescript
export const modelRoutingEntrySchema: z.ZodType
```
- Returns: `Zod schema for a routing entry containing id, route, profileId, and optional enabled flag`
- Errors:
	- `Zod validation error when id or profileId is empty, route is invalid, or enabled is not boolean when supplied.`
#### `roleDistinctRequirementSchema`

```typescript
export const roleDistinctRequirementSchema: z.ZodType
```
- Returns: `Zod schema for a role-distinct requirement on an agent step`
- Errors:
	- `Zod validation error when step is empty, mode is not agent, roles are missing or invalid SessionRole values, roles contain duplicates, or distinctBy is not model/profile.`
#### `modelRoutingTableSettingsSchema`

```typescript
export const modelRoutingTableSettingsSchema: z.ZodType
```
- Returns: `Zod schema for a model-routing table settings payload`
- Errors:
	- `Zod validation error when active is missing or not boolean, entries contain duplicate enabled route keys, route shapes are invalid, referenced profile ids are empty, or role-distinct requirements are malformed.`
#### `modelRoutingErrorCodeSchema`

```typescript
export const modelRoutingErrorCodeSchema: z.ZodEnum
```
- Returns: `Zod schema inferring ModelRoutingErrorCode`
#### `ModelRoutingConfigurationError`

```typescript
export class ModelRoutingConfigurationError extends Error { constructor(code: ModelRoutingErrorCode, message: string, safeDetails?: ModelRoutingSafeDetails); }
```
- Parameters:
	- `code: ModelRoutingErrorCode` — Sanitized typed routing/configuration failure code.
	- `message: string` — Human-readable sanitized message without secrets, prompts, raw settings_json, request bodies, transcripts, or provider responses.
	- `safeDetails: ModelRoutingSafeDetails | undefined` — Optional safe structured context such as tenant, runId, routeId, step, role, mode, providerKind, adapterId, profileId/name, model identity, distinctBy, and roles.
- Returns: `ModelRoutingConfigurationError`
#### `createModelRoutingResolver`

```typescript
export function createModelRoutingResolver(options: CreateModelRoutingResolverOptions): ModelRoutingResolver
```
- Parameters:
	- `options: CreateModelRoutingResolverOptions` — Configuration reader plus agent and direct adapter registries used to validate and construct resolved profiles.
- Returns: `ModelRoutingResolver`
#### `ModelRoutingResolver.resolveAgentRoute`

```typescript
resolveAgentRoute(input: ResolveAgentRouteInput): Promise
```
- Parameters:
	- `input: ResolveAgentRouteInput` — Tenant, runId, step, and role for single agent route resolution. Distinct role groups use resolveDistinctAgentRoutes instead.
- Returns: `Promise`
- Errors:
	- `ModelRoutingConfigurationError with routing_table_missing when no active model_routing_table record exists for the tenant.`
	- `ModelRoutingConfigurationError with routing_table_ambiguous when more than one active model_routing_table record exists for the tenant.`
	- `ModelRoutingConfigurationError with route_not_found when neither exact (step, role) nor step default route exists.`
	- `ModelRoutingConfigurationError with duplicate_route when multiple enabled entries match an exact/default route key for the loaded tenant table.`
	- `ModelRoutingConfigurationError with profile_not_found when the selected entry references a missing provider_profile record.`
	- `ModelRoutingConfigurationError with profile_incomplete when the referenced profile lacks explicit model, inferenceSettings, endpoint, or credential reference shape required for routing.`
	- `ModelRoutingConfigurationError with route_mode_mismatch when an agent route points to a non-agent profile or incompatible adapter capability.`
	- `ModelRoutingConfigurationError with adapter_unavailable when no agent adapter is registered for providerKind/adapterId.`
	- `ModelRoutingConfigurationError with credential_reference_invalid when the credential reference cannot be validated before session start.`
#### `ModelRoutingResolver.resolveDirectRoute`

```typescript
resolveDirectRoute(input: ResolveDirectRouteInput): Promise
```
- Parameters:
	- `input: ResolveDirectRouteInput` — Tenant, runId, and step for bounded direct route resolution.
- Returns: `Promise`
- Errors:
	- `ModelRoutingConfigurationError with routing_table_missing when no active model_routing_table record exists for the tenant.`
	- `ModelRoutingConfigurationError with routing_table_ambiguous when more than one active model_routing_table record exists for the tenant.`
	- `ModelRoutingConfigurationError with route_not_found when no direct route exists for the step.`
	- `ModelRoutingConfigurationError with duplicate_route when multiple enabled direct entries match the step for the loaded tenant table.`
	- `ModelRoutingConfigurationError with profile_not_found when the selected entry references a missing provider_profile record.`
	- `ModelRoutingConfigurationError with profile_incomplete when the referenced profile lacks explicit model, inferenceSettings, endpoint, or credential reference shape required for routing.`
	- `ModelRoutingConfigurationError with route_mode_mismatch when a direct route points to a non-direct profile or incompatible adapter capability.`
	- `ModelRoutingConfigurationError with adapter_unavailable when no direct adapter is registered for providerKind/adapterId.`
	- `ModelRoutingConfigurationError with credential_reference_invalid when the credential reference cannot be validated before a direct call starts.`
#### `ModelRoutingResolver.resolveDistinctAgentRoutes`

```typescript
resolveDistinctAgentRoutes(input: ResolveDistinctAgentRoutesInput): Promise
```
- Parameters:
	- `input: ResolveDistinctAgentRoutesInput` — Tenant, runId, step, required roles, and distinctness policy for group agent route resolution. Callers may pass roles explicitly; the resolver also applies matching routing-table-defined RoleDistinctRequirement entries for the step.
- Returns: `Promise`
- Errors:
	- `ModelRoutingConfigurationError with routing_table_missing when no active model_routing_table record exists for the tenant.`
	- `ModelRoutingConfigurationError with routing_table_ambiguous when more than one active model_routing_table record exists for the tenant.`
	- `ModelRoutingConfigurationError with duplicate_route when duplicate enabled routes are detected while loading the tenant table.`
	- `ModelRoutingConfigurationError with role_distinct_unsatisfied when the resolved role set is not distinct by the caller-requested or routing-table-defined model/profile policy.`
	- `Any ModelRoutingConfigurationError produced by resolving an individual role in the group.`
#### `createRoutingProfileResolver`

```typescript
export function createRoutingProfileResolver(options: CreateRoutingProfileResolverOptions): { resolveAgentProfile(input: AgentRunnerFactoryInput): Promise; resolveDirectProfile(input: DirectCallFactoryInput): Promise; }
```
- Parameters:
	- `options: CreateRoutingProfileResolverOptions` — Control-plane composition options containing a ModelRoutingResolver, tenant selection policy, and optional explicit-profile fallbacks for agent and direct factory inputs.
- Returns: `Object containing agent and direct resolveProfile functions suitable for createAgentRunnerFactory and createDirectCallFactory`
- Errors:
	- `ModelRoutingConfigurationError when routing cannot resolve or validate a profile for dispatch.`
	- `ProviderConfigurationError only when the control-plane boundary intentionally maps routing errors into existing execution configuration errors.`
### Types

#### `AgentModelRouteKey`

```typescript
type AgentModelRouteKey = { mode: 'agent'; step: string; role: SessionRole; defaultForStep?: never } | { mode: 'agent'; step: string; defaultForStep: true; role?: never };
```
#### `DirectModelRouteKey`

```typescript
interface DirectModelRouteKey { readonly mode: 'direct'; readonly step: string; readonly role?: never; readonly defaultForStep?: never; }
```
#### `ModelRouteKey`

```typescript
type ModelRouteKey = AgentModelRouteKey | DirectModelRouteKey;
```
#### `ModelRoutingEntry`

```typescript
interface ModelRoutingEntry { readonly id: string; readonly route: ModelRouteKey; readonly profileId: string; readonly enabled?: boolean; }
```
#### `RoleDistinctRequirement`

```typescript
interface RoleDistinctRequirement { readonly step: string; readonly mode: 'agent'; readonly roles: readonly SessionRole[]; readonly distinctBy: 'model' | 'profile'; }
```
#### `ModelRoutingTableSettings`

```typescript
interface ModelRoutingTableSettings { readonly active: boolean; readonly tableName?: string; readonly version?: number; readonly entries: readonly ModelRoutingEntry[]; readonly roleDistinctRequirements?: readonly RoleDistinctRequirement[]; }
```
#### `UpdateModelRoutingTableSettings`

```typescript
interface UpdateModelRoutingTableSettings { readonly active?: boolean; readonly tableName?: string | null; readonly version?: number | null; readonly entries?: readonly ModelRoutingEntry[]; readonly roleDistinctRequirements?: readonly RoleDistinctRequirement[] | null; }
```
#### `ModelRoutingErrorCode`

```typescript
type ModelRoutingErrorCode = 'routing_table_missing' | 'routing_table_ambiguous' | 'route_not_found' | 'duplicate_route' | 'profile_not_found' | 'profile_incomplete' | 'route_mode_mismatch' | 'adapter_unavailable' | 'credential_reference_invalid' | 'role_distinct_unsatisfied';
```
#### `ProviderProfileSettings`

```typescript
interface ProviderProfileSettings { readonly profileName: string; readonly credentialSecretHandle?: SecretHandle; readonly model?: ModelIdentity; readonly inferenceSettings?: InferenceSettings; readonly endpoint?: RunnerEndpointSettings; }
```
#### `ConfigurationRecordSettings`

```typescript
type ConfigurationRecordSettings = ProviderProfileSettings | ModelRoutingTableSettings;
```
#### `CreateConfigurationRecordRequest`

```typescript
type CreateConfigurationRecordRequest = { readonly tenant: string; readonly kind: 'provider_profile'; readonly providerKind: string; readonly adapterId: string; readonly settings: ProviderProfileSettings } | { readonly tenant: string; readonly kind: 'model_routing_table'; readonly settings: ModelRoutingTableSettings; readonly providerKind?: never; readonly adapterId?: never };
```
#### `UpdateConfigurationRecordRequest`

```typescript
type UpdateConfigurationRecordRequest = { readonly kind: 'provider_profile'; readonly providerKind?: string; readonly adapterId?: string; readonly settings?: UpdateConfigurationRecordSettings } | { readonly kind: 'model_routing_table'; readonly settings?: UpdateModelRoutingTableSettings; readonly providerKind?: never; readonly adapterId?: never };
```
#### `ConfigurationRecord`

```typescript
type ConfigurationRecord = { readonly id: string; readonly tenant: string; readonly kind: 'provider_profile'; readonly providerKind: string; readonly adapterId: string; readonly settings: ProviderProfileSettings; readonly createdAt: string; readonly updatedAt: string } | { readonly id: string; readonly tenant: string; readonly kind: 'model_routing_table'; readonly settings: ModelRoutingTableSettings; readonly createdAt: string; readonly updatedAt: string; readonly providerKind?: never; readonly adapterId?: never };
```
#### `ModelRoutingConfigurationReader`

```typescript
interface ModelRoutingConfigurationReader { listConfigurationRecords(tenant: string): Promise; findConfigurationRecordById(tenant: string, id: string): Promise; }
```
Repository create/update/list/find contracts used by API handlers follow the same tenant-first rule: the tenant is an explicit trusted argument or a required field on service-internal create types, and record id alone is never sufficient to read or mutate configuration.
#### `CreateModelRoutingResolverOptions`

```typescript
interface CreateModelRoutingResolverOptions { readonly configuration: ModelRoutingConfigurationReader; readonly agentAdapters: AgentProviderAdapterRegistry; readonly directAdapters: DirectProviderAdapterRegistry; readonly validateCredentialReference?: (input: { tenant: string; profile: ResolvedAgentRunnerProfile; credentialReference: ResolvedAgentCredentialReference }) => Promise; }
```
#### `ResolveAgentRouteInput`

```typescript
interface ResolveAgentRouteInput { readonly tenant: string; readonly runId?: string; readonly step: string; readonly role: SessionRole; }
```
#### `ResolveDirectRouteInput`

```typescript
interface ResolveDirectRouteInput { readonly tenant: string; readonly runId?: string; readonly step: string; }
```
#### `ResolveDistinctAgentRoutesInput`

```typescript
interface ResolveDistinctAgentRoutesInput { readonly tenant: string; readonly runId?: string; readonly step: string; readonly roles: readonly SessionRole[]; readonly distinctBy?: 'model' | 'profile'; }
```
#### `ModelRoutingResolution`

```typescript
interface ModelRoutingResolution { readonly profile: ResolvedAgentRunnerProfile; readonly credentialReference: ResolvedAgentCredentialReference; readonly routeId: string; readonly profileId: string; readonly routingTableId: string; }
```
#### `ModelRoutingDistinctResolution`

```typescript
interface ModelRoutingDistinctResolution { readonly step: string; readonly distinctBy: 'model' | 'profile'; readonly resolutionsByRole: Readonly>; }
```
#### `ModelRoutingSafeDetails`

```typescript
interface ModelRoutingSafeDetails { readonly tenant?: string; readonly runId?: string; readonly routingTableId?: string; readonly routeId?: string; readonly step?: string; readonly role?: SessionRole; readonly roles?: readonly SessionRole[]; readonly mode?: 'agent' | 'direct'; readonly distinctBy?: 'model' | 'profile'; readonly profileId?: string; readonly profileName?: string; readonly providerKind?: string; readonly adapterId?: string; readonly model?: ModelIdentity; readonly collided?: readonly { readonly role: SessionRole; readonly profileId: string; readonly providerKind: string; readonly model: ModelIdentity }[]; }
```
#### `ResolvedAgentRunnerProfile`

```typescript
interface ResolvedAgentRunnerProfile { readonly mode: RunnerProfileMode; readonly providerKind: string; readonly adapterId: string; readonly profileName: string; readonly configurationRecordId?: string; readonly model: ModelIdentity; readonly inferenceSettings: InferenceSettings; readonly endpoint: RunnerEndpointSettings; readonly connectionMechanism: ProviderConnectionMechanism; }
```
#### `ResolvedAgentCredentialReference`

```typescript
interface ResolvedAgentCredentialReference { readonly required: boolean; readonly secretHandle?: string; readonly authTarget?: 'header' | 'process_environment'; }
```
#### `CreateRoutingProfileResolverOptions`

```typescript
interface CreateRoutingProfileResolverOptions { readonly resolver: ModelRoutingResolver; readonly selectTenant: (input: AgentRunnerFactoryInput | DirectCallFactoryInput) => string; readonly fallbackExplicitProfileResolver?: (input: AgentRunnerFactoryInput) => Promise; readonly fallbackExplicitDirectProfileResolver?: (input: DirectCallFactoryInput) => Promise; }
```
### Notes

This artifact proposes code-facing API additions for the model-routing feature. It intentionally keeps dispatch on the existing ResolvedAgentRunnerProfile/ResolvedAgentCredentialReference contracts and adds routing metadata alongside the profile rather than embedding route data into adapter-visible profile fields. The configuration-record settings union is externally discriminated by the parent kind field, so create/update/response schemas must be top-level kind-tagged unions while the standalone settings schema remains a plain z.union. Duplicate-route detection is specified at write-time and lazy resolve-time per tenant, not at synchronous resolver construction. Role-distinct group checking happens in `resolveDistinctAgentRoutes`; production dispatch must invoke that group resolver during pre-dispatch/session-start validation for steps with routing-table-defined `RoleDistinctRequirement` entries, while ordinary steps without such requirements may use single-role resolution. routingTableId on ModelRoutingResolution is a deliberate additive observability extension beyond the minimal tech-spec interface. Direct explicit-profile fallback is included symmetrically with agent fallback as an optional compatibility seam.
## Task list

### Story 1: API contracts describe routable configuration records

Enzo can import one shared configuration-record contract that validates provider profiles, model routing tables, route keys, role-distinct requirements, and typed routing error codes.
#### Task 1.1: Split configuration-record settings by record kind

- **Description:** Update `packages/api-contract/src/configuration-record.ts` so `provider_profile` settings remain provider-profile-only and `model_routing_table` becomes a first-class configuration-record kind.
- **Acceptance criteria:**
	- `configurationRecordKindSchema` accepts exactly `provider_profile` and `model_routing_table`.
	- Create and response schemas include tenant ownership at the service/repository boundary or are enriched from a trusted tenant envelope before persistence.
	- `providerProfileSettingsSchema` remains exported and validates only provider-profile settings.
	- `configurationRecordSettingsSchema` is the agreed union of provider-profile settings and model-routing-table settings.
	- Create, update, and response schemas select the matching settings shape from the parent record kind.
	- Provider-only fields are required for provider-profile create requests and rejected for model-routing-table create requests where the agreed API says they are not valid.
- **Dependencies:** None.
#### Task 1.2: Add route-key and routing-table schemas

- **Description:** Add the agent route key, direct route key, routing entry, role-distinct requirement, model-routing-table settings, patch settings, and routing error-code schemas from the Converged API.
- **Acceptance criteria:**
	- `agentModelRouteKeySchema` accepts exact agent routes with `role` and step-default routes with `defaultForStep: true`, but rejects both fields together or neither field.
	- `directModelRouteKeySchema` accepts direct routes by `step` only and rejects `role` and `defaultForStep`.
	- `modelRoutingEntrySchema` validates stable `id`, route key, `profileId`, and optional `enabled`.
	- `roleDistinctRequirementSchema` validates agent mode, non-empty unique role lists, and `distinctBy: 'model' | 'profile'`.
	- `modelRoutingTableSettingsSchema` requires an `active` boolean.
	- `modelRoutingTableSettingsSchema` rejects duplicate enabled route keys.
	- `updateModelRoutingTableSettingsSchema` accepts partial table updates with at least one routing-table field and enforces the agreed whole-array replacement and null-clearing semantics.
	- `modelRoutingErrorCodeSchema` contains the exact agreed error-code literals.
- **Dependencies:** Task 1.1.
#### Task 1.3: Export and test the contract surface

- **Description:** Re-export the new schemas and inferred types from `packages/api-contract/src/index.ts` and add focused contract tests.
- **Acceptance criteria:**
	- The package root exports every schema and type listed for `packages/api-contract/src/index.ts` in the Converged API.
	- `packages/api-contract/src/configuration-record.spec.ts` covers valid provider-profile records after the settings split.
	- Contract tests cover valid and invalid model-routing-table records, agent role routes, agent step defaults, direct routes, duplicate enabled keys, role-distinct requirements, and kind/settings mismatches.
	- Contract tests prove create, update, and response schemas enforce the parent-kind/settings relationship in both directions.
- **Dependencies:** Task 1.2.
### Story 2: Persistence stores tenant-scoped routing tables through generic configuration records

Opal can create, list, find, and update tenant-scoped `model_routing_table` records through the existing service-owned configuration storage without a dedicated routing database table.
#### Task 2.0: Add tenant ownership to generic configuration records

- **Description:** Add the required persistence migration and repository/API plumbing so generic configuration records are tenant-owned before routing uses them for tenant-specific profile lookup.
- **Acceptance criteria:**
	- The `configuration_records` storage has a non-null tenant/owner column with existing development data backfilled to the configured default/development tenant.
	- Repository create/list/find/update methods require tenant and never perform tenantless configuration-record lookup.
	- API/service calls derive tenant from the trusted request context or validated request envelope before calling the repository.
	- Repository tests prove a tenant cannot find, update, or route to another tenant's provider-profile record.
- **Dependencies:** Task 1.3.
#### Task 2.1: Parse configuration rows by parent kind

- **Description:** Update `packages/persistence/src/configuration-record-repository.ts` row mapping so each `configuration_records` row validates settings against the schema selected by its `kind`.
- **Acceptance criteria:**
	- `provider_profile` rows still parse and return provider metadata and provider-profile settings.
	- `model_routing_table` rows parse and return routing-table settings without `providerKind` or `adapterId`.
	- Row mapping rejects a kind/settings mismatch at the repository boundary.
	- The repository does not cast all `settings_json` payloads as provider-profile settings.
- **Dependencies:** Task 2.0.
#### Task 2.2: Support routing-table create, list, find, and update

- **Description:** Extend the repository create/update paths so routing-table records round-trip through the existing generic configuration-record table.
- **Acceptance criteria:**
	- Creating a `model_routing_table` record persists `kind: 'model_routing_table'` and the routing-table settings JSON.
	- Listing configuration records includes both provider-profile and model-routing-table records.
	- Finding a routing-table record by id returns the parsed routing-table response or `null` for a miss.
	- Creating or updating an active routing-table record fails if it would leave more than one active routing table for the tenant.
	- Updating a routing-table record applies the agreed patch semantics for `active`, `tableName`, `version`, `entries`, and `roleDistinctRequirements`.
	- Updating a persisted record with a request body whose kind differs from the stored kind fails with a typed validation/configuration error.
- **Dependencies:** Task 2.1.
#### Task 2.3: Add persistence regression tests

- **Description:** Add repository tests for provider-profile compatibility and model-routing-table round trips.
- **Acceptance criteria:**
	- Tests prove provider-profile records still create, list, find, and update after the settings split.
	- Tests prove model-routing-table records create, list, find, and update with entries and role-distinct requirements.
	- Tests cover routing-table patch replacement/clear behavior for `active`, `entries`, `roleDistinctRequirements`, `tableName`, and `version`.
	- Tests prove kind/settings mismatches and update-kind mismatches are rejected at the repository boundary.
- **Dependencies:** Task 2.2.
### Story 3: Core resolver turns routes into resolved dispatch profiles

Enzo can resolve agent and direct work by tenant, step, and role through a core resolver that returns the existing dispatch profile shape plus safe routing metadata.
#### Task 3.1: Add typed routing error and resolver public API

- **Description:** Create `packages/core/src/model-routing-resolver.ts` with the agreed error class, configuration reader interface, resolver factory, resolver methods, inputs, results, and safe-details types.
- **Acceptance criteria:**
	- `ModelRoutingConfigurationError` carries a `ModelRoutingErrorCode`, sanitized message, and optional `ModelRoutingSafeDetails`.
	- `createModelRoutingResolver` accepts `ModelRoutingConfigurationReader`, agent adapter registry, direct adapter registry, and optional credential-reference validation.
	- The resolver exposes `resolveAgentRoute`, `resolveDirectRoute`, and `resolveDistinctAgentRoutes`.
	- `packages/core/src/index.ts` re-exports the resolver factory, error class, resolver interface, inputs, results, reader interface, options, and safe-details type.
	- Error messages and safe details exclude raw `settings_json`, credential values, secret plaintext, request bodies, prompts, provider responses, transcripts, and workspace file contents.
- **Dependencies:** Task 1.3.
#### Task 3.2: Implement table loading and route specificity

- **Description:** Implement tenant routing-table loading, duplicate detection, exact/default agent specificity, direct step matching, and typed route-miss behavior.
- **Acceptance criteria:**
	- The resolver loads active `model_routing_table` configuration records lazily at resolve time.
	- Missing tenant routing configuration fails with `routing_table_missing`.
	- Multiple active routing tables for one tenant fail with `routing_table_ambiguous`.
	- Agent resolution checks exact `(step, role)` before agent step default.
	- Agent resolution returns `route_not_found` when neither exact nor default route exists.
	- Direct resolution checks only `{ mode: 'direct', step }` and returns `route_not_found` when missing.
	- Duplicate enabled entries for a matching route fail with `duplicate_route` instead of being selected by array order.
	- Disabled entries are ignored by resolution and cannot satisfy a required route.
- **Dependencies:** Task 3.1.
#### Task 3.3: Validate provider profiles and adapter compatibility

- **Description:** Resolve selected entries to provider-profile records and validate completeness, mode compatibility, adapter availability, connection mechanism, endpoint data, and credential references before dispatch.
- **Acceptance criteria:**
	- A route referencing a missing provider-profile record fails with `profile_not_found`.
	- A route referencing a provider-profile record owned by another tenant is treated as not visible and fails with `profile_not_found`.
	- A provider profile missing explicit model, inference settings, endpoint settings, or credential-reference shape fails with `profile_incomplete`.
	- An agent route pointing at a direct-only profile or a direct route pointing at an agent-only profile fails with `route_mode_mismatch`.
	- A missing mode-specific adapter registry entry fails with `adapter_unavailable`.
	- Invalid credential references fail with `credential_reference_invalid` before an agent session or direct call starts.
	- Agent validation uses only the agent registry, and direct validation uses only the direct registry.
- **Dependencies:** Task 3.2.
#### Task 3.4: Construct existing resolved profile contracts

- **Description:** Build `ResolvedAgentRunnerProfile` and `ResolvedAgentCredentialReference` from the selected provider-profile record without creating a parallel dispatch profile type.
- **Acceptance criteria:**
	- The returned profile uses the existing `ResolvedAgentRunnerProfile` fields for mode, provider kind, adapter id, profile name, configuration record id, model, inference settings, endpoint, and connection mechanism.
	- `configurationRecordId` is the provider-profile id, not the routing-table id.
	- `ModelRoutingResolution` returns `routeId`, `profileId`, and `routingTableId` alongside the dispatch profile.
	- The resolver derives credential `authTarget` from the selected connection mechanism.
	- Adapter-visible profile and credential-reference values contain no secret plaintext.
- **Dependencies:** Task 3.3.
#### Task 3.5: Implement role-distinct group resolution

- **Description:** Implement `resolveDistinctAgentRoutes` so callers and routing-table-defined requirements can require one step's roles to resolve to distinct models or profiles.
- **Acceptance criteria:**
	- The method resolves each requested role with normal agent exact/default specificity.
	- `distinctBy: 'model'` compares provider and model identity.
	- `distinctBy: 'profile'` compares provider-profile record id.
	- Matching routing-table-defined `RoleDistinctRequirement` entries for the step are applied during group resolution.
	- Unsatisfied distinctness fails with `role_distinct_unsatisfied` and safe details containing step, roles, distinctBy, and non-secret collision summaries.
	- Single-role `resolveAgentRoute` does not try to validate a role group; production callers must use `resolveDistinctAgentRoutes` in the pre-dispatch/session-start path for steps with table-defined distinct requirements.
- **Dependencies:** Task 3.4.
#### Task 3.6: Add resolver unit tests

- **Description:** Add `packages/core/src/model-routing-resolver.spec.ts` coverage for routing specificity, profile validation, typed errors, and role-distinct behavior.
- **Acceptance criteria:**
	- Tests cover exact agent match, agent step-default fallback, direct match, missing routing table, multiple active routing tables, typed route miss, duplicate enabled routes, and disabled-route behavior.
	- Tests cover missing profile, incomplete profile, mode mismatch, unavailable adapter, and invalid credential reference.
	- Tests cover resolved profile construction, including provider-profile `configurationRecordId`, route metadata, connection mechanism, and credential-reference auth target.
	- Tests cover `role_distinct_unsatisfied` for caller-requested requirements and routing-table-defined requirements.
	- Tests assert sanitized errors do not include secret values or raw settings payloads.
- **Dependencies:** Task 3.5.
### Story 4: Control-plane dispatch uses routing for agent and direct work

Phoebe can see production dispatch select different configured cells for the same step's roles and dispatch direct work by step without constructing profiles by hand.
#### Task 4.1: Compose routing-aware profile resolvers in the control plane

- **Description:** Add `createRoutingProfileResolver` in `apps/control-plane/src/server.ts` or a nearby module and wire it into real agent and direct dispatch composition.
- **Acceptance criteria:**
	- The composition builds a `ModelRoutingResolver` from the configuration-record repository and existing agent and direct adapter registries.
	- `resolveAgentProfile` adapts agent factory input into `resolveAgentRoute` with tenant, run id, step, and role.
	- The pre-dispatch/session-start path invokes `resolveDistinctAgentRoutes` before affected agent dispatches when the active routing table defines a matching `RoleDistinctRequirement`.
	- `resolveDirectProfile` adapts direct factory input into `resolveDirectRoute` with tenant, run id, and step.
	- Optional explicit-profile fallbacks remain available only as compatibility seams for tests or local explicit-profile mode.
	- Production real dispatch uses routing when a routing table exists instead of defaulting to `realRunnerDispatch.defaultProviderProfileId`.
- **Dependencies:** Tasks 2.3 and 3.6.
#### Task 4.2: Preserve role and tenant through agent dispatch inputs

- **Description:** Ensure the production agent dispatch caller supplies the role and tenant needed for route resolution without narrowing roles to only implementer/reviewer.
- **Acceptance criteria:**
	- Agent factory input passed to routing includes the current tenant, run id, step, and snake_case session role.
	- If a current entry point lacks a role, a small injected role selector or default role seam is added for this slice.
	- The role seam accepts arbitrary `SessionRole` values that pass the shared schema.
	- Missing role data for agent work fails as a typed routing/configuration error before provider execution.
- **Dependencies:** Task 4.1.
#### Task 4.3: Preserve tenant and step through direct dispatch inputs

- **Description:** Ensure direct-call dispatch passes tenant and step into `resolveDirectRoute` and never uses the agent registry as a proxy for direct capability.
- **Acceptance criteria:**
	- `DirectStepWorkInput` or the direct-call factory input carries tenant through to direct route resolution.
	- Direct route resolution is keyed only by step.
	- Direct dispatch fails with a typed routing/configuration error when the direct route points at a non-direct profile or unavailable direct adapter.
	- Direct dispatch still returns sanitized `RunWorkResult` failure text when routing fails inside `ExecutionRunUnitOfWork`.
- **Dependencies:** Task 4.1.
#### Task 4.4: Map routing errors safely at dispatch boundaries

- **Description:** Preserve routing error codes for tests and callers while mapping to existing execution/provider configuration errors only where required by current boundaries.
- **Acceptance criteria:**
	- Agent dispatch exposes or preserves `ModelRoutingConfigurationError` details where tests can assert the routing code.
	- Any mapping to `ProviderConfigurationError` keeps the original routing code available or recoverable.
	- Direct dispatch failures remain sanitized and do not include raw configuration or secret data.
	- Route resolution logs, if added, include safe route/profile metadata only.
- **Dependencies:** Tasks 4.2 and 4.3.
### Story 5: Integration coverage proves all configured runner cells through production seams

Opal and Phoebe can trust the routing feature because tests write real configuration records, use mocked provider cells, and exercise the production dispatch wiring.
#### Task 5.1: Add control-plane routing integration test setup

- **Description:** Add `apps/control-plane/src/model-routing.integration.spec.ts` scaffolding that creates provider-profile records, a model-routing-table record, mocked adapter cells, and real dispatch composition.
- **Acceptance criteria:**
	- Tests create configuration through the service-owned configuration path rather than in-memory resolver fixtures only.
	- Mocked agent and direct adapters require no live Anthropic or OpenAI credentials and make no network calls.
	- The fixture includes one active tenant-scoped routing table with routes for Claude agent, OpenAI agent, Anthropic direct, and OpenAI direct cells.
	- The fixture records enough safe metadata to assert which cell handled each dispatch.
- **Dependencies:** Task 4.4.
#### Task 5.2: Prove agent exact routes, defaults, and route misses

- **Description:** Add integration tests for ordinary agent route resolution and production agent dispatch.
- **Acceptance criteria:**
	- A test writes provider-profile and routing-table configuration, then dispatches an agent `(step, role)` through the production path.
	- A test proves a role with no exact route falls back to the agent step-level default.
	- A test proves a genuine agent route miss returns the typed `route_not_found` code.
	- Tests assert the routing resolver is invoked in the production dispatch path, not only in isolated unit tests.
- **Dependencies:** Task 5.1.
#### Task 5.3: Prove role-distinct agent dispatch through Claude and OpenAI cells

- **Description:** Add integration coverage where `implementer` and `reviewer` for the same step resolve to different agent providers and dispatch through the existing event consumer.
- **Acceptance criteria:**
	- The routing table maps the step's `implementer` route to the Claude agent cell.
	- The routing table maps the same step's `reviewer` route to the OpenAI agent cell.
	- The test verifies both roles dispatch through the existing event consumer and mocked cells.
	- The test verifies the resolved profiles have distinct provider/model identities.
	- The test exercises the production pre-dispatch/session-start group-validation path for the table-defined distinct requirement, not only an isolated resolver unit call.
	- A separate test proves an unsatisfiable distinct-role requirement returns `role_distinct_unsatisfied` with safe details.
- **Dependencies:** Task 5.2.
#### Task 5.4: Prove direct route dispatch through a direct cell

- **Description:** Add integration coverage for bounded direct calls resolving by step and dispatching through an Anthropic or OpenAI direct adapter.
- **Acceptance criteria:**
	- A test writes a direct `{ mode: 'direct', step }` route and dispatches through the production direct-call path.
	- The direct test verifies the selected direct adapter handled the call and returned a validated direct result.
	- The direct test proves direct routes do not accept or require a role.
	- The direct test requires no live provider credentials or network calls.
- **Dependencies:** Task 5.1.
#### Task 5.5: Run targeted validation for routing coverage

- **Description:** Run the narrow test commands that cover contracts, persistence, core resolver behavior, and control-plane routing integration.
- **Acceptance criteria:**
	- `pnpm nx test api-contract` passes or any failure is documented with the failing test and reason.
	- `pnpm nx test persistence` passes or any failure is documented with the failing test and reason.
	- `pnpm nx test core` passes or any failure is documented with the failing test and reason.
	- The control-plane routing integration test command passes or any failure is documented with the failing test and reason.
	- No validation command requires live Anthropic or OpenAI credentials.
- **Dependencies:** Tasks 5.2, 5.3, and 5.4.
### Story 6: Documentation and agent navigation stay current

The next agent can find the routing contracts, resolver, dispatch wiring, and validation commands without rediscovering the implementation.
#### Task 6.1: Update the agent code map

- **Description:** Update `context-agent/wiki/code-map.md` with the routing-table contract schemas, resolver module, resolved-profile construction rules, control-plane dispatch wiring, deliberate `routingTableId` metadata extension, explicit-profile fallback seams, and targeted routing test commands.
- **Acceptance criteria:**
	- The code map identifies `packages/api-contract/src/configuration-record.ts` as the routing-table contract source.
	- The code map identifies `packages/core/src/model-routing-resolver.ts` as the resolver source and summarizes exact/default/direct specificity.
	- The code map records that routing returns existing `ResolvedAgentRunnerProfile` and `ResolvedAgentCredentialReference` contracts.
	- The code map records the control-plane composition path for agent and direct routing.
	- The code map lists the targeted test commands used for routing work.
- **Dependencies:** Tasks 3.6 and 4.4.
#### Task 6.2: Record any implementation-time decisions or conflicts

- **Description:** If implementation discovers a substantive conflict with the agreed API, ADRs, or concept docs, record it in the correct human-owned or agent-owned documentation path before handoff.
- **Acceptance criteria:**
	- No existing requirements, design, tech spec, or Converged API sections are changed without explicit approval.
	- New durable agent-only implementation notes go under `context-agent/` using the repository decision format where appropriate.
	- Human-owned concept or ADR updates are made only when the implementation uncovers a real decision change that needs human-visible documentation.
	- `context-human/concepts/index.md` or `context-human/adrs/index.md` is updated if a human-owned concept or ADR is added or renamed.
- **Dependencies:** Task 6.1.