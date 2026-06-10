---
created: 2026-06-10
last_updated: 2026-06-10
status: complete
issue: 23
specced_by: autocatalyst
---
# Feature: Runner event consumer and step result checkpoints

## Product requirements

### What

Add a control-plane event consumer that drains the typed event stream emitted by a runner while a run executes. The consumer stores every event in the live run-event stream, re-streams those events over the existing `GET /v1/runs/:id/events` Server-Sent Events endpoint, passes only the validated terminal result into orchestration, and records validated step results on `RunStep` as durable checkpoints.
The feature expands the existing live stream from state-transition-only events to the full runner event vocabulary: assistant turns, tool activity, structured progress, notifications, importance hints, step checkpoints, and terminal results. It also makes `Last-Event-ID` reconnect work for active runs within the event retention window.
### Why

Issue 21 gave the system a runner boundary and typed event vocabulary. Issue 22 added the result-contract tolerance pipeline that validates the terminal handoff before core consumes it. The control plane still treats run events mostly as state transitions: the SSE endpoint can show a state change, but not the runner's live typed stream, and it cannot replay recent events to a reconnecting client.
Autocatalyst needs one event path that all runner output uses. Clients should watch a run live without polling, reconnect without losing recent context, and later inspect the durable step checkpoint that drove workflow transition. The control plane should own what it stores and re-streams; runners should only emit typed events and terminal results.
### Goals

- Consume the complete typed runner event stream during the existing bounded-concurrency run dispatch.
- Persist each consumed event into the live/reconnect event store for an active run.
- Re-stream each persisted event to subscribed clients over `GET /v1/runs/:id/events`.
- Support `Last-Event-ID` resume from the event after the supplied id when the event remains inside the retention window.
- Preserve existing run state-transition events and make them part of the same stream observed by clients.
- Hand the validated terminal result from the issue 22 execution boundary into the run; downstream logic must not consume raw runner output.
- Record the last validated step result on the relevant `RunStep` occurrence as a durable checkpoint.
- Make structured progress tools (`update_plan`, `report_progress`, and `notify`) available to the runner and route their emitted events through the same consumer path.
- Degrade gracefully when optional progress signals are missing or malformed; stream delivery and run execution must continue with less structure.
- Prove live delivery, reconnect replay, terminal result handoff, `RunStep` checkpoint persistence, and progress-signal degradation in integration coverage.
### Non-goals

- Creating the permanent session-grain observability archive for all runner turns.
- Cross-runner uniform telemetry beyond the live/reconnect event stream and `RunStep` checkpoint.
- Recovery or resume-on-load from a checkpoint after process restart.
- Real Claude, OpenAI, direct provider, model-routing, request-alteration, or skill-materialization adapters.
- UI rendering decisions for progress, notifications, or importance hints.
- Opening pull requests, pushing branches, merging, or publishing remote git changes.
### Personas

- **Opal (Operator)** needs to watch a run while it executes, reconnect after a network interruption, and trust that recent events replay in order.
- **Enzo (Engineer)** needs one control-plane event path instead of separate ad hoc code for state transitions, progress, checkpoints, and terminal results.
- **Phoebe (PM)** needs confidence that structured progress improves visibility without making runs fragile when optional model signals are missing.
- **Dani (Designer)** needs the API to carry enough typed event detail and importance hints for future surfaces to decide what to show.
### User stories

- As Opal, I can subscribe to `GET /v1/runs/:id/events` before or during dispatch and see runner progress events as they happen.
- As Opal, I can reconnect with `Last-Event-ID` and receive events after that id while the run is still inside the retention window.
- As Enzo, I can plug the runner event stream into a single consumer that validates, stores, publishes, and handles terminal output.
- As Enzo, I can inspect a run's `RunStep` history and find the last validated result that caused a step transition.
- As Phoebe, I can rely on missing optional progress structure reducing detail rather than failing a run.
- As Dani, I can design future run-progress views using typed assistant-turn, tool, progress, notification, checkpoint, and importance fields.
### Acceptance criteria

#### Event vocabulary and consumer

- The control-plane consumer accepts the full typed runner event vocabulary already defined by `@autocatalyst/api-contract`, not only `run_state_transition`.
- The consumer drains events while the run executes within the existing `RunDispatchQueue` bounded-concurrency path.
- Each event is validated before it is stored or published.
- Events with the wrong run id, duplicate terminal events, or events after a terminal result still fail through the existing runner protocol error rules.
- The consumer preserves event order for one run.
- The consumer records enough metadata to enforce tenant scoping for both live subscribers and reconnect replay.
#### Live/reconnect event store

- A run-event store persists each consumed event for active-run replay within a bounded retention window.
- `Last-Event-ID` replay starts after the supplied event id, not at or before it.
- Reconnect replay is scoped by run id and tenant.
- If `Last-Event-ID` is absent, a subscriber receives new live events and any explicit initial replay behavior documented by the implementation.
- If `Last-Event-ID` is unknown, older than the retention window, or otherwise not replayable, the endpoint returns a pre-stream HTTP `409 Conflict` JSON error and does not open or continue the SSE stream. The error payload is `{ "error": { "code": "run_event_replay_cursor_unknown" | "run_event_replay_cursor_expired", "message": string, "lastEventId": string } }`. Use `run_event_replay_cursor_expired` when retained expired-id metadata proves the id once existed for that run and tenant; use `run_event_replay_cursor_unknown` when no retained event or expired-id metadata matches the id.
- `run_event_replay_cursor_expired` is the documented signal that turn-grain live events are no longer replayable; clients recover by reading durable run and step state with `GET /v1/runs/:id` and `GET /v1/runs/:id/steps`.
- Retention limits prevent unbounded memory or database growth.
#### SSE transport

- `GET /v1/runs/:id/events` streams persisted typed events, including runner progress and terminal events, not only state transitions.
- SSE frames include stable `id`, `event`, and JSON `data` fields.
- Successful streams continue to flush an initial connection comment so clients resolve promptly; invalid reconnect cursors fail before that comment or any SSE frame is written.
- Existing auth, tenant checks, and policy behavior remain in force.
- The SDK `subscribeRunEvents` path continues to work with the expanded event stream.
#### Terminal result and orchestration

- The event consumer passes the validated issue 22 terminal result to orchestration.
- Downstream run-transition logic consumes only the validated terminal value.
- A validation failure is represented as a sanitized failure directive, not as raw malformed output.
- The terminal event is stored and re-streamed after validation has made it safe for control-plane consumption.
#### `RunStep` checkpoint persistence

- `RunStep` can store the validated result for the step occurrence that just completed.
- `recordRunStepTransition` or a narrow adjacent lifecycle seam writes the step result atomically with the run transition.
- `GET /v1/runs/:id/steps` returns the stored step result through the shared API contract when present.
- Result JSON is schema-validated as shared `JsonValue`-compatible data before persistence.
- Stored results are sanitized and never include raw model output, host paths, secrets, or ambient environment values.
#### Structured progress tools

- The runner has typed tool surfaces for `update_plan`, `report_progress`, and `notify`.
- `update_plan` maps to a plan-style `runner_progress` event.
- `report_progress` maps to task-progress or intent-style `runner_progress` events.
- `notify` maps to a `runner_notification` event with severity and importance where available.
- Missing or malformed optional progress payloads degrade through the issue 22 tolerance handling; they do not fail the run.
- Unsupported provider behavior is isolated behind runner/tool adapter seams and is not required beyond the stub runner.
#### Tests

- An integration test dispatches the stub runner and asserts that events are persisted to the live/reconnect store.
- The same or a paired integration test asserts that a subscribed client observes runner events live over SSE.
- A reconnect test supplies `Last-Event-ID` and receives events after that id.
- A terminal-result test asserts that the validated result is handed to the run, exposed over SSE only in the safe `runner_terminal_result` handoff shape, and recorded on the appropriate `RunStep`.
- A progress-degradation test proves a missing optional progress signal produces a less-structured stream without failing the run.
- Targeted tests cover event-store retention, tenant/run scoping, unknown or expired `Last-Event-ID`, SSE frame formatting, and `RunStep` result serialization.
## Design spec

### Design scope

This is a backend execution and API feature. It does not add a visual UI. The design work is the runtime experience for operators and developers: the event stream should be timely, ordered, replayable within the live retention window, and safe to consume.
### Operator experience

A subscriber should be able to connect before dispatch starts and watch a run progress through typed events. If the network drops, the subscriber should reconnect with the last event id it processed and receive the next retained event. If the requested event is no longer retained, the response should make the limit clear instead of pretending the stream is complete.
The live stream is not the permanent history of a finished run. A client looking at an old run, or receiving `409 Conflict` with `error.code: "run_event_replay_cursor_expired"`, should use durable run and step reads such as `GET /v1/runs/:id` and `GET /v1/runs/:id/steps`. Those reads show the durable step checkpoint, not every turn-grain event.
### Developer experience

A developer should wire execution through one consumer rather than remembering to publish events in multiple places. The consumer should expose small, typed dependencies: an execution entry point, a retained `RunEventStore`, and a lifecycle transition function. `RunEventStore.append` is the sole publication side effect for retained events: it validates, retains, and fans out to matching live subscribers. Tests should be able to replace each dependency with in-memory fakes.
Runner adapter authors should emit typed events and terminal results. They should not know how SSE frames are formatted, how `Last-Event-ID` replay is implemented, or how `RunStep` rows are updated.
### Event flow

The happy path is:
1. The orchestrator dispatches a run through `RunDispatchQueue`.
2. The execution unit of work starts the configured `ExecutionEntryPoint`.
3. The runner emits non-terminal events such as assistant turns, tool activity, progress, notifications, and checkpoints.
4. The event consumer validates each event and appends it to the live/reconnect store; `RunEventStore.append` retains the event and publishes it to current subscribers.
5. The runner emits a terminal result.
6. The issue 22 result pipeline validates the terminal handoff before core consumes it.
7. The consumer appends the safe terminal event; `RunEventStore.append` retains and publishes it.
8. Orchestration applies the validated directive.
9. The lifecycle persistence seam records the transition and the validated result checkpoint on `RunStep`.
10. The state-transition event emitted by the lifecycle layer enters the same run-event stream so clients see both runner activity and workflow movement. Because that state transition is emitted after the lifecycle write commits, an append failure for this trailing post-commit event is logged and surfaced to observability, but the committed transition stands and the API call must not pretend the transition failed solely because the live/reconnect append failed.
### Reconnect flow

The reconnect path is:
1. A client stores the latest SSE `id` it processed.
2. The client reconnects to `GET /v1/runs/:id/events` with `Last-Event-ID`.
3. The control plane authorizes the run and tenant as usual.
4. The event store returns retained events for that run and tenant after the supplied id.
5. The endpoint writes replayed frames first, then continues with live frames from the same subscription.
6. If the id is unknown or expired, the endpoint closes the live subscription created for replay safety, returns HTTP `409 Conflict` before streaming starts, and writes JSON `{ "error": { "code": "run_event_replay_cursor_unknown" | "run_event_replay_cursor_expired", "message": string, "lastEventId": string } }`. It must not emit a typed SSE error event, silently downgrade to live-only streaming, or replay data from another run or tenant. For `run_event_replay_cursor_expired`, the client recovery path is to abandon live replay for that cursor and read durable state from `GET /v1/runs/:id` and `GET /v1/runs/:id/steps`.
### Progress tool behavior

`update_plan`, `report_progress`, and `notify` are structured conveniences, not hard run requirements. The runner should turn valid tool calls into the corresponding typed events. If the agent omits a plan, sends partial progress, or provides an optional field with the wrong shape, the event path should either emit a coarser valid event or omit that progress event and continue.
This preserves ADR-012: optional progress signals improve the stream when they are available, but the run should not fail because the model failed to describe progress perfectly.
### `RunStep` checkpoint behavior

The validated terminal result belongs to the step that just completed. The durable checkpoint should be written to the exact source `RunStep` occurrence that was current when the dispatched unit of work started. `applyRunDirective`/`recordRunStepTransition` should carry a `sourceRunStepId` resolved from lifecycle state before transition persistence begins, and persistence must update that row scoped by run id and current step. If a legacy in-memory seam cannot provide an id, it may resolve the source as the latest open occurrence for the current step by occurrence index, attempt, and `startedAt`; zero matches or multiple equally latest open matches are protocol/persistence errors and must not create a checkpoint on a historical, retried, or destination step. If the current repository seam can only create the destination step, implementation should extend the lifecycle write so it can atomically complete/update the source step and create the destination step in one transaction.
The checkpoint should store only the validated result object or a documented safe subset. It must not store the raw scratch-root candidate, validation issue details that include sensitive excerpts, or provider-specific transcript text.
### Error and degradation design

The event consumer should distinguish protocol failures from optional-signal degradation:
- Protocol failures include malformed required event fields, wrong run id, duplicate terminal result, or events after terminal.
- Terminal result failures are handled by the issue 22 validation path and become sanitized fail directives where possible.
- Optional progress-signal failures become omitted or less-specific progress events and are recorded only as safe metadata when useful.
- Subscriber overflow or disconnect should close only that subscriber and should not fail the run.
- Event-store append failures while draining runner output before a terminal result is consumed are control-plane failures because reconnect and live stream consistency would no longer be trustworthy for the in-flight unit of work.
- Event-store append failures for trailing state-transition events emitted after lifecycle persistence has committed are post-commit publication failures: log them, expose safe operational metadata, and leave the durable transition and API result intact.
## Tech spec

### Current state

- `packages/api-contract/src/runner-events.ts` defines the runner event vocabulary and importance hint.
- `packages/api-contract/src/run-events.ts` defines `run_state_transition` events used by the current SSE stream.
- `packages/api-contract/src/step-results.ts` defines the post-validation terminal handoff from issue 22.
- `packages/execution/src/execution-entry-point.ts` validates raw runner protocol events, buffers the raw terminal, validates the scratch-root result in `scratch_file` mode, and yields `ExecutionBoundaryEvent` values.
- `packages/core/src/execution-run-unit-of-work.ts` drains `ExecutionBoundaryEvent` streams and maps terminal handoffs to `RunWorkResult`.
- `packages/core/src/run-events.ts` has `InMemoryRunEventBus`, but it publishes only `RunStateTransitionEvent` and does not replay retained history.
- `packages/core/src/routes.ts` formats `GET /v1/runs/:id/events` as SSE frames, currently using the state-transition schema and event name.
- `packages/core/src/orchestrator.ts` publishes state-transition events after lifecycle changes and applies unit-of-work directives.
- `apps/control-plane/src/server.ts` is the composition root that currently constructs `InMemoryRunEventBus` and injects it into both the orchestrator and control-plane service.
- `packages/core/src/domain-repositories.ts` exposes `recordRunStepTransition` as the lifecycle persistence seam.
- `packages/persistence/src/schema.ts` and `packages/api-contract/src/run-step.ts` model `RunStep` without a step-result checkpoint field today.
### Proposed modules and ownership

Add or update API contract modules:
- `packages/api-contract/src/run-events.ts` — introduce a union schema for client-visible run stream events. It should include existing `run_state_transition` and safe runner event shapes. If event names remain separate, expose typed names for each frame type.
- `packages/api-contract/src/run-step.ts` — add an optional nullable validated result checkpoint field, using shared JSON-value schema conventions.
- `packages/api-contract/src/index.ts` — export expanded run-event and `RunStep` types.
Add or update core modules:
- `packages/core/src/run-events.ts` — replace or extend `InMemoryRunEventBus` with a retained `RunEventStore` whose append/replay/subscribe methods accept the expanded event union. The default implementation may remain in-memory for this issue, but it must support bounded replay by run id, tenant, and `Last-Event-ID`.
- `packages/core/src/runner-event-consumer.ts` — own the consumer that drains execution events, appends them to the run-event store for retention and live fan-out, extracts the validated terminal result, and returns the `RunWorkResult` consumed by orchestration.
- `packages/core/src/execution-run-unit-of-work.ts` — delegate event draining to the consumer or inline the consumer behavior behind a testable helper.
- `packages/core/src/orchestrator.ts` — pass validated advance results into lifecycle transition persistence so `RunStep` can record them.
- `packages/core/src/run-lifecycle.ts` and `packages/core/src/domain-repositories.ts` — extend transition input/output types with an optional validated step result checkpoint.
- `packages/core/src/routes.ts` — stream the expanded event union and perform replay from the retained store before live subscription frames.
- `packages/core/src/control-plane-service.ts` — keep tenant checks and subscription ownership intact while forwarding `Last-Event-ID` to the expanded event stream.
Add or update persistence modules:
- `packages/persistence/src/schema.ts` — add a nullable `result_json` or `checkpoint_result_json` column to `run_steps`.
- `packages/persistence/drizzle/*` — add a migration for the new `RunStep` result column.
- `packages/persistence/src/domain-repositories.ts` — serialize, parse, validate, and atomically write the optional `RunStep` result checkpoint in `recordRunStepTransition`.
Add or update execution modules:
- `packages/execution/src/stub-runner.ts` — expose scripted `update_plan`, `report_progress`, and `notify` behavior, including optional malformed/missing signals for degradation tests.
- `packages/execution/src/runner.ts` or a new package-level module — define provider-neutral progress tool call shapes if they are not already expressed by the runner event schemas.
Add or update control-plane app modules:
- `apps/control-plane/src/server.ts` — replace `new InMemoryRunEventBus()` wiring with the retained run-event store and inject the same store into both the orchestrator/execution path and subscription service. This composition-root migration is required so the app does not compile against stale state-transition-only bus types.
- `apps/control-plane/src/integration.spec.ts` or `apps/control-plane/src/control-plane-service.integration.spec.ts` — assert the app-level SSE behavior with the retained store, including live delivery, reconnect replay, expired-cursor HTTP 409 fallback signaling, and tenant scoping.
### Implementation touch points

Area
Files
Required change

Shared contracts
`packages/api-contract/src/run-events.ts`, `packages/api-contract/src/run-step.ts`, `packages/api-contract/src/index.ts`
Expand the client-visible event union and add nullable `RunStep.checkpointResult`.

Core event path
`packages/core/src/run-events.ts`, `packages/core/src/runner-event-consumer.ts`, `packages/core/src/execution-run-unit-of-work.ts`, `packages/core/src/orchestrator.ts`, `packages/core/src/run-lifecycle.ts`, `packages/core/src/domain-repositories.ts`
Replace the state-transition-only bus with retained append/replay/subscribe, drain runner events once, and carry validated checkpoints into lifecycle persistence.

SSE and service
`packages/core/src/routes.ts`, `packages/core/src/control-plane-service.ts`
Stream expanded events, enforce tenant-scoped replay, and return pre-stream 409 cursor errors.

Control-plane composition
`apps/control-plane/src/server.ts`
Construct and share the retained event store instead of `InMemoryRunEventBus`; inject it into both orchestration/execution and SSE subscription paths.

Durable storage
`packages/persistence/src/schema.ts`, `packages/persistence/drizzle/*`, `packages/persistence/src/domain-repositories.ts`
Add and atomically write nullable checkpoint JSON on the source `RunStep`.

Execution progress seams
`packages/execution/src/stub-runner.ts`, `packages/execution/src/runner-progress-tools.ts` or equivalent
Emit/degrade structured progress and notification events without requiring real provider support.

End-to-end coverage
`apps/control-plane/src/integration.spec.ts` or `apps/control-plane/src/control-plane-service.integration.spec.ts`
Verify app wiring, live SSE, reconnect, expired-cursor fallback signaling, checkpoint persistence, and degradation behavior.

### Event data shape

The client-visible stream should be one typed union. A representative shape is:
```typescript
type ClientRunEvent =
  | RunStateTransitionEvent
  | RunnerAssistantTurnEvent
  | RunnerToolActivityEvent
  | RunnerProgressEvent
  | RunnerNotificationEvent
  | RunnerStepCheckpointEvent
  | RunnerTerminalResultEvent;
```
Every variant must include:
- `id` for SSE resume;
- `runId` for scoping;
- `tenant` or an equivalent server-side tenant association for authorization and replay;
- `createdAt` for ordering and retention;
- a discriminating `type`.
If raw runner events do not carry tenant, the consumer should add tenant association in the store record rather than mutating the public payload. Public payloads should still validate through shared schemas before clients receive them.
For `runner_terminal_result`, the client-visible event is the post-validation execution-boundary terminal handoff, not the raw runner terminal payload. Its `result` field must use the safe `RunnerTerminalStepResult` shape: `{ directive: 'advance'; result?: Record }`, `{ directive: 'needs_input'; question?: string }`, or `{ directive: 'fail'; reason?: string }`, with the existing directive cross-field rules. When present, `result.result` is the validated checkpoint value that orchestration also persists on `RunStep.checkpointResult`. SSE must not expose a raw, pre-validation candidate result, result-file contents that failed validation, provider-private metadata, or any separate unvalidated payload. Implementations may include a validated `resultContract` identifier on the terminal event when useful for debugging or client rendering.
### Event store contract

A small store interface should separate retention from transport:
```typescript
interface RunEventStore {
  append(input: AppendRunEventInput): Promise;
  replayAfter(input: { runId: string; tenant: string; lastEventId?: string }): Promise;
  subscribe(input: { runId: string; tenant: string }): RunEventSubscription;
}
```
`RunEventReplayResult` should distinguish at least:
- `ok` with ordered retained events;
- `unknown_event_id` when the id is not in the retained sequence for that run and tenant;
- `expired_event_id` when the default retained store can prove the id was once known for that run and tenant but has fallen out of retention.
The default implementation should bound retention by count, time, or both. It must also keep bounded expired-id metadata, scoped by run id and tenant, for ids evicted by the same store instance so `replayAfter` can return `expired_event_id` instead of `unknown_event_id` for retained-history gaps it created. An id with no retained event and no expired-id metadata returns `unknown_event_id`. Tests should use injectable clocks and ids so replay order is deterministic. `append` is the only publication path for retained run events: after schema and scope validation, it must retain the event before fan-out to matching subscribers, and callers must not separately invoke a publisher for the same event. `subscribe` is a live-only operation; it does not interpret, validate, or deduplicate `Last-Event-ID`. Reconnect cursor interpretation belongs to `replayAfter`, which the route calls after creating the live subscription.
### Consumer algorithm

The consumer should follow this order:
1. Start draining `ExecutionBoundaryEvent` values for the dispatched run.
2. For each non-terminal event, validate the event and call `RunEventStore.append`; append retains it and publishes it to live subscribers.
3. For the terminal event, validate that it is an issue 22 execution-boundary terminal handoff.
4. Call `RunEventStore.append` for the terminal event only after the terminal payload is safe for control-plane use.
5. Map the terminal result to `RunWorkResult`.
6. Return the directive to orchestration; for advance directives, `workResult.result` is the optional validated result checkpoint.
7. Let orchestration apply the workflow transition and persist the checkpoint on `RunStep` atomically.
8. After the lifecycle transition commits, attempt to append the resulting `run_state_transition` event through the same expanded event store so append performs retention and live publication.
If the append fails before a terminal result is consumed, the unit of work should fail the run with a sanitized control-plane failure. If the trailing post-commit `run_state_transition` append fails after `recordRunStepTransition` has durably committed the transition and checkpoint, log the append failure and keep the committed transition as the source of truth; do not fail the API call or roll back. If publishing to one subscriber fails, only that subscriber should close.
### `RunStep` result checkpoint schema

Add an optional result field to the shared `RunStep` schema. Suggested contract:
```typescript
result: jsonValueSchema.nullable()
```
or, if a more explicit name reads better in the domain model:
```typescript
checkpointResult: jsonValueSchema.nullable()
```
Use one name consistently across API contract, persistence schema, row mappers, repository inputs, and tests. The result value should be nullable for historical rows and for steps that have not produced a validated result.
### SSE formatting

The route should format frames from the event union. Recommended frame naming:
- `event: run_state_transition` for state transitions;
- `event: runner_assistant_turn`, `runner_tool_activity`, `runner_progress`, `runner_notification`, `runner_step_checkpoint`, and `runner_terminal_result` for runner events.
The `id` line should always use the event id. The `data` line should contain the complete validated JSON payload for that event. The endpoint should replay retained events before awaiting live events from the subscription.
### Testing plan

Targeted tests should include:
- `packages/core/src/run-events.spec.ts` for append, live publish, replay after id, tenant scoping, retention overflow, unknown id, expired id, and subscriber overflow.
- `packages/core/src/runner-event-consumer.spec.ts` for event drain order, terminal mapping, append failure, progress degradation, and protocol error behavior.
- `packages/core/src/execution-run-unit-of-work.spec.ts` for delegated consumer behavior and validated result propagation.
- `packages/core/src/orchestrator.spec.ts` and `packages/core/src/run-lifecycle.spec.ts` for passing validated result checkpoints into lifecycle persistence.
- `packages/api-contract/src/run-events.spec.ts` for the expanded client-visible event union, including a `runner_terminal_result` payload with the validated checkpoint result and rejection of raw or unvalidated terminal payload fields.
- `packages/api-contract/src/run-step.spec.ts` for optional result checkpoint validation.
- `packages/persistence/src/__tests__/run-lifecycle-persistence.spec.ts` for atomic `RunStep` result writes and migration behavior.
- `packages/core/src/routes.spec.ts` for SSE frame names, ids, data shape, `runner_terminal_result` SSE exposure of only the validated terminal handoff, replay-before-live behavior, and reconnect edge cases.
- `packages/sdk/src/client.spec.ts` for the expanded `subscribeRunEvents` typing.
- `apps/control-plane/src/integration.spec.ts` or `apps/control-plane/src/control-plane-service.integration.spec.ts` for stub-runner dispatch, live SSE observation, reconnect with `Last-Event-ID`, persisted events, validated terminal result handoff, `RunStep` checkpoint persistence, and optional progress degradation.
Suggested commands:
```bash
pnpm nx test api-contract -- run-events.spec.ts run-step.spec.ts
pnpm nx test core -- run-events.spec.ts runner-event-consumer.spec.ts execution-run-unit-of-work.spec.ts orchestrator.spec.ts run-lifecycle.spec.ts routes.spec.ts
pnpm nx test persistence -- run-lifecycle-persistence.spec.ts domain-migrations.spec.ts
pnpm nx test sdk -- client.spec.ts
pnpm nx test control-plane -- integration.spec.ts control-plane-service.integration.spec.ts
pnpm test:boundaries
pnpm validate
```
### Risks and open edges

- The default live/reconnect store may be process-local in this issue. That supports active-run reconnect in one process but does not provide recovery after a process restart.
- Provider-specific support for `update_plan`, `report_progress`, and `notify` is unsupported beyond the stub/tool seam in this feature.
- The exact `RunStep` result field name should be chosen once and used consistently; renaming it later would touch API, persistence, SDK, and docs.
- Unknown or expired `Last-Event-ID` behavior must be explicit so clients can recover safely; expired cursors should drive clients to durable run and step reads rather than a broken SSE retry loop.
- Storing terminal events only after validation may slightly delay the final stream frame, but it keeps malformed output away from the control plane.
## Task list

### Story 1: Expand shared API contracts for the run stream and step checkpoints

#### Task 1.1: Define the client-visible run event union

Description: Update `packages/api-contract/src/run-events.ts` so clients can validate every event variant in the agreed stream: state transitions, assistant turns, tool activity, progress, notifications, step checkpoints, and terminal results. Keep `run_state_transition` as one `ClientRunEvent` variant and add `formatRunEventFrameName`.
Acceptance criteria:
- `clientRunEventSchema` accepts all agreed safe event variants and rejects unknown or malformed variants.
- The `runner_terminal_result` variant uses the post-validation `RunnerTerminalStepResult` handoff shape, accepts an optional validated checkpoint result for `advance`, and rejects raw or unvalidated terminal payload fields.
- `runEventFrameNameSchema`, `RunEventFrameName`, and `formatRunEventFrameName` produce the exact frame names listed in this spec's SSE formatting section.
- Existing state-transition event fields and behavior remain compatible with current callers.
- `packages/api-contract/src/index.ts` re-exports the new run-event types and helpers.
- Targeted contract tests cover every event variant and frame-name mapping.
Dependencies: None.
#### Task 1.2: Add replay result contract types

Description: Add `runEventReplayStatusSchema`, `RunEventReplayStatus`, `runEventReplayResultSchema`, and `RunEventReplayResult` to `packages/api-contract/src/run-events.ts`.
Acceptance criteria:
- Replay results support `ok`, `unknown_event_id`, and `expired_event_id`.
- The `ok` variant carries `readonly ClientRunEvent[]`.
- Unknown and expired variants include the requested `lastEventId`.
- Contract tests cover valid and invalid replay result payloads.
Dependencies: Task 1.1.
#### Task 1.3: Add nullable `checkpointResult` to `RunStep`

Description: Update `packages/api-contract/src/run-step.ts` so read models include `checkpointResult: JsonValue | null`, while step creation inputs remain checkpoint-free.
Acceptance criteria:
- `runStepSchema` requires `checkpointResult` on read models and validates it as nullable `JsonValue`.
- Historical or incomplete steps can be represented with `checkpointResult: null`.
- `createRunStepInputSchema` remains strict and rejects `checkpointResult`.
- `RunStep` and `CreateRunStepInput` exports match the API contract described in this spec.
- Tests cover valid JSON checkpoint values, `null`, and rejected create input payloads that include `checkpointResult`.
Dependencies: None.
### Story 2: Replace the state-transition-only event bus with a retained run event store

#### Task 2.1: Implement the `RunEventStore` contract

Description: Replace or extend `packages/core/src/run-events.ts` with the agreed retained store interfaces and an `InMemoryRetainedRunEventStore` implementation.
Acceptance criteria:
- `RunEventStore`, `RunEventStoreScope`, `AppendRunEventInput`, `ReplayRunEventsInput`, `SubscribeRunEventsInput`, `RunEventSubscription`, `RetainedRunEventStoreOptions`, and `InMemoryRetainedRunEventStore` are exported.
- `append` validates `ClientRunEvent`, verifies the event run id matches the supplied scope, retains the event, then publishes it to matching subscribers.
- No separate publisher API is used for the retained stream; callers publish by awaiting `RunEventStore.append`.
- `replayAfter` returns retained events strictly after `lastEventId`.
- `replayAfter` returns `{ status: 'ok', events: [] }` when `lastEventId` is absent.
- `subscribe` creates a live subscription scoped by run id and tenant and does not accept or interpret `lastEventId`.
- The previous state-transition helper remains available as `createRunStateTransitionEvent`.
Dependencies: Task 1.1 and Task 1.2.
#### Task 2.2: Enforce retention, ordering, and tenant isolation

Description: Add deterministic retention behavior to `InMemoryRetainedRunEventStore` using configured count, time, subscriber buffer, id, and clock hooks.
Acceptance criteria:
- Events replay in append order for one run.
- Replay never returns events for another run or tenant.
- Retention limits prevent unbounded growth per run.
- Unknown ids return `unknown_event_id`.
- The default retained store records bounded expired-id metadata for evicted ids, scoped by run id and tenant.
- Evicted ids still covered by that metadata return `expired_event_id`; ids never seen by that store instance, or older than the expired-id metadata window, return `unknown_event_id`.
- Subscriber overflow closes only that subscriber and does not fail the run.
- Tests cover append order, live publish, replay after id, tenant scoping, retention overflow, unknown id, expired id, and subscriber overflow.
Dependencies: Task 2.1.
#### Task 2.3: Migrate core event dependencies to retained-store slices

Description: Update core wiring types and the control-plane composition root that currently accept or construct `RunEventPublisher`, `RunEventSubscriber`, or `RunEventBus` so they accept `RunEventStore` or a narrow async slice of it.
Acceptance criteria:
- Stale synchronous bus types are removed or marked deprecated in favor of the retained store.
- Core constructors compile with the new event-store dependency.
- `apps/control-plane/src/server.ts` constructs the retained store and injects one shared instance into both the orchestrator/execution path and the service/SSE subscription path.
- No caller assumes events are state-transition-only.
- Append failures during pre-terminal runner-event draining can propagate as awaited control-plane failures instead of unhandled promises; post-commit state-transition append failures are caught, logged, and do not invalidate an already committed transition.
Dependencies: Task 2.1.
### Story 3: Consume execution-boundary runner events through one control-plane path

#### Task 3.1: Add `consumeRunnerEvents`

Description: Create `packages/core/src/runner-event-consumer.ts` to drain execution-boundary events, validate and append client-visible events through the retained store, and map the safe terminal event to `RunWorkResult`.
Acceptance criteria:
- `RunnerEventConsumerDependencies`, `ConsumeRunnerEventsInput`, `ConsumeRunnerEventsResult`, and `consumeRunnerEvents` match the contracts described in this spec.
- Non-terminal events are validated and appended; subscribers see them only through the `RunEventStore.append` fan-out side effect.
- Terminal events are appended only after the issue 22 terminal payload is safe for control-plane use.
- Duplicate terminal events, wrong run ids, malformed required fields, and events after terminal fail with existing runner protocol error behavior.
- Append failures before terminal consumption fail the unit of work with sanitized control-plane failure details.
- The returned checkpoint candidate is only `result.workResult.result` when the directive is `advance`.
Dependencies: Task 1.1 and Task 2.1.
#### Task 3.2: Delegate execution unit-of-work draining to the consumer

Description: Update `packages/core/src/execution-run-unit-of-work.ts` so it delegates event stream processing to `consumeRunnerEvents` or a narrow injectable helper.
Acceptance criteria:
- `createExecutionRunUnitOfWork` accepts the retained event store and consumer hooks described in this spec.
- Terminal mapping still produces the same `RunWorkResult` directives as issue 22.
- Sanitized materialization and protocol errors keep their existing public behavior.
- Tests prove validated result propagation, consumer delegation, append failure behavior, and protocol error behavior.
Dependencies: Task 3.1.
#### Task 3.3: Preserve terminal-result validation as the orchestration boundary

Description: Ensure downstream orchestration consumes only the validated terminal result produced by the execution boundary and consumer.
Acceptance criteria:
- Raw runner output cannot reach `RunWorkResult` mapping.
- Terminal validation failures become sanitized fail directives when the issue 22 tolerance pipeline allows recovery.
- The terminal event stored in the stream contains only the safe validated payload.
- Tests cover malformed terminal output and sanitized failure mapping.
Dependencies: Task 3.1 and Task 3.2.
### Story 4: Persist validated step-result checkpoints atomically with lifecycle transitions

#### Task 4.1: Extend lifecycle inputs for checkpoint results

Description: Update `packages/core/src/run-lifecycle.ts` and `packages/core/src/domain-repositories.ts` so `applyRunDirective` and `recordRunStepTransition` can carry an optional validated `checkpointResult` plus the source `RunStep` occurrence id selected before transition persistence.
Acceptance criteria:
- `ApplyRunDirectiveInput` includes optional `checkpointResult`.
- `RecordRunStepTransitionInput` includes optional `checkpointResult`.
- `ApplyRunDirectiveInput` and `RecordRunStepTransitionInput` include `sourceRunStepId` for the current source occurrence when available; checkpoint writes target that row and fail rather than guessing on no match or ambiguous legacy fallback.
- Only the lifecycle transition seam can write checkpoints; step creation inputs remain checkpoint-free.
- Lifecycle tests cover directives with and without checkpoint results.
Dependencies: Task 1.3.
#### Task 4.2: Pass advance results from orchestration into lifecycle persistence

Description: Update `packages/core/src/orchestrator.ts` so advance directives pass `workResult.result` as the checkpoint candidate when applying run lifecycle transitions.
Acceptance criteria:
- Checkpoint extraction happens only for `directive: 'advance'`.
- `DefaultOrchestrator.#publishEvent` or equivalent event publishing is async and awaited so ordering and logging are deterministic.
- State-transition events are appended through the expanded `RunEventStore`.
- State-transition append failures that occur after `createRun`, `createConversationWithFirstRun`, or `applyDirective` have durably committed lifecycle state are handled as post-commit publication failures: they are caught, logged with safe metadata, and do not make the API response claim the transition failed.
- Tests cover checkpoint propagation, awaited post-commit append attempts, and the distinction between pre-terminal append failures and post-commit state-transition append failures.
Dependencies: Task 2.3 and Task 4.1.
#### Task 4.3: Add persistence storage and migration for `checkpoint_result_json`

Description: Update persistence schema, migration files, and row mappers so `run_steps` can store nullable validated checkpoint JSON.
Acceptance criteria:
- `packages/persistence/src/schema.ts` defines the nullable checkpoint result column.
- `packages/persistence/drizzle/0005_run_step_checkpoint_result.sql` adds the column without breaking existing rows.
- Persistence mappers serialize and parse `checkpointResult` as `JsonValue | null`.
- Invalid non-JSON values are rejected before persistence.
- Migration and mapper tests cover historical rows, checkpoint rows, and invalid checkpoint values.
Dependencies: Task 1.3.
#### Task 4.4: Write checkpoints atomically with run-step transitions

Description: Update `packages/persistence/src/domain-repositories.ts` so `recordRunStepTransition` updates the source step checkpoint while completing the transition in one transaction.
Acceptance criteria:
- The source `RunStep` occurrence receives the validated checkpoint result when supplied.
- The source occurrence is selected by `sourceRunStepId` scoped to the same run and current step; legacy fallback may use the latest open current-step occurrence only when it is unique.
- Destination step creation does not accept or write checkpoint results.
- Source step update and destination step creation commit or roll back together.
- `GET /v1/runs/:id/steps` returns `checkpointResult` through the shared API contract.
- Tests cover successful writes, rollback on failure, and read serialization.
Dependencies: Task 4.1 and Task 4.3.
### Story 5: Stream retained typed events over SSE with reconnect support

#### Task 5.1: Update control-plane service event subscription wiring

Description: Update `packages/core/src/control-plane-service.ts` so run event subscription requests use the retained event store, tenant scope, and `Last-Event-ID` input.
Acceptance criteria:
- Existing auth and tenant checks remain in force.
- Service methods pass run id, tenant, and optional `lastEventId` to the expanded event stream path; the route uses `lastEventId` only when it calls `replayAfter`, not when it creates the live subscription.
- Tenant remains server-side authorization context and is not accepted from SDK subscription input.
- Tests cover authorized subscription, unauthorized access, and tenant isolation.
Dependencies: Task 2.1.
#### Task 5.2: Format expanded SSE frames in routes

Description: Update `packages/core/src/routes.ts` so `GET /v1/runs/:id/events` streams `ClientRunEvent` frames instead of state-transition-only payloads.
Acceptance criteria:
- Successful streams flush the existing initial connection comment; invalid reconnect cursors return HTTP 409 before the comment or any SSE frame.
- Each frame includes stable `id`, `event`, and JSON `data` fields.
- Frame names come from `formatRunEventFrameName`.
- The route validates or receives validated `ClientRunEvent` values before serialization.
- Tests cover frame names, ids, data payloads, and malformed stream values.
Dependencies: Task 1.1, Task 2.1, and Task 5.1.
#### Task 5.3: Implement subscribe-before-replay reconnect behavior

Description: Update the SSE route to create the live subscription before calling `replayAfter`, then write retained frames before draining buffered live events.
Acceptance criteria:
- `Last-Event-ID` replay starts after the supplied id.
- Events appended between subscribe and replay drain are buffered and delivered once.
- Unknown ids return HTTP `409 Conflict` with `error.code: "run_event_replay_cursor_unknown"` before any SSE frame; ids covered by expired-id metadata return HTTP `409 Conflict` with `error.code: "run_event_replay_cursor_expired"` before any SSE frame. In both cases the route closes the pre-created subscription and does not continue live streaming.
- The expired-cursor 409 response is documented as the client signal to recover from durable state via `GET /v1/runs/:id` and `GET /v1/runs/:id/steps`.
- Absent `Last-Event-ID` results in live-only replay from `{ status: 'ok', events: [] }`.
- Tests cover replay-before-live ordering, no gap between replay and live events, unknown id, expired id, and absent id.
Dependencies: Task 2.2 and Task 5.2.
#### Task 5.4: Widen SDK stream typing without changing the public call signature

Description: Update `packages/sdk/src/client.ts` so `subscribeRunEvents(id, options?)` continues to use the existing positional signature while parsing events as `ClientRunEvent`.
Acceptance criteria:
- The SDK method signature remains `subscribeRunEvents(id: string, options?: RunEventsStreamOptions)`.
- `RunEventsResponse` defaults to `ClientRunEvent`.
- The SDK continues to send `options.lastEventId` as `Last-Event-ID`.
- Unknown or expired reconnect cursors surface through the existing HTTP error path with the route's `run_event_replay_cursor_unknown` or `run_event_replay_cursor_expired` code; the SDK does not wait for an SSE error event.
- SDK docs or error handling guidance identify `run_event_replay_cursor_expired` as the signal to reload durable run and step state with `GET /v1/runs/:id` and `GET /v1/runs/:id/steps`.
- SDK tests cover widened event typing, reconnect headers, HTTP 409 reconnect cursor errors, and parse errors for invalid `ClientRunEvent` frames.
Dependencies: Task 1.1 and Task 5.2.
### Story 6: Add structured progress tool seams and stub-runner degradation coverage

#### Task 6.1: Define provider-neutral progress tool schemas

Description: Add `packages/execution/src/runner-progress-tools.ts` with schemas and types for `update_plan`, `report_progress`, and `notify`.
Acceptance criteria:
- `runnerProgressToolNameSchema`, `UpdatePlanToolInput`, `ReportProgressToolInput`, `NotifyToolInput`, and related schemas match the provider-neutral progress tool shapes described in this spec.
- Payload fields that are optional in the spec remain optional in the schemas.
- The module keeps provider-neutral tool shapes separate from the core runner interface.
- `packages/execution/src/index.ts` re-exports the progress tool schemas and types.
- Tests cover valid payloads, partial payloads, and malformed payloads used by degradation tests.
Dependencies: Task 1.1.
#### Task 6.2: Add scripted progress support to the stub runner

Description: Update `packages/execution/src/stub-runner.ts` so scripted runs can emit valid progress events, omit optional progress signals, or degrade malformed progress payloads without failing the run.
Acceptance criteria:
- `StubRunnerScript`, `StubRunnerProgressSignal`, and `StubRunnerMalformedProgressPayload` match the scripted progress behavior described in this spec.
- `update_plan` maps to plan-style `runner_progress`.
- `report_progress` maps to task-progress or intent-style `runner_progress`.
- `notify` maps to `runner_notification` with severity and importance when available.
- Missing optional progress signals do not fail the run.
- Malformed optional progress payloads degrade as `omit`, `coarse_progress`, or `notification_without_importance` when scripted.
- Stub-runner tests cover valid, missing, and malformed progress scenarios.
Dependencies: Task 6.1 and Task 3.1.
#### Task 6.3: Keep unsupported provider behavior behind adapter seams

Description: Ensure progress tool support is available through the stub/tool seam only for this feature and does not imply direct provider support.
Acceptance criteria:
- No real Claude, OpenAI, direct provider, model-routing, request-alteration, or skill-materialization adapter is required.
- Provider-specific limitations are documented in code comments or package docs where the progress seam is exposed.
- Tests rely on the stub runner and do not require external provider credentials.
Dependencies: Task 6.1 and Task 6.2.
### Story 7: Prove the end-to-end behavior and guard regressions

#### Task 7.1: Add core unit coverage for event storage and consumption

Description: Add focused tests around the retained event store, runner event consumer, execution unit of work, orchestrator, lifecycle, and routes.
Acceptance criteria:
- `packages/core/src/run-events.spec.ts` covers retention, replay, scoping, ordering, and subscriber behavior.
- `packages/core/src/runner-event-consumer.spec.ts` covers drain order, terminal mapping, append failure, progress degradation, and protocol errors.
- `packages/core/src/execution-run-unit-of-work.spec.ts` covers delegated consumer behavior and validated result propagation.
- `packages/core/src/orchestrator.spec.ts` and `packages/core/src/run-lifecycle.spec.ts` cover checkpoint propagation and lifecycle persistence inputs.
- `packages/core/src/routes.spec.ts` covers SSE frame formatting and reconnect edge cases.
Dependencies: Story 2, Story 3, Story 4, and Story 5.
#### Task 7.2: Add API contract, persistence, and SDK coverage

Description: Add targeted tests in packages that own the public contracts, durable storage, and SDK client parsing.
Acceptance criteria:
- `packages/api-contract/src/run-events.spec.ts` covers the expanded client-visible event union.
- `packages/api-contract/src/run-step.spec.ts` covers nullable checkpoint result validation and create-input rejection.
- `packages/persistence/src/__tests__/run-lifecycle-persistence.spec.ts` covers atomic checkpoint writes.
- Migration coverage verifies the new nullable column.
- `packages/sdk/src/client.spec.ts` covers expanded `subscribeRunEvents` typing and reconnect headers.
Dependencies: Story 1, Task 4.3, Task 4.4, and Task 5.4.
#### Task 7.3: Add control-plane integration coverage

Description: Add or update integration tests in the control-plane app to prove the complete run path with the stub runner and the `apps/control-plane/src/server.ts` retained-store wiring.
Acceptance criteria:
- A dispatched stub-runner run persists typed events to the retained live/reconnect store.
- A subscribed client observes runner events live over SSE.
- A reconnecting client sends `Last-Event-ID` and receives only events after that id.
- An expired reconnect cursor returns HTTP 409 with `run_event_replay_cursor_expired`, and the test documents that client recovery is durable `GET /v1/runs/:id` / `GET /v1/runs/:id/steps` reads.
- The validated terminal result is handed to orchestration and persisted as `RunStep.checkpointResult`.
- Missing or malformed optional progress signals produce a less-structured stream without failing the run.
- Integration tests do not use real provider credentials.
Dependencies: Story 2, Story 3, Story 4, Story 5, and Story 6.
#### Task 7.4: Run targeted and full validation

Description: Execute the relevant package tests first, then the broader repository validation required for handoff.
Acceptance criteria:
- Run targeted tests for `api-contract`, `core`, `persistence`, `execution`, `sdk`, and `control-plane` using the commands in the tech spec or their current package equivalents.
- Run `pnpm test:boundaries`.
- Run `pnpm validate`.
- Document any skipped command with the reason and the residual risk.
Dependencies: Task 7.1, Task 7.2, and Task 7.3.