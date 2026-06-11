---
created: 2026-06-11
last_updated: 2026-06-11
status: complete
issue: 35
specced_by: markdstafford
---
# Enhancement: List a tenant's runs

## Product requirements

### What

Add the missing collection read for runs: an authenticated client can call `GET /v1/runs` and receive the newest runs owned by the caller's tenant. The endpoint returns a bounded list of `Run` resources using a response shape declared in `packages/api-contract/src/run.ts`, and the SDK exposes the same capability through `ControlPlaneClient.listRuns()`.
This enhancement completes the basic run read surface started by issue 15. The system already supports creating a run through `POST /v1/conversations`, reading one run through `GET /v1/runs/:id`, reading its steps through `GET /v1/runs/:id/steps`, and streaming its events through `GET /v1/runs/:id/events`. The missing piece is a way for a client to discover its runs without already knowing each run id.
### Why

A client that creates work needs to render a run list after restart, reload, or navigation. Today it can create and inspect known runs, but it cannot ask the control plane for the tenant's recent runs. That forces clients to keep their own run-id cache, which conflicts with the control plane being the source of truth.
The request should stay intentionally small. The comprehensive read model with filters, pagination, cross-entity rollups, in-flight run views, queue depth, and cost belongs to later observability and query work. This enhancement adds only the bounded newest-first collection read that makes the existing run resource discoverable.
### Goals

- Add a tenant-scoped run-list repository operation that returns runs for one tenant only.
- Return runs newest-first by `createdAt` descending, with a deterministic tie-breaker.
- Bound the list with a sane default cap so an unfiltered collection read cannot return an unbounded table.
- Expose an in-process `ControlPlaneService.listRuns()` operation that authorizes the caller and scopes by the caller's tenant.
- Register `GET /v1/runs` on `runCollectionPath` in `packages/core/src/routes.ts` behind the same bearer auth and policy pattern as the other protected run routes.
- Add a `runListResponseSchema` in `packages/api-contract/src/run.ts` and reuse it in routes, SDK, tests, and OpenAPI.
- Add `ControlPlaneClient.listRuns()` in `packages/sdk/src/client.ts`, parsed through `runListResponseSchema`.
- Prove cross-tenant isolation: a run owned by another tenant never appears in the list.
- Prove newest-first ordering through an integration test that creates runs through the existing create path and then lists them.
### Non-goals

- Add query parameters, filters, search, or pagination cursors.
- Add conversation, topic, project, status, workflow, terminality, or date-range filters.
- Add cost, queue, session, step, feedback, or operational rollups to the list response.
- Change `GET /v1/runs/:id`, `GET /v1/runs/:id/steps`, or `GET /v1/runs/:id/events`.
- Change run creation, dispatch, lifecycle transitions, event replay, or SSE behavior.
- Add new database tables or migrations unless the implementation discovers an ordering/index problem that cannot be solved safely with the existing `runs` table.
- Update human concept docs in this issue; the existing `api`, `orchestrator`, and `run` concepts already allow this basic collection read.
### Personas

- **Phoebe (PM)** needs a client to show the runs a tenant has created without relying on local memory of run ids.
- **Enzo (Engineer)** needs one typed contract and SDK method for the run collection read so clients do not duplicate HTTP details.
- **Opal (Operator)** needs tenant isolation to hold for collection reads just as it does for single-run reads.
### User stories

- As a client developer, I can call `ControlPlaneClient.listRuns()` and receive typed `Run` records.
- As a network API client, I can call `GET /v1/runs` with bearer auth and receive my tenant's runs.
- As a tenant user, I see my newest runs first after opening a run-list view.
- As a tenant user, I never see another tenant's runs in the collection response.
- As a service maintainer, I can inspect the OpenAPI document and see the run-list operation under the `runs` tag.
### Acceptance criteria

#### Tenant-scoped persistence

- `RunRepository` gains a tenant-scoped list operation, for example `listByTenant(tenant, options?)`.
- The Drizzle persistence implementation queries `runs.tenant = tenant`; it does not list all runs and filter in application code.
- The operation returns runs ordered by `createdAt` descending.
- The operation uses a deterministic tie-breaker, such as `id` descending, when two runs have the same `createdAt`.
- The operation applies a default cap. A cap around 50 or 100 is acceptable as long as it is named and documented in code or tests.
- A persistence test creates runs for at least two tenants and asserts only the requested tenant's runs are returned.
- A persistence test asserts newest-first ordering.
#### In-process service

- `ControlPlaneService` exposes `listRuns(input)` alongside `getRun`, `listRunSteps`, and `subscribeRunEvents`.
- `ServiceListRunsInput` carries `principal` and `tenant`.
- `DefaultControlPlaneService.listRuns` calls the policy point with an action such as `run.list` and a collection resource descriptor.
- If policy denies the action, the method throws the same typed forbidden error style used by existing service methods.
- The method calls the tenant-scoped repository operation with the request tenant, not a tenant from the request body or query string.
- The method returns a typed result such as `{ runs }` and validates or preserves the contract shape through the shared schema at the route or SDK boundary.
#### Network route

- `GET /v1/runs` is registered on `runCollectionPath` in `packages/core/src/routes.ts`.
- The route is protected by bearer auth and the existing principal attachment path.
- The route uses the policy pre-handler style already used for protected routes.
- The route calls `dependencies.controlPlane.listRuns({ principal, tenant: principal.tenantId })`.
- The route returns HTTP `200` with `runListResponseSchema`.
- Validation, authorization, and unexpected errors use the existing error response conventions.
- `GET /v1/runs/:id` continues to resolve to the single-run route and is not shadowed by the collection route.
#### API contract and OpenAPI

- `packages/api-contract/src/run.ts` exports `runListResponseSchema`, `RunListResponse`, and `listRunsSuccessStatusCode` or a similarly named `200` constant.
- `runListResponseSchema` has the shape `{ runs: Run[] }` and reuses `runSchema`.
- `packages/api-contract/src/index.ts` exports the new schema, type, and status code through the existing `export * from './run.js'` path or explicit exports.
- `packages/api-contract/src/openapi.ts` registers `GET /v1/runs` under the `runs` tag.
- The OpenAPI entry documents `200`, `401`, and `403`/forbidden as supported by existing conventions. It may also document the shared error envelope for unexpected failures if that matches nearby routes.
- Contract tests assert the response schema accepts valid run arrays and rejects invalid run shapes.
#### SDK

- `ControlPlaneClient` includes `listRuns(): Promise`.
- The SDK sends `GET` to `runCollectionPath` and includes the bearer token when configured.
- The SDK parses success responses through `runListResponseSchema`.
- The SDK uses the existing `throwForError` behavior for non-OK responses.
- SDK tests assert the method path, method, bearer header, and parsed return value.
#### End-to-end proof

- An integration test creates multiple runs through the existing `POST /v1/conversations` create path.
- The test calls `GET /v1/runs` and asserts the created runs are present newest-first.
- The test proves tenant scoping. It may use a service-level integration seam, route-level stub, direct persistence setup, or a test principal injection seam, but the assertion must show a run from another tenant is excluded by the list operation.
- The test confirms the response body uses `{ runs: [...] }` and each item is a `Run` resource.
- Existing tests for `GET /v1/runs/:id`, `GET /v1/runs/:id/steps`, and run events continue to pass.
## Design spec

### Design scope

This is a backend API and SDK enhancement. It has no visual UI, layout, or component design in this pass. The user-facing design is the client and developer experience of asking, "What runs can this tenant see?" and receiving a small, predictable list.
The endpoint should feel like the natural collection pair for the existing single-resource route. A client reads the collection at `GET /v1/runs`, then reads details, steps, or events for a selected item through the existing `GET /v1/runs/:id` family.
### API experience

The request has no body and no query parameters in this slice:
```javascript
GET /v1/runs
Authorization: Bearer 
```
The response is a simple collection envelope:
```json
{
  "runs": [
    {
      "id": "run_123",
      "topicId": "topic_123",
      "owner": { "kind": "human", "id": "user_1", "tenantId": "tenant_dev" },
      "tenant": "tenant_dev",
      "workKind": "enhancement",
      "currentStep": "spec.author",
      "terminal": false,
      "createdAt": "2026-06-11T12:00:00.000Z",
      "updatedAt": "2026-06-11T12:00:00.000Z"
    }
  ]
}
```
The envelope should remain stable when filters or pagination arrive later. Future additions can add optional `nextCursor`, `limit`, or filter echo fields without changing `runs`.
### Ordering and bounds

The default sort is newest-first by `createdAt` descending. This matches the expected run-list view: the most recently created work appears first. If two rows share `createdAt`, the query uses a deterministic tie-breaker so tests and clients do not see unstable order.
The list is bounded even though there are no query parameters. The bound should be a named constant near the repository method or service layer. A default cap of 50 or 100 is suitable. This is not pagination; it is a safety guard for the first collection read.
### Tenant isolation

Tenant scoping belongs in every layer that touches the read:
- The service takes tenant from the authenticated principal context.
- The repository query includes `where runs.tenant = tenant`.
- The route never accepts a tenant query parameter or body field.
- The response schema still includes each run's `tenant`, but that field is descriptive, not a selector.
The design should mirror existing single-run reads. `getRun` loads by id and rejects a tenant mismatch. `listRuns` should avoid even loading other tenants' rows by using a tenant-scoped query.
### Policy behavior

The route should use the same authorization style as other protected routes. A collection read can use an action named `run.list` and a resource descriptor such as:
```typescript
{ kind: 'run_collection', path: '/v1/runs' }
```
The current policy is permissive in production wiring, but tests can stub a deny response to prove the service honors the policy point.
### SDK experience

The SDK method should be small and unsurprising:
```typescript
const { runs } = await client.listRuns();
```
It should behave like existing SDK reads: use the configured bearer token, throw `ControlPlaneClientError` for shared error responses, and parse success through the contract schema.
### Error behavior

The endpoint should not introduce new domain errors. Expected errors are:
- `401 Unauthorized` when bearer auth fails or is missing.
- `403 Forbidden` when policy denies `run.list`.
- `500 Internal Server Error` for unexpected failures, using the existing shared error envelope.
There is no `404` for an empty collection. A tenant with no runs receives `200` and `{ "runs": [] }`.
## Tech spec

### Current state

The current codebase already includes most of the resource surface this enhancement composes:
- `packages/api-contract/src/run.ts` defines `runSchema`, `runCollectionPath = '/v1/runs'`, `runResourcePath = '/v1/runs/:id'`, `runIdParamsSchema`, and `getRunSuccessStatusCode`.
- `packages/core/src/routes.ts` registers `GET /v1/runs/:id`, `GET /v1/runs/:id/steps`, and `GET /v1/runs/:id/events` through `ControlPlaneService`.
- `packages/core/src/control-plane-service.ts` exposes `getRun`, `listRunSteps`, `subscribeRunEvents`, `replayRunEvents`, and `tick` with tenant checks.
- `packages/core/src/policy.ts` defines the closed `PolicyAction` and `PolicyResourceDescriptor` unions used by service and route authorization, but it does not yet include `run.list` or a `run_collection` descriptor.
- `packages/core/src/domain-repositories.ts` has `RunRepository.findById`, `findActiveByTopic`, and `listByTopic`, but no tenant-scoped collection list.
- `packages/persistence/src/domain-repositories.ts` implements `DrizzleRunRepository.listByTopic` ordered ascending by creation time, but it does not implement a tenant list.
- `packages/api-contract/src/openapi.ts` registers run detail, run steps, and run events, but not `GET /v1/runs`.
- `packages/sdk/src/client.ts` has `getRun`, `listRunSteps`, and `subscribeRunEvents`, but no `listRuns`.
The main implementation gap is a vertical path for the run collection read: contract schema, repository method, service method, route, OpenAPI entry, SDK method, and tests.
### Contract changes

Update `packages/api-contract/src/run.ts`:
```typescript
export const listRunsSuccessStatusCode = 200 as const;

export const runListResponseSchema = z.object({
  runs: z.array(runSchema)
}).strict();

export type RunListResponse = z.infer;
```
`runCollectionPath` already exists and should stay the canonical route constant for both `GET /v1/runs` and future collection operations. No query schema is needed for this issue. If implementation wants the cap visible in the contract, expose a named constant only if it is useful to tests; do not add a public query parameter.
Add or update contract tests in `packages/api-contract/src/run.spec.ts` or a nearby file:
- `runListResponseSchema` accepts `{ runs: [validRun] }`.
- It rejects items that fail `runSchema`.
- `listRunsSuccessStatusCode` is `200`.
### Repository changes

Update `RunRepository` in `packages/core/src/domain-repositories.ts`:
```typescript
export interface ListRunsByTenantOptions {
  readonly limit?: number;
}

export interface RunRepository {
  // existing methods
  listByTenant(tenant: string, options?: ListRunsByTenantOptions): Promise;
}
```
A named options type keeps the interface additive if later code adds cursor or filters. For this issue, only `limit` is needed. If the team prefers no options yet, a fixed cap inside persistence is acceptable, but the cap must still be named.
Update `DrizzleRunRepository` in `packages/persistence/src/domain-repositories.ts`:
- Add a constant such as `defaultRunListLimit = 100` near the repository implementation or exported from an internal module.
- Normalize provided limits through a named helper or clearly tested branch:
	- `undefined` uses `defaultRunListLimit`.
	- A positive integer from `1` through `defaultRunListLimit` is used as provided.
	- `0`, negative numbers, fractional numbers, `NaN`, and infinite values are rejected with a range-style error before querying.
	- Values greater than `defaultRunListLimit` are clamped to `defaultRunListLimit`.
- Query with `where(eq(runs.tenant, tenant))`.
- Sort with `orderBy(desc(runs.createdAt), desc(runs.id))` or another documented deterministic tie-breaker.
- Apply `.limit(limit)`.
- Map rows through the existing `#rowToRun` validator.
Representative implementation:
```typescript
async listByTenant(tenant: string, options: ListRunsByTenantOptions = {}): Promise {
  const limit = normalizeRunListLimit(options.limit);
  const rows = this.#database.drizzle
    .select()
    .from(runs)
    .where(eq(runs.tenant, tenant))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit)
    .all();
  return rows.map((row) => this.#rowToRun(row));
}
```
This requires importing `desc` from Drizzle if not already imported. No migration is expected.
### Service changes

Update `packages/core/src/control-plane-service.ts`:
- Add `ServiceListRunsInput` with `principal` and `tenant`.
- Add `ServiceListRunsResult` with `runs: readonly Run[]`.
- Add `listRuns(input): Promise` to `ControlPlaneService`.
- Implement `DefaultControlPlaneService.listRuns`.
- Update `packages/core/src/policy.ts` so `PolicyAction` includes `'run.list'` and `PolicyResourceDescriptor` includes `{ readonly kind: 'run_collection'; readonly path: '/v1/runs' }`.
Representative implementation:
```typescript
async listRuns(input: ServiceListRunsInput): Promise {
  const decision = await this.#policy.authorize({
    principal: input.principal,
    action: 'run.list',
    resource: { kind: 'run_collection', path: '/v1/runs' }
  });
  if (!decision.allowed) {
    throw new ControlPlaneServiceError('forbidden', 'Not authorized to list runs.');
  }

  const runs = await this.#runs.listByTenant(input.tenant);
  return { runs };
}
```
The service should not accept tenant from request data. It should use the tenant passed from the route's resolved principal.
### Route changes

Update `packages/core/src/routes.ts` imports to include `listRunsSuccessStatusCode`, `runListResponseSchema`, and any type needed for route tests.
Register the collection route near the existing run routes. With Fastify, `GET /v1/runs` and `GET /v1/runs/:id` can coexist; defining the collection route before the parameter route is still clearer.
Representative route:
```typescript
protectedApp.get(runCollectionPath, {
  preHandler: authorizePreHandler(dependencies.policy, 'run.list', () => ({
    kind: 'run_collection' as const,
    path: '/v1/runs' as const
  }))
}, async (request, reply) => {
  const principal = requirePrincipalFromRequest(request);
  try {
    const result = await dependencies.controlPlane.listRuns({
      principal,
      tenant: principal.tenantId
    });
    await reply.status(listRunsSuccessStatusCode).send(
      runListResponseSchema.parse({ runs: result.runs })
    );
  } catch (error) {
    if (error instanceof ControlPlaneServiceError) {
      await handleControlPlaneServiceError(reply, error);
      return;
    }
    throw error;
  }
});
```
Update route test scaffolding in `packages/core/src/routes.spec.ts` so the mocked `controlPlane` includes `listRuns`.
### OpenAPI changes

Update `packages/api-contract/src/openapi.ts`:
- Import `listRunsSuccessStatusCode` and `runListResponseSchema` from `./run.js`.
- Register `RunListResponse` with the registry.
- Add a `GET` path for `runCollectionPath` under the `runs` tag.
Representative registration:
```typescript
registry.registerPath({
  method: 'get',
  path: runCollectionPath,
  tags: ['runs'],
  responses: {
    [listRunsSuccessStatusCode]: jsonResponse(RunListResponse, 'List of runs for the authenticated tenant.'),
    401: jsonResponse(ErrorResponse, 'Unauthorized.'),
    403: jsonResponse(ErrorResponse, 'Forbidden.')
  }
});
```
Keep the existing `GET /v1/runs/{id}` registration unchanged.
### SDK changes

Update `packages/sdk/src/client.ts`:
- Import `runListResponseSchema` and `RunListResponse`.
- Add `listRuns(): Promise` to `ControlPlaneClient`.
- Implement it with `GET` to `runCollectionPath`.
Representative implementation:
```typescript
async listRuns() {
  const response = await fetchImplementation(urlFor(baseUrl, runCollectionPath), {
    method: 'GET',
    headers: protectedHeaders(bearerToken)
  });
  await throwForError(response);
  return runListResponseSchema.parse(await parseJson(response));
}
```
Add SDK tests for path, method, bearer header, success parsing, and shared error handling if not already covered by another read method pattern.
### Test plan

Targeted tests should cover each layer:
- `packages/api-contract/src/run.spec.ts`: schema and status-code coverage for `runListResponseSchema`.
- `packages/persistence/src/__tests__/domain-repositories.spec.ts` or a focused run repository spec: `listByTenant` returns only one tenant's runs, sorts newest-first, and applies the cap if a small test limit is provided.
- `packages/core/src/control-plane-service.spec.ts`: `listRuns` calls policy, calls `runs.listByTenant` with the input tenant, returns runs, and maps policy denial to forbidden.
- `packages/core/src/routes.spec.ts`: `GET /v1/runs` calls `controlPlane.listRuns` with the resolved principal tenant, returns `{ runs }`, rejects unauthenticated requests, and maps forbidden through the shared error envelope.
- `packages/sdk/src/client.spec.ts`: `listRuns` sends `GET /v1/runs`, includes auth, and parses the response through the schema.
- `apps/control-plane/src/integration.spec.ts` or `apps/control-plane/src/control-plane-service.integration.spec.ts`: create runs through the existing create path, call `GET /v1/runs`, assert newest-first response, and assert another tenant's run is excluded through the available test seam.
Useful targeted validation commands after implementation:
```bash
pnpm nx test api-contract -- run.spec.ts
pnpm nx test persistence -- domain-repositories.spec.ts
pnpm nx test core -- control-plane-service.spec.ts
pnpm nx test core -- routes.spec.ts
pnpm nx test sdk -- client.spec.ts
pnpm nx test control-plane -- integration.spec.ts
```
Then run broader validation if practical:
```bash
pnpm validate
```
### Documentation and code map

No new module is required, so `context-agent/wiki/code-map.md` only needs an update if implementation adds, moves, or significantly changes a module. If the enhancement only expands existing modules, updating the code map is optional under the repository instruction.
Human concept docs do not need a same-issue update. `context-human/concepts/api.md` already describes `GET /runs` as a collection read direction, and this implementation is the first bounded slice of that surface.
### Risks and follow-ups

- The default cap may hide older runs until pagination exists. This is acceptable for the first collection read, but clients should not treat the response as an exhaustive archive forever.
- The hardcoded development principal and permissive policy make full multi-tenant network testing harder. Use service or persistence seams to prove cross-tenant exclusion if the network app cannot swap principals easily.
- Without filters, larger tenants will need pagination and query parameters soon. That should be a separate enhancement with explicit API design.
- If tests require stable newest-first ordering across runs created within the same millisecond, the deterministic tie-breaker must be asserted and documented.
## Converged API

### Files

Path
Purpose
Exports

`packages/api-contract/src/run.ts`
Defines the strict run collection response contract and success status for GET /v1/runs, reusing the existing Run schema and run collection path.
`listRunsSuccessStatusCode`, `runListResponseSchema`, `RunListResponse`

`packages/api-contract/src/run.spec.ts`
Adds contract tests proving runListResponseSchema accepts valid run arrays, rejects invalid run items and unknown top-level properties through strict mode, and exports the 200 list status code.

`packages/api-contract/src/openapi.ts`
Registers the GET /v1/runs OpenAPI operation under the runs tag with 200, 401, and 403 responses using the shared run list response schema.

`packages/core/src/domain-repositories.ts`
Extends the run repository abstraction with a tenant-scoped bounded list operation.
`ListRunsByTenantOptions`, `RunRepository`

`packages/persistence/src/domain-repositories.ts`
Implements tenant-scoped run listing in Drizzle with database-level tenant filtering, newest-first ordering, deterministic tie-breaker, and a named default cap.
`defaultRunListLimit`, `DrizzleRunRepository`

`packages/persistence/src/__tests__/domain-repositories.spec.ts`
Adds persistence coverage for DrizzleRunRepository.listByTenant proving cross-tenant isolation, newest-first ordering with deterministic tie-breaker behavior, and limit/default cap behavior using persisted rows.

`packages/core/src/policy.ts`
Extends the closed authorization unions so service and route policy calls can use action `run.list` and resource descriptor `{ kind: 'run_collection', path: '/v1/runs' }` without policy type errors.
`PolicyAction`, `PolicyResourceDescriptor`

`packages/core/src/control-plane-service.ts`
Adds the in-process listRuns service operation that authorizes run.list and scopes repository access to the caller tenant.
`ServiceListRunsInput`, `ServiceListRunsResult`, `ControlPlaneService`, `DefaultControlPlaneService`

`packages/core/src/control-plane-service.spec.ts`
Adds service tests proving listRuns calls policy with action run.list and a run collection resource, calls runs.listByTenant with the input tenant, returns the repository runs, and maps policy denial to the existing forbidden ControlPlaneServiceError style.

`packages/core/src/routes.ts`
Registers the protected GET /v1/runs route on runCollectionPath and returns responses validated by strict runListResponseSchema without shadowing GET /v1/runs/:id.

`packages/core/src/routes.spec.ts`
Updates createFakeControlPlaneService() to include a listRuns vi.fn default stub and adds route tests for GET /v1/runs authentication, principal-tenant scoping, successful \{ runs \} response, forbidden error mapping, and coexistence with GET /v1/runs/:id.

`packages/sdk/src/client.ts`
Exposes ControlPlaneClient.listRuns() for SDK consumers, sending GET /v1/runs with configured bearer auth and parsing successful responses with the shared strict contract schema.
`ControlPlaneClient`

`packages/sdk/src/client.spec.ts`
Adds SDK tests proving listRuns sends GET to runCollectionPath, includes the bearer header when configured, parses successful responses through runListResponseSchema, and uses existing throwForError behavior for non-OK shared error responses.

`apps/control-plane/src/integration.spec.ts`
Adds end-to-end or integration coverage that creates multiple runs through the existing POST /v1/conversations path, calls GET /v1/runs, asserts the response body is \{ runs: \[...\] \} with Run resources newest-first, and proves another tenant's run is excluded through the available test seam.

### Public API

#### `listRunsSuccessStatusCode`

```typescript
export const listRunsSuccessStatusCode = 200 as const
```
- Returns: `200`
#### `runListResponseSchema`

```typescript
export const runListResponseSchema: z.ZodObject }, 'strict'>
```
- Returns: `Strict Zod schema for RunListResponse`
- Errors:
	- `ZodError when the response is not a strict object with exactly the supported top-level fields and a runs array of valid Run resources`
	- `ZodError when unknown top-level response properties are present`
#### `RunRepository.listByTenant`

```typescript
listByTenant(tenant: string, options?: ListRunsByTenantOptions): Promise
```
- Parameters:
	- `tenant: string` — Tenant identifier used to scope the persistence query. Only runs with runs.tenant equal to this value may be returned, and filtering must occur in the database query.
	- `options: ListRunsByTenantOptions | undefined` — Optional list controls. For this enhancement only limit is supported; absent limit uses the named default cap. Positive integer limits from 1 through the named default cap are honored. Zero, negative, fractional, NaN, and infinite limits are rejected with a range-style error before querying. Limits above the named default cap are clamped to that cap.
- Returns: `Promise`
#### `ControlPlaneService.listRuns`

```typescript
listRuns(input: ServiceListRunsInput): Promise
```
- Parameters:
	- `input: ServiceListRunsInput` — Authenticated principal and tenant context for the collection read. The route supplies tenant from principal.tenantId; no request body or query parameter can select a tenant.
- Returns: `Promise`
- Errors:
	- `ControlPlaneServiceError with code forbidden when policy denies action run.list`
#### `GET /v1/runs`

```typescript
GET /v1/runs -> 200 RunListResponse
```
- Parameters:
	- `Authorization: Bearer token header` — Required bearer authentication header used by the existing protected route principal attachment path.
- Returns: `RunListResponse`
- Errors:
	- `401 Unauthorized when bearer authentication fails or is missing`
	- `403 Forbidden when policy denies run.list`
	- `500 Internal Server Error for unexpected failures using the existing shared error envelope`
#### `ControlPlaneClient.listRuns`

```typescript
listRuns(): Promise
```
- Returns: `Promise`
- Errors:
	- `ControlPlaneClientError when the server returns a non-OK shared error response`
	- `ZodError when a successful response does not satisfy strict runListResponseSchema`
### Types

#### `RunListResponse`

```typescript
type RunListResponse = z.infer // { runs: Run[] }
```
#### `ListRunsByTenantOptions`

```typescript
interface ListRunsByTenantOptions { readonly limit?: number }
```
#### `ServiceListRunsInput`

```typescript
interface ServiceListRunsInput { readonly principal: Principal; readonly tenant: string }
```
#### `ServiceListRunsResult`

```typescript
interface ServiceListRunsResult { readonly runs: readonly Run[] }
```
### Notes

The proposed code-facing API adds a bounded tenant-scoped run collection read. No query parameters, filters, pagination cursors, request body, or new domain error types are proposed. The route should use the existing runCollectionPath constant ('/v1/runs'), bearer-auth protected routing, policy action 'run.list', and shared error envelope conventions. Persistence must query by tenant directly, order by createdAt descending with a deterministic tie-breaker such as id descending, and apply a named default cap such as 50 or 100. The response schema must be implemented with z.object(\{ runs: z.array(runSchema) \}).strict(), consistent with the existing strict run resource contract. The existing packages/core/src/routes.spec.ts createFakeControlPlaneService() scaffold must be updated when ControlPlaneService gains listRuns by adding listRuns: vi.fn(async () =\> \{ throw new Error('controlPlane.listRuns not stubbed for this test'); \}) alongside existing service method stubs, otherwise TypeScript structural checking will fail. Test coverage is part of this API proposal: contract, persistence, service, route, SDK, and integration specs should prove strict schema behavior, tenant isolation, newest-first ordering, protected route behavior, SDK request/parse behavior, and end-to-end list discovery. The RunListResponse mutable array shape is intentionally inherited from Zod inference at the network contract boundary, while ServiceListRunsResult remains readonly to match service conventions.
## Task list

### Story 1: Define the run-list contract

Add the shared API contract for a bounded tenant run list so every layer uses one response shape and one success status.
#### Task 1.1: Add the list response schema and status constant

**Description:** Update `packages/api-contract/src/run.ts` to export `listRunsSuccessStatusCode`, `runListResponseSchema`, and `RunListResponse` exactly as agreed in `## Converged API`.
**Acceptance criteria:**
- `runListResponseSchema` has the strict shape `{ runs: Run[] }` and reuses `runSchema`.
- `RunListResponse` is inferred from `runListResponseSchema`.
- `listRunsSuccessStatusCode` is exported as `200 as const`.
- Existing run path and single-run exports remain unchanged.
**Dependencies:** None.
#### Task 1.2: Cover the contract with tests

**Description:** Add contract tests in `packages/api-contract/src/run.spec.ts` or the existing nearby run contract test file.
**Acceptance criteria:**
- A valid response with one or more valid `Run` resources parses successfully.
- `{ runs: [] }` parses successfully.
- A response with an invalid run item fails parsing.
- A response with unknown top-level properties fails because the schema is strict.
- The exported list success status code equals `200`.
**Dependencies:** Task 1.1.
#### Task 1.3: Register the OpenAPI operation

**Description:** Update `packages/api-contract/src/openapi.ts` to document `GET /v1/runs` under the `runs` tag.
**Acceptance criteria:**
- The OpenAPI document includes `GET /v1/runs` using `runCollectionPath`.
- The `200` response uses the shared run list response schema.
- The operation documents `401` and `403` responses using existing error envelope conventions.
- Existing `GET /v1/runs/{id}`, steps, and events registrations remain unchanged.
**Dependencies:** Task 1.1.
### Story 2: Add tenant-scoped persistence support

Add a repository operation that lists only one tenant's runs, ordered newest-first and bounded by a named cap.
#### Task 2.1: Extend the repository interface

**Description:** Update `packages/core/src/domain-repositories.ts` with `ListRunsByTenantOptions` and `RunRepository.listByTenant(tenant, options?)`.
**Acceptance criteria:**
- `ListRunsByTenantOptions` supports `readonly limit?: number`.
- `RunRepository` includes `listByTenant(tenant: string, options?: ListRunsByTenantOptions): Promise`.
- Existing repository methods keep their current signatures.
- All repository test doubles and compile-time implementations are updated to satisfy the new interface.
**Dependencies:** None.
#### Task 2.2: Implement Drizzle tenant run listing

**Description:** Update `packages/persistence/src/domain-repositories.ts` to implement `DrizzleRunRepository.listByTenant`.
**Acceptance criteria:**
- The query filters in SQL with `where(eq(runs.tenant, tenant))`.
- The query orders by `createdAt` descending and a deterministic tie-breaker such as `id` descending.
- The query applies a named default cap, such as `defaultRunListLimit = 100`.
- Provided limits are normalized consistently: `undefined` uses the named default cap; positive integers from `1` through the cap are honored; zero, negative, fractional, `NaN`, and infinite values are rejected with a range-style error before querying; values above the cap are clamped to the cap.
- Rows are mapped through the existing run row validator.
- No migration is added unless implementation proves the current table cannot support safe ordering.
**Dependencies:** Task 2.1.
#### Task 2.3: Test repository isolation, ordering, and bounds

**Description:** Add persistence tests for `listByTenant` in `packages/persistence/src/__tests__/domain-repositories.spec.ts` or an equivalent focused repository spec.
**Acceptance criteria:**
- Runs from another tenant never appear in the returned list.
- Runs for the requested tenant are ordered newest-first.
- Ties on `createdAt` have deterministic ordering.
- A small explicit limit returns no more than that number of runs.
- The default cap is named and covered either by behavior or direct assertion.
- Limit tests assert the required normalization behavior for invalid, zero, negative, fractional, and excessive limit values.
**Dependencies:** Task 2.2.
### Story 3: Add the in-process service operation

Expose a service method that authorizes the collection read and scopes the repository query to the caller's tenant.
#### Task 3.1: Add service types and interface method

**Description:** Update `packages/core/src/control-plane-service.ts` with `ServiceListRunsInput`, `ServiceListRunsResult`, and `ControlPlaneService.listRuns`.
**Acceptance criteria:**
- `ServiceListRunsInput` carries `principal` and `tenant`.
- `ServiceListRunsResult` carries `readonly runs: readonly Run[]`.
- `ControlPlaneService` exposes `listRuns(input): Promise`.
- Existing service methods and exported types remain compatible.
**Dependencies:** Task 2.1.
#### Task 3.2: Implement service authorization and repository call

**Description:** Implement `DefaultControlPlaneService.listRuns` using the agreed `run.list` action and run collection resource descriptor.
**Acceptance criteria:**
- The service calls policy authorization before reading persistence.
- The policy request includes the authenticated principal, action `run.list`, and a collection resource such as `{ kind: 'run_collection', path: '/v1/runs' }`.
- `packages/core/src/policy.ts` extends the `PolicyAction` union with `'run.list'` and the `PolicyResourceDescriptor` union with `{ readonly kind: 'run_collection'; readonly path: '/v1/runs' }`, so the service and route compile with the new policy input.
- Policy denial throws the existing forbidden `ControlPlaneServiceError` style.
- The service calls `runs.listByTenant(input.tenant)` and never reads tenant from request body or query data.
- The service returns `{ runs }` without changing the run resource shape.
**Dependencies:** Task 3.1, Task 2.2.
#### Task 3.3: Test service behavior

**Description:** Add `listRuns` coverage in `packages/core/src/control-plane-service.spec.ts`.
**Acceptance criteria:**
- The service authorizes with action `run.list` and the run collection resource descriptor.
- The service calls `runs.listByTenant` with the input tenant.
- A successful repository result is returned as `{ runs }`.
- Policy denial maps to the existing forbidden service error.
- The repository is not called when policy denies access.
**Dependencies:** Task 3.2.
### Story 4: Register the protected network route

Add `GET /v1/runs` to the control-plane routes without changing or shadowing the existing run detail routes.
#### Task 4.1: Add the `GET /v1/runs` route

**Description:** Update `packages/core/src/routes.ts` to register the collection route on `runCollectionPath`.
**Acceptance criteria:**
- The route is registered as `GET /v1/runs`.
- The route is protected by the existing bearer auth and principal attachment flow.
- The route uses the same policy pre-handler pattern as nearby protected run routes.
- The handler calls `dependencies.controlPlane.listRuns({ principal, tenant: principal.tenantId })`.
- The success response uses `listRunsSuccessStatusCode` and parses through `runListResponseSchema`.
- Service errors use existing route error mapping.
- `GET /v1/runs/:id`, steps, and events continue to route correctly.
**Dependencies:** Task 1.1, Task 3.2.
#### Task 4.2: Update route test scaffolding

**Description:** Update route test helpers, including `createFakeControlPlaneService()`, to include a default `listRuns` stub.
**Acceptance criteria:**
- TypeScript structural checks pass after `ControlPlaneService` gains `listRuns`.
- The default `listRuns` stub fails loudly when a test forgets to provide a specific behavior.
- Existing route tests for create, get, steps, and events continue to compile and pass.
**Dependencies:** Task 3.1.
#### Task 4.3: Test route success and error behavior

**Description:** Add route tests for `GET /v1/runs` in `packages/core/src/routes.spec.ts`.
**Acceptance criteria:**
- An authenticated request returns `200` with `{ runs: [...] }`.
- The route passes the resolved principal and `principal.tenantId` to `controlPlane.listRuns`.
- An unauthenticated request returns `401` through existing auth behavior.
- A service forbidden error returns `403` through the shared error envelope.
- A request to `GET /v1/runs/:id` still reaches the single-run route, proving the collection route does not shadow it.
**Dependencies:** Task 4.1, Task 4.2.
### Story 5: Add SDK support

Expose the run collection read to SDK consumers through `ControlPlaneClient.listRuns()`.
#### Task 5.1: Implement `ControlPlaneClient.listRuns`

**Description:** Update `packages/sdk/src/client.ts` to add `listRuns(): Promise`.
**Acceptance criteria:**
- The method sends `GET` to `runCollectionPath`.
- The method includes the configured bearer token using existing protected header helpers.
- The method calls existing `throwForError` behavior for non-OK responses.
- The method parses successful JSON through `runListResponseSchema`.
- Public SDK exports and types remain consistent with existing client patterns.
**Dependencies:** Task 1.1.
#### Task 5.2: Test SDK request and parse behavior

**Description:** Add `listRuns` tests in `packages/sdk/src/client.spec.ts`.
**Acceptance criteria:**
- The SDK sends the request to `/v1/runs` with method `GET`.
- The bearer header is included when a token is configured.
- A valid response parses and returns `RunListResponse`.
- An invalid success body fails through schema parsing.
- A non-OK shared error response uses existing `throwForError` behavior.
**Dependencies:** Task 5.1.
### Story 6: Prove the full vertical slice

Add integration coverage that demonstrates clients can discover newly created runs and cannot see another tenant's runs.
#### Task 6.1: Add run-list integration coverage

**Description:** Update `apps/control-plane/src/integration.spec.ts` or the existing control-plane integration spec to create runs through `POST /v1/conversations`, then list them through `GET /v1/runs`.
**Acceptance criteria:**
- The test creates multiple runs through the existing conversation create path.
- The test calls `GET /v1/runs` with authentication.
- The response body is `{ runs: [...] }`.
- Returned items satisfy the `Run` resource shape.
- The created runs appear newest-first.
- The test proves a run from another tenant is excluded through an available service, route, persistence, or principal injection seam.
**Dependencies:** Task 4.1, Task 5.1.
#### Task 6.2: Run targeted validation

**Description:** Run targeted tests for the layers changed by this enhancement.
**Acceptance criteria:**
- Contract tests for `runListResponseSchema` pass.
- Persistence repository tests for `listByTenant` pass.
- Service tests for `listRuns` pass.
- Route tests for `GET /v1/runs` pass.
- SDK tests for `ControlPlaneClient.listRuns` pass.
- Integration coverage for create-then-list behavior passes.
**Dependencies:** Task 1.2, Task 2.3, Task 3.3, Task 4.3, Task 5.2, Task 6.1.
#### Task 6.3: Run broad validation and update agent notes if needed

**Description:** Run the project-level validation command when practical and update agent-facing navigation only if implementation adds or significantly changes modules.
**Acceptance criteria:**
- `pnpm validate` passes, or any skipped/failed validation is documented with the exact reason.
- `context-agent/wiki/code-map.md` is updated only if implementation adds, moves, or significantly changes a module.
- No human concept docs are changed for this enhancement unless a separate approval asks for that update.
**Dependencies:** Task 6.2.