---
created: 2026-06-08
last_updated: 2026-06-08
status: implementing
issue: 15
specced_by: markdstafford
---
# Feature: Orchestrator service ingress

## Product requirements

### What

Add the orchestrator as Autocatalyst's single run-mutation authority and expose it through the typed service interface. A caller can open a conversation and its first run, read a run, read the run's step timeline, and subscribe to the run's state transitions over Server-Sent Events (SSE). The same operations are available to in-process callers and network clients under `/v1`.
The orchestrator becomes the only service-facing component allowed to create runs, transition run steps, dispatch run work, or publish run-state events. The initial `createConversationWithFirstRun` operation is orchestrator-owned too: because conversation, main topic, optional message, run, and first run step must commit atomically, `ControlPlaneService.createConversationWithFirstRun` calls `Orchestrator.createConversationWithFirstRun(...)`; the orchestrator calls `ConversationIngressRepository.createConversationTopicMessageAndRun(...)` for that durable transaction and publishes the lifecycle-start event only after the commit succeeds. Network routes and future in-process adapters call the control-plane service instead of writing runs, run steps, or lifecycle state directly, and the service does not call persistence methods that create or transition runs outside the orchestrator.
### Why

Autocatalyst already has the run step catalog, workflow tables, transition rule, lifecycle persistence methods, domain repositories, bearer-auth envelope, policy seam, and a heartbeat-only SSE endpoint. Those pieces do not yet form one mutation boundary. Without a single orchestrator path, route handlers or adapters could create runs, advance steps, or emit events inconsistently.
This feature turns the existing lifecycle and repository foundation into the service ingress future clients need. It proves the run starts through the approved service boundary, duplicate active work is refused by the durable `runs_one_active_per_topic` index, step transitions publish live events, and the network surface matches the in-process service contract for create, read, and stream operations.
### Goals

- Add a single orchestrator module in `packages/core` that owns standalone run creation, composite conversation-with-first-run creation, run transition, dispatch admission, and run-state event publication.
- Ensure `startRunLifecycle` and `applyRunDirective` are reached only through the orchestrator from service ingress and route handlers; lifecycle start is reached through `Orchestrator.createRun` or `Orchestrator.createConversationWithFirstRun`.
- Surface the durable one-active-run-per-topic constraint as a typed conflict instead of an unhandled persistence exception.
- Bound concurrently dispatched run work per host and queue additional work until capacity is available.
- Expose an in-process typed service interface for creating a conversation with its first run, reading a run, listing a run's steps, and subscribing to run transition events.
- Expose matching network routes under `/v1`: `POST /conversations`, `GET /runs/{id}`, `GET /runs/{id}/steps`, and `GET /runs/{id}/events`.
- Replace the heartbeat-only SSE route with typed run-state-transition events for a specific run.
- Publish a run-state-transition event every time the orchestrator records a run transition, including lifecycle start.
- Scope reads and streams by principal and tenant through the existing auth and policy seams.
- Add a push-primary creation path where service calls create a conversation and first run, plus orchestrator-owned `dispatch` and `tick` advancement seams for stubbed unit-of-work and non-push sources.
- Keep intake routing minimal: map inbound submissions to a workflow/work kind from the existing catalog, without full intent classification or intent-upgrade behavior.
- Prove the behavior with unit and integration tests, including end-to-end create/read/subscribe coverage and a post-subscription transition observation driven through `tick` or dispatch.
- Update `context-agent/wiki/code-map.md` during implementation for the new orchestrator, service, event, route, and SDK modules.
### Non-goals

- Building the full execution runtime, workspace provisioning, real `Runner` adapter, or AI model session driver.
- Implementing full intent classification, intent-upgrade-at-the-gate behavior, `revise` and `answer` message semantics, or rich message routing.
- Implementing recovery-on-load or automatic re-admission of non-terminal runs after restart.
- Implementing operator actions such as `cancel`, `set-step`, archive, cleanup, or destructive purge.
- Adding global or per-tenant fairness beyond the per-host concurrency bound.
- Persisting a permanent turn-grain event archive beyond the live run-events stream needed here.
- Building desktop, mobile, or chat UI around these routes.
- Removing the proof-only probe-resource endpoint.
### Personas

- **Enzo (Engineer)** needs one typed service path for run mutations so routes, adapters, tests, and future execution code cannot bypass lifecycle rules.
- **Phoebe (PM)** needs confidence that starting work from a request produces a visible run handle and live progress signal.
- **Opal (Operator)** needs duplicate active work to fail deterministically and bounded dispatch to protect the host.
- **Dani (Designer)** is not a direct user of this backend feature, but later client progress views depend on the event stream and read routes this feature adds.
### User stories

- As Enzo, I can call the in-process service to open a conversation and first run without making an HTTP request.
- As Enzo, I can call the network API to open the same conversation/run shape and receive the same typed response.
- As Enzo, I can read a run and its step occurrences through service methods and SDK methods.
- As Enzo, I can subscribe to a run's transition stream and receive typed events whenever the orchestrator changes run state.
- As Opal, I can submit duplicate active work for a topic and get a typed conflict while the original run remains unchanged.
- As Opal, I can configure a per-host concurrency cap and know the orchestrator queues work beyond that cap.
- As Phoebe, I can create work from a client and immediately get a run id plus live transition updates.
- As a future adapter author, I can call the in-process service instead of reaching into repositories or lifecycle functions.
### Acceptance criteria

#### Single run-mutation authority

- A `packages/core` orchestrator module is the only service-facing path that creates runs, records run-step transitions after creation, dispatches run work, or publishes run events.
- `ControlPlaneService.createConversationWithFirstRun` delegates first-run creation to `Orchestrator.createConversationWithFirstRun`; the orchestrator calls the required `ConversationIngressRepository` atomic transaction and publishes the lifecycle-start event after commit.
- Network routes mutate run state only by calling the service interface, which calls the orchestrator for every run creation or transition path.
- In-process callers mutate run state only by calling the same service interface, which preserves that same boundary.
- No route handler writes `Run`, `Topic`, `Conversation`, `RunStep`, or lifecycle transition state directly.
- `startRunLifecycle` and `applyRunDirective` remain lifecycle primitives; application code reaches lifecycle start through `Orchestrator.createRun` or `Orchestrator.createConversationWithFirstRun`, and reaches directive application only through the orchestrator.
- A test asserts a handler or unit-of-work result is returned to the orchestrator and the orchestrator turns it into a transition, rather than the handler writing run state itself.
#### Durable dedup conflict

- Creating a second active run under a topic that already has a non-terminal run is refused by the `runs_one_active_per_topic` constraint.
- The refusal is surfaced as a typed conflict error, such as `active_run_conflict`, with structured details that include the topic id and, when available, the existing active run id.
- The duplicate request does not advance, replace, or modify the existing run.
- Any network endpoint that can start a run for an existing topic receives an HTTP `409 Conflict` error envelope using the shared error response shape. This issue's `POST /v1/conversations` always creates a new main topic, so duplicate-under-same-topic HTTP coverage is limited to the first network path that supports an existing topic id.
- In-process callers receive the typed conflict error rather than a database-specific exception.
- A test creates one active run and asserts the second create is rejected while the first run and its first `RunStep` remain unchanged.
- Manual or integration proof for this issue should demonstrate duplicate-active-run refusal by calling the orchestrator or persistence seam twice for the same topic. It should not claim that a `curl` against `POST /v1/conversations` can exercise the duplicate-topic gate, because that route always creates a new main topic.
#### Per-host bounded dispatch

- The orchestrator owns a per-host concurrency limiter for dispatched run work.
- The cap is configurable through orchestrator construction options, with a safe test-friendly default.
- Work beyond the cap waits in FIFO order or another explicitly documented deterministic order.
- A stubbed unit of work can be dispatched through the orchestrator without invoking a real runner.
- A test drives more runs than the cap through the orchestrator and asserts no more than the cap are active at once.
- Queued work starts when an in-flight unit completes or fails.
- A failed unit releases its slot and lets the queue continue.
#### In-process service interface

- A typed service module exposes `createConversationWithFirstRun`, `getRun`, `listRunSteps`, `subscribeRunEvents`, and `tick` or equivalent names that match existing project conventions.
- `createConversationWithFirstRun` authorizes and routes intake, then asks the orchestrator to create the `Conversation`, main `Topic`, first inbound `Message` when the request carries a submission body, first `Run`, and first `RunStep` through the required atomic ingress repository and publish the lifecycle-start event after commit.
- The create operation sets the conversation's active topic to the main topic.
- The create operation resolves only enough work-kind routing to start or advance a run from the workflow catalog.
- `getRun` returns a typed `Run` or a typed not-found result.
- `listRunSteps` returns typed `RunStep` occurrences in persisted order.
- `subscribeRunEvents` returns an async iterable, event emitter, or equivalent typed subscription abstraction that can be bridged to SSE without HTTP-specific coupling.
- Service methods carry a `Principal` and tenant context and call the policy seam for authorization.
#### Network API and SDK

- `POST /v1/conversations` opens a conversation, its main topic, and its first run.
- `GET /v1/runs/{id}` returns the typed `Run` resource.
- `GET /v1/runs/{id}/steps` returns the typed list of `RunStep` occurrences.
- `GET /v1/runs/{id}/events` streams typed SSE events for that run.
- Request, response, params, and event payload shapes come from Zod schemas in `packages/api-contract`.
- Route paths, success status codes, and schemas are exported from `packages/api-contract` and reused by core routes, SDK methods, and tests.
- `ControlPlaneClient` exposes methods for the same operations: create conversation with first run, get run, list run steps, and subscribe or open the run-events stream.
- The OpenAPI document includes the new REST routes. The SSE route is represented at least by path, params, status, auth, and event media type metadata according to existing OpenAPI conventions.
- Validation failures, not-found results, forbidden results, and conflicts use the shared error envelope.
#### Run-events SSE stream

- `GET /v1/runs/{id}/events` replaces or supersedes the heartbeat-only `/v1/events` route for run-specific progress.
- The stream uses `text/event-stream`, no-cache headers, and the existing bearer auth and policy pre-handler.
- The route validates `runId` path params through `api-contract` schemas.
- The route checks that the run exists and is visible to the request principal and tenant before streaming.
- The orchestrator publishes a typed `run_state_transition` event on lifecycle start and each transition.
- Each event includes at minimum an event id, run id, transition kind, from step when present, to step, current run snapshot or enough run fields for clients to update state, created timestamp, and tenant/scope data needed for filtering.
- Subscribers for one run receive only events for that run.
- The stream sends events in the order the orchestrator publishes them.
- The implementation supports clean client disconnect without leaking listeners.
- `Last-Event-ID` handling may be live-memory-only for this issue; permanent replay beyond active retention is out of scope.
#### Push ingestion and tick fallback

- A push service call creates a conversation and first run without polling.
- Run advancement in this issue is not exposed as a public direct push/apply-directive service method or route; it occurs through `Orchestrator.dispatch` and `ControlPlaneService.tick` with stubbed unit-of-work behavior.
- A `tick` entry point exists for sources without push support.
- `tick` runs through the orchestrator, not around it.
- A test asserts `tick` reconciles or advances a run state using a stubbed source or unit of work.
- `tick` does not implement recovery-on-load for all non-terminal runs; it only proves the fallback seam.
- There is no public network route that advances a run in this issue. Network coverage proves create, read, step listing, SSE framing, and live delivery; post-subscription advancement in network tests is triggered through an in-process `tick` or dispatch seam.
#### Minimal intake routing

- The create request supports enough submission data to map to a workflow/work kind from the existing catalog.
- The issue-reference path can carry an already-known work kind from the enriched issue context or use a simple feature/bug/chore mapping sufficient for this issue's tests.
- Free-form full intent classification is not required.
- Intent upgrade, active-run `answer`, and `revise` message semantics are not implemented in this feature.
- Unsupported or ambiguous intake shapes fail with a typed validation or routing error instead of silently creating the wrong workflow.
#### End-to-end proof

- An integration test creates a run through the service interface, subscribes to its event stream, triggers a post-subscription transition through `tick` or dispatch, and observes that transition over the stream.
- A network integration test creates a conversation and run through `POST /v1/conversations`, reads the run through `GET /v1/runs/{id}`, reads its steps through `GET /v1/runs/{id}/steps`, opens `GET /v1/runs/{id}/events`, then triggers a post-subscription transition through an in-process test seam such as `tick` or dispatch and observes at least one run-state-transition SSE event. The test must not rely on replaying the already-published lifecycle-start event.
- Tests cover auth and tenant scoping for the new routes at the level supported by the existing hardcoded principal and permissive policy seam.
- `context-agent/wiki/code-map.md` is updated with the new orchestrator, service, route, event, and SDK locations.
## Design spec

### Design scope

This is a backend and service-interface feature. There is no visual screen, layout, component, or human-facing interaction design in this pass.
The design work is the developer and client experience: how callers submit work, how run mutations are centralized, how duplicate active work is reported, how live transition events are shaped, and how bounded dispatch behaves before a real runner exists.
### Service experience

The primary service flow should be predictable:
1. A caller submits work through `POST /v1/conversations` or the in-process service.
2. The service authenticates the request, attaches a `Principal`, and authorizes the action through the policy point.
3. The service routes the initial submission to a work kind and calls `Orchestrator.createConversationWithFirstRun`.
4. The orchestrator calls the required `ConversationIngressRepository` transaction so the conversation, main topic, optional message, run, and initial run step commit or roll back together.
5. After the transaction commits, the orchestrator publishes the `run_state_transition` event for the initial step as part of the same create operation.
6. The response returns the conversation, main topic, optional message, run, and initial step data the client needs to render progress.
7. A client reads the run or step timeline through REST as durable history.
8. A client watches live state through `GET /v1/runs/{id}/events`.
The in-process and network paths should differ only in transport framing. They should share request/response types, validation rules, authorization checks, and orchestrator calls.
### Authority boundary

The orchestrator should be the named boundary for all run mutations:
- Creating a standalone run goes through the orchestrator.
- Creating the first run as part of `createConversationWithFirstRun` goes through `Orchestrator.createConversationWithFirstRun`; inside that method, the orchestrator invokes the required atomic `ConversationIngressRepository` transaction and then publishes the start event.
- Applying a directive goes through the orchestrator.
- Dispatching a stubbed unit of work goes through the orchestrator.
- Publishing run-state events happens from the orchestrator after durable state changes.
- Route handlers and adapters never sequence lifecycle calls and repository writes themselves.
Lifecycle code remains the focused state-machine layer. The orchestrator does not duplicate `next(workflow, step, directive)` logic; it calls `startRunLifecycle` for standalone run creation and `applyRunDirective` for advancement. For composite conversation ingress, the orchestrator owns the create call and the persistence transaction must reuse the exact lifecycle-start construction from `run-lifecycle.ts`—including terminal derivation, occurrence initialization, and first `RunStep` shape—rather than reimplementing a second hand-aligned start path. The orchestrator handles authority concerns around dedup errors, dispatch, event publication, and service-facing result mapping.
### Create-conversation request

The create route should model intake as resource creation. A compact initial shape is enough for this feature:
```json
{
  "projectId": "proj_123",
  "identity": "Issue 15",
  "topic": {
    "title": "Add orchestrator service ingress"
  },
  "submission": {
    "kind": "issue_reference",
    "body": "please work on issue 15",
    "workKind": "feature",
    "trackedIssue": {
      "number": 15,
      "title": "feat: add the orchestrator as the single run-mutation authority and its service ingress",
      "state": "open",
      "url": "https://github.com/markdstafford/autocatalyst/issues/15"
    }
  }
}
```
The exact field names may follow implementation conventions, but the shape must distinguish the conversation binding, topic title, and initial submission. `workKind` can be required for this first slice to avoid implementing full intent classification. Later intake can replace that with classifier-owned enrichment while keeping the route additive.
`submission.kind` and `submission.workKind` are intentionally both present in this slice: `kind` describes the submitted artifact shape, while `workKind` is the minimal routing key. If implementation can derive one from the other without adding classifier scope, it may reduce this surface, but tests should keep routing explicit.
### Create-conversation response

The response should give the client all stable handles produced by the create:
```json
{
  "conversation": { "id": "conv_123" },
  "topic": { "id": "topic_123", "kind": "main" },
  "message": { "id": "msg_123" },
  "run": { "id": "run_123", "currentStep": "intake", "terminal": false },
  "runStep": { "id": "step_123", "step": "intake" }
}
```
If implementation chooses not to persist the first `Message` in this issue, the field should be omitted rather than returned as null. Persisting the message is preferred because it makes the request auditable and matches the intake concept.
### Run-state event design

The event payload should be small, typed, and enough for a client to update live status without re-reading immediately:
```json
{
  "id": "evt_123",
  "type": "run_state_transition",
  "runId": "run_123",
  "transition": {
    "directive": "advance",
    "fromStep": "intake",
    "toStep": "spec.author"
  },
  "run": {
    "id": "run_123",
    "topicId": "topic_123",
    "workKind": "feature",
    "currentStep": "spec.author",
    "terminal": false
  },
  "runStep": {
    "id": "step_124",
    "step": "spec.author",
    "phase": "spec",
    "occurrence": { "index": 1, "attempt": 1 }
  },
  "tenant": "tenant_default",
  "createdAt": "2026-06-08T00:00:00.000Z"
}
```
For lifecycle start, `fromStep` is omitted and the event still uses `type: "run_state_transition"`. For SSE framing, the SSE event name should match the payload type:
```plain text
event: run_state_transition
id: evt_123
data: { ...payload... }
```
### Event delivery model

This issue can use an in-memory event bus with per-run filtering. It should still have a clear interface so a later durable event store can replace it:
- `publishRunEvent(event)` is called only after the durable lifecycle write succeeds.
- `subscribeRunEvents(runId, principal)` returns a cancellable subscription.
- The bus filters by run id and tenant.
- The route unsubscribes when the HTTP connection closes.
- Tests can await a published event without timing-sensitive sleeps.
This feature does not need permanent replay. If `Last-Event-ID` is present, the implementation may ignore it or support live-memory replay from a bounded buffer. The behavior must be documented in code comments or tests so future execution-runtime work can extend it deliberately.
Because the event bus is live/in-memory for this issue, tests must not assume a subscriber can observe events published before it subscribed. End-to-end SSE tests should prove stream framing and live delivery by opening the subscription first, then triggering a later transition through `ControlPlaneService.tick`, `Orchestrator.dispatch`, or another in-process test seam defined by this spec.
### Dispatch and unit-of-work design

The orchestrator should accept a unit-of-work abstraction that can be stubbed in tests and replaced by the execution runtime later. A unit returns a result instead of mutating run state:
```typescript
interface RunUnitOfWork {
  run(input: RunWorkInput): Promise;
}

type RunWorkResult =
  | { directive: 'advance' }
  | { directive: 'needs_input'; question?: string }
  | { directive: 'fail'; reason: string };
```
The orchestrator receives the result, validates or maps it, and applies the lifecycle directive. This proves the important authority rule: execution produces a result, and the orchestrator records the state transition.
The concurrency limiter wraps dispatch, not lifecycle creation. Creating a run and publishing its start event can happen immediately. Dispatch of AI/system work waits for capacity.
### Error and empty-state design

- A missing run read returns a typed not-found result and maps to HTTP `404`.
- A run-events subscription for a missing or unauthorized run returns `404` or `403` before opening the stream.
- Duplicate active run creation returns a typed conflict and maps to HTTP `409` where a network endpoint supports starting a run for an existing topic.
- Unsupported work kind or intake shape returns a typed validation/routing error and maps to `400`.
- A repository with no conversations, topics, runs, or steps is valid.
- Listing steps for a run with only its initial step returns a one-item list.
### Security and scoping

The feature should use the current bearer auth hook, hardcoded development principal, and permissive policy point without expanding the auth model. It must still pass the principal and tenant through every service operation so the seam is correct when policy becomes stricter.
Run reads and streams should verify that the target run belongs to the same tenant as the principal. Where the repository does not expose an ownership-aware read yet, the service can read the run and check `run.tenant` before returning it.
## Tech spec

### Current state

The repository already contains most lower-level pieces this feature composes:
- `packages/core/src/run-step-catalog.ts` defines step ids, phases, roles, `waiting_on`, and derived sets.
- `packages/core/src/run-workflows.ts` defines workflows for `feature`, `enhancement`, `bug`, `chore`, `file_issue`, and `question`.
- `packages/core/src/run-transition.ts` owns the pure transition rule.
- `packages/core/src/run-lifecycle.ts` owns `startRunLifecycle` and `applyRunDirective`, using `RunRepository.recordRunLifecycleStart` and `recordRunStepTransition`.
- `packages/core/src/domain-repositories.ts` exposes repositories for `Conversation`, `Topic`, `Message`, `Run`, and `RunStep`.
- `packages/persistence/src/domain-repositories.ts` implements the domain repositories and lifecycle transaction methods.
- `packages/persistence/src/schema.ts` defines `runs_one_active_per_topic` on `runs.topic_id where terminal = 0`.
- `packages/core/src/routes.ts` registers authenticated `/v1` routes and currently has a heartbeat-only `GET /v1/events` SSE route.
- `packages/api-contract/src/run.ts`, `conversation.ts`, `topic.ts`, `message.ts`, and `run-step.ts` define domain schemas.
- `packages/sdk/src/client.ts` exposes typed client methods for existing routes.
The main gaps are service-level orchestration, create-conversation/run ingress, run reads, run-step listing, typed per-run SSE events, conflict mapping for the active-run uniqueness constraint, and bounded dispatch.
### Proposed package shape

Keep the feature inside existing packages:
- `packages/api-contract/` owns route constants, params, request/response schemas, list schemas, event schemas, status codes, and OpenAPI registration.
- `packages/core/` owns the orchestrator, service interface, event bus abstraction, route handlers, auth/policy integration, and concurrency limiter.
- `packages/persistence/` owns any repository additions needed for active-run lookup, transaction composition, and deterministic conflict detection.
- `packages/sdk/` owns typed client methods for the new routes and a stream helper for run events.
- `apps/control-plane/` wires the new dependencies into the existing Fastify app composition.
Suggested new core modules:
- `packages/core/src/orchestrator.ts`
- `packages/core/src/control-plane-service.ts`
- `packages/core/src/run-events.ts`
- `packages/core/src/run-dispatch-queue.ts`
Suggested new or expanded contract files:
- `packages/api-contract/src/conversation-ingress.ts` or expanded `conversation.ts`
- `packages/api-contract/src/run-events.ts` or expanded `sse.ts`
- Expanded `packages/api-contract/src/run.ts`
- Expanded `packages/api-contract/src/run-step.ts`
- Expanded `packages/api-contract/src/openapi.ts`
### Contract additions

Add schemas and constants for the new network surface. Names can follow existing package style, but the contract should include these concepts:
```typescript
export const conversationCollectionPath = '/v1/conversations' as const;
export const runCollectionPath = '/v1/runs' as const;
export const runResourcePath = '/v1/runs/:id' as const;
export const runStepsPath = '/v1/runs/:id/steps' as const;
export const runEventsPath = '/v1/runs/:id/events' as const;
export const createConversationSuccessStatusCode = 201 as const;
```
Add path params:
```typescript
export const runIdParamsSchema = z.object({ id: z.string().min(1) }).strict();
```
Add create request and response schemas. The request should reuse existing domain value schemas for `Principal`, `TrackedIssue`, and `ChannelReference` where applicable. It should avoid requiring clients to supply ids that the service owns.
```typescript
export const createConversationWithFirstRunRequestSchema = z.object({
  projectId: z.string().min(1),
  identity: z.string().min(1),
  channel: channelReferenceSchema.optional(),
  topic: z.object({
    title: z.string().min(1)
  }).strict(),
  submission: z.object({
    kind: z.enum(['issue_reference', 'free_form', 'question', 'list_to_file']),
    body: z.string().min(1),
    workKind: z.enum(['feature', 'enhancement', 'bug', 'chore', 'file_issue', 'question']),
    trackedIssue: trackedIssueSchema.optional()
  }).strict()
}).strict();

export const createConversationWithFirstRunResponseSchema = z.object({
  conversation: conversationSchema,
  topic: topicSchema,
  message: messageSchema.optional(),
  run: runSchema,
  runStep: runStepSchema
}).strict();
```
Add step list response:
```typescript
export const runStepListResponseSchema = z.object({
  steps: z.array(runStepSchema)
}).strict();
```
Add run event schemas:
```typescript
export const runStateTransitionEventSchema = z.object({
  id: z.string().min(1),
  type: z.literal('run_state_transition'),
  runId: z.string().min(1),
  transition: z.object({
    directive: z.enum(['start', 'advance', 'revise', 'needs_input', 'cancel', 'fail']),
    fromStep: z.string().min(1).optional(),
    toStep: z.string().min(1)
  }).strict(),
  run: runSchema,
  runStep: runStepSchema,
  tenant: z.string().min(1),
  createdAt: z.string().datetime()
}).strict();
```
If `start` should not be added to the lifecycle directive enum, keep it only in the event schema as an event transition kind. Do not feed `start` into `nextWorkflowStep`.
Add error code constants:
```typescript
export const conflictErrorCode = 'conflict' as const;
export const activeRunConflictErrorCode = 'active_run_conflict' as const;
export const intakeRoutingErrorCode = 'intake_routing_error' as const;
```
### Repository additions

The existing repositories can create/read most records. Add only narrow methods needed by the service and conflict mapping:
- `RunRepository.findActiveByTopic(topicId): Promise` to help create typed conflict details after a uniqueness failure.
- `RunRepository.listSteps(runId)` is not appropriate because steps already have a separate repository; use `RunStepRepository.listByRun(runId)` through the service.
- Consider a transaction method for creating conversation, main topic, initial message, setting active topic, and starting run. If the existing repositories cannot compose those writes atomically from core because each repository owns its own transaction, add a persistence-owned method behind a core interface such as `ConversationIngressRepository.createConversationTopicMessageAndRun(...)`.
Prefer atomic creation for the ingress operation. If the implementation cannot atomically create the conversation/topic/message plus lifecycle start with existing interfaces, it should add a narrow transaction boundary rather than accept partial creation. The minimum safe transaction creates:
1. `Conversation` with `activeTopicId: null`.
2. Main `Topic`.
3. `Conversation.activeTopicId` update to the main topic.
4. Optional inbound `Message` under the topic.
5. `Run` plus initial `RunStep` using the exact lifecycle-start helper or construction shared with `startRunLifecycle`, including `deriveRunTerminal`, occurrence initialization, and entry-step shape.
The transaction must still let the active-run unique index reject duplicates if a caller starts a run on an existing topic through the same orchestrator in later service methods.
### Orchestrator interface

A representative core interface:
```typescript
export interface Orchestrator {
  createRun(input: CreateOrchestratedRunInput): Promise;
  createConversationWithFirstRun(input: CreateOrchestratedConversationInput): Promise;
  applyDirective(input: ApplyOrchestratedDirectiveInput): Promise;
  dispatch(input: DispatchRunInput): Promise;
  tick(input: TickInput): Promise;
}
```
`createRun` wraps `startRunLifecycle` for standalone run creation. `createConversationWithFirstRun` owns the composite create path: it calls the atomic ingress repository, receives the persisted run and initial `RunStep`, and publishes the start event after the transaction succeeds. `applyDirective` wraps `applyRunDirective`. `createRun`, `createConversationWithFirstRun`, and `applyDirective` publish run-state-transition events only after persistence succeeds. All methods map errors into orchestrator/service error types.
Use typed errors or discriminated results. Do not require callers to parse error message strings. Suggested codes:
```typescript
export type OrchestratorErrorCode =
  | 'active_run_conflict'
  | 'missing_run'
  | 'terminal_run'
  | 'invalid_transition'
  | 'unknown_work_kind'
  | 'forbidden'
  | 'persistence_failed';
```
### Conflict mapping

SQLite uniqueness errors should be mapped near the persistence/orchestrator boundary. Use whatever error type the current SQLite driver exposes, but keep detection narrow:
- Detect a unique-constraint failure for `runs_one_active_per_topic` or the equivalent SQLite message naming that index/table.
- Query `findActiveByTopic(topicId)` after the failure when possible.
- Throw or return `active_run_conflict` with `topicId` and optional `existingRunId`.
- Do not map all uniqueness errors to active-run conflicts; topic main uniqueness and one-PR uniqueness must remain distinct errors.
Tests should assert the public code and response, not the exact low-level SQLite error string.
### Event bus implementation

Add a small in-memory bus in core:
```typescript
export interface RunEventPublisher {
  publish(event: RunStateTransitionEvent): void;
}

export interface RunEventSubscriber {
  subscribe(input: SubscribeRunEventsInput): RunEventSubscription;
}

export interface RunEventSubscription {
  events: AsyncIterable;
  close(): void;
}
```
Implementation details:
- Generate monotonic or UUID event ids. Tests can inject an id generator and clock.
- Store active subscribers by run id.
- Deliver events to matching subscribers only.
- Bound subscriber buffers so a stalled client cannot grow memory unbounded. A small buffer with disconnect-on-overflow is acceptable for this issue.
- Remove subscribers on `close()` and on HTTP disconnect.
### Concurrency limiter

Implement the limiter as a core utility, not route code. A simple queue is enough:
```typescript
export class RunDispatchQueue {
  constructor(options: { maxConcurrent: number });
  enqueue(work: () => Promise): Promise;
  readonly activeCount: number;
  readonly queuedCount: number;
}
```
The orchestrator's `dispatch` method should call `enqueue`. Tests can hold promises open to assert active count never exceeds the cap. The queue should release capacity in a `finally` block.
### Service interface

Add a core service that routes all run-bearing operations through the orchestrator and uses repositories only for read operations:
```typescript
export interface ControlPlaneService {
  createConversationWithFirstRun(input: ServiceCreateConversationInput): Promise;
  getRun(input: ServiceGetRunInput): Promise;
  listRunSteps(input: ServiceListRunStepsInput): Promise;
  subscribeRunEvents(input: ServiceSubscribeRunEventsInput): Promise;
  tick(input: ServiceTickInput): Promise;
}
```
Each input carries `principal` and tenant. Route handlers should parse HTTP, then call this service. In-process adapters should call the same service directly. For `createConversationWithFirstRun`, the service performs policy checks and minimal intake routing, then delegates the run-creating transaction to `Orchestrator.createConversationWithFirstRun`; it does not call the ingress repository directly. The service does not expose a public direct push-advance/apply-directive method in this issue; advancement remains behind `tick` and orchestrator dispatch with stubbed unit-of-work behavior.
Authorization can use existing policy actions, adding new action strings as needed:
- `conversation.create`
- `run.read`
- `run_steps.list`
- `run_events.stream`
- `run.tick`
Because the current policy point is permissive, tests should verify the service calls it rather than expecting denial behavior unless a stub policy denies.
### Route wiring

Expand `ControlPlaneRouteDependencies` to include the control-plane service or enough dependencies to construct it. Prefer injecting the service to keep route handlers thin.
Route behavior:
- `POST /v1/conversations`: parse request schema, require principal, call service, return `201` and response schema.
- `GET /v1/runs/:id`: parse params, call service, return `200` and `runSchema`; map missing to `404`.
- `GET /v1/runs/:id/steps`: parse params, call service, return `200` and `runStepListResponseSchema`; map missing run to `404` if the service validates parent existence.
- `GET /v1/runs/:id/events`: parse params and require principal before writing headers; if authorized and found, subscribe, write SSE frames until disconnect, then close subscription.
Deprecate the existing `GET /v1/events` route or leave it only if tests and docs clearly mark it as legacy/probe. The issue acceptance wants `GET /runs/{id}/events` to carry run transitions and replace the heartbeat-only handler, so route tests should prevent the legacy constant from being mistaken for live run progress.
### SDK additions

Add methods to `ControlPlaneClient`:
```typescript
createConversationWithFirstRun(request): Promise;
getRun(id: string): Promise;
listRunSteps(id: string): Promise;
subscribeRunEvents(id: string, options?): Promise | AsyncIterable>;
```
For the SSE method, a minimal helper that returns the raw `Response` may be acceptable if the environment lacks a standard EventSource. If so, expose typed parsing utilities for SSE frames or document that the caller consumes `text/event-stream` and validates payloads with `runStateTransitionEventSchema`.
### Control-plane app composition

Update the app composition in `apps/control-plane` to construct and pass:
- Domain repositories from `packages/persistence`.
- Orchestrator instance.
- Event bus instance.
- Dispatch queue with configurable cap.
- Control-plane service.
Keep app boot thin. Environment parsing for the concurrency cap can be added to existing config with a default, such as `AUTOCATALYST_RUN_CONCURRENCY=2` for local development. Tests should inject the value directly rather than depending on process environment where possible.
### Testing

Add targeted tests at each layer:
- Contract tests for new request, response, params, list, event, path, status, and error constants, with a code comment noting that execution-runtime may widen the strict event schema additively later.
- Orchestrator tests for lifecycle start event publication, directive event publication, handler-result-to-transition behavior, active-run conflict mapping, terminal-run rejection, and missing-run mapping.
- Dispatch queue tests for cap enforcement, FIFO/deterministic ordering, release on success, and release on failure.
- Service tests for policy calls, minimal intake routing, delegation of conversation/topic/message/run creation to the orchestrator, tenant checks, run reads, step listing, event subscription, and `tick` behavior.
- Persistence tests for `findActiveByTopic` and active-run conflict detection if new persistence code is added.
- Route tests for all new endpoints, validation failures, not found, conflict mapping, auth, and SSE disconnect cleanup.
- SDK tests for the new REST methods and the chosen SSE helper shape.
- End-to-end integration test that creates work through the service/network surface, subscribes to the run-events stream, triggers a post-subscription transition through `tick` or dispatch, and observes a `run_state_transition` SSE event without relying on replay of the start event.
Run targeted package tests first, then the workspace checks currently recorded in the code map or package scripts.
### Documentation updates

Implementation must update `context-agent/wiki/code-map.md` with:
- The orchestrator module and its authority boundary.
- The control-plane service module and in-process interface.
- The run event bus and SSE route modules.
- New API contract files and route constants.
- New SDK methods.
- Any new app config for run concurrency.
- Any new targeted test commands discovered while implementing.
Human-owned concept docs already describe the target architecture. Do not change them for this issue unless implementation discovers a real mismatch that needs human review.
### Risks and open decisions

- **Atomic ingress transaction:** Existing repository interfaces may not atomically create conversation, topic, message, run, and first step as one unit. If that gap appears, add a narrow persistence transaction interface rather than composing non-atomic writes in route code.
- **SQLite conflict detection:** Low-level unique-constraint messages can vary. Keep detection narrow and test the public conflict code, not the exact driver message.
- **SSE parsing in the SDK:** Browser, Node, and test environments differ in EventSource support. A raw-response stream helper plus schema validation may be safer than introducing an EventSource dependency.
- **Live-only event storage:** This issue can use an in-memory bus. That means subscribers may miss transitions published before they connect; durable replay belongs to later execution-runtime or observability work.
- **Strict event schema now, additive widening later:** The run-state event schema can be strict in `api-contract` for this issue, but implementation comments should make clear that execution-runtime is expected to widen or extend it additively later.
- **No network advancement route:** The network surface for this issue is create, read, step listing, and stream. Tests that need a post-subscription transition should trigger it through an in-process `tick` or dispatch seam while the SSE connection is open.
- **Provider/runner behavior:** Real model execution is unsupported here. Dispatch runs against a stubbed unit of work only, and the orchestrator must not assume provider-specific runner behavior.
## Task list

### Story 1: Add API contracts for orchestrator ingress

#### Task 1.1: Add conversation ingress contract

- **Description:** Create `packages/api-contract/src/conversation-ingress.ts` with `conversationCollectionPath`, `createConversationSuccessStatusCode`, submission-kind schema, create request schema, create response schema, and inferred TypeScript types matching this spec.
- **Acceptance criteria:**
	- The request schema validates project, identity, optional channel, topic title, and submission fields.
	- `submission.workKind` composes `createRunWorkKindSchema` instead of redeclaring the work-kind enum.
	- The response schema includes `conversation`, `topic`, optional `message`, `run`, and `runStep`.
	- Contract tests cover valid requests, invalid intake shapes, response parsing, and exported status/path constants.
- **Dependencies:** None.
#### Task 1.2: Extend run and run-step contracts

- **Description:** Extend `packages/api-contract/src/run.ts` and `packages/api-contract/src/run-step.ts` with route paths, status constants, params schema, ingress work-kind schema, and the run-step list response schema described in this spec.
- **Acceptance criteria:**
	- `runCollectionPath`, `runResourcePath`, `runIdParamsSchema`, `getRunSuccessStatusCode`, and `createRunWorkKindSchema` are exported from `run.ts`.
	- `runStepsPath`, `listRunStepsSuccessStatusCode`, and `runStepListResponseSchema` are exported from `run-step.ts`.
	- Tests cover route constants, params validation, allowed work kinds, rejected unknown work kinds, and list response validation.
- **Dependencies:** None.
#### Task 1.3: Add run-events and error contracts

- **Description:** Add `packages/api-contract/src/run-events.ts` and extend `packages/api-contract/src/errors.ts` with the SSE event contract and error-code constants described in this spec.
- **Acceptance criteria:**
	- `runEventsPath`, `runEventsSuccessStatusCode`, `runEventsMediaType`, `runStateTransitionEventName`, `runStateTransitionKindSchema`, and `runStateTransitionEventSchema` are exported.
	- The event schema validates `type: 'run_state_transition'`, transition kind, run snapshot, run step, tenant, and ISO datetime.
	- `conflictErrorCode`, `activeRunConflictErrorCode`, `intakeRoutingErrorCode`, and `forbiddenErrorCode` are exported without removing existing error constants.
	- Tests cover start events with no `fromStep`, normal transition events with `fromStep`, and rejected malformed events.
- **Dependencies:** Task 1.2.
#### Task 1.4: Re-export and document new contract routes in OpenAPI

- **Description:** Update `packages/api-contract/src/index.ts` and `packages/api-contract/src/openapi.ts` so the new contract files are public and the OpenAPI document includes the new REST and SSE routes.
- **Acceptance criteria:**
	- The public entrypoint exports all named request, response, list, event, path, status, media-type, event-name, and error-code symbols added by this spec.
	- OpenAPI includes `POST /v1/conversations`, `GET /v1/runs/{id}`, `GET /v1/runs/{id}/steps`, and `GET /v1/runs/{id}/events`.
	- The SSE route includes path params, auth metadata, `200` status, and `text/event-stream` metadata according to existing OpenAPI conventions.
	- Entry-point and OpenAPI tests assert the new exports and route registrations.
- **Dependencies:** Tasks 1.1, 1.2, 1.3.
### Story 2: Add persistence seams for atomic ingress and active-run conflicts

#### Task 2.1: Extend core repository interfaces

- **Description:** Update `packages/core/src/domain-repositories.ts` with `RunRepository.findActiveByTopic`, `ConversationIngressRepository`, `CreateConversationTopicMessageAndRunInput`, and `CreateConversationTopicMessageAndRunResult`.
- **Acceptance criteria:**
	- New interfaces use existing contract types for conversation, topic, message, run, and run-step inputs/results.
	- The ingress repository represents one atomic write boundary for conversation, main topic, optional inbound message, run, and initial run step.
	- Existing repository consumers still compile after the interface change.
	- Interface tests or TypeScript compile checks prove the new types are exported through `packages/core/src/index.ts` only when Story 5 exports are added.
- **Dependencies:** Story 1.
#### Task 2.2: Implement active-run lookup in persistence

- **Description:** Add `findActiveByTopic(topicId)` to `DrizzleRunRepository` in `packages/persistence/src/domain-repositories.ts`.
- **Acceptance criteria:**
	- The method returns the non-terminal run for the topic or `null`.
	- The method does not return terminal runs.
	- Persistence tests cover active run found, no run found, and terminal run ignored.
	- The implementation preserves existing row mapping and validation behavior.
- **Dependencies:** Task 2.1.
#### Task 2.3: Implement active-run constraint detection

- **Description:** Add `isActiveRunConstraintViolation` in persistence and use narrow SQLite detection for the `runs_one_active_per_topic` unique constraint.
- **Acceptance criteria:**
	- Detection recognizes the active-run partial unique constraint failure raised by the current SQLite driver.
	- Detection does not classify unrelated uniqueness failures, including main-topic and pull-request uniqueness failures, as active-run conflicts.
	- Tests assert public conflict classification behavior and avoid depending on an exact full SQLite error string where possible.
	- The helper is exported from `packages/persistence/src/index.ts`.
- **Dependencies:** Task 2.2.
#### Task 2.4: Implement atomic conversation ingress repository

- **Description:** Implement `DrizzleConversationIngressRepository.createConversationTopicMessageAndRun` so conversation, main topic, active-topic update, optional message, run, and initial run step are committed or rolled back together when called by the orchestrator.
- **Acceptance criteria:**
	- The transaction creates the conversation with `activeTopicId: null`, creates the main topic, updates the conversation active topic, creates the optional inbound message, and records the initial run plus first `RunStep`.
	- A failure in any write rolls back all prior writes in the transaction.
	- The transaction reuses the exact lifecycle-start construction shared with `startRunLifecycle`, including terminal derivation, occurrence fields, and initial `RunStep` shape.
	- Active-run constraint failures are surfaced as `active_run_conflict` details with `topicId` and optional `existingRunId`.
	- Persistence tests cover successful creation with message, successful creation without message, rollback on forced failure, and duplicate-active-run conflict mapping.
- **Dependencies:** Tasks 2.2, 2.3.
### Story 3: Build run event delivery

#### Task 3.1: Add run-state event construction

- **Description:** Create `packages/core/src/run-events.ts` with `createRunStateTransitionEvent` and shared event input types.
- **Acceptance criteria:**
	- Event construction produces payloads that pass `runStateTransitionEventSchema`.
	- Start events use transition directive `start` and omit `fromStep`.
	- Directive events include `fromStep` when supplied.
	- Tests can inject a clock and id generator for deterministic event ids and timestamps.
- **Dependencies:** Story 1.
#### Task 3.2: Implement in-memory run event bus

- **Description:** Add `InMemoryRunEventBus` and the `RunEventPublisher`, `RunEventSubscriber`, `RunEventSubscription`, and `SubscribeRunEventsInput` interfaces.
- **Acceptance criteria:**
	- Subscribers receive only events matching their run id and tenant.
	- Events are yielded in publication order.
	- `close()` removes the subscriber and stops future delivery.
	- Subscriber buffers are bounded; overflow behavior is deterministic and covered by tests.
	- Tests await events without timing-sensitive sleeps.
- **Dependencies:** Task 3.1.
### Story 4: Build dispatch admission control

#### Task 4.1: Implement deterministic dispatch queue

- **Description:** Create `packages/core/src/run-dispatch-queue.ts` with `RunDispatchQueue` and `RunDispatchQueueOptions`.
- **Acceptance criteria:**
	- The constructor rejects non-positive or non-integer `maxConcurrent` values.
	- `enqueue` runs no more than `maxConcurrent` jobs at once.
	- Queued jobs start in FIFO or another documented deterministic order.
	- Slots are released in a `finally` block after both successful and failed jobs.
	- `activeCount` and `queuedCount` report current queue state for tests.
- **Dependencies:** None.
#### Task 4.2: Add dispatch queue tests for success and failure

- **Description:** Add focused tests that hold promises open to prove cap enforcement, queue ordering, and release behavior.
- **Acceptance criteria:**
	- A test drives more work items than the cap and asserts the active count never exceeds the cap.
	- A test asserts queued work starts after a successful in-flight item completes.
	- A test asserts queued work starts after a failed in-flight item rejects.
	- Rejections propagate to the original `enqueue` caller.
- **Dependencies:** Task 4.1.
### Story 5: Implement orchestrator authority

#### Task 5.1: Add orchestrator errors and public types

- **Description:** Create `packages/core/src/orchestrator.ts` with public interfaces, input/result types, `OrchestratorError`, `OrchestratorErrorCode`, `ActiveRunConflictDetails`, and `RunUnitOfWork` types matching this spec.
- **Acceptance criteria:**
	- Public types match this spec's API names and do not add new required provider-specific fields.
	- `OrchestratorError` carries a stable code, message, optional details, and optional cause.
	- The core package entrypoint re-exports the orchestrator types added by this spec.
	- Type-level or compile tests prove consumers can import the orchestrator API from `@autocatalyst/core`.
- **Dependencies:** Stories 1, 2, 3, 4.
#### Task 5.2: Implement `createRun` and start-event publication

- **Description:** Implement `Orchestrator.createRun` around `startRunLifecycle` and `Orchestrator.createConversationWithFirstRun` around the atomic ingress repository.
- **Acceptance criteria:**
	- `createRun` validates the requested work kind through the workflow catalog and maps unknown work kinds to `unknown_work_kind`.
	- `createRun` persists lifecycle start only through `startRunLifecycle`.
	- `createRun` publishes a `run_state_transition` start event only after persistence succeeds.
	- `createConversationWithFirstRun` calls the atomic ingress repository itself and publishes a `run_state_transition` start event only after the transaction succeeds.
	- Active-run constraint failures map to `active_run_conflict` with structured details.
	- Unit tests cover standalone create success, composite create success, unknown work kind, active-run conflict, failed persistence with no event, and rejection of invalid initial lifecycle state returned by the ingress repository.
- **Dependencies:** Task 5.1.
#### Task 5.3: Implement `applyDirective`

- **Description:** Implement `Orchestrator.applyDirective` around `applyRunDirective` and event publication.
- **Acceptance criteria:**
	- The orchestrator calls the lifecycle primitive instead of reimplementing transition rules.
	- Successful directives publish one `run_state_transition` event after durable state changes.
	- Missing runs, terminal runs, and invalid transitions map to stable orchestrator error codes.
	- Unit tests assert event payload shape, transition order, and no publication on failed transition.
- **Dependencies:** Task 5.2.
#### Task 5.4: Implement dispatch and unit-of-work result handling

- **Description:** Implement `Orchestrator.dispatch` so a stub-friendly `RunUnitOfWork` runs through `RunDispatchQueue` and returns directives for the orchestrator to apply.
- **Acceptance criteria:**
	- Dispatch reads the target run, rejects missing or terminal runs, and submits work through the queue.
	- Unit-of-work results map to lifecycle directives without letting the unit mutate run state directly.
	- A failed unit releases the queue slot and propagates the failure.
	- Tests assert handler-result-to-transition behavior and that the unit of work does not write run state itself.
- **Dependencies:** Tasks 5.3, 4.2.
#### Task 5.5: Implement tick fallback

- **Description:** Implement `Orchestrator.tick` as the non-push reconciliation seam that can dispatch or transition a specified run through the same authority path.
- **Acceptance criteria:**
	- `tick` never bypasses `dispatch` or `applyDirective`.
	- A no-target/no-work case returns `{ status: 'noop' }`.
	- A specified run can be dispatched or transitioned with a stubbed unit of work.
	- Tests cover noop, missing run, and successful reconciliation through a stub.
- **Dependencies:** Task 5.4.
### Story 6: Implement in-process control-plane service

#### Task 6.1: Add service errors and public service types

- **Description:** Create `packages/core/src/control-plane-service.ts` with `ControlPlaneService`, construction options, service input types, `ControlPlaneServiceError`, and `ControlPlaneServiceErrorCode`.
- **Acceptance criteria:**
	- Public types match this spec's API names and carry principal and tenant on each operation.
	- Service errors expose stable machine-readable codes and optional details.
	- The core package entrypoint re-exports the service API types added by this spec.
	- Tests or compile checks prove public imports work from `@autocatalyst/core`.
- **Dependencies:** Story 5.
#### Task 6.2: Implement create conversation with first run

- **Description:** Implement `ControlPlaneService.createConversationWithFirstRun` using policy checks, minimal intake routing, and `Orchestrator.createConversationWithFirstRun`.
- **Acceptance criteria:**
	- The service calls policy action `conversation.create` before writing.
	- The service maps supported submission shapes to the requested workflow/work kind and rejects unsupported or ambiguous shapes with `intake_routing_error`.
	- The service delegates conversation, main topic, optional first inbound message, first run, and first run step creation to `Orchestrator.createConversationWithFirstRun`; it does not call the atomic ingress repository directly.
	- The orchestrator returns a transaction result whose conversation active topic is set to the main topic.
	- The orchestrator publishes the start event after commit; the service does not publish directly to the event bus.
	- Tests cover creation with a message, creation without a message when allowed, policy denial, intake routing failure, active-run conflict, orchestrator delegation, and start-event publication.
- **Dependencies:** Tasks 2.4, 6.1.
#### Task 6.3: Implement run read and step listing

- **Description:** Implement `getRun` and `listRunSteps` with policy checks, tenant checks, typed not-found errors, and persisted-order step listing.
- **Acceptance criteria:**
	- `getRun` calls policy action `run.read`, returns a typed run, maps missing runs to `not_found`, and maps tenant mismatch to `forbidden`.
	- `listRunSteps` verifies the parent run exists and is visible before listing steps.
	- Steps are returned in persisted occurrence order.
	- Tests cover success, missing run, tenant mismatch, policy denial, and a run with only its initial step.
- **Dependencies:** Task 6.1.
#### Task 6.4: Implement run event subscription and tick service methods

- **Description:** Implement `subscribeRunEvents` and `tick` in the control-plane service.
- **Acceptance criteria:**
	- `subscribeRunEvents` checks policy action `run_events.stream`, verifies run existence and tenant scope before opening a subscription, and passes `lastEventId` to the event subscriber input.
	- `tick` checks policy action `run.tick` and delegates to `Orchestrator.tick`.
	- Tests cover subscription success, missing run before stream open, tenant mismatch, policy denial, live-memory-only `lastEventId` pass-through, tick noop, and tick reconciliation through the orchestrator.
- **Dependencies:** Tasks 5.5, 6.3.
### Story 7: Wire HTTP routes and app composition

#### Task 7.1: Inject the control-plane service into route dependencies

- **Description:** Update `ControlPlaneRouteDependencies` and route registration setup so route handlers receive an injected `ControlPlaneService`.
- **Acceptance criteria:**
	- Existing health, probe-resource, configuration, secret, auth, and principal routes keep working.
	- New route handlers do not construct repositories, orchestrators, or event buses directly.
	- Route tests can inject a fake control-plane service.
	- Existing route dependency tests are updated without weakening auth or policy coverage.
- **Dependencies:** Story 6.
#### Task 7.2: Add create, read, and step-list routes

- **Description:** Add authenticated Fastify routes for `POST /v1/conversations`, `GET /v1/runs/:id`, and `GET /v1/runs/:id/steps`.
- **Acceptance criteria:**
	- Routes use schemas and constants from `@autocatalyst/api-contract`.
	- Routes require the bearer auth principal and pass principal and tenant into the service.
	- Success responses use status `201` for create and `200` for reads.
	- Validation and intake routing failures map to `400`, not found to `404`, forbidden to `403`, and active-run conflict to `409` through the shared error envelope.
	- Route tests cover success, validation failures, service error mapping, auth failure, and tenant/principal propagation.
- **Dependencies:** Task 7.1.
#### Task 7.3: Add run-events SSE route

- **Description:** Add authenticated `GET /v1/runs/:id/events` that bridges `ControlPlaneService.subscribeRunEvents` to SSE frames.
- **Acceptance criteria:**
	- The route validates params through `runIdParamsSchema` before opening the stream.
	- The route checks service authorization and existence before writing SSE headers.
	- The route sets `text/event-stream`, no-cache, and connection headers consistent with existing SSE conventions.
	- Frames use `event: run_state_transition`, the event id, and JSON data that validates against the event schema.
	- The route closes the subscription on client disconnect and does not leak listeners.
	- Route tests cover successful event streaming, missing/forbidden before headers, `Last-Event-ID` forwarding, ordered events, and disconnect cleanup.
- **Dependencies:** Task 7.2.
#### Task 7.4: Compose orchestrator dependencies in the control-plane app

- **Description:** Update `apps/control-plane/src/config.ts` and `apps/control-plane/src/server.ts` to read run concurrency config and construct the persistence repositories, event bus, dispatch queue, orchestrator, and control-plane service.
- **Acceptance criteria:**
	- `ControlPlaneAppConfig` includes `runConcurrency`.
	- Config reads `AUTOCATALYST_RUN_CONCURRENCY` or an implementation-equivalent flag with a safe default.
	- Invalid run concurrency values fail startup with a clear error.
	- Server composition injects the constructed service into `registerControlPlaneRoutes`.
	- App tests cover default config, environment or argv override, invalid values, and server construction with injected or real dependencies.
- **Dependencies:** Tasks 7.1, 7.3.
### Story 8: Add SDK support

#### Task 8.1: Add REST client methods

- **Description:** Extend `packages/sdk/src/client.ts` with `createConversationWithFirstRun`, `getRun`, and `listRunSteps`.
- **Acceptance criteria:**
	- Methods use route constants, status constants, and schemas from `@autocatalyst/api-contract`.
	- `createConversationWithFirstRun` sends `POST /v1/conversations` and validates the `201` response.
	- `getRun` and `listRunSteps` call the run routes and validate `200` responses.
	- Shared error envelopes still become `ControlPlaneClientError`.
	- SDK tests cover successful calls, non-2xx error envelopes, unexpected status, and request/response validation.
- **Dependencies:** Story 1, Task 7.2.
#### Task 8.2: Add run-events stream helper

- **Description:** Add `ControlPlaneClient.subscribeRunEvents` plus `RunEventsStreamOptions` and `RunEventsResponse` exports.
- **Acceptance criteria:**
	- The method calls `GET /v1/runs/{id}/events` with bearer auth and optional abort signal.
	- The method sends `Last-Event-ID` when `options.lastEventId` is present.
	- The return value is discriminated as `{ kind: 'response' }` or `{ kind: 'iterable' }` as implemented.
	- If parsed SSE delivery is implemented, parsed payloads validate through `runStateTransitionEventSchema`.
	- Tests cover stream request construction, pre-stream error handling, `Last-Event-ID`, and the chosen response shape.
- **Dependencies:** Task 8.1, Task 7.3.
#### Task 8.3: Re-export SDK additions

- **Description:** Update `packages/sdk/src/index.ts` so the expanded client interface and stream helper types are public.
- **Acceptance criteria:**
	- `ControlPlaneClient`, `createControlPlaneClient`, `RunEventsStreamOptions`, and `RunEventsResponse` are exported.
	- Entry-point tests cover the new exports.
- **Dependencies:** Task 8.2.
### Story 9: Prove end-to-end ingress behavior

#### Task 9.1: Add service-level integration proof

- **Description:** Add a core or app integration test that creates work through the in-process service, subscribes, triggers a post-subscription transition, and observes a `run_state_transition` event.
- **Acceptance criteria:**
	- The test uses real or integration-grade repositories and a real in-memory event bus.
	- The test creates a conversation with its first run through `ControlPlaneService.createConversationWithFirstRun`.
	- The test subscribes through `ControlPlaneService.subscribeRunEvents` after creation.
	- The test triggers a later transition through `ControlPlaneService.tick`, `Orchestrator.dispatch`, or another explicit in-process test seam.
	- The test observes at least one typed run-state transition event published after subscription.
	- The test asserts the run id and tenant on the event match the created run.
- **Dependencies:** Stories 6, 7.
#### Task 9.2: Add network integration proof

- **Description:** Add an end-to-end Fastify integration test that exercises create, read, step list, and SSE over `/v1`.
- **Acceptance criteria:**
	- The test creates a conversation/run through `POST /v1/conversations`.
	- The test reads the run through `GET /v1/runs/{id}`.
	- The test reads steps through `GET /v1/runs/{id}/steps`.
	- The test opens `GET /v1/runs/{id}/events`, then triggers a later transition through an in-process `tick` or dispatch seam.
	- The test observes at least one post-subscription `run_state_transition` SSE event and does not rely on replaying the lifecycle-start event.
	- The test covers auth and tenant scoping at the level supported by the existing development principal and policy seam.
- **Dependencies:** Task 9.1.
#### Task 9.3: Add duplicate-active-run and bounded-dispatch integration coverage

- **Description:** Add integration tests that prove durable duplicate-active-run conflict mapping and per-host dispatch bounds through the orchestrator/service boundary.
- **Acceptance criteria:**
	- A duplicate active run under the same topic maps to `active_run_conflict` in orchestrator/persistence tests.
	- HTTP `409` duplicate-active-run coverage is required only for a current or future network path that can start a run for an existing topic; `POST /v1/conversations` does not support that scenario because it always creates a new main topic.
	- The first run and its initial `RunStep` remain unchanged after the duplicate request fails.
	- Dispatching more units than the configured cap never exceeds the cap.
	- A failed dispatched unit releases capacity and lets queued work continue.
- **Dependencies:** Stories 5, 6, 7.
#### Task 9.4: Update agent code map and run validation

- **Description:** Update `context-agent/wiki/code-map.md` with the new orchestrator, service, event, route, SDK, persistence, and config modules, then run targeted and workspace checks.
- **Acceptance criteria:**
	- The code map lists the new modules and their authority boundaries.
	- The code map records any new targeted test commands discovered during implementation.
	- Targeted tests run for affected packages: `api-contract`, `core`, `persistence`, `sdk`, and `control-plane`.
	- Broader validation runs with `pnpm validate` unless blocked by an environment issue.
	- Any skipped check is documented with the exact reason.
- **Dependencies:** All implementation tasks.