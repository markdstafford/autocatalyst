---
created: 2026-06-08
last_updated: 2026-06-08
status: complete
issue: 13
specced_by: markdstafford
---
# Feature: Run step catalog, workflows-as-data, and transition rule

## Product requirements

### What

Add the first runtime lifecycle model for Autocatalyst runs. The service gains a typed step-primitives catalog, workflow definitions for each work kind, and one transition rule that maps `(workflow, current step, directive)` to the next step.
A run pins its workflow when it starts. The run then advances through that workflow by applying directives such as `advance`, `revise`, `needs_input`, `cancel`, and `fail`. Every entered step writes a `RunStep` occurrence, and the run's `terminal` discriminator stays derived from the current step's intrinsic `waiting_on` value.
This feature builds on the domain model and persistence schema from issue 11. The `runs` table already stores `work_kind`, `current_step`, and the temporary `terminal` discriminator. The `run_steps` table already stores step occurrences with `phase`, `step`, `role`, and occurrence metadata. This feature supplies the lifecycle logic over those existing fields.
### Why

Autocatalyst needs one durable rule for how work moves from intake to completion. Today, the schema can store a run's current step, but the service does not yet have the catalog, workflow tables, or transition function that make those stored strings meaningful.
The run and workflow concepts already define the target model: steps carry `waiting_on`, workflows are data, and one `next(workflow, step, directive)` function moves the run. Implementing that model now prevents later orchestration work from hardcoding step strings, maintaining separate terminal lists, or recording `RunStep` rows inconsistently.
### Goals

- Add a typed step-primitives catalog for the run lifecycle steps defined in `context-human/concepts/run.md` and `context-human/concepts/workflow.md`.
- Ensure each step declares an explicit `phase` and intrinsic `waiting_on` value.
- Derive terminal, model-active, and message-accepting step sets from `waiting_on` instead of hand-maintained lists.
- Represent `feature`, `enhancement`, `bug`, `chore`, `file_issue`, and `question` workflows as data over the shared catalog.
- Implement the `next(workflow, step, directive)` transition rule for `advance`, `revise`, `needs_input`, `cancel`, and `fail`.
- Store backward `revise` behavior as workflow table data instead of special-case transition code.
- Pin a run's workflow from `workKind` when the run starts and reject unknown work kinds.
- Keep the persisted `terminal` field synchronized with the current step's `waiting_on === 'none'` classification.
- Write a `RunStep` occurrence for every step the lifecycle enters.
- Prove the lifecycle with unit tests for catalog/workflow data and an integration test that drives a feature run through the transition rule.
- Update `context-agent/wiki/code-map.md` during implementation for any new lifecycle modules.
### Non-goals

- Building the full orchestrator as the single authority for creating and transitioning runs.
- Running model sessions, invoking agents, or implementing the Runner boundary.
- Implementing human-in-the-loop message classification, directive normalization from free-form messages, or approval handling.
- Implementing the in-step implementer/reviewer convergence loop, max-round behavior, or feedback disposition checks at gates.
- Implementing the complexity classifier or finer implementation steps such as `implementation.define_classes` and `implementation.define_public_api`.
- Adding a workflow editing UI, tenant-defined workflow engine, or database-loaded workflow definitions.
- Opening pull requests, filing tracker issues, or running deterministic side effects for `pr.open` and `issues.file`.
### Personas

- **Enzo (Engineer)** needs one typed lifecycle module so later orchestration and runner code can move runs without duplicating step and workflow logic.
- **Phoebe (PM)** needs confidence that feature, enhancement, bug, chore, question, and file-issue runs follow product-approved paths.
- **Opal (Operator)** needs terminality and active-run behavior to be predictable from the current step.
- **Dani (Designer)** is not a direct user of this backend-only feature, but future run-status surfaces depend on stable lifecycle metadata.
### User stories

- As Enzo, I can import the step catalog and know each step's phase and `waiting_on` value from one source of truth.
- As Enzo, I can import workflow definitions and inspect each workflow's ordered path and transition table without reading branchy transition code.
- As Enzo, I can call `next(workflow, step, directive)` and receive the next step or a typed rejection for an invalid transition.
- As Enzo, I can start a run from `workKind` and see it pin the matching workflow at `intake`.
- As Enzo, I can apply a transition and see the run's `currentStep`, derived `terminal` value, and `RunStep` timeline update together.
- As Opal, I can trust that a run becomes inactive exactly when its current step has `waiting_on: none`.
- As Phoebe, I can see tests prove the feature workflow path, `revise` edges, human gates, and terminal behavior match the approved concepts.
### Acceptance criteria

#### Step catalog

- The step-primitives catalog exists as code.
- The catalog includes `intake`, `spec.author`, `spec.awaiting_input`, `spec.human_review`, `implementation.plan`, `implementation.build`, `implementation.awaiting_input`, `implementation.human_review`, `docs.update`, `docs.human_review`, `pr.finalize`, `pr.open`, `pr.human_review`, `issues.file`, `question.answer`, `done`, `canceled`, and `failed`.
- Each catalog entry declares an explicit `phase` and `waiting_on` value matching `context-human/concepts/run.md` and `context-human/concepts/workflow.md`.
- A test asserts every catalog entry's `phase` and `waiting_on` value.
- Behavioral sets derive from `waiting_on`: terminal steps are `none`, model-active steps are `ai`, and message-accepting steps are `human`.
- A test asserts those sets are derived from catalog data rather than maintained as independent step lists.
#### Workflow data

- The `feature` workflow is stored as data and follows this order: `intake -> spec.author -> spec.human_review -> implementation.plan -> implementation.build -> implementation.human_review -> docs.update -> docs.human_review -> pr.finalize -> pr.open -> pr.human_review -> done`.
- The `enhancement` workflow is stored as its own workflow data, even if its initial path matches `feature`.
- The `bug`, `chore`, `file_issue`, and `question` workflows are stored as data over the shared catalog.
- The `bug` workflow's ordinary `advance` path is exactly `intake -> spec.author -> implementation.plan -> implementation.build -> implementation.human_review -> docs.update -> pr.finalize -> pr.open -> pr.human_review -> done`.
- The `chore` workflow's ordinary `advance` path is exactly `intake -> implementation.plan -> implementation.build -> implementation.human_review -> docs.update -> pr.finalize -> pr.open -> pr.human_review -> done`.
- The `file_issue` workflow's ordinary `advance` path is exactly `intake -> spec.author -> issues.file -> done`, and the `question` workflow's ordinary `advance` path is exactly `intake -> question.answer -> done`.
- Workflows reference only steps that exist in the shared catalog.
- Tests assert each workflow's path and catalog references.
#### Transition rule

- `next(workflow, step, directive)` resolves transitions for `advance`, `revise`, `needs_input`, `cancel`, and `fail`.
- `cancel` always reaches `canceled`, and `fail` always reaches `failed` from non-terminal workflow steps.
- `needs_input` reaches the matching `*.awaiting_input` step where that workflow phase supports one.
- A run leaves `spec.awaiting_input` only by applying `advance`, which resumes at `spec.author`.
- A run leaves `implementation.awaiting_input` only by applying `advance`, which resumes at `implementation.build`.
- Workflows that can enter `spec.awaiting_input` are `feature`, `enhancement`, `bug`, and `file_issue`.
- Workflows that can enter `implementation.awaiting_input` are `feature`, `enhancement`, `bug`, and `chore`.
- Invalid directives for a workflow step return a typed error or rejected result that callers can handle without parsing strings.
- `revise` uses workflow table data for backward edges.
- Tests cover `advance`, `revise`, `needs_input`, `cancel`, and `fail` behavior across the supported workflows.
- Tests cover the important `revise` edges: ordinary review back to the producing step, `pr.finalize` back to `implementation.human_review`, and `docs.human_review` back to `docs.update`.
- Tests cover resuming from `spec.awaiting_input` and `implementation.awaiting_input` with `advance` for every workflow that can enter those pause steps.
#### Run state and step occurrences

- Starting a run resolves its workflow from `workKind`, pins that workflow for the run's life, and begins at the workflow's first step.
- Unknown `workKind` values are rejected.
- Starting a run creates the run and its initial `RunStep` occurrence through one persistence operation that runs in a database transaction.
- If either the run create or the initial `RunStep` insert fails, the start operation is not partially persisted.
- Applying a transition updates `runs.current_step` and sets `runs.terminal` from the destination step's `waiting_on` value.
- The one-active-run-per-topic partial index continues to work because `terminal` is synchronized with the catalog-derived terminal classification.
- Applying a transition writes a `RunStep` occurrence for the entered step in the same database transaction as the run-state update.
- If either the run-state update or the `RunStep` insert fails, the transition is not partially persisted.
- `RunStep` occurrence metadata includes deterministic `index` and `attempt` values for repeated visits, computed inside the same database transaction that inserts the occurrence.
- An integration test creates a `feature` run, drives it from `intake` to `done` with repeated `advance` plus one `revise`, asserts the current step after each transition, asserts the `RunStep` rows in order, proves human gates halt until another directive is applied, and proves the run becomes terminal at `done`.
## Design spec

### Design scope

This is a backend-only foundation feature. There is no visual UI, desktop interaction, or human-facing settings screen to design in this pass.
The design work is the service-facing experience for future orchestration code and developers: how lifecycle data is named, how transitions are requested, how errors are reported, and how persisted run state stays aligned with the catalog.
### Service experience

The lifecycle should feel like one small state machine with explicit data:
1. A caller starts a run with a persisted `workKind`.
2. The lifecycle resolves the matching workflow and pins that workflow identity for the run.
3. The run enters the workflow's first step, normally `intake`.
4. The lifecycle writes a `RunStep` occurrence for the entered step.
5. A caller applies a directive to the run's current step.
6. The transition rule looks up the edge in the pinned workflow.
7. The lifecycle updates `currentStep` and derived `terminal` together.
8. The lifecycle writes the next `RunStep` occurrence.
9. The caller decides what to do with the new step outside this feature.
This feature does not dispatch work for `ai` or `system` steps. It only records where the run is and what the next step is when a directive is applied.
### Catalog behavior

The step catalog is the shared vocabulary every workflow composes. Each entry should expose:
- `id`: the durable step string stored in `runs.current_step` and `run_steps.step`.
- `phase`: `spec`, `implementation`, `docs`, `pr`, or `null` for phase-less steps.
- `waitingOn`: `system`, `ai`, `human`, or `none`.
- `roles`: the roles the step can carry, where the workflow concept already fixes them.
The catalog should derive helper sets from `waitingOn`:
- `terminalSteps`: all entries where `waitingOn === 'none'`.
- `modelActiveSteps`: all entries where `waitingOn === 'ai'`.
- `messageAcceptingSteps`: all entries where `waitingOn === 'human'`.
Those helpers may be exported for readability, but they must be computed from catalog data. They must not be source-of-truth lists.
### Workflow behavior

A workflow is data over the catalog. It needs enough information to support the transition rule and later orchestration:
- `id`: `feature`, `enhancement`, `bug`, `chore`, `file_issue`, or `question`.
- `workKind`: the stored run work kind that resolves to this workflow.
- `artifactKind`: for workflows that author an artifact in this initial catalog, the artifact kind this workflow produces.
- `steps`: the ordered path for ordinary `advance` behavior.
- `transitions`: directive-specific edges, including backward `revise` edges.
The initial workflows should be plain TypeScript data, not database rows or configuration files. That keeps this feature aligned with ADR-025: steps are code and workflows are data, while a configurable workflow engine remains a future additive change.
### Transition behavior

The transition function should be deterministic and side-effect free:
```typescript
nextWorkflowStep(workflow, currentStep, directive) -> TransitionResult
```
A successful result contains the current step, directive, and next step. A failed result identifies the invalid workflow, step, directive, or missing edge. Callers should not parse error message strings to decide what happened.
The stateful lifecycle service should wrap that pure function. At start, it asks persistence to create the run and initial `RunStep` occurrence atomically. On directive application, it reads the current run, verifies the pinned workflow, computes the next step, and asks persistence to update persisted run state and write the destination `RunStep` occurrence atomically.
### Human gates and pauses

Human gates are ordinary steps with `waitingOn: human`. This feature should not implement approval semantics, open-feedback checks, or message classification. A caller must explicitly apply another directive to leave a human step.
`needs_input` is different from a phase gate. It routes to a within-phase `*.awaiting_input` step when the workflow has one for the current phase. If no matching pause exists in that workflow, the transition should be invalid rather than inventing a new step.
Pause exit behavior is explicit and table-driven:
- `feature`, `enhancement`, `bug`, and `file_issue` may enter `spec.awaiting_input` from `spec.author` via `needs_input`; `advance` from `spec.awaiting_input` resumes at `spec.author`.
- `feature`, `enhancement`, `bug`, and `chore` may enter `implementation.awaiting_input` from `implementation.build` via `needs_input`; `advance` from `implementation.awaiting_input` resumes at `implementation.build`.
- `question` has no `needs_input` pause edge in this feature; a `needs_input` directive in the `question` workflow is invalid.
- `revise`, `needs_input`, `cancel`, and `fail` remain available or invalid from pause steps only according to the workflow transition table plus universal non-terminal `cancel`/`fail` behavior. The only product-approved resume directive from a pause step is `advance`.
### Terminal behavior

The persisted `terminal` boolean remains because the existing partial unique index depends on it. This feature changes how code sets it: the value must be derived from the destination catalog entry.
- Destination step `done`, `canceled`, or `failed` sets `terminal: true`.
- Any destination step with `waitingOn` other than `none` sets `terminal: false`.
- Callers should not pass an independent terminal value when applying lifecycle transitions.
This reconciles the temporary comment in `packages/api-contract/src/run.ts` without requiring a schema migration.
### Empty state

A repository with no runs or run steps is valid. The catalog and workflow data exist in code and do not require seeded database data.
Starting the first run for a topic should work as long as the topic exists and no other non-terminal run violates the existing partial unique index.
### Error handling

Lifecycle errors should be explicit enough for callers and tests:
- Unknown work kind.
- Unknown workflow id.
- Unknown step id.
- Step not present in the pinned workflow.
- Directive not valid for the current workflow step.
- Missing pause target for `needs_input`.
- Attempt to transition a terminal run.
- Missing run when applying a transition.
Use these exact error-code taxonomies in code and tests:
```typescript
export type TransitionErrorCode =
  | 'unknown_workflow'
  | 'unknown_step'
  | 'step_not_in_workflow'
  | 'terminal_step'
  | 'invalid_directive'
  | 'missing_edge'
  | 'missing_pause_target';

export type RunLifecycleErrorCode =
  | 'unknown_work_kind'
  | 'unknown_workflow'
  | 'missing_run'
  | 'terminal_run'
  | 'invalid_transition'
  | 'start_persistence_failed'
  | 'transition_persistence_failed';
```
Map failures to those codes as follows:
- Unknown work kind while starting or resolving a run maps to `RunLifecycleErrorCode: 'unknown_work_kind'`.
- Unknown workflow id maps to `TransitionErrorCode: 'unknown_workflow'` in the pure transition rule and `RunLifecycleErrorCode: 'unknown_workflow'` when raised by lifecycle workflow resolution.
- Unknown step id maps to `TransitionErrorCode: 'unknown_step'`.
- A known step that is not present in the pinned workflow maps to `TransitionErrorCode: 'step_not_in_workflow'`.
- A directive value outside the supported directive enum maps to `TransitionErrorCode: 'invalid_directive'`.
- A supported directive with no configured edge from the current workflow step maps to `TransitionErrorCode: 'missing_edge'`, except `needs_input` with no phase-local pause target maps to `TransitionErrorCode: 'missing_pause_target'`.
- An attempt to transition from a terminal step maps to `TransitionErrorCode: 'terminal_step'` in the pure transition rule and `RunLifecycleErrorCode: 'terminal_run'` when lifecycle rejects an already-terminal persisted run.
- Missing run while applying a directive maps to `RunLifecycleErrorCode: 'missing_run'`.
- Any transition-rule failure surfaced by `applyRunDirective` maps to `RunLifecycleErrorCode: 'invalid_transition'` and carries the original `TransitionErrorCode` as structured detail.
- A failed atomic start write maps to `RunLifecycleErrorCode: 'start_persistence_failed'`; a failed atomic directive write maps to `RunLifecycleErrorCode: 'transition_persistence_failed'`.
Repository constraint failures, such as the one-active-run-per-topic index, can continue to surface as repository/database errors unless an existing persistence convention already wraps them.
## Tech spec

### Current state

The domain schema from issue 11 already stores the lifecycle fields this feature needs:
- `packages/api-contract/src/run.ts` defines `Run` and `CreateRunInput` with `workKind`, `currentStep`, and `terminal`.
- `packages/api-contract/src/run-step.ts` defines `RunStep` and `CreateRunStepInput` with `phase`, `step`, `role`, and `occurrence`.
- `packages/core/src/domain-repositories.ts` exposes `RunRepository` and `RunStepRepository` interfaces with create/find/list methods.
- `packages/persistence/src/domain-repositories.ts` implements those interfaces against the Drizzle schema.
- `packages/persistence/src/schema.ts` keeps the `runs_one_active_per_topic` partial unique index keyed on `terminal = 0`.
The main gap is lifecycle-owned mutation. `RunRepository` can create and read runs and `RunStepRepository` can create rows, but starting a lifecycle run must create the run and its first `RunStep` occurrence as one durable write, and lifecycle transitions need to advance `currentStep`, update derived `terminal`, and insert the destination `RunStep` occurrence as one durable write. This feature should add narrow persistence-owned transaction methods for those lifecycle writes rather than exposing broad update behavior or sequencing independent repository calls.
### Proposed package shape

Keep this feature inside existing packages.
- `packages/api-contract/` owns shared literal schemas and inferred types only if lifecycle concepts need to cross package boundaries.
- `packages/core/` owns the step catalog, workflow data, pure transition rule, lifecycle use cases, and repository interfaces.
- `packages/persistence/` owns the concrete transaction methods that create a run with its initial run step and update a run with its corresponding transition run step.
- `apps/control-plane/` should not need public route changes for this feature.
- `packages/sdk/` should not need changes because no public API route is added.
Suggested new core modules:
- `packages/core/src/run-step-catalog.ts`
- `packages/core/src/run-workflows.ts`
- `packages/core/src/run-transition.ts`
- `packages/core/src/run-lifecycle.ts`
Export the public types and functions from `packages/core/src/index.ts`.
### API contract types

Add shared schemas in `packages/api-contract/src/run-lifecycle.ts` only if implementation needs these types outside core. Candidate schemas:
```typescript
const runStepIdSchema = z.string().min(1);
const runWorkflowIdSchema = z.enum(['feature', 'enhancement', 'bug', 'chore', 'file_issue', 'question']);
const runDirectiveSchema = z.enum(['advance', 'revise', 'needs_input', 'cancel', 'fail']);
const waitingOnSchema = z.enum(['system', 'ai', 'human', 'none']);
const runPhaseSchema = z.enum(['spec', 'implementation', 'docs', 'pr']).nullable();
```
If those values remain internal to core for this feature, define them in core and avoid widening the API contract prematurely. Do not replace `runWorkKindSchema` with a closed enum unless the implementation intentionally rejects all custom work kinds at the lifecycle boundary while preserving the stored string shape.
### Step catalog model

Represent the catalog as readonly TypeScript data with strongly typed ids. A representative shape:
```typescript
export type RunPhase = 'spec' | 'implementation' | 'docs' | 'pr' | null;
export type WaitingOn = 'system' | 'ai' | 'human' | 'none';
export type RunStepRole = 'implementer' | 'reviewer';

export interface RunStepDefinition {
  id: RunStepId;
  phase: RunPhase;
  waitingOn: WaitingOn;
  roles: readonly RunStepRole[];
}
```
Use the concept docs as the source for role metadata:
- `spec.author`: `implementer`, `reviewer`
- `implementation.plan`: `implementer`
- `implementation.build`: `implementer`, `reviewer`
- `docs.update`: `implementer`
- `pr.finalize`: `reviewer`
- `question.answer`: `implementer`
- System, human, and terminal steps: no model role
For `RunStep` rows created directly by lifecycle entry rather than model-session execution, use a consistent role value. Because `sessionRoleSchema` accepts snake_case strings, `none` is acceptable for system, human, and terminal entry rows. Model-session rows can later use the actual role when runner execution lands.
### Workflow data model

Represent each workflow as readonly data that references catalog step ids. A representative shape:
```typescript
export type RunWorkflowId = 'feature' | 'enhancement' | 'bug' | 'chore' | 'file_issue' | 'question';
export type RunDirective = 'advance' | 'revise' | 'needs_input' | 'cancel' | 'fail';

export interface RunWorkflowDefinition {
  id: RunWorkflowId;
  workKind: string;
  artifactKind?: 'feature_spec' | 'enhancement_spec' | 'bug_triage';
  steps: readonly RunStepId[];
  transitions: Readonly>>>;
}
```
`feature`, `enhancement`, and `bug` must declare their artifact kinds (`feature_spec`, `enhancement_spec`, and `bug_triage` respectively). `chore`, `file_issue`, and `question` do not need an `artifactKind` in this initial catalog because this issue follows the active workflow concept's lighter chore path straight into implementation rather than adding a spec-authoring phase for chores.
Generate ordinary `advance` edges from `steps` where practical, then overlay explicit edges for `revise`, `needs_input`, and pause resumes. Keep `revise` and pause-resume edges in the workflow data. Do not bury special cases in the transition function. `cancel` and `fail` are universal in `nextWorkflowStep` for every non-terminal workflow-owned step and do not need to be repeated in sparse workflow tables.
For the initial workflows, align the ordinary `advance` paths with the active run and workflow concepts:
- `feature`: `intake -> spec.author -> spec.human_review -> implementation.plan -> implementation.build -> implementation.human_review -> docs.update -> docs.human_review -> pr.finalize -> pr.open -> pr.human_review -> done`.
- `enhancement`: its own workflow data; for this feature its ordinary path matches `feature`.
- `bug`: `intake -> spec.author -> implementation.plan -> implementation.build -> implementation.human_review -> docs.update -> pr.finalize -> pr.open -> pr.human_review -> done`.
- `chore`: `intake -> implementation.plan -> implementation.build -> implementation.human_review -> docs.update -> pr.finalize -> pr.open -> pr.human_review -> done`.
- `file_issue`: `intake -> spec.author -> issues.file -> done`.
- `question`: `intake -> question.answer -> done`.
The `bug` and `chore` paths intentionally have fewer convergence gates than `feature`: `bug` keeps triage authoring but skips the spec and docs human-review gates, while `chore` takes the short path straight into implementation and also skips the docs human-review gate. All implementing workflows still carry implementation, docs, and pr phases. Do not add new step primitives.
Each workflow's transition table must include the following edges where the referenced source step is workflow-owned:
- Ordinary review `revise` edges:
	- `spec.human_review --revise--> spec.author` for `feature` and `enhancement`.
	- `implementation.human_review --revise--> implementation.build` for `feature`, `enhancement`, `bug`, and `chore`.
	- `docs.human_review --revise--> docs.update` for `feature` and `enhancement`.
	- `pr.human_review --revise--> pr.finalize` for `feature`, `enhancement`, `bug`, and `chore`.
- Special revise edge:
	- `pr.finalize --revise--> implementation.human_review` for `feature`, `enhancement`, `bug`, and `chore`.
- Pause-entry and pause-resume edges:
	- `spec.author --needs_input--> spec.awaiting_input` and `spec.awaiting_input --advance--> spec.author` for `feature`, `enhancement`, `bug`, and `file_issue`.
	- `implementation.build --needs_input--> implementation.awaiting_input` and `implementation.awaiting_input --advance--> implementation.build` for `feature`, `enhancement`, `bug`, and `chore`.
Pause steps are workflow-owned for transition validation when they appear as a transition table key or destination, even though they are not part of the ordinary `advance` path in `steps`.
### Transition rule

Implement a pure transition function in core. Suggested API:
```typescript
export type TransitionErrorCode =
  | 'unknown_workflow'
  | 'unknown_step'
  | 'step_not_in_workflow'
  | 'terminal_step'
  | 'invalid_directive'
  | 'missing_edge'
  | 'missing_pause_target';

export type TransitionResult =
  | { ok: true; workflowId: RunWorkflowId; from: RunStepId; directive: RunDirective; to: RunStepId }
  | { ok: false; code: TransitionErrorCode; message: string };

export function nextWorkflowStep(
  workflow: RunWorkflowDefinition,
  currentStep: string,
  directive: RunDirective
): TransitionResult;
```
The function should:
1. Verify the current step exists in the catalog.
2. Verify the current step belongs to the workflow, either in the ordinary `steps` path or as an explicit transition-table source/destination such as `spec.awaiting_input` or `implementation.awaiting_input`.
3. Reject transitions out of terminal steps.
4. Resolve `cancel` and `fail` consistently to terminal steps for non-terminal current steps.
5. Resolve all other directives from workflow transition data.
6. Verify the destination step exists in the catalog and belongs to the workflow or is one of the shared terminal steps.
7. Return the exact `TransitionErrorCode` values defined in Error handling; callers should never infer the case from `message`.
### Lifecycle use cases

Add core lifecycle use cases around the pure transition rule. Suggested functions:
```typescript
export async function startRunLifecycle(input: StartRunLifecycleInput): Promise;
export async function applyRunDirective(input: ApplyRunDirectiveInput): Promise;
```
`startRunLifecycle` should:
- Resolve workflow data from `workKind`.
- Build the initial run payload at the workflow's first step.
- Set `terminal` from that first step's `waitingOn` value.
- Ask persistence to create the run and initial `RunStep` occurrence atomically.
- Return the run, workflow id, step definition, and created run step.
`applyRunDirective` should:
- Load the run.
- Resolve the pinned workflow from the run's `workKind`.
- Reject missing or terminal runs.
- Call `nextWorkflowStep`.
- Build the destination `RunStep` payload fields other than occurrence counts.
- Persist `currentStep`, derived `terminal`, and the destination `RunStep` occurrence through one persistence method that computes occurrence counts and inserts the row in a database transaction.
- Return the updated run, workflow id, step definition, transition result, and created run step.
This feature can use `workKind` as the pinned workflow identity because the existing schema does not have a separate workflow-id column. Do not mutate `workKind` during lifecycle transitions. If implementation discovers that a distinct persisted `workflowId` is necessary to satisfy pinning, add a migration only after documenting why `workKind` is insufficient.
### Repository changes

Extend the core repository boundary narrowly with lifecycle-recording methods. The methods may live on `RunRepository` or on a small lifecycle-specific repository interface, but they must be implemented in `packages/persistence` using the existing better-sqlite3/Drizzle transaction support.
```typescript
recordRunLifecycleStart(input: {
  run: CreateRunInput;
  runStep: Omit;
}): Promise;

recordRunStepTransition(input: {
  runId: string;
  currentStep: string;
  terminal: boolean;
  runStep: Omit;
}): Promise;
```
Implement `recordRunLifecycleStart` by opening a synchronous Drizzle transaction, inserting the run, computing the initial occurrence for that new run, inserting the initial `run_steps` row, validating both returned rows, and committing only if both writes succeed. If either write fails, the transaction must roll back so callers never observe a run without its initial occurrence row.
Implement `recordRunStepTransition` by opening a synchronous Drizzle transaction, updating `runs.current_step`, `runs.terminal`, and `runs.updated_at`, computing the destination occurrence counts from rows visible inside that same transaction, inserting the destination `run_steps` row, validating both returned rows, and committing only if both writes succeed. If either write fails, the transaction must roll back so callers never observe a run advanced without its matching occurrence row.
Keep create/read behavior unchanged. Avoid a broad generic update method unless existing repository conventions require it; lifecycle code only needs these atomic lifecycle writes.
### RunStep occurrence indexing

`RunStep.occurrence.index` should be deterministic. For this feature, derive it from existing rows for the run inside the same database transaction that inserts the `RunStep` row:
- `index`: count of existing `RunStep` rows for the run before inserting the new one.
- `attempt`: one plus the number of existing rows for the same `runId` and `step`.
- `key`: optional; omit unless implementation has a stable key to add.
The lifecycle layer may decide the destination step, phase, role, and timestamps, but it must not precompute `index` or `attempt` in a separate read before calling persistence. This feature relies on the persistence transaction as the concurrency boundary for deterministic occurrence values.
Use the destination step's catalog `phase`. Use `role: 'none'` for lifecycle entry rows that are not tied to a model role. Use `startedAt` as the transition time, `endedAt: null`, and `durationMs: null` unless the implementation has an existing convention for instantaneous system rows.
### Persistence and migrations

No schema migration is required if lifecycle pinning uses existing `work_kind`, `current_step`, and `terminal` fields.
If implementation adds a `workflow_id` column, it must include a committed Drizzle migration and update API-contract schemas, repository mappers, tests, and context docs. That should be avoided unless required because the current issue asks for lifecycle logic over existing tables.
### OpenAPI and SDK

No OpenAPI or SDK changes are proposed. This feature adds internal lifecycle behavior, not a public HTTP route.
If implementation adds a diagnostic or transition route for tests, define the request and response schemas in `packages/api-contract`, generate OpenAPI from those schemas, and update the SDK from the same contract. Do not hand-author duplicate route types.
### Testing

Add focused unit tests first, then integration tests.
Core unit tests should cover:
- Catalog entries and derived behavioral sets.
- Workflow paths and catalog references.
- `advance` through the feature path.
- `revise` edges, including ordinary producing-step revision, `pr.finalize -> implementation.human_review`, and `docs.human_review -> docs.update`.
- `needs_input` edges for spec and implementation phases.
- `advance` resume edges from `spec.awaiting_input` and `implementation.awaiting_input` for every workflow that can enter those pause steps.
- `cancel` and `fail` from non-terminal steps.
- Invalid workflow, step, and directive results.
- Rejection when transitioning from terminal steps.
Persistence tests should cover:
- The start recording method inserts the run, computes and inserts the initial `RunStep`, and returns both validated rows.
- A forced initial `RunStep` insert failure rolls back the run insert so no start is partially recorded.
- The transition recording method updates `currentStep`, derived `terminal`, and `updatedAt`, inserts the matching `RunStep`, and returns both validated rows.
- A forced insert failure rolls back the run update so no transition is partially recorded.
- The one-active-run-per-topic partial index still allows a new run after a previous run reaches a `waitingOn: none` step.
Integration tests should cover:
- Starting a feature run at `intake`.
- Driving it through the feature workflow with repeated `advance` plus one `revise`.
- Seeing human gates hold until a caller applies another directive.
- Recording `RunStep` rows in deterministic order with expected `phase`, `step`, `role`, `index`, and `attempt`.
- Ending at `done` with `terminal: true`.
Run targeted checks during implementation:
```bash
pnpm nx test core
pnpm nx test persistence
pnpm nx test api-contract
```
Run broader validation if touched packages or generated artifacts warrant it:
```bash
pnpm validate
```
### Documentation updates

During implementation, update `context-agent/wiki/code-map.md` with the new lifecycle modules and repository method. Human-owned concept docs and ADRs already describe the target model and do not need changes unless implementation discovers a mismatch.
### Risks and open decisions

- **Workflow pinning storage:** using `workKind` as the pinned workflow identity should be enough for this feature. If future work allows workflow versions or tenant-configured workflows, a separate persisted workflow id/version will be needed.
- **Atomicity:** creating a run and its initial `RunStep`, and updating `runs.current_step` with the destination `RunStep`, are required to be atomic for this feature. Occurrence counts must be computed inside those transactions. If implementation discovers an unexpected blocker in the existing persistence abstraction, stop and revise the spec rather than shipping a known integrity gap.
- **Bug and chore depth:** this spec gives `bug` and `chore` fewer convergence gates than `feature` and `enhancement` to match the active concepts. The exact paths here are starting points to tune; future decisions may add finer implementation-depth workflow data after ADR-025's deferred implementation-depth work.
- **Provider behavior:** this feature does not interact with providers, adapter composition, model routing, or runner execution.
## Task list

### Story 1: Define the run step catalog

#### Task 1.1: Add the typed catalog module

**Description:** Create `packages/core/src/run-step-catalog.ts` with the approved step ids, phase values, `waitingOn` values, role metadata, lookup helpers, and derived behavioral sets.
**Acceptance criteria:**
- `runStepCatalog` and `runStepDefinitions` contain exactly the step ids listed in the acceptance criteria.
- Every entry declares `phase`, `waitingOn`, and `roles` according to the tech spec.
- `terminalSteps`, `modelActiveSteps`, and `messageAcceptingSteps` are computed from `waitingOn`.
- `getRunStepDefinition`, `isKnownRunStepId`, and `deriveRunTerminal` are exported with strongly typed signatures.
**Dependencies:** None.
#### Task 1.2: Test catalog metadata and derived sets

**Description:** Add core unit tests that lock the catalog values and prove behavioral sets are derived from catalog data.
**Acceptance criteria:**
- Tests assert each catalog entry's `phase` and `waitingOn` value.
- Tests assert terminal steps are exactly entries where `waitingOn === 'none'`.
- Tests assert model-active steps are exactly entries where `waitingOn === 'ai'`.
- Tests assert message-accepting steps are exactly entries where `waitingOn === 'human'`.
**Dependencies:** Task 1.1.
### Story 2: Represent workflows as data

#### Task 2.1: Add workflow definitions and lookup helpers

**Description:** Create `packages/core/src/run-workflows.ts` with workflow-as-data definitions for `feature`, `enhancement`, `bug`, `chore`, `file_issue`, and `question`.
**Acceptance criteria:**
- `feature` follows the approved full path from `intake` through `done`.
- `enhancement` has its own workflow definition even if its first path matches `feature`.
- `file_issue` follows `intake -> spec.author -> issues.file -> done`.
- `question` follows `intake -> question.answer -> done`.
- `bug` follows exactly `intake -> spec.author -> implementation.plan -> implementation.build -> implementation.human_review -> docs.update -> pr.finalize -> pr.open -> pr.human_review -> done`.
- `chore` follows exactly `intake -> implementation.plan -> implementation.build -> implementation.human_review -> docs.update -> pr.finalize -> pr.open -> pr.human_review -> done`.
- `feature`, `enhancement`, and `bug` declare artifact kinds matching the artifact they produce.
- `chore` does not declare an artifact kind in this initial catalog because its path starts in implementation.
- All workflows expose `steps` and sparse transition-table data through core exports.
- `getRunWorkflowById`, `getRunWorkflowForWorkKind`, and `isKnownRunWorkflowId` are exported with strongly typed signatures.
**Dependencies:** Task 1.1.
#### Task 2.2: Encode revise and needs-input edges in workflow data

**Description:** Add directive-specific transition data for backward `revise` behavior and phase-local `needs_input` pauses without adding special cases to the transition function.
**Acceptance criteria:**
- Ordinary review steps have `revise` edges back to their producing steps.
- `pr.finalize` revises to `implementation.human_review`.
- `docs.human_review` revises to `docs.update`.
- `feature`, `enhancement`, `bug`, and `file_issue` route `spec.author --needs_input--> spec.awaiting_input` and resume with `spec.awaiting_input --advance--> spec.author`.
- `feature`, `enhancement`, `bug`, and `chore` route `implementation.build --needs_input--> implementation.awaiting_input` and resume with `implementation.awaiting_input --advance--> implementation.build`.
- `question` has no `needs_input` edge.
- Workflows do not reference steps outside the shared catalog.
**Dependencies:** Task 2.1.
#### Task 2.3: Test workflow paths and references

**Description:** Add core unit tests for every workflow path, lookup helper, and catalog reference.
**Acceptance criteria:**
- Tests assert the exact `feature`, `enhancement`, `file_issue`, and `question` paths.
- Tests assert the exact `bug` and `chore` paths.
- Tests fail if any workflow step or transition destination is missing from the catalog, except shared terminal destinations that are also catalog entries.
- Tests verify work-kind lookup rejects unknown work kinds.
**Dependencies:** Task 2.1, Task 2.2.
### Story 3: Implement the pure transition rule

#### Task 3.1: Add `nextWorkflowStep`

**Description:** Create `packages/core/src/run-transition.ts` with the side-effect-free transition function and typed success/failure results.
**Acceptance criteria:**
- The function verifies that the workflow id is known.
- The function verifies that `currentStep` exists in the catalog.
- The function verifies that `currentStep` belongs to the workflow, either in the ordinary path or as a transition-table-owned pause step.
- The function rejects transitions out of terminal steps.
- `cancel` resolves to `canceled` and `fail` resolves to `failed` from any non-terminal workflow step before transition-table lookup.
- `advance`, `revise`, and `needs_input` resolve through workflow transition data.
- Missing table edges return `missing_edge`; unrecognized or invalid directives return `invalid_directive`; supported `needs_input` directives with no phase-local pause target return `missing_pause_target`.
- Destination steps are validated against the catalog and workflow membership rules in the tech spec.
**Dependencies:** Task 1.1, Task 2.1, Task 2.2.
#### Task 3.2: Test transition behavior

**Description:** Add core unit tests that exercise valid and invalid transition paths across the supported workflows.
**Acceptance criteria:**
- Tests cover ordinary `advance` through the feature path.
- Tests cover ordinary `revise` edges, `pr.finalize -> implementation.human_review`, and `docs.human_review -> docs.update`.
- Tests cover `needs_input` for supported phases and invalid `needs_input` where no pause target exists.
- Tests cover `advance` resume from `spec.awaiting_input` and `implementation.awaiting_input` for every workflow that can enter those pause steps.
- Tests cover universal `cancel` and `fail` from non-terminal steps.
- Tests cover unknown workflow, unknown step, step-not-in-workflow, terminal-step, invalid-directive, missing-edge, and missing-pause-target failures.
**Dependencies:** Task 3.1.
### Story 4: Add lifecycle use cases around persisted runs

#### Task 4.1: Extend the core repository interface

**Description:** Add narrow lifecycle-recording repository methods to `packages/core/src/domain-repositories.ts` so lifecycle code can request one atomic write for run creation plus initial `RunStep` insert, and one atomic write for run update plus destination `RunStep` insert.
**Acceptance criteria:**
- The start input includes only the `CreateRunInput` and initial `RunStep` fields that cannot be derived inside persistence.
- The transition input includes only the target run id, destination `currentStep`, catalog-derived `terminal`, and destination `RunStep` fields that cannot be derived inside persistence.
- Occurrence `index` and `attempt` are omitted from lifecycle repository inputs and computed inside the persistence transaction.
- Each method returns the persisted `Run` and created `RunStep`.
- Existing repository methods remain unchanged.
**Dependencies:** None.
#### Task 4.2: Implement the atomic persistence transition method

**Description:** Implement the lifecycle-recording methods in `packages/persistence/src/domain-repositories.ts` using Drizzle transactions over better-sqlite3.
**Acceptance criteria:**
- The start method inserts the run and initial `RunStep` in the same transaction.
- If the initial `RunStep` insert fails, the run insert is rolled back.
- The transition method updates `current_step`, `terminal`, and `updated_at`.
- The transition method computes occurrence `index` and `attempt` from rows visible inside the transaction and inserts the supplied `RunStep` row in that same transaction.
- The transition method returns the validated `Run` and validated `RunStep`.
- The transition method throws an error when the target run does not exist.
- If the transition `RunStep` insert fails, the run update is rolled back.
- Existing create/read/list behavior remains unchanged.
**Dependencies:** Task 4.1.
#### Task 4.3: Add lifecycle entry and transition use cases

**Description:** Create `packages/core/src/run-lifecycle.ts` with `startRunLifecycle`, `applyRunDirective`, `RunLifecycleError`, and related types.
**Acceptance criteria:**
- `startRunLifecycle` resolves the workflow from `workKind`, builds the run at the workflow first step, derives `terminal`, records the run and initial `RunStep` through the atomic start persistence method, and returns `RunLifecycleState`.
- `applyRunDirective` loads the run, resolves the pinned workflow from `workKind`, rejects missing or terminal runs, calls `nextWorkflowStep`, builds the destination entry row fields that are not occurrence counts, records the run update and destination `RunStep` through the atomic transition persistence method, and returns `RunLifecycleState`.
- Unknown work kinds, unknown workflows, missing runs, terminal runs, invalid transitions, and lifecycle persistence failures use the exact `RunLifecycleErrorCode` values from the Error handling section.
- There is no two-call run-create-plus-run-step-insert sequence in `startRunLifecycle`; tests prove the persistence method is atomic.
- There is no two-call run-update-plus-run-step-insert sequence in `applyRunDirective`; tests prove the persistence method is atomic.
**Dependencies:** Task 1.1, Task 2.1, Task 3.1, Task 4.1.
#### Task 4.4: Compute deterministic `RunStep` occurrence metadata

**Description:** Add the lifecycle helper logic needed to create entry `RunStep` rows with stable `index` and `attempt` values.
**Acceptance criteria:**
- `index` equals the count of existing `RunStep` rows for the run before insertion, computed inside the inserting transaction.
- `attempt` equals one plus the number of existing rows for the same run and step, computed inside the inserting transaction.
- Entry rows use the destination catalog `phase`.
- Entry rows use `role: 'none'`.
- Entry rows set `startedAt` from the provided clock or current time, and leave `endedAt` and `durationMs` empty unless existing conventions require otherwise.
**Dependencies:** Task 4.3.
#### Task 4.5: Test lifecycle and persistence behavior

**Description:** Add unit or integration-level tests for lifecycle use cases and the persistence repository update method.
**Acceptance criteria:**
- Persistence tests prove the transition-recording method updates `currentStep`, `terminal`, and `updatedAt` and inserts the destination `RunStep`.
- Persistence tests prove a failed `RunStep` insert rolls back the run update.
- Lifecycle tests prove unknown work kinds are rejected on start.
- Lifecycle tests prove missing runs, terminal runs, and invalid transitions are rejected on directive application.
- Persistence tests prove the start-recording method inserts the run and initial `RunStep` atomically.
- Persistence tests prove a failed initial `RunStep` insert rolls back the run insert.
- Lifecycle tests prove start and transition operations write `RunStep` rows with deterministic `index` and `attempt`.
- Tests cover the one-active-run-per-topic index by showing a new run is allowed after a previous run reaches a `waitingOn: none` step.
**Dependencies:** Task 4.2, Task 4.3, Task 4.4.
### Story 5: Export lifecycle APIs and keep docs current

#### Task 5.1: Re-export lifecycle APIs from core

**Description:** Update `packages/core/src/index.ts` to expose the catalog, workflow, transition, lifecycle, and repository types and values introduced by this feature.
**Acceptance criteria:**
- Value exports include the lifecycle catalog, workflow, transition, repository, and `RunLifecycleError` values introduced by this feature.
- Type exports use explicit `export type` blocks consistent with the existing index pattern.
- Downstream imports can use the core package entrypoint for the lifecycle API surface.
**Dependencies:** Task 1.1, Task 2.1, Task 3.1, Task 4.1, Task 4.3.
#### Task 5.2: Update agent navigation docs

**Description:** Update `context-agent/wiki/code-map.md` with the new lifecycle modules and atomic transition-recording persistence method.
**Acceptance criteria:**
- The code map points future agents to the catalog, workflow, transition, lifecycle, and persistence update locations.
- The update is limited to agent-owned documentation.
**Dependencies:** Task 5.1.
### Story 6: Prove the feature workflow end to end

#### Task 6.1: Add the feature-run integration test

**Description:** Add an integration test that creates a feature run and drives it through the approved lifecycle using repeated `advance` plus one `revise`.
**Acceptance criteria:**
- The run starts at `intake` with the resolved `feature` workflow.
- The test asserts the current step after each directive.
- Human gates hold until the caller applies another directive.
- One `revise` edge is exercised and then the run advances again.
- `RunStep` rows appear in deterministic order with expected `phase`, `step`, `role`, `index`, and `attempt`.
- The run ends at `done` with `terminal: true`.
**Dependencies:** Task 4.5, Task 5.1.
#### Task 6.2: Run targeted validation

**Description:** Run the relevant package checks and fix failures caused by this feature.
**Acceptance criteria:**
- `pnpm nx test core` passes.
- `pnpm nx test persistence` passes.
- `pnpm nx test api-contract` passes, or is documented as not needed because no api-contract files changed.
- `pnpm validate` passes, or any inability to run it is documented with the exact reason.
**Dependencies:** Task 6.1, Task 5.2.