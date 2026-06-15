---
created: 2026-06-15
last_updated: 2026-06-15
status: implementing
issue: 59
specced_by: autocatalyst
---
# Feature: Producing-step implementer/reviewer convergence loop

## Product requirements

### What

Autocatalyst runs a bounded in-step convergence loop for any producing step that carries both an `implementer` role and a `reviewer` role. In one round, the implementer writes work, the host commits the changed workspace state to the run branch, and a separate reviewer session reads the committed branch and working tree through read-only tools. The reviewer raises findings with severities, and the implementer disposes of blocking findings in later rounds until no blocking finding remains or the loop escalates to a person.
The first real implementation target is `implementation.build`, where a run should execute a real code-writing implementer and a real read-only critic over actual git state. The same generic engine also applies to `spec.author` because that step already carries both roles. Steps without a reviewer role continue to dispatch once and advance as they do today.
### Why

The workflow docs and ADR-026 define review as a role inside a producing step, not as a separate workflow step. Today the orchestrator dispatches an AI step once, consumes the terminal result, and advances. That means the existing step catalog can say a step has a reviewer, but the system does not yet run the implementer/reviewer exchange that makes the role meaningful.
This feature turns the review concept into working orchestration. It gives implementation runs a cold independent review pass before a human gate, records reviewer findings as first-class `Feedback`, preserves each round's exchange, and avoids either shipping unconverged work or failing the run when bounded review cannot settle.
### Goals

- Run a generic convergence engine for every AI-producing step whose step catalog roles include `reviewer`.
- Preserve current single-dispatch behavior for AI steps with only an `implementer` role, such as `implementation.plan` and `docs.update`.
- Commit implementer changes through the host-controlled workspace git port before reviewer execution.
- Dispatch the reviewer as a distinct read-only agent session over actual workspace state.
- Resolve implementer and reviewer profiles through `(step, role)` model routing, preferring distinct models or profiles when configured.
- Continue the loop on a single configured model when distinct routing cannot be satisfied, with a sanitized warning that review is not adversarial.
- Let the implementer decide convergence by fixing findings or declining them with recorded reasons.
- Persist every reviewer finding as a first-class `Feedback` item authored by the reviewer's model principal.
- Persist a durable per-round record on the step record so the following human gate can render findings, dispositions, declined findings, and outcomes.
- Escalate to a human pause on max rounds or oscillation instead of failing or silently advancing.
- Prove the first real `implementation.build` path end to end with real dispatch, a real workspace, real git commits, and reviewer findings.
### Non-goals

- Altitude or layered convergence (`layout`, `public_api`, `private_api`, `build`) and build-contract drift checks.
- Parallel reviewers inside one step.
- The complexity classifier that chooses convergence depth.
- Human reply handling that resolves findings or advances/revises after an escalation.
- New branch, worktree, push, merge, or pull request management outside the run workspace lifecycle Autocatalyst already owns.
- A new visual review surface. This slice persists the data needed by later surfaces.
- Letting the reviewer edit files, run state-changing git, or veto the implementer's convergence decision.
### Personas

#### Enzo

- **Role:** Engineer maintaining the orchestrator, runner boundary, and workflow engine.
- **Cares about:** A reusable loop that fits existing step roles, routing, feedback, session, and run-step records.
- **Constraints:** He needs the implementation to keep provider details behind runner adapters and avoid one-off logic for only `implementation.build`.
#### Phoebe

- **Role:** Product or project owner reviewing a run at a human gate.
- **Cares about:** Seeing what the model reviewer found, how the implementer responded, and which findings were declined.
- **Constraints:** She should not need to inspect raw logs or provider output to understand why a run is waiting on her.
#### Opal

- **Role:** Operator watching real runs and failures.
- **Cares about:** Bounded progress, safe escalation, sanitized diagnostics, and no accidental write access for reviewer sessions.
- **Constraints:** She needs stalled reviews to pause for a person instead of spinning forever, failing without context, or advancing with hidden blockers.
### Narratives

#### Enzo watches a build converge

Enzo starts a feature run that reaches `implementation.build`. The implementer session writes code and exits with an `advance` result. Autocatalyst commits the workspace changes on the run branch, then starts a reviewer session resolved through the same model-routing table with role `reviewer`.
The reviewer reads the committed branch and raises one `warning` about an untested edge case. Autocatalyst records the finding as `Feedback`, then starts the next implementer round with that finding in context. The implementer adds the missing test, records that the finding was fixed, and the host commits the change before another reviewer pass.
The second reviewer pass raises no blocking findings. The step records both rounds and advances through the existing workflow transition to `implementation.human_review`.
#### Phoebe reviews a declined finding

Phoebe opens a run at the implementation human gate. She sees the final implementation summary plus the model review exchange. One reviewer finding was declined by the implementer with a reason because the reviewer asked for behavior outside the accepted spec.
The declined finding remains visible as a `Feedback` item and in the per-round record. Phoebe can decide whether the explanation is acceptable at the human gate. The critic did not veto the run, but its concern did not disappear.
#### Opal handles an unconverged loop

Opal forces a test scenario where the reviewer keeps returning the same blocking finding and the implementer does not reduce the blocking count. After the configured max rounds, Autocatalyst stops the loop. The run pauses at `implementation.awaiting_input` with `waitingOn: human` and a summary of open findings plus the last positions from both roles.
The run does not fail, does not keep spending tokens, and does not move to `implementation.human_review` as if review had passed. Opal can see that the pause came from convergence exhaustion or oscillation without raw provider messages or secrets.
### User stories

- As Enzo, I want role-bearing producing steps to run a shared implementer/reviewer loop, so that review behavior follows the step catalog instead of per-step special cases.
- As Enzo, I want implementer changes committed before reviewer execution, so that the reviewer reads the same durable git state a person or later step would inspect.
- As Enzo, I want reviewer sessions to be read-only, so that critique cannot mutate the workspace or branch.
- As Enzo, I want distinct implementer and reviewer profiles resolved through `(step, role)` routing, so that the existing routing table controls adversarial review.
- As Opal, I want the loop to run even when only one model is configured, so that review degrades loudly rather than being skipped.
- As Phoebe, I want every reviewer finding persisted as `Feedback`, so that model findings and human feedback appear in one review model.
- As Phoebe, I want each round's findings and implementer dispositions persisted, so that I can review the exchange rather than only the final answer.
- As Opal, I want max-round and oscillation escalation to pause for a human, so that stalled review does not fail or advance silently.
- As Enzo, I want real end-to-end coverage on `implementation.build`, so that the first real code-writing path proves the production dispatch, workspace, git, routing, feedback, and round-record integration.
### Acceptance criteria

- A convergence engine runs for any producing AI step whose catalog roles include `reviewer`, including `spec.author` and `implementation.build`.
- A step with no reviewer role dispatches once and advances unchanged.
- One round consists of an implementer session followed by a reviewer session.
- After each implementer session, the host commits changed files to the run branch through `WorkspaceGitPort.commitFiles` or the existing workspace-git abstraction; agents do not run state-changing git as part of the commit boundary.
- The reviewer session inspects committed and working-tree state through read-only git and file tooling.
- The reviewer cannot edit files, commit, push, switch branches, or mutate run workspace state.
- Reviewer findings carry severity `blocker`, `warning`, or `info`.
- The implementer disposes of each blocking reviewer finding by fixing it or declining it with a recorded reason.
- The step only advances after a reviewer pass and a convergence-gate evaluation of the current blocking set.
- A fresh `blocker` or `warning` from the latest reviewer pass blocks until a later implementer round fixes it or declines it with a recorded reason; fresh final-pass blocking findings escalate instead of advancing.
- A reviewer `satisfied` result is sufficient for convergence, but not required when all current blocking findings have valid implementer dispositions.
- A reviewer repeat of an already declined finding with the same blocking signature remains non-blocking and visible; materially new blocker or warning findings require a new implementer disposition.
- Finding filtering is build-depth only: `info` never blocks, `blocker` and `warning` block until fixed or declined, and declined findings are recorded but do not block.
- No altitude, category, or depth-layer filtering is added in this slice.
- Distinct proposer and critic profiles resolve through `resolveDistinctAgentRoutes` on `(step, role)` keys.
- When distinct routing cannot be satisfied, the loop runs with a single configured model, logs a sanitized warning that review is not adversarial, and does not skip the reviewer.
- The loop is bounded by max rounds, defaulting to 3 and read from per-step workflow data when available.
- The engine detects oscillation using a repeated blocking-finding signature or a non-decreasing blocking count across rounds.
- On convergence, the run advances through the existing workflow transition: `spec.author` to `spec.human_review`, and `implementation.build` to `implementation.human_review`.
- On max rounds or oscillation, the run pauses on the matching `*.awaiting_input` step with `waitingOn: human`, open findings, and both roles' last positions.
- Max-round or oscillation escalation does not fail the run and does not silently advance it.
- Each reviewer finding is persisted as a first-class `Feedback` item authored by the reviewer's model principal.
- Each round leaves a durable per-round record on the relevant `RunStep`, including findings, feedback ids, implementer dispositions, round outcome, and both session references when available.
- Declined findings remain visible to the following human gate.
- A real end-to-end test drives `implementation.build` through the production dispatch path over a real workspace and git branch, with no mocked rounds, injected findings, or test-only pump.
- The real end-to-end test proves a happy path that converges and advances the run.
- The real end-to-end test proves a forced-stall path that reaches max rounds and pauses `waitingOn: human` with open findings.
- End-to-end coverage asserts distinct proposer and critic routing, persisted `Feedback`, and persisted per-round records.
- A targeted test asserts the single-configured-model case still runs the reviewer and emits the not-adversarial warning.
- `context-agent/wiki/code-map.md` is updated during implementation for new convergence modules, changed dispatch wiring, persistence shape, and tests.
### Non-functional requirements

- **Safety:** Reviewer sessions are read-only at the tool-policy and workspace-git boundaries. Any attempted write or state-changing git action fails safely.
- **Security:** Logs, run events, failures, and warnings do not include raw provider output, prompts, secrets, credential handles, file dumps, or unsanitized shell errors.
- **Consistency:** Commit, finding persistence, disposition persistence, round-record persistence, and run transition ordering must avoid durable states that claim convergence without the supporting records.
- **Compatibility:** Existing workflow step ids, human gates, and transition tables remain stable. Single-role AI steps keep current behavior.
- **Observability:** Sessions, runner events, warnings, and state transitions identify `run`, `step`, `role`, and round where practical.
- **Cost control:** The max-round bound prevents unbounded model spend. The default is 3 unless workflow data specifies otherwise.
### Devil's advocate pass

- **The biggest risk is mixing role orchestration into the existing one-shot unit of work.** The current `RunUnitOfWork.run` returns one directive. The convergence engine should become the owner of repeated role dispatch for eligible steps, while the existing one-shot path remains available for non-reviewed steps.
- **Read-only reviewer enforcement cannot rely on prompt text.** The design must pass a restricted tool policy and workspace-git capability set to the reviewer session. If a provider cannot enforce read-only tools, the adapter must fail the reviewer session or the feature must document the unsupported behavior.
- **The single-model degraded path may be mistaken for true adversarial review.** The warning should be structured and tied to the run and step, and tests should prove the loop still executes.
- **Round records can become too loose if stored as arbitrary JSON.** The tech spec defines a narrow shared schema for round records even if storage remains `checkpointResultJson`.
- **The real end-to-end test may be expensive or environment-sensitive.** It should be opt-in only if it needs live providers, but the required production-path smoke must still avoid mocked round orchestration and injected findings.
### Reviewer pass

This feature aligns with ADR-026 by keeping reviewer behavior inside the producing step and giving convergence authority to the implementer. It aligns with ADR-024 by resolving routes per `(step, role)` and degrading loudly when distinctness cannot be satisfied. It aligns with ADR-018 by making reviewer findings ordinary `Feedback` records, and with ADR-025 by using workflow data for max rounds and existing transitions for advance and `needs_input` pauses.
The design intentionally excludes altitude layering even though the review concept mentions it. Issue 59 asks for build-depth only; adding altitude filtering here would blur the boundary with the next issue and make acceptance harder to prove.
## Design spec

### Design scope

This is a backend workflow and orchestration feature. It adds no screens, components, or visual design. The design covers run-state behavior, role dispatch, workspace-git behavior, feedback creation, round-record persistence, and what a human reviewer should be able to see at the next gate.
### Goals of the design

- Make reviewed producing steps behave consistently from the step catalog roles.
- Make the review exchange visible and auditable without reading raw session logs.
- Keep reviewer authority advisory and implementer authority explicit.
- Keep stalled review bounded and human-resolvable.
- Preserve existing one-shot behavior for steps without reviewers.
### User flows

#### Flow 1: Reviewed implementation build converges

1. A run reaches `implementation.build`.
2. The orchestrator identifies the step as AI-active and role-bearing with `implementer` and `reviewer`.
3. The convergence engine resolves implementer and reviewer routes for `implementation.build`.
4. Round 1 starts an implementer session with write-capable workspace tools.
5. The implementer writes code and returns an advance result.
6. The host commits changed files to the run branch.
7. The reviewer session starts with read-only file and git tools against the committed state.
8. The reviewer returns one or more findings or returns satisfied.
9. The engine persists findings as `Feedback` and records the round.
10. If blocking findings remain, the next implementer round receives those findings.
11. The implementer fixes or declines each blocking finding, and the engine records dispositions.
12. When no blocking finding remains, the engine advances to `implementation.human_review`.
#### Flow 2: Reviewed spec authoring converges

1. A feature or enhancement run reaches `spec.author`.
2. The same convergence engine detects the reviewer role.
3. The implementer produces the spec result through the existing spec-authoring path.
4. The host commits the spec file and records the spec artifact as existing spec-authoring behavior requires.
5. The reviewer reads the committed spec file in read-only mode and returns findings or satisfied.
6. Findings become `Feedback` and round records.
7. On convergence, the run advances to `spec.human_review`; on exhaustion, it pauses at `spec.awaiting_input`.
#### Flow 3: Single-role AI step keeps current behavior

1. A run reaches `implementation.plan` or `docs.update`.
2. The orchestrator sees no reviewer role for the step.
3. The existing single-dispatch unit of work runs once.
4. The resulting directive advances, asks for input, or fails exactly as current behavior allows.
#### Flow 4: Distinct routing is unavailable

1. A reviewed step starts and asks routing for distinct implementer and reviewer profiles.
2. The routing resolver cannot satisfy distinctness, but a single profile is otherwise configured.
3. The engine records a sanitized warning that review is not adversarial.
4. The implementer and reviewer sessions still run as separate sessions, with no shared memory and separate role tags.
5. Round records note that the reviewer profile was not distinct.
#### Flow 5: Review stalls and escalates

1. A reviewed step reaches max rounds or repeats the same blocking-finding signature.
2. The engine persists the final round record and open findings.
3. The engine returns a `needs_input` outcome for the current step.
4. The workflow transition moves the run to `spec.awaiting_input` or `implementation.awaiting_input`.
5. The pause payload includes open findings and both roles' last positions.
6. The run reports `waitingOn: human` and waits for later human-resolution behavior.
### States and interaction behavior

- `spec.author` and `implementation.build` are AI-active producing steps with implementer and reviewer roles.
- `implementation.plan`, `docs.update`, and `question.answer` remain AI-active single-role steps.
- `spec.awaiting_input` and `implementation.awaiting_input` are human pauses for needs-input and convergence escalation. They are not approval gates.
- `spec.human_review` and `implementation.human_review` remain explicit human gates after convergence.
- Reviewer findings use `Feedback.status: open` when first created.
- A finding fixed by the implementer is recorded in the round disposition and may be marked addressed or resolved according to the existing feedback lifecycle rules available at implementation time.
- A finding declined by the implementer is recorded with a required reason and does not block convergence, but remains visible in the per-round record and at the human gate.
- `info` findings are non-blocking from the start, but they are still persisted when returned by the reviewer.
### Components and interactions

- **Convergence engine:** Coordinates rounds for a single run step. It decides whether to use reviewed or one-shot behavior from step roles.
- **Role dispatcher:** Starts implementer and reviewer sessions with the correct role, route, prompt inputs, tool policy, workspace shape, and round context.
- **Workspace git port:** Commits implementer changes after each implementer session and before reviewer execution.
- **Reviewer read-only tool policy:** Restricts reviewer file and git access to inspection operations.
- **Finding parser and filter:** Normalizes reviewer output into findings with severities and applies build-depth blocking rules.
- **Disposition collector:** Captures whether the implementer fixed or declined each finding and the reason for declines.
- **Feedback writer:** Creates model-authored `Feedback` records for each reviewer finding.
- **Round recorder:** Persists a typed round record on the source `RunStep` checkpoint result.
- **Escalation adapter:** Converts max-round and oscillation outcomes into a `needs_input` directive with a safe checkpoint payload.
- **Model-routing integration:** Uses `resolveDistinctAgentRoutes` for reviewed agent steps, and falls back to single-route execution with a warning when required.
### Accessibility and responsive behavior

No UI accessibility or responsive-layout work is included. Future review surfaces should render reviewer findings and implementer dispositions with clear labels, keyboard-accessible navigation, and screen-reader-readable status text.
### Design system updates

None.
### Reviewer pass

The flows keep the human-facing behavior simple: a reviewed step either converges and reaches the normal human gate, or pauses at the phase-specific awaiting-input step with open findings. The design avoids turning reviewer output into an invisible quality signal; every finding has a durable `Feedback` record and every round has a durable exchange record.
## Tech spec

### Overview

Add a reviewed-step execution path around the existing orchestrator dispatch flow. When the current step is AI-active and its catalog definition includes `reviewer`, the orchestrator delegates to a convergence engine instead of directly running one `RunUnitOfWork`. The engine runs bounded implementer/reviewer rounds, writes implementer commits through a host workspace-git port, creates feedback for reviewer findings, persists typed round records into the current run step's checkpoint data, and returns `advance` or `needs_input` to the existing workflow transition layer.
The feature should reuse current packages and boundaries:
- `packages/core/src/run-step-catalog.ts` remains the source for roles.
- `packages/core/src/run-workflows.ts` remains the source for transitions and phase-specific awaiting-input edges.
- `packages/core/src/model-routing-resolver.ts` remains the source for distinct role routing.
- `packages/core/src/feedback-lifecycle.ts` and the feedback repository remain the persistence path for findings.
- `packages/api-contract/src/run-step.ts` remains the public run-step schema, with a typed convergence checkpoint shape stored in `checkpointResult` unless a later implementation chooses an additive explicit field.
- Execution and provider packages remain behind public runner and adapter APIs.
### Architecture

#### Reviewed dispatch decision

`DefaultOrchestrator.dispatch` should branch by step metadata:
1. Load the run and validate tenant, terminal state, and waiting-on behavior as it does today.
2. If `waitingOn` is `system`, run the system-step path.
3. If `waitingOn` is `human`, refuse dispatch as today.
4. If `waitingOn` is `ai` and roles do not include `reviewer`, run the current one-shot `RunUnitOfWork` path unchanged.
5. If `waitingOn` is `ai` and roles include `reviewer`, call the convergence engine.
The convergence engine returns one of the existing `RunWorkResult` directives plus a safe checkpoint result. The orchestrator then uses `applyDirective` so state transitions, events, auto-dispatch scheduling, and failure normalization stay centralized.
#### Convergence engine responsibilities

The engine owns one run step attempt and all rounds inside that attempt:
- Resolve max rounds from workflow step policy, defaulting to 3.
- Resolve implementer and reviewer routes through role-aware routing.
- Run implementer sessions with write-capable execution context.
- Commit implementer changes after each implementer session.
- Run reviewer sessions with read-only execution context.
- Parse reviewer findings and persist them as `Feedback`.
- Pass unresolved findings and previous dispositions into later implementer rounds.
- Persist a round record after each reviewer pass and after each disposition pass.
- Determine convergence from implementer dispositions, not reviewer veto.
- Detect max-round exhaustion and oscillation.
- Return `advance` on convergence or `needs_input` on escalation.
The engine should be generic over `(run, step)` and should not hard-code only `implementation.build`.
#### Per-round state machine and convergence gate

The convergence engine evaluates review state in a fixed sequence so fresh reviewer findings cannot be skipped:
1. **Implementer pass:** round `N` runs the implementer. In round 1 there are no required dispositions. In later rounds, the implementer must return one normalized disposition for each carried-forward blocking finding that does not already have a valid decline.
2. **Disposition validation:** fixed dispositions require a non-empty summary; declined dispositions require a non-empty reason. A valid decline makes that finding non-blocking for the rest of the attempt, including if a later reviewer repeats the same blocking signature. A fixed disposition is treated as the implementer's claim that the issue was addressed, but a later reviewer may still raise a materially new or repeated blocking finding that needs another disposition unless it matches an already declined signature.
3. **Host commit:** the host commits implementer changes before any reviewer pass starts.
4. **Reviewer pass:** the reviewer returns either `satisfied` or structured findings. Findings are persisted as `Feedback` before the convergence decision is made.
5. **Current blocking-set calculation:** the engine considers only the latest reviewer pass plus carried-forward declined signatures. `info` findings are never blocking. `blocker` and `warning` findings are blocking unless they match a valid declined signature from an earlier implementer disposition.
6. **Convergence gate:** the engine returns `advance` only when the current blocking set is empty after the reviewer pass. A `satisfied` reviewer result produces an empty blocking set, but `satisfied` is not required if the reviewer only returns `info` findings or repeats already-declined signatures.
7. **Continue or escalate:** if the current blocking set is non-empty and another round remains, those findings become the required dispositions for the next implementer pass. If the current blocking set is non-empty on the last allowed round, or oscillation is detected, the engine returns `needs_input` with open findings; it never advances with undisposed fresh blocking findings.
#### Role dispatch

The current `RunUnitOfWork` input only carries `run`, `runId`, and `tenant`; control-plane wiring currently has a `resolveRole` seam that defaults to `implementer`. Reviewed execution needs an explicit role and round in the execution input. Add an internal extension such as:
```typescript
interface RunRoleWorkInput extends RunWorkInput {
  readonly role: 'implementer' | 'reviewer';
  readonly round: number;
  readonly reviewContext?: ReviewContext;
  readonly toolPolicyMode?: 'write' | 'read_only';
  readonly routeProfileId?: string;
}
```
The exact type can live in core if the existing execution context resolver can consume it through callbacks. The public API does not need to expose this shape. Session persistence should record `role` and `round` in the existing `sessions` table.
#### Workspace git and filesystem behavior

The host, not the agent, commits implementer work. Add or reuse a `WorkspaceGitPort` in core-facing dependencies with operations similar to:
```typescript
interface WorkspaceGitPort {
  commitFiles(input: {
    runId: string;
    workspaceRepoRoot: string;
    message: string;
    allowEmpty?: boolean;
  }): Promise;
}
```
Implementation should use existing workspace containment and argument-array git patterns from the execution workspace internals through a public port or control-plane seam. Core must not import execution internals directly. The reviewer session receives read-only git and file capabilities only; state-changing git commands, writes, edits, branch switches, pushes, and merges are unavailable.
#### Model routing behavior

For reviewed agent steps, call `resolveDistinctAgentRoutes({ tenant, runId, step, roles: ['implementer', 'reviewer'] })` before dispatching the first round. If routing resolves distinct profiles, pass each role's resolution to the role dispatcher.
If the resolver reports a distinctness failure but a normal route can still resolve for the roles, run both sessions on the single available profile and log a warning with safe fields: run id, step, roles, distinctBy, routing table id if safe, and reason code. The warning must not include credential data, raw config values, prompts, or provider responses. Missing routing that prevents any session from running remains a configuration failure and should fail safely through existing sanitized failure behavior.
#### Finding and disposition contract

Reviewer terminal output for reviewed steps needs a narrow structured result contract. A suggested internal schema:
```typescript
type ReviewerFindingSeverity = 'blocker' | 'warning' | 'info';

type ReviewerFinding = {
  externalId?: string;
  title: string;
  body: string;
  severity: ReviewerFindingSeverity;
  anchor?: FeedbackAnchor;
};

type ReviewerResult =
  | { status: 'satisfied'; findings?: [] }
  | { status: 'findings'; findings: ReviewerFinding[] };
```
Implementer disposition output should be equally narrow:
```typescript
type FindingDisposition =
  | { feedbackId: string; disposition: 'fixed'; summary: string }
  | { feedbackId: string; disposition: 'declined'; reason: string };
```
The implementation may fold dispositions into the implementer's ordinary terminal result if that better fits the existing runner contract, but the persisted round record must always contain a normalized disposition for each blocking finding from the previous reviewer pass.
#### Blocking rules

Apply build-depth-only filtering:
- `info` never blocks convergence.
- `blocker` and `warning` block until fixed or declined by the implementer.
- Declined findings do not block, but must carry a non-empty reason and remain visible.
- No altitude, category, or layer logic is introduced.
#### Oscillation detection

Persist enough information to detect repeated unresolved work across rounds. At minimum, compute a stable signature from blocking findings, such as normalized title, severity, anchor, and a body hash. The engine should escalate when:
- The same blocking signature repeats after an implementer round, or
- The count of blocking findings does not decrease across rounds and the engine has already given the implementer at least one chance to respond.
This rule should be deterministic and covered by unit tests. It can be conservative; false positives pause for a person rather than ship bad work.
### Data model

#### Feedback

Use the existing `Feedback` entity for reviewer findings:
- `runId`: current run.
- `owner` and `tenant`: copied from the run.
- `target`: `artifact` for `spec.author`; `implementation` for `implementation.build` if the current `Feedback.target` enum supports it, otherwise add the missing target value through `packages/api-contract/src/feedback.ts` and persistence validation.
- `status`: `open` at creation.
- `title` and `body`: from the reviewer finding.
- `anchor`: optional reviewer-provided anchor when it satisfies the shared anchor schema.
- `thread[0].author`: model principal for the reviewer route.
If implementation findings require `target: implementation`, update all feedback lifecycle filters and gate readers that currently assume artifact-only behavior. Existing artifact feedback behavior must remain unchanged.
#### Round records on `RunStep`

The current `RunStep` schema has `checkpointResult: JsonValue | null`, and persistence stores it in `run_steps.checkpoint_result_json`. Define a typed convergence checkpoint schema and write it into the source step's checkpoint result. A suggested shape:
```typescript
type ConvergenceCheckpoint = {
  kind: 'convergence_review';
  step: string;
  maxRounds: number;
  routing: {
    distinct: boolean;
    distinctBy?: 'model' | 'profile';
    warningCode?: 'role_distinct_unsatisfied';
  };
  rounds: ConvergenceRoundRecord[];
  outcome: 'converged' | 'max_rounds' | 'oscillation';
  openFeedbackIds: string[];
  lastPositions: {
    implementer?: string;
    reviewer?: string;
  };
};

type ConvergenceRoundRecord = {
  round: number;
  implementerSessionId?: string;
  reviewerSessionId?: string;
  implementerCommitSha?: string | null;
  changedFileCount: number;
  findings: Array;
  dispositions: Array;
  outcome: 'continue' | 'converged' | 'max_rounds' | 'oscillation';
};
```
The public `runStepSchema` can continue to expose `checkpointResult` as JSON if no stronger public contract is desired in this slice. Internally, validate the shape before persistence so review surfaces can rely on it.
#### Workflow policy

Add per-step convergence policy data to workflow definitions or a nearby catalog helper:
```typescript
type StepConvergencePolicy = {
  maxRounds?: number;
};
```
Default to 3 when no policy is present. The policy should be data, not a hard-coded branch in the engine.
#### Sessions

The `sessions` table already stores `step`, `role`, and `round`. Ensure reviewed role dispatch creates one session record per implementer and reviewer run with the correct role and round values. Cost and telemetry rollups should stay per `(run, step, role)`.
### API contracts and internal interfaces

No new public HTTP route is required. Existing reads of `GET /v1/runs/:id`, `GET /v1/runs/:id/steps`, run events, and feedback list routes should be enough to observe state, step checkpoints, and findings once target support is complete.
Add or extend internal contracts:
- `ConvergenceEngine` in `packages/core`, with injected role dispatcher, workspace git port, feedback dependencies, routing resolver, clock, ids, and logger.
- `ReviewedRoleDispatcher` abstraction around execution so the engine can run `implementer` and `reviewer` sessions without provider-specific logic.
- `ReviewerResult` and `FindingDisposition` schemas, preferably in `packages/api-contract` if execution result validation needs shared Zod schemas, or in core if the role dispatcher can validate before returning to the engine.
- `ConvergenceCheckpoint` schema, likely in `packages/api-contract/src/run-step.ts` or a sibling export if public clients should understand it.
- Optional `RunStepRepository` or `RunRepository` method to update the active source step checkpoint after each round. If checkpoint updates only happen when applying the next directive today, add an atomic update method so max-round escalation and crash recovery do not lose earlier rounds.
### Execution context and prompts

The implementer prompt for rounds after the first should include:
- Current step and round number.
- Findings from the prior reviewer pass.
- Required disposition format.
- Reminder that declined findings need a concrete reason.
The reviewer prompt should include:
- Current step and round number.
- Read-only review role instructions.
- The expected finding schema and severity definitions.
- The build-depth blocking policy.
- A clear instruction to return satisfied when no material findings remain.
Prompt text is not a security boundary. Tool policy and workspace capabilities enforce read-only reviewer behavior.
### Error handling and escalation

- Implementer execution failures use existing sanitized runner failure handling.
- Reviewer protocol or validation failures should fail safely unless the result tolerance pipeline can repair the output.
- Distinct-routing unsatisfied degrades only when a usable single route is available; otherwise fail with a safe configuration reason.
- Commit failures after implementer execution should fail safely and should not start reviewer execution for that round.
- Max rounds and oscillation are not failures. They return `needs_input`, persist the convergence checkpoint, and move to the workflow's awaiting-input step.
- If a reviewed step has no `needs_input` edge, treat escalation as an invalid workflow configuration and fail safely with a sanitized reason.
### Testing strategy

#### Unit tests

- Step-role dispatch selection: reviewed steps use the convergence engine; single-role AI steps use existing one-shot behavior.
- Blocking filter: `info` non-blocking, `warning` and `blocker` blocking until fixed or declined, declined non-blocking with reason required.
- Oscillation detection for repeated signatures and non-decreasing blocking counts.
- Round checkpoint schema validation.
- Feedback creation from reviewer findings, including model-principal authorship.
- Max-round escalation returns `needs_input` and preserves open findings.
- Distinct-routing failure falls back to same-model review only when a usable single route exists and logs the warning.
- Reviewer tool policy construction excludes write and state-changing git capabilities.
#### Integration tests

- Orchestrator dispatch over `spec.author` and `implementation.build` records convergence checkpoints and advances to the expected next step on convergence.
- `implementation.build` max-round exhaustion transitions to `implementation.awaiting_input` with `waitingOn: human`.
- `spec.author` max-round exhaustion transitions to `spec.awaiting_input` with `waitingOn: human`.
- Feedback list includes model reviewer findings alongside human-created feedback for the same run.
- Existing `spec.human_review` artifact feedback behavior and single-role AI-step dispatch behavior remain unchanged.
#### Real end-to-end smoke

Add the issue-required first-real-path smoke for `implementation.build`:
- Drive the production dispatch path, not a mocked convergence-loop pump.
- Use a real workspace and git branch owned by the run workspace lifecycle.
- Position a run at `implementation.build` with a small real task.
- Run a real implementer agent that writes and commits code through the host commit boundary.
- Run a real critic agent that reviews read-only over actual git state.
- Assert a happy path that converges and advances to `implementation.human_review`.
- Assert a forced-stall variant that reaches max rounds and pauses `waitingOn: human` with open findings.
- Assert role routing, `Feedback` persistence, session role/round records, and convergence checkpoint records.
If live provider credentials are unavailable in normal CI, keep the live-provider variant opt-in and add a deterministic production-path harness that still exercises the real dispatch, workspace, git, persistence, routing, and engine code without injecting round results into the engine.
### Rollout and compatibility

Implement behind the step-role check rather than a global behavior flag. That makes the change active only where the catalog declares a reviewer. Preserve current behavior for non-reviewed AI steps. Keep logs structured and sanitized so operators can diagnose degraded same-model review without leaking provider or prompt data.
### Final decisions and implementation discovery

- Implementation findings use `Feedback.target: 'implementation'`; the existing feedback contract already accepts that target.
- `ConvergenceCheckpoint` remains typed JSON inside `RunStep.checkpointResult` for this slice, validated by the shared convergence schema.
- Host git commits flow through the core-facing `RunWorkspaceGitPort` seam so core does not import execution internals.
- Implementation must inventory provider adapters while wiring reviewer tool policy. Adapters that cannot enforce reviewer read-only tools must fail reviewer dispatch safely or grant no file/git access.
## Converged API

### Files

Path
Purpose
Exports

`packages/api-contract/src/convergence.ts`
Defines shared Zod schemas and TypeScript types for reviewer findings, implementer dispositions, and the durable convergence checkpoint stored in RunStep.checkpointResult.
`reviewerFindingSeveritySchema`, `reviewerFindingSchema`, `reviewerFindingContextSchema`, `reviewerResultSchema`, `findingDispositionSchema`, `convergenceRoundRecordSchema`, `convergenceCheckpointSchema`, `ReviewerFindingSeverity`, `ReviewerFinding`, `ReviewerFindingContext`, `ReviewerResult`, `FindingDisposition`, `ConvergenceRoundRecord`, `ConvergenceCheckpoint`

`packages/api-contract/src/index.ts`
Re-exports the convergence contract module so package consumers can validate and inspect convergence checkpoint payloads without depending on core internals.
`reviewerFindingSeveritySchema`, `reviewerFindingSchema`, `reviewerFindingContextSchema`, `reviewerResultSchema`, `findingDispositionSchema`, `convergenceRoundRecordSchema`, `convergenceCheckpointSchema`, `ReviewerFindingSeverity`, `ReviewerFinding`, `ReviewerFindingContext`, `ReviewerResult`, `FindingDisposition`, `ConvergenceRoundRecord`, `ConvergenceCheckpoint`

`packages/core/src/convergence-engine.ts`
Adds the generic reviewed-step convergence loop used only by AI producing steps whose catalog roles include both implementer and reviewer; coordinates role dispatch, host commits, feedback creation, round recording, blocking rules, oscillation detection, and advance/escalation outcomes.
`createConvergenceEngine`, `ConvergenceEngine`, `ConvergenceEngineOptions`, `ConvergenceEngineInput`, `ConvergenceEngineResult`, `ConvergenceEscalationReason`

`packages/core/src/reviewed-role-dispatcher.ts`
Defines the execution seam used by the convergence engine to run implementer and reviewer sessions with explicit role, round, route, review context, and tool-policy mode without exposing provider-specific details.
`ReviewedRoleDispatcher`, `RunRoleWorkInput`, `ReviewContext`, `ReviewedRoleDispatchResult`, `ToolPolicyMode`

`packages/core/src/run-workspace-git.ts`
Defines the host-controlled workspace git port used by the convergence engine to commit implementer changes and expose only read-only inspection capabilities to reviewer sessions.
`RunWorkspaceGitPort`, `RunWorkspaceCommitFilesInput`, `RunWorkspaceCommitResult`, `ReviewerWorkspacePolicy`

`packages/core/src/convergence-feedback.ts`
Normalizes reviewer findings into first-class Feedback records authored by the reviewer model principal and returns feedback ids for round records.
`createReviewerFeedback`, `ReviewerFeedbackCreationInput`, `ReviewerFeedbackCreationResult`

`packages/core/src/convergence-policy.ts`
Owns the StepConvergencePolicy type and provides data-driven convergence policy lookup, including the max-round default, for workflow steps without hard-coding specific step ids in the engine.
`defaultConvergenceMaxRounds`, `getStepConvergencePolicy`, `StepConvergencePolicy`

`packages/core/src/orchestrator.ts`
Extends DefaultOrchestrator dispatch selection and constructor options so AI steps with both implementer and reviewer roles delegate to ConvergenceEngine while reviewer-only steps such as pr.finalize and other non-reviewed AI steps keep the existing one-shot RunUnitOfWork path.
`DefaultOrchestrator`, `DefaultOrchestratorOptions`, `RunWorkInput`, `RunWorkResult`

`packages/core/src/domain-repositories.ts`
Extends RunStepRepository with an atomic checkpoint update method so each convergence round can be durably recorded before final advance or human escalation.
`RunStepRepository`, `UpdateRunStepCheckpointInput`

`packages/core/src/run-workflows.ts`
Adds optional per-step convergence policy data to workflow definitions while preserving existing workflow ids, step ids, and transition tables; re-exports StepConvergencePolicy from convergence-policy.ts rather than declaring a second copy.
`RunWorkflowDefinition`, `StepConvergencePolicy`, `runWorkflows`

`packages/core/src/index.ts`
Re-exports the core convergence engine, dispatcher, feedback, policy, and workspace-git seams for application wiring and tests.
`createConvergenceEngine`, `ConvergenceEngine`, `ConvergenceEscalationReason`, `ReviewedRoleDispatcher`, `RunWorkspaceGitPort`, `createReviewerFeedback`, `getStepConvergencePolicy`

### Public API

#### `reviewerFindingSeveritySchema`

```typescript
export const reviewerFindingSeveritySchema: z.ZodEnum
```
- Returns: `Zod schema for ReviewerFindingSeverity`
#### `reviewerFindingSchema`

```typescript
export const reviewerFindingSchema: z.ZodObject
```
- Returns: `Zod schema validating ReviewerFinding objects with non-empty title/body, blocker|warning|info severity, optional externalId, and optional FeedbackAnchor`
- Errors:
	- `ZodError when a reviewer finding is missing title, body, or severity, or when anchor does not satisfy feedbackAnchorSchema`
#### `reviewerFindingContextSchema`

```typescript
export const reviewerFindingContextSchema: z.ZodObject
```
- Returns: `Zod schema validating persisted reviewer finding context passed back into later implementer/reviewer rounds, including feedbackId, title, body, severity, and optional FeedbackAnchor.`
- Errors:
	- `ZodError when a previous finding context omits feedbackId, title, body, or severity, or when anchor does not satisfy feedbackAnchorSchema`
#### `reviewerResultSchema`

```typescript
export const reviewerResultSchema: z.ZodDiscriminatedUnion
```
- Returns: `Zod schema for { status: 'satisfied'; findings?: [] } or { status: 'findings'; findings: non-empty ReviewerFinding[] }`
- Errors:
	- `ZodError when reviewer terminal output does not match the narrow reviewed-step result contract`
	- `ZodError when status is 'findings' but findings is empty; callers must use status 'satisfied' for no findings`
#### `findingDispositionSchema`

```typescript
export const findingDispositionSchema: z.ZodDiscriminatedUnion
```
- Returns: `Zod schema for normalized implementer dispositions keyed by feedbackId`
- Errors:
	- `ZodError when a fixed disposition lacks a non-empty summary or a declined disposition lacks a non-empty reason`
#### `convergenceRoundRecordSchema`

```typescript
export const convergenceRoundRecordSchema: z.ZodObject
```
- Returns: `Zod schema for one persisted implementer/reviewer round record`
- Errors:
	- `ZodError when round number, changedFileCount, outcome, findings, dispositions, or session references do not match the durable checkpoint contract`
#### `convergenceCheckpointSchema`

```typescript
export const convergenceCheckpointSchema: z.ZodObject
```
- Returns: `Zod schema for RunStep.checkpointResult payloads with kind 'convergence_review'`
- Errors:
	- `ZodError when a checkpoint omits routing, rounds, outcome, openFeedbackIds, lastPositions, or uses an unsupported outcome`
#### `createConvergenceEngine`

```typescript
export function createConvergenceEngine(options: ConvergenceEngineOptions): ConvergenceEngine
```
- Parameters:
	- `options: ConvergenceEngineOptions` — Injected role dispatcher, workspace git port with required reviewer read-only policy, feedback writer dependencies, routing resolver, run-step repository, policy resolver, clock/id/logger seams, and optional max-round defaults.
- Returns: `ConvergenceEngine`
- Errors:
	- `ModelRoutingConfigurationError when no usable implementer or reviewer route can be resolved`
	- `ConvergenceEngineError with code 'commit_failed' when host git commit fails after implementer execution`
	- `ConvergenceEngineError with code 'reviewer_result_invalid' when reviewer output cannot be validated as ReviewerResult`
	- `ConvergenceEngineError with code 'disposition_invalid' when required implementer dispositions are missing or invalid`
	- `ConvergenceEngineError with code 'workflow_escalation_edge_missing' when a reviewed step cannot transition on needs_input`
#### `ConvergenceEngine.run`

```typescript
run(input: ConvergenceEngineInput): Promise
```
- Parameters:
	- `input: ConvergenceEngineInput` — The current run, tenant, active run step, current step definition, workflow definition, and optional workspace context for an eligible reviewed producing step; callers must only invoke it when the step catalog roles include both implementer and reviewer.
- Returns: `Promise`
- Errors:
	- `Propagates sanitized configuration and persistence errors from injected dependencies`
	- `Returns a fail directive through ConvergenceEngineResult only when the existing failure-normalization path requires it; max-round and oscillation outcomes are returned as needs_input, not thrown`
	- `Rejects or returns a safe configuration failure if invoked for a step that does not include both implementer and reviewer roles`
#### `ReviewedRoleDispatcher.runRole`

```typescript
runRole(input: RunRoleWorkInput): Promise
```
- Parameters:
	- `input: RunRoleWorkInput` — Run work input plus explicit role, round, routeProfileId, model routing resolution, review context, and optional requested toolPolicyMode. The dispatcher derives the effective tool policy from role: reviewer calls are always executed with enforced read_only tool access regardless of an omitted or conflicting toolPolicyMode input, while implementer calls default to write mode unless a narrower mode is explicitly supported.
- Returns: `Promise`
- Errors:
	- `Returns or propagates existing sanitized runner failures when the role session fails`
	- `Throws or returns a safe unsupported-tool-policy failure when a provider adapter cannot enforce read-only reviewer tools`
	- `Throws or returns a safe policy failure if any reviewer run cannot be executed with enforced read_only tool access at the AI session tool-call boundary, including when the input omits toolPolicyMode or supplies a conflicting mode`
	- `Throws or returns a safe policy failure if a reviewer run is requested without an enforced ReviewerWorkspacePolicy; absence of that policy grants no file or git access`
#### `RunWorkspaceGitPort.commitFiles`

```typescript
commitFiles(input: RunWorkspaceCommitFilesInput): Promise
```
- Parameters:
	- `input: RunWorkspaceCommitFilesInput` — Run id, workspace repo root, commit message, and optional allowEmpty flag. Commits are whole-workspace host commit boundaries for this slice.
- Returns: `Promise`
- Errors:
	- `Rejects when workspaceRepoRoot is outside the run workspace containment boundary`
	- `Rejects when git commit fails or would require branch switching, push, merge, or other state not owned by the host commit boundary`
#### `createReviewerFeedback`

```typescript
export async function createReviewerFeedback(input: ReviewerFeedbackCreationInput): Promise
```
- Parameters:
	- `input: ReviewerFeedbackCreationInput` — Run, current step id, reviewer model principal, reviewer findings, feedback repository/lifecycle dependencies, and clock/id seams; [Feedback.target](http://Feedback.target)='implementation' is already valid for [implementation.build](http://implementation.build) findings.
- Returns: `Promise`
- Errors:
	- `Rejects when a finding target cannot be mapped to the Feedback target enum for the current step`
	- `Rejects when feedback persistence fails`
	- `Rejects when reviewer model authorship cannot be represented as the first thread entry`
#### `getStepConvergencePolicy`

```typescript
export function getStepConvergencePolicy(workflow: RunWorkflowDefinition, step: RunStepId): Required
```
- Parameters:
	- `workflow: RunWorkflowDefinition` — Workflow definition whose optional per-step convergence policy should be inspected.
	- `step: RunStepId` — Current producing step id.
- Returns: `Required`
#### `RunStepRepository.updateCheckpoint`

```typescript
updateCheckpoint(input: UpdateRunStepCheckpointInput): Promise
```
- Parameters:
	- `input: UpdateRunStepCheckpointInput` — Run step id, run id, tenant, checkpointResult JSON payload, and optional optimistic concurrency token when supported by persistence.
- Returns: `Promise`
- Errors:
	- `Rejects when the run step does not exist or does not belong to the tenant/run`
	- `Rejects when checkpointResult is not valid JSON or fails convergenceCheckpointSchema for convergence_review payloads`
	- `Rejects on optimistic concurrency mismatch when the repository implementation supports it`
### Types

#### `ReviewerFindingSeverity`

```typescript
type ReviewerFindingSeverity = 'blocker' | 'warning' | 'info';
```
#### `ReviewerFinding`

```typescript
type ReviewerFinding = { externalId?: string; title: string; body: string; severity: ReviewerFindingSeverity; anchor?: FeedbackAnchor; };
```
#### `ReviewerFindingContext`

```typescript
type ReviewerFindingContext = { feedbackId: string; title: string; severity: ReviewerFindingSeverity; body: string; anchor?: FeedbackAnchor; };
```
#### `ReviewerResult`

```typescript
type ReviewerResult = { status: 'satisfied'; findings?: [] } | { status: 'findings'; findings: [ReviewerFinding, ...ReviewerFinding[]] };
```
#### `FindingDisposition`

```typescript
type FindingDisposition = { feedbackId: string; disposition: 'fixed'; summary: string } | { feedbackId: string; disposition: 'declined'; reason: string };
```
#### `ConvergenceOutcome`

```typescript
type ConvergenceOutcome = 'converged' | 'max_rounds' | 'oscillation';
```
#### `ConvergenceEscalationReason`

```typescript
type ConvergenceEscalationReason = 'max_rounds' | 'oscillation';
```
#### `ConvergenceRoundOutcome`

```typescript
type ConvergenceRoundOutcome = 'continue' | 'converged' | 'max_rounds' | 'oscillation';
```
#### `ConvergenceRoundRecord`

```typescript
type ConvergenceRoundRecord = { round: number; implementerSessionId?: string; reviewerSessionId?: string; implementerCommitSha?: string | null; changedFileCount: number; findings: Array; dispositions: FindingDisposition[]; outcome: ConvergenceRoundOutcome; };
```
#### `ConvergenceCheckpoint`

```typescript
type ConvergenceCheckpoint = { kind: 'convergence_review'; step: string; maxRounds: number; routing: { distinct: boolean; distinctBy?: 'model' | 'profile'; warningCode?: 'role_distinct_unsatisfied' }; rounds: ConvergenceRoundRecord[]; outcome: ConvergenceOutcome; openFeedbackIds: string[]; lastPositions: { implementer?: string; reviewer?: string }; };
```
#### `StepConvergencePolicy`

```typescript
interface StepConvergencePolicy { readonly maxRounds?: number; }
```
#### `ToolPolicyMode`

```typescript
type ToolPolicyMode = 'write' | 'read_only';
```
#### `RunRoleWorkInput`

```typescript
interface RunRoleWorkInput extends RunWorkInput { readonly role: 'implementer' | 'reviewer'; readonly round: number; readonly reviewContext?: ReviewContext; readonly toolPolicyMode?: ToolPolicyMode; readonly routeProfileId?: string; readonly route?: ModelRoutingResolution; }
```
#### `ReviewContext`

```typescript
interface ReviewContext { readonly previousFindings?: readonly ReviewerFindingContext[]; readonly requiredDispositions?: readonly { feedbackId: string; title: string; severity: ReviewerFindingSeverity; body: string }[]; readonly previousRounds?: readonly ConvergenceRoundRecord[]; readonly routingDistinct?: boolean; }
```
#### `ReviewedRoleDispatchResult`

```typescript
type ReviewedRoleDispatchResult = { workResult: RunWorkResult; sessionCheckpointResult?: JsonValue; reviewerResult?: ReviewerResult; dispositions?: FindingDisposition[]; sessionId?: string; lastPosition?: string; modelPrincipal?: Principal; };
```
#### `RunWorkspaceCommitFilesInput`

```typescript
interface RunWorkspaceCommitFilesInput { readonly runId: string; readonly workspaceRepoRoot: string; readonly message: string; readonly allowEmpty?: boolean; }
```
#### `RunWorkspaceCommitResult`

```typescript
interface RunWorkspaceCommitResult { readonly commitSha: string | null; readonly changedFileCount: number; }
```
#### `RunWorkspaceGitPort`

```typescript
interface RunWorkspaceGitPort { commitFiles(input: RunWorkspaceCommitFilesInput): Promise; readonly reviewerPolicy: ReviewerWorkspacePolicy; }
```
#### `ReviewerWorkspacePolicy`

```typescript
interface ReviewerWorkspacePolicy { readonly fileAccess: 'read_only'; readonly gitAccess: 'read_only'; readonly forbiddenGitActions: ReadonlyArray; }
```
#### `ConvergenceEngineOptions`

```typescript
interface ConvergenceEngineOptions { readonly dispatcher: ReviewedRoleDispatcher; readonly git: RunWorkspaceGitPort; readonly feedback: FeedbackRepository; readonly runSteps: RunStepRepository; readonly routing: ModelRoutingResolver; readonly getPolicy?: (workflow: RunWorkflowDefinition, step: RunStepId) => Required; readonly logger?: { warn(message: string, details?: unknown): void }; readonly clock?: () => string; readonly idGenerator?: () => string; }
```
#### `ConvergenceEngineInput`

```typescript
interface ConvergenceEngineInput { readonly runId: string; readonly run: Run; readonly tenant: string; readonly runStep: RunStep; readonly stepDefinition: RunStepDefinition; readonly workflow: RunWorkflowDefinition; readonly workspace?: WorkspaceContext; }
```
#### `ConvergenceEngineResult`

```typescript
type ConvergenceEngineResult = { readonly workResult: RunWorkResult; readonly checkpointResult: ConvergenceCheckpoint; };
```
#### `ReviewerFeedbackCreationInput`

```typescript
interface ReviewerFeedbackCreationInput { readonly run: Run; readonly step: RunStepId; readonly reviewerPrincipal: Principal; readonly findings: readonly ReviewerFinding[]; readonly repository: FeedbackRepository; readonly clock?: () => string; readonly idGenerator?: () => string; }
```
#### `ReviewerFeedbackCreationResult`

```typescript
interface ReviewerFeedbackCreationResult { readonly feedback: readonly Feedback[]; readonly findingsByFeedbackId: Readonly>; }
```
#### `UpdateRunStepCheckpointInput`

```typescript
interface UpdateRunStepCheckpointInput { readonly runStepId: string; readonly runId: string; readonly tenant: string; readonly checkpointResult: JsonValue; readonly expectedUpdatedAt?: string; }
```
### Notes

No new public HTTP route is proposed. Existing run, run-step, event, and feedback read APIs remain sufficient; this artifact proposes shared TypeScript/Zod contracts plus core orchestration seams. The reviewed dispatch condition is roles.includes('implementer') && roles.includes('reviewer'); reviewer-only steps such as pr.finalize continue on the existing one-shot RunUnitOfWork path. Reviewer read-only enforcement is represented as an internal tool-policy/workspace-git contract with a required ReviewerWorkspacePolicy; the dispatcher, not the caller, owns the effective reviewer tool policy and must force role='reviewer' sessions to read_only tool access even if toolPolicyMode is omitted or conflicting. Provider adapters that cannot enforce reviewer read-only tool access or reviewer workspace-git policy must fail reviewer dispatch or grant no file/git access. [Feedback.target](http://Feedback.target)='implementation' is already accepted by the existing feedback contract, so implementation findings require no feedback target migration.
## Task list

### Story 1: Shared contracts define reviewed-step results and checkpoints

Enzo can import one shared contract module for reviewer findings, implementer dispositions, and durable convergence checkpoint data.
#### Task 1.1: Add convergence contract schemas

- **Description:** Create `packages/api-contract/src/convergence.ts` with the Zod schemas and inferred types from the Converged API.
- **Acceptance criteria:**
	- `reviewerFindingSeveritySchema` accepts exactly `blocker`, `warning`, and `info`.
	- `reviewerFindingSchema` requires non-empty `title`, non-empty `body`, valid severity, optional `externalId`, and optional `FeedbackAnchor`.
	- `reviewerFindingContextSchema` requires `feedbackId`, `title`, `body`, and severity for findings passed into later rounds.
	- `reviewerResultSchema` accepts `status: 'satisfied'` with no findings or an empty findings array.
	- `reviewerResultSchema` accepts `status: 'findings'` only with a non-empty findings array.
	- `findingDispositionSchema` requires a non-empty `summary` for `fixed` and a non-empty `reason` for `declined`.
- **Dependencies:** None.
#### Task 1.2: Add convergence checkpoint schemas

- **Description:** Add `convergenceRoundRecordSchema` and `convergenceCheckpointSchema` to `packages/api-contract/src/convergence.ts`.
- **Acceptance criteria:**
	- Round records validate `round`, optional session ids, optional implementer commit sha, `changedFileCount`, findings, dispositions, and round outcome.
	- Finding records in a round validate `feedbackId`, severity, title, `blocking`, and deterministic `signature`.
	- Checkpoints validate `kind: 'convergence_review'`, step, max rounds, routing metadata, rounds, outcome, open feedback ids, and last positions.
	- Checkpoint outcomes accept exactly `converged`, `max_rounds`, and `oscillation`.
	- Routing warning codes match the Converged API.
- **Dependencies:** Task 1.1.
#### Task 1.3: Export and test the convergence contracts

- **Description:** Re-export convergence schemas and types from `packages/api-contract/src/index.ts` and add focused API-contract tests.
- **Acceptance criteria:**
	- The package root exports every schema and type listed for `packages/api-contract/src/index.ts` in the Converged API.
	- Contract tests cover valid and invalid reviewer findings, reviewer results, finding contexts, and dispositions.
	- Contract tests cover valid and invalid convergence round records and checkpoints.
	- Tests prove `status: 'findings'` with an empty findings array is rejected.
	- Tests prove declined dispositions without reasons and fixed dispositions without summaries are rejected.
- **Dependencies:** Task 1.2.
### Story 2: Persistence and feedback seams can store every round

Phoebe can retrieve reviewer findings as ordinary `Feedback` and see the per-round exchange on the source `RunStep`.
#### Task 2.1: Add atomic run-step checkpoint updates

- **Description:** Extend `RunStepRepository` in `packages/core/src/domain-repositories.ts` and its persistence implementation with `updateCheckpoint(input: UpdateRunStepCheckpointInput)`.
- **Acceptance criteria:**
	- The repository method requires run step id, run id, tenant, and checkpoint JSON.
	- The method rejects updates when the run step does not belong to the tenant and run.
	- The method validates `kind: 'convergence_review'` payloads with `convergenceCheckpointSchema` before persistence.
	- Persistence writes `run_steps.checkpoint_result_json` without changing unrelated run-step fields.
	- Repository tests cover success, tenant/run mismatch, invalid convergence checkpoint JSON, and optional optimistic concurrency behavior when supported.
- **Dependencies:** Task 1.3.
#### Task 2.2: Create reviewer feedback from findings

- **Description:** Implement `packages/core/src/convergence-feedback.ts` so reviewer findings become model-authored `Feedback` records.
- **Acceptance criteria:**
	- `createReviewerFeedback` maps `spec.author` findings to the artifact feedback target.
	- `createReviewerFeedback` maps `implementation.build` findings to `Feedback.target: 'implementation'`.
	- Each created feedback item is owned by the run tenant and run owner.
	- Each feedback item starts with `status: open`.
	- The first thread entry is authored by the reviewer model principal.
	- Returned results include feedback ids and a finding lookup keyed by feedback id.
	- Errors are safe when a target cannot be mapped, feedback persistence fails, or reviewer authorship cannot be represented.
- **Dependencies:** Task 1.3.
#### Task 2.3: Add feedback and checkpoint persistence tests

- **Description:** Add focused tests for reviewer feedback creation and durable round-record persistence.
- **Acceptance criteria:**
	- Tests prove reviewer findings appear in feedback lists alongside human-created feedback for the same run.
	- Tests prove implementation findings use the existing `implementation` feedback target.
	- Tests prove checkpoint updates preserve previous round records when a later round is appended.
	- Tests prove invalid convergence checkpoints are rejected at the repository boundary.
	- Tests assert feedback author data does not expose provider credentials, raw prompts, or provider responses.
- **Dependencies:** Tasks 2.1 and 2.2.
### Story 3: Core seams support role dispatch and host git commits

Enzo can run implementer and reviewer sessions through provider-neutral interfaces while the host owns commits and reviewer read-only policy.
#### Task 3.1: Define the reviewed role dispatcher seam

- **Description:** Create `packages/core/src/reviewed-role-dispatcher.ts` with `ReviewedRoleDispatcher`, `RunRoleWorkInput`, `ReviewContext`, `ReviewedRoleDispatchResult`, and `ToolPolicyMode`.
- **Acceptance criteria:**
	- `RunRoleWorkInput` extends the existing run-work input with explicit role, round, optional review context, optional route profile id, optional route resolution, and optional tool policy mode.
	- `ReviewedRoleDispatchResult` can carry the ordinary `RunWorkResult`, session checkpoint data, reviewer result, dispositions, session id, last position, and model principal.
	- The dispatcher contract states that reviewer sessions are forced to read-only tool access even if callers omit or conflict with `toolPolicyMode`.
	- The dispatcher contract states that absent reviewer workspace policy grants no file or git access.
	- The new seam is exported from `packages/core/src/index.ts`.
- **Dependencies:** Task 1.3.
#### Task 3.2: Define the run workspace git port

- **Description:** Create `packages/core/src/run-workspace-git.ts` with `RunWorkspaceGitPort`, commit input/result types, and `ReviewerWorkspacePolicy`.
- **Acceptance criteria:**
	- `commitFiles` accepts run id, workspace repo root, commit message, and optional `allowEmpty`.
	- `commitFiles` returns commit sha and changed file count.
	- `ReviewerWorkspacePolicy` grants only read-only file and git access.
	- The forbidden git action list includes commit, push, merge, checkout, switch, reset, and rebase.
	- The port contract rejects workspace roots outside the run workspace containment boundary.
	- The port is exported from `packages/core/src/index.ts`.
- **Dependencies:** None.
#### Task 3.3: Wire role dispatch to execution sessions

- **Description:** Adapt the existing execution dispatch path so reviewed role inputs create separate implementer and reviewer sessions with correct role, round, route, review context, and tool policy.
- **Acceptance criteria:**
	- Implementer sessions keep write-capable behavior used by current producing steps.
	- Reviewer sessions receive enforced `read_only` tool policy and the required `ReviewerWorkspacePolicy`.
	- Session persistence records the correct `step`, `role`, and `round`.
	- Provider adapters that cannot enforce reviewer read-only access fail safely or grant no file/git access.
	- The reviewer cannot edit files, commit, push, switch branches, or mutate workspace state through exposed tools.
	- Dispatch failures are sanitized through the existing runner failure path.
- **Dependencies:** Tasks 3.1 and 3.2.
#### Task 3.4: Add host commit implementation for run workspaces

- **Description:** Implement the concrete `RunWorkspaceGitPort` using the existing workspace containment and argument-array git patterns without importing execution internals into core.
- **Acceptance criteria:**
	- The host commits implementer changes after implementer execution and before reviewer execution.
	- The commit operation never switches branches, pushes, merges, rebases, or resets.
	- Empty changes return `commitSha: null` and `changedFileCount: 0` unless the implementation explicitly supports `allowEmpty`.
	- Commit failures stop the current round before reviewer dispatch.
	- Tests cover normal commits, no-change commits, containment rejection, and disallowed git action protection.
- **Dependencies:** Task 3.2.
### Story 4: The convergence engine owns reviewed-step rounds

Opal can rely on a bounded, generic convergence loop that advances only on convergence and pauses safely on stalled review.
#### Task 4.1: Add convergence policy lookup

- **Description:** Create `packages/core/src/convergence-policy.ts` and extend `packages/core/src/run-workflows.ts` with optional per-step convergence policy data.
- **Acceptance criteria:**
	- `defaultConvergenceMaxRounds` is 3.
	- `getStepConvergencePolicy(workflow, step)` returns a required max-round value.
	- Workflow policy data is optional and does not change existing workflow ids, step ids, or transition tables.
	- Policy lookup is data-driven and does not hard-code `spec.author` or `implementation.build` inside the engine.
	- Core exports the policy helper and type.
- **Dependencies:** None.
#### Task 4.2: Implement blocking rules and oscillation detection

- **Description:** Add deterministic helpers inside `packages/core/src/convergence-engine.ts` for finding signatures, blocking status, disposition validation, and oscillation detection.
- **Acceptance criteria:**
	- `info` findings never block convergence.
	- `warning` and `blocker` findings block until fixed or declined.
	- Declined findings require a non-empty reason and do not block after disposition.
	- Finding signatures are stable across equivalent reviewer findings using normalized title, severity, anchor, and body hash.
	- Oscillation is detected when the same blocking signature repeats after an implementer round.
	- Oscillation is detected when blocking count does not decrease after the implementer has had at least one chance to respond.
	- Unit tests cover all blocking and oscillation rules.
	- Unit tests prove a fresh final-pass `blocker` or `warning` escalates instead of advancing.
	- Unit tests prove a reviewer repeat of an already declined finding signature remains non-blocking and visible.
	- Unit tests prove `satisfied` reviewer output produces convergence when there are no carried-forward blocking findings.
- **Dependencies:** Task 1.3.
#### Task 4.3: Implement route resolution for reviewed roles

- **Description:** In the convergence engine, resolve implementer and reviewer routes through `resolveDistinctAgentRoutes` and support the single-profile degraded path.
- **Acceptance criteria:**
	- Reviewed steps call `resolveDistinctAgentRoutes` with roles `implementer` and `reviewer`.
	- Distinct routing passes each role's route resolution to the dispatcher.
	- `role_distinct_unsatisfied` degrades only when usable single-role routes still exist for both roles.
	- The degraded path still runs separate implementer and reviewer sessions.
	- The logger emits a sanitized warning with run id, step, roles, distinctness mode, routing table id when safe, and reason code.
	- Missing routing that prevents either session from running fails safely through existing sanitized failure behavior.
	- Unit tests prove the warning contains no credential data, raw routing settings, prompts, provider responses, or workspace file contents.
- **Dependencies:** Task 3.1.
#### Task 4.4: Implement the round loop

- **Description:** Implement `createConvergenceEngine` and `ConvergenceEngine.run` in `packages/core/src/convergence-engine.ts`.
- **Acceptance criteria:**
	- The engine rejects or safely fails if invoked for a step that does not include both implementer and reviewer roles.
	- Each round runs the implementer first.
	- The host commits changed files after implementer execution.
	- The reviewer runs after the commit with read-only policy.
	- Reviewer output is validated with `reviewerResultSchema`.
	- Reviewer findings are persisted as `Feedback`.
	- The engine passes unresolved findings, required dispositions, previous rounds, and routing distinctness into later implementer rounds.
	- Implementer dispositions are validated with `findingDispositionSchema`.
	- A convergence checkpoint is durably written after each reviewer pass and after disposition data is available.
	- The engine returns `advance` with a converged checkpoint when no blocking finding remains.
	- The engine does not return `advance` for fresh `blocker` or `warning` findings from the latest reviewer pass unless they match an already declined signature.
- **Dependencies:** Tasks 2.1, 2.2, 3.3, 3.4, 4.1, 4.2, and 4.3.
#### Task 4.5: Implement max-round and oscillation escalation

- **Description:** Make the convergence engine return `needs_input` instead of failing when max rounds or oscillation stops the loop.
- **Acceptance criteria:**
	- Max-round exhaustion persists the final checkpoint with `outcome: 'max_rounds'`.
	- Oscillation persists the final checkpoint with `outcome: 'oscillation'`.
	- Escalation result includes open feedback ids and last positions from both roles when available.
	- Escalation returns a `needs_input` directive that uses the existing workflow transition to the matching awaiting-input step.
	- If a reviewed step has no `needs_input` edge, the engine fails safely with `workflow_escalation_edge_missing`.
	- Max-round and oscillation outcomes do not fail the run and do not silently advance it.
- **Dependencies:** Task 4.4.
#### Task 4.6: Add convergence engine unit tests

- **Description:** Add focused unit tests for the generic convergence engine without mocking away engine decisions.
- **Acceptance criteria:**
	- Tests cover one-round convergence.
	- Tests cover a finding fixed in a later round.
	- Tests cover a finding declined with a recorded reason.
	- Tests cover invalid reviewer results and invalid dispositions.
	- Tests cover commit failure preventing reviewer dispatch.
	- Tests cover max-round escalation and oscillation escalation.
	- Tests cover checkpoint persistence after each round.
	- Tests cover model-principal authorship for persisted feedback.
- **Dependencies:** Task 4.5.
### Story 5: Orchestrator dispatch uses convergence for reviewed producing steps

Enzo can rely on step catalog roles to select reviewed execution while existing single-role AI steps keep current behavior.
#### Task 5.1: Select reviewed dispatch from step roles

- **Description:** Extend `DefaultOrchestrator` in `packages/core/src/orchestrator.ts` so AI steps with both `implementer` and `reviewer` roles delegate to the convergence engine.
- **Acceptance criteria:**
	- System-step dispatch still runs before AI dispatch selection.
	- Human-waiting steps still refuse dispatch as they do today.
	- AI steps without `reviewer` continue through the existing one-shot `RunUnitOfWork` path unchanged.
	- AI steps with both `implementer` and `reviewer` call `ConvergenceEngine.run`.
	- Reviewer-only steps such as `pr.finalize` remain on the existing one-shot path.
	- The orchestrator still applies returned directives through the centralized transition, event, scheduling, and failure-normalization path.
- **Dependencies:** Task 4.4.
#### Task 5.2: Compose convergence dependencies in application wiring

- **Description:** Wire the convergence engine, reviewed role dispatcher, run workspace git port, feedback writer dependencies, routing resolver, run-step repository, policy lookup, and logger into the control-plane composition root.
- **Acceptance criteria:**
	- Production dispatch has a concrete `ConvergenceEngine` in `DefaultOrchestratorOptions`.
	- The convergence engine receives the same tenant-aware routing resolver used by normal agent dispatch.
	- The engine receives a concrete host git port for the run workspace lifecycle.
	- The engine receives feedback and run-step persistence dependencies from the existing repositories.
	- The composition does not create branches, switch branches, create worktrees, push, merge, or open pull requests outside the existing run workspace lifecycle.
	- Dependency construction keeps provider-specific behavior behind runner adapters and execution seams.
- **Dependencies:** Tasks 2.3, 3.3, 3.4, 4.6, and 5.1.
#### Task 5.3: Preserve prompt and result context across rounds

- **Description:** Update execution prompt/context builders so implementer and reviewer sessions receive the reviewed-step context required by the tech spec.
- **Acceptance criteria:**
	- Later implementer rounds include the current step, round number, prior reviewer findings, required disposition format, and the rule that declined findings need concrete reasons.
	- Reviewer sessions include current step, round number, read-only review role instructions, expected finding schema, severity definitions, build-depth blocking policy, and satisfied-result instruction.
	- Prompt text is not treated as the security boundary; tool policy and workspace capabilities enforce read-only behavior.
	- Context passed to sessions excludes raw secrets and credential handles.
	- Session checkpoints or terminal results are normalized into `ReviewedRoleDispatchResult`.
- **Dependencies:** Tasks 3.3 and 4.4.
#### Task 5.4: Add orchestrator integration tests

- **Description:** Add integration coverage for dispatch selection, reviewed-step transitions, and one-shot compatibility.
- **Acceptance criteria:**
	- `spec.author` convergence advances to `spec.human_review` on convergence.
	- `implementation.build` convergence advances to `implementation.human_review` on convergence.
	- `spec.author` max-round exhaustion transitions to `spec.awaiting_input` with `waitingOn: human`.
	- `implementation.build` max-round exhaustion transitions to `implementation.awaiting_input` with `waitingOn: human`.
	- `implementation.plan`, `docs.update`, and `question.answer` keep current one-shot behavior.
	- Feedback and convergence checkpoints are observable through existing run, run-step, event, and feedback reads.
- **Dependencies:** Tasks 5.2 and 5.3.
### Story 6: Production-path validation proves implementation build review

Opal can see a real `implementation.build` run exercise dispatch, workspace, git, routing, feedback, and checkpoints without a test-only loop pump.
#### Task 6.1: Add deterministic production-path smoke coverage

- **Description:** Add a deterministic smoke harness for `implementation.build` that uses production dispatch, a real workspace, real git operations, persistence, routing, and the convergence engine without injecting round results into the engine.
- **Acceptance criteria:**
	- The smoke positions a run at `implementation.build` with a small real task.
	- The implementer path writes a real file change in the run workspace.
	- The host commit boundary creates the commit or records a no-change result according to the port contract.
	- The reviewer path reads through read-only workspace and git capabilities.
	- The happy path converges and advances to `implementation.human_review`.
	- The forced-stall path reaches max rounds and pauses with `waitingOn: human`.
	- Assertions cover distinct role routing, persisted `Feedback`, session role/round records, and convergence checkpoint records.
- **Dependencies:** Task 5.4.
#### Task 6.2: Add opt-in live-provider end-to-end coverage

- **Description:** Add an opt-in live-provider variant for the issue-required first real `implementation.build` path when credentials are available.
- **Acceptance criteria:**
	- The test is skipped by default when live provider credentials are unavailable.
	- The test uses production dispatch and a real run workspace branch owned by the run workspace lifecycle.
	- The implementer is a real code-writing agent.
	- The critic is a real read-only reviewer agent.
	- The happy path proves convergence and advancement to `implementation.human_review`.
	- The forced-stall variant proves max-round pause with open findings.
	- The test never logs secrets, prompts, raw provider output, or workspace file dumps.
- **Dependencies:** Task 6.1.
#### Task 6.3: Add safety and regression tests for reviewer read-only behavior

- **Description:** Add targeted tests that attempt reviewer writes and state-changing git operations through the reviewed execution path.
- **Acceptance criteria:**
	- Reviewer file writes are rejected or unavailable.
	- Reviewer commit, push, merge, checkout, switch, reset, and rebase are rejected or unavailable.
	- A provider adapter that cannot enforce read-only reviewer tools fails reviewer dispatch safely.
	- Reviewer read-only failures do not leave a checkpoint that claims convergence.
	- Logs and run events for policy failures are sanitized.
- **Dependencies:** Tasks 3.3 and 5.2.
#### Task 6.4: Document implementation map and validation commands

- **Description:** Update `context-agent/wiki/code-map.md` with the convergence modules, orchestration wiring, persistence shape, read-only reviewer policy, and targeted test commands.
- **Acceptance criteria:**
	- The code map identifies `packages/api-contract/src/convergence.ts` as the shared convergence contract source.
	- The code map identifies `packages/core/src/convergence-engine.ts` as the generic reviewed-step engine.
	- The code map identifies dispatcher, workspace-git, feedback, policy, orchestrator, and repository seams changed for this feature.
	- The code map lists deterministic and opt-in live validation commands.
	- The documentation notes that providers unable to enforce reviewer read-only tools must fail reviewer dispatch or grant no file/git access.
- **Dependencies:** Tasks 6.1, 6.2, and 6.3.