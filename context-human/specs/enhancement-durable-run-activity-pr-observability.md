---
created: 2026-06-22
last_updated: 2026-06-22
status: complete
issue: 95
specced_by: autocatalyst
---
# Enhancement: Durable run activity and pull-request observability

## Product requirements

### What

Autocatalyst should make a completed run diagnosable through durable API reads and safe server logs. A client should be able to read the pull request attached to a run, inspect the durable step and session activity that happened during execution, and rely on server-side logs when an endpoint returns a 5xx error.
This enhancement also keeps sparse `pr.finalize` output safe. If the model returns an empty tolerated pull-request finalization result, Autocatalyst must still build a useful pull-request title and body from the actual change rather than falling back to mechanical file-list-only content.
### Parent feature

This enhances several completed slices rather than adding standalone product behavior:
- `feature-review-open-merge-pull-request.md` and `enhancement-build-pr-title-body-from-actual-change.md`, which created the pull-request lifecycle, PR persistence, merge reconciliation, and deterministic PR content fallbacks.
- `feature-runner-event-consumer-step-results.md`, which expanded live SSE run events and durable `RunStep.checkpointResult` storage.
- `feature-runner-boundary-execution-context-stub-runner.md`, `feature-runner-event-consumer-step-results.md`, and the runner adapter features, which established typed execution events and session metadata.
- `context-human/concepts/observability.md` and ADR-030, which require durable session-grain run records plus retention-bounded diagnostic streams.
### Current behavior

The repository already has many of the pieces but they are not connected into a complete diagnosis surface.
`PullRequestRepository.findByRun(runId)` exists and `pr.open` persists a `PullRequest` row, but the public API exposes only `POST /v1/pull-requests/reconcile`. There is no `GET /v1/runs/:id/pull-request` route and no SDK method for reading the PR attached to a run.
`GET /v1/runs/:id/events` streams typed run events and can replay retained events from `InMemoryRetainedRunEventStore`. That store is process memory. It helps active-run reconnects but cannot provide durable history after restart or after the retention window. Durable `RunStep` rows exist and can store checkpoint JSON, but execution sessions are not written to the `sessions` table during normal runner dispatch. A completed run can therefore have little useful durable history beyond its final step rows.
The `Session` contract and persistence repository exist with useful fields such as `step`, `role`, `round`, model identity, token counts, turn counts, tool counts, outcome, and cost. The execution runner also reports similar metadata, but no production path currently creates session rows from runner session metadata.
The control-plane server creates Fastify with `logger: false` and its generic error handler returns a safe 500 envelope without logging the caught exception. That protects the client response, but it leaves operators without a server-side stack or sanitized diagnostic when a route fails.
The PR title/body fallback has already been improved to use actual changed paths and summaries, but issue 95 keeps it in scope because end-to-end validation still found cases where `pr.finalize` could produce weak mechanical content when its tolerated result was empty. This enhancement should preserve the existing fallback hierarchy and add regression proof around the completed-run path.
### Proposed behavior

Add a typed pull-request read surface under a run:
- `GET /v1/runs/:id/pull-request` returns the run's persisted `PullRequest` row when one exists.
- The endpoint is tenant-scoped and policy-protected like other run child resources, using a dotted policy action on a noun-like resource descriptor rather than treating the action string as the resource kind.
- The SDK exposes `getRunPullRequest(id)` using schemas from `packages/api-contract`.
Make completed runs queryable through durable activity records:
- Every dispatched model or runner session creates a durable `Session` row, including failed and needs-input outcomes when a session starts and reaches a terminal execution result or classified failure.
- Existing `GET /v1/runs/:id/steps` remains the durable step timeline endpoint.
- Add a typed read endpoint for durable sessions, preferably `GET /v1/runs/:id/sessions`, so clients can query step/role/round-level execution history after completion.
- Run state transitions remain visible through `RunStep` rows and live SSE while active. The durable contract is not per-turn transcript replay; it is step and session history.
Improve server-side diagnostics without leaking details to clients:
- Fastify and route error handling should log 5xx failures with redacted, structured fields and stack information when available.
- Client responses keep the safe existing error envelope and do not include stack traces, secrets, raw provider responses, prompts, tokens, absolute workspace paths, or raw command output.
- Known service errors that intentionally map to 4xx should not be logged as server faults.
Keep PR fallback content useful:
- If `pr.finalize` returns `{}` or otherwise omits `titleSubject` and `reconciledSummary`, PR content still comes from the cumulative implementation summary and final changed paths.
- A PR fallback title/body may list changed files, but the title and main summary must not be only a mechanical file list when there is a better deterministic subject available.
- Regression coverage should prove a completed run with empty tolerated `pr.finalize` output still has a useful pull-request record, durable activity history, and safe diagnostics if any route fails.
### Why

A completed Autocatalyst run is the core artifact the product asks people to trust. If the run ends but the API cannot answer which PR it opened, which steps and sessions happened, or why a 500 occurred, operators and future agents must infer behavior from ephemeral logs or local debugging.
ADR-030 already sets the product expectation: durable database records answer what a run did and what it cost, while ephemeral logs answer why recent behavior failed. Issue 95 closes the gap between that architecture and the current implementation. It also gives clients one normal API path for post-run diagnosis instead of relying on a live SSE stream that is intentionally not permanent.
### Goals

- Expose the persisted pull request for a run through a typed API endpoint and SDK method.
- Persist durable session-grain activity for each executed model or runner session.
- Provide a typed durable session read endpoint scoped by run and tenant.
- Preserve `RunStep` as the durable state-transition timeline and keep SSE as the live/reconnect stream, not the permanent per-turn archive.
- Emit redacted server-side logs for every unexpected 5xx error while keeping client error responses safe.
- Prove that sparse `pr.finalize` output still results in useful PR title/body content based on actual changes.
- Keep provider-specific details behind existing runner, code-host, and request-alteration seams.
### Non-goals

- Durable per-turn assistant transcript storage.
- Long-term replay of all SSE frames after process restart.
- A new UI for run activity or pull-request viewing.
- Changing the `PullRequest` entity state machine or merge reconciliation behavior.
- Changing provider adapters to expose raw prompt, response, request, or credential details.
- Building a full OpenTelemetry backend, traces, dashboards, or cross-run analytics in this slice.
- Replacing the existing safe client error envelope with detailed errors.
### Personas

- **Opal, operator:** needs enough durable run history and server logs to diagnose a completed or failed run without having watched it live.
- **Enzo, engineer/client developer:** needs typed API and SDK surfaces for pull requests, steps, sessions, and safe error behavior.
- **Riley, code reviewer:** needs the PR opened by Autocatalyst to describe the actual change, even when final model summary output is sparse.
- **Ari, future agent:** needs queryable run history through stable API reads rather than ephemeral console output or hidden process memory.
### User stories

- As Opal, I can call `GET /v1/runs/:id/pull-request` after `pr.open` and see the PR provider, number, URL, state, and branch.
- As Opal, I can inspect a completed run's steps and sessions after the SSE retention window has expired.
- As Opal, I can correlate a 500 response with a redacted server-side log entry that includes the route, request id, status code, error name, and stack when safe.
- As Enzo, I can consume pull-request and session reads through the SDK without duplicating path strings or schemas.
- As Riley, I can review an Autocatalyst PR whose title and body summarize the actual change when `pr.finalize` returned an empty tolerated result.
- As Ari, I can query durable activity records to decide whether a run failed in spec authoring, implementation review, docs, or PR handling.
### Acceptance criteria

#### Pull-request read surface

- `packages/api-contract` defines a route constant, response schema, success status, and TypeScript type for `GET /v1/runs/:id/pull-request`.
- `GET /v1/runs/:id/pull-request` returns the persisted `PullRequest` row for the run.
- A run with no persisted pull request returns 404 with the standard error envelope.
- A missing run or cross-tenant run returns 404 for this child resource.
- The route uses the authenticated principal and policy resource pattern used by other run child routes.
- `packages/sdk/src/client.ts` exposes `getRunPullRequest(id)` and validates the response with the shared schema.
- OpenAPI generation includes the endpoint.
#### Durable run activity

- Each dispatched model or runner session writes one durable `Session` row at `(runId, step, role, round)` grain.
- Session rows include model identity, inference settings, start/end time, duration, token breakdown when available, assistant/tool counts when available, outcome, and cost fields that satisfy the existing `sessionSchema`.
- Failed sessions and sessions that return `needs_input` are persisted with safe outcomes and without raw provider diagnostics.
- Session writes are associated with the current `RunStep`/step context and do not create rows for human gates or deterministic system-only steps unless a real model/direct session ran.
- A completed run remains queryable through durable `RunStep` and `Session` reads after process restart and after in-memory retained SSE events are gone.
- If session metadata is incomplete, the row records `usageAvailable: false`, zero token counts, zero cost, and safe counts rather than dropping the session.
- Optional metadata incompleteness is the only best-effort case. `SessionRepository.create` infrastructure failures are not silently ignored: success and `needs_input` paths fail the dispatch/run with a sanitized persistence failure, while pre-existing failure, cancellation, and timeout terminal outcomes keep their original sanitized terminal reason and log the session-persistence failure safely.
#### Durable session API

- `packages/api-contract` defines `GET /v1/runs/:id/sessions` or an equivalent run-child session read route.
- The response returns sessions ordered deterministically by run-local execution order when available, otherwise by `(startedAt, id)` as a compatibility fallback.
- The route is tenant-scoped and returns 404 for missing or cross-tenant runs.
- The SDK exposes a typed list method.
- The API does not expose raw runner events, transcripts, prompts, scratch paths, credentials, or provider response bodies.
#### State transitions and retained SSE

- `GET /v1/runs/:id/steps` remains the durable state-transition timeline.
- `RunStep.checkpointResult` continues to store validated step output where existing workflows need it.
- The retained SSE store remains a live/reconnect aid unless a separate durable event store is explicitly added. The implementation must not imply that in-memory SSE replay is durable after restart.
- Integration coverage demonstrates the expected degradation: after retained SSE is unavailable, clients can still read steps, sessions, and the pull-request record.
#### Server-side 5xx logging

- Unexpected route failures that produce a 5xx response emit a server-side log entry.
- The log entry includes safe fields such as request id, method, route or URL pattern, status code, error name, sanitized error code when present, and stack trace when available.
- Logs redact or omit authorization headers, bearer tokens, secret handles, provider request/response bodies, prompt text, model output, raw `gh` stderr/stdout, absolute workspace paths, and environment variables.
- Expected 4xx service errors such as validation, not found, forbidden, conflict, and unsupported pause are not logged as 5xx failures.
- The client response for 5xx remains a safe generic error envelope.
- Tests verify that a thrown unexpected error is logged and that known secret sentinels do not appear in logs or responses.
#### Pull-request fallback content

- A run whose `pr.finalize` result normalizes from `{}` to clean advance opens or has opened a PR with a useful conventional-commit title.
- The title subject prefers `titleSubject`, `reconciledSummary`, cumulative implementation summary, and changed-path-derived subject before the generic fallback.
- The PR body includes actual repository-relative changed paths when available.
- The PR title and main summary do not contain only count placeholders such as `N file(s) changed` or round-pass placeholders such as `Round N: implementation passed review`.
- Existing blocker/revise behavior for `pr.finalize` is unchanged.
### Non-functional requirements

- **Security:** New reads and logs must not expose secrets, credentials, raw provider text, prompt content, absolute workspace paths, raw subprocess output, or authorization headers.
- **Compatibility:** The API evolves additively under `/v1`; existing routes and response fields remain valid.
- **Durability:** Step and session records live in SQLite through the existing repository abstraction and survive process restarts.
- **Provider neutrality:** Core consumes provider-neutral runner/session metadata. Provider-specific adapters may supply metadata, but core must tolerate missing optional fields.
- **Determinism:** Activity reads have stable ordering. PR fallback content is stable for the same run state and branch diff.
- **Observability split:** Durable API reads answer what happened; redacted logs answer why a recent server fault happened. Per-turn transcripts remain out of durable storage.
### Impact on existing behavior

Clients get new run-child read endpoints and SDK methods. Existing run, step, feedback, spec, event, and reconciliation endpoints keep their behavior. Operators gain server-side diagnostics for 5xx responses. Completed runs become easier to inspect through durable step, session, and pull-request records.
The implementation may add fields to session ordering or repository internals if needed, but it should avoid breaking the current `Session` schema unless a new optional field is additive. PR fallback text may become more specific and less mechanical in sparse-final-review cases.
### Product devil's advocate pass

- **Durable session rows are not enough to explain every model decision.** That is intentional. ADR-030 keeps per-turn detail out of the durable database. Session rows identify what ran, when, with which model, at what cost, and with what outcome; logs and live SSE carry recent diagnostic detail.
- **Logging stacks can leak data if handled casually.** The logging seam must sanitize structured fields and avoid copying raw request bodies, provider messages, command output, and paths. Tests should include leak sentinels.
- **A PR read endpoint could reveal cross-tenant existence.** Treat it as a run child resource and return 404 for missing and inaccessible runs.
- **Session persistence can fail after a runner has already failed.** Optional metadata gaps are best-effort and still create a degraded row; `SessionRepository.create` infrastructure errors are not metadata gaps. If the model/direct session was otherwise successful or produced `needs_input`, the dispatch should fail with a sanitized persistence failure because the required durable activity record is missing. If the session already failed, cancelled, or timed out, the original sanitized terminal reason remains the run-facing reason and the persistence error is logged safely.
- **File-path-derived PR titles can still be mechanical.** They are acceptable only after better summary sources are absent, and they must be actual changed paths rather than count placeholders.
### Product reviewer pass

This is correctly scoped as an observability and diagnosis enhancement. It does not try to make SSE a permanent event archive or log raw transcripts. The most important implementation constraint is to connect existing contracts and repositories into production dispatch rather than inventing a parallel history store.
### References

- [Issue 95](https://github.com/markdstafford/autocatalyst/issues/95) — source request and acceptance criteria.
- `context-human/concepts/observability.md` — durable session-grain records and telemetry split.
- `context-human/concepts/api.md` — run child resources, SSE, and additive `/v1` API evolution.
- `context-human/concepts/trackers.md` — pull-request record and code-host boundary.
- `context-human/concepts/run.md` — step, session, role, and durable run lifecycle concepts.
- `context-human/specs/feature-runner-event-consumer-step-results.md` — live event stream and `RunStep` checkpoint context.
- `context-human/specs/enhancement-build-pr-title-body-from-actual-change.md` — PR fallback behavior.
- `packages/core/src/domain-repositories.ts` — `PullRequestRepository`, `RunStepRepository`, and `SessionRepository` interfaces.
- `packages/persistence/src/domain-repositories.ts` — Drizzle repositories for pull requests, run steps, and sessions.
- `packages/core/src/run-events.ts` — retained in-memory run event store.
- `apps/control-plane/src/server.ts` — Fastify composition and current logger setting.
## Design spec

### Design scope

This is a backend API, persistence, and observability design. It adds no screens, visual components, or design-system tokens. The visible behavior is that API and SDK clients can inspect completed run activity and pull-request state, and operators can find safe server logs for unexpected 5xx responses.
### Run diagnosis experience

A useful completed-run diagnosis flow should look like this:
1. A client calls `GET /v1/runs/:id` to see the final run state and current step.
2. The client calls `GET /v1/runs/:id/steps` to see the durable step timeline and checkpoint summaries.
3. The client calls `GET /v1/runs/:id/sessions` to see each model or runner session by step, role, and round.
4. The client calls `GET /v1/runs/:id/pull-request` to see the opened PR, provider, URL, state, and branch.
5. If live event replay is unavailable, the client uses the durable reads above instead of expecting the SSE stream to reconstruct every turn.
6. If an endpoint returns a 500, the operator finds a server log with safe route and stack context while the client sees only a generic error envelope.
### Pull-request read flow

1. The client requests the run child resource `GET /v1/runs/:id/pull-request`.
2. The route authenticates and authorizes the principal.
3. The service loads the run and enforces tenant scoping.
4. The service calls `pullRequests.findByRun(runId)`.
5. If found, the response returns `{ pullRequest }` or an equivalent contract-owned wrapper containing the shared `PullRequest` entity.
6. If the run is missing, inaccessible, or has no PR, the response is 404.
The route should not call the code-host provider. It reads the local persisted PR row only. Provider state refresh remains owned by merge reconciliation.
### Durable session flow

A model-backed execution should produce one durable session record per actual model/direct session:
1. The orchestrator dispatches a run step and resolves the current phase, step, role, and round.
2. The runner or direct-call path starts and records a start timestamp.
3. As execution completes, the adapter or execution boundary exposes safe session metadata: model identity, inference settings, token usage if available, assistant/tool counts if available, and terminal outcome.
4. Core maps that metadata into `CreateSessionInput` and writes it through `SessionRepository.create`.
5. The run transition and `RunStep` checkpoint continue through existing lifecycle paths.
6. Later, `GET /v1/runs/:id/sessions` lists those rows after tenant validation.
The design should not require every provider to supply token usage. Missing usage is represented with `usageAvailable: false`, zero token counts, and zero cost. The row should still tell the operator that a session ran, which step and role it belonged to, and whether it succeeded, failed, timed out, or was cancelled.
### Retained SSE and durable history behavior

The SSE stream remains the best experience while a run is active. `Last-Event-ID` and retained replay are still bounded by the in-memory retention store. This enhancement should be explicit that retained SSE replay is not the permanent completed-run record.
For completed or restarted runs, durable reads provide the fallback:
- `GET /v1/runs/:id` shows the run's terminal state and safe failure reason when applicable.
- `GET /v1/runs/:id/steps` shows state transitions and persisted step checkpoints.
- `GET /v1/runs/:id/sessions` shows the model/direct sessions that ran.
- `GET /v1/runs/:id/pull-request` shows the PR attached to the run.
This split matches the observability concept: durable records show what happened; live/telemetry streams show richer recent activity.
### Server logging behavior

Unexpected server errors should be logged once at the route/error-handler boundary. The log should be useful for operators and safe to retain:
- Include request id, method, route pattern when available, response status, error name, sanitized error code, and stack.
- Exclude request bodies by default. If a future log includes body metadata, it should include only size or schema name, not content.
- Redact headers that may carry credentials, especially `authorization`, cookies, provider tokens, and custom provider auth headers.
- Avoid raw exception messages from provider SDKs, `gh`, git, filesystem operations, and model output unless they have already been classified as safe.
Known `ControlPlaneServiceError` cases that map to 4xx are normal API outcomes and should not be logged as internal faults. Internal service errors mapped to 500 should be logged with sanitized cause information.
### PR fallback content behavior

The existing PR content flow remains the right user experience. The design invariant is that sparse final review improves or accepts deterministic content; it does not degrade the PR to placeholder text.
The fallback order is:
1. `pr.finalize.titleSubject` when present.
2. A useful subject from `pr.finalize.reconciledSummary` when present.
3. A useful subject from cumulative implementation summary when present.
4. A changed-path-derived subject from actual repository-relative paths.
5. `complete approved implementation` only when no richer source exists.
The body should include the reconciled or cumulative summary when available and a `Changed files` section with actual paths. If only paths are available, a bounded sentence may summarize them, but the title and summary should not be count-only placeholders.
### Component interactions

- **API contract:** owns new path constants and schemas for run pull-request and run session reads.
- **Control-plane service:** enforces tenant checks, calls repositories, maps not-found behavior, and returns contract-owned results.
- **Routes:** parse params, require principal, authorize policy resources, call service methods, and serialize responses.
- **SDK:** exposes typed convenience methods that validate responses.
- **Execution/run unit of work:** maps runner/direct metadata to durable `Session` rows.
- **Persistence:** stores and lists sessions through the existing Drizzle repository.
- **Error handling/logging:** captures unexpected 5xx errors at a shared boundary and emits redacted logs.
- **PR content modules:** preserve deterministic fallback behavior and gain regression coverage for empty `pr.finalize` output.
### Design reviewer pass

The design keeps the durable surface intentionally coarse-grained. It avoids storing transcripts while still answering the diagnosis questions that issue 95 raises. The main risk is trying to couple session persistence too tightly to every adapter. Core should define a safe session metadata input and tolerate absent optional provider data.
## Tech spec

### Overview

This enhancement extends the existing contract-first `/v1` API, core service, SDK, and execution wiring. It should reuse the already-defined `PullRequest`, `RunStep`, and `Session` schemas. It should not add a separate observability database or make SSE replay durable. The durable database remains SQLite through the repository abstraction.
### Current state

Relevant current implementation points:
- `packages/api-contract/src/pull-request.ts` defines `pullRequestSchema` and create input schemas, but no run-child read route.
- `packages/core/src/domain-repositories.ts` includes `PullRequestRepository.findByRun(runId)`.
- `packages/persistence/src/domain-repositories.ts` implements `DrizzlePullRequestRepository.findByRun`.
- `packages/sdk/src/client.ts` exposes `reconcilePullRequests()` but no pull-request read method.
- `packages/api-contract/src/session.ts` and `packages/persistence/src/domain-repositories.ts` define and persist `Session` rows.
- Production code does not currently call `sessions.create` outside tests.
- `packages/core/src/run-events.ts` implements `InMemoryRetainedRunEventStore`, a bounded in-memory retained SSE store.
- `packages/core/src/routes.ts` already supports `GET /v1/runs/:id/events`, `?replay=retained`, and cursor 409 errors before stream bytes.
- `apps/control-plane/src/server.ts` creates Fastify with `logger: false`.
- `packages/core/src/routes.ts` has an app-level `setErrorHandler` that returns a generic 500 but does not log the error.
- `packages/core/src/pr-content.ts`, `packages/core/src/conventional-title.ts`, `packages/core/src/implementation-summary.ts`, and `packages/core/src/pr-open-handler.ts` own PR fallback content.
### Architecture

#### Pull-request read endpoint

Add a new API contract module or extend `pull-request.ts`:
```typescript
export const runPullRequestPath = '/v1/runs/:id/pull-request' as const;
export const getRunPullRequestSuccessStatusCode = 200 as const;
export const runPullRequestResponseSchema = z.object({
  pullRequest: pullRequestSchema
}).strict();
export type RunPullRequestResponse = z.infer;
```
Export the new symbols from `packages/api-contract/src/index.ts` and add OpenAPI coverage in `packages/api-contract/src/openapi.ts`.
Add a `ControlPlaneService.getRunPullRequest(input)` method. It should:
1. Load the run by id.
2. Return `ControlPlaneServiceError('not_found')` when the run is missing or `run.tenant !== input.tenant`.
3. Call `pullRequests.findByRun(runId)`.
4. Return `not_found` if no PR exists.
5. Return `{ pullRequest }` parsed by the contract schema.
Extend the policy model with both a new action and a new noun-like resource descriptor kind:
- `PolicyAction`: `'run_pull_request.read'`
- `PolicyResourceDescriptor`: `{ kind: 'run_pull_request'; id: string; path: '/v1/runs/:id/pull-request' }`
Register the route in `packages/core/src/routes.ts` by authorizing action `run_pull_request.read` against resource `{ kind: 'run_pull_request', id: runId, path: '/v1/runs/:id/pull-request' }`. Add SDK method `getRunPullRequest(id)` in `packages/sdk/src/client.ts`.
#### Durable session read endpoint

Add route-level contract symbols for `GET /v1/runs/:id/sessions`:
```typescript
export const runSessionsPath = '/v1/runs/:id/sessions' as const;
export const listRunSessionsSuccessStatusCode = 200 as const;
export const runSessionListResponseSchema = z.object({
  sessions: z.array(sessionSchema)
}).strict();
export type RunSessionListResponse = z.infer;
```
This can live in `session.ts` or a new `run-sessions.ts` module. Export it from the API contract and OpenAPI generator.
Extend the policy model with both a new action and a new noun-like resource descriptor kind:
- `PolicyAction`: `'run_sessions.list'`
- `PolicyResourceDescriptor`: `{ kind: 'run_sessions'; id: string; path: '/v1/runs/:id/sessions' }`
Add `sessions: SessionRepository` to `DefaultControlPlaneService` dependencies if it is not already present. Add `listRunSessions(input)`:
1. Load and tenant-check the run.
2. Call `sessions.listByRun(runId)`.
3. Return sessions in repository order.
4. Parse response with `runSessionListResponseSchema`.
Register `GET /v1/runs/:id/sessions` in routes and add `listRunSessions(id)` to the SDK.
Ordering should eventually use a run-local session sequence per ADR-030. If adding a sequence column is too large for this slice, keep the current `(startedAt, id)` order and document it as a compatibility fallback. Do not sort by wall-clock alone.
#### Session persistence from execution

Add a core-owned session recording seam close to `ExecutionRunUnitOfWork` or `DefaultOrchestrator`, not inside provider adapters. The seam should accept safe metadata from the execution boundary and context from the run dispatch:
```typescript
interface RecordExecutionSessionInput {
  readonly runId: string;
  readonly phase: string | null;
  readonly step: string;
  readonly role: SessionRole;
  readonly round: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: SessionOutcome;
  readonly model: ModelIdentity;
  readonly inferenceSettings: InferenceSettings;
  readonly tokens?: TokenBreakdown;
  readonly assistantTurnCount?: number;
  readonly toolCallCount?: number;
}
```
Map missing token data to:
- `usageAvailable: false`
- the current token schema's zero-equivalent shape
- zero nano-dollar cost
Map terminal results to outcomes:
- `advance` -\> `succeeded`
- `needs_input` -\> `succeeded` unless the execution boundary already classifies it differently
- sanitized execution failure -\> `failed`
- cancellation -\> `cancelled`
- timeout classification -\> `timeout`
Runner metadata sources already exist in the execution layer. `packages/execution/src/agent-orchestrator-runner.ts` counts assistant turns and tool calls and exposes metadata. The core bridge should capture that metadata after session completion and call `SessionRepository.create`. Provider adapters should not write database rows.
For reviewed convergence steps, each implementer/reviewer round should produce its own session row with the correct role and round. For direct calls, use role `none` or the role already resolved for the direct step, matching `sessionRoleSchema`.
#### Session persistence failure semantics

The session recorder must separate optional metadata incompleteness from persistence infrastructure failures:
- Missing optional usage, token, cost, assistant-turn, or tool-count metadata is normalized into a degraded but valid `Session` row with `usageAvailable: false` and zero-equivalent safe fields. This metadata incompleteness does not fail the run.
- Missing required dispatch context (`runId`, `step`, `role`, `round`, model identity, timing, or terminal outcome) is a sanitized configuration/validation error and should be unreachable from production dispatch.
- `SessionRepository.create` throwing or rejecting is a persistence infrastructure failure. The recorder surfaces a sanitized persistence error and logs safe details through the dispatch logging seam; it does not return `null` or mark the write as optional.
- For otherwise successful `advance` sessions, a `SessionRepository.create` infrastructure failure fails the dispatch/run with the existing sanitized persistence-failure handling because the completed run would otherwise lack required durable activity.
- For `needs_input` sessions, a `SessionRepository.create` infrastructure failure also fails the dispatch/run with sanitized persistence-failure handling before exposing the needs-input transition, for the same required-observability reason.
- For sessions whose terminal execution result is already `failed`, `cancelled`, or `timeout`, a `SessionRepository.create` infrastructure failure is logged safely and must not replace the original sanitized terminal reason shown on the run. The existing terminal outcome remains authoritative; tests should assert the log exists and the original failure/cancellation/timeout classification is preserved.
- The recorder should not implement an independent retry loop. If the existing unit-of-work or repository layer already retries persistence failures, the recorder may rely on that policy; otherwise failures are handled as above after the single create attempt.
#### Run activity durability

Do not persist all `ClientRunEvent` frames in this slice unless implementation discovers it is necessary for session recording. The durable activity contract for issue 95 is:
- step transitions: `RunStep` rows;
- validated step outputs: `RunStep.checkpointResult` where currently used;
- model/direct execution attempts: `Session` rows;
- live/recent turn activity: retained SSE and telemetry logs.
If implementation adds a durable run-event table, it must be additive and must not store raw transcripts or provider-private payloads. It should not replace session persistence.
#### Server-side logging for 5xx

Update the control-plane composition and route error boundary:
- Enable or inject a Fastify logger in `apps/control-plane/src/server.ts`, preferably through a `logger` option that defaults to a safe console-compatible or Fastify logger.
- Keep request/response payload logging disabled by default.
- In `packages/core/src/routes.ts` `setErrorHandler`, call `request.log.error` or an injected logger before sending 500.
- Include safe fields only: request id, method, router path if available, status code, error name, sanitized code, and stack.
- Avoid logging `error.message` for provider-shaped errors unless the error type is known to be safe. Prefer `error.name` and typed safe codes.
The generic 500 response should remain:
```json
{ "error": { "code": "internal_error", "message": "An internal server error occurred." } }
```
Known `ControlPlaneServiceError` values handled inside route handlers continue to map to their current behavior. `persistence_failed` maps to a safe 500 and must log sanitized details because it is a server fault from the client's perspective. `unauthorized` remains grouped with access-denial outcomes that map to 403/4xx in the current route handler and must not be logged as a 5xx server fault unless a future explicit change reclassifies it as a 500.
#### PR fallback regression

Keep the implementation centered in existing modules:
- `packages/core/src/implementation-summary.ts`
- `packages/core/src/conventional-title.ts`
- `packages/core/src/pr-content.ts`
- `packages/core/src/pr-open-handler.ts`
Do not add a second PR title builder. Add or strengthen tests that drive an empty `pr.finalize` result through `pr.open` and assert:
- PR title has the correct conventional prefix;
- title subject is not count-only or `Round N` text;
- body includes real repository-relative changed paths;
- persisted PR can be read through the new endpoint.
### Data model

No new table is required for pull-request reads. The existing `pull_requests` table is the source of truth.
No new table is required for sessions. The existing `sessions` table and `SessionRepository` are the source of truth. A future migration may add a run-local `sequence` column for deterministic ordering; if this slice adds it, it must be optional/additive and backfilled or defaulted for existing rows.
No change is required to `run_steps` unless implementation needs to adjust checkpoint persistence for activity tests. `checkpoint_result_json` already exists.
### API shape

#### `GET /v1/runs/:id/pull-request`

Success response:
```json
{
  "pullRequest": {
    "id": "pr_...",
    "runId": "run_...",
    "owner": { "kind": "human", "id": "...", "displayName": "..." },
    "tenant": "tenant_dev",
    "provider": "github",
    "number": 123,
    "url": "https://github.com/owner/repo/pull/123",
    "state": "open",
    "branch": "feat/example",
    "createdAt": "2026-06-22T00:00:00.000Z",
    "updatedAt": "2026-06-22T00:00:00.000Z"
  }
}
```
Errors:
- 404 when run is missing, inaccessible, or has no pull request.
- 403 only if the policy layer rejects the principal before service-level child-resource hiding applies.
- 500 with generic envelope for unexpected server faults.
#### `GET /v1/runs/:id/sessions`

Success response:
```json
{
  "sessions": [
    {
      "id": "sess_...",
      "runId": "run_...",
      "phase": "implementation",
      "step": "implementation.build",
      "role": "implementer",
      "round": 1,
      "model": { "provider": "anthropic", "model": "claude-sonnet-4" },
      "inferenceSettings": {},
      "startedAt": "2026-06-22T00:00:00.000Z",
      "endedAt": "2026-06-22T00:01:00.000Z",
      "durationMs": 60000,
      "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "usageAvailable": false,
      "assistantTurnCount": 0,
      "toolCallCount": 0,
      "outcome": "succeeded",
      "cost": { "currency": "USD", "nanoDollars": 0, "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
    }
  ]
}
```
The exact token/cost field names must match existing `tokenBreakdownSchema` and `costSchema`; the example is illustrative.
### Security and redaction

- New endpoints must use bearer auth and principal tenant scoping.
- Cross-tenant child-resource access returns 404 from service logic.
- Session rows must not contain raw prompts, model messages, provider response bodies, scratch file content, absolute workspace paths, environment variables, or credentials.
- Logs must redact authorization headers, secret-bearing environment variables, provider custom headers, `GH_TOKEN`, secret handles when they are not already safe to display, and known test sentinel values.
- Error logs should prefer typed safe details from existing error classes (`safeDetails`, `code`, classified failure reason) over raw messages.
### Tests

Targeted test coverage should include:
- API contract tests for new path constants, success status codes, and response schemas.
- Core service tests for `getRunPullRequest` and `listRunSessions`, including missing run, cross-tenant run, and no-PR behavior.
- Route or control-plane integration tests for `GET /v1/runs/:id/pull-request` and `GET /v1/runs/:id/sessions` over HTTP with bearer auth.
- SDK tests for `getRunPullRequest` and `listRunSessions` URL, status, and response validation.
- Execution/core tests that a stub or fake runner session creates a durable `Session` row for success, needs-input, and sanitized failure paths.
- Convergence tests that implementer and reviewer rounds produce distinct role/round session rows where the dispatch path has enough metadata.
- Logging tests that force an unexpected route failure, assert a 500 response, assert a log entry exists, and assert secret sentinels are absent from logs and response.
- PR lifecycle integration coverage where empty tolerated `pr.finalize` output still creates readable PR content and the new PR read endpoint returns the persisted record.
- Regression tests that retained SSE being unavailable does not remove the ability to read steps, sessions, and PR state.
### Implementation notes

- Prefer adding service methods to `DefaultControlPlaneService` rather than letting routes access repositories directly.
- Keep all route schemas in `packages/api-contract`; do not duplicate response shapes in route code.
- Use existing `ControlPlaneServiceError('not_found')` for child-resource hiding.
- Keep code-host provider reads out of `GET /v1/runs/:id/pull-request`; reconciliation owns remote refresh.
- Keep session persistence in core/execution orchestration, not adapters or persistence tests.
- Update `context-agent/wiki/code-map.md` during implementation if modules, route surfaces, or execution wiring change significantly.
### Open questions and risks

- **Session ordering:** ADR-030 calls for a per-run session sequence. The current schema orders by `(startedAt, id)`. Implementation should decide whether to add sequence now or document the fallback and sequence later.
- **Direct-call sessions:** The direct-call path is not a streaming runner. It still needs session metadata at the bounded-call boundary.
- **Partial metadata:** Some adapters may not return usage. Persist rows with `usageAvailable: false` rather than skipping them.
- **Log transport:** The spec requires server-side logs, not a full OTLP integration. A future observability slice can route the same structured logs to OTLP.
- **Provider behavior:** Providers that cannot supply token usage, enforce tool policy, or report detailed turn counts remain supported only with degraded session metadata. They must not leak raw provider diagnostics.
### Tech reviewer pass

The design aligns with ADR-005 through ADR-007 by adding typed REST routes and SDK methods. It aligns with ADR-030 by making `RunStep` and `Session` the durable history rather than trying to persist all runner turns. The main implementation risk is finding the right seam for session metadata so reviewed convergence rounds, ordinary agent steps, and direct calls all record rows without provider-specific database access.
## Converged API

### Files

Path
Purpose
Exports

`packages/api-contract/src/pull-request.ts`
Add the contract-owned run-child pull-request read route path, success status, strict response schema, and inferred response type while reusing the existing strict PullRequest entity schema.
`runPullRequestPath`, `getRunPullRequestSuccessStatusCode`, `runPullRequestResponseSchema`, `RunPullRequestResponse`

`packages/api-contract/src/session.ts`
Add the contract-owned run-child durable session list route path, success status, strict response schema, and inferred response type while reusing the existing strict Session entity schema.
`runSessionsPath`, `listRunSessionsSuccessStatusCode`, `runSessionListResponseSchema`, `RunSessionListResponse`

`packages/api-contract/src/index.ts`
Re-export the new pull-request and session route contract symbols through the package barrel.
`runPullRequestPath`, `getRunPullRequestSuccessStatusCode`, `runPullRequestResponseSchema`, `RunPullRequestResponse`, `runSessionsPath`, `listRunSessionsSuccessStatusCode`, `runSessionListResponseSchema`, `RunSessionListResponse`

`packages/api-contract/src/openapi.ts`
Include GET /v1/runs/\{id\}/pull-request and GET /v1/runs/\{id\}/sessions in generated OpenAPI using the shared strict schemas and standard error envelope.
`generateOpenApiDocument`

`packages/core/src/control-plane-service.ts`
Add service-layer run-child methods that enforce tenant scoping, child-resource hiding, schema parsing, and repository access for persisted pull requests and sessions. Policy authorization remains owned by the authenticated route layer using the concrete run-child resource descriptors.
`ControlPlaneService`, `DefaultControlPlaneService`, `ServiceGetRunPullRequestInput`, `ServiceGetRunPullRequestResult`, `ServiceListRunSessionsInput`, `ServiceListRunSessionsResult`

`packages/core/src/policy.ts`
Extend the closed policy unions with dotted actions and noun-like resource descriptor kinds for the two new run-child reads.
`PolicyAction`, `PolicyResourceDescriptor`

`packages/core/src/routes.ts`
Register the new authenticated run-child GET routes by authorizing action `run_pull_request.read` on resource kind `run_pull_request` and action `run_sessions.list` on resource kind `run_sessions`, export safe log field typing for tests, and log sanitized structured details for every route-produced 5xx including `persistence_failed` service errors handled before Fastify's shared error boundary. `unauthorized` remains a 403/4xx access-denial outcome and is not logged as a 5xx fault.
`registerControlPlaneRoutes`, `ControlPlaneRouteDependencies`, `SafeServerErrorLogFields`, `runPullRequestReadPolicyAction`, `runPullRequestPolicyResourceKind`, `runSessionsListPolicyAction`, `runSessionsPolicyResourceKind`

`packages/core/src/execution-session-recorder.ts`
Provide a core-owned seam for mapping provider-neutral runner/direct-call session metadata into durable SessionRepository.create rows with safe defaults for missing optional usage and count metadata. Optional provider metadata never causes the session row to be dropped, and cost is derived inside the recorder from the resolved token breakdown so cost.tokens and session.tokens stay in sync.
`RecordExecutionSessionInput`, `ExecutionSessionRecorderDependencies`, `recordExecutionSession`

`packages/core/src/execution-run-unit-of-work.ts`
Call recordExecutionSession from the core execution dispatch/unit-of-work boundary after each real model-backed runner or direct-call session reaches a terminal result, including success, needs_input, classified failure, cancellation, and timeout paths, while skipping deterministic human-gate/system-only steps that did not run a model session.
`ExecutionRunUnitOfWork`, `RunWorkInput`, `RealRunnerDispatchOptions`

`packages/execution/src/agent-orchestrator-runner.ts`
Continue exposing provider-neutral session metadata from runner execution, including model identity, inference settings, start/end time, terminal outcome, token usage when available, assistant turn count, and tool call count, for the core recorder bridge to persist without storing raw transcripts or provider payloads.
`runAgentOrchestrator`, `AgentOrchestratorRunResult`

`packages/execution/src/execution-entry-point.ts`
Preserve the direct execution entry-point metadata shape consumed by the core dispatch bridge so direct model calls can also produce durable Session rows at the same run, step, role, and round grain.
`executeAgentStep`

`apps/control-plane/src/reviewed-execution-dispatcher.ts`
Ensure reviewed implementer/reviewer convergence dispatch propagates role, round, step, and safe session metadata to the core session recorder call site so each real implementer and reviewer model session is persisted as a distinct row.
`createReviewedExecutionDispatcher`

`packages/core/src/domain-repositories.ts`
Continue to expose PullRequestRepository.findByRun and SessionRepository.listByRun/create as the repository contracts consumed by the new service reads, deterministic session listing, and session recorder.
`PullRequestRepository`, `SessionRepository`

`packages/persistence/src/domain-repositories.ts`
Use existing Drizzle repositories as the durable SQLite source of truth for pull-request lookup and deterministic session listing ordered by startedAt and id until an optional run-local sequence exists.
`DrizzlePullRequestRepository`, `DrizzleSessionRepository`

`packages/sdk/src/client.ts`
Expose typed SDK convenience methods for reading a run's persisted pull request and durable session activity, validating responses with shared strict API-contract schemas.
`ControlPlaneClient`, `createControlPlaneClient`

`apps/control-plane/src/server.ts`
Allow safe Fastify logging configuration/injection while preserving disabled request/response payload logging and wire the session recorder dependencies into real runner/direct execution dispatch composition.
`ControlPlaneServerOptions`, `createControlPlaneServer`, `startControlPlaneServer`

`packages/core/src/pr-content.ts`
Preserve and regression-protect deterministic PR title/body fallback behavior for empty tolerated pr.finalize output using implementation summaries and changed paths; document the fallback order in JSDoc or tests rather than as a public TypeScript type.
`buildPullRequestContent`

`packages/api-contract/src/run-observability.spec.ts`
Cover the new contract-owned run-child pull-request and session path constants, success status codes, strict response schemas, OpenAPI inclusion, and rejection of unknown top-level response fields.

`packages/core/src/control-plane-service.run-observability.spec.ts`
Cover service-layer getRunPullRequest and listRunSessions behavior for successful reads, missing runs, cross-tenant hiding, no-PR hiding, deterministic session repository order, and persistence_failed mapping.

`packages/core/src/routes.run-observability.spec.ts`
Exercise authenticated HTTP route integration for GET /v1/runs/:id/pull-request and /sessions, policy authorization inputs using actions `run_pull_request.read`/`run_sessions.list` and resource kinds `run_pull_request`/`run_sessions`, standard 404 envelopes, generic 500 envelopes, sanitized 5xx logging for setErrorHandler and handleControlPlaneServiceError `persistence_failed` branches, explicit no-5xx-log behavior for 403/4xx `unauthorized` outcomes, and leak-sentinel assertions proving secrets are absent from logs and responses.

`packages/sdk/src/client.run-observability.spec.ts`
Cover SDK getRunPullRequest and listRunSessions URL construction, bearer-auth behavior, non-2xx ControlPlaneClientError handling, and strict response validation failures for extra fields.

`packages/core/src/execution-session-recorder.spec.ts`
Cover recordExecutionSession persistence for success, needs_input, sanitized failure, cancellation, and timeout outcomes; missing optional metadata defaults; usageAvailable precedence; cost derivation from resolved tokens; and the guarantee that optional provider metadata gaps never return null or skip SessionRepository.create.

`packages/core/src/execution-run-unit-of-work.session-persistence.spec.ts`
Cover core dispatch wiring that creates durable Session rows for real runner/direct-call sessions while skipping deterministic human-gate/system-only steps and preserving run, step, role, round, timing, outcome, and safe metadata.

`apps/control-plane/src/reviewed-execution-dispatcher.session-persistence.spec.ts`
Cover reviewed implementer/reviewer convergence dispatch so each real model session is persisted as a distinct row with the expected role and round.

`apps/control-plane/src/pr-lifecycle.run-observability.integration.spec.ts`
Cover a completed PR lifecycle where empty tolerated pr.finalize output still produces useful persisted PR title/body content, the new pull-request read endpoint returns that record, durable steps and sessions remain readable, and retained SSE unavailability does not remove completed-run diagnosis.

### Public API

#### `runPullRequestPath`

```typescript
export const runPullRequestPath = '/v1/runs/:id/pull-request' as const
```
- Returns: `'/v1/runs/:id/pull-request'`
#### `getRunPullRequestSuccessStatusCode`

```typescript
export const getRunPullRequestSuccessStatusCode = 200 as const
```
- Returns: `200`
#### `runPullRequestResponseSchema`

```typescript
export const runPullRequestResponseSchema = z.object({ pullRequest: pullRequestSchema }).strict()
```
- Returns: `Strict Zod schema parsing RunPullRequestResponse and rejecting unknown top-level response fields`
- Errors:
	- `ZodError when the response does not contain exactly a pullRequest matching pullRequestSchema`
	- `ZodError when unknown top-level response fields are present`
#### `runSessionsPath`

```typescript
export const runSessionsPath = '/v1/runs/:id/sessions' as const
```
- Returns: `'/v1/runs/:id/sessions'`
#### `listRunSessionsSuccessStatusCode`

```typescript
export const listRunSessionsSuccessStatusCode = 200 as const
```
- Returns: `200`
#### `runSessionListResponseSchema`

```typescript
export const runSessionListResponseSchema = z.object({ sessions: z.array(sessionSchema) }).strict()
```
- Returns: `Strict Zod schema parsing RunSessionListResponse and rejecting unknown top-level response fields`
- Errors:
	- `ZodError when the response does not contain exactly sessions matching sessionSchema[]`
	- `ZodError when unknown top-level response fields are present`
#### `runPullRequestReadPolicyAction`

```typescript
export const runPullRequestReadPolicyAction = 'run_pull_request.read' as const
```
- Returns: `'run_pull_request.read'`
#### `runPullRequestPolicyResourceKind`

```typescript
export const runPullRequestPolicyResourceKind = 'run_pull_request' as const
```
- Returns: `'run_pull_request'`
#### `runSessionsListPolicyAction`

```typescript
export const runSessionsListPolicyAction = 'run_sessions.list' as const
```
- Returns: `'run_sessions.list'`
#### `runSessionsPolicyResourceKind`

```typescript
export const runSessionsPolicyResourceKind = 'run_sessions' as const
```
- Returns: `'run_sessions'`
#### `ControlPlaneService.getRunPullRequest`

```typescript
getRunPullRequest(input: ServiceGetRunPullRequestInput): Promise
```
- Parameters:
	- `input: ServiceGetRunPullRequestInput` — Authenticated principal, tenant, and run id for the run-child pull-request lookup. The route authorizes this call using policy action `run_pull_request.read` and resource descriptor `{ kind: 'run_pull_request', id: runId, path: '/v1/runs/:id/pull-request' }` before invoking the service.
- Returns: `Promise`
- Errors:
	- `ControlPlaneServiceError('not_found') when the run is missing, cross-tenant, or has no persisted pull request`
	- `ControlPlaneServiceError('forbidden') when service-level policy/guarding denies run pull-request read access`
	- `ControlPlaneServiceError('persistence_failed') when repository access fails`
#### `ControlPlaneService.listRunSessions`

```typescript
listRunSessions(input: ServiceListRunSessionsInput): Promise
```
- Parameters:
	- `input: ServiceListRunSessionsInput` — Authenticated principal, tenant, and run id for listing durable sessions under a run. The route authorizes this call using policy action `run_sessions.list` and resource descriptor `{ kind: 'run_sessions', id: runId, path: '/v1/runs/:id/sessions' }` before invoking the service.
- Returns: `Promise`
- Errors:
	- `ControlPlaneServiceError('not_found') when the run is missing or cross-tenant`
	- `ControlPlaneServiceError('forbidden') when service-level policy/guarding denies run session list access`
	- `ControlPlaneServiceError('persistence_failed') when repository access fails`
#### `registerControlPlaneRoutes`

```typescript
export async function registerControlPlaneRoutes(app: FastifyInstance, dependencies: ControlPlaneRouteDependencies): Promise
```
- Parameters:
	- `app: FastifyInstance` — Fastify application to receive protected /v1 route registrations and the shared error handler.
	- `dependencies: ControlPlaneRouteDependencies` — Route dependencies including auth, policy, safe logging, and ControlPlaneService.
- Returns: `Promise`
- Errors:
	- `Registers GET /v1/runs/:id/pull-request with policy action run_pull_request.read and resource kind run_pull_request, then returns 404 standard envelope for missing, inaccessible, or no-PR runs`
	- `Registers GET /v1/runs/:id/sessions with policy action run_sessions.list and resource kind run_sessions, then returns 404 standard envelope for missing or inaccessible runs`
	- `Unexpected route errors are logged with redacted structured 5xx fields and returned to clients as the generic internal_error envelope`
	- `ControlPlaneServiceError('persistence_failed') branches that are converted to 500 by handleControlPlaneServiceError are also logged with the same sanitized 5xx fields before returning the generic internal_error envelope`
	- `Expected 4xx service errors such as validation, not_found, forbidden, unauthorized, conflict, and unsupported_pause are not logged as server faults`
#### `recordExecutionSession`

```typescript
export async function recordExecutionSession(dependencies: ExecutionSessionRecorderDependencies, input: RecordExecutionSessionInput): Promise
```
- Parameters:
	- `dependencies: ExecutionSessionRecorderDependencies` — Session repository, optional clock/id helpers, and optional safe logger used to persist one durable session row.
	- `input: RecordExecutionSessionInput` — Provider-neutral execution metadata plus run, step, role, round, timing, outcome, model, and optional usage/counts. Required identity/grain fields are supplied by production dispatch context; missing optional provider metadata is normalized to safe zero-equivalent values. Callers do not provide cost; the recorder derives cost from the resolved token breakdown so createSessionInputSchema superRefine invariants are satisfied by construction.
- Returns: `Promise`
- Errors:
	- `Does not return null for incomplete optional provider metadata; missing optional usage/count data is persisted with usageAvailable=false and zero-equivalent token, derived cost, assistant-turn, and tool-call fields`
	- `Throws a sanitized validation/configuration error if required dispatch context such as runId, step, role, round, model, startedAt, or outcome is absent or invalid; production dispatch must make this unreachable by construction`
	- `Surfaces a sanitized persistence failure when SessionRepository.create fails; dispatch treats it as fatal for otherwise successful and needs_input sessions, and logs it without replacing the original terminal reason for already failed, cancelled, or timed-out sessions`
#### `ControlPlaneClient.getRunPullRequest`

```typescript
getRunPullRequest(id: string): Promise
```
- Parameters:
	- `id: string` — Run id to read the locally persisted pull request for.
- Returns: `Promise`
- Errors:
	- `ControlPlaneClientError with status 404 when the run is missing, inaccessible, or has no persisted pull request`
	- `ControlPlaneClientError for any non-2xx standard API error response`
	- `Error when the successful response fails strict runPullRequestResponseSchema validation`
#### `ControlPlaneClient.listRunSessions`

```typescript
listRunSessions(id: string): Promise
```
- Parameters:
	- `id: string` — Run id whose durable sessions should be listed.
- Returns: `Promise`
- Errors:
	- `ControlPlaneClientError with status 404 when the run is missing or inaccessible`
	- `ControlPlaneClientError for any non-2xx standard API error response`
	- `Error when the successful response fails strict runSessionListResponseSchema validation`
#### `createControlPlaneClient`

```typescript
export function createControlPlaneClient(options: ControlPlaneClientOptions): ControlPlaneClient
```
- Parameters:
	- `options: ControlPlaneClientOptions` — Base URL, optional fetch implementation, and optional bearer token for protected route calls.
- Returns: `ControlPlaneClient`
- Errors:
	- `Error when no fetch implementation is available`
	- `Returned client methods throw ControlPlaneClientError for API error envelopes`
#### `generateOpenApiDocument`

```typescript
export function generateOpenApiDocument(): OpenApiDocument
```
- Returns: `OpenApiDocument`
- Errors:
	- `OpenAPI generation should fail fast if registered Zod schemas are invalid or incompatible with the OpenAPI registry`
#### `createControlPlaneServer`

```typescript
export async function createControlPlaneServer(options: ControlPlaneServerOptions): Promise
```
- Parameters:
	- `options: ControlPlaneServerOptions` — Server composition options, additively including an optional safe Fastify logger configuration and existing persistence/auth/provider options.
- Returns: `Promise`
- Errors:
	- `Error when bearerToken or masterSecret is empty`
	- `Persistence or migration errors during SQLite setup`
	- `Provider composition errors according to existing server composition behavior`
#### `buildPullRequestContent`

```typescript
export function buildPullRequestContent(input: BuildPullRequestContentInput): PullRequestContent
```
- Parameters:
	- `input: BuildPullRequestContentInput` — Finalization output, implementation summaries, and changed paths used to derive deterministic PR title and body content.
- Returns: `PullRequestContent`
### Types

#### `RunPullRequestResponse`

```typescript
export type RunPullRequestResponse = z.infer
```
#### `RunSessionListResponse`

```typescript
export type RunSessionListResponse = z.infer
```
#### `ServiceGetRunPullRequestInput`

```typescript
export interface ServiceGetRunPullRequestInput { readonly principal: Principal; readonly tenant: string; readonly runId: string; }
```
#### `ServiceGetRunPullRequestResult`

```typescript
export type ServiceGetRunPullRequestResult = RunPullRequestResponse
```
#### `ServiceListRunSessionsInput`

```typescript
export interface ServiceListRunSessionsInput { readonly principal: Principal; readonly tenant: string; readonly runId: string; }
```
#### `ServiceListRunSessionsResult`

```typescript
export type ServiceListRunSessionsResult = RunSessionListResponse
```
#### `RecordExecutionSessionInput`

```typescript
export interface RecordExecutionSessionInput { readonly runId: string; readonly phase: string | null; readonly step: string; readonly role: SessionRole; readonly round: number; readonly startedAt: string; readonly endedAt: string | null; readonly outcome: SessionOutcome; readonly model: ModelIdentity; readonly inferenceSettings: InferenceSettings; readonly tokens?: TokenBreakdown; readonly usageAvailable?: boolean; readonly assistantTurnCount?: number; readonly toolCallCount?: number; }
```
#### `ExecutionSessionRecorderDependencies`

```typescript
export interface ExecutionSessionRecorderDependencies { readonly sessions: SessionRepository; readonly logger?: { warn(fields: Record, message: string): void; error(fields: Record, message: string): void }; }
```
#### `SafeServerErrorLogFields`

```typescript
export interface SafeServerErrorLogFields { readonly requestId: string; readonly method: string; readonly route: string; readonly statusCode: number; readonly errorName: string; readonly errorCode?: string; readonly stack?: string; }
```
#### `ControlPlaneServerOptions`

```typescript
export interface ControlPlaneServerOptions { readonly databasePath: string; readonly bearerToken: string; readonly masterSecret: string; readonly logger?: FastifyServerOptions['logger']; readonly runConcurrency?: number; readonly workspaceRoots?: WorkspaceRootOptions; readonly policy?: PolicyDecisionPoint; readonly health?: HealthDependencyChecker; readonly extensionRegistry?: ExtensionRegistryCatalog; readonly providerAdapters?: ProviderAdapterMap; readonly onProviderComposition?: (result: ProviderCompositionResult) => void | Promise; readonly unitOfWork?: RunUnitOfWork; readonly onControlPlaneReady?: (service: ControlPlaneService) => void; readonly runEventStoreOptions?: RetainedRunEventStoreOptions; readonly realRunnerDispatch?: RealRunnerDispatchOptions; readonly resolveExecutionMode?: (input: RunWorkInput, context: ExecutionContext) => Promise | ExecutionModeResolution; }
```
### Notes

The enhancement is additive: it introduces two contract-owned run-child read surfaces, SDK methods, service methods, route registrations with concrete policy actions `run_pull_request.read` and `run_sessions.list` applied to noun-like resource descriptor kinds `run_pull_request` and `run_sessions`, a core session-recording seam, production execution dispatch call sites, and safe 5xx logging behavior while reusing existing PullRequest, Session, RunStep, repository, and PR content contracts. runPullRequestResponseSchema and runSessionListResponseSchema are explicitly strict and reject unknown top-level fields. recordExecutionSession returns Promise\, not null: incomplete optional provider metadata is persisted with usageAvailable=false and zero-equivalent token, derived cost, assistant-turn, and tool-call values; callers do not pass cost, because recordExecutionSession derives cost from the resolved session.tokens so cost.tokens and session.tokens cannot diverge; explicit usageAvailable:false wins and zeroes usage, otherwise usageAvailable is true only when tokens are present; only missing required dispatch context is an invalid/unreachable production condition, and persistence infrastructure errors are surfaced/logged separately. `persistence_failed` service errors that map to 500 must log sanitized details because those are server faults even when converted before the Fastify setErrorHandler boundary; `unauthorized` remains a 403/4xx access-denial outcome and is not logged as a server fault; other expected 4xx service errors are also not logged as server faults. SafeServerErrorLogFields is exported from routes.ts for tests rather than treated as an internal-only duck type. The PR fallback order is a behavioral invariant documented in pr-content JSDoc/tests rather than a public type: titleSubject, reconciledSummary-derived subject, cumulative implementation summary-derived subject, changed-path-derived subject, then complete approved implementation. Retained SSE remains explicitly non-durable; completed-run diagnosis should use GET /v1/runs/:id, /steps, /sessions, and /pull-request. Session ordering can initially use the existing persistence fallback order of (startedAt, id); a future optional run-local sequence field may improve determinism without changing these response wrappers. Providers that cannot supply usage or detailed counts are represented with usageAvailable=false and zero-equivalent safe fields, not raw diagnostics. Representative tests are part of the artifact: contract schema/OpenAPI tests, service tests, HTTP route and sanitized 5xx logging tests with secret leak sentinels, SDK tests, recorder and dispatch session-persistence tests for success/needs-input/failure/cancellation/timeout paths, convergence role/round tests, PR lifecycle fallback integration, and retained-SSE-unavailability regression coverage.
## Task list

### Story 1: Contract-owned run observability API surfaces

Enable clients and downstream packages to depend on typed, shared contracts for the new run-child pull-request and session reads.
#### Task 1.1: Add pull-request read contract

**Description:** Extend `packages/api-contract/src/pull-request.ts` with the `GET /v1/runs/:id/pull-request` path constant, success status code, strict response schema, and inferred response type defined in the Converged API.
**Acceptance criteria:**
- `runPullRequestPath`, `getRunPullRequestSuccessStatusCode`, `runPullRequestResponseSchema`, and `RunPullRequestResponse` are exported.
- The response schema wraps the existing `pullRequestSchema` as `{ pullRequest }`.
- The response schema is strict and rejects unknown top-level fields.
- Existing pull-request contract exports remain unchanged.
**Dependencies:** None.
#### Task 1.2: Add durable session list contract

**Description:** Extend `packages/api-contract/src/session.ts` with the `GET /v1/runs/:id/sessions` path constant, success status code, strict response schema, and inferred response type defined in the Converged API.
**Acceptance criteria:**
- `runSessionsPath`, `listRunSessionsSuccessStatusCode`, `runSessionListResponseSchema`, and `RunSessionListResponse` are exported.
- The response schema wraps the existing `sessionSchema` array as `{ sessions }`.
- The response schema is strict and rejects unknown top-level fields.
- Existing session entity schema behavior remains unchanged.
**Dependencies:** None.
#### Task 1.3: Re-export and document new contract surfaces

**Description:** Re-export the new pull-request and session route contract symbols from `packages/api-contract/src/index.ts` and include both routes in generated OpenAPI output.
**Acceptance criteria:**
- Package consumers can import all new contract symbols from `packages/api-contract`.
- OpenAPI output includes `GET /v1/runs/{id}/pull-request`.
- OpenAPI output includes `GET /v1/runs/{id}/sessions`.
- Both OpenAPI routes use shared response schemas and standard error envelopes.
**Dependencies:** Tasks 1.1 and 1.2.
#### Task 1.4: Add contract regression tests

**Description:** Add `packages/api-contract/src/run-observability.spec.ts` to prove path constants, success status codes, strict response validation, and OpenAPI inclusion.
**Acceptance criteria:**
- Tests pass for valid pull-request and session response examples.
- Tests fail validation for unknown top-level response fields.
- Tests assert both route paths and success status codes.
- Tests assert both routes appear in generated OpenAPI.
**Dependencies:** Tasks 1.1, 1.2, and 1.3.
### Story 2: Service and route reads for completed-run diagnosis

Expose the persisted pull-request record and durable session rows through tenant-scoped, policy-protected run-child endpoints.
#### Task 2.1: Add service methods for run pull-request and session reads

**Description:** Extend `packages/core/src/control-plane-service.ts` with `getRunPullRequest` and `listRunSessions`, including the input/result types from the Converged API.
**Acceptance criteria:**
- `getRunPullRequest` loads the run, enforces tenant scoping, calls `PullRequestRepository.findByRun`, and returns `{ pullRequest }`.
- `getRunPullRequest` returns `ControlPlaneServiceError('not_found')` for missing runs, cross-tenant runs, and runs with no persisted PR.
- `listRunSessions` loads the run, enforces tenant scoping, calls `SessionRepository.listByRun`, and returns `{ sessions }`.
- Repository failures map to `ControlPlaneServiceError('persistence_failed')`.
- Responses are parsed with the shared API-contract schemas before return.
**Dependencies:** Tasks 1.1 and 1.2.
#### Task 2.2: Register authenticated run-child routes

**Description:** Register `GET /v1/runs/:id/pull-request` and `GET /v1/runs/:id/sessions` in `packages/core/src/routes.ts` using the agreed policy actions and noun-like resource descriptors.
**Acceptance criteria:**
- Pull-request route authorizes policy action `run_pull_request.read` on resource descriptor `{ kind: 'run_pull_request', id: runId, path: '/v1/runs/:id/pull-request' }`.
- Session route authorizes policy action `run_sessions.list` on resource descriptor `{ kind: 'run_sessions', id: runId, path: '/v1/runs/:id/sessions' }`.
- The closed `PolicyAction` union includes `run_pull_request.read` and `run_sessions.list`.
- The closed `PolicyResourceDescriptor` union includes `{ kind: 'run_pull_request'; id: string; path: '/v1/runs/:id/pull-request' }` and `{ kind: 'run_sessions'; id: string; path: '/v1/runs/:id/sessions' }`.
- Both routes require the authenticated principal and pass tenant/run id to the service.
- Missing, inaccessible, and no-PR cases return the standard 404 error envelope as specified.
- Successful responses use the shared contract schemas and status codes.
**Dependencies:** Tasks 1.3 and 2.1.
#### Task 2.3: Preserve deterministic repository ordering

**Description:** Confirm or update `DrizzleSessionRepository.listByRun` so the durable session endpoint returns sessions in deterministic repository order, using the current `(startedAt, id)` fallback unless a run-local sequence already exists.
**Acceptance criteria:**
- Session listing does not sort by wall-clock timestamp alone.
- Existing rows are returned in stable order for equal or close timestamps.
- No incompatible schema migration is introduced.
- Any ordering comment or test names state that `(startedAt, id)` is the compatibility fallback until a run-local sequence exists.
**Dependencies:** Task 2.1.
#### Task 2.4: Add service and route tests

**Description:** Add service and HTTP route tests for the new completed-run diagnosis reads.
**Acceptance criteria:**
- Service tests cover successful PR read, missing run, cross-tenant hiding, no-PR hiding, successful session listing, deterministic repository order, and persistence failure mapping.
- Route tests cover authenticated HTTP success for both endpoints.
- Route tests cover policy actions, noun-like resource descriptors, and standard 404 envelopes.
- Route tests verify response schemas reject unexpected top-level fields through contract-owned parsing where applicable.
**Dependencies:** Tasks 2.1, 2.2, and 2.3.
### Story 3: SDK access to run observability reads

Let client developers use typed SDK methods instead of hand-built paths for completed-run pull-request and session activity reads.
#### Task 3.1: Add SDK methods

**Description:** Extend `packages/sdk/src/client.ts` with `getRunPullRequest(id)` and `listRunSessions(id)`.
**Acceptance criteria:**
- `getRunPullRequest` calls the contract-owned pull-request path with the run id.
- `listRunSessions` calls the contract-owned session list path with the run id.
- Both methods include bearer auth behavior consistent with existing protected SDK calls.
- Both methods validate successful responses with shared strict schemas.
- Both methods throw existing SDK error types for non-2xx standard error envelopes.
**Dependencies:** Tasks 1.3 and 2.2.
#### Task 3.2: Add SDK tests

**Description:** Add `packages/sdk/src/client.run-observability.spec.ts` for URL construction, auth, response validation, and error handling.
**Acceptance criteria:**
- Tests assert correct URL construction for both new methods.
- Tests assert bearer token headers are sent when configured.
- Tests assert `ControlPlaneClientError` behavior for non-2xx responses.
- Tests assert strict successful response validation fails for extra fields.
**Dependencies:** Task 3.1.
### Story 4: Durable session persistence from real execution

Record one durable `Session` row for each real model-backed runner or direct-call session without storing raw transcripts or provider diagnostics.
#### Task 4.1: Add the core execution session recorder

**Description:** Create `packages/core/src/execution-session-recorder.ts` with `recordExecutionSession`, `RecordExecutionSessionInput`, and `ExecutionSessionRecorderDependencies`.
**Acceptance criteria:**
- The recorder maps provider-neutral metadata to `SessionRepository.create`.
- Missing optional token, usage, assistant-turn, and tool-call metadata produce safe zero-equivalent fields.
- Explicit `usageAvailable: false` wins and zeroes usage.
- Cost is derived from the resolved token breakdown so `cost.tokens` and `session.tokens` stay in sync.
- The recorder returns the created `Session` and never returns `null` because optional metadata is incomplete.
- Required dispatch-context validation failures are sanitized and do not include prompts, provider payloads, workspace paths, credentials, or raw command output.
**Dependencies:** Task 1.2.
#### Task 4.2: Capture and expose safe runner session metadata

**Description:** Ensure `packages/execution/src/agent-orchestrator-runner.ts` and `packages/execution/src/execution-entry-point.ts` preserve provider-neutral session metadata needed by the core recorder.
**Acceptance criteria:**
- Runner results expose model identity, inference settings, start/end time, terminal outcome, token usage when available, assistant turn count, and tool call count.
- Direct execution entry-point results expose compatible metadata for direct model calls.
- Metadata excludes raw transcripts, prompts, provider response bodies, credentials, environment variables, absolute workspace paths, and raw subprocess output.
- Providers that cannot supply usage or counts still return enough metadata for degraded durable session rows.
**Dependencies:** Task 4.1.
#### Task 4.3: Wire session recording into core execution dispatch

**Description:** Update `packages/core/src/execution-run-unit-of-work.ts` so each real runner or direct-call session records a durable session row when it reaches a terminal result.
**Acceptance criteria:**
- Success, `needs_input`, sanitized failure, cancellation, and timeout paths record durable sessions with safe outcomes.
- Deterministic human gates and system-only steps that do not run a model session do not create session rows.
- Run id, phase, step, role, round, model, timing, usage, counts, and outcome flow from dispatch context and execution metadata into the recorder.
- Optional metadata gaps still produce degraded rows; `SessionRepository.create` infrastructure failures fail otherwise successful and `needs_input` dispatches with sanitized persistence-failure handling, while already-failed, cancelled, or timed-out sessions preserve their original sanitized terminal reason and log the persistence failure safely.
- Existing `RunStep` checkpoint behavior and live SSE behavior are preserved.
**Dependencies:** Tasks 4.1 and 4.2.
#### Task 4.4: Propagate convergence role and round metadata

**Description:** Update `apps/control-plane/src/reviewed-execution-dispatcher.ts` so implementer and reviewer convergence sessions persist as distinct durable rows.
**Acceptance criteria:**
- Each real implementer model session records role `implementer` and the correct round.
- Each real reviewer model session records role `reviewer` and the correct round.
- Revisions, blockers, and clean advances preserve the same role/round grain.
- No provider adapter writes database rows directly.
**Dependencies:** Task 4.3.
#### Task 4.5: Add session recorder and dispatch tests

**Description:** Add tests for recorder normalization, core dispatch call sites, and reviewed convergence role/round persistence.
**Acceptance criteria:**
- Recorder tests cover success, `needs_input`, sanitized failure, cancellation, timeout, missing optional metadata, explicit unavailable usage, and cost derivation.
- Recorder/dispatch tests cover `SessionRepository.create` infrastructure failures: success and `needs_input` paths fail with sanitized persistence failure, while failure, cancellation, and timeout paths preserve the original terminal classification and emit a safe log.
- Core dispatch tests prove real runner/direct sessions create rows and deterministic system-only steps do not.
- Convergence tests prove implementer and reviewer rounds produce distinct rows with expected role and round.
- Tests include leak sentinels proving raw provider diagnostics are not persisted.
**Dependencies:** Tasks 4.1, 4.3, and 4.4.
### Story 5: Safe server-side diagnostics for 5xx responses

Log unexpected server faults with useful structured fields while keeping client responses and logs free of secrets and raw provider data.
#### Task 5.1: Add safe server error logging support

**Description:** Update `apps/control-plane/src/server.ts` and `packages/core/src/routes.ts` to enable or inject safe Fastify logging and export `SafeServerErrorLogFields` for tests.
**Acceptance criteria:**
- `ControlPlaneServerOptions` accepts an optional Fastify logger configuration.
- Request and response payload logging remains disabled by default.
- The shared Fastify error handler logs unexpected 5xx failures with request id, method, route, status code, error name, sanitized error code when available, and stack when available.
- Client 5xx responses keep the generic `internal_error` envelope.
- Log field construction avoids request bodies, authorization headers, cookies, provider payloads, prompts, raw model output, raw `gh` output, absolute workspace paths, and environment variables.
**Dependencies:** None.
#### Task 5.2: Log service errors that map to 500

**Description:** Update `handleControlPlaneServiceError` behavior in `packages/core/src/routes.ts` so `persistence_failed` branches that become 500 responses are logged with the same sanitized fields, while `unauthorized` remains the current 403/4xx access-denial outcome.
**Acceptance criteria:**
- `persistence_failed` responses log sanitized 5xx details before returning the generic envelope.
- `unauthorized` responses continue to map to 403/4xx and are not logged as server faults.
- Expected 4xx service errors such as validation, not found, forbidden, unauthorized, conflict, and unsupported pause are not logged as server faults.
- Existing public error envelopes remain compatible.
**Dependencies:** Task 5.1.
#### Task 5.3: Add logging tests with leak sentinels

**Description:** Add route/control-plane tests that force unexpected and service-mapped 5xx failures and verify safe logging.
**Acceptance criteria:**
- Tests assert an unexpected thrown route error returns the generic 500 envelope and emits one sanitized log entry.
- Tests assert `persistence_failed` service faults are logged.
- Tests assert `unauthorized` 403/4xx outcomes are not logged as server faults.
- Tests assert known 4xx service errors are not logged as server faults.
- Tests assert secret sentinels do not appear in logs or responses.
- Tests assert raw request bodies and authorization headers are absent from log output.
**Dependencies:** Tasks 5.1 and 5.2.
### Story 6: PR fallback regression and completed-run integration

Prove sparse `pr.finalize` output still produces useful PR content and remains diagnosable through durable reads after live SSE replay is unavailable.
#### Task 6.1: Strengthen PR fallback documentation and tests

**Description:** Preserve the existing PR content modules and add regression coverage around the agreed fallback order for empty tolerated `pr.finalize` output.
**Acceptance criteria:**
- Tests drive `{}` or equivalent empty tolerated `pr.finalize` output through PR content generation.
- The title keeps a useful conventional-commit prefix and subject.
- The title subject prefers `titleSubject`, then `reconciledSummary`, then cumulative implementation summary, then changed-path-derived subject, then the generic fallback.
- The title and main summary are not count-only placeholders or `Round N` pass placeholders when richer deterministic content exists.
- The body includes actual repository-relative changed paths when available.
- Existing blocker and revise behavior is unchanged.
**Dependencies:** None.
#### Task 6.2: Add completed-run observability integration coverage

**Description:** Add `apps/control-plane/src/pr-lifecycle.run-observability.integration.spec.ts` or equivalent coverage for a completed PR lifecycle with empty tolerated `pr.finalize` output.
**Acceptance criteria:**
- The completed run opens or has opened a persisted PR with useful title/body content.
- `GET /v1/runs/:id/pull-request` returns the persisted PR record.
- `GET /v1/runs/:id/steps` remains readable as the durable step timeline.
- `GET /v1/runs/:id/sessions` returns durable session rows for executed model/direct sessions.
- The test demonstrates retained SSE unavailability does not remove the ability to read steps, sessions, and PR state.
**Dependencies:** Tasks 2.2, 4.3, and 6.1.
#### Task 6.3: Verify end-to-end safe diagnostics behavior

**Description:** Extend integration coverage so a failed diagnosis route or controlled fault can be correlated with sanitized server logs without leaking sensitive content.
**Acceptance criteria:**
- A forced 5xx during completed-run diagnosis emits a safe server log entry.
- The client response remains the generic safe 500 envelope.
- Log output contains route/request context useful for operators.
- Log output and response exclude secret sentinels, prompts, provider payloads, absolute workspace paths, and raw command output.
**Dependencies:** Tasks 5.3 and 6.2.
### Story 7: Documentation, validation, and handoff readiness

Keep agent-facing navigation accurate and verify the additive API, persistence, SDK, logging, and PR fallback behavior before implementation handoff.
#### Task 7.1: Update agent code map for changed surfaces

**Description:** Update `context-agent/wiki/code-map.md` after implementation changes so future agents can find the new contracts, routes, service methods, session recorder, SDK methods, logging seam, and integration tests.
**Acceptance criteria:**
- Code map entries mention the new API-contract surfaces.
- Code map entries mention the new service and route methods.
- Code map entries mention the session recorder and execution dispatch wiring.
- Code map entries mention the SDK methods and relevant tests.
- No human-owned requirements, design, tech spec, or Converged API sections are rewritten as part of this documentation task.
**Dependencies:** Tasks 1.3, 2.2, 3.1, 4.3, and 5.1.
#### Task 7.2: Run targeted package verification

**Description:** Run targeted tests for the packages touched by this enhancement before broader validation.
**Acceptance criteria:**
- API-contract tests pass.
- Core service, route, recorder, and dispatch tests pass.
- SDK tests pass.
- Control-plane reviewed-dispatcher and PR lifecycle integration tests pass or any environment-specific skip is documented.
- Failures are fixed or explicitly called out before handoff.
**Dependencies:** Tasks 1.4, 2.4, 3.2, 4.5, 5.3, and 6.2.
#### Task 7.3: Run broader project validation

**Description:** Run the repository's standard lint, typecheck, and test validation for the affected workspace once targeted checks pass.
**Acceptance criteria:**
- Standard lint command passes or any existing unrelated failure is documented with evidence.
- Standard typecheck command passes or any existing unrelated failure is documented with evidence.
- Standard test command passes or any existing unrelated failure is documented with evidence.
- Validation notes include remaining risks around provider metadata degradation and session ordering fallback.
**Dependencies:** Task 7.2.