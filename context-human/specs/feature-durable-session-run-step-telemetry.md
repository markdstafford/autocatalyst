---
created: 2026-10-20
last_updated: 2026-10-20
status: approved
issue: 89
specced_by: markdstafford
---
# Durable session and run-step telemetry from first run

## Requirements

### What

Every dispatched runner session records durable telemetry while the run executes. When a model session completes or fails, the system writes a `Session` row for that `(step, role, round)` with deterministic per-run ordering, normalized usage, resolved model information, timing, counts, outcome, and an embedded raw-token `Cost`. The run also leaves a complete `RunStep` occurrence timeline, including repeated entries for looping steps, with bounds closed on exit.

### Why

Autocatalyst needs the database to be the source of truth for run history and later cost work. Ephemeral telemetry is useful while a run is live, but it may be absent or expire. Durable session-grain records let agents and operators reconstruct what happened and price sessions later without backfill.

### Goals

- A real dispatched run writes one durable `Session` row for every model go from the first run after the feature ships.
- Each `Session` row carries deterministic ordering through a per-run session sequence, not inferred wall-clock order.
- Token usage is normalized once per adapter into `input`, `output`, `cacheRead`, and `cacheWrite`, with `usageAvailable` distinguishing unknown usage from real zeroes.
- `RunStep` rows represent every step occurrence, including each loop round, and close `endedAt` and `durationMs` on exit.
- Integration tests read `Session` and `RunStep` rows back through `DrizzleSessionRepository.listByRun` and `DrizzleRunStepRepository.listByRun` and assert real production-path telemetry.

### Personas

- **Operator** — watches runs and needs persisted evidence of what happened, even when no OTLP backend is configured. They care about reliable history and safe diagnostics.
- **Cost implementer** — will price session rows later. They need raw token usage, model identity, and inference settings stored consistently.
- **Adapter implementer** — adds or maintains provider cells. They need a shared telemetry shape so new adapters inherit behavior instead of inventing their own records.
- **Debugging agent** — reads database state to understand a previous run. It needs deterministic ordering and complete step/session history.

### Narratives

An operator dispatches a feature run with the normal production path. The run enters `spec.author`, calls a model, pauses for human review, and leaves rows in SQLite before anyone opens a tracing backend. The operator can query the run and see the step occurrence and the exact model session that produced the spec, including duration, model, inference settings, token availability, counts, and outcome.

A cost implementer starts the next cost feature. They do not need to replay old logs or parse provider output. They list sessions for a run and find raw token breakdowns already embedded in `Session.cost.tokens`, with `usd` unset, ready for pricing.

An adapter implementer adds a future provider. They implement provider-specific usage extraction in the adapter contract, then the shared agent or direct orchestrator emits the same session telemetry and the same durable recorder writes it. They do not create a provider-specific persistence path.

### User stories

#### Operators and debugging agents

- As an operator, I want each run to leave durable session rows as it executes, so that run history survives telemetry backend gaps.
- As a debugging agent, I want run sessions and step occurrences ordered deterministically, so that I can reconstruct the timeline without guessing from timestamps.
- As an operator, I want failures to include redacted diagnostics only, so that secrets and raw provider content are not persisted.

#### Cost and telemetry implementers

- As a cost implementer, I want raw token usage stored in `Session.cost.tokens` with `usd` absent, so that later pricing can use the session as the cost unit.
- As an adapter implementer, I want token normalization to happen in each provider adapter but emit through one shared shape, so that all runner cells remain comparable.
- As a test author, I want a real dispatched run test that reads persisted sessions and run steps, so that fixtures cannot mask a broken production path.

### Non-functional requirements

- Durable session recording must not depend on OTLP, logs, metrics, or any external telemetry backend.
- Persisted diagnostics must be redacted and must not include raw secrets, credentials, prompt bodies, response bodies, or unbounded provider errors.
- The session write path should be atomic enough that a completed session is not silently lost after the runner returns metadata. If persistence fails, the failure must be visible through existing safe error handling rather than leaking raw provider data.
- Ordering must be stable across repeated reads. The repository ordering should use the per-run session sequence before timestamp tie-breakers.
- Schema migrations must support fresh databases and existing local databases.

### Out of scope

- Token pricing, rate tables, nano-dollar computation, or setting `cost.usd`.
- Cached aggregate run cost.
- New operational visibility read models beyond existing repository/API reads.
- OTel SDK logging, metrics instruments, trace wiring, or replacing pino.
- Durable per-turn or per-tool database rows.
- Backfilling sessions for runs that already happened.

## Design spec

This feature is backend-only and has no UI design changes. The user-visible behavior is the database and repository readback: a run leaves a complete durable activity record. Any interim display that reads these rows is outside this feature unless a separate read-surface issue pulls it forward.

The design follows the two-store observability model in `context-human/concepts/observability.md`: the database stores durable facts, while telemetry backends remain optional diagnostics. It also follows `context-human/concepts/agent-runners.md` and `context-agent/standards/telemetry-conventions.md`: runner telemetry is uniform, emitted as work happens, tagged with run context, and normalized at the adapter boundary.

## Technical specification

### Overview

This feature adds the missing production write path between runner completion metadata and durable `Session` rows, and completes deterministic ordering with a per-run session sequence. Per ADR-030, durable telemetry is written session-grain from the first run. Per ADR-015, the `Session` is the cost unit, but this feature stores only raw tokens and leaves pricing unset. The implementation changes the shared session contract, the SQLite table and migration, adapter usage normalization, shared runner telemetry, execution/core recording, and production-path tests.

### Architecture

#### Components

- `packages/api-contract/src/session.ts` adds the per-run `sequence` field to `sessionSchema` and `createSessionInputSchema`.
- `packages/persistence/src/schema.ts` and a new Drizzle migration add `sessions.sequence` with a per-run ordering strategy.
- `packages/persistence/src/domain-repositories.ts` updates `DrizzleSessionRepository` so `create` stores the sequence and `listByRun` returns deterministic order.
- Provider adapters (`claude-agent-adapter`, `openai-agent-adapter`, `anthropic-direct-adapter`, `openai-direct-adapter`) expose normalized token usage with `usageAvailable`.
- Shared execution orchestrators (`agent-orchestrator-runner`, `direct-orchestrator`, dispatch wiring) emit or return a uniform session telemetry shape.
- `packages/core/src/execution-session-recorder.ts` or its successor maps finished execution metadata to `Session` rows through `DrizzleSessionRepository`.
- `packages/core/src/execution-run-unit-of-work.ts` and reviewed dispatch wiring ensure production-dispatched agent and direct sessions reach the recorder.
- `context-agent/wiki/code-map.md` documents the session-recording path and sequence field.

#### Boundaries

Provider-specific token extraction stays inside adapters. The shared connection layer and mode orchestrators own the uniform telemetry shape and counts. Core owns translating completed execution metadata into domain `Session` creation. Persistence owns schema, sequence storage, repository ordering, and migrations. No runner writes directly to Drizzle.

#### Data flow

1. Dispatch resolves a profile for a `(run, phase, step, role)` and constructs the runner or direct call.
2. The adapter extracts provider usage from the provider completion object. If unavailable, the request-alteration boundary extraction is used as fallback when present. If neither source exists, usage is marked unavailable.
3. The shared orchestrator measures start/end time, assistant turns, tool calls, outcome, resolved model, inference settings, and redacted failure diagnostics.
4. The execution unit of work receives the finished session metadata and asks the session recorder to create a `Session`.
5. The recorder allocates the next per-run sequence, fills tokens and `cost.tokens` with the same raw breakdown, leaves `cost.usd` unset, and persists through the repository.
6. Run lifecycle transitions continue to write `RunStep` occurrence rows on entry and close bounds on exit. Looping steps create fresh occurrences each round.
7. Repository reads return stable run-step and session timelines.

#### Integration points

- Existing `RunStep` lifecycle methods: `recordRunLifecycleStart` and `recordRunStepTransition`.
- Existing `DrizzleSessionRepository.create`, `findById`, and `listByRun`.
- Existing execution telemetry context in `packages/execution/src/runner-dispatch.ts` and production dispatch in `apps/control-plane/src/server.ts`.
- Existing runner-event consumer and execution unit of work, where a finished model session already surfaces.

### Data model

#### Session changes

Add a required integer `sequence` to `Session` and `CreateSessionInput`. It is scoped to a run and monotonically increases for each persisted session in that run. The sequence is not global and does not replace `round`, `step`, `role`, or step occurrence information.

`Session.tokens` remains the normalized raw token breakdown. `Session.cost.tokens` must equal `Session.tokens`. `Session.cost.usd` remains absent or null according to the existing `Cost` schema. Add or retain an explicit `usageAvailable` field on the durable session shape so unknown provider usage is not confused with all token counts being zero.

#### Database schema

Add `sessions.sequence` as a non-null integer. For SQLite migration compatibility, existing rows can receive sequence values per run based on current row order, but this is only a migration requirement; the feature does not backfill production telemetry for old runs. Add an index that supports list ordering, for example `(run_id, sequence)`, and consider a unique constraint on `(run_id, sequence)` if the repository can allocate safely inside the same transaction.

#### Sequence allocation

The safest initial allocation is inside the persistence transaction that creates a session: compute `coalesce(max(sequence), 0) + 1` for the run and insert with that value. Current per-run execution is serial enough for this to be practical. If later execution allows concurrent sessions for the same run, the unique constraint should surface conflicts and the repository can retry.

#### RunStep changes

No new `RunStep` fields are required. This feature verifies that each step entry creates a fresh occurrence and each exit closes `endedAt` and `durationMs`, including loops. If current transition code misses loop occurrences or duration closure, fix it in the lifecycle repository path rather than deriving rows after the run.

### API contracts and interfaces

No new public route is required for the feature. Existing repository reads are the acceptance surface, and any existing `GET /v1/runs/:id/sessions` contract must include the new session sequence once `sessionSchema` changes.

Internal interfaces need these changes:

- The provider adapter result metadata includes normalized tokens and `usageAvailable`.
- The shared orchestrator session telemetry includes run context, resolved model, inference settings, start/end timestamps or duration, assistant-turn count, tool-call count, outcome, and redacted diagnostics.
- The session recorder input mirrors that telemetry and adds the domain fields needed by `CreateSessionInput`.
- `DrizzleSessionRepository.listByRun` orders by sequence, with stable fallback ordering only for defensive compatibility.

### Implementation plan

Start with the contract and migration so downstream code has a stable shape. Then update persistence mapping and repository ordering, including sequence allocation tests. Next, define the shared execution session telemetry type and connect the agent and direct orchestrators to produce it from existing metadata. After that, update each adapter to return normalized usage with explicit availability and fallback behavior. Then wire the core session recorder into the production execution unit of work, ensuring direct and reviewed paths are covered. Finally, add real production-path integration tests and update the agent code map.

The riskiest step is deciding exactly where the finished session metadata crosses from execution to core. Prefer using the existing execution unit-of-work seam instead of adding a new event consumer path. The second risk is provider SDK usage differences; handle these with provider-specific unit tests and one shared normalization contract.

### Testing strategy

#### Unit tests

- `api-contract` tests assert `Session` and `CreateSessionInput` require and parse `sequence`, preserve `usageAvailable`, and enforce `cost.tokens === tokens`.
- Persistence tests assert migration success, session sequence allocation, deterministic `listByRun` order, and any uniqueness constraint behavior.
- Adapter tests cover token normalization for Claude agent, OpenAI agent, Anthropic direct, and OpenAI direct, including authoritative provider usage, fallback usage, real zeroes, and unavailable usage.
- Execution tests cover assistant/tool counts, duration, outcome, resolved model and inference settings, and redacted failure diagnostics in the shared telemetry shape.
- Recorder tests assert `cost.tokens === tokens`, `usd` unset, sequence set, and safe failure behavior.

#### Integration and end-to-end tests

Add a real dispatched-run test through the production control-plane dispatch path. It must not inject session rows or use a mock session emitter. After the run reaches a pause or terminal boundary, read sessions through `DrizzleSessionRepository.listByRun` and run steps through `DrizzleRunStepRepository.listByRun`. Assert model, inference settings, token breakdown, `usageAvailable`, duration, outcome, assistant/tool counts, sequence ordering, and run-step bounds.

Add or extend a convergence smoke path so a multi-round implementer/reviewer step leaves multiple session rows ordered by sequence. Live cross-provider proofs may remain behind existing live-provider environment gates, but per-provider normalization must be unit-tested without live credentials.

#### Manual checks

Run a local real dispatch with no OTLP backend configured and inspect SQLite rows. Confirm session rows are present, `usd` is unset, diagnostics are redacted, and `RunStep` rows close on transition.

### Operational concerns

- **Observability:** This feature creates the durable observability floor. It may also emit logs or metrics through existing paths, but database writes must not depend on them.
- **Failure modes:** Provider usage may be missing. In that case, persist zero-equivalent token fields with `usageAvailable=false`, not a pretend known zero. Persistence errors must surface safely and must not leak raw provider data.
- **Security and privacy:** Persist only counts, model identifiers, inference settings, outcomes, and redacted diagnostics. Do not persist prompt or response content as telemetry diagnostics.
- **Performance:** Session insertion is one small row per model go. `listByRun` should use a run-scoped ordering index.
- **Rollout:** No feature flag is required. The migration and write path ship together, and records begin with the first run after deployment.

### Open questions

- Should `(run_id, sequence)` be enforced unique immediately, or should the first implementation rely on transactional allocation plus an index and add uniqueness after concurrency assumptions settle? Decide during implementation after checking current SQLite transaction behavior.
- Does the existing `Session` schema already have a durable `usageAvailable` field, or must it be added with this issue alongside `sequence`? Decide by inspecting `packages/api-contract/src/session.ts` and `domain-value-objects.ts`.
- Which existing integration test is closest to the real dispatched-run proof: `apps/control-plane/src/integration.spec.ts`, `runner-cells.integration.spec.ts`, or a new focused spec? Decide during implementation based on fixture reuse and runtime cost.

### Devil's advocate pass

The main risk is splitting responsibility incorrectly. If adapters emit provider-specific telemetry and core tries to normalize later, the system will drift across runner cells. Keep provider extraction in adapters and the durable shape in shared execution/core code.

A second risk is making session persistence best-effort and swallowing failures. That would satisfy happy-path tests while violating the durable-source-of-truth goal. The implementation should use sanitized errors and targeted recovery, but a completed session should not disappear silently.

A simpler alternative is to derive sessions from runner events after the run finishes. That conflicts with the requirement to write as work happens and would make failures, partial runs, and absent telemetry harder to account for. The spec rejects that alternative.

### Reviewer pass

This spec covers each acceptance criterion from issue #89: sequence schema and migration, uniform telemetry, adapter-normalized tokens with availability, durable session writes, run-step timeline closure, no OTLP dependency, real production-path testing, provider-cell coverage, and code-map update. The scope explicitly excludes pricing, aggregate cost, OTel work, new read models, and backfill. The design depends on existing execution and persistence seams rather than adding a parallel telemetry persistence channel.

## Task list

### Story 1: Extend the session contract and persistence model

Add deterministic per-run session ordering to the shared contract and SQLite persistence layer. This story is the foundation for all later recording work.

#### T-001: Add session sequence to API contract

**Description:** Update `packages/api-contract/src/session.ts` and related tests so `Session` and `CreateSessionInput` include a required per-run integer `sequence`. Confirm the schema still enforces token and cost consistency and carries usage availability.

**Acceptance criteria:**

- `sessionSchema` parses and returns `sequence`.
- `createSessionInputSchema` requires `sequence` or clearly delegates allocation to repository input if the existing repository owns generated fields.
- Contract tests cover valid sequence values and reject invalid values.
- Tests cover `cost.tokens === tokens` and `usageAvailable` semantics.

**Dependencies:** none.

#### T-002: Add sessions.sequence migration and schema mapping

**Description:** Update `packages/persistence/src/schema.ts`, row mappers, and Drizzle migration files to add `sessions.sequence`. Include an index or uniqueness constraint to support deterministic run-scoped ordering.

**Acceptance criteria:**

- Fresh database migration creates `sessions.sequence` as non-null.
- Existing database migration assigns safe sequence values to existing rows.
- Persistence schema and mappers read and write `sequence`.
- Migration tests pass for fresh and migrated databases.

**Dependencies:** T-001.

#### T-003: Allocate and order session sequences in DrizzleSessionRepository

**Description:** Update `DrizzleSessionRepository.create` and `listByRun` so sessions get a monotonically increasing per-run sequence and reads order by that sequence. Keep allocation transaction-scoped and test repeated inserts.

**Acceptance criteria:**

- Creating multiple sessions for one run assigns `1, 2, 3...` or the agreed first value consistently.
- Creating sessions for different runs uses independent sequences.
- `listByRun` returns sessions ordered by sequence.
- Tests cover deterministic ordering when timestamps tie.

**Dependencies:** T-002.

### Story 2: Define and emit uniform session telemetry

Create one shared telemetry shape for agent and direct runner cells, with provider-specific token extraction confined to adapters.

#### T-004: Define shared session telemetry types

**Description:** Add or refine execution/core types for completed session telemetry: run context, phase, step, role, round, model, inference settings, duration, counts, outcome, token breakdown, usage availability, and redacted diagnostics.

**Acceptance criteria:**

- Agent and direct paths can represent the same telemetry fields.
- Direct calls can represent `role: none` and nullable phase where appropriate.
- Failure diagnostics are typed as redacted/safe strings or structured safe metadata.
- Type tests or unit tests cover success and failure shapes.

**Dependencies:** T-001.

#### T-005: Normalize token usage in all four adapters

**Description:** Update Claude agent, OpenAI agent, Anthropic direct, and OpenAI direct adapters so each returns normalized token usage and `usageAvailable`. Use provider completion usage as authoritative and request-alteration extraction only as fallback.

**Acceptance criteria:**

- Each adapter maps provider fields to `input`, `output`, `cacheRead`, and `cacheWrite`.
- Each adapter distinguishes real zero usage from unavailable usage.
- Fallback extraction is used only when authoritative usage is missing.
- Unit tests cover all four adapters and both available/unavailable usage.

**Dependencies:** T-004.

#### T-006: Emit telemetry from shared agent and direct orchestrators

**Description:** Wire the shared agent orchestrator and direct orchestrator to produce the uniform session telemetry as sessions start, complete, or fail. Count assistant turns and tool calls as the runner stream is consumed.

**Acceptance criteria:**

- Agent sessions report started/completed/failed outcome, duration, counts, model, inference settings, context tags, tokens, and usage availability.
- Direct calls report the same durable fields where applicable.
- Failure paths include redacted diagnostics and no raw provider messages or secrets.
- Unit tests cover success, failure before terminal result, and missing usage.

**Dependencies:** T-004, T-005.

### Story 3: Persist sessions through the production execution path

Connect completed telemetry to durable `Session` rows without introducing a mock-only write path.

#### T-007: Map execution telemetry to durable Session rows

**Description:** Update `packages/core/src/execution-session-recorder.ts` or equivalent code to convert finished session telemetry into `CreateSessionInput`. Ensure tokens are copied into `cost.tokens` and `cost.usd` remains unset.

**Acceptance criteria:**

- Recorder creates one `Session` row per completed or failed model go.
- `Session.cost.tokens` exactly equals `Session.tokens`.
- `usd` is absent/null according to the schema and no pricing is performed.
- Recorder tests cover successful, failed, unavailable-usage, and redacted-diagnostic cases.

**Dependencies:** T-003, T-006.

#### T-008: Wire the recorder into real agent, direct, and reviewed execution paths

**Description:** Ensure `execution-run-unit-of-work`, production dispatch, direct calls, and reviewed convergence dispatch pass telemetry to the recorder with the correct run, step, role, and round. Avoid fixture-only or injected-session behavior.

**Acceptance criteria:**

- Production agent dispatch records sessions when `sessions` repository dependencies are available.
- Direct orchestrator calls record sessions through the same recorder shape.
- Implementer/reviewer convergence rounds record separate sessions with correct roles and rounds.
- Existing deterministic non-model/system steps do not create fake session rows.

**Dependencies:** T-007.

### Story 4: Complete and verify RunStep occurrence timelines

Ensure the step timeline is complete alongside sessions and remains durable as the run executes.

#### T-009: Verify and fix RunStep transition closure semantics

**Description:** Inspect `recordRunLifecycleStart` and `recordRunStepTransition` to confirm each step entry writes a new occurrence and each exit closes `endedAt` and `durationMs`. Fix gaps, especially repeated entries for looped steps.

**Acceptance criteria:**

- A fresh occurrence is written for each step entry, including repeated entries for the same step in later rounds.
- The previous occurrence closes with `endedAt` and `durationMs` on transition.
- Repository tests cover looping step scenarios and duration closure.
- No post-hoc backfill is needed to complete the timeline.

**Dependencies:** none.

### Story 5: Prove production-path behavior

Add tests that demonstrate the feature through real dispatch and per-provider normalization without depending on live services for CI.

#### T-010: Add real dispatched-run persistence integration test

**Description:** Drive a run through the production control-plane dispatch path with test adapters that exercise the real orchestration and recorder path. Read rows through `DrizzleSessionRepository.listByRun` and `DrizzleRunStepRepository.listByRun`.

**Acceptance criteria:**

- The test does not inject session rows and does not use a mock durable session emitter.
- The test asserts persisted model, inference settings, normalized token breakdown, `usageAvailable`, duration, outcome, assistant/tool counts, and sequence ordering.
- The test asserts run-step occurrence bounds and duration.
- A converging multi-round scenario leaves multiple ordered sessions.

**Dependencies:** T-008, T-009.

#### T-011: Add per-provider normalization coverage and live-gated smoke hooks

**Description:** Ensure all four adapters have deterministic unit coverage for token normalization and add or update live-provider smoke tests behind existing environment gates where useful.

**Acceptance criteria:**

- Claude agent, OpenAI agent, Anthropic direct, and OpenAI direct normalization tests pass without live credentials.
- Live smoke tests remain skipped unless existing provider-specific environment variables are set.
- A new adapter can follow the same contract without a new persistence path.

**Dependencies:** T-005, T-006.

### Story 6: Update agent documentation

Record the durable session path for future agents.

#### T-012: Update code map for session recording and sequence

**Description:** Update `context-agent/wiki/code-map.md` with the session sequence field, adapter normalization path, shared telemetry emission, recorder, and production integration tests.

**Acceptance criteria:**

- Code map mentions where `sequence` lives in contract and persistence.
- Code map identifies the execution/core recorder path from runner telemetry to `Session` rows.
- Code map names the relevant tests and any live-gated provider proofs.

**Dependencies:** T-010, T-011.

### Dependency graph

Critical path: T-001 → T-002 → T-003 → T-004 → T-005 → T-006 → T-007 → T-008 → T-010 → T-012.

Parallel work: T-009 can run alongside contract and telemetry work. T-011 can begin after T-005 and finish alongside T-010. T-012 waits for the final implemented paths and test names.
