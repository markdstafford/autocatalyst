---
created: 2026-10-22
last_updated: 2026-10-22
status: complete
issue: 112
specced_by: markdstafford
---
# Create and manage projects over `/v1/projects`

## Requirements

### What

Add a versioned `Project` HTTP resource so authenticated clients can create, list, read, and update the projects Autocatalyst works on. A client can create a project with repository, issue-tracker, code-host, and credential-reference settings, then create a conversation bound to that project without direct database writes.

### Why

`Conversation` creation already requires a `projectId`, and intake explicitly binds work to an existing project. Today there is no API for clients to create or discover that project. Exposing `Project` over `/v1/projects` completes the settings flow: store a secret over `/v1/secrets`, reference its handle in project settings, and start work through `/v1/conversations`.

### Goals

- A human or system principal can manage tenant-scoped projects through `/v1/projects` without direct repository or database access.
- Project records created over the API are valid inputs for issue-reference intake, workspace resolution, and pull-request code-host behavior.
- Sensitive and dangerous fields stay controlled: clients cannot set `workspaceRootOverride`, and repository URLs must use `https`.
- Tenant boundaries are enforced for list, read, and update, with cross-tenant project ids returning `404`.
- The shared contract, OpenAPI document, and SDK expose the resource consistently.

### Personas

- **API client developer**: Builds a client or adapter that configures Autocatalyst through HTTP. They need stable schemas, clear validation errors, and no hidden database setup.
- **Repository owner**: Connects a software repository to Autocatalyst. They care that credentials are references, not plaintext, and that a project cannot be accidentally exposed across tenants.
- **Autocatalyst operator**: Runs the control plane. They need safe defaults, tenant scoping, and predictable failure modes for invalid project settings.

### User stories

- As an API client developer, I want to create a project over HTTP, so that I can start conversations against it without writing to the database.
- As a repository owner, I want project settings to reference secret handles, so that tokens are never stored in the project record.
- As an API client developer, I want to list and read my tenant's projects, so that I can choose the correct `projectId` for a new conversation.
- As a repository owner, I want to update tracker and code-host settings, so that I can rotate integrations without recreating the project.
- As an Autocatalyst operator, I want unsafe repository URLs and workspace overrides rejected, so that project configuration cannot make the server clone from local files or arbitrary protocols.

### Non-functional requirements

- **Security**: Only non-model principals may create or update projects. All route handlers must call the policy decision point before doing work.
- **Tenancy**: `owner` and `tenant` come from the authenticated `Principal`. Reads and updates are scoped by tenant.
- **Validation**: Request schemas are strict. Unknown or explicitly forbidden fields produce `400` validation errors.
- **Compatibility**: The API follows ADR-006 additive `/v1` evolution and the existing API naming conventions.
- **Secret safety**: Project settings store only credential references matching `secretHandlePattern`; existence and tenant ownership of the secret are out of scope for this feature.

### Out of scope

- Deleting projects.
- Testing external tracker or code-host connectivity when settings are written.
- Checking that a credential handle exists or belongs to the tenant.
- Merge strategy and default branch fields on the code-host setting.
- A database uniqueness constraint for repository binding.
- Setting `workspaceRootOverride` through the API.
- Consolidating persistence-local schema copies.
- Any user interface for editing projects.

## Design spec

This is a backend-only feature. No end-user UI or visual design is required. The user experience is the HTTP and SDK flow:

1. The client creates a secret with `POST /v1/secrets` and receives a secret handle.
2. The client creates a project with `POST /v1/projects`, using the secret handle in `issueTrackerSetting`, `codeHostSetting`, or `credentialRefs`.
3. The client lists or reads projects to select a `projectId`.
4. The client creates a conversation with `POST /v1/conversations` and the project id.

The API should make failures clear at the boundary. Invalid fields, unsafe URLs, and malformed secret handles return `400`; model principals receive `403`; duplicate repository bindings in a tenant return `409`; missing or cross-tenant ids return `404`.

## Technical specification

### Overview

Per ADR-006 and ADR-007, this feature adds a contract-first REST resource under `/v1/projects`. It reuses the existing `Project` entity and table, extends the project repository port with tenant-scoped reads and updates, and registers Fastify routes that validate requests with the shared contract. Per ADR-008, project settings are service-owned configuration stored in the database and scoped by owner and tenant.

### Architecture

#### Components

- `packages/api-contract/src/project.ts`: Add route constants, status constants, request schemas, response schemas, id params schema, and exports for `hostRepositorySchema` and the setting reference schema.
- `packages/api-contract/src/openapi.ts`: Register the `/v1/projects` paths.
- `packages/core/src/domain-repositories.ts`: Extend `ProjectRepository` with tenant-scoped `list`, `findById(tenant, id)`, and `update`, while keeping the existing global `findById(id)` for orchestrator/workspace loading.
- `packages/core/src/policy.ts`: Add project resource descriptors and actions for create, list, read, and update.
- `packages/core/src/routes.ts`: Register `POST /v1/projects`, `GET /v1/projects`, `GET /v1/projects/:id`, and `PATCH /v1/projects/:id`.
- `packages/persistence/src/domain-repositories.ts`: Implement tenant-scoped project list, find, and update in `DrizzleProjectRepository`.
- `packages/sdk/src/client.ts`: Add `createProject`, `listProjects`, `getProject`, and `updateProject`, each parsing responses with contract schemas.
- `apps/control-plane/src/integration.spec.ts` or a dedicated project integration spec: Add real server end-to-end coverage.
- `context-agent/wiki/code-map.md`: Record the new API resource and modified files.

#### Boundaries

The API layer owns HTTP validation, auth principal extraction, policy calls, and mapping service errors to HTTP responses. Core owns project use-case rules, including duplicate host-repository checks and principal restrictions. Persistence owns tenant-scoped queries and durable updates. The repository-binding uniqueness check stays in the service layer and does not add a database constraint in this feature.

#### Data flow

- **Create**: Route validates request → policy authorizes `project.create` → core rejects model principals → core checks tenant duplicate by `hostRepository.provider`, `hostRepository.owner`, and `hostRepository.name` → repository creates a project with `owner` and `tenant` from principal and `workspaceRootOverride: null` → route returns `201` with the project.
- **List**: Route validates principal → policy authorizes `project.list` → repository lists by tenant → route returns `{ projects }`.
- **Read**: Route validates id → policy authorizes `project.read` → repository finds by tenant and id → route returns project or `404`.
- **Update**: Route validates strict partial request → policy authorizes `project.update` → core rejects model principals → repository finds by tenant and id → repository updates allowed mutable fields and changes `updatedAt` → route returns updated project or `404`.

### Data model

No new table is required. The existing `projects` table remains the durable store. The update path changes only these client-updatable fields:

- `displayName`
- `issueTrackerSetting`
- `codeHostSetting`
- `credentialRefs`
- `updatedAt`

Create sets these fields from server state or controlled defaults:

- `owner`: authenticated principal id or owner value.
- `tenant`: authenticated principal tenant.
- `workspaceRootOverride`: `null`.
- `issueTrackerSetting`: request value or `null`.
- `codeHostSetting`: request value or `null`.
- `credentialRefs`: request value or empty collection.

Repository URL fields must pass HTTPS-only validation:

- `repoUrl`
- `hostRepository.url`

Credential reference validation applies anywhere a credential handle appears in settings or `credentialRefs`. Values must match `secretHandlePattern`; route creation does not check secret existence.

### API contracts

#### Shared contract exports

- `projectCollectionPath = '/v1/projects'`
- `projectPath = '/v1/projects/:id'` or equivalent path builder/constant matching existing conventions
- `createProjectSuccessStatusCode = 201`
- `listProjectsSuccessStatusCode = 200`
- `getProjectSuccessStatusCode = 200`
- `updateProjectSuccessStatusCode = 200`
- `projectIdParamsSchema`
- `createProjectRequestSchema`
- `updateProjectRequestSchema`
- `projectResponseSchema`
- `projectListResponseSchema`
- exported `hostRepositorySchema` and setting reference schema

#### `POST /v1/projects`

Request fields:

- `displayName`
- `repoUrl` with `https` protocol only
- `hostRepository` with `url` using `https` only
- optional `issueTrackerSetting`, default `null`
- optional `codeHostSetting`, default `null`
- optional `credentialRefs`, default empty

Strictly forbidden request fields:

- `owner`
- `tenant`
- `workspaceRootOverride`

Responses:

- `201`: project response
- `400`: schema validation failure, including unsafe URLs or forbidden fields
- `403`: model principal or policy denial
- `409`: host repository binding already exists in the same tenant

#### `GET /v1/projects`

Response: `200 { projects: Project[] }`, scoped to the caller's tenant.

#### `GET /v1/projects/:id`

Response: `200 Project` when found in tenant. Missing ids and ids in another tenant both return `404`.

#### `PATCH /v1/projects/:id`

Allowed request fields:

- `displayName`
- `issueTrackerSetting` (`null` clears it)
- `codeHostSetting` (`null` clears it)
- `credentialRefs`

Rules:

- The request must include at least one allowed field.
- `repoUrl` and `hostRepository` are not updatable and produce `400` if present.
- `owner`, `tenant`, and `workspaceRootOverride` remain forbidden.
- `updatedAt` changes on every successful update.

Responses:

- `200`: updated project
- `400`: schema validation failure
- `403`: model principal or policy denial
- `404`: missing or cross-tenant project id

### Implementation plan

1. Extend the contract schemas and export all route-level constants and types. Keep the create and patch request schemas strict, and centralize HTTPS and secret-handle validation in reusable schema pieces.
2. Add OpenAPI registration and contract tests for the new paths, status codes, and schemas.
3. Extend the project repository port and Drizzle implementation with tenant-scoped list, find, and update methods. Preserve the existing global `findById` for orchestrator and workspace code.
4. Add core project use-case functions or route-local service functions that enforce non-model principals, duplicate host-repository detection, immutable fields, and tenant scoping.
5. Add policy descriptors/actions and call the policy point from each route before executing work.
6. Register Fastify routes and map errors to `400`, `403`, `404`, and `409` using existing API error conventions.
7. Add SDK methods that use contract constants and parse responses with contract schemas.
8. Add an end-to-end production-server test that creates a secret, creates a project referencing it, reads the project, creates a conversation bound to it, and verifies second-tenant isolation.
9. Update `context-agent/wiki/code-map.md` with the new resource and touched files.

### Testing strategy

- **Contract tests**: Verify create, patch, single response, and list response schemas; strict rejection of forbidden fields; HTTPS-only URL validation; malformed secret handles; and OpenAPI path registration.
- **Core/unit tests**: Verify model principal rejection, duplicate host-repository conflict within a tenant, cross-tenant `404` behavior, and patch field rules.
- **Persistence tests**: Verify tenant-scoped list/find/update, global `findById` preservation, and `updatedAt` changes.
- **Route/integration tests**: Verify HTTP status codes and response shapes for create, list, read, update, validation failures, forbidden model principals, duplicate conflict, and cross-tenant isolation.
- **SDK tests**: Verify client methods call the expected paths and parse returned data.
- **End-to-end test**: Drive a production server with no direct project repository writes: create secret → create project → read project → create conversation using project id → verify another tenant cannot list, read, or update it.

### Operational concerns

- **Security**: Reject non-HTTPS repository URLs to avoid local-file, SSH, git-protocol, and cleartext HTTP clone risks. Never store secret plaintext in project records.
- **Privacy**: Return `404` for cross-tenant ids so project existence does not leak.
- **Consistency**: Duplicate host-repository checks are service-layer checks without a database constraint, so concurrent identical creates may race. This is accepted for this feature because a database uniqueness constraint is out of scope.
- **Observability**: Use existing request logging and error handling. Do not log secret handle values more broadly than existing API request handling already does.
- **Rollout**: This is additive under `/v1`; no migration beyond existing table compatibility is expected unless current JSON serialization requires shape adjustment.

### Open questions

- Decide during implementation whether project use cases live in a new `packages/core/src/project.ts` module or inside existing route/service structure. Prefer a small core module if route handlers would otherwise own business rules.
- Confirm the exact existing `Principal` fields used for `owner`; use the established pattern from configuration records rather than introducing a new owner mapping.
- Confirm existing error helper names for `409 conflict`; add a contract error code only if the current error module lacks one.

## Task list

### Story 1: Define the project API contract

Deliver the shared schemas and OpenAPI surface that every layer uses.

#### T-001: Add `/v1/projects` contract schemas

**Description:** Extend `packages/api-contract/src/project.ts` with route constants, status constants, id params, strict create request schema, strict partial update request schema, single response schema, and list response schema. Export `hostRepositorySchema` and the setting reference schema for reuse.

**Acceptance criteria:**

- Contract exports include collection/path constants and success status codes for create, list, read, and update.
- Create rejects `owner`, `tenant`, and `workspaceRootOverride`.
- Patch requires at least one allowed field and rejects `repoUrl` and `hostRepository`.
- `repoUrl` and `hostRepository.url` accept only `https` URLs.
- Credential references must match `secretHandlePattern`.

**Dependencies:** none.

#### T-002: Register project paths in OpenAPI

**Description:** Add the project collection and item routes to the generated OpenAPI document and assert them in `openapi.spec.ts`.

**Acceptance criteria:**

- OpenAPI includes `POST /v1/projects`, `GET /v1/projects`, `GET /v1/projects/{id}`, and `PATCH /v1/projects/{id}`.
- Tests assert the paths, methods, request schemas, response schemas, and success status codes.

**Dependencies:** T-001.

### Story 2: Add tenant-scoped project persistence

Deliver repository capabilities needed by the API while preserving existing orchestrator behavior.

#### T-003: Extend the project repository port

**Description:** Update `packages/core/src/domain-repositories.ts` so `ProjectRepository` supports tenant-scoped `list`, `findById(tenant, id)`, and `update`, while keeping the existing global `findById(id)` capability for orchestrator/workspace consumers.

**Acceptance criteria:**

- The port exposes tenant-scoped list, find, and update methods.
- Existing global lookup remains available and existing callers continue to compile.
- Types distinguish update input from create input and only include mutable fields.

**Dependencies:** none.

#### T-004: Implement Drizzle project list/find/update

**Description:** Implement the new port methods in `DrizzleProjectRepository`, including tenant filters and `updatedAt` mutation on update.

**Acceptance criteria:**

- `list(tenant)` returns only projects in that tenant.
- `findById(tenant, id)` returns `null` for missing and cross-tenant ids.
- `update` changes only allowed fields and always changes `updatedAt`.
- Persistence tests cover tenant isolation and update behavior.

**Dependencies:** T-003.

### Story 3: Implement project route behavior and policy

Deliver the HTTP resource with authorization, validation, conflict handling, and tenant scoping.

#### T-005: Add project policy descriptors and actions

**Description:** Extend `packages/core/src/policy.ts` with project resource descriptors and actions for create, list, read, and update.

**Acceptance criteria:**

- Policy input can describe project collection and single-project resources.
- Actions exist for project create, list, read, and update.
- Route tests can verify the policy point is called before work runs.

**Dependencies:** none.

#### T-006: Add core project use-case behavior

**Description:** Add service/use-case logic for creating, listing, reading, and updating projects. Enforce principal kind, tenant scoping, duplicate repository binding, immutable fields, and default values.

**Acceptance criteria:**

- Model principals cannot create or update projects and receive `403`.
- Create sets `owner` and `tenant` from the principal and stores `workspaceRootOverride` as `null`.
- Create defaults settings to `null` and `credentialRefs` to empty when omitted.
- Duplicate `(hostRepository.provider, owner, name)` in the same tenant returns `409`.
- Missing and cross-tenant ids return `404`.

**Dependencies:** T-001, T-003, T-004.

#### T-007: Register Fastify project routes

**Description:** Add route handlers for the four project endpoints, using contract schemas, principal extraction, policy calls, and existing error response conventions.

**Acceptance criteria:**

- `POST /v1/projects` returns `201` with a parsed project response.
- `GET /v1/projects` returns `{ projects: [...] }` for the caller's tenant.
- `GET /v1/projects/:id` returns one project or `404`.
- `PATCH /v1/projects/:id` updates allowed fields, supports explicit `null` to clear settings, and returns the updated project.
- Each route calls the policy decision point before executing repository work.

**Dependencies:** T-001, T-005, T-006.

### Story 4: Expose projects through the SDK

Deliver typed client access to the new resource.

#### T-008: Add SDK project methods

**Description:** Add `createProject`, `listProjects`, `getProject`, and `updateProject` to `packages/sdk`, using contract constants and parsing responses with contract schemas.

**Acceptance criteria:**

- SDK methods are exported from the public entry point.
- Each method sends the correct HTTP method and path.
- Each method parses successful responses with the corresponding contract schema.
- SDK tests cover all four methods.

**Dependencies:** T-001, T-007.

### Story 5: Prove the end-to-end configuration flow

Deliver confidence that clients can configure a project and start work without database writes.

#### T-009: Add production-server end-to-end project test

**Description:** Add an integration test that drives the real control-plane server over HTTP. The test creates a secret, creates a project referencing the secret handle, reads it back, starts a conversation with that project id, and verifies second-tenant isolation.

**Acceptance criteria:**

- The test creates the project only through `POST /v1/projects`; it does not write directly through the project repository.
- The project references a secret handle created through `POST /v1/secrets`.
- `POST /v1/conversations` accepts the project id and creates the conversation/run flow expected by existing intake.
- A second tenant cannot list, read, or update the first tenant's project.

**Dependencies:** T-007, T-008.

#### T-010: Add validation and conflict integration coverage

**Description:** Add focused route/integration tests for invalid URL protocols, malformed secret handles, forbidden fields, model principal rejection, patch immutability, empty patch bodies, and duplicate host repository conflicts.

**Acceptance criteria:**

- `file:`, `ssh:`, `git:`, and plain `http:` repository URLs return `400`.
- Malformed credential references return `400`.
- Create bodies with `owner`, `tenant`, or `workspaceRootOverride` return `400`.
- Patch bodies with `repoUrl` or `hostRepository` return `400`.
- Empty patch bodies return `400`.
- Duplicate host repository binding in a tenant returns `409`.

**Dependencies:** T-007.

### Story 6: Update agent navigation docs

Record the new resource for future agents.

#### T-011: Update the code map

**Description:** Update `context-agent/wiki/code-map.md` with the new project API resource, contract files, core route/use-case files, persistence methods, SDK methods, and test locations.

**Acceptance criteria:**

- The code map mentions `/v1/projects` and the files that own its contract, routes, persistence, and SDK methods.
- The update follows existing code-map style and does not alter human-owned docs.

**Dependencies:** T-007, T-008, T-009.

### Dependency graph

Critical path: T-001 → T-003 → T-004 → T-006 → T-007 → T-009 → T-011.

Parallel work: T-002 can follow T-001; T-005 can run independently before T-007; T-008 can start after T-001 but finishes after T-007; T-010 can run after T-007 alongside T-009.

## References

- `context-human/concepts/settings.md`
- `context-human/concepts/trackers.md`
- `context-human/concepts/intake.md`
- `context-human/concepts/domain-model.md`
- `context-human/concepts/api.md`
- `context-human/adrs/adr-008-config-model.md`
- `context-human/adrs/adr-013-core-domain-vocabulary.md`
- `context-human/adrs/adr-006-api-versioning.md`
- `context-agent/standards/api-conventions.md`
