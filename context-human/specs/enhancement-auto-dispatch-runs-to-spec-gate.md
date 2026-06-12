---
created: 2026-06-12
last_updated: 2026-06-12
status: implementing
issue: 45
specced_by: markdstafford
---
# Enhancement: Auto-dispatch runs to the spec gate

## Product requirements

### What

Autocatalyst should automatically dispatch a run when `POST /v1/conversations` creates it, then keep dispatching the same run after each successful `system` or `ai` step transition until the run reaches a step whose `waitingOn` value is `human`, `none`, or otherwise not dispatchable.
For a feature run, the first production path should be:
1. `POST /v1/conversations` creates the conversation, main topic, optional inbound message, run, and initial `intake` run step.
2. The create request returns without waiting for the whole run to execute.
3. The orchestrator dispatches `intake` asynchronously.
4. The run transitions to `spec.author`.
5. The orchestrator dispatches `spec.author` asynchronously.
6. The runner emits live runner events over the run SSE stream.
7. The run transitions to `spec.human_review`.
8. The orchestrator stops because `spec.human_review` waits on a human.
The run should then report `waitingOn: "human"` through existing run read/list surfaces and should have live `runner_*` and `run_state_transition` SSE events visible to subscribers.
### Why

`POST /v1/conversations` currently creates a run at `intake` and returns it, but a production caller does not have a production action that advances it. Tests can drive progress by calling `tick`, but a user-created run should not depend on a test-only hook or a separate manual dispatch call before work starts.
The product model says ingestion is push-primary. Creating or advancing work should schedule the next eligible unit immediately, while `tick` remains only a fallback for sources that cannot push or for explicit test/recovery seams. Auto-dispatch makes the first user-visible run lifecycle real: submit work, receive a run handle, watch progress over SSE, and review at the first human gate.
### Goals

- Schedule dispatch automatically after successful first-run creation.
- Schedule dispatch again after any transition whose resulting step has `waitingOn` of `system` or `ai`.
- Do not auto-dispatch human gates, terminal steps, or unknown/non-dispatchable steps.
- Keep auto-dispatch fire-and-return so `POST /v1/conversations` does not await runner execution.
- Surface asynchronous dispatch failures through persisted run state and SSE events, not as a failed create response after the create already committed.
- Preserve the orchestrator as the single run-mutation authority; route handlers and the service facade should not bypass it.
- Keep `tick` as an explicit fallback seam, but remove dependence on `tick` from the normal create-and-progress path.
- Prove the behavior with end-to-end coverage that uses the real network create path and the real SSE stream.
- Update `context-agent/wiki/code-map.md` during implementation for the new auto-dispatch wiring.
### Non-goals

- Implementing the in-step adversarial convergence loop.
- Classifying human replies at gates into `advance`, `revise`, or other directives.
- Building the full human-in-the-loop resume path.
- Changing the real `spec.author` prompt, result schema, skill set, or credential-injection behavior.
- Adding a polling scheduler, background pump, restart recovery loop, or multi-host lease system.
- Exposing a public network route that directly dispatches or ticks a run.
- Changing workflow definitions or adding new workflow steps.
### Personas

- **Phoebe (PM)** needs a created run to visibly start work without a second hidden action.
- **Enzo (Engineer)** needs production and test paths to share the same orchestrator-owned dispatch behavior.
- **Opal (Operator)** needs failed asynchronous work to be visible in run state and SSE without making creation requests hang.
- **A future client author** needs the existing SSE stream to show both runner activity and step transitions as the run progresses.
### User stories

- As Phoebe, I can create a feature conversation and see the run advance on its own until it pauses for review.
- As Enzo, I can write an end-to-end test that posts a conversation and observes production auto-dispatch over SSE without calling `tick`.
- As Opal, I can tell whether asynchronous dispatch failed by reading the run and watching run events.
- As a client author, I can keep one run-events subscription open and receive runner events and `run_state_transition` events in the order the orchestrator publishes them.
### Acceptance criteria

- Creating a run through `POST /v1/conversations` schedules dispatch for the new run without a separate caller.
- Creating a run through the in-process control-plane service schedules the same auto-dispatch path.
- After a transition lands on a step whose `waitingOn` is `ai` or `system`, the orchestrator schedules dispatch for that run again.
- After a transition lands on a step whose `waitingOn` is `human`, the orchestrator does not dispatch, and reads report `waitingOn: "human"`.
- After a transition lands on a terminal step whose `waitingOn` is `none`, the orchestrator does not dispatch.
- Auto-dispatch is fire-and-return. The create response returns after durable creation and start-event publication, not after runner execution.
- A dispatch failure that happens after the create response is not returned as the create response error. It is recorded through the normal run failure path when possible and emitted through run events.
- The existing `dispatch` guard for human steps remains in place.
- The production create path no longer depends on a captured test hook or direct `controlPlane.tick()` call to make a new run advance.
- `tick` remains available as a fallback and uses the same dispatch machinery as auto-dispatch.
- An end-to-end network test creates a feature conversation, subscribes to `GET /v1/runs/:id/events`, and observes the run move to `spec.author`, emit runner events for `spec.author`, transition to `spec.human_review`, and pause with `waitingOn: "human"` without calling `tick` or injecting a dispatch from the test.
- `context-agent/wiki/code-map.md` is updated for the auto-dispatch wiring during implementation.
## Design spec

### Design scope

This enhancement is backend-only. It changes the run lifecycle experience exposed through the existing service, API, SDK, and SSE surfaces. It does not add visual screens or client-side components.
The design focus is the caller experience and operational behavior: create returns quickly, live events show progress, and the run stops cleanly at the first human gate.
### Service experience

The normal feature-run experience should feel like one action from the caller:
1. The caller posts a conversation with `submission.workKind: "feature"`.
2. The response returns created resource handles, including the run id.
3. A client subscribes to the run event stream or already has a subscription open from a reconnect.
4. The stream shows the run advancing out of `intake`.
5. The stream shows runner events for `spec.author`.
6. The stream shows a `run_state_transition` into `spec.human_review`.
7. A read of the run reports `waitingOn: "human"`.
The create response should not promise that these steps completed before the HTTP response. It only promises that the run was created and accepted for asynchronous dispatch. Clients use the run id and SSE/read surfaces for progress.
### Auto-dispatch policy

Auto-dispatch should be driven by the destination step after a durable transition, not by hand-coded workflow names. The orchestrator already has the step catalog and can inspect `waitingOn` for `run.currentStep`.
Dispatch policy:
- `waitingOn: "system"` -\> schedule dispatch.
- `waitingOn: "ai"` -\> schedule dispatch.
- `waitingOn: "human"` -\> do not schedule dispatch.
- `waitingOn: "none"` -\> do not schedule dispatch.
- Unknown step -\> log a safe warning and do not schedule dispatch, or fail synchronously if the step should be impossible at that boundary.
This keeps behavior aligned with the catalog. If future workflows add a new `system` or `ai` step, the run can continue without adding a special case.
### Fire-and-return behavior

Auto-dispatch should schedule work and detach from the caller. A successful create request should not wait for `intake`, `spec.author`, or later runner work.
If a dispatch fails asynchronously, the failure should follow the normal orchestrator path:
- runner terminal `fail` -\> apply `fail` directive and publish a state transition;
- runner/protocol/materialization failure before terminal -\> map to a sanitized `fail` result where the existing unit-of-work path supports it;
- scheduling/admission failure -\> log with sanitized details and, where possible, transition the run to `failed`.
The create or transition response should return successfully once the durable state change and its event publication succeed. Auto-dispatch scheduling runs after that commit point and must not convert an already committed run or transition into a create/applyDirective API error. If scheduling initiation itself throws or rejects after the commit point, handle it through the detached asynchronous failure path: catch it, log sanitized diagnostics, and fail the run when safe. Callers that retry a successful create response are still subject to normal active-run conflict behavior because the run already exists.
### Event experience

The existing run event stream remains the client-facing progress surface. Auto-dispatch should use the same event store as manual dispatch:
- `run_state_transition` events come from orchestrator-owned lifecycle changes.
- `runner_*` events come from `consumeRunnerEvents` through the configured execution unit of work.
- Events are scoped by run id and tenant.
- Subscribers should receive events live and may use existing replay behavior for retained events.
Because the run id is not known until the create response returns, a fast runner may legitimately emit early events before a test can subscribe to `GET /v1/runs/:id/events`. Network end-to-end tests should use a production-safe controlled test runner delay or barrier inside the test unit of work, not a tick/dispatch hook, so the create response can return, the test can open the run event stream, and then the delayed runner work can proceed. The test may use existing replay for events that are inherently before subscription, but the core proof should release the runner only after the SSE subscription is open and then observe at least one runner event and the later `spec.human_review` transition live.
### Human gate pause

The stop condition is a normal step-catalog decision. When the run reaches `spec.human_review`, `getRun` and `listRuns` should return `waitingOn: "human"` because the service maps `currentStep` through `getRunStepDefinition`.
Auto-dispatch should not call `dispatch` for a human step. The existing `dispatch` guard remains a second layer of protection so direct calls cannot run a human gate.
## Tech spec

### Current state

The relevant code already exists in these places:
- `packages/core/src/orchestrator.ts` owns `DefaultOrchestrator.createConversationWithFirstRun`, `applyDirective`, `dispatch`, and `tick`.
- `packages/core/src/control-plane-service.ts` exposes `DefaultControlPlaneService.createConversationWithFirstRun` and `tick`.
- `packages/core/src/run-step-catalog.ts` defines `waitingOn` for each step.
- `packages/core/src/run-workflows.ts` defines the feature workflow: `intake -> spec.author -> spec.human_review -> ...`.
- `packages/core/src/run-dispatch-queue.ts` provides bounded dispatch.
- `packages/core/src/execution-run-unit-of-work.ts` consumes runner execution and maps terminal results to run work results.
- `packages/core/src/runner-event-consumer.ts` appends runner events to the run event store.
- `packages/core/src/run-events.ts` stores and streams `ClientRunEvent` values.
- `apps/control-plane/src/server.ts` wires the real service, event store, dispatch queue, orchestrator, and execution unit of work.
- `apps/control-plane/src/integration.spec.ts` and `apps/control-plane/src/control-plane-service.integration.spec.ts` currently use captured `tick` calls in end-to-end proofs.
The missing behavior is not a new route. The missing behavior is automatic scheduling from inside the orchestrator-owned mutation path.
### Architecture

Add an internal auto-dispatch helper to `DefaultOrchestrator`. The helper should be the only component that decides whether a newly created or newly transitioned run should be dispatched again.
Suggested shape:
```typescript
interface AutoDispatchOptions {
  readonly enabled?: boolean;
}

class DefaultOrchestrator {
  #scheduleAutoDispatch(run: Run): void;
  #shouldAutoDispatch(run: Run): boolean;
}
```
The exact option names can follow local conventions. The default should enable auto-dispatch for production paths. Tests that need exact synchronous control may disable it with an explicit constructor option, but new end-to-end tests for issue 45 should use the enabled default.
`#shouldAutoDispatch(run)` should:
1. read `getRunStepDefinition(run.currentStep)`;
2. return true only for `waitingOn === "system"` or `waitingOn === "ai"`;
3. return false for `human`, `none`, or an unknown definition.
`#scheduleAutoDispatch(run)` should:
1. call `#shouldAutoDispatch(run)`;
2. if false, return without side effects;
3. if true, start `this.dispatch({ runId: run.id, tenant: run.tenant })` in a detached promise;
4. catch and handle any rejection without producing an unhandled promise rejection.
### Orchestrator wiring

Call the auto-dispatch helper after the durable state change and after event publication:
- In `createRun`, after publishing the `start` transition event.
- In `createConversationWithFirstRun`, after publishing the `start` transition event.
- In `applyDirective`, after publishing the transition event.
Publishing the state transition before scheduling the next dispatch keeps event ordering understandable: clients see the transition into a step before runner events for work done in that step.
Do not schedule from inside `dispatch` before `applyDirective` returns. The loop should be transition-driven so all entry points that apply directives share the same rule.
### Failure handling

Detached auto-dispatch must never create an unhandled rejection. The catch handler should log sanitized diagnostics and then try to fail the run only when that is safe.
Recommended handling:
- If `dispatch` reaches the unit of work and the unit returns `fail`, existing dispatch logic applies the `fail` directive.
- If `dispatch` rejects before it can apply a directive for a non-terminal, non-human step, the auto-dispatch catch handler may call `applyDirective({ directive: "fail" })`, unless the error means the run is already terminal, missing, forbidden, or invalid because it reached a human step in the meantime.
- If a race means the run has already moved to a human or terminal step, log at debug/warn level and do not overwrite the newer state.
- Never include raw provider messages, secret values, workspace paths outside existing safe diagnostics, or credential material in logs or persisted failure reasons.
The implementation should avoid recursive failure loops. Applying a `fail` directive moves the run to `failed`, whose `waitingOn` is `none`, so the transition-driven auto-dispatch helper will not schedule again.
### Concurrency and duplicate scheduling

The existing `RunDispatchQueue` bounds concurrent work, but it does not deduplicate multiple queued dispatches for the same run. The orchestrator must make auto-dispatch scheduling idempotent within a process so closely spaced create/transition/tick/fallback paths do not enqueue duplicate automatic work for the same run.
Add a small orchestrator-owned in-memory set of auto-dispatch run ids. The set should:
- add the run id before starting detached dispatch;
- remove it in `finally`;
- skip scheduling if the same run id is already pending or active through auto-dispatch.
This set is an in-process guard only. It does not block explicit operator/test calls to `dispatch` or `tick`; those paths still re-read run state and use the existing human/terminal guards. Durable correctness remains the run lifecycle state and transition rules, so duplicate unit-of-work execution must remain harmless to lifecycle state even if it comes from a different process or explicit fallback call.
### Service, API, and SDK impact

No new public route is required.
Existing behavior changes:
- `POST /v1/conversations` still returns the same resource shape, but the created run is scheduled immediately after creation.
- `GET /v1/runs/:id` and `GET /v1/runs` continue to derive `waitingOn` from the run step catalog.
- `GET /v1/runs/:id/events` becomes the proof surface for automatic progress because it receives both runner events and state transitions.
- `ControlPlaneService.tick` stays available and still dispatches through the orchestrator, but normal tests should stop using it to move a just-created run.
The SDK should not need a new method. Existing `createConversationWithFirstRun`, `getRun`, `listRunSteps`, and `subscribeRunEvents` calls should observe the new behavior.
### Test plan

Add or update targeted core tests:
- `DefaultOrchestrator.createConversationWithFirstRun` schedules auto-dispatch after the start event when the initial step is `intake`.
- `DefaultOrchestrator.applyDirective` schedules auto-dispatch after a transition to `spec.author`.
- `DefaultOrchestrator.applyDirective` does not schedule auto-dispatch after a transition to `spec.human_review`.
- `DefaultOrchestrator.applyDirective` does not schedule auto-dispatch after a transition to `done`, `failed`, or `canceled`.
- A rejected detached dispatch is caught and does not produce an unhandled rejection.
- A dispatch failure for an eligible step records a failed run when the run can still be failed safely.
Add or update service/control-plane integration tests:
- The service-level create path advances a feature run without calling `controlPlane.tick`.
- The network `POST /v1/conversations` path advances a feature run without a captured tick hook.
- An SSE test subscribes to the run events stream and observes:
	- a `run_state_transition` into `spec.author`;
	- one or more `runner_*` events for `spec.author`;
	- a `run_state_transition` into `spec.human_review`;
	- a final read whose run has `currentStep: "spec.human_review"` and `waitingOn: "human"`.
Existing tests that intentionally assert tick fallback behavior should remain, but they should be renamed or scoped so they no longer describe the normal production path.
### Validation

Recommended targeted validation after implementation:
```bash
pnpm nx test core -- orchestrator.spec.ts
pnpm nx test control-plane -- control-plane-service.integration.spec.ts
pnpm nx test control-plane -- integration.spec.ts
pnpm nx test core
pnpm nx test control-plane
pnpm test:boundaries
```
Run `pnpm validate` when practical after the targeted suite passes.
### Risks and mitigations

- **Create response races event observation.** Because dispatch is fire-and-return, a fast local runner may finish before a client subscribes. Network tests should use a controlled test runner delay/barrier so subscription opens before the delayed runner emits live events, while still using retained replay for any events that occur before the run id is known.
- **Unhandled detached promise failures.** The auto-dispatch helper must catch every rejection and route it to sanitized logging and run failure handling.
- **Duplicate dispatch for the same run.** Transition-driven scheduling minimizes duplicates, and the required in-memory auto-dispatch in-flight guard skips duplicate automatic schedules for the same run within a process. Cross-process or explicit duplicate attempts still rely on lifecycle guards and idempotent transition handling.
- **Async failure overwrites newer state.** Before applying a failure from a detached catch, re-read or rely on `applyDirective` terminal/human guards so a newer human or terminal state is not overwritten.
- **Provider behavior varies.** Real provider adapters may emit different non-terminal runner event mixes. Tests should assert at least one valid runner event, not provider-specific wording.
## Converged API

### Files

Path
Purpose
Exports

`packages/core/src/orchestrator.ts`
Owns the auto-dispatch policy and wiring after durable run creation or transition. Adds an optional constructor configuration for tests that need to disable auto-dispatch; production defaults remain enabled. Private helpers decide dispatchability from the run-step catalog, skip duplicate automatic schedules with an orchestrator-owned in-memory in-flight run-id set, and launch detached dispatch promises with rejection handling.
`AutoDispatchOptions`, `DefaultOrchestratorOptions`, `DefaultOrchestrator`, `Orchestrator`

`packages/core/src/orchestrator.spec.ts`
Adds targeted coverage for auto-dispatch after start transitions, after transitions to system/ai steps, non-dispatch for human/none steps, explicit non-dispatch after transitions to done, failed, and canceled, caught detached dispatch failures without unhandled rejections, and the run-state assertion that a dispatch failure for an eligible step records a failed run when the run can still be failed safely.

`packages/core/src/control-plane-service.ts`
No new service method; existing create/read/list/event methods observe the orchestrator-owned auto-dispatch behavior and continue to derive waitingOn from the run-step catalog. Committed create/transition results are not converted into service errors if post-commit auto-dispatch scheduling or execution later fails; those failures surface through run state/events when safe.
`ControlPlaneService`, `DefaultControlPlaneService`

`apps/control-plane/src/control-plane-service.integration.spec.ts`
Updates service-level integration coverage so createConversationWithFirstRun advances a feature run through the production auto-dispatch path without calling tick. Existing tests that intentionally assert tick fallback behavior remain, but are renamed or scoped so they describe fallback/recovery behavior rather than the normal production create-and-progress path.

`apps/control-plane/src/integration.spec.ts`
Adds or updates network end-to-end coverage for POST /v1/conversations plus GET /v1/runs/:id/events without test-injected dispatch or tick. The SSE/read assertions explicitly cover: a run_state_transition into [spec.author](http://spec.author); one or more runner_\* events for [spec.author](http://spec.author); a run_state_transition into spec.human_review; and a final getRun read asserting currentStep: 'spec.human_review' and waitingOn: 'human'. Existing tests that intentionally assert tick fallback behavior remain, but are renamed or scoped so they describe fallback/recovery behavior rather than the normal production path.

`context-agent/wiki/code-map.md`
Documents the new orchestrator auto-dispatch wiring, the duplicate auto-dispatch in-flight guard, and clarifies that normal create-and-progress paths no longer depend on tick while tick remains a fallback seam.

### Public API

#### `AutoDispatchOptions`

```typescript
export interface AutoDispatchOptions { readonly enabled?: boolean; }
```
- Parameters:
	- `enabled: boolean | undefined` — When false, DefaultOrchestrator suppresses detached auto-dispatch scheduling. Undefined defaults to enabled so production create and transition paths schedule eligible work. Intended primarily for tests that require exact synchronous control. This option does not disable explicit dispatch or tick fallback behavior.
- Returns: `AutoDispatchOptions`
#### `DefaultOrchestratorOptions`

```typescript
export interface DefaultOrchestratorOptions { readonly runs: RunRepository; readonly conversationIngress: ConversationIngressRepository; readonly events: RunEventStore; readonly dispatchQueue: RunDispatchQueue; readonly unitOfWork?: RunUnitOfWork; readonly autoDispatch?: AutoDispatchOptions; /* existing options unchanged */ }
```
- Parameters:
	- `autoDispatch: AutoDispatchOptions | undefined` — Optional auto-dispatch configuration. If omitted or enabled, run creation and successful eligible step transitions schedule dispatch asynchronously after state-transition event publication.
- Returns: `DefaultOrchestratorOptions`
#### `DefaultOrchestrator.constructor`

```typescript
export class DefaultOrchestrator implements Orchestrator { constructor(options: DefaultOrchestratorOptions); }
```
- Parameters:
	- `options: DefaultOrchestratorOptions` — Repository, event store, dispatch queue, unit-of-work, and optional auto-dispatch configuration. Auto-dispatch is enabled unless options.autoDispatch.enabled is false.
- Returns: `DefaultOrchestrator`
#### `DefaultOrchestrator.createRun`

```typescript
createRun(input: CreateOrchestratedRunInput): Promise
```
- Parameters:
	- `input: CreateOrchestratedRunInput` — Existing run creation input. After durable run lifecycle start and start-event publication, the orchestrator schedules detached dispatch when the initial step waitingOn is system or ai.
- Returns: `Promise`
- Errors:
	- `OrchestratorError with code active_run_conflict when the topic already has an active run.`
	- `OrchestratorError with code unknown_work_kind when input.workKind has no workflow.`
	- `OrchestratorError with code persistence_failed when durable run creation or start-event persistence fails before the create result is committed.`
	- `Post-commit auto-dispatch scheduling or execution failures are not returned from this promise; they are caught, logged with sanitized details, and routed through run failure/events when safe.`
#### `DefaultOrchestrator.createConversationWithFirstRun`

```typescript
createConversationWithFirstRun(input: CreateOrchestratedConversationInput): Promise
```
- Parameters:
	- `input: CreateOrchestratedConversationInput` — Existing atomic conversation/topic/message/run creation input. After durable creation and start-event publication, schedules detached dispatch for the first step when its waitingOn value is system or ai. The promise resolves without waiting for runner execution.
- Returns: `Promise`
- Errors:
	- `OrchestratorError with code unknown_work_kind when input.workKind has no workflow.`
	- `OrchestratorError with code persistence_failed when the workflow has no first step, the first step is unknown, durable conversation/topic/message/run creation fails, or start-event persistence fails.`
	- `OrchestratorError with code active_run_conflict when creation violates the active-run uniqueness rule.`
	- `Post-commit auto-dispatch scheduling or execution failures after the create result is committed are not returned from this promise; they are surfaced through logs, run state, and run events when safe.`
#### `DefaultOrchestrator.applyDirective`

```typescript
applyDirective(input: ApplyOrchestratedDirectiveInput): Promise
```
- Parameters:
	- `input: ApplyOrchestratedDirectiveInput` — Existing transition directive input. After a successful durable transition and run_state_transition event publication, schedules detached dispatch only if the destination step waitingOn is system or ai. Human, none, terminal, and unknown steps are not auto-dispatched; done, failed, and canceled are terminal non-dispatch targets.
- Returns: `Promise`
- Errors:
	- `OrchestratorError with code missing_run when input.runId does not exist.`
	- `OrchestratorError with code forbidden when the run tenant does not match input.tenant.`
	- `OrchestratorError with code terminal_run when the run is already terminal.`
	- `OrchestratorError with code invalid_transition when the workflow rejects the directive or the spec review gate is blocked.`
	- `OrchestratorError with code persistence_failed when transition persistence or required approval/spec finalization work fails.`
	- `Post-commit auto-dispatch scheduling or execution failures after this method resolves are caught and surfaced through logs, run state, and run events when safe.`
#### `ControlPlaneService.createConversationWithFirstRun`

```typescript
createConversationWithFirstRun(input: ServiceCreateConversationInput): Promise
```
- Parameters:
	- `input: ServiceCreateConversationInput` — Existing service facade input for POST /v1/conversations. It continues to delegate creation to the orchestrator and now returns after durable creation and start-event publication while orchestrator-owned auto-dispatch proceeds asynchronously.
- Returns: `Promise`
- Errors:
	- `ControlPlaneServiceError with code forbidden when policy denies conversation.create.`
	- `ControlPlaneServiceError with code intake_routing_error when the orchestrator reports unknown_work_kind or invalid_transition.`
	- `ControlPlaneServiceError with code active_run_conflict when an active run already exists for the topic.`
	- `ControlPlaneServiceError with code persistence_failed for durable persistence failures before the create result is committed.`
	- `Post-commit auto-dispatch scheduling or execution failures are not returned from this promise; they are surfaced through logs, run state, and run events when safe.`
#### `ControlPlaneClient.createConversationWithFirstRun`

```typescript
createConversationWithFirstRun(request: CreateConversationWithFirstRunRequest): Promise
```
- Parameters:
	- `request: CreateConversationWithFirstRunRequest` — Existing SDK request for POST /v1/conversations. Response shape is unchanged; callers should use returned [run.id](http://run.id) with getRun/listRuns/subscribeRunEvents to observe asynchronous progress.
- Returns: `Promise`
- Errors:
	- `ControlPlaneClientError when the HTTP response is a non-2xx API error.`
	- `Error when the response status is not the expected 201 after error handling.`
	- `ZodError when the request or response does not match the API contract.`
#### `GET /v1/runs/:id/events`

```typescript
GET /v1/runs/:id/events -> text/event-stream
```
- Parameters:
	- `id: string` — Run id whose retained and live run events should be streamed. Auto-dispatch uses the same event store, so clients observe runner_\* events and run_state_transition events for automatically advanced steps.
	- `Last-Event-ID: string | undefined` — Optional SSE replay cursor header. Existing replay behavior is unchanged.
- Returns: `text/event-stream`
- Errors:
	- `HTTP 401/403 when authentication or authorization fails.`
	- `HTTP 404 when the run does not exist for the tenant.`
	- `HTTP 409 with run_event_replay_cursor_unknown or run_event_replay_cursor_expired when replay cannot satisfy Last-Event-ID.`
### Types

#### `AutoDispatchOptions`

```typescript
interface AutoDispatchOptions { readonly enabled?: boolean; }
```
#### `DefaultOrchestratorOptions`

```typescript
interface DefaultOrchestratorOptions { readonly runs: RunRepository; readonly conversationIngress: ConversationIngressRepository; readonly events: RunEventStore; readonly dispatchQueue: RunDispatchQueue; readonly unitOfWork?: RunUnitOfWork; readonly autoDispatch?: AutoDispatchOptions; readonly clock?: () => string; readonly eventIdGenerator?: () => string; readonly isActiveRunConflict?: (error: unknown) => boolean; readonly logger?: { warn(message: string, details?: unknown): void }; }
```
#### `Auto-dispatch eligibility policy`

```typescript
type AutoDispatchEligibility = 'system' | 'ai';
```
#### `Auto-dispatch in-flight guard`

```typescript
private readonly autoDispatchInFlightRunIds: Set;
```
#### `CreateConversationWithFirstRunResponse`

```typescript
type CreateConversationWithFirstRunResponse = { conversation: Conversation; topic: Topic; message?: Message; run: Run; runStep: RunStep; };
```
#### `ClientRunEvent`

```typescript
type ClientRunEvent = RunStateTransitionEvent | RunnerEventReplayableClientEvent;
```
### Notes

No new public network route, API-contract request/response schema, SDK method, or committed-create dispatch-initiation error is proposed. The main public change is behavioral on existing creation, transition, read/list, and SSE surfaces: eligible runs are dispatched asynchronously after orchestrator-owned durable transitions, while human/terminal/unknown steps are not dispatched. Private helpers such as #shouldAutoDispatch(run), #scheduleAutoDispatch(run), and the in-memory duplicate-scheduling guard are intentionally omitted from public_api because they should remain internal to DefaultOrchestrator. Tick remains available as an explicit fallback seam; tests that keep tick coverage should be renamed or scoped so they no longer describe the normal production path. Provider event details may vary, so network tests should assert at least one valid runner_\* event for [spec.author](http://spec.author) rather than provider-specific event wording.
## Task list

### Story 1: Orchestrator owns auto-dispatch policy and scheduling

Description: Add the orchestrator-owned auto-dispatch seam so run creation and successful run transitions schedule eligible next work without a route handler, service facade, SDK method, or test hook driving progress.
Acceptance criteria:
- `DefaultOrchestrator` exports the agreed `AutoDispatchOptions` and extends `DefaultOrchestratorOptions` with optional `autoDispatch`.
- Auto-dispatch is enabled by default and can be disabled only through the explicit constructor option.
- Eligibility is based on `getRunStepDefinition(run.currentStep).waitingOn`, with only `system` and `ai` dispatchable.
- `human`, `none`, terminal, and unknown steps are not auto-dispatched.
- Scheduling happens only after durable lifecycle mutation and after publishing the relevant state-transition event.
- The implementation preserves the existing public method shapes and does not add a public network dispatch/tick route.
Dependencies: None.
#### Task 1.1: Add auto-dispatch options

Description: Update `packages/core/src/orchestrator.ts` so the public type surface matches the Converged API before wiring behavior.
Acceptance criteria:
- `AutoDispatchOptions` is exported as `{ readonly enabled?: boolean }`.
- `DefaultOrchestratorOptions` accepts `autoDispatch?: AutoDispatchOptions`.
- The constructor stores an enabled-by-default flag without changing existing required dependencies.
- Existing tests that need synchronous control can construct the orchestrator with `autoDispatch: { enabled: false }`.
Dependencies: None.
#### Task 1.2: Implement dispatch eligibility helper

Description: Add a private `DefaultOrchestrator` helper that centralizes the step-catalog policy.
Acceptance criteria:
- The helper reads the destination run's `currentStep` through `getRunStepDefinition`.
- It returns true only when `waitingOn` is `system` or `ai`.
- It returns false for `human`, `none`, and unknown step definitions.
- Unknown step handling uses existing safe logging conventions if a logger is available and never throws from the scheduler path solely because a step is unknown.
- No workflow-name or step-name special cases are introduced for `intake` or `spec.author`.
Dependencies: Task 1.1.
#### Task 1.3: Implement detached auto-dispatch scheduling helper

Description: Add a private scheduler helper that launches eligible dispatches asynchronously and catches every detached rejection.
Acceptance criteria:
- The helper exits without side effects when auto-dispatch is disabled.
- The helper exits without side effects for non-eligible steps.
- Eligible runs start `dispatch({ runId: run.id, tenant: run.tenant })` without awaiting runner execution from the caller.
- The detached promise has a rejection handler so no unhandled promise rejection is produced.
- Any synchronous admission/start failure after the durable commit point is caught by the same detached failure handler and is not returned as a create/applyDirective API error.
- Duplicate automatic scheduling for a run already pending or active in this orchestrator process is skipped by the in-flight guard.
Dependencies: Task 1.2.
#### Task 1.4: Wire scheduling after create and transition events

Description: Call the scheduler from the orchestrator mutation points that create or advance run state.
Acceptance criteria:
- `createRun` schedules auto-dispatch after the durable start transition and start-event publication.
- `createConversationWithFirstRun` schedules auto-dispatch after the durable start transition and start-event publication.
- `applyDirective` schedules auto-dispatch after a successful durable transition and `run_state_transition` event publication.
- `dispatch` does not contain a separate loop that bypasses `applyDirective`.
- Event ordering remains transition-first, then runner events for the newly entered step.
Dependencies: Task 1.3.
### Story 2: Detached dispatch failures are safe and observable

Description: Ensure asynchronous auto-dispatch failures never crash the process, never leak sensitive provider details, and surface through existing run failure/event behavior when the run can still be failed safely.
Acceptance criteria:
- Detached dispatch failures are caught and logged with sanitized details.
- Existing dispatch/unit-of-work fail results continue to flow through `applyDirective({ directive: 'fail' })`.
- Pre-terminal failures that reject before applying a directive attempt to fail the run when it is still safe.
- Races with already-human, already-terminal, missing, or forbidden runs do not overwrite newer state.
- Applying a fail directive does not create a recursive auto-dispatch loop because failed runs are non-dispatchable.
Dependencies: Story 1.
#### Task 2.1: Add safe detached rejection handling

Description: Implement the catch path for auto-dispatch promises in `packages/core/src/orchestrator.ts`.
Acceptance criteria:
- The catch path logs only safe error codes/messages and run identifiers already acceptable in existing diagnostics.
- It never persists raw provider output, secret values, credential material, or unsafe workspace paths as failure reasons.
- It distinguishes expected lifecycle races from unexpected dispatch failures enough to avoid noisy failure overwrites.
- Unit tests can force a dispatch rejection and observe no unhandled rejection.
Dependencies: Task 1.3.
#### Task 2.2: Route eligible asynchronous dispatch failures to run failure when safe

Description: When detached dispatch rejects before applying a terminal directive, attempt to mark the run failed through the normal orchestrator mutation path if the run is still on an eligible non-terminal step.
Acceptance criteria:
- The failure path re-checks or otherwise respects current run state before applying `fail`.
- Human and terminal current states are left unchanged.
- Missing/forbidden/invalid-transition errors from the failure attempt are swallowed after safe logging.
- A successful failure attempt publishes the normal run transition event and persists the failed state.
Dependencies: Task 2.1.
#### Task 2.3: Add duplicate auto-dispatch in-flight guard

Description: Add the required in-memory run-id guard described in the Converged API so closely spaced entry points do not enqueue duplicate automatic dispatches for the same run in one orchestrator process.
Acceptance criteria:
- `DefaultOrchestrator` tracks auto-dispatch run ids before detached dispatch starts and removes them in `finally`.
- If a run id is already pending or active through auto-dispatch, a second auto-dispatch schedule attempt is skipped.
- The guard affects only auto-dispatch and does not block explicit `dispatch` or `tick` calls.
- Durable lifecycle guards still make duplicate explicit or cross-process dispatch attempts harmless to final run state.
Dependencies: Task 1.4.
### Story 3: Service/API behavior observes orchestrator auto-dispatch without new public routes

Description: Keep the service, route, and SDK surfaces stable while ensuring production construction uses auto-dispatch defaults and post-commit dispatch failures surface asynchronously.
Acceptance criteria:
- `POST /v1/conversations` response shape remains unchanged.
- `ControlPlaneService.createConversationWithFirstRun` delegates to the orchestrator and returns after durable creation/start-event publication, not runner execution.
- Post-commit auto-dispatch scheduling or execution failures are not returned as create/applyDirective/service/API errors.
- Durable persistence failures that happen before the commit point still map to `persistence_failed`.
- `GET /v1/runs/:id`, `GET /v1/runs`, and `GET /v1/runs/:id/events` require no new public contract.
- Server wiring in `apps/control-plane/src/server.ts` leaves auto-dispatch enabled by default.
Dependencies: Story 1.
#### Task 3.1: Preserve service facade error behavior

Description: Verify `packages/core/src/control-plane-service.ts` continues to expose committed create results as successes and does not add a post-commit dispatch-initiation error path.
Acceptance criteria:
- Existing durable persistence failures still map to `persistence_failed`.
- Post-commit auto-dispatch scheduling/execution failures are observed through run state/events when safe, not service create errors.
- Existing forbidden, intake routing, and active-run-conflict mappings remain unchanged.
Dependencies: Task 1.1.
#### Task 3.2: Preserve route and SDK contracts

Description: Verify the control-plane route and SDK behavior require no new method or response schema changes.
Acceptance criteria:
- No public route is added for direct dispatch or tick.
- `ControlPlaneClient.createConversationWithFirstRun` continues to use the existing request and response schemas.
- No API-contract update is required solely for post-commit auto-dispatch scheduling/execution failures.
- Existing non-2xx handling remains limited to pre-commit validation, authorization, routing, active-run-conflict, and persistence failures.
Dependencies: Task 3.1.
#### Task 3.3: Confirm production wiring uses enabled defaults

Description: Check construction in `apps/control-plane/src/server.ts` and related integration setup so production paths do not accidentally disable auto-dispatch.
Acceptance criteria:
- The real server-created `DefaultOrchestrator` omits `autoDispatch` or sets it enabled.
- Only targeted tests that need deterministic synchronous control pass `autoDispatch: { enabled: false }`.
- No route handler calls `tick` or direct dispatch to compensate for creation.
Dependencies: Task 1.4.
### Story 4: Core orchestrator tests prove policy, ordering, and failure safety

Description: Add targeted unit coverage around the new orchestrator behavior while preserving existing explicit dispatch/tick tests.
Acceptance criteria:
- Tests cover auto-dispatch after run start and after transitions to eligible steps.
- Tests cover non-dispatch after human, terminal, `none`, and unknown/non-dispatchable steps.
- Tests verify auto-dispatch scheduling is fire-and-return and ordered after state-transition publication.
- Tests verify detached dispatch rejections are caught.
- Existing tests that assume manual control either disable auto-dispatch explicitly or are updated to assert the new behavior.
Dependencies: Stories 1 and 2.
#### Task 4.1: Add create-path auto-dispatch tests

Description: Extend `packages/core/src/orchestrator.spec.ts` for `createRun` and `createConversationWithFirstRun` scheduling.
Acceptance criteria:
- `createConversationWithFirstRun` schedules dispatch for the initial `intake` step.
- `createRun` schedules dispatch for an eligible initial step.
- Tests assert the create promise resolves without awaiting unit-of-work completion.
- Tests assert the start transition event is published before the scheduled dispatch starts, using existing fake event/queue seams where practical.
Dependencies: Task 1.4.
#### Task 4.2: Add transition-path eligibility tests

Description: Extend `DefaultOrchestrator.applyDirective` coverage for every dispatchability class.
Acceptance criteria:
- Transition to `spec.author` schedules auto-dispatch.
- Transition to `spec.human_review` does not schedule auto-dispatch.
- Transitions to `done`, `failed`, and `canceled` do not schedule auto-dispatch.
- A transition to any step with `waitingOn: 'none'` does not schedule auto-dispatch.
- Unknown step handling is covered through a safe seam or by isolating the helper behavior without mutating production catalogs.
Dependencies: Task 1.4.
#### Task 4.3: Add detached failure tests

Description: Add tests that force auto-dispatch rejection and verify safe outcomes.
Acceptance criteria:
- A rejected detached dispatch does not trigger an unhandled rejection.
- An eligible run can be transitioned to `failed` through the normal failure path when safe.
- A run that has already reached a human gate or terminal state is not overwritten by the detached failure handler.
- Logs or observable diagnostics used in assertions contain sanitized details only.
Dependencies: Story 2.
#### Task 4.4: Preserve explicit dispatch and tick fallback tests

Description: Adjust existing orchestrator tests that rely on exact synchronous state to account for enabled-by-default auto-dispatch.
Acceptance criteria:
- Existing explicit `dispatch` tests still prove dispatch guard behavior, runner result handling, and failure mapping.
- Existing `tick` tests still prove fallback behavior and continue to use the same dispatch machinery.
- Tests that are not about auto-dispatch disable auto-dispatch explicitly when automatic scheduling would make them flaky.
- Test names distinguish normal auto-dispatch behavior from tick fallback/recovery behavior.
Dependencies: Task 1.1.
### Story 5: Service and network integration tests prove create-to-human-gate progress without tick

Description: Update integration coverage so the production service and HTTP/SSE paths prove a feature run advances from creation to `spec.human_review` without captured test hooks, direct dispatch, or `controlPlane.tick()`.
Acceptance criteria:
- Service-level integration creates a feature conversation and observes progress without calling `controlPlane.tick`.
- Network-level integration posts to `POST /v1/conversations` and observes the real run event stream.
- SSE assertions include transition into `spec.author`, at least one valid `runner_*` event for `spec.author`, transition into `spec.human_review`, and final `waitingOn: "human"`.
- Tests do not assert provider-specific runner event wording.
- Existing tick-specific tests remain only as fallback/recovery coverage and are renamed or scoped accordingly.
Dependencies: Stories 1 through 4.
#### Task 5.1: Update service-level integration coverage

Description: Modify `apps/control-plane/src/control-plane-service.integration.spec.ts` so the service create path relies on orchestrator auto-dispatch.
Acceptance criteria:
- The test creates a feature conversation through `DefaultControlPlaneService.createConversationWithFirstRun`.
- It observes advancement to `spec.author` and then to `spec.human_review` without calling `tick`.
- Final service read/list assertions report `currentStep: 'spec.human_review'` and `waitingOn: 'human'`.
- Any remaining tick tests are clearly named as fallback/recovery behavior.
Dependencies: Story 4.
#### Task 5.2: Add or update network SSE end-to-end coverage

Description: Modify `apps/control-plane/src/integration.spec.ts` to prove the real HTTP and SSE path.
Acceptance criteria:
- The test uses the real `POST /v1/conversations` route.
- The test subscribes to `GET /v1/runs/:id/events` for the created run and does not inject a dispatch hook.
- The stream observes a `run_state_transition` into `spec.author`.
- The stream observes at least one valid `runner_*` event attributable to `spec.author`.
- The stream observes a `run_state_transition` into `spec.human_review`.
- A final network or service read asserts `currentStep: 'spec.human_review'` and `waitingOn: 'human'`.
- The test uses a controlled test runner delay/barrier so the run id can be returned, the SSE subscription can open, and then the runner can be released to emit live runner events and the subsequent `spec.human_review` transition.
- The test may use existing replay support for events that occurred before the run id was knowable, such as the initial start transition or a very fast transition into `spec.author`, but the runner event and later human-gate transition proof should be live after subscription.
Dependencies: Task 5.1.
#### Task 5.3: Remove normal-path dependence on captured tick hooks

Description: Refactor existing integration setup so captured tick hooks are not the mechanism that advances newly created production-path runs.
Acceptance criteria:
- No normal create-and-progress test calls `controlPlane.tick()` to move a newly created run.
- No normal create-and-progress test invokes a captured dispatch/tick function from the server setup.
- Tick fallback tests still call tick intentionally and assert fallback semantics.
- Test helper names and comments no longer describe tick as the production progression mechanism.
Dependencies: Tasks 5.1 and 5.2.
### Story 6: Documentation and validation complete the handoff

Description: Update agent-facing navigation docs and run the targeted validation suite for the changed orchestrator, service, and network behavior.
Acceptance criteria:
- `context-agent/wiki/code-map.md` documents the new auto-dispatch wiring and the fact that tick is fallback, not the normal create-and-progress path.
- Validation includes targeted core, service integration, network integration, and boundary checks where practical.
- Any skipped validation is documented with the exact reason.
- Remaining provider-event variability risk is called out in implementation handoff/PR notes.
Dependencies: Stories 1 through 5.
#### Task 6.1: Update the agent code map

Description: Edit `context-agent/wiki/code-map.md` during implementation so future agents can find the auto-dispatch behavior.
Acceptance criteria:
- The `packages/core/src/orchestrator.ts` entry mentions auto-dispatch helpers, enabled-by-default options, and detached failure handling.
- The entry mentions the in-flight guard.
- The service/API notes clarify that normal create-and-progress paths no longer depend on tick.
- The tick description remains as an explicit fallback seam.
Dependencies: Stories 1 through 3.
#### Task 6.2: Run targeted validation

Description: Execute the focused test commands from the tech spec after implementation.
Acceptance criteria:
- Run `pnpm nx test core -- orchestrator.spec.ts`.
- Run `pnpm nx test control-plane -- control-plane-service.integration.spec.ts`.
- Run `pnpm nx test control-plane -- integration.spec.ts`.
- Run broader `pnpm nx test core`, `pnpm nx test control-plane`, and `pnpm test:boundaries` when targeted tests pass and time permits.
- Run `pnpm validate` when practical.
- Record exact failures or skipped commands for follow-up.
Dependencies: Stories 1 through 5.
#### Task 6.3: Document implementation notes and residual risks

Description: Capture non-obvious implementation decisions in the final handoff or PR notes.
Acceptance criteria:
- Note any duplicate-dispatch behavior observed and how the required auto-dispatch in-flight guard handled it.
- Note how asynchronous dispatch failures are sanitized before logging or persistence.
- Note any provider-specific SSE variability observed in tests.
- Note any validation commands that were skipped or failed.
Dependencies: Tasks 6.1 and 6.2.