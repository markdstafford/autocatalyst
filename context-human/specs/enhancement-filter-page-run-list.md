---
created: 2026-11-01
last_updated: 2026-11-01
status: draft
issue: 133
specced_by: markdstafford
---
# Enhancement: Filter and page the run list

## Parent feature

`context-human/specs/enhancement-list-tenant-runs.md` — adds the tenant-scoped `GET /v1/runs` collection read and SDK `listRuns()` method that return the newest bounded set of runs. This enhancement keeps that collection surface and lifts the silent newest-100 cap into explicit filters and cursor paging.

## What

`GET /v1/runs` becomes a bounded, filterable page of run rows. An operator client can filter runs by `status`, `waitingOn`, `workKind`, and `projectId`; can request a page with `limit` and `cursor`; and receives `nextCursor` only when more matching rows exist. Every row returned by `GET /v1/runs`, `GET /v1/runs/:id`, and reply responses includes the row data the collection view needs: tracked issue number/title, work kind, derived status, waiting class, project id, and created time.

## Why

The current list silently returns only the newest 100 tenant runs, so older matching work disappears with no signal and a client cannot implement collection views reliably. Server-side filtering and cursor paging let the client ask for the subset it can display, detect whether more rows exist, and retrieve older matches without loading the entire tenant history or issuing one read per row for project/status data.

## User stories

- An operator can list failed runs without missing failures that are older than the newest 100 runs.
- An operator can list runs waiting on a human and page through the result set.
- An operator can filter the run list to one project without seeing another tenant's runs.
- A client developer can call `listRuns()` with optional filters, `limit`, and `cursor`, then follow `nextCursor` until the list is exhausted.
- A client developer can render a run-list row from list/get/reply responses without fetching conversations, topics, or messages.

## Design changes

This is a backend API and SDK enhancement with no new UI components. The client-visible design change is the run collection contract: a list response is now one page of the filtered collection rather than an implicit newest-100 sample.

### API experience

Examples:

```http
GET /v1/runs?status=failed
GET /v1/runs?waitingOn=human&limit=25
GET /v1/runs?projectId=proj_1&status=in_progress&status=failed
GET /v1/runs?cursor=<opaque-cursor>
```

Repeated values within the same filter field combine with OR. Different filter fields combine with AND. Unknown query fields and enum values outside the contract return `400 validation_error`. A project id the tenant does not own returns an empty page rather than an authorization oracle or cross-tenant data.

The response remains a collection envelope and adds `nextCursor` only when there are more matching rows:

```json
{
  "runs": [
    {
      "id": "run_123",
      "topicId": "topic_123",
      "tenant": "tenant_dev",
      "trackedIssue": { "number": 133, "title": "Filter runs" },
      "workKind": "enhancement",
      "currentStep": "spec.human_review",
      "terminal": false,
      "waitingOn": "human",
      "status": "in_progress",
      "projectId": "proj_123",
      "createdAt": "2026-11-01T12:00:00.000Z",
      "updatedAt": "2026-11-01T12:05:00.000Z"
    }
  ],
  "nextCursor": "opaque"
}
```

### Row data consistency

`GET /v1/runs`, `GET /v1/runs/:id`, and the run embedded in a reply response use the same mapping function, so `waitingOn`, `status`, and `projectId` agree for a given run. Conversation-creation responses and run events continue to carry the persisted/orchestrator run shape and do not claim `status` or `projectId`; clients treat run state-transition events as invalidation triggers and re-read the run when they need row data.

### Paging behavior

Default page size is 100 and the maximum accepted `limit` is 100. Ordering stays newest to oldest by `createdAt`, with run id as the deterministic tie-breaker. Cursors are opaque to clients and encode the ordering position needed to request the next page. Invalid or malformed cursors return `400 validation_error`.

## Technical changes

### Affected files

- `packages/api-contract/src/run.ts` — add optional `projectId` and `status` on `runSchema`, define status enum, query schema, list response with optional `nextCursor`, and exported types/constants.
- `packages/api-contract/src/openapi.ts` and OpenAPI tests — document filters, paging, new fields, `nextCursor`, and `400 validation_error`.
- `packages/core/src/routes.ts` — parse and validate `GET /v1/runs` query parameters with the existing validation helper and pass normalized options into the service.
- `packages/core/src/control-plane-service.ts` — derive `status`, join/project-map `projectId`, and use one mapper for list/get/reply responses.
- `packages/core/src/domain-repositories.ts` — extend `RunRepository.listByTenant` options with filters, limit, and cursor/page behavior.
- `packages/persistence/src/domain-repositories.ts` — push filters, project join, ordering, cursor predicate, and limit-plus-one pagination into the database query.
- `packages/sdk/src/client.ts` — keep `listRuns()` working with no arguments and add optional filters, `limit`, and `cursor` arguments parsed through the contract response schema.
- `context-agent/wiki/code-map.md` — record the run row fields, filter query, cursor behavior, and repository method.

### Changes

#### Contract and status derivation

Add a `runStatusSchema` enum with `in_progress`, `done`, `failed`, and `canceled`. Add `status?: RunStatus` and `projectId?: string` to `runSchema` so persistence parses stored rows and event payloads that do not have API-only read fields. The read mapper always fills both fields for list/get/reply responses.

Status is derived from the current run state, not stored as a new database field:

1. If the run is not terminal, status is `in_progress`.
2. If the terminal current step is `done`, status is `done`.
3. If the terminal current step is `failed`, status is `failed`.
4. If the terminal current step is `canceled`, status is `canceled`.

#### Query contract

Define a strict query schema for `GET /v1/runs` with:

- `status`: repeatable `runStatusSchema` values.
- `waitingOn`: repeatable values from the same waiting-on enum already used by run mapping.
- `workKind`: repeatable work-kind values.
- `projectId`: repeatable project ids.
- `limit`: positive integer, default 100, maximum 100.
- `cursor`: opaque string.

The route must reject unknown query fields and invalid values through the existing validation helper so callers receive `400 validation_error`.

#### Repository paging and filtering

`RunRepository.listByTenant(tenant, options?)` should return a page result such as `{ runs, nextCursor? }` or an equivalent internal shape. Filters must be applied in the SQL query before the page is selected. The implementation should request `limit + 1` rows, return at most `limit`, and emit `nextCursor` only when the extra row proves that more matches exist.

The repository query must remain tenant-scoped and order by `runs.createdAt DESC, runs.id DESC`. Cursor predicates must continue that ordering, for example: rows where `createdAt < cursor.createdAt` OR `createdAt = cursor.createdAt AND id < cursor.id`. The cursor should encode only the minimal ordered-position data and should be authenticated or otherwise robust against malformed input; malformed or undecodable cursors surface as validation errors, not internal faults.

Project filtering and `projectId` row data require joining from run to topic to conversation/project in a constant number of queries for the page. Do not read one conversation/topic/project per run. If the tenant does not own the requested project id, the join plus tenant predicate naturally returns an empty list.

`waitingOn` filtering may be implemented with the same deterministic step-catalog logic used by `mapRunToApiRun`, but it still must filter before page selection. If the value is not directly stored, translate filter values into current-step predicates or a database-compatible expression derived from the catalog instead of loading 100 rows and filtering in memory.

#### Service and response mapping

Keep a single `mapRunToApiRun`-style function as the source for API-only row fields. Extend it to accept enough page row context to set `projectId`, and to derive `status` from `currentStep` and `terminal`. Use it for:

- `GET /v1/runs` rows.
- `GET /v1/runs/:id`.
- The run in a reply response.

Do not change run events to carry `status` or `projectId`. Do not make conversation-creation responses fail validation because those runs lack the new optional fields.

#### SDK and OpenAPI

`ControlPlaneClient.listRuns()` remains callable with no arguments and returns the newest default page. It also accepts an optional argument containing filter arrays or single values, `limit`, and `cursor`; serializes repeated query parameters; parses the response through the shared contract schema; and exposes `nextCursor` in the return type. OpenAPI must list all query fields, the new response fields, `nextCursor`, and the `400 validation_error` response.

#### Security, privacy, and compliance

Authentication and authorization remain the existing bearer principal and policy path for run collection reads. Tenant scoping is mandatory in the repository query and must not rely on client-supplied tenant data. Unknown project ids return empty pages to avoid cross-tenant disclosure. Query parsing must be strict to prevent unexpected fields from silently changing behavior. Cursors are opaque and must not expose sensitive tenant data; if they encode timestamps/ids, those values are already visible in run rows but should still be treated as implementation details.

#### Observability

No new metrics are required for this slice. Existing route logging/error handling should surface validation failures and unexpected repository failures. Tests should be the primary proof of filter/paging behavior.

#### Testing plan

- Contract tests for optional run fields, query schema parsing, invalid filters, invalid cursors, and list response `nextCursor`.
- Persistence tests proving tenant-scoped SQL filtering before paging, 105-run cursor paging with no duplicates/missing rows, project filtering beyond the newest 100, and constant-query project resolution for a 100-run page.
- Service/route tests proving list/get row mapping matches for the same run, invalid query fields return `400 validation_error`, and unknown tenant project ids return empty lists.
- SDK tests for no-argument `listRuns()`, filter/limit/cursor serialization, error handling, and response parsing.
- OpenAPI tests asserting query fields, response fields, and `400`.
- Production-server wiring tests that create runs through `POST /v1/conversations` in two projects and list by project/status/repeated status values.
- Transition-driven tests for `status=failed` and `waitingOn=human`; do not create those states by direct repository writes.
- Consumer-shape tests confirming conversation creation and run events still parse without `status`/`projectId`, while get/reply responses include them.
- No tests may make model calls; use fake mode, stubs, or deterministic service transitions.

#### Alternatives considered

- Keep filtering in the client: rejected because the client cannot filter runs omitted by the newest-100 cap.
- Load the newest 100 then filter in memory: rejected because old matching rows would still be hidden.
- Make `status` and `projectId` required in `runSchema`: rejected because stored runs and run events parse through the same strict schema and do not contain API-only read fields.
- Add server-side grouping/sorting/saved views now: rejected as out of scope; the browser owns grouping, sorting, and view configuration for this issue.

#### Risks

- Translating `waitingOn` into SQL-compatible predicates can drift from step-catalog mapping. Mitigate with tests for real service transitions and shared catalog-derived helper code.
- Cursor implementation can produce duplicates or gaps if tie-break logic diverges from ordering. Mitigate with the 105-run pagination test and same-timestamp cases.
- Project joins can accidentally become N+1. Mitigate with query-count or repository-level assertions for a 100-run page.
- Optional API-only fields could be mistaken as persisted fields. Mitigate by documenting mapper ownership and consumer-shape tests.

## Task list

- [ ] **Story: Contract and validation surface**
  - [ ] **Task: Add run row fields and list query schemas**
    - **Description**: Extend `packages/api-contract/src/run.ts` with optional `projectId` and `status` on `runSchema`, a `runStatusSchema`, strict list-runs query parsing for repeatable filters, `limit`, and `cursor`, and a list response schema that includes optional `nextCursor`. Keep system/persistence compatibility by making API-only fields optional.
    - **Acceptance criteria**:
      - [ ] `runSchema` accepts stored/event runs without `projectId` or `status`.
      - [ ] `runSchema` accepts API read runs with `projectId` and `status`.
      - [ ] Status values are limited to `in_progress`, `done`, `failed`, and `canceled`.
      - [ ] Query schema accepts repeated `status`, `waitingOn`, `workKind`, and `projectId` values plus `limit` and `cursor`.
      - [ ] Query schema rejects unknown fields, invalid enum values, non-positive limits, limits above 100, and malformed cursors.
    - **Dependencies**: None
  - [ ] **Task: Document OpenAPI changes**
    - **Description**: Update the OpenAPI generation/registration for `GET /v1/runs` so it lists all query fields, new response fields, optional `nextCursor`, and `400 validation_error`. Add or update OpenAPI assertions.
    - **Acceptance criteria**:
      - [ ] OpenAPI documents `status`, `waitingOn`, `workKind`, `projectId`, `limit`, and `cursor` query parameters.
      - [ ] OpenAPI documents `status`, `projectId`, and `nextCursor` in successful responses.
      - [ ] OpenAPI documents `400 validation_error` for invalid query input.
      - [ ] `openapi.spec.ts` or the nearest existing OpenAPI test asserts the new contract.
    - **Dependencies**: "Task: Add run row fields and list query schemas"

- [ ] **Story: Repository filtering and cursor paging**
  - [ ] **Task: Extend the run repository list contract**
    - **Description**: Update the core `RunRepository.listByTenant` interface and related option/result types to carry normalized filters, `limit`, and cursor page position while preserving no-argument/default behavior.
    - **Acceptance criteria**:
      - [ ] The interface supports filters for status, waitingOn, workKind, and projectId.
      - [ ] The interface supports default limit 100, explicit limit up to 100, and optional cursor.
      - [ ] The result type can return `nextCursor` only when more rows match.
      - [ ] Existing callers compile and default to the newest page.
    - **Dependencies**: "Task: Add run row fields and list query schemas"
  - [ ] **Task: Implement SQL-level filters and paging**
    - **Description**: Update `DrizzleRunRepository.listByTenant` to apply tenant scoping, filter predicates, project join, status/waitingOn derivation predicates, newest-first ordering, run-id tie-break, cursor predicate, and limit-plus-one pagination in the database query.
    - **Acceptance criteria**:
      - [ ] Filtering happens before page selection, not after loading the newest page.
      - [ ] Ordering is `createdAt` descending with run id as tie-break.
      - [ ] Default page size is 100 and `nextCursor` is emitted only when an extra matching row exists.
      - [ ] Following `nextCursor` returns the next page with no duplicates or missing rows.
      - [ ] Project ids for a 100-run page are read in a constant number of queries, not one query per run.
      - [ ] A project id outside the tenant returns an empty list.
    - **Dependencies**: "Task: Extend the run repository list contract"
  - [ ] **Task: Add persistence coverage for old matches and paging**
    - **Description**: Add repository tests that create enough runs to exceed the default page and prove filters and cursor paging work against persisted data.
    - **Acceptance criteria**:
      - [ ] A test creates 105 runs, lists without `limit`, sees 100 plus `nextCursor`, follows it, sees five and no `nextCursor`, with no duplicates or omissions.
      - [ ] A filter matching an old run beyond the newest 100 still returns that run.
      - [ ] A project filter does not leak runs from another tenant.
      - [ ] A query-count or equivalent assertion proves project resolution is constant-query for a 100-run page.
    - **Dependencies**: "Task: Implement SQL-level filters and paging"

- [ ] **Story: Service mapping and HTTP route behavior**
  - [ ] **Task: Extend API run mapping with status and project id**
    - **Description**: Extend the existing `mapRunToApiRun` path so it derives `status`, fills `projectId` from conversation/topic context, and remains the single mapper used by list, get, and reply responses.
    - **Acceptance criteria**:
      - [ ] Non-terminal runs map to `status: in_progress`.
      - [ ] Terminal `done`, `failed`, and `canceled` runs map to matching statuses.
      - [ ] List, get, and reply responses use the same mapper.
      - [ ] A test shows list and get responses match for the same run's row fields.
      - [ ] Conversation-creation responses and run events still parse without `status` or `projectId`.
    - **Dependencies**: "Task: Implement SQL-level filters and paging"
  - [ ] **Task: Wire validated list query parameters through the route and service**
    - **Description**: Update `GET /v1/runs` route parsing to use the strict contract query schema and pass normalized filters, `limit`, and `cursor` into `ControlPlaneService.listRuns`. Preserve existing auth/policy behavior.
    - **Acceptance criteria**:
      - [ ] `GET /v1/runs` accepts all specified filters, repeated values, `limit`, and `cursor`.
      - [ ] Repeated values within a field combine with OR and different fields combine with AND.
      - [ ] Unknown query fields and invalid values return `400 validation_error`.
      - [ ] Invalid cursor values return `400 validation_error`.
      - [ ] No route accepts tenant from query input.
    - **Dependencies**: "Task: Extend API run mapping with status and project id"
  - [ ] **Task: Add transition-driven route/service tests**
    - **Description**: Cover status and waiting-on filters using real service transitions rather than direct repository writes, and cover consumer shape differences explicitly.
    - **Acceptance criteria**:
      - [ ] A `status=failed` filter returns runs driven to failed through the service transition path.
      - [ ] A `waitingOn=human` filter returns runs driven to a human-waiting state through the service transition path.
      - [ ] Tests state that run events do not carry `status` or `projectId`.
      - [ ] Tests state that get/reply responses do carry `status` and `projectId`.
      - [ ] No test makes a model call.
    - **Dependencies**: "Task: Wire validated list query parameters through the route and service"

- [ ] **Story: SDK client support**
  - [ ] **Task: Add optional listRuns arguments and response typing**
    - **Description**: Update `ControlPlaneClient.listRuns()` so the no-argument call continues to fetch the newest page and an optional argument serializes filters, `limit`, and `cursor` as query parameters. Parse success responses through the shared list response schema and expose `nextCursor`.
    - **Acceptance criteria**:
      - [ ] Existing `listRuns()` callers require no changes.
      - [ ] Filter arrays or repeated values serialize as repeated query parameters.
      - [ ] `limit` and `cursor` serialize correctly.
      - [ ] Success responses parse through the contract schema.
      - [ ] The returned TypeScript type includes `nextCursor`.
    - **Dependencies**: "Task: Add run row fields and list query schemas"
  - [ ] **Task: Add SDK tests for filtered and paged listing**
    - **Description**: Extend SDK tests to cover no-argument listing, filter serialization, cursor following input, response parsing, and shared error handling.
    - **Acceptance criteria**:
      - [ ] No-argument `listRuns()` sends `GET /v1/runs` with no query string.
      - [ ] Filtered calls send repeated query parameters for repeated filters.
      - [ ] `limit` and `cursor` appear in the request URL when supplied.
      - [ ] Responses with `nextCursor` parse and return it.
      - [ ] Non-OK responses continue using existing SDK error behavior.
    - **Dependencies**: "Task: Add optional listRuns arguments and response typing"

- [ ] **Story: Production wiring and documentation**
  - [ ] **Task: Add production-server wiring coverage**
    - **Description**: Add or extend a wiring/e2e test that uses the production server, creates runs in two projects through `POST /v1/conversations`, then lists by project, by `status=in_progress`, and by repeated statuses.
    - **Acceptance criteria**:
      - [ ] The test creates runs in two projects through the public conversation endpoint.
      - [ ] Listing with each `projectId` returns only that project's runs.
      - [ ] Listing with `status=in_progress` returns the expected active runs.
      - [ ] Listing with repeated `status` values returns OR-combined results.
      - [ ] Each row assertion covers issue number, title, work kind, status, `waitingOn`, `projectId`, and `createdAt`.
      - [ ] The test runs without model calls.
    - **Dependencies**: "Task: Wire validated list query parameters through the route and service", "Task: Add optional listRuns arguments and response typing"
  - [ ] **Task: Update agent code map documentation**
    - **Description**: Update `context-agent/wiki/code-map.md` with the new run row fields, list filter query, cursor behavior, and repository method location so future agents can find the implementation.
    - **Acceptance criteria**:
      - [ ] The code map names `status` and `projectId` as API read fields on runs.
      - [ ] The code map documents `GET /v1/runs` filters and paging cursor.
      - [ ] The code map points to the repository method that performs database filtering and paging.
      - [ ] The documentation does not claim run events carry `status` or `projectId`.
    - **Dependencies**: "Task: Implement SQL-level filters and paging", "Task: Extend API run mapping with status and project id"
