---
created: 2026-06-13
last_updated: 2026-06-13
status: complete
issue: 47
specced_by: autocatalyst
---
# Feature: Sanitized failed-run reason

## Product requirements

### What

When a run fails, Autocatalyst carries a sanitized, human-readable failure reason from the runner failure path to every operator-facing run surface. The reason is stable enough for automation and safe enough for logs, persistence, API reads, and Server-Sent Events (SSE). For example, a provider authentication failure maps to `provider_auth_failed` rather than exposing a raw SDK message, request body, header, token, filesystem path, or provider-specific diagnostic.
The feature threads that reason through the existing failed-run path. The runner or execution layer produces a sanitized fail reason, the orchestrator preserves it on the `fail` directive, the run record persists it as `failureReason`, `GET /v1/runs/:id` exposes it for failed runs, and the `fail` `run_state_transition` event includes the same value over SSE.
### Why

A terminal `failed` run is currently too opaque for an operator. The execution unit of work already returns a reason on a fail result, but the orchestrator drops it when applying the `fail` directive. The run record and transition event also lack a field that can carry it.
This leaves operators and agents with the most important fact missing: why the run failed. A safe failure reason lets Opal, Enzo, and automated tooling decide whether to fix credentials, retry later, inspect workspace state, or escalate without reading raw provider output or searching logs for unsafe error detail.
### Goals

- Preserve the unit-of-work fail reason when the orchestrator applies a `fail` directive.
- Persist a failed run's sanitized reason on the durable `Run` record as `failureReason`.
- Expose `failureReason` through the shared run contract and `GET /v1/runs/:id`.
- Include the same reason in the `fail` `run_state_transition` event payload delivered over `/v1/runs/:id/events`.
- Produce the canonical stable provider failure code: provider authentication failures, including provider 401 responses, map to exactly `provider_auth_failed` on persisted and public surfaces.
- Prevent raw SDK messages, secrets, request content, response bodies, absolute paths, and provider-specific sensitive detail from appearing in `failureReason`, transition events, run records, API responses, or logs.
- Prove the behavior with an end-to-end forced-failure test that drives the production create -\> auto-dispatch -\> failure path.
### Non-goals

- A complete taxonomy for every possible provider, transport, workspace, validation, and orchestration failure.
- Changing the run lifecycle, terminal states, workflow transition table, or directive vocabulary.
- Adding UI screens for failed-run diagnosis.
- Changing retention policy for run events, logs, or telemetry stores.
- Recording raw provider diagnostics anywhere durable.
- Replacing the current no-leak adapter logging policy that records only safe metadata such as error name.
- Implementing the in-step adversarial convergence loop, human reply classification, or auto-dispatch itself beyond depending on the existing auto-dispatch path.
### Personas

#### Opal

- **Role:** Operator watching active and failed runs.
- **Cares about:** Seeing a clear, safe reason for failure without opening provider logs or workspaces.
- **Constraints:** She must not see raw SDK messages, tokens, request bodies, response bodies, or secret-adjacent values.
#### Enzo

- **Role:** Engineer maintaining the orchestrator, runner boundary, API contracts, and persistence layer.
- **Cares about:** One reason value flowing through existing seams without side-channel fields or provider-specific control-plane logic.
- **Constraints:** He needs additive schema changes, strict validation, and tests that prove the chain does not drop or mutate the reason unexpectedly.
#### Phoebe

- **Role:** Product owner reviewing run outcomes.
- **Cares about:** Failed work being understandable enough to decide whether to retry, fix configuration, or file follow-up work.
- **Constraints:** She should not need to know the runner implementation or provider SDK to understand a common failure such as bad credentials.
### Narratives

#### Opal diagnoses bad credentials

Opal starts a feature run that reaches an AI step. The configured provider credential is invalid, and the provider returns an authentication failure. The adapter and connection layer classify that condition as `provider_auth_failed` and avoid logging the provider's raw response.
The run moves to `failed`. Opal calls `GET /v1/runs/:id` and sees `failureReason: "provider_auth_failed"` on the returned run. She also watches `/v1/runs/:id/events` and sees the `fail` transition carry the same reason.
Opal rotates the credential and retries from the appropriate recovery path. She does not need to inspect raw SDK errors, and no secret appears in logs, persisted state, or the event stream.
#### Enzo follows a failed run through the control plane

Enzo writes a test where the execution unit of work returns `{ directive: "fail", reason: "provider_auth_failed" }`. The orchestrator passes that reason into `applyDirective` instead of dropping it. The lifecycle persistence updates the run to `failed` and stores the same sanitized value.
The transition publisher constructs a `run_state_transition` event with `transition.directive: "fail"` and `transition.reason` set to the stored value. The event schema accepts the field only as a bounded string. Existing non-fail transitions remain unchanged.
#### Phoebe reads an actionable failure

Phoebe checks a failed run from issue work. The status says the run failed, and the run details include a concise failure reason. She can tell that this is a provider authentication problem, not a spec-review rejection or a build failure.
The reason is intentionally short. It supports routing and action, but it does not expose the underlying provider message or stack trace.
### User stories

- As Opal, I want a failed run to expose a safe `failureReason`, so that I can tell why it failed without reading raw logs.
- As Opal, I want the `fail` SSE transition to carry the same reason as the run read, so that live watchers and later API reads agree.
- As Opal, I want provider authentication failures to map to the stable code `provider_auth_failed`, so that I can fix credentials instead of treating the run as an unknown failure.
- As Enzo, I want the unit-of-work fail reason to pass through `applyDirective`, so that the existing runner boundary remains the source of failure classification.
- As Enzo, I want the persisted run schema and shared API contract to include `failureReason`, so that every service layer uses the same shape.
- As Enzo, I want no raw SDK or secret detail in failure reasons or logs, so that observability remains safe by default.
- As Phoebe, I want failed-run status to include an understandable reason, so that I can decide whether to retry, reconfigure, or ask for help.
### Acceptance criteria

- `ApplyOrchestratedDirectiveInput` accepts an optional sanitized `reason` for `fail` directives.
- `dispatch` passes the unit-of-work's `fail` reason into `applyDirective` when the work result is `fail`.
- Existing internal failure-to-fail paths that synthesize a fail directive use a safe stable reason where one is available, and they do not expose raw exception messages.
- `Run` gains an optional `failureReason` field in `packages/api-contract/src/run.ts` and related exported types.
- The persistence schema stores `failureReason` on `runs`, with migrations and repository mapping updated for creates, reads, and lifecycle transitions.
- A run transition to `failed` sets `failureReason` to the sanitized reason when one is supplied.
- Non-failed runs do not expose a stale failure reason after normal non-fail transitions.
- `GET /v1/runs/:id` returns `failureReason` for a failed run with a persisted reason.
- `run_state_transition` events allow a reason on `transition` only for the `fail` directive, and the event created for a failed transition carries the same sanitized value as the persisted run.
- `/v1/runs/:id/events` delivers that transition over SSE with the reason in the JSON `data` frame.
- The adapter and connection layer classify provider authentication failures, including a provider 401, as exactly `provider_auth_failed` before persistence, API responses, or SSE publication.
- No raw SDK message, provider response body, request body, header value, token, credential, secret handle value, or absolute workspace path appears in `failureReason`, persisted run JSON, transition event JSON, API response JSON, or ordinary logs.
- A forced-failure end-to-end test drives create -\> auto-dispatch -\> provider-auth failure through the production path and asserts the same sanitized `failureReason` on `GET /v1/runs/:id` and the `fail` transition event over SSE.
- Existing tests for runner terminal fail results continue to pass, including validation that fail results use `reason` and not `question`.
- `context-agent/wiki/code-map.md` is updated during implementation for the failure-reason threading.
### Non-functional requirements

- **Security:** The failure reason is a sanitized code or short safe phrase. It must not include content, secrets, raw provider diagnostics, stack traces, absolute paths, or unredacted URLs.
- **Compatibility:** The API change is additive. Existing run consumers that ignore unknown fields continue to work.
- **Consistency:** The persisted run and the fail transition event carry the same reason value for the transition that failed the run.
- **Durability:** The reason survives process restart because it is stored on the durable run record, not only in logs or retained events.
- **Observability:** The reason is suitable for grouping failures in logs, metrics, and operator views.
- **Provider neutrality:** The control plane stores a provider-neutral reason string. Provider-specific classification stays in the execution connection layer or adapter.
### Devil's advocate pass

- **The main risk is accidental leakage.** Raw provider errors often include URLs, request details, or response bodies. The design treats adapter and connection classification as a whitelist of stable codes rather than copying exception messages.
- **The second risk is mismatched state.** If the event uses the unit-of-work reason but persistence stores a different value, live watchers and API readers disagree. The tech spec makes `applyDirective` carry one reason into lifecycle persistence and event construction.
- **A full taxonomy would slow this feature down.** The issue only needs threading plus at least provider authentication classification. Other stable codes can be added when specific failure modes are encountered.
- **Reason optionality matters.** Some fail paths may not have a classified reason yet. The API should allow absence or a generic safe fallback, but it must never make up detailed diagnostics from raw errors.
### Reviewer pass

This feature aligns with the observability concept by adding an actionable durable fact to the run record while keeping diagnostic detail in safe telemetry. It aligns with the run concept by preserving the existing `fail` directive and terminal `failed` state. It aligns with the agent-runners concept by keeping provider identity and failure classification at the adapter and connection boundary instead of embedding provider logic in the orchestrator.
The request explicitly says to treat issue 47 as a feature. This spec therefore uses the feature workflow and file naming even though the issue currently has an `enhancement` label.
## Design spec

### Design scope

This is a backend and API feature. It adds no visual UI, screens, layout, or design-system components. The design covers what operators and API/SSE clients observe when a run fails.
### Goals of the design

- Make the reason for a failed run visible on both polling and live-stream surfaces.
- Keep one canonical sanitized reason value across runner output, run persistence, API response, and transition event.
- Make common provider authentication failures actionable without leaking provider internals.
- Preserve existing behavior for non-failed transitions and successful runs.
### User flows

#### Flow 1: Forced provider-auth failure becomes visible

1. A feature run starts and auto-dispatch reaches an AI-backed step.
2. The connection layer or adapter receives a provider authentication failure, such as HTTP 401.
3. The execution path maps the failure to `provider_auth_failed` and emits or returns a fail terminal result with that sanitized reason.
4. The core unit of work returns `{ directive: "fail", reason: "provider_auth_failed" }` for provider-auth failures. Existing safe phrases remain compatible for non-provider-auth legacy paths only.
5. The orchestrator calls `applyDirective` with `directive: "fail"` and the reason.
6. Lifecycle persistence moves the run to `failed` and writes `failureReason` on the run.
7. The transition event publisher emits a `run_state_transition` event with `transition.directive: "fail"`, `transition.toStep: "failed"`, and the same reason.
8. `GET /v1/runs/:id` returns the failed run with `failureReason`.
9. `/v1/runs/:id/events` streams the fail transition with the same reason in the event payload.
#### Flow 2: Fail path has only a generic safe reason

1. A runner or control-plane boundary fails before producing a more specific classification.
2. The unit of work maps the failure to a safe existing reason, such as `Runner failed before terminal result.` or `Execution failed: `.
3. The orchestrator persists and publishes that safe reason without using the raw exception message.
4. Operators see a less specific reason, but the response remains safe and durable.
#### Flow 3: Normal transition does not carry a failure reason

1. A run advances, needs input, is revised, starts, or is canceled.
2. The transition event omits `transition.reason`.
3. The run record has no `failureReason` unless the run is in the failed terminal state from a prior failed transition.
4. API clients do not need to handle reason fields on successful or human-waiting runs.
### States and interaction behavior

- `failureReason` is meaningful only when `currentStep` is `failed` and `terminal` is `true`.
- A `fail` transition may carry a reason. Other transition directives must not carry a failure reason in their transition payload.
- The run response may omit `failureReason` when there is no reason. If present, it is a sanitized string.
- The event stream and run read should agree for the transition that fails the run.
- A missing reason is allowed for backward compatibility, but new production failure paths should supply a safe reason whenever one is available.
### Components and interactions

- **Provider connection layer:** Classifies transport and provider response failures into stable safe codes. It should classify provider authentication failures as `provider_auth_failed` and keep response bodies out of logs and errors.
- **Provider adapter:** Catches provider SDK failures, logs only safe metadata, and produces or propagates sanitized failure classifications. The Claude adapter already avoids logging raw error messages; this behavior remains required.
- **Execution entry point and runner consumer:** Preserve validated fail terminal reasons and synthesized safe failure reasons when mapping runner events to `RunWorkResult`.
- **Orchestrator:** Adds `reason` to `ApplyOrchestratedDirectiveInput`, passes unit-of-work fail reasons through dispatch, and forwards the reason into lifecycle persistence and event publication.
- **Run lifecycle and repository:** Store `failureReason` on the run when applying a fail transition and prevent stale reasons on non-fail states.
- **API contract:** Adds `failureReason` to `runSchema` and adds an optional reason field to the fail transition event payload.
- **Routes and control-plane service:** Continue to return `Run` through the shared contract so `GET /v1/runs/:id` exposes the new field automatically after repository mapping is updated.
- **SSE route:** Reuses `clientRunEventSchema` and frame formatting. No frame-name change is needed.
### Content design

Failure reasons should be short and stable. Preferred values are allowlisted snake_case codes such as `provider_auth_failed`, `spec_authoring_failed`, `auto_dispatch_failed`, `runner_failed_before_terminal_result`, `workspace_provisioning_failed`, `result_file_missing`, or `schema_validation_failed`. Existing exact safe execution phrases may continue where they are already part of the execution boundary for non-provider-auth paths, but only when they appear in the enumerated `KnownSafeFailurePhrase` list in the tech spec. Provider-auth classifications must use exactly `provider_auth_failed`. The recommended public codes and the implementation allowlist must stay in sync so normalization preserves existing safe reasons instead of flattening them to a generic fallback.
The value should answer "what kind of failure happened?" rather than "what exact provider text was returned?". Detailed raw diagnostics remain out of scope for durable surfaces.
### Accessibility and responsive behavior

No UI accessibility or responsive-layout work is included. Future UI surfaces should present `failureReason` as readable text, pair code-like values with explanations when available, and avoid relying on color alone to indicate failure.
### Design system updates

None.
### Reviewer pass

The design keeps all operator-visible behavior in existing API and SSE surfaces. It does not add a second failure-reporting channel, and it keeps provider-specific classification outside the control plane. Provider-auth failures use the canonical bare code `provider_auth_failed`; existing exact safe phrases remain allowed only for compatibility with non-provider-auth legacy paths until those paths are classified.
## Tech spec

### Overview

Issue 47 closes the gap between failure classification and operator visibility. The code already models runner terminal fail results with a `reason`, and `RunWorkResult` already has `{ directive: "fail"; reason: string }`. The orchestrator currently drops that reason when it calls `applyDirective`, while `Run`, run persistence, and `run_state_transition` events lack fields to carry it.
The implementation should make additive contract and persistence changes, then thread one sanitized reason value through dispatch, directive application, lifecycle persistence, run reads, event construction, and SSE delivery. Provider-auth classification should be added at the provider connection/adapter boundary without leaking raw SDK detail.
### Architecture

#### API contracts

- Update `packages/api-contract/src/run.ts`:
	- Add `failureReason: z.string().min(1).optional()` to `runSchema`.
	- Consider the same field on create/update inputs only if repository creation paths need it; ordinary run creation should not set it.
	- Keep the field optional for additive compatibility.
- Update `packages/api-contract/src/run-events.ts`:
	- Extend `runStateTransitionEventSchema.transition` with `reason: z.string().min(1).optional()`.
	- Add a refinement so `reason` is valid only when `directive === "fail"`.
	- Keep existing frame names and event discriminators unchanged.
- Update API contract tests for run parsing, run event parsing, and fail-transition validation.
- Update OpenAPI generation expectations if snapshots or schema assertions cover `Run` or run events.
#### Persistence

- Update `packages/persistence/src/schema.ts` so `runs` has a nullable `failure_reason` text column.
- Add the corresponding migration and migration tests. Existing rows should read as `failureReason` absent.
- Update `packages/persistence/src/domain-repositories.ts`:
	- Map `failure_reason` to `failureReason` on reads.
	- Persist `failureReason` when a lifecycle transition sets it.
	- Clear or leave unset for run creation and non-fail transitions.
- Update run repository tests and lifecycle persistence tests to cover setting the reason on fail and preserving absence on non-fail transitions.
#### Core lifecycle and orchestrator

- Update `ApplyOrchestratedDirectiveInput` in `packages/core/src/orchestrator.ts` with `reason?: string`.
- Update `dispatch` so unit-of-work fail results call:
```typescript
return this.applyDirective({
  runId: input.runId,
  directive: 'fail',
  tenant: input.tenant,
  reason: result.reason
});
```
- Update other synthesized fail paths to pass safe stable reasons when available. Do not pass raw caught error messages.
- Update `applyRunDirective` and its input type in `packages/core/src/run-lifecycle.ts` so a fail transition can carry a reason into repository persistence.
- Update `RunRepository.recordRunStepTransition` or the equivalent repository input shape to accept `failureReason?: string`.
- Ensure non-fail transitions do not retain a stale failure reason. The safest behavior is:
	- Set `failureReason` to the supplied sanitized reason on `directive: "fail"`.
	- Set it to `undefined` or `null` for any transition whose target is not `failed`.
- Update event publication in `packages/core/src/orchestrator.ts` and `packages/core/src/run-events.ts`:
	- Add `reason?: string` to `CreateRunStateTransitionEventInput`.
	- Include `transition.reason` only for fail events with a supplied reason.
	- Use the same reason passed to lifecycle persistence, not a separately recomputed value.
- Update orchestrator tests that currently assert fail transition behavior so they assert the reason is passed through and published.
#### Execution and provider classification

- Preserve existing fail terminal behavior in `packages/api-contract/src/runner-events.ts`, `packages/api-contract/src/step-results.ts`, `packages/core/src/runner-event-consumer.ts`, and `packages/core/src/execution-run-unit-of-work.ts`.
- Add a small provider-neutral sanitized failure classifier near the connection layer or shared execution error boundary. It should map:
	- HTTP 401 or provider-auth equivalents -\> `provider_auth_failed`.
	- Existing stable execution errors -\> their existing safe codes where already available, including `workspace_provisioning_failed`, `result_file_missing`, and `schema_validation_failed`.
	- Unknown raw provider errors -\> a generic safe code or existing safe fallback, not the raw message.
- Update `packages/execution/src/connection.ts` so non-transient provider authentication failures throw or return a classified safe failure code that downstream runner paths can convert into a fail terminal reason.
- Update `packages/claude-agent-adapter/src/claude-agent-adapter.ts` so SDK failures can produce the sanitized code without logging `err.message`. Keep existing safe logging of `errorName` and provider metadata.
- Update `packages/openai-agent-adapter/src/openai-agent-adapter.ts` so OpenAI Agents SDK startup, sandbox, and run-session authentication failures that bypass the shared connection classifier also produce the sanitized code without logging `err.message`, response bodies, request bodies, paths, tokens, or secret values.
- If the current adapter cannot convert thrown SDK errors directly into terminal fail events, ensure the execution unit of work maps the resulting typed execution error to the canonical public reason `provider_auth_failed`.
#### API and SSE surface

- `GET /v1/runs/:id` should expose `failureReason` automatically through the shared `Run` schema after repository mapping is updated.
- `/v1/runs/:id/events` should require no route-specific changes beyond accepting the updated `clientRunEventSchema`; it already writes `data: ${JSON.stringify(validated)}` for each event.
- Ensure replayed retained events and live events both carry the same transition shape.
- No change is needed to `/v1/events` unless it reuses the same client event schemas for run transition payloads.
### Data model

#### Run

```typescript
type Run = {
  id: string;
  topicId: string;
  owner: NonModelPrincipal;
  tenant: string;
  workKind: string;
  currentStep: string;
  waitingOn?: 'system' | 'ai' | 'human' | 'none';
  terminal: boolean;
  trackedIssue?: TrackedIssue;
  testingGuideResult?: TestingGuideResult;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
};
```
Persistence stores this as nullable `runs.failure_reason`. The API omits the field when it is absent.
#### Run state transition event

```typescript
type RunStateTransitionEvent = {
  id: string;
  type: 'run_state_transition';
  runId: string;
  transition: {
    directive: 'start' | 'advance' | 'revise' | 'needs_input' | 'cancel' | 'fail';
    fromStep?: string;
    toStep: string;
    reason?: string; // only for directive === 'fail'
  };
  run: Run;
  runStep: RunStep;
  tenant: string;
  createdAt: string;
};
```
The event embeds the post-transition `run`, so `event.transition.reason` and `event.run.failureReason` should match for failed transitions when a reason exists.
### Error and sanitization policy

- Treat `failureReason` as public API data, not as an internal diagnostic field.
- Prefer stable snake_case codes for new classifications.
- Never derive `failureReason` by copying `Error.message` from provider SDKs or filesystem errors.
- The classifier may inspect structured error fields such as HTTP status, typed error code, or known safe enum values.
- The classifier must ignore response body content and secret-bearing values.
- Logs on the provider path should record safe metadata only: provider kind, adapter id, run id, step, typed code, and error name if safe.
- Existing redaction helpers remain a defense-in-depth layer, not the primary reason generator.
### Sanitization and allowlist boundary

The boundary for public and durable failure reasons is the transition from runner/execution/control-plane inputs into `applyDirective`, lifecycle persistence, and run-event construction. Runner terminal results and `ApplyOrchestratedDirectiveInput.reason` remain string-shaped at their existing TypeScript seams for compatibility, but they are untrusted until normalized by the failure-reason module.
Implementation must use an allowlist normalizer before any write to `Run.failureReason`, `runs.failure_reason`, `transition.reason`, API JSON, SSE JSON, or ordinary logs:
- Preserve every code in `KnownFailureReasonCode`: `provider_auth_failed`, `spec_authoring_failed`, `auto_dispatch_failed`, `runner_failed_before_terminal_result`, `workspace_provisioning_failed`, `result_file_missing`, and `schema_validation_failed`.
- Preserve only exact known legacy safe phrases listed in `KnownSafeFailurePhrase` for compatibility with existing non-provider-auth paths. The initial complete list is:
	- `Runner failed before terminal result.`
	- `Execution failed: workspace_provisioning_failed`
	- `Execution failed: result_file_missing`
	- `Execution failed: result_file_unreadable`
	- `Execution failed: result_json_invalid`
	- `Execution failed: result_path_outside_scratch_root`
	- `Execution failed: result_contract_missing`
	- `Execution failed: result_contract_unknown`
	- `Execution failed: schema_validation_failed`
	- `Execution failed: correction_attempts_exhausted`
	- `Execution failed: correction_request_failed`
	- `Execution failed: normalizer_failed`
	- `Execution failed: direct_port_not_configured`
	- `Execution failed: direct_call_failed`
	- `Execution failed: unsupported_adapter`
	- `Execution failed: missing_candidate`
	- `Execution failed: invalid_direct_metadata`
	- `Execution failed: structured_result_missing`
	- `Execution failed: structured_result_malformed`
	- `Execution failed: multiple_structured_candidates`
	- `Execution failed: extra_structured_output`
- Map classified provider-auth failures to exactly `provider_auth_failed`; do not wrap this value in `Execution failed: ...` for persisted or public surfaces.
- Replace unknown non-empty runner terminal reasons, unknown `applyDirective` reasons, raw exception messages, paths, URLs, response bodies, request bodies, headers, token-like values, and any value failing the allowlist with `runner_failed_before_terminal_result` unless a more specific typed classifier provides another known code. The rejected value must not be logged; logs may record only that an unknown reason was replaced plus safe metadata such as run id and provider kind.
- Reject empty or non-string reason values at schema/contract boundaries where they are invalid.
- Use the normalized value once for both lifecycle persistence and event creation so the stored run and the fail transition agree.
Focused tests for `runner-event-consumer`, `execution-run-unit-of-work`, `orchestrator.applyDirective`, and `createRunStateTransitionEvent` should prove that arbitrary non-empty strings cannot reach persisted or public failure-reason fields unchanged.
### Test strategy

- **API contract tests:** Add positive and negative schema tests for `Run.failureReason` and fail transition `transition.reason`.
- **Persistence tests:** Verify migration shape, repository read/write mapping, fail transition persistence, and absence on non-fail transitions.
- **Core orchestrator tests:** Verify `dispatch` passes unit-of-work fail reasons into `applyDirective`, fail events carry the reason, and non-fail events omit it.
- **Runner/execution tests:** Verify allowlisted terminal fail reasons still pass through, unknown runner-supplied strings are replaced with a safe fallback, synthesized validation failures remain sanitized, and provider-auth classification maps to `provider_auth_failed`.
- **Adapter/connection tests:** Simulate HTTP 401 or provider-auth SDK errors in the shared connection layer, Claude adapter, and OpenAI agent adapter, and assert the safe code appears while raw messages, response bodies, and secrets do not.
- **Route/SSE tests:** Verify `GET /v1/runs/:id` exposes `failureReason` and `/v1/runs/:id/events` writes a fail frame whose JSON data includes the same reason.
- **End-to-end forced-failure test:** Drive create -\> auto-dispatch -\> failure through production code with bad credentials or a production-path provider-auth failure seam. Assert `GET /v1/runs/:id` and SSE agree on the sanitized reason. Do not inject a fake unit-of-work fail result for this acceptance test.
- **No-leak regression tests:** Include sentinel secret values in simulated provider configuration or error detail and assert serialized logs, run JSON, and event JSON do not contain them.
### Rollout and compatibility

This is an additive API and database change. Existing clients can ignore `failureReason`. Existing retained events do not gain a reason retroactively, so clients must tolerate older fail events without `transition.reason`.
The implementation should not rewrite historical run records. New failed transitions populate the field. Older failed runs may have no reason.
### Open questions

- Should all future non-provider failure reasons be bare codes, or should existing safe phrases remain as-is until each path is classified? This feature requires the canonical `provider_auth_failed` code for provider-auth failures and allows exact safe legacy phrases only for other compatibility paths.
- Should a future API expose a documented enum of known failure codes? This feature establishes the field and one provider-auth code, but a full taxonomy is out of scope.
- Should failure reasons be mirrored into metrics labels? The reason is safe enough for grouping, but metric cardinality policy should be handled separately.
### Reviewer pass

The tech spec keeps the data flow narrow: one optional reason enters on a fail directive, persists on the run, and publishes on the fail transition. The provider-auth code is classified near provider boundaries, where status and SDK details are available, while the control plane stores only a provider-neutral string. The main implementation risk is a tempting shortcut that copies exception messages into `failureReason`; tests with sentinel secrets should block that.
## Task list

### Dependency graph

- Story 1 / Task 1.1: Add `failureReason` to run and run-event contracts has no dependencies.
- Story 1 / Task 1.2: Add nullable `runs.failure_reason` storage depends on Story 1 / Task 1.1.
- Story 1 / Task 1.3: Map `failureReason` through persistence repositories depends on Story 1 / Task 1.2.
- Story 2 / Task 2.1: Extend core repository and lifecycle inputs depends on Story 1 / Task 1.3.
- Story 2 / Task 2.2: Pass unit-of-work fail reasons through orchestrator dispatch depends on Story 2 / Task 2.1.
- Story 2 / Task 2.3: Create fail transition events with the persisted reason depends on Story 1 / Task 1.1 and Story 2 / Task 2.2.
- Story 3 / Task 3.1: Add sanitized failure reason primitives depends on Story 1 / Task 1.1.
- Story 3 / Task 3.2: Classify provider-auth failures in the connection layer depends on Story 3 / Task 3.1.
- Story 3 / Task 3.3: Classify Claude adapter SDK auth failures safely depends on Story 3 / Task 3.1.
- Story 3 / Task 3.4: Classify OpenAI agent adapter SDK auth failures safely depends on Story 3 / Task 3.1.
- Story 3 / Task 3.5: Convert classified execution errors into fail results depends on Story 2 / Task 2.2, Story 3 / Task 3.2, Story 3 / Task 3.3, and Story 3 / Task 3.4.
- Story 4 / Task 4.1: Add focused GET and SSE route regression tests depends on Story 1 / Task 1.3 and Story 2 / Task 2.3.
- Story 4 / Task 4.2: Add the production-path forced-failure acceptance test depends on Story 3 / Task 3.5 and Story 4 / Task 4.1.
- Story 4 / Task 4.3: Add no-leak regression coverage across serialized outputs depends on Story 3 / Task 3.1 through Story 4 / Task 4.2.
- Story 5 / Task 5.1: Update agent navigation documentation depends on Stories 1 through 4.
- Story 5 / Task 5.2: Run targeted package validation depends on Story 1 / Task 1.1 through Story 4 / Task 4.3.
- Story 5 / Task 5.3: Run broad workspace validation depends on Story 5 / Task 5.2.
### Story 1: Public contracts and persistence can carry a sanitized reason

Enzo can add `failureReason` to the shared API shape and durable run storage without changing existing run lifecycle states or requiring clients to send the field during run creation.
#### Task 1.1: Add `failureReason` to run and run-event contracts

- **Description:** Update the API contract package so failed runs can expose an optional `failureReason` and fail `run_state_transition` events can expose an optional `transition.reason` while non-fail transitions reject that field.
- **Acceptance criteria:**
	- `packages/api-contract/src/run.ts` adds optional non-empty `failureReason` to `runSchema` and the inferred `Run` type.
	- `packages/api-contract/src/run-events.ts` adds optional non-empty `transition.reason` to `runStateTransitionEventSchema` only when `transition.directive === "fail"`.
	- Existing event discriminators, SSE frame names, route constants, and run fields stay unchanged.
	- `packages/api-contract/src/run.spec.ts` proves ordinary runs still parse, failed runs with non-empty `failureReason` parse, and empty or non-string reasons fail.
	- `packages/api-contract/src/run-events.spec.ts` proves fail transitions can carry a reason and non-fail transitions cannot.
- **Dependencies:** None.
#### Task 1.2: Add nullable `runs.failure_reason` storage

- **Description:** Add the durable nullable database column and migration needed to persist a failed run reason without rewriting historical runs.
- **Acceptance criteria:**
	- `packages/persistence/src/schema.ts` defines nullable `runs.failure_reason`.
	- `packages/persistence/drizzle/0008_run_failure_reason.sql` adds the nullable column for existing SQLite databases.
	- `packages/persistence/drizzle/meta/_journal.json` registers the migration in sequence.
	- `packages/persistence/src/migrations.spec.ts` proves migrated existing rows read with no `failureReason` until a failed transition stores one.
- **Dependencies:** Story 1 / Task 1.1.
#### Task 1.3: Map `failureReason` through persistence repositories

- **Description:** Update persistence repository mapping so run reads and lifecycle transition writes round-trip `failureReason` consistently.
- **Acceptance criteria:**
	- `packages/persistence/src/domain-repositories.ts` maps `runs.failure_reason` to `Run.failureReason` on reads.
	- `recordRunStepTransition` persists `failureReason` for failed transitions and clears it for non-failed target states.
	- New run creation and legacy rows omit `failureReason` unless a later fail transition sets it.
	- `packages/persistence/src/domain-repositories.spec.ts` covers create/read absence, fail-transition persistence, returned run mapping, and stale-reason clearing on a subsequent non-fail transition.
- **Dependencies:** Story 1 / Task 1.2.
### Story 2: Core lifecycle and event publication thread one reason value

Opal can trust that the reason shown in the run record and the reason shown in the fail transition came from the same sanitized value passed through the existing fail directive path.
#### Task 2.1: Extend core repository and lifecycle inputs

- **Description:** Add the optional failure reason to the core repository transition contract and lifecycle directive input, then pass it only when the directive fails the run.
- **Acceptance criteria:**
	- `packages/core/src/domain-repositories.ts` adds optional `failureReason` to `RecordRunStepTransitionInput`.
	- `packages/core/src/run-lifecycle.ts` adds optional `reason` to `ApplyRunDirectiveInput`.
	- `applyRunDirective` forwards `reason` as `failureReason` only for failed transitions.
	- Non-fail transitions omit or clear stale `failureReason` through the repository contract.
	- `packages/core/src/run-lifecycle.spec.ts` covers fail forwarding, non-fail omission/clearing, and invalid or terminal transitions not persisting stale reasons.
- **Dependencies:** Story 1 / Task 1.3.
#### Task 2.2: Pass unit-of-work fail reasons through orchestrator dispatch

- **Description:** Update the orchestrator so `RunWorkResult` fail reasons reach `applyDirective`, are normalized at the public/durable boundary, and then use one normalized value for lifecycle persistence and event creation.
- **Acceptance criteria:**
	- `packages/core/src/orchestrator.ts` adds optional `reason` to `ApplyOrchestratedDirectiveInput`.
	- `dispatch` passes `result.reason` when a unit of work returns `{ directive: "fail" }`.
	- `applyDirective` normalizes `reason` once, then passes the same normalized value to `applyRunDirective` and event publication.
	- Synthesized fail paths use stable safe reasons such as `spec_authoring_failed` or `auto_dispatch_failed` and never copy caught raw error messages.
	- `packages/core/src/orchestrator.spec.ts` proves unit-of-work fail reasons are persisted and published, non-fail events omit `transition.reason`, and synthesized fail paths use stable safe codes.
- **Dependencies:** Story 2 / Task 2.1.
#### Task 2.3: Create fail transition events with the persisted reason

- **Description:** Extend core run-event creation so fail events include `transition.reason` only when a sanitized reason is supplied, and the embedded run agrees with the transition.
- **Acceptance criteria:**
	- `packages/core/src/run-events.ts` adds optional `reason` to `CreateRunStateTransitionEventInput`.
	- `createRunStateTransitionEvent` includes `transition.reason` only for fail directives with a supplied reason.
	- Event creation validates through the updated contract schema and rejects reason-on-non-fail cases.
	- `packages/core/src/run-events.spec.ts` proves fail reason creation, non-fail omission, schema rejection for invalid reason placement, and agreement between `transition.reason` and embedded `run.failureReason`.
- **Dependencies:** Story 1 / Task 1.1 and Story 2 / Task 2.2.
### Story 3: Provider failures are classified before they reach public surfaces

Enzo can classify provider authentication failures into stable safe reasons near the provider boundary while unknown or unsupported provider errors fall back to existing safe generic reasons.
#### Task 3.1: Add sanitized failure reason primitives

- **Description:** Create the provider-neutral failure reason module and typed classified-provider error used by execution, connection, and adapter code.
- **Acceptance criteria:**
	- `packages/execution/src/failure-reasons.ts` exports the agreed constants, `SanitizedFailureReason`, `KnownFailureReasonCode`, `KnownSafeFailurePhrase`, `makeSanitizedFailureReason`, `normalizeFailureReasonForPublicSurface`, `formatExecutionFailureReason`, `ProviderFailureClassificationInput`, and `classifyProviderFailure`.
	- `KnownFailureReasonCode` includes `provider_auth_failed`, `spec_authoring_failed`, `auto_dispatch_failed`, `runner_failed_before_terminal_result`, `workspace_provisioning_failed`, `result_file_missing`, and `schema_validation_failed`.
	- `KnownSafeFailurePhrase` preserves exactly this enumerated list and no open-ended phrase pattern: `Runner failed before terminal result.`, `Execution failed: workspace_provisioning_failed`, `Execution failed: result_file_missing`, `Execution failed: result_file_unreadable`, `Execution failed: result_json_invalid`, `Execution failed: result_path_outside_scratch_root`, `Execution failed: result_contract_missing`, `Execution failed: result_contract_unknown`, `Execution failed: schema_validation_failed`, `Execution failed: correction_attempts_exhausted`, `Execution failed: correction_request_failed`, `Execution failed: normalizer_failed`, `Execution failed: direct_port_not_configured`, `Execution failed: direct_call_failed`, `Execution failed: unsupported_adapter`, `Execution failed: missing_candidate`, `Execution failed: invalid_direct_metadata`, `Execution failed: structured_result_missing`, `Execution failed: structured_result_malformed`, `Execution failed: multiple_structured_candidates`, and `Execution failed: extra_structured_output`.
	- `normalizeFailureReasonForPublicSurface` preserves allowlisted codes and exact known safe phrases, including malformed-spec `schema_validation_failed` output, instead of flattening them to `runner_failed_before_terminal_result`.
	- `classifyProviderFailure` maps HTTP 401, `statusCode` 401, allowlisted auth codes, and known auth error names/classes to `provider_auth_failed`.
	- The classifier never copies `Error.message`, response bodies, request bodies, headers, tokens, absolute paths, URLs, or secret handle values into output.
	- `packages/execution/src/errors.ts` exports `ClassifiedProviderFailureError` with a fixed generic message, sanitized `failureReason`, safe metadata only, and `isClassifiedProviderFailureError`.
	- `packages/execution/src/failure-reasons.spec.ts` covers allowed classifications, widened safe code preservation, exact legacy safe phrases, rejection of unsafe/open-ended strings, and sentinel secret no-copy behavior.
- **Dependencies:** Story 1 / Task 1.1.
#### Task 3.2: Classify provider-auth failures in the connection layer

- **Description:** Use the sanitized classifier where provider transport and launch-time credential failures are visible to the execution connection layer.
- **Acceptance criteria:**
	- `packages/execution/src/connection.ts` converts provider HTTP 401 and launch-time credential validation failures into `ClassifiedProviderFailureError` with `provider_auth_failed`.
	- Connection logs contain safe structured metadata only, such as provider kind, status, code, and error name.
	- Connection logs and thrown classified errors exclude raw response bodies, request payloads, headers, tokens, secret values, absolute paths, and secret-bearing URLs.
	- `packages/execution/src/connection.spec.ts` simulates 401 and credential validation failures and asserts the safe reason plus no-leak behavior.
- **Dependencies:** Story 3 / Task 3.1.
#### Task 3.3: Classify Claude adapter SDK auth failures safely

- **Description:** Update the Claude adapter async-generator failure path so SDK authentication failures become classified provider failures without logging raw SDK diagnostics.
- **Acceptance criteria:**
	- `packages/claude-agent-adapter/src/claude-agent-adapter.ts` classifies SDK failures from safe structural properties such as `status`, `statusCode`, allowlisted `code`, `errorName`, or known auth error class identity.
	- Auth failures throw or emit `ClassifiedProviderFailureError` with `provider_auth_failed`.
	- Existing safe logging behavior is preserved: logs may include safe metadata but not `err.message`, response bodies, request bodies, paths, tokens, or sentinel secrets.
	- `packages/claude-agent-adapter/src/claude-agent-adapter.spec.ts` covers process-environment async-generator auth failures and no-leak logging.
- **Dependencies:** Story 3 / Task 3.1.
#### Task 3.4: Classify OpenAI agent adapter SDK auth failures safely

- **Description:** Update the OpenAI agent adapter failure paths that can bypass the shared connection classifier so OpenAI Agents SDK authentication failures become classified provider failures without logging raw SDK diagnostics.
- **Acceptance criteria:**
	- `packages/openai-agent-adapter/src/openai-agent-adapter.ts` classifies SDK startup, sandbox-client/session, and run-session failures from safe structural properties such as `status`, `statusCode`, allowlisted `code`, `errorName`, or known OpenAI auth error class identity.
	- Auth failures throw or emit `ClassifiedProviderFailureError` with `provider_auth_failed`; the adapter must not return a public terminal reason such as `OpenAI agent session failed.` for provider-auth failures.
	- Existing safe logging behavior is preserved: logs may include safe metadata but not `err.message`, response bodies, request bodies, paths, tokens, header values, or sentinel secrets.
	- `packages/openai-agent-adapter/src/openai-agent-adapter.spec.ts` covers OpenAI Agents SDK auth failures across startup/sandbox and run-session paths plus no-leak logging.
- **Dependencies:** Story 3 / Task 3.1.
#### Task 3.5: Convert classified execution errors into fail results

- **Description:** Update execution run-unit-of-work handling so classified provider failures become fail `RunWorkResult` reasons and existing allowlisted runner terminal fail reasons remain intact while unknown strings are safely replaced.
- **Acceptance criteria:**
	- `packages/core/src/execution-run-unit-of-work.ts` catches typed classified provider failures before the generic fallback and returns a fail result containing the canonical `provider_auth_failed` value for provider-auth failures.
	- Unknown thrown provider or SDK errors still use existing safe generic reasons and never copy raw messages.
	- `packages/core/src/runner-event-consumer.ts` continues preserving allowlisted terminal fail `reason` values, including `schema_validation_failed` and exact safe execution phrases, replaces unknown strings safely, and does not accept `question` as the fail detail.
	- `packages/core/src/execution-run-unit-of-work.spec.ts` covers classified provider-auth fail results, generic safe fallback, preservation of allowlisted runner terminal fail reasons, replacement of unknown reason strings, and sentinel secret no-leak behavior.
	- `packages/core/src/runner-event-consumer.spec.ts`, `packages/api-contract/src/runner-events.spec.ts`, and `packages/api-contract/src/step-results.spec.ts` retain or extend coverage that fail terminal results use `reason`, not `question`.
- **Dependencies:** Story 2 / Task 2.2, Story 3 / Task 3.2, Story 3 / Task 3.3, and Story 3 / Task 3.4.
### Story 4: HTTP and SSE surfaces prove operators see the same safe reason

Opal can read a failed run through `GET /v1/runs/:id` or watch `/v1/runs/:id/events` and see the same sanitized reason without route-specific failure logic.
#### Task 4.1: Add focused GET and SSE route regression tests

- **Description:** Add route-level coverage proving the updated shared schemas and repository mapping reach the existing run read and event stream routes.
- **Acceptance criteria:**
	- `packages/core/src/routes.spec.ts` asserts `GET /v1/runs/:id` serializes `failureReason` for a failed persisted run.
	- The same route test asserts `/v1/runs/:id/events` writes a `run_state_transition` SSE `data` frame containing matching `transition.reason` and embedded `run.failureReason`.
	- The route-level test may use a pre-classified or pre-persisted failed run for focused HTTP serialization coverage.
	- The route implementation does not add a second failure-reason source or route-specific classifier.
- **Dependencies:** Story 1 / Task 1.3 and Story 2 / Task 2.3.
#### Task 4.2: Add the production-path forced-failure acceptance test

- **Description:** Add the end-to-end test that drives create -\> auto-dispatch -\> execution/provider-auth classification -\> failed run through production code and asserts both operator-facing surfaces.
- **Acceptance criteria:**
	- `apps/control-plane/src/run-failure-reason.integration.spec.ts` starts the control-plane API/test server and required dependencies.
	- The test configures a production-path provider-auth failure seam, not a fake unit-of-work fail result and not a pre-persisted failed run.
	- The test creates a run through the normal API/control-plane path and waits for auto-dispatch to fail through the real execution adapter or connection classifier.
	- `GET /v1/runs/:id` returns the sanitized `failureReason` value `provider_auth_failed`.
	- `/v1/runs/:id/events` emits a fail `run_state_transition` SSE data frame with `transition.reason` and embedded `run.failureReason` both set to `provider_auth_failed`.
	- Sentinel secrets placed in simulated provider configuration or error detail do not appear in serialized API JSON, SSE JSON, observable persisted JSON, or ordinary logs.
- **Dependencies:** Story 3 / Task 3.5 and Story 4 / Task 4.1.
#### Task 4.3: Add no-leak regression coverage across serialized outputs

- **Description:** Add or extend tests so unsafe provider diagnostics cannot appear in public failure reason surfaces or ordinary logs.
- **Acceptance criteria:**
	- Tests include sentinel values for tokens, header values, request bodies, response bodies, absolute paths, secret handles, and raw SDK messages.
	- Serialized run JSON, transition event JSON, SSE frame JSON, and ordinary logs do not contain the sentinel values.
	- Tests assert the public reason remains a stable safe code or exact safe compatibility phrase.
	- The coverage complements provider/adapter unit tests and does not depend only on redaction helpers.
- **Dependencies:** Story 3 / Task 3.1 through Story 4 / Task 4.2.
### Story 5: Implementation handoff stays navigable and validated

The next implementation agent can find the changed modules, run focused checks, and understand unsupported provider behavior without rediscovering the failure-reason flow.
#### Task 5.1: Update agent navigation documentation

- **Description:** Document the failure-reason threading in the agent code map after implementation changes land.
- **Acceptance criteria:**
	- `context-agent/wiki/code-map.md` records the API contract fields, persistence column and migration, core lifecycle/orchestrator/event flow, execution classifier, Claude adapter behavior, GET/SSE route coverage, and no-leak tests.
	- The documentation notes that unknown or unsupported provider errors fall back to safe generic reasons rather than exposing raw diagnostics.
	- No human-facing requirements, design, tech spec, or Converged API sections are changed during implementation without explicit approval.
- **Dependencies:** Stories 1 through 4.
#### Task 5.2: Run targeted package validation

- **Description:** Run focused tests for each package touched by the feature before broader validation.
- **Acceptance criteria:**
	- API contract tests pass for run, run events, runner events, and step results.
	- Persistence migration and domain repository tests pass.
	- Core lifecycle, orchestrator, run-events, runner-event-consumer, and execution-run-unit-of-work tests pass.
	- Execution classifier and connection tests pass.
	- Claude adapter tests pass.
	- Core route tests and control-plane run-failure-reason integration tests pass or any environment-specific skip is documented with the exact reason.
- **Dependencies:** Story 1 / Task 1.1 through Story 4 / Task 4.3.
#### Task 5.3: Run broad workspace validation

- **Description:** Run the repository's broad validation command after targeted tests are green or documented.
- **Acceptance criteria:**
	- The implementation runs the existing broad workspace validation command from project scripts or Nx conventions.
	- Any failure is investigated enough to identify whether it is caused by this feature, an environment issue, or a pre-existing unrelated problem.
	- The final handoff lists the targeted and broad validation commands with pass/fail/skip status.
- **Dependencies:** Story 5 / Task 5.2.
### Reviewer pass

The task list now uses the repository's accepted Story/Task hierarchical numbering while preserving the story grouping. The dependency graph shows the intended implementation order by task number and title: contracts and persistence first, core threading next, provider classification before HTTP/SSE acceptance, and documentation/validation last. Route-level tests are scoped to the existing `packages/core/src/routes.spec.ts` Fastify route tests, while the production-path forced-failure acceptance test is scoped to `apps/control-plane/src/run-failure-reason.integration.spec.ts`; no new `packages/api` package is required.