---
created: 2026-06-12
last_updated: 2026-06-12
status: implementing
issue: 41
specced_by: autocatalyst
---
# Enhancement: Expose the spec-review API surface for a run

## Product requirements

### Summary

Expose the spec-review state that issue 39 made real inside core through the `/v1` API and SDK. A client can read a run's current spec artifact, see that a run is waiting on a human at the spec gate, and create or list feedback items against the run's spec. This enhancement keeps the existing spec artifact and feedback lifecycle behavior, but makes the initial review loop reachable over the network.
### Parent feature

This enhances `feature-spec-artifact-feedback-gate.md`, which introduced file-canonical spec artifacts, first-class artifact feedback, and the `spec.human_review` gate. That feature deliberately kept public HTTP feedback lifecycle routes out of scope. This enhancement exposes the read and create/list parts needed by an interim client to review a generated spec.
### Current behavior

Feature and enhancement runs can author a committed spec file, persist a spec `Artifact`, and pause at `spec.human_review`. Core already has services for committed spec frontmatter parsing, spec authoring, artifact feedback creation and lifecycle transitions, and gate blocking while artifact feedback is open or addressed.
The network API does not expose this state. `packages/core/src/routes.ts` registers run reads, run steps, and run events, but no artifact/spec or feedback routes. `DefaultControlPlaneService` exposes `listRuns`, `getRun`, `listRunSteps`, and run event methods, but no spec read or feedback methods. `GET /v1/runs/:id` and `GET /v1/runs` return `runSchema`, which includes `currentStep` but does not include the current step's `waitingOn` value from `run-step-catalog.ts`.
### Proposed behavior

Add three API capabilities under `/v1`:
1. `GET /v1/runs/:id/spec` returns the run's current file-canonical spec artifact, rendered markdown from the committed spec file, parsed committed frontmatter, and the artifact's `cachedStatus`.
2. `GET /v1/runs/:id` and `GET /v1/runs` include `waitingOn`, derived from the current step's catalog entry, so clients can distinguish a human pause from active AI or system work.
3. `POST /v1/runs/:id/feedback` creates a feedback item for the run, and `GET /v1/runs/:id/feedback` lists the run's feedback items.
All routes are tenant-scoped. A run in another tenant returns a not-found response for the spec and feedback surfaces rather than leaking that the run exists. The API contract package owns the new Zod schemas and paths, the control-plane service owns the authorization and repository access, routes expose the service over Fastify, and the SDK adds typed methods matching the existing run-read pattern.
### Why

The spec-review gate is useful only if a client can inspect what is waiting for review and record review feedback. Issue 39 created the core model, but left the interim UX without the API surface required to run the checkpoint. Exposing the current spec, run `waitingOn`, and feedback create/list operations lets a desktop app, mobile app, or external client participate in the spec review without reaching into core internals or the workspace filesystem directly.
### Goals

- A client can read a run's current spec over HTTP as markdown, parsed frontmatter, and artifact cached status.
- A client can tell from run reads whether the current step is waiting on `system`, `ai`, `human`, or `none`.
- A client can create and list feedback items for a run through the API and SDK.
- Tenant scoping is enforced consistently: cross-tenant access returns 404 for spec and feedback reads/writes.
- The existing spec-review gate behavior remains unchanged: open or addressed artifact feedback continues to block advancement.
### User stories

- As Phoebe, I want to read a generated spec through the API, so that I can review it without checking out the workspace branch manually.
- As Phoebe, I want the run read to show `waitingOn: human`, so that I know the run is paused for my review rather than still running.
- As Phoebe, I want to create feedback against the spec, so that my requested changes become tracked items that block the gate until handled.
- As Phoebe, I want to list existing feedback for the run, so that I can see what is still open before approving.
- As Enzo, I want the API schemas and SDK methods to be typed from `packages/api-contract`, so that clients use the same contract as routes and tests.
- As Opal, I want tenant-scoped not-found behavior, so that one tenant cannot infer another tenant's run or spec exists.
### Acceptance criteria

#### Read the current spec

- `GET /v1/runs/:id/spec` returns the run's current spec artifact as rendered markdown, parsed frontmatter, and the artifact's `cachedStatus`.
- The committed spec file at the artifact's `location` is the source for markdown and frontmatter.
- Frontmatter is parsed with the existing committed spec parser and schema in `packages/core/src/spec-frontmatter.ts` and `packages/api-contract/src/spec-authoring.ts`.
- `cachedStatus` comes from the `Artifact` row, not from reparsing the file.
- A run in another tenant returns 404 rather than the spec.
- A run with no current spec artifact returns 404 with the standard error envelope.
- The response shape is a Zod schema in `packages/api-contract`.
- `packages/sdk/src/client.ts` exposes a typed method for the endpoint.
#### Surface gate state on run reads

- `GET /v1/runs/:id` includes `waitingOn`, derived from the current step's catalog entry.
- `GET /v1/runs` includes `waitingOn` for each returned run.
- The value is one of `system`, `ai`, `human`, or `none`.
- A run paused at `currentStep: spec.human_review` returns `waitingOn: human`.
- The field is added additively to `runSchema`; existing fields remain unchanged and no existing field becomes stricter.
#### Feedback create and list

- `POST /v1/runs/:id/feedback` creates a feedback item scoped to the run and tenant.
- The create request accepts a target, title, body, and optional anchor. The initial thread is authored by the authenticated principal.
- The spec-review use case creates feedback with `target: artifact`.
- `GET /v1/runs/:id/feedback` lists feedback items for the run, tenant-scoped.
- Both endpoints route through `DefaultControlPlaneService` to the existing `FeedbackRepository` and feedback lifecycle use cases where appropriate.
- Both endpoints reuse the existing `feedback.ts` contract schemas rather than duplicating entity shapes.
- The SDK exposes typed methods for create and list.
#### Existing gate behavior

- The open-feedback completion gate from issue 39 is unchanged.
- An open or addressed feedback item on `target: artifact` still keeps the run from advancing past `spec.human_review`.
- This enhancement does not add lifecycle transitions such as resolve, reopen, or `wont_fix` over HTTP.
#### General

- Integration tests in `apps/control-plane` exercise each new endpoint end to end over HTTP with a bearer principal.
- Integration tests cover reading a spec, seeing `waitingOn` on run reads, posting feedback, listing it back, and cross-tenant 404 behavior.
- `context-agent/wiki/code-map.md` is updated during implementation for the new routes, service methods, API schemas, and SDK methods.
### Non-functional requirements

- **Security:** Routes must not expose raw workspace absolute paths, secrets, provider output, prompt content, or filesystem errors. Cross-tenant access to spec and feedback endpoints returns 404.
- **Compatibility:** The API evolves additively under `/v1`. Existing run fields and existing SDK methods keep their current behavior.
- **Consistency:** Spec markdown and frontmatter are read from the committed file at the artifact location. The artifact row remains the source for `cachedStatus`.
- **Reliability:** A missing spec artifact, missing spec file, malformed frontmatter, or unknown current step returns a safe error envelope rather than an uncaught exception.
- **Performance:** Spec reads perform one run lookup, one artifact lookup, and one file read. No new latency target is required for this slice.
### Impact on existing behavior

- **Changed behaviors:** Run read responses include a new `waitingOn` field. No existing field is removed or renamed.
- **Affected user stories:** The parent feature's review stories become reachable by API clients for spec read and feedback creation/listing.
- **Migration / compatibility concerns:** Existing persisted run rows do not need migration because `waitingOn` is derived at read time from `currentStep`. Existing clients that ignore unknown JSON fields continue to work.
### Out of scope

- Human reply classification that turns a message into `advance` or `revise`.
- Moving feedback through `addressed`, `resolved`, `wont_fix`, or reopened states over HTTP.
- Re-dispatching the spec authoring step to revise the spec after feedback.
- In-step adversarial convergence review findings.
- A desktop, mobile, or web UI for reviewing the spec.
- Changing the spec artifact authoring behavior from issue 39.
### Devil's advocate pass

- **Spec reads can leak filesystem details if errors are forwarded directly.** The implementation must convert file and frontmatter failures into standard safe envelopes and keep absolute workspace paths out of responses and logs.
- **Run ****`waitingOn`**** must not become a second source of truth.** It should be derived from `run-step-catalog.ts` on each read rather than persisted to the run row.
- **Feedback creation could accidentally become a lifecycle mutation endpoint.** This slice should create and list only. Resolution, reopening, and approval semantics remain in the existing core gate paths and later HITL work.
- **Cross-tenant behavior is stricter than existing ****`getRun`**** behavior.** Current run reads may distinguish forbidden from missing. This enhancement explicitly requires not-found behavior for spec and feedback surfaces so child resources do not reveal another tenant's run.
### Reviewer pass

This enhancement fits the parent feature because it surfaces the already-built spec artifact and feedback model without changing the workflow. It aligns with ADR-006 by adding endpoints and additive response fields under `/v1`. It aligns with ADR-007 by keeping request and response shapes in `api-contract`. It aligns with ADR-018 by treating feedback as first-class run-parented records, and with `feedback.md` by preserving the existing gate precondition.
## Design spec

### Design scope

This is a backend API design. It adds no visual screens, components, or design-system tokens. The design covers client-facing HTTP flows, response states, and SDK interactions that an interim review client can use.
### Goals of the design

- Make the spec review checkpoint understandable through ordinary REST reads.
- Keep clients away from workspace internals by returning rendered spec content through the service.
- Let clients record and review feedback items without owning the feedback lifecycle state machine.
### User flows

#### Flow 1: Client discovers a run is waiting for spec review

1. The client calls `GET /v1/runs/:id` or `GET /v1/runs`.
2. The API returns the run with its existing fields and `waitingOn` derived from the current step.
3. If the run is at `spec.human_review`, the response includes `currentStep: "spec.human_review"` and `waitingOn: "human"`.
4. The client chooses the spec review view or notification path based on `waitingOn: human`.
#### Flow 2: Client reads the generated spec

1. The client calls `GET /v1/runs/:id/spec`.
2. The service verifies the run exists for the caller's tenant.
3. The service finds the run's current `feature_spec` or `enhancement_spec` artifact with `canonicalRecord: file`.
4. The service reads the committed markdown file at the artifact location from the run workspace or repository path available to trusted core services.
5. The service parses the frontmatter and returns markdown, frontmatter, and artifact cached status.
6. If the run has no spec artifact, the service returns 404.
#### Flow 3: Client creates spec feedback

1. The reviewer submits a feedback request with `target: "artifact"`, title, body, and optional anchor.
2. The route authenticates the bearer principal and passes the caller as the feedback author.
3. The service verifies the run belongs to the caller's tenant.
4. The feedback lifecycle create path writes an `open` feedback item with an initial thread entry.
5. The endpoint returns the created feedback item.
6. The existing spec gate continues to block while the item is open.
#### Flow 4: Client lists feedback for the run

1. The client calls `GET /v1/runs/:id/feedback`.
2. The service verifies the run belongs to the caller's tenant.
3. The service returns all feedback items for the run.
4. The client filters or groups items by target and status as needed.
### Response states and interactions

- `GET /v1/runs/:id/spec` returns `200` when a file-canonical spec artifact exists and the file can be parsed.
- `GET /v1/runs/:id/spec` returns `404` when the run is missing, inaccessible to the tenant, or has no current spec artifact.
- `GET /v1/runs/:id/spec` returns a safe server error if the artifact points at a missing or malformed committed file. The response must not include absolute paths.
- `POST /v1/runs/:id/feedback` returns the created `Feedback` item with `status: open`.
- `GET /v1/runs/:id/feedback` returns `{ feedback: [...] }` or the equivalent contract-owned collection wrapper.
- Validation errors use the existing validation error envelope.
### Components and interactions

- **Run read decoration:** A small mapper converts persisted `Run` entities into API runs by adding `waitingOn` from `getRunStepDefinition(run.currentStep)`.
- **Spec read service method:** A control-plane service method validates tenant access, locates the current spec artifact, reads the committed spec file, parses frontmatter, and returns a contract-owned response.
- **Feedback create service method:** A control-plane service method validates tenant access and creates feedback through the feedback lifecycle create use case, using the authenticated non-model principal as author.
- **Feedback list service method:** A control-plane service method validates tenant access and lists repository feedback for the run.
- **Routes:** Fastify handlers parse params and bodies with contract schemas, call service methods, and map service errors to standard envelopes.
- **SDK methods:** The SDK adds `getRunSpec(id)`, `createRunFeedback(id, request)`, and `listRunFeedback(id)` or equivalent names that match existing client style.
### Accessibility and responsive behavior

No UI behavior is introduced. Future review clients should expose `waitingOn`, spec content, and feedback statuses with clear labels, keyboard-accessible feedback creation, and screen-reader-readable status changes.
### Design system updates

None.
### Reviewer pass

The design covers each acceptance criterion without inventing lifecycle actions beyond create and list. The main design risk is the spec file read boundary: the API must return markdown from the committed spec file while still hiding absolute workspace paths. Implementation should reuse the internal workspace/repository file access seam introduced for spec authoring or add a narrow trusted file-read port rather than letting routes read paths directly.
## Tech spec

### Overview

Per ADR-006 and ADR-007, this enhancement extends `/v1` additively using Zod schemas in `packages/api-contract`. Per ADR-017, the committed spec file remains the document source of truth, while the `Artifact` row supplies operational metadata such as `cachedStatus`. Per ADR-018, feedback remains a first-class run child that gates human review. The implementation adds contract schemas, control-plane service methods, Fastify routes, SDK methods, and integration tests around the existing Artifact, Feedback, spec frontmatter, and run-step catalog modules.
### Architecture

#### Components

- `packages/api-contract/src/run.ts` adds a `waitingOn` schema and field to the run response shape.
- `packages/api-contract/src/artifact.ts` or a new `run-spec.ts` module defines `GET /v1/runs/:id/spec` path constants and response schema.
- `packages/api-contract/src/feedback.ts` adds route-level create and list schemas for run feedback while continuing to export the entity schemas.
- `packages/core/src/control-plane-service.ts` adds service methods for spec read, feedback create, and feedback list.
- `packages/core/src/routes.ts` registers the new routes under the existing authenticated `/v1` group.
- `packages/core/src/run-step-catalog.ts` remains the source for `waitingOn` derivation.
- `packages/core/src/spec-frontmatter.ts` parses committed spec frontmatter for spec reads.
- `packages/core/src/feedback-lifecycle.ts` remains the creation path for artifact feedback.
- `packages/sdk/src/client.ts` adds typed client methods using the new contract schemas.
- `apps/control-plane/src/integration.spec.ts` or a focused integration spec exercises the HTTP surface end to end.
#### Boundaries

Routes do not read repositories or files directly. They parse HTTP inputs, obtain the authenticated principal, call `ControlPlaneService`, and serialize contract-validated responses.
The control-plane service owns tenant checks. For spec and feedback child resources, a run that is missing or belongs to another tenant maps to `not_found`. This avoids leaking cross-tenant existence through child resource endpoints.
Core file access for spec reads should go through a narrow trusted port, not ad hoc `fs` calls in route handlers. The port should read only the artifact's committed relative path under an approved repository/workspace root. Responses include the relative artifact location only if the contract includes it; they never include absolute workspace paths.
#### Data flow

1. A client sends an authenticated request with a bearer principal.
2. The route validates path params and body against `api-contract` schemas.
3. The service loads the run and verifies `run.tenant === principal.tenantId`.
4. For run reads, the service maps each run to include `waitingOn` from `getRunStepDefinition(run.currentStep)`.
5. For spec reads, the service finds the current spec artifact, reads the committed markdown file, parses frontmatter, and returns the response.
6. For feedback create, the service builds the lifecycle input from the request, run owner/tenant, and authenticated principal, then calls `createArtifactFeedback` or a generalized create use case.
7. For feedback list, the service returns `FeedbackRepository.listByRun(run.id)` after tenant verification.
8. The SDK validates request bodies before sending and validates responses after receiving, matching existing SDK style.
#### Integration points

- Existing domain repositories: `RunRepository`, `ArtifactRepository`, and `FeedbackRepository`.
- Existing spec frontmatter parser: `parseSpecFrontmatter` and `specAuthorFrontmatterSchema`.
- Existing error envelope and status code constants from `packages/api-contract/src/errors.ts`.
- Existing bearer principal attachment and policy authorization in control-plane routes.
- New policy action/resource variants in `packages/core/src/policy.ts` for the child-resource endpoints: `run_spec.read` on `{ kind: 'run_spec', id, path: '/v1/runs/:id/spec' }`, `run_feedback.create` on `{ kind: 'run_feedback', id, path: '/v1/runs/:id/feedback' }`, and `run_feedback.list` on the same `run_feedback` resource descriptor.
- Existing control-plane integration test scaffolding with real SQLite persistence and Fastify injection or HTTP client.
### Data model

No database migration is required.
#### Run response model

`waitingOn` is derived and not persisted. Add a contract schema such as:
```typescript
export const waitingOnSchema = z.enum(['system', 'ai', 'human', 'none']);

export const runSchema = z.object({
  // existing fields unchanged
  waitingOn: waitingOnSchema.optional()
}).strict().superRefine(requireTenantMatchesOwner);
```
The schema field is optional for additive compatibility, but service responses should populate it for `GET /v1/runs/:id`, `GET /v1/runs`, and conversation-ingress responses if those responses reuse `runSchema` and can be safely decorated. If a run has an unknown `currentStep`, the service should either return `waitingOn: system` only by explicit fallback decision or fail safely with a sanitized internal error. Because the step catalog is authoritative, silently inventing a value is discouraged.
#### Spec read model

The spec read response should include:
```typescript
export const runSpecResponseSchema = z.object({
  artifact: artifactSchema,
  markdown: z.string(),
  frontmatter: specAuthorFrontmatterSchema,
  cachedStatus: artifactCachedStatusSchema
}).strict();
```
`cachedStatus` duplicates `artifact.cachedStatus` for client convenience and to satisfy the issue's explicit contract. The implementation may include only the artifact fields needed by clients if the contract defines a smaller artifact summary, but it should avoid creating a second status enum.
The service selects the current spec artifact by run work kind:
- `feature` runs read `kind: feature_spec`.
- `enhancement` runs read `kind: enhancement_spec`.
- Other run kinds return 404 unless they later gain file-canonical specs.
The artifact must have `canonicalRecord: file`. Its `location` must be a relative path under `context-human/specs/` and must match the committed spec path constraints.
#### Feedback request and list model

The create endpoint should accept a narrow request instead of a raw `CreateFeedbackInput`, because the server owns run id, tenant, owner, status, and initial thread metadata:
```typescript
export const createRunFeedbackRequestSchema = z.object({
  target: z.literal('artifact'),
  title: z.string().min(1),
  body: z.string().min(1),
  anchor: feedbackAnchorSchema.optional()
}).strict();

export const runFeedbackListResponseSchema = z.object({
  feedback: z.array(feedbackSchema)
}).strict();
```
For issue 41, `target: artifact` is required and the route-level schema restricts the initial endpoint to `artifact`. The API can widen this additively later if other run feedback targets become product requirements.
### API contracts

#### `GET /v1/runs/:id/spec`

- **Auth:** Bearer principal required.
- **Authorization:** `run_spec.read` on a `run_spec` child resource descriptor. The service still enforces tenant ownership.
- **Success:** `200 OK` with `runSpecResponseSchema`.
- **Not found:** `404` when the run is absent, cross-tenant, unsupported for spec reads, or has no current spec artifact.
- **Server error:** Standard internal error envelope for missing files, malformed frontmatter, or file-read failures.
Example response:
```json
{
  "artifact": {
    "id": "art_123",
    "runId": "run_123",
    "owner": { "kind": "human", "id": "user_1", "displayName": "Phoebe", "tenantId": "tenant_1" },
    "tenant": "tenant_1",
    "kind": "enhancement_spec",
    "canonicalRecord": "file",
    "location": "context-human/specs/enhancement-spec-review-api-surface.md",
    "cachedStatus": "draft",
    "publicationRefs": [],
    "createdAt": "2026-06-12T00:00:00.000Z",
    "updatedAt": "2026-06-12T00:00:00.000Z"
  },
  "markdown": "---\ncreated: 2026-06-12\n...",
  "frontmatter": {
    "created": "2026-06-12",
    "last_updated": "2026-06-12",
    "status": "draft",
    "issue": 41,
    "specced_by": "autocatalyst"
  },
  "cachedStatus": "draft"
}
```
#### `GET /v1/runs/:id`

- **Change:** Existing response gains `waitingOn`.
- **Success example:** A spec review pause returns `currentStep: "spec.human_review"` and `waitingOn: "human"`.
- **Compatibility:** Existing fields and status codes remain unchanged.
#### `GET /v1/runs`

- **Change:** Each run in the list gains `waitingOn`.
- **Compatibility:** Existing filters, if any, and response wrapper remain unchanged.
#### `POST /v1/runs/:id/feedback`

- **Auth:** Bearer principal required and must be a non-model principal for authorship.
- **Authorization:** `run_feedback.create` on a `run_feedback` child resource descriptor.
- **Request:** `createRunFeedbackRequestSchema`.
- **Success:** `201 Created` or existing create status convention with `feedbackSchema`.
- **Not found:** `404` when the run is absent or cross-tenant.
- **Validation:** `400` for invalid body or unsupported target.
#### `GET /v1/runs/:id/feedback`

- **Auth:** Bearer principal required.
- **Authorization:** `run_feedback.list` on a `run_feedback` child resource descriptor.
- **Success:** `200 OK` with `{ "feedback": [...] }`.
- **Not found:** `404` when the run is absent or cross-tenant.
### Implementation plan

First, extend `api-contract` with the route constants and schemas: `waitingOn`, run spec response, feedback create request, feedback list response, and success status constants. Export them from the package entry point and update OpenAPI generation if it enumerates route contracts manually.
Second, add service-level helpers in core. A run decoration helper should map persisted `Run` values to API `Run` values with `waitingOn`. Service methods should check tenant access, select the spec artifact by run kind, read and parse the spec file through a trusted file-read port, create feedback through lifecycle helpers, and list feedback through the repository. Extend `DefaultControlPlaneServiceOptions` with the concrete dependencies these methods need: `ArtifactRepository`, `FeedbackRepository`, feedback lifecycle dependencies or the existing create use case dependencies, `SpecFileReader`, the id and clock providers used by feedback creation, and any run workspace metadata/root resolver required by the spec file reader.
Third, wire app-level dependencies in `apps/control-plane/src/server.ts`. The server should instantiate the concrete `NodeSpecFileReader` from the existing run workspace metadata/root seam, reuse the existing domain `artifacts` and `feedback` repositories and lifecycle dependency objects, and pass those plus ids/clock into `DefaultControlPlaneService` along with the existing orchestrator, run repositories, events, and policy.
Fourth, register Fastify routes in `packages/core/src/routes.ts`. Route handlers should follow the existing parse/auth/service/error pattern, including validation error responses and `ControlPlaneServiceError` mapping. If child-resource cross-tenant access must return 404, either add a child-resource error mapping path or make service methods throw `not_found` for inaccessible runs.
Fifth, add SDK methods in `packages/sdk/src/client.ts`. Methods should construct paths from contract constants, validate outbound request bodies, throw `ControlPlaneClientError` for error envelopes, and parse responses with the new schemas.
Sixth, add integration tests in `apps/control-plane`. Tests should create or seed a run, spec artifact, committed spec file, and feedback repository state through the existing test seams. The tests should hit the HTTP routes with a bearer token and assert response shapes, tenant scoping, and SDK behavior if the SDK is used in integration tests.
Finally, update `context-agent/wiki/code-map.md` during implementation to point future agents at the new contracts, routes, service methods, and SDK methods.
### Testing strategy

- **Contract tests:** Validate new Zod schemas for run spec response, feedback create request, feedback list response, and run `waitingOn` compatibility.
- **Core unit tests:** Cover run-to-`waitingOn` decoration, current spec artifact selection, no-spec 404 behavior, cross-tenant not-found behavior, and feedback create/list service methods.
- **Route tests:** Cover request validation, status codes, standard error envelopes, and authenticated principal wiring.
- **Integration tests:** In `apps/control-plane`, exercise `GET /v1/runs/:id/spec`, `GET /v1/runs/:id`, `GET /v1/runs`, `POST /v1/runs/:id/feedback`, and `GET /v1/runs/:id/feedback` over HTTP with a bearer principal.
- **Tenant tests:** Assert a cross-tenant spec read and feedback list/create return 404.
- **SDK tests:** Use a mocked fetch or integration client to prove typed methods parse requests and responses.
- **Regression tests:** Verify existing run read/list behavior still passes for clients that do not depend on `waitingOn`.
### Operational concerns

- **Observability:** Log route-level failures with sanitized codes only. Do not log raw markdown, full frontmatter, absolute paths, bearer tokens, or feedback body text at info level.
- **Failure modes:** Missing spec artifact returns 404. Missing file, malformed frontmatter, or file read failure returns a safe internal error unless the implementation defines a more specific safe code. Unknown `currentStep` should be treated as a data integrity problem.
- **Security and privacy:** Child-resource endpoints must not reveal another tenant's run. Feedback bodies may contain sensitive review notes and should be handled as ordinary persisted user content, not diagnostics.
- **Performance:** The spec endpoint reads a markdown file on demand. No cache is required in this slice because the spec review flow is low volume.
- **Rollout:** No feature flag is required. The API changes are additive.
### Open questions

- **Spec file read root wiring:** The API will use the `SpecFileReader` abstraction, but implementation still must choose the concrete root source in `apps/control-plane/src/server.ts` from the existing issue 39 run workspace metadata/root seam. The selected source must allow only committed repository-relative spec paths and must not expose absolute paths.
- **Conversation ingress response:** If conversation creation returns a run using `runSchema`, should it also include `waitingOn` immediately? This is additive and likely consistent, but the issue acceptance criteria only require `GET /v1/runs/:id` and `GET /v1/runs`.
### Devil's advocate pass

The biggest unresolved technical risk is file access. The artifact stores a relative committed location, but API service code still needs a safe way to read the file for the correct run without exposing or trusting arbitrary paths. The implementation should not solve this by putting filesystem logic in routes or by accepting a client-provided path.
A second risk is mixing domain entities and API view models. Adding `waitingOn` to `runSchema` may tempt code to persist it or expect repositories to return it. The implementation should keep a clear mapper between persisted runs and API responses.
A third risk is route scope creep. Once feedback endpoints exist, it is tempting to add resolve or reopen operations. Those lifecycle transitions are out of scope for issue 41 and should remain behind existing core seams until the HITL pause/resume work defines the user action model.
### Reviewer pass

This technical plan follows the existing package boundaries. Contracts live in `api-contract`, service behavior lives in `core`, persistence remains behind repositories, and SDK methods consume the same schemas. The design preserves additive `/v1` evolution and does not change the spec gate's completion rules. The remaining implementation decision is narrow and should be resolved while wiring the concrete file-read root seam.
## Converged API

### Files

Path
Purpose
Exports

`packages/api-contract/src/run.ts`
Add the derived run waiting-state contract to existing run read and list responses while keeping run fields additive. Document the implementation decision that unknown currentStep values are data-integrity errors: service decorators must fail safely with ControlPlaneServiceError('persistence_failed') rather than omitting waitingOn or inventing a fallback.
`waitingOnSchema`, `runSchema`, `RunWaitingOn`, `Run`

`packages/api-contract/src/run-spec.ts`
Define the /v1/runs/:id/spec path constants, success status, and response schema for reading a run's current file-canonical spec artifact.
`runSpecPath`, `getRunSpecSuccessStatusCode`, `runSpecResponseSchema`, `RunSpecResponse`

`packages/api-contract/src/feedback.ts`
Add route-level request/response schemas and path constants for creating and listing run feedback while reusing existing feedback entity schemas.
`runFeedbackPath`, `createRunFeedbackRequestSchema`, `runFeedbackListResponseSchema`, `createRunFeedbackSuccessStatusCode`, `listRunFeedbackSuccessStatusCode`, `CreateRunFeedbackRequest`, `RunFeedbackListResponse`

`packages/api-contract/src/index.ts`
Add only the new run-spec barrel export (`export * from './run-spec.js'`). Existing `export * from './run.js'` and `export * from './feedback.js'` already re-export waitingOn and run feedback symbols, including createRunFeedbackSuccessStatusCode and listRunFeedbackSuccessStatusCode.
`runSpecPath`, `getRunSpecSuccessStatusCode`, `runSpecResponseSchema`, `RunSpecResponse`

`packages/api-contract/src/openapi.ts`
Register the new spec and feedback routes and the additive run waitingOn field in generated OpenAPI output if route contracts are enumerated manually.

`packages/core/src/control-plane-service.ts`
Add tenant-scoped service methods for spec reads and feedback create/list, decorate run read/list responses with waitingOn derived from the run-step catalog, and extend `DefaultControlPlaneServiceOptions` with the required repositories and helper dependencies (`ArtifactRepository`, `FeedbackRepository`, feedback lifecycle dependencies or create use case dependencies, `SpecFileReader`, ids/clock, and workspace metadata/root resolver access as needed). Unknown currentStep values are treated as data-integrity failures and surfaced as sanitized persistence_failed service errors.
`ControlPlaneService`, `DefaultControlPlaneService`, `DefaultControlPlaneServiceOptions`, `ServiceGetRunSpecInput`, `ServiceGetRunSpecResult`, `ServiceCreateRunFeedbackInput`, `ServiceCreateRunFeedbackResult`, `ServiceListRunFeedbackInput`, `ServiceListRunFeedbackResult`

`packages/core/src/spec-file-reader.ts`
Provide a narrow trusted file-read port for reading the committed spec file at an artifact's repository-relative location without exposing workspace absolute paths to routes or responses.
`SpecFileReader`, `NodeSpecFileReader`

`packages/core/src/policy.ts`
Add explicit policy actions and child-resource descriptors for the new endpoints instead of reusing generic run actions.
`PolicyAction` variants `run_spec.read`, `run_feedback.create`, `run_feedback.list`; `PolicyResourceDescriptor` variants `run_spec`, `run_feedback`

`packages/core/src/routes.ts`
Register authenticated Fastify handlers for GET /v1/runs/:id/spec, POST /v1/runs/:id/feedback, and GET /v1/runs/:id/feedback using contract validation and control-plane service methods.

`packages/sdk/src/client.ts`
Expose typed SDK methods for reading a run spec and creating/listing run feedback using the shared api-contract schemas.
`ControlPlaneClient`, `createControlPlaneClient`

`apps/control-plane/src/server.ts`
Instantiate and pass the new control-plane service dependencies: artifact and feedback repositories, feedback lifecycle dependencies, `NodeSpecFileReader`, ids/clock, and workspace metadata/root access from the existing domain repository setup.
`createControlPlaneServer` wiring for `DefaultControlPlaneServiceOptions`

`apps/control-plane/src/integration.spec.ts`
Exercise the new HTTP endpoints end to end with bearer principals, including spec read, waitingOn on run reads, feedback create/list, and cross-tenant 404 behavior.

`context-agent/wiki/code-map.md`
Document the new contracts, routes, service methods, file-read seam, and SDK methods for future agents.

### Public API

#### `waitingOnSchema`

```typescript
export const waitingOnSchema = z.enum(['system', 'ai', 'human', 'none']);
```
- Returns: `Zod schema for RunWaitingOn`
#### `runSchema`

```typescript
export const runSchema: z.ZodObject ;
```
- Returns: `Zod schema for Run with optional additive waitingOn field`
- Errors:
	- `ZodError when waitingOn is present and is not one of system, ai, human, or none`
	- `Note: runSchema retains the pre-existing requireTenantMatchesOwner superRefine constraint; this enhancement does not introduce or change that validation.`
#### `runSpecPath`

```typescript
export const runSpecPath = '/v1/runs/:id/spec' as const;
```
- Returns: `'/v1/runs/:id/spec'`
#### `runSpecResponseSchema`

```typescript
export const runSpecResponseSchema = z.object({ artifact: artifactSchema, markdown: z.string(), frontmatter: specAuthorFrontmatterSchema, cachedStatus: artifactCachedStatusSchema }).strict();
```
- Returns: `Zod schema for RunSpecResponse`
- Errors:
	- `ZodError when artifact is not a valid Artifact`
	- `ZodError when frontmatter does not satisfy specAuthorFrontmatterSchema`
	- `ZodError when cachedStatus is not a valid ArtifactCachedStatus`
#### `getRunSpecSuccessStatusCode`

```typescript
export const getRunSpecSuccessStatusCode = 200 as const;
```
- Returns: `200`
#### `runFeedbackPath`

```typescript
export const runFeedbackPath = '/v1/runs/:id/feedback' as const;
```
- Returns: `'/v1/runs/:id/feedback'`
#### `createRunFeedbackRequestSchema`

```typescript
export const createRunFeedbackRequestSchema = z.object({ target: z.literal('artifact'), title: z.string().min(1), body: z.string().min(1), anchor: feedbackAnchorSchema.optional() }).strict();
```
- Returns: `Zod schema for CreateRunFeedbackRequest`
- Errors:
	- `ZodError when target is not artifact`
	- `ZodError when title or body is empty`
	- `ZodError when anchor does not satisfy feedbackAnchorSchema`
#### `runFeedbackListResponseSchema`

```typescript
export const runFeedbackListResponseSchema = z.object({ feedback: z.array(feedbackSchema) }).strict();
```
- Returns: `Zod schema for RunFeedbackListResponse`
- Errors:
	- `ZodError when any listed item does not satisfy feedbackSchema`
#### `createRunFeedbackSuccessStatusCode`

```typescript
export const createRunFeedbackSuccessStatusCode = 201 as const;
```
- Returns: `201`
#### `listRunFeedbackSuccessStatusCode`

```typescript
export const listRunFeedbackSuccessStatusCode = 200 as const;
```
- Returns: `200`
#### `ControlPlaneService.getRunSpec`

```typescript
getRunSpec(input: ServiceGetRunSpecInput): Promise;
```
- Parameters:
	- `input: ServiceGetRunSpecInput` — Authenticated principal, tenant id, and target run id. The service derives access from the caller tenant and run ownership.
- Returns: `Promise`
- Errors:
	- `ControlPlaneServiceError('forbidden')` when policy denies `run_spec.read`
	- `ControlPlaneServiceError('not_found')` when the run is missing, belongs to another tenant, has unsupported work kind, has no current file-canonical spec artifact, or has no current spec artifact
	- `ControlPlaneServiceError('persistence_failed')` when the committed spec file cannot be safely read or frontmatter parsing fails
#### `ControlPlaneService.createRunFeedback`

```typescript
createRunFeedback(input: ServiceCreateRunFeedbackInput): Promise;
```
- Parameters:
	- `input: ServiceCreateRunFeedbackInput` — Authenticated non-model principal, tenant id, run id, and validated create feedback request.
- Returns: `Promise`
- Errors:
	- `ControlPlaneServiceError('forbidden')` when policy denies `run_feedback.create`
	- `ControlPlaneServiceError('unauthorized')` when the authenticated principal cannot author feedback
	- `ControlPlaneServiceError('not_found')` when the run is missing or belongs to another tenant
	- `ControlPlaneServiceError('persistence_failed')` when feedback lifecycle creation or repository persistence fails
#### `ControlPlaneService.listRunFeedback`

```typescript
listRunFeedback(input: ServiceListRunFeedbackInput): Promise;
```
- Parameters:
	- `input: ServiceListRunFeedbackInput` — Authenticated principal, tenant id, and target run id.
- Returns: `Promise`
- Errors:
	- `ControlPlaneServiceError('forbidden')` when policy denies `run_feedback.list`
	- `ControlPlaneServiceError('not_found')` when the run is missing or belongs to another tenant
	- `ControlPlaneServiceError('persistence_failed')` when feedback repository access fails
#### `SpecFileReader.readCommittedSpec`

```typescript
readCommittedSpec(input: { readonly run: Run; readonly artifact: Artifact }): Promise;
```
- Parameters:
	- `input: { readonly run: Run; readonly artifact: Artifact }` — The tenant-verified run and selected file-canonical spec artifact whose relative location should be read.
- Returns: `Promise`
- Errors:
	- `SpecFileReadError` when the artifact location is absolute, escapes the approved workspace/repository root, is outside the committed spec path constraints, is missing, or cannot be read
#### `ControlPlaneClient.getRunSpec`

```typescript
getRunSpec(id: string): Promise;
```
- Parameters:
	- `id: string` — Run id to read the current spec for.
- Returns: `Promise`
- Errors:
	- `ControlPlaneClientError` when the HTTP response is a non-ok standard error envelope, including 404 for missing, cross-tenant, or no-spec runs
	- `ZodError` when a successful response does not satisfy runSpecResponseSchema
#### `ControlPlaneClient.createRunFeedback`

```typescript
createRunFeedback(id: string, request: CreateRunFeedbackRequest): Promise;
```
- Parameters:
	- `id: string` — Run id to create feedback for.
	- `request: CreateRunFeedbackRequest` — Feedback target, title, body, and optional anchor. For this slice target must be artifact.
- Returns: `Promise`
- Errors:
	- `ZodError` before sending when request does not satisfy createRunFeedbackRequestSchema
	- `ControlPlaneClientError` when the HTTP response is a non-ok standard error envelope, including 404 for missing or cross-tenant runs
	- `ZodError` when a successful response does not satisfy feedbackSchema
#### `ControlPlaneClient.listRunFeedback`

```typescript
listRunFeedback(id: string): Promise;
```
- Parameters:
	- `id: string` — Run id to list feedback for.
- Returns: `Promise`
- Errors:
	- `ControlPlaneClientError` when the HTTP response is a non-ok standard error envelope, including 404 for missing or cross-tenant runs
	- `ZodError` when a successful response does not satisfy runFeedbackListResponseSchema
### Types

#### `RunWaitingOn`

```typescript
type RunWaitingOn = 'system' | 'ai' | 'human' | 'none';
```
#### `Run`

```typescript
interface Run { id: string; topicId: string; owner: NonModelPrincipal; tenant: string; workKind: string; currentStep: string; terminal: boolean; waitingOn?: RunWaitingOn; trackedIssue?: TrackedIssue; testingGuideResult?: TestingGuideResult; createdAt: string; updatedAt: string; }
```
#### `RunSpecResponse`

```typescript
interface RunSpecResponse { artifact: Artifact; markdown: string; frontmatter: SpecAuthorFrontmatter; cachedStatus: ArtifactCachedStatus; }
```
#### `CreateRunFeedbackRequest`

```typescript
interface CreateRunFeedbackRequest { target: 'artifact'; title: string; body: string; anchor?: FeedbackAnchor; }
```
#### `RunFeedbackListResponse`

```typescript
interface RunFeedbackListResponse { feedback: Feedback[]; }
```
#### `ServiceGetRunSpecInput`

```typescript
interface ServiceGetRunSpecInput { principal: Principal; tenant: string; runId: string; }
```
#### `ServiceGetRunSpecResult`

```typescript
interface ServiceGetRunSpecResult { spec: RunSpecResponse; }
```
#### `ServiceCreateRunFeedbackInput`

```typescript
interface ServiceCreateRunFeedbackInput { principal: Principal; tenant: string; runId: string; request: CreateRunFeedbackRequest; }
```
#### `ServiceCreateRunFeedbackResult`

```typescript
interface ServiceCreateRunFeedbackResult { feedback: Feedback; }
```
#### `ServiceListRunFeedbackInput`

```typescript
interface ServiceListRunFeedbackInput { principal: Principal; tenant: string; runId: string; }
```
#### `ServiceListRunFeedbackResult`

```typescript
interface ServiceListRunFeedbackResult { feedback: readonly Feedback[]; }
```
#### `SpecFileReader`

```typescript
interface SpecFileReader { readCommittedSpec(input: { readonly run: Run; readonly artifact: Artifact }): Promise; }
```
### Notes

The proposed API is additive under /v1. Feedback creation is intentionally restricted to target: artifact for the issue 41 spec-review slice; lifecycle transitions such as resolve, reopen, addressed, and wont_fix remain out of scope. Cross-tenant access for the spec and feedback child resources should be mapped to not_found rather than forbidden to avoid leaking run existence. WaitingOn derivation decision: because run-step-catalog.ts is authoritative and getRunStepDefinition can return null for unknown currentStep values, run read/list decorators must fail safely with a sanitized ControlPlaneServiceError('persistence_failed') for unknown steps. They must not silently omit waitingOn or invent a default. The optional contract field remains only for additive wire compatibility. Index barrel decision: index.ts only needs `export * from './run-spec.js'`; existing run.ts and feedback.ts barrel exports already expose waitingOn and all run feedback request/response/status symbols. The runSchema tenant-owner Zod refinement is pre-existing and unchanged by this enhancement.
## Task list

### Story 1: Add the shared API contracts

**Description:** Define the additive `/v1` contract surface in `packages/api-contract` so routes, services, SDK code, tests, and generated OpenAPI output share the same schemas and constants.
**Acceptance criteria:**
- `run.ts` exports `waitingOnSchema`, `RunWaitingOn`, and an additive optional `waitingOn` field on `runSchema`.
- `run-spec.ts` exports `runSpecPath`, `getRunSpecSuccessStatusCode`, `runSpecResponseSchema`, and `RunSpecResponse`.
- `feedback.ts` exports `runFeedbackPath`, `createRunFeedbackRequestSchema`, `runFeedbackListResponseSchema`, `createRunFeedbackSuccessStatusCode`, `listRunFeedbackSuccessStatusCode`, `CreateRunFeedbackRequest`, and `RunFeedbackListResponse`.
- `createRunFeedbackRequestSchema` accepts only `target: 'artifact'` for this slice.
- `index.ts` exports only the new `run-spec.js` barrel in addition to existing exports.
- OpenAPI generation includes the new spec and feedback routes if routes are enumerated manually.
- Contract tests cover valid and invalid `waitingOn`, spec response, feedback create request, and feedback list response payloads.
**Dependencies:** Existing `artifactSchema`, `artifactCachedStatusSchema`, `specAuthorFrontmatterSchema`, `feedbackSchema`, `feedbackTargetSchema`, and `feedbackAnchorSchema`.
#### Task 1.1: Extend the run contract with `waitingOn`

**Description:** Add the waiting-state enum and optional additive field to `runSchema` without changing existing run fields or tenant-owner validation.
**Acceptance criteria:**
- `waitingOnSchema` is `z.enum(['system', 'ai', 'human', 'none'])`.
- `RunWaitingOn` is inferred from `waitingOnSchema`.
- `runSchema` accepts a valid `waitingOn` value and rejects invalid values.
- Existing run schema behavior remains unchanged when `waitingOn` is absent.
**Dependencies:** None.
#### Task 1.2: Add the run spec contract module

**Description:** Create `packages/api-contract/src/run-spec.ts` for the spec read endpoint.
**Acceptance criteria:**
- `runSpecPath` is `'/v1/runs/:id/spec' as const`.
- `getRunSpecSuccessStatusCode` is `200 as const`.
- `runSpecResponseSchema` is strict and contains `artifact`, `markdown`, `frontmatter`, and `cachedStatus`.
- The response schema reuses the existing artifact and spec frontmatter schemas.
- `RunSpecResponse` is inferred from `runSpecResponseSchema`.
**Dependencies:** Task 1.1 only if the module export ordering requires it.
#### Task 1.3: Add run feedback route contracts

**Description:** Add request, response, path, and status constants for creating and listing run feedback while reusing existing feedback entity schemas.
**Acceptance criteria:**
- `runFeedbackPath` is `'/v1/runs/:id/feedback' as const`.
- `createRunFeedbackRequestSchema` is strict and requires `target: 'artifact'`, non-empty `title`, non-empty `body`, and optional `anchor`.
- `runFeedbackListResponseSchema` is strict and returns `{ feedback: Feedback[] }`.
- Create success status is `201`; list success status is `200`.
- Types are inferred and exported.
**Dependencies:** None.
#### Task 1.4: Export and document the new contracts

**Description:** Make the new contract symbols available from the package entry point and OpenAPI output.
**Acceptance criteria:**
- `packages/api-contract/src/index.ts` exports `./run-spec.js`.
- Existing run and feedback exports continue to expose their symbols without duplicate barrel exports.
- `packages/api-contract/src/openapi.ts` includes `GET /v1/runs/:id/spec`, `POST /v1/runs/:id/feedback`, and `GET /v1/runs/:id/feedback` if it manually lists route contracts.
- Generated or checked OpenAPI output, if committed in this repository, matches the new contracts.
**Dependencies:** Tasks 1.1, 1.2, and 1.3.
#### Task 1.5: Add child-resource policy variants

**Description:** Extend the control-plane policy model with explicit child-resource actions and descriptors for the new spec and feedback routes.
**Acceptance criteria:**
- `PolicyAction` includes `run_spec.read`, `run_feedback.create`, and `run_feedback.list`.
- `PolicyResourceDescriptor` includes `{ kind: 'run_spec', id, path: '/v1/runs/:id/spec' }`.
- `PolicyResourceDescriptor` includes `{ kind: 'run_feedback', id, path: '/v1/runs/:id/feedback' }`.
- Route pre-handlers use the new actions and descriptors instead of `run.read` or `run.list`.
- Existing run read/list authorization behavior remains unchanged.
**Dependencies:** Task 1.2 and Task 1.3.
#### Task 1.6: Add contract tests

**Description:** Add focused schema tests for the new and changed contract shapes.
**Acceptance criteria:**
- Tests prove valid run responses with and without `waitingOn` parse.
- Tests prove invalid `waitingOn` values fail.
- Tests prove valid run spec responses parse and malformed responses fail.
- Tests prove feedback create accepts only `target: 'artifact'`.
- Tests prove feedback list responses parse existing `feedbackSchema` items.
**Dependencies:** Tasks 1.1, 1.2, and 1.3.
### Story 2: Read the current spec through the control-plane service

**Description:** Add a tenant-scoped service path that locates a run's current file-canonical spec artifact, reads the committed spec markdown safely, parses frontmatter, and returns the converged API response.
**Acceptance criteria:**
- `ControlPlaneService.getRunSpec` and `DefaultControlPlaneService.getRunSpec` are implemented with the converged input and result types.
- The method verifies policy and tenant ownership before reading artifact or file data.
- Missing, cross-tenant, unsupported run kind, missing current spec artifact, and non-file-canonical spec artifact cases return `ControlPlaneServiceError('not_found')`.
- File read failures and frontmatter parse failures return a sanitized `ControlPlaneServiceError('persistence_failed')`.
- The response uses markdown from the committed spec file, frontmatter from `spec-frontmatter.ts`, and `cachedStatus` from the artifact row.
- No absolute workspace paths are exposed in service results or service errors.
**Dependencies:** Story 1.
#### Task 2.0: Extend service options and server wiring for spec and feedback dependencies

**Description:** Add the constructor dependencies required by spec reads and feedback create/list to `DefaultControlPlaneServiceOptions`, then wire them from the concrete app setup in `apps/control-plane/src/server.ts`.
**Acceptance criteria:**
- `DefaultControlPlaneServiceOptions` includes `ArtifactRepository` for spec artifact lookup.
- `DefaultControlPlaneServiceOptions` includes `FeedbackRepository` and the existing feedback lifecycle dependencies or create use case dependencies needed by feedback creation.
- `DefaultControlPlaneServiceOptions` includes `SpecFileReader` for committed spec reads.
- `DefaultControlPlaneServiceOptions` includes the id generator and clock providers required by feedback lifecycle creation.
- `DefaultControlPlaneServiceOptions` includes or receives access to the workspace metadata/root resolver required by `NodeSpecFileReader`; routes do not receive this dependency directly.
- `apps/control-plane/src/server.ts` instantiates `NodeSpecFileReader` from the existing run workspace metadata/root seam and passes it to `DefaultControlPlaneService`.
- `apps/control-plane/src/server.ts` passes the concrete artifact repository, feedback repository, feedback lifecycle dependencies, ids/clock, and existing policy to `DefaultControlPlaneService`.
- Existing `DefaultControlPlaneService` tests and app server construction are updated to provide test doubles for the new required dependencies.
**Dependencies:** Story 1 and the existing issue 39 artifact, feedback, and workspace metadata seams.
#### Task 2.1: Add the spec file reader port

**Description:** Implement `SpecFileReader` and `NodeSpecFileReader` in `packages/core/src/spec-file-reader.ts` as the only file-read seam used by spec API service code.
**Acceptance criteria:**
- `SpecFileReader.readCommittedSpec` accepts a tenant-verified `Run` and file-canonical `Artifact`.
- The reader rejects absolute artifact locations.
- The reader rejects paths that escape the approved workspace or repository root.
- The reader rejects paths outside the committed spec path constraints, including locations outside `context-human/specs/`.
- The reader returns `{ markdown }` for valid committed spec files.
- `SpecFileReadError` does not expose absolute paths in public messages.
**Dependencies:** Existing run workspace or repository root metadata seam from issue 39.
#### Task 2.2: Select the current spec artifact safely

**Description:** Add a service helper that maps run work kind to the expected artifact kind and selects the current file-canonical spec artifact.
**Acceptance criteria:**
- Feature runs select `kind: 'feature_spec'`.
- Enhancement runs select `kind: 'enhancement_spec'`.
- Other run kinds return `not_found`.
- Artifacts with `canonicalRecord` other than `file` return `not_found`.
- Artifact `location` validation is delegated to `SpecFileReader`, not duplicated in routes.
**Dependencies:** Task 2.1 and existing `ArtifactRepository`.
#### Task 2.3: Implement `getRunSpec`

**Description:** Wire run lookup, policy checks, tenant checks, artifact selection, file reading, frontmatter parsing, and response creation into the control-plane service.
**Acceptance criteria:**
- `ServiceGetRunSpecInput` and `ServiceGetRunSpecResult` match the converged API section.
- The method performs policy checks for `run_spec.read` on the `run_spec` resource descriptor before reading artifact or file data.
- Cross-tenant runs return `not_found`, not `forbidden`, after policy authorization succeeds.
- `parseSpecFrontmatter` or the existing committed spec parser validates the markdown frontmatter.
- `cachedStatus` is copied from the artifact row, not derived from parsed frontmatter.
- Service results satisfy `runSpecResponseSchema`.
**Dependencies:** Tasks 2.0, 2.1, and 2.2.
#### Task 2.4: Add service tests for spec reads

**Description:** Cover successful spec reads and safe failure modes at the service layer.
**Acceptance criteria:**
- A valid enhancement run with a file-canonical enhancement spec returns artifact, markdown, parsed frontmatter, and cached status.
- A valid feature run selects a feature spec artifact.
- Missing run, cross-tenant run, unsupported work kind, no spec artifact, and non-file-canonical artifact return `not_found`.
- Missing file, unsafe location, malformed frontmatter, and read errors return `persistence_failed`.
- Error assertions do not depend on absolute filesystem paths.
**Dependencies:** Task 2.3.
### Story 3: Decorate run reads with derived waiting state

**Description:** Add `waitingOn` to run read and list responses by deriving it from `run-step-catalog.ts` at response-mapping time.
**Acceptance criteria:**
- `GET /v1/runs/:id` includes `waitingOn` for returned runs.
- `GET /v1/runs` includes `waitingOn` for each returned run.
- A run at `currentStep: 'spec.human_review'` returns `waitingOn: 'human'`.
- Unknown `currentStep` values fail safely with `ControlPlaneServiceError('persistence_failed')`.
- `waitingOn` is not stored in repositories or database rows.
- Existing run read and list fields remain unchanged.
**Dependencies:** Story 1.
#### Task 3.1: Add a run API mapper for `waitingOn`

**Description:** Create or update the control-plane run response mapper so persisted runs become API runs with derived waiting state.
**Acceptance criteria:**
- The mapper calls `getRunStepDefinition(run.currentStep)` or the existing catalog lookup.
- Known steps map to the catalog entry's `waitingOn` value.
- Unknown steps throw or surface a sanitized persistence failure.
- The mapper returns values that satisfy `runSchema`.
- The mapper is shared by run get and run list paths.
**Dependencies:** Task 1.1.
#### Task 3.2: Use the mapper in run get and list service methods

**Description:** Update existing `DefaultControlPlaneService` run read methods to return decorated API runs.
**Acceptance criteria:**
- `getRun` returns a run with `waitingOn`.
- `listRuns` returns every run with `waitingOn`.
- Existing authorization, tenant filtering, and pagination behavior remain unchanged.
- Conversation-ingress responses that reuse `runSchema` are decorated if they pass through the same mapper and can do so safely.
**Dependencies:** Task 3.1.
#### Task 3.3: Add run waiting-state tests

**Description:** Verify waiting-state derivation for single-run and list responses.
**Acceptance criteria:**
- Tests cover `spec.human_review` returning `human`.
- Tests cover representative `system`, `ai`, and `none` step values if present in the catalog.
- Tests cover unknown `currentStep` returning or throwing the expected sanitized failure.
- Tests prove persisted run fixtures do not need a stored `waitingOn` value.
**Dependencies:** Task 3.2.
### Story 4: Create and list run feedback through the control-plane service

**Description:** Add tenant-scoped service methods that create artifact feedback authored by the authenticated principal and list feedback items for a run.
**Acceptance criteria:**
- `ControlPlaneService.createRunFeedback` and `DefaultControlPlaneService.createRunFeedback` are implemented with the converged input and result types.
- `ControlPlaneService.listRunFeedback` and `DefaultControlPlaneService.listRunFeedback` are implemented with the converged input and result types.
- Create rejects model principals as feedback authors with `unauthorized`.
- Missing and cross-tenant runs return `not_found` for create and list.
- Create uses the existing feedback lifecycle creation path.
- List uses `FeedbackRepository.listByRun` or the existing equivalent repository method after tenant verification.
- Lifecycle transition endpoints such as resolve, reopen, addressed, or `wont_fix` are not added.
**Dependencies:** Story 1 and Task 2.0.
#### Task 4.1: Define service input and result types

**Description:** Add the feedback service types named in the converged API section.
**Acceptance criteria:**
- `ServiceCreateRunFeedbackInput` contains `principal`, `tenant`, `runId`, and validated `request`.
- `ServiceCreateRunFeedbackResult` contains `feedback`.
- `ServiceListRunFeedbackInput` contains `principal`, `tenant`, and `runId`.
- `ServiceListRunFeedbackResult` contains readonly feedback items.
- Types use shared contract request and feedback response types.
**Dependencies:** Task 1.3.
#### Task 4.2: Implement feedback creation

**Description:** Add `createRunFeedback` service behavior that validates access and delegates creation to existing feedback lifecycle code.
**Acceptance criteria:**
- The method performs policy checks for `run_feedback.create` on the `run_feedback` resource descriptor.
- The method verifies the run belongs to the caller tenant.
- The method creates an `open` feedback item with an initial thread entry authored by the authenticated non-model principal.
- The method uses the server-owned run id, tenant, owner, status, and thread metadata rather than accepting them from the request body.
- Repository or lifecycle failures return `persistence_failed`.
**Dependencies:** Task 2.0, Task 4.1, and existing feedback lifecycle creation helper.
#### Task 4.3: Implement feedback listing

**Description:** Add `listRunFeedback` service behavior that validates access and returns feedback for the tenant-verified run.
**Acceptance criteria:**
- The method performs policy checks for `run_feedback.list` on the `run_feedback` resource descriptor.
- The method verifies the run belongs to the caller tenant.
- Missing or cross-tenant runs return `not_found`.
- The method returns `{ feedback }` in the shape expected by `runFeedbackListResponseSchema`.
- Repository failures return `persistence_failed`.
**Dependencies:** Task 2.0, Task 4.1, and existing `FeedbackRepository`.
#### Task 4.4: Add service tests for feedback create and list

**Description:** Cover feedback service success paths, authorship rules, tenant scoping, and persistence failures.
**Acceptance criteria:**
- Creating artifact feedback returns a `Feedback` item with `status: 'open'`.
- The first thread entry reflects the authenticated non-model principal.
- Model principals cannot author feedback.
- Listing returns feedback for the target run.
- Cross-tenant create and list return `not_found`.
- Repository or lifecycle failures map to sanitized service errors.
**Dependencies:** Tasks 4.2 and 4.3.
### Story 5: Expose the new endpoints through Fastify routes

**Description:** Register authenticated `/v1` routes for spec read, feedback create, and feedback list using contract validation, existing bearer-principal wiring, and standard error envelopes.
**Acceptance criteria:**
- `GET /v1/runs/:id/spec` authorizes `run_spec.read` on the `run_spec` resource descriptor and calls `ControlPlaneService.getRunSpec`.
- `POST /v1/runs/:id/feedback` authorizes `run_feedback.create` on the `run_feedback` resource descriptor, validates `createRunFeedbackRequestSchema`, and calls `ControlPlaneService.createRunFeedback`.
- `GET /v1/runs/:id/feedback` authorizes `run_feedback.list` on the `run_feedback` resource descriptor and calls `ControlPlaneService.listRunFeedback`.
- Successful responses use `200`, `201`, and `200` respectively.
- Validation failures use the existing validation error envelope.
- `ControlPlaneServiceError` values map to existing route error envelopes and status codes.
- Routes do not perform direct repository or filesystem access.
**Dependencies:** Stories 1, 2, and 4.
#### Task 5.1: Register the spec read route

**Description:** Add the Fastify handler for `GET /v1/runs/:id/spec`.
**Acceptance criteria:**
- Path params are parsed using existing route param patterns.
- The authenticated principal and tenant are passed to the service after `run_spec.read` authorization succeeds.
- A successful response is validated or serialized against `runSpecResponseSchema`.
- `not_found` returns 404 for missing, cross-tenant, unsupported, and no-spec runs.
- Filesystem and frontmatter failures return a safe standard error without path leakage.
**Dependencies:** Story 2.
#### Task 5.2: Register feedback create and list routes

**Description:** Add Fastify handlers for `POST /v1/runs/:id/feedback` and `GET /v1/runs/:id/feedback`.
**Acceptance criteria:**
- Create parses and validates the request body with `createRunFeedbackRequestSchema`.
- Create returns the created `Feedback` item with status code `201`.
- List returns `{ feedback: [...] }` with status code `200`.
- Cross-tenant runs return 404 for both routes.
- Unsupported feedback targets fail validation before service invocation.
**Dependencies:** Story 4.
#### Task 5.3: Add route tests

**Description:** Add route-level tests for validation, auth wiring, service calls, and error mapping.
**Acceptance criteria:**
- Tests verify each route authorizes the expected policy action/resource and passes principal, tenant, run id, and request body to the correct service method.
- Tests verify create rejects invalid body shapes.
- Tests verify service `not_found`, `forbidden`, `unauthorized`, and `persistence_failed` errors map to expected envelopes.
- Tests verify route handlers do not include absolute paths in error responses.
**Dependencies:** Tasks 5.1 and 5.2.
### Story 6: Add typed SDK methods

**Description:** Extend `packages/sdk/src/client.ts` with typed methods for spec read and run feedback create/list that use the shared contract schemas.
**Acceptance criteria:**
- `ControlPlaneClient.getRunSpec(id)` returns `Promise`.
- `ControlPlaneClient.createRunFeedback(id, request)` returns `Promise`.
- `ControlPlaneClient.listRunFeedback(id)` returns `Promise`.
- Request bodies are validated before send.
- Successful responses are parsed with the shared contract schemas.
- Non-ok standard error envelopes throw `ControlPlaneClientError`.
- Method names and path construction match existing client style.
**Dependencies:** Stories 1 and 5.
#### Task 6.1: Implement `getRunSpec`

**Description:** Add the SDK method that calls `GET /v1/runs/:id/spec`.
**Acceptance criteria:**
- The method builds the route from the contract path convention or existing path helper style.
- The method sends an authenticated GET request through the existing client transport.
- The method parses success responses with `runSpecResponseSchema`.
- 404 and other non-ok responses throw `ControlPlaneClientError`.
**Dependencies:** Task 1.2 and Task 5.1.
#### Task 6.2: Implement feedback SDK methods

**Description:** Add SDK methods for creating and listing run feedback.
**Acceptance criteria:**
- `createRunFeedback` validates the request with `createRunFeedbackRequestSchema` before sending.
- `createRunFeedback` parses the success response with `feedbackSchema`.
- `listRunFeedback` parses the success response with `runFeedbackListResponseSchema`.
- Both methods reuse existing error handling behavior.
**Dependencies:** Task 1.3 and Task 5.2.
#### Task 6.3: Add SDK tests

**Description:** Verify SDK request validation, response parsing, path construction, and error handling.
**Acceptance criteria:**
- Tests prove `getRunSpec` returns parsed spec responses.
- Tests prove `createRunFeedback` rejects non-artifact targets before sending.
- Tests prove `createRunFeedback` returns parsed feedback.
- Tests prove `listRunFeedback` returns parsed feedback arrays.
- Tests prove standard error envelopes throw `ControlPlaneClientError`.
**Dependencies:** Tasks 6.1 and 6.2.
### Story 7: Prove the API end to end

**Description:** Add integration coverage in `apps/control-plane` for the full HTTP and service path using bearer principals, seeded runs, committed spec files, artifacts, and feedback records.
**Acceptance criteria:**
- Integration tests exercise `GET /v1/runs/:id/spec`.
- Integration tests exercise `GET /v1/runs/:id` with `waitingOn`.
- Integration tests exercise `GET /v1/runs` with `waitingOn`.
- Integration tests exercise `POST /v1/runs/:id/feedback`.
- Integration tests exercise `GET /v1/runs/:id/feedback`.
- Integration tests verify cross-tenant 404 behavior for spec read, feedback create, and feedback list.
- Existing integration tests for run read and list still pass.
**Dependencies:** Stories 2, 3, 4, and 5.
#### Task 7.1: Build integration fixtures for spec review runs

**Description:** Create or extend test fixtures for a run paused at `spec.human_review` with a file-canonical spec artifact and committed markdown file.
**Acceptance criteria:**
- Fixture includes a tenant-owned run with `currentStep: 'spec.human_review'`.
- Fixture includes a matching `feature_spec` or `enhancement_spec` artifact with `canonicalRecord: 'file'`.
- Fixture writes a valid spec markdown file under `context-human/specs/`.
- Fixture supports a second tenant for cross-tenant tests.
**Dependencies:** Existing integration test database and workspace helpers.
#### Task 7.2: Test spec read and waiting-state responses

**Description:** Add end-to-end tests for spec read and decorated run read/list responses.
**Acceptance criteria:**
- `GET /v1/runs/:id/spec` returns artifact, markdown, frontmatter, and cached status.
- `GET /v1/runs/:id` returns `waitingOn: 'human'` for the spec review run.
- `GET /v1/runs` returns the same run with `waitingOn: 'human'`.
- Cross-tenant spec read returns 404.
- A run without a current spec artifact returns 404.
**Dependencies:** Task 7.1 and Story 5.
#### Task 7.3: Test feedback create and list endpoints

**Description:** Add end-to-end tests for creating and reading back artifact feedback through HTTP.
**Acceptance criteria:**
- `POST /v1/runs/:id/feedback` with `target: 'artifact'` creates an open feedback item.
- The created feedback's title, body, anchor, target, tenant, run id, and author are correct.
- `GET /v1/runs/:id/feedback` returns the created feedback item.
- Cross-tenant create and list return 404.
- Invalid target or empty title/body returns the standard validation error.
**Dependencies:** Task 7.1 and Story 5.
### Story 8: Preserve gate behavior and update agent navigation docs

**Description:** Verify the new API surface does not alter the existing spec-review gate and update agent-facing documentation for future maintainers.
**Acceptance criteria:**
- Existing gate tests still prove open or addressed artifact feedback blocks `spec.human_review`.
- No HTTP lifecycle transition routes are added for resolve, reopen, addressed, or `wont_fix`.
- `context-agent/wiki/code-map.md` points to the new contracts, routes, service methods, spec file reader, SDK methods, and integration tests.
- The implementation notes mention the `waitingOn` derivation rule and cross-tenant child-resource 404 behavior.
**Dependencies:** Stories 2, 3, 4, 5, 6, and 7.
#### Task 8.1: Add or update gate regression tests

**Description:** Run existing gate tests and add a narrow regression if coverage does not already prove artifact feedback blocks advancement after API-created feedback.
**Acceptance criteria:**
- Open artifact feedback blocks advancement past `spec.human_review`.
- Addressed artifact feedback still blocks advancement until the existing gate rules allow progress.
- The new create/list API does not bypass or mutate the gate state machine.
- No tests depend on lifecycle transition endpoints that are out of scope.
**Dependencies:** Story 4 and existing gate test helpers.
#### Task 8.2: Update `context-agent/wiki/code-map.md`

**Description:** Document the new files and touchpoints so future agents can find the API surface quickly.
**Acceptance criteria:**
- The code map references `packages/api-contract/src/run-spec.ts`.
- The code map references the changed run and feedback contract files.
- The code map references `packages/core/src/spec-file-reader.ts`.
- The code map references the new `ControlPlaneService` methods and Fastify routes.
- The code map references the SDK methods and control-plane integration tests.
**Dependencies:** Stories 1 through 7.
#### Task 8.3: Run targeted and broad validation

**Description:** Run the project checks needed for this slice and record any skipped checks with reasons.
**Acceptance criteria:**
- Targeted contract, core, route, SDK, and integration tests pass.
- The repository's standard typecheck and lint commands pass if available.
- Any generated OpenAPI or build artifacts are up to date.
- Any skipped validation is documented with an exact reason.
**Dependencies:** All implementation tasks.