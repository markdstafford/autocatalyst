---
created: 2026-06-11
last_updated: 2026-06-12
status: complete
issue: 39
specced_by: autocatalyst
---
# Feature: Spec artifact authoring, first-class feedback, and the spec review gate

## Product requirements

### What

When a feature or enhancement run reaches `spec.author`, Autocatalyst dispatches the agent with the `mm:planning` skill materialized into its session, receives a validated structured result, commits the authored spec under `context-human/specs/`, records a file-canonical spec `Artifact`, and pauses the run at `spec.human_review` with `waiting_on: human`. A reviewer can create structured `Feedback` against the spec artifact, including reopening a `wont_fix` item. The run cannot advance out of the spec review gate while feedback for the artifact target is still open or addressed-but-unconfirmed.
### Why

This is the first producing run step that turns Autocatalyst from a lifecycle shell into a system that creates durable work. Existing issues established the runner boundary, runtime skills catalog, step-result tolerance pipeline, workflows, orchestration, Artifact records, and Feedback records. This feature connects those pieces into the file-canonical spec path so a real feature or enhancement run produces the committed planning artifact that later implementation steps build from.
### Goals

- A feature or enhancement run at `spec.author` starts an agent session with `mm:planning` resolved and materialized through the existing runtime skills path.
- The agent result for `spec.author` is checked through a registered step-result contract before any file, commit, Artifact, or run transition is recorded.
- A valid file-canonical spec is committed under `context-human/specs/` with frontmatter that satisfies the committed spec-frontmatter contract.
- The run records one spec-kind `Artifact` for the committed file, using `kind` from the workflow and `canonicalRecord: file`.
- The run pauses at `spec.human_review` after the spec commit and reports that it is waiting on a human.
- Reviewers can create, address, resolve, mark `wont_fix`, and reopen `Feedback` for `target: artifact`.
- The spec gate refuses an advance while any artifact-target feedback for the run is `open` or addressed-but-unconfirmed by someone other than the approving reviewer. On approval, the approver's own `addressed` items are co-resolved in the same action before the guard runs.
- Explicit approval at `spec.human_review` first co-resolves the approver's own `addressed` feedback, then updates and commits the spec frontmatter from `status: draft` to `status: approved` before the run advances to `implementation.plan`.
- Integration coverage proves the full path from run creation through dispatch, committed spec file, Artifact persistence, human gate pause, feedback blocking, and feedback unblocking.
### Non-goals

- In-step adversarial convergence between implementer and reviewer roles for `spec.author`.
- Human reply classification that turns free-form messages into `advance` or `revise` directives.
- Re-dispatching `spec.author` to revise the spec after gate feedback.
- Automatically changing spec body content in response to artifact feedback. This slice records and dispositions feedback, but it cannot amend the generated spec content beyond the explicit approval-status frontmatter update.
- Public HTTP routes for feedback lifecycle operations. This slice proves creation, transition, reopening, co-resolution, and gate behavior through core service/use-case and repository seams; a later API slice may expose those use cases through `/v1` routes.
- Spec amendment during implementation.
- Supersession through `supersedes` and `superseded_by`.
- Bug triage, chore plans, and file-issue authoring.
- Reading `docs_root` from `mm.toml`; this slice uses the hard-coded `context-human/specs/` path.
- Desktop, mobile, or web UI for artifact review.
- Opening PRs, pushing branches, merging, or managing branch lifecycle outside the existing run workspace owner.
### Personas

#### Phoebe

- **Role:** Product or project owner reviewing a generated spec.
- **Cares about:** A concrete spec she can read, comment on, and approve before implementation starts.
- **Constraints:** She should not need to know how the agent session, workspace, result validation, or database writes work.
#### Enzo

- **Role:** Engineer maintaining the run lifecycle and execution boundary.
- **Cares about:** Step outputs being structured, validated, persisted, and transitioned through one predictable seam.
- **Constraints:** He needs the implementation to reuse existing workflow, runner, repository, and tolerance-pipeline patterns rather than adding a one-off spec path.
#### Opal

- **Role:** Operator watching runs and failures.
- **Cares about:** Safe failure behavior that does not commit malformed specs or start later phases from bad state.
- **Constraints:** She needs sanitized failure reasons, clear run state, and no leaked prompt, provider, workspace, or secret content.
### Narratives

#### Phoebe reviews the first generated spec

Phoebe starts a feature run from an issue. The run advances to `spec.author`, and Autocatalyst dispatches the planning agent in the run workspace. A little later the run pauses at `spec.human_review`, and Phoebe can see that a spec file now exists under `context-human/specs/` and that the run is waiting for her.
She reads the spec and leaves feedback on the artifact: one comment asks for a sharper non-goal, another asks for an acceptance criterion to be made testable. Autocatalyst records each comment as `Feedback` for the artifact target. The run stays at the gate until those items are dispositioned.
Because this slice does not redispatch `spec.author` or edit generated body content, requested spec-content changes are addressed as review dispositions rather than automatic amendments. A reviewer can accept an explanation, accept a `wont_fix` disposition, reopen an unacceptable disposition, or require a future revise/amend feature before approving; the only file mutation performed by this slice is the explicit approval-status frontmatter update.
#### Enzo investigates a malformed result

Enzo runs an integration test where the fake agent returns a spec path and frontmatter with a bad issue value. The step-result contract catches the problem before the system writes or commits the spec. Deterministic repair and correction get a chance to fix the output; if they cannot, the step fails safely.
No `Artifact` row points at a malformed file, and the run does not leave `spec.author` as if the work succeeded. Enzo sees a typed failure code from the result-validation path rather than a downstream file or database error.
#### Opal checks gate behavior

Opal sees a run paused at `spec.human_review`. A reviewer has marked one item `wont_fix`, and Phoebe reopens it because the explanation is not acceptable. The next attempt to approve the gate is refused while the reopened item is `open`.
Once the item is addressed and confirmed or deliberately left `wont_fix` with Phoebe's approval, the gate can advance. Opal can trust that the run did not move into implementation with unresolved artifact feedback.
### User stories

- As Phoebe, I want a feature or enhancement run to produce a committed spec file, so that I can review a durable artifact before implementation starts.
- As Phoebe, I want to leave structured feedback against the spec artifact, so that requested changes are tracked individually.
- As Phoebe, I want reopened `wont_fix` feedback to block the spec gate again, so that rejected workarounds cannot silently pass review.
- As Enzo, I want `spec.author` to use the existing runtime skills materialization path, so that planning behavior is configured the same way for supported agent backends.
- As Enzo, I want the `spec.author` terminal result to be validated before side effects, so that bad agent output cannot create a bad committed spec or Artifact row.
- As Enzo, I want the spec file, Artifact row, and run transition to agree on kind, location, and status, so that later implementation steps have a stable source of truth.
- As Opal, I want the run to pause at `spec.human_review`, so that human approval remains explicit and visible.
- As Opal, I want blocked gate advances to return a safe, typed reason, so that operations can diagnose feedback gating without reading raw model output.
### Acceptance criteria

- On `spec.author` for `feature` and `enhancement` workflows, the unit of work dispatches the agent through the existing runner path with the runtime-resolved `mm:planning` skill bundle present in the `ExecutionContext`.
- `spec.author` has a registered step-result contract, identified by `(step, schemaId)`, that validates the structured result before any spec file, Artifact row, commit, or run transition is recorded.
- Malformed `spec.author` output goes through deterministic normalization and correction through the existing tolerance pipeline; unrepairable output fails the step safely and records no committed spec or Artifact.
- A successful feature run writes a Markdown spec under `context-human/specs/feature-.md`; a successful enhancement run writes `context-human/specs/enhancement-.md`.
- The written spec frontmatter satisfies `context-agent/standards/spec-frontmatter.md`: required fields are present, `status` is one of the allowed lowercase values, `issue` is an integer when present, and `specced_by` accepts either a human GitHub username or the service identity `autocatalyst`.
- The spec file is committed on the run workspace branch. The implementation must not create, switch, push, merge, or open branches or PRs outside the workspace lifecycle that Autocatalyst already owns.
- The system records a spec `Artifact` with `kind: feature_spec` or `kind: enhancement_spec`, `canonicalRecord: file`, `location` set to the committed spec path, initial `cachedStatus: draft`, and `linkedIssue` copied from the run when present.
- For the authored spec waiting at `spec.human_review`, `Artifact.cachedStatus` is exactly `draft`, matching the committed frontmatter.
- After the spec commit and Artifact write, the run advances to `spec.human_review`, remains non-terminal, and reports `waiting_on: human`.
- `spec.human_review` does not dispatch an agent session. Dispatch admission checks the step catalog's `waitingOn` value and refuses runner dispatch for steps with `waitingOn: human`; the step only accepts explicit human/operator directives.
- Through the core feedback lifecycle service seam, `Feedback` can be created for `target: artifact` with an optional anchor and a non-empty thread attributed to principals. Public HTTP feedback lifecycle routes are out of scope for this slice.
- Artifact feedback supports the lifecycle `open -> addressed -> resolved | wont_fix`, including reopening a `wont_fix` item back to `open`.
- An approval advance from `spec.human_review` first resolves the approving principal's own `addressed` artifact feedback items, then is refused if any remaining feedback for the same run and `target: artifact` has status `open` or `addressed`.
- An advance from `spec.human_review` is allowed only after that approval-time co-resolution leaves every artifact-target feedback item for the run `resolved` or `wont_fix`.
- A successful explicit approval from `spec.human_review` rewrites the committed spec frontmatter to `status: approved`, commits that one-file status update on the current workspace branch, updates the spec Artifact cached status to `approved`, and only then advances the run to `implementation.plan`.
- Integration coverage creates a feature run, dispatches through `spec.author`, observes a committed spec under `context-human/specs/`, observes a persisted spec `Artifact`, observes the run paused at `spec.human_review`, creates and transitions artifact feedback through the core service/use-case seam, verifies open artifact feedback blocks advancement, and verifies resolved or `wont_fix` feedback unblocks advancement.
- `context-agent/wiki/code-map.md` is updated during implementation for any new spec-authoring modules, step-result contract registration, Artifact behavior, Feedback behavior, and gate checks.
### Non-functional requirements

- **Safety:** No malformed spec frontmatter is committed. No `Artifact` points at a missing or invalid spec file.
- **Security:** Failure messages, logs, and validation details must not include secrets, raw prompts, provider responses, or full workspace file contents.
- **Consistency:** File write, git commit, Artifact creation, and run transition must be ordered so recovery never treats an uncommitted or invalid spec as ready for review.
- **Compatibility:** Existing feature and enhancement workflow step IDs remain unchanged. Existing bug, chore, file-issue, and question workflows keep their current behavior.
- **Observability:** The run event stream should expose the normal runner events during `spec.author` and a state-transition event when the run reaches `spec.human_review`.
- **Performance:** No new latency target is set. The feature should add only validation, file I/O, git commit, and database writes around the existing agent session.
### Devil's advocate pass

- **The largest risk is side-effect ordering.** If the implementation writes the file before validation or creates the Artifact before commit succeeds, a failed step can leave convincing but invalid state behind. The technical design requires validation first and then an ordered, recoverable side-effect sequence.
- **The feedback lifecycle already has creation but may lack transition use cases.** The current repository interface creates and lists feedback, but issue 39 needs status changes and reopening. The technical design calls this out as an additive domain use-case layer rather than overloading raw repository writes.
- **The human gate can be confused with an automatic empty-feedback pass.** The concept docs say human review is active approval. The design keeps zero-feedback gates paused until a person or operator explicitly advances them.
- **Alternative considered:** Commit the spec first, then parse and validate committed frontmatter. This was rejected because the durable repository history would already contain invalid frontmatter. The boundary contract must run before the commit.
### Reviewer pass

This spec aligns with ADR-017 by using one `Artifact` entity and deriving the artifact kind from the workflow. It aligns with ADR-018 by using target-scoped feedback as a gate precondition, not as a message subtype. It aligns with ADR-027 by validating the `spec.author` result before downstream side effects. It also builds directly on issue 37's runtime skill materialization rather than introducing another skill-loading path.
The main remaining ambiguity is the exact structured-result shape the agent must return. The technical specification proposes a small result schema, but implementation should keep it narrow and test-driven so it does not duplicate the full spec-frontmatter schema in two places.
## Design spec

### Design scope

This is a backend workflow feature. It adds no screens, visual components, or user-facing layout. The design covers the operator and reviewer experience through run state, committed files, Artifact records, Feedback records, and gate behavior.
### Goals of the design

- Make a completed spec-authoring step visible as one durable committed file plus one queryable Artifact handle.
- Make spec review explicit: the run pauses for a human even when there is no feedback.
- Make artifact feedback structured, reopenable, and gate-enforcing without requiring a new review surface in this slice.
### User flows

#### Flow 1: Author a feature spec and pause for review

1. A feature run starts from an issue and reaches `spec.author`.
2. The execution context resolver includes the B1 planning skill bundle for the file-canonical workflow.
3. The runner executes the planning agent and returns a terminal result with the authored spec metadata and file content or scratch result reference.
4. The result contract validates the output. If validation fails after repair and correction, the step fails without writing the spec artifact.
5. The system writes the spec under `context-human/specs/feature-.md`.
6. The system validates the frontmatter contract, commits the file in the run workspace, creates the `Artifact` row, and records only an internal workspace handle for later approval finalization.
7. The orchestrator applies `advance` and the run lands at `spec.human_review`.
8. The reviewer sees the run waiting on a human and reviews the committed spec.
#### Flow 2: Feedback blocks the spec gate

1. A reviewer creates feedback against the artifact target, optionally anchored to the artifact or file range.
2. The feedback starts as `open`.
3. The reviewer or operator tries to advance the `spec.human_review` gate.
4. The gate check lists feedback for the run and filters to `target: artifact`.
5. Because at least one item is `open` or `addressed`, the advance is refused with a safe gate-blocked reason.
6. The run remains at `spec.human_review`.
#### Flow 3: Feedback is dispositioned and the gate advances

1. The implementer or system records a response and moves the item to `addressed` or `wont_fix`.
2. If the item is `addressed`, its originator can explicitly confirm it, moving it to `resolved`. For this slice, the originator is the principal on the first persisted feedback thread entry; `owner`, when present on the Feedback shape, is a routing/current-assignee hint and is not the confirmation authority. If an addressed item originated from the same reviewer who later approves the gate, approval also confirms it and moves it to `resolved` in the same action. If the item is `wont_fix`, the originator may accept it at approval time or reopen it.
3. The reviewer explicitly approves the spec gate.
4. The approval path co-resolves the approver's own `addressed` artifact feedback, then the gate check confirms every remaining artifact-target item is `resolved` or `wont_fix`.
5. The approval path updates the committed spec frontmatter from `status: draft` to `status: approved`, commits only that file on the current workspace branch, updates the spec Artifact cached status to `approved`, and then applies `advance`.
6. The run moves to `implementation.plan`.
### States and interaction behavior

- `spec.author` is an AI-active producing step.
- `spec.human_review` is a human gate and must not dispatch the agent; dispatch admission is explicitly gated by the step catalog's `waitingOn` field.
- `Artifact.cachedStatus` starts as `draft` for an authored spec waiting at `spec.human_review`, matching the committed frontmatter status.
- Successful gate approval changes both the committed frontmatter and the spec Artifact cached status to `approved` before the run leaves `spec.human_review`.
- Feedback status values are exactly `open`, `addressed`, `resolved`, and `wont_fix`.
- Feedback confirmation ownership is determined by `originator = feedback.thread[0].author`. Approval-time co-resolution applies only to addressed artifact feedback whose originator principal equals the approving principal; addressed feedback originated by other reviewers continues to block.
- A reopened `wont_fix` item returns to `open` and blocks the gate again.
- Gate approval is a separate action from manual item status changes, but it deliberately includes the `feedback.md` approval behavior that co-resolves the approver's own `addressed` items before the guard blocks on any remaining unconfirmed feedback.
### Components and interactions

- **Spec authoring handler:** Runs after the execution boundary returns a validated `spec.author` result. It owns spec path selection, frontmatter validation, file write, git commit, Artifact creation, and transition payload construction.
- **Spec result contract:** Defines the minimal structured output required from the planning agent and plugs into the existing step-result tolerance pipeline.
- **Artifact persistence interaction:** Creates exactly one file-canonical spec Artifact for the run's successful spec-authoring pass.
- **Feedback use cases:** Provide create, status transition, and reopen operations for artifact feedback.
- **Gate guard:** Checks artifact feedback before allowing an `advance` directive from `spec.human_review`; the approval path invokes approver-owned addressed-feedback co-resolution before this guard.
- **Spec approval finalizer:** Updates the committed spec frontmatter and Artifact cached status to `approved` as part of the explicit human approval path.
### Accessibility and responsive behavior

No visual accessibility or responsive-layout work is included. Future review surfaces should expose artifact feedback with keyboard-accessible anchors, screen-reader-readable status labels, and clear announcements when feedback blocks gate approval.
### Design system updates

None. This slice adds no UI components or design tokens.
### Reviewer pass

The design covers each product story without inventing a UI surface. The flows preserve the existing workflow vocabulary and keep the gate explicit. The only deferred interaction is free-form human reply classification; that is intentionally out of scope, so tests should drive gate actions through service/operator seams rather than channel prose.
## Tech spec

### Overview

Per ADR-017, this feature uses the existing single `Artifact` model and stores feature and enhancement specs as file-canonical artifacts. Per ADR-018, review feedback is a first-class `Feedback` record scoped by `target: artifact` and used as a gate precondition. Per ADR-027 and ADR-012, `spec.author` output is validated through the step-result tolerance pipeline before any downstream side effects. The implementation adds a spec-authoring completion path around the existing execution unit of work, plus feedback lifecycle use cases and a guard on the `spec.human_review` advance transition.
### Architecture

#### Components

- `packages/core/src/run-workflows.ts` remains the source of workflow shape. The `feature` and `enhancement` workflows already contain `spec.author` followed by `spec.human_review`.
- `packages/core/src/run-step-catalog.ts` remains the source of step behavior. `spec.author` is AI-active and `spec.human_review` is human-waiting.
- `packages/core/src/execution-run-unit-of-work.ts` remains the runner boundary consumer. It should continue to return a validated `RunWorkResult`, checkpoint result, and the resolved workspace repository root supplied by the public execution boundary.
- A new or extended core spec-authoring service should consume the validated `spec.author` result and perform file, commit, Artifact, and transition side effects in one ordered path.
- `packages/execution/src/result-contracts.ts` and `packages/execution/src/result-tolerance.ts` provide the contract registry and validation pipeline for `spec.author`.
- `packages/api-contract/src/artifact.ts` and `packages/api-contract/src/feedback.ts` provide the existing shared domain schemas.
- `packages/core/src/domain-repositories.ts` and `packages/persistence/src/domain-repositories.ts` need additive feedback lifecycle methods or use cases for status changes and reopen behavior.
- `packages/core/src/orchestrator.ts` or the lifecycle layer needs a gate guard before applying `advance` out of `spec.human_review`, plus a dispatch admission check that refuses agent work when the step catalog says `waitingOn: human`.
#### Boundaries

Spec authoring belongs in `packages/core` because it coordinates run state, Artifact persistence, and workflow transitions. It may call execution through the public `@autocatalyst/execution` API only. Provider adapters must not learn about spec files, Artifact rows, or feedback gates.
Core must not import execution internals such as `workspace-paths.ts` or `workspace-provisioner.ts`. The implementation decision for this slice is that the execution boundary returns the run's resolved concrete repository root alongside the validated terminal result. Core passes that `workspaceRepoRoot` into `CompleteSpecAuthoringInput` immediately, but does not persist the absolute path in public run-step checkpoints, public checkpoint reads, API responses, or ordinary logs. For later human approval, core records an internal-only workspace handle or run-workspace metadata record keyed by the run, such as `{ workspaceHandle, runId, workspaceRepoRoot }`, whose absolute path field is only available to trusted lifecycle services after restart and is redacted from diagnostics. `FinalizeSpecApprovalInput` receives the resolved root by resolving that internal handle through the workspace lifecycle seam, not by reading an absolute path from a public checkpoint. `WorkspaceGitPort` and `WorkspaceFileSystemPort` operate only under that path. `ExecutionContext` continues to carry workspace intent; it is not treated as sufficient to derive the concrete run worktree path inside core.
Filesystem and git operations must run only inside the run workspace. This feature does not create or switch branches; it uses the workspace branch that Autocatalyst provisioned for the run. Any git helper should use argument-array commands and existing workspace containment patterns rather than shell-string composition.
#### Data flow

1. The orchestrator dispatches a non-terminal run at `spec.author`.
2. Core resolves an `ExecutionContext`; issue 37's hard-coded skill mapping includes `mm:planning` for file-canonical `spec.author` runs.
3. Execution materializes the environment and runs the agent.
4. The execution entry point validates the terminal result against the registered `spec.author` contract.
5. Core receives `RunWorkResult.advance.result` plus the resolved `workspaceRepoRoot` from the public execution boundary.
6. The spec-authoring service validates the result's semantic references, derives the final spec path under that `workspaceRepoRoot`, validates frontmatter, writes the Markdown file, commits it, creates the Artifact with `cachedStatus: draft`, records or updates the internal workspace handle needed for later approval finalization, and returns `advance` with safe checkpoint data that includes the committed relative path, Artifact id, and workspace handle but not the absolute resolved workspace repo root.
7. The orchestrator transitions the run to `spec.human_review` and publishes a state-transition event.
8. Gate approval later resolves the internal workspace handle to the current `workspaceRepoRoot`, co-resolves the approver's own `addressed` artifact feedback, checks for any remaining blocking artifact feedback, rewrites and commits the spec frontmatter to `status: approved` using that resolved root, updates the Artifact cached status to `approved`, and applies another `advance`.
#### Integration points

- Runtime skills catalog from issue 37 for `mm:planning`.
- Step-result contract registry and validation pipeline from issues 21 and 22.
- Workspace provisioning and run-owned branch from the workspace lifecycle.
- SQLite persistence through existing domain repositories.
- Run event store and SSE stream for runner events and state transitions.
### Data model

#### Existing entities

- `Run` already carries `workKind`, `currentStep`, `terminal`, `trackedIssue`, and owner/tenant fields.
- `Artifact` already supports `kind`, `canonicalRecord`, `location`, `cachedStatus`, `linkedIssue`, and `publicationRefs`.
- `Feedback` already supports `target`, `status`, `title`, `body`, optional `anchor`, and `thread`.
#### Required changes

- Add feedback lifecycle operations at the core repository/use-case level:
	- Set `open -> addressed` with a required thread response.
	- Set `open -> wont_fix` with a required thread response.
	- Set `addressed -> resolved` when the originator or authorized system confirms.
	- Set `wont_fix -> open` to reopen an item.
- Persistence should update `status`, append the thread entry, and bump `updatedAt` atomically for each feedback transition.
- Feedback transition use cases generate the full persisted thread entry, including entry id and `createdAt`, before calling repository persistence. Repository updates append that full entry atomically with the status and `updatedAt` update.
- Add approval-time feedback confirmation that resolves the approving principal's own `addressed` artifact feedback items before the gate guard checks for remaining blockers.
- Because this slice cannot amend generated spec body content, `addressed` means a response thread entry records the proposed disposition or explanation for the originator to confirm. It does not imply that the spec body changed. Reviewers who require an actual content amendment must leave or reopen the item as blocking until a later revise/amend path exists.
- Add spec approval operations that update the committed spec frontmatter to `status: approved`, commit the file on the current workspace branch, and update the existing spec Artifact cached status to `approved` before the run advances out of `spec.human_review`.
- If a spec-authoring pass can be retried after failure, the Artifact creation path must prevent duplicate successful spec Artifacts for the same run and kind. A simple lookup-before-create is acceptable if workflow semantics ensure one successful pass; a uniqueness guard is safer if retries become possible in this slice.
#### Spec frontmatter

Committed spec frontmatter must follow `context-agent/standards/spec-frontmatter.md`:
```yaml
created: 2026-06-11
last_updated: 2026-06-11
status: draft
issue: 39
specced_by: autocatalyst
```
The validator should reject invalid status values, missing required fields, non-integer `issue`, and malformed supersession slugs if present. Although the frontmatter standard describes `specced_by` as a GitHub username, this committed spec uses the service author identity `autocatalyst`; the validator must intentionally accept that service identity rather than enforcing a strict username-only pattern. The validator can live in core or execution, but the committed contract should be exported through a stable package boundary if more than one package needs it.
#### Status mapping

The committed frontmatter status is the document source of truth. While waiting at `spec.human_review`, the file remains `status: draft`, and the corresponding `Artifact.cachedStatus` is exactly `draft`. Successful approval changes the committed frontmatter to `status: approved` and updates `Artifact.cachedStatus` to `approved` before the run advances to `implementation.plan`. This slice does not introduce a separate `ready_for_review` cached status for authored specs.
### API contracts and internal interfaces

No public HTTP feedback lifecycle endpoint is included in this slice. The complete integration proof must use service/use-case and repository seams for artifact feedback creation, status transition, reopening, approval-time co-resolution, and gate blocking. Future work may expose those same use cases through `/v1` REST routes, but implementation tasks for this spec must not add public feedback lifecycle routes unless a later approved spec amends this scope.
#### Execution completion handoff

The public execution/core boundary must include the resolved concrete repository root for the run when returning a validated terminal result for workspace-backed steps:
```typescript
interface ExecutionCompletionForCore {
  runWorkResult: RunWorkResult;
  checkpointResult: JsonValue;
  workspaceRepoRoot: string;
  workspaceHandle: string;
}
```
This is a public handoff from execution to core, not an import of execution internals. Execution remains responsible for deriving the path from workspace provisioning internals; core only receives and uses the already-resolved `workspaceRepoRoot` for containment-checked filesystem and git ports during the current operation. The `checkpointResult` returned from execution must not contain absolute workspace paths. Core persists the `workspaceHandle` in safe checkpoint/internal metadata and persists the absolute `workspaceRepoRoot` only in internal-only workspace metadata if restart recovery requires it; public RunStep/checkpoint reads and API responses must expose at most the handle and relative committed artifact paths.
#### `spec.author` step-result contract

Register a contract for `step: spec.author` with a schema id such as `autocatalyst.spec_author.v1`. The result should be narrow and operational:
```typescript
interface SpecAuthorResult {
  kind: 'feature_spec' | 'enhancement_spec';
  slug: string;
  relativePath: string; // must be under context-human/specs/
  frontmatter: {
    created: string;
    last_updated: string;
    status: 'draft' | 'approved' | 'implementing' | 'complete' | 'superseded';
    issue?: number;
    specced_by: string;
    supersedes?: string;
    superseded_by?: string;
  };
  body: string;
}
```
Validation rules:
- `kind` must match the current run workflow's artifact kind.
- `relativePath` must be `context-human/specs/feature-.md` for feature specs or `context-human/specs/enhancement-.md` for enhancement specs.
- `relativePath` must pass path-containment checks and must not be absolute.
- `slug` must be kebab-case and match the filename.
- `frontmatter.issue`, when present, must match `run.trackedIssue.number`.
- `frontmatter.status` must be `draft` at initial spec authoring.
- `body` must be post-frontmatter Markdown content. The committed Markdown must be rendered from the structured frontmatter plus body to avoid two sources of truth.
#### Core spec-authoring service

Suggested interface:
```typescript
interface CompleteSpecAuthoringInput {
  run: Run;
  result: SpecAuthorResult;
  workspaceRepoRoot: string; // resolved by execution and returned through the public boundary
  workspaceHandle: string; // safe persisted handle for later approval finalization
}

interface CompleteSpecAuthoringOutput {
  artifact: Artifact;
  committedPath: string;
  checkpointResult: JsonValue;
}
```
The service should perform:
1. Validate workflow kind and path.
2. Render or verify frontmatter.
3. Write the file under the repo root.
4. Run a frontmatter contract check on the written bytes.
5. Commit only the spec file.
6. Create the Artifact row.
7. Return checkpoint data safe to persist on the run step: committed relative path, Artifact id, and workspace handle only, with no absolute workspace path and no raw Markdown content.
#### Spec approval finalizer

Suggested interface:
```typescript
interface FinalizeSpecApprovalInput {
  run: Run;
  approver: Principal;
  workspaceRepoRoot: string; // resolved from internal workspace metadata immediately before finalization
  workspaceHandle: string; // safe handle recorded from spec authoring; may appear in checkpoints/API responses
}
```
The approval path should resolve `workspaceHandle` through the internal workspace lifecycle/metadata seam, then use this input after approval-time feedback co-resolution and the gate guard. It must read the existing file-canonical spec Artifact, update only frontmatter status metadata in the workspace rooted at `workspaceRepoRoot`, commit only that file, and update `Artifact.cachedStatus` to `approved`. The absolute `workspaceRepoRoot` is never returned in public responses and is redacted from logs.
#### Feedback lifecycle use cases

Suggested use cases:
```typescript
createArtifactFeedback(input): Promise
addressFeedback(input): Promise
resolveFeedback(input): Promise
markFeedbackWontFix(input): Promise
reopenFeedback(input): Promise
listBlockingFeedback(input: { runId: string; target: 'artifact' }): Promise
resolveApproverAddressedFeedback(input: { runId: string; target: 'artifact'; approver: Principal }): Promise
```
The transition functions must reject invalid lifecycle moves and require a thread entry for any implementer response. Originator confirmation and approval-time co-resolution compare the acting principal to `feedback.thread[0].author`; if broader authorization remains permissive for operators, tests must name that limitation while still preserving this originator seam.
The use-case layer accepts lightweight thread-entry input from callers, validates the author and body, and uses its `ids` and `clock` dependencies to build the full persisted thread-entry shape with `id`, `author`, `body`, and `createdAt`. Repository transition methods receive that full persisted entry and append it atomically with the status update. The authoritative originator for confirmation is `feedback.thread[0].author`; `owner`, if present, is treated only as a routing/current-assignee hint and does not make the owner eligible for originator confirmation. `resolveApproverAddressedFeedback` implements the `feedback.md` approval behavior by resolving only `addressed` artifact feedback whose first thread entry author equals the approving principal, appending a generated confirmation thread entry, and leaving other reviewers' `addressed` feedback untouched for the guard to block.
#### Gate guard

Before applying `advance` from `spec.human_review`, the explicit approval path first calls `resolveApproverAddressedFeedback` for the approving principal. Then the guard checks:
```typescript
feedback.runId === run.id &&
feedback.target === 'artifact' &&
(feedback.status === 'open' || feedback.status === 'addressed')
```
If any item matches after approver co-resolution, refuse the transition with a typed safe error such as `feedback_gate_blocked`. Do not mutate the run. `wont_fix` and `resolved` items do not block the gate, but approval remains explicit. After the guard passes, the approval finalizer must update and commit the spec frontmatter status to `approved` and update the Artifact cached status to `approved` before the run advances.
### Implementation plan

1. Add the `spec.author` result schema and register it in the existing step-result contract registry used by the execution entry point.
2. Add frontmatter parsing/rendering/validation helpers for the committed spec contract, reusing the standard in `context-agent/standards/spec-frontmatter.md`.
3. Extend the public execution/core handoff so successful workspace-backed execution returns the resolved `workspaceRepoRoot` for immediate side effects plus a safe `workspaceHandle` for persisted approval finalization.
4. Add the core spec-authoring completion service that validates the result, writes the spec file under `context-human/specs/` below the resolved `workspaceRepoRoot`, commits only that file in the run workspace, and creates the Artifact row.
5. Wire `spec.author` dispatch so an `advance` result, resolved `workspaceRepoRoot`, and safe `workspaceHandle` pass through the completion service before the run transitions to `spec.human_review`; persist only the handle and relative artifact data in public checkpoint-visible state.
6. Add feedback lifecycle use cases and persistence methods for status transitions, thread append, reopening, and approval-time co-resolution of the approver's own `addressed` feedback.
7. Add the `spec.human_review` gate guard that refuses `advance` when artifact feedback remains `open` or `addressed` after approval-time co-resolution.
8. Add the approval finalizer that updates and commits the spec frontmatter to `approved` using the resolved `workspaceRepoRoot`, updates the Artifact cached status to `approved`, and then permits the run transition to `implementation.plan`.
9. Add integration tests around the full feature-run path using fake adapters or stub runners, including malformed-result failure, approval-status update, and feedback gate behavior.
10. Update agent-owned code navigation docs for the new modules and behaviors.
### Testing strategy

#### Unit tests

- Validate `SpecAuthorResult` success and failure cases: wrong kind, wrong path, path traversal, invalid slug, invalid status, string issue, and issue mismatch.
- Validate frontmatter rendering and parsing against the committed schema.
- Validate Artifact creation input maps workflow kind to `feature_spec` or `enhancement_spec` and uses `canonicalRecord: file`.
- Validate the spec approval finalizer updates frontmatter and Artifact cached status to `approved` without changing spec body content.
- Validate feedback lifecycle transitions, invalid transitions, required thread entries, approval-time co-resolution of the approver's own `addressed` feedback, and reopening `wont_fix`.
- Validate multi-reviewer confirmation behavior: the approver's own addressed feedback is co-resolved using first-thread-entry originator equality, while addressed feedback originated by another reviewer continues to block even if `owner` points elsewhere.
- Validate feedback transition persistence receives full thread entries with generated `id` and `createdAt`.
- Validate gate guard filtering by run id, target, and status.
#### Integration tests

- Drive a feature run from creation through `spec.author` dispatch with a fake/stub agent result and assert:
	- the spec file exists under `context-human/specs/`;
	- the file frontmatter is valid;
	- the file was committed in the workspace branch;
	- an Artifact row exists with file canonical record and the correct kind;
	- the run is paused at `spec.human_review`.
- Attempt to advance `spec.human_review` with open artifact feedback and assert refusal with no run transition.
- Resolve or mark the feedback `wont_fix`, explicitly advance the gate, and assert the run reaches `implementation.plan`.
- Assert the approval advance commits the spec frontmatter status change to `approved` and updates the Artifact cached status to `approved`.
- Return malformed `spec.author` output and assert no spec file commit and no Artifact row.
- Confirm `spec.human_review` itself does not dispatch the runner.
#### Manual checks

- Inspect a generated spec file and confirm it follows existing spec style and frontmatter conventions.
- Inspect failure logs to confirm they contain typed safe details but not raw prompt text, provider responses, secrets, or full file contents.
### Operational concerns

- **Observability:** Emit normal runner events during `spec.author`; emit a state-transition event when the run reaches `spec.human_review`; log sanitized spec-authoring side-effect failures with typed codes.
- **Failure modes:** Result validation failure stops before side effects. File write failure stops before commit and Artifact creation. Commit failure stops before Artifact creation. Artifact creation failure leaves a committed file without a database handle; implementation should either surface a recoverable failure or make the operation idempotent enough for retry.
- **Approval failure modes:** If the approval frontmatter rewrite, approval commit, or Artifact cached-status update fails, the run must remain at `spec.human_review` with a safe typed failure rather than advancing to implementation with stale `draft` frontmatter.
- **Recovery:** Retrying `spec.author` after a partial failure must not create duplicate Artifacts or overwrite a human-reviewed spec without an explicit revise path.
- **Security:** Path containment must prevent writes outside the run repo. Logs must avoid raw file content unless a test explicitly inspects local files.
- **Rollout:** This behavior applies only to feature and enhancement workflows. Other workflows keep existing behavior until their own specs define authoring.
### Open questions

- **Duplicate successful spec attempts:** Should persistence enforce one spec Artifact per run and kind, or should core handle idempotency? A persistence guard is safer if retries are expected.
- **Operator authorization for forced dispositions:** Originator confirmation is defined by the first feedback thread entry author, but a separate authorization decision may later decide whether operators can force-resolve or override feedback. Keep the principal seam explicit even if policy remains permissive.
### Devil's advocate pass

- The proposed `SpecAuthorResult` may duplicate information already present in Markdown. To avoid drift, implementation should render Markdown from structured frontmatter and body or parse the final file once, not trust two independent values.
- Git commit behavior from core can violate package boundaries if it reaches into execution internals. This spec resolves the workspace-root half of that risk by requiring execution to return the resolved repo root publicly; core must still use narrow workspace git/filesystem ports and must not import private execution helpers.
- Blocking on `addressed` feedback may surprise implementers who think "addressed" means done. This is intentional per ADR-018 for feedback not owned by the approver; the approver's own `addressed` items are resolved during approval per `feedback.md`.
- An Artifact creation failure after commit creates split state. The safest recovery is idempotent re-entry: find the committed spec and create the missing Artifact on retry instead of committing another file.
### Reviewer pass

The technical design stays within the existing architecture: core coordinates workflow and persistence, execution validates runner output and returns the resolved workspace repo root through its public boundary, provider adapters stay unaware of spec artifacts, and persistence owns durable entities. It respects the user's branch-management constraint by treating the run workspace branch as pre-owned by Autocatalyst and by not adding branch, push, merge, or PR behavior.
## Task list

### Story 1: Define the spec-authoring result contract

Create the shared schema and execution registration that make `spec.author` output narrow, typed, and validated before core side effects.
#### Task T-001: Add shared spec-authoring schemas

**Description:** Create `packages/api-contract/src/spec-authoring.ts` with the `SpecAuthorResult`, `SpecAuthorFrontmatter`, and `SpecArtifactKind` schemas and exported TypeScript types described in this spec. Export the module from `packages/api-contract/src/index.ts`.
**Acceptance criteria:**
- `SpecAuthorResultSchema` accepts `kind`, `slug`, `relativePath`, structured `frontmatter`, and post-frontmatter `body`.
- `SpecAuthorFrontmatterSchema` accepts the committed spec status enum, integer `issue` when present, required `created`, `last_updated`, and `specced_by`, and optional `implemented_by`, `supersedes`, and `superseded_by`.
- `specced_by` validation intentionally accepts the service identity `autocatalyst` in addition to human GitHub usernames.
- Schema tests reject string issues, unsupported statuses, empty body content, malformed slugs, and unknown spec artifact kinds.
- Package index tests prove the new schemas and types are exported from `@autocatalyst/api-contract`.
**Dependencies:** None.
#### Task T-002: Register the `spec.author` result contract

**Description:** Extend `packages/execution/src/result-contracts.ts` so the existing step-result tolerance pipeline knows the stable schema id `autocatalyst.spec_author.v1` for `spec.author` terminal results.
**Acceptance criteria:**
- `SPEC_AUTHOR_SCHEMA_ID` is exported with value `autocatalyst.spec_author.v1`.
- `registerSpecAuthorResultContract` registers the schema for `step: spec.author` without changing existing result contracts.
- Result-contract tests prove valid `SpecAuthorResult` values pass and malformed values enter the existing validation failure path.
- Existing deterministic normalization and correction behavior still runs around the registered contract.
**Dependencies:** T-001.
### Story 2: Validate and render committed spec frontmatter

Provide one core source for frontmatter rendering, parsing, and validation so committed Markdown specs cannot drift from the structured result.
#### Task T-003: Implement committed spec frontmatter helpers

**Description:** Add `packages/core/src/spec-frontmatter.ts` with `renderSpecFrontmatter`, `parseSpecFrontmatter`, and `validateCommittedSpecFrontmatter` following `context-agent/standards/spec-frontmatter.md`.
**Acceptance criteria:**
- Rendering produces a YAML frontmatter block with required fields and supported optional fields only.
- Parsing returns `SpecAuthorFrontmatter` from Markdown that contains a valid frontmatter block.
- Validation rejects missing required fields, invalid status values, non-integer `issue`, malformed `implemented_by`, and malformed supersession slugs, while accepting the service identity `autocatalyst` for `specced_by`.
- Tests cover round-tripping rendered frontmatter and rejecting Markdown with no frontmatter block.
**Dependencies:** T-001.
#### Task T-004: Keep frontmatter and body as one rendered source of truth

**Description:** Add tests and helper behavior that render final Markdown from structured frontmatter plus `body`, rather than trusting an independent full-Markdown result from the agent.
**Acceptance criteria:**
- Rendered Markdown contains exactly one frontmatter block followed by the result body.
- A body that already starts with a frontmatter block is rejected or normalized through an explicit tested rule.
- The initial committed status for spec authoring must be `draft`.
- Tests prove `validateCommittedSpecFrontmatter` runs against the rendered bytes that would be committed.
**Dependencies:** T-003.
### Story 3: Complete spec authoring after validation

Implement the ordered core service that turns a validated `spec.author` result into a committed file-canonical spec Artifact without creating, switching, pushing, merging, or opening branches or PRs.
#### Task T-005: Define spec-authoring service ports and errors

**Description:** Add `packages/core/src/spec-authoring-service.ts` with the input/output types, dependency ports, and typed validation, containment, commit, and artifact-persistence errors described in this spec.
**Acceptance criteria:**
- `CompleteSpecAuthoringInput`, `CompleteSpecAuthoringOutput`, `SpecAuthoringServiceDependencies`, `WorkspaceGitPort`, and `WorkspaceFileSystemPort` include the resolved `workspaceRepoRoot` handoff, safe `workspaceHandle`, and match the interfaces described in this spec.
- The service dependencies include only artifact persistence, git commit, filesystem access, and clock.
- The git port exposes `commitFiles` for the current workspace branch only and has no branch creation, checkout, push, merge, worktree, or PR operation.
- Absolute workspace paths are accepted only as internal inputs and are not included in public checkpoint-visible output, public API response shapes, or error/log messages.
- Error tests prove unsafe inputs produce typed safe errors without raw prompt, provider response, secret, or full file-content leakage.
**Dependencies:** T-003, T-004.
#### Task T-006: Implement workflow, path, and issue validation in `completeSpecAuthoring`

**Description:** Implement the pre-side-effect validation path in `completeSpecAuthoring` for workflow kind, artifact kind, slug, relative path, path containment, initial status, issue matching, and body semantics.
**Acceptance criteria:**
- Feature runs accept only `kind: feature_spec` and `context-human/specs/feature-.md`.
- Enhancement runs accept only `kind: enhancement_spec` and `context-human/specs/enhancement-.md`.
- Absolute paths, path traversal, and paths outside `context-human/specs/` fail before any filesystem, git, or repository call.
- `frontmatter.issue`, when present, must match the run's tracked issue number.
- Unit tests prove no side-effect dependency is called when validation fails.
**Dependencies:** T-005.
#### Task T-007: Implement ordered write, validate, commit, and Artifact creation

**Description:** Complete the successful `completeSpecAuthoring` path by rendering the spec, writing it under the run workspace root, validating the written bytes, committing only that file, and creating or recovering the file-canonical Artifact.
**Acceptance criteria:**
- The service writes exactly the validated relative spec path under the provided workspace repository root received from the execution/core handoff.
- The service reads or validates the written bytes before commit.
- The git dependency is called with only the spec file path and a safe commit message.
- The Artifact row uses `kind: feature_spec` or `kind: enhancement_spec`, `canonicalRecord: file`, the committed path, mapped `cachedStatus`, and the run's linked issue when present.
- If an existing spec Artifact for the same run and kind is found during retry recovery, the output sets `artifactCreated: recovered`; otherwise it sets `artifactCreated: created`.
- Commit failure stops before Artifact creation, and Artifact creation failure surfaces a typed recoverable error.
**Dependencies:** T-006.
### Story 4: Wire spec authoring into the run lifecycle

Route successful `spec.author` execution through the completion service before the run reaches `spec.human_review`, while keeping `spec.human_review` human-only.
#### Task T-008: Pass validated `spec.author` results through the completion service

**Description:** Update `packages/core/src/execution-run-unit-of-work.ts`, `packages/core/src/orchestrator.ts`, or the existing lifecycle seam so a successful `spec.author` `advance` result carries the resolved `workspaceRepoRoot` and safe `workspaceHandle` from execution, calls `completeSpecAuthoring`, and persists only safe checkpoint data before applying the workflow transition.
**Acceptance criteria:**
- `spec.author` still dispatches through the existing execution runner path and receives the runtime-resolved `mm:planning` skill bundle in `ExecutionContext`.
- Execution returns the resolved concrete workspace repository root and safe workspace handle through the public execution/core handoff; core does not derive the root from `ExecutionContext` and does not import `workspace-paths.ts` or `workspace-provisioner.ts`.
- `CompleteSpecAuthoringInput.workspaceRepoRoot`, `WorkspaceGitPort`, and `WorkspaceFileSystemPort` all receive that resolved repo root before file or git side effects run.
- The completion service runs after the execution result contract has accepted the terminal result and before the run transition is persisted.
- A successful completion produces safe checkpoint data that includes the committed relative path, Artifact id, and workspace handle needed by approval finalization, not raw Markdown contents or the absolute resolved workspace repo root.
- The absolute workspace repo root, if persistence is needed for restart recovery, is stored only in internal run-workspace metadata and is redacted from logs and public RunStep/checkpoint reads.
- Malformed unrepairable output leaves the run at `spec.author` failure handling with no committed spec and no Artifact row.
- Existing non-spec workflow steps keep their current behavior.
**Dependencies:** T-002, T-007.
#### Task T-009: Preserve human-waiting behavior at `spec.human_review`

**Description:** Ensure the run step catalog, orchestrator, and dispatch admission behavior continue to treat `spec.human_review` as a human gate rather than an AI-active step.
**Acceptance criteria:**
- The `spec.human_review` step reports `waiting_on: human` after a successful spec authoring transition.
- Dispatch admission uses the step catalog's `waitingOn` value as the named guard; when `waitingOn: human`, the orchestrator refuses runner dispatch before calling the unit of work.
- No runner dispatch is attempted when a run is already at `spec.human_review`, even if `orchestrator.dispatch()` is called directly.
- A state-transition event is emitted when the run reaches `spec.human_review`.
- Tests prove a feature run and an enhancement run both pause at `spec.human_review` after spec authoring.
**Dependencies:** T-008.
### Story 5: Add feedback lifecycle operations

Make artifact feedback createable, addressable, resolvable, markable as `wont_fix`, and reopenable through domain use cases and persistence.
#### Task T-010: Extend repository ports for feedback transitions and Artifact idempotency

**Description:** Update `packages/core/src/domain-repositories.ts` with the additive FeedbackRepository and ArtifactRepository methods described in this spec, including the canonical `FeedbackStatusTransitionPersistenceInput`, `FeedbackThreadEntryPersistenceInput`, and optimistic-concurrency error type.
**Acceptance criteria:**
- `FeedbackRepository` includes `findById`, `listByRun`, and `updateStatusAndAppendThread`.
- `FeedbackStatusTransitionPersistenceInput.threadEntry` uses the full persisted thread-entry shape with `id`, `author`, `body`, and `createdAt`, not the caller input shape.
- `ArtifactRepository` includes `findByRunAndKind` for one-spec-artifact-per-run-kind recovery and `updateCachedStatus` for approval.
- `FeedbackConcurrentModificationError` exposes code `feedback_concurrent_modification`, feedback id, expected status, and optional actual status.
- Existing repository consumers compile without changing their current call shapes.
**Dependencies:** None.
#### Task T-011: Implement persistence for feedback transitions and Artifact lookup

**Description:** Update `packages/persistence/src/domain-repositories.ts` to satisfy the extended core repository ports with atomic status-plus-thread updates, run/kind Artifact lookup, and Artifact cached-status updates.
**Acceptance criteria:**
- Feedback status updates append the supplied full thread entry, including `id` and `createdAt`, and update `updatedAt` atomically.
- The persistence layer rejects stale expected-status transitions with `FeedbackConcurrentModificationError`.
- `findByRunAndKind` returns the existing spec Artifact for retry recovery when present and `null` otherwise.
- `updateCachedStatus` persists `approved` for the spec Artifact during approval.
- Persistence tests cover valid transitions, stale transitions, full thread append behavior, Artifact lookup, and Artifact cached-status update.
**Dependencies:** T-010.
#### Task T-012: Add feedback lifecycle use cases

**Description:** Add `packages/core/src/feedback-lifecycle.ts` with `createArtifactFeedback`, `addressFeedback`, `resolveFeedback`, `markFeedbackWontFix`, `reopenFeedback`, `listBlockingFeedback`, and `resolveApproverAddressedFeedback`.
**Acceptance criteria:**
- `createArtifactFeedback` requires `target: artifact`, non-empty title/body, a principal, and a non-empty initial thread entry.
- `addressFeedback` allows only `open -> addressed` and requires a response thread entry.
- `markFeedbackWontFix` allows only `open -> wont_fix` and requires an explanation thread entry.
- `resolveFeedback` allows only `addressed -> resolved` and accepts an optional non-empty confirmation entry.
- `resolveFeedback` treats the first persisted thread entry author as the feedback originator for confirmation; `owner` does not grant originator confirmation authority.
- `resolveApproverAddressedFeedback` resolves only `addressed` artifact feedback whose first persisted thread entry author equals the approving principal and appends an approval-confirmation thread entry generated by the use-case layer.
- `reopenFeedback` allows only `wont_fix -> open` and requires a reopen explanation.
- Transition use cases generate the persisted thread entry id and `createdAt` before calling `FeedbackRepository.updateStatusAndAppendThread`.
- `listBlockingFeedback` returns only feedback for the run with `target: artifact` and status `open` or `addressed`, after any caller-requested approval-time co-resolution has completed.
- Unit tests cover valid moves, invalid moves, required thread entries, permissive or explicit authorization policy seams, and concurrent-modification propagation.
- Unit tests cover multi-reviewer approval behavior, including an approver co-resolving only feedback they originated and being blocked by addressed feedback originated by another reviewer.
**Dependencies:** T-010, T-011.
### Story 6: Guard and finalize the spec review gate

Block explicit advancement from `spec.human_review` while artifact feedback is unresolved or addressed-but-unconfirmed, and commit the lifecycle-required approval status before the run enters implementation.
#### Task T-013: Implement the spec review gate guard

**Description:** Add `packages/core/src/spec-review-gate.ts` with `assertSpecReviewGateCanAdvance`, `SpecReviewGateBlockedError`, and the input and dependency types described in this spec.
**Acceptance criteria:**
- The guard rejects runs that are not currently at `spec.human_review` with a typed invalid-step error.
- The guard delegates feedback filtering to the injected `listBlockingFeedback` function.
- Open and remaining addressed artifact feedback block with code `feedback_gate_blocked` and safe blocking feedback ids.
- Resolved and `wont_fix` feedback do not block the guard.
- Tests prove the guard does not mutate the run.
**Dependencies:** T-012.
#### Task T-014: Wire the gate guard into explicit advance handling

**Description:** Update the orchestrator or lifecycle advance path so explicit human/operator `advance` directives from `spec.human_review` co-resolve the approver's own addressed feedback, then call `assertSpecReviewGateCanAdvance` before mutating run state.
**Acceptance criteria:**
- A run with open artifact feedback remains at `spec.human_review` after an advance attempt.
- A run with addressed artifact feedback owned by a different reviewer remains at `spec.human_review` after an advance attempt.
- Addressed artifact feedback originated by a different reviewer remains at `spec.human_review` after an advance attempt, even if the Feedback `owner` field points at the approving principal.
- Addressed artifact feedback originated by the approving principal, determined by the first thread entry author, is resolved in the same approval action before the guard runs.
- A run with all artifact feedback resolved or `wont_fix` proceeds to the approval finalizer instead of mutating run state directly.
- Feedback for another run or a non-artifact target does not block.
- Gate-blocked errors are safe for logs and API callers and do not include feedback body content.
**Dependencies:** T-013.
#### Task T-015: Finalize spec approval before implementation

**Description:** Add `packages/core/src/spec-approval-finalizer.ts` and wire explicit approval so the committed spec frontmatter and Artifact cached status move from `draft` to `approved` before `spec.human_review` advances to `implementation.plan`.
**Acceptance criteria:**
- The finalizer reads the file-canonical spec Artifact for the run, parses the committed frontmatter, and changes only `status` to `approved` plus the appropriate `last_updated` value.
- `FinalizeSpecApprovalInput.workspaceRepoRoot` is resolved from the internal workspace handle/metadata recorded from the public execution completion handoff and is used for all filesystem and git containment checks.
- Public checkpoints, RunStep reads, API responses, and logs never expose the absolute workspace repo root; they expose at most the safe workspace handle and relative committed artifact path.
- The finalizer writes and validates the updated spec file under that resolved repo root, commits only that file on the current workspace branch, and never creates, switches, pushes, merges, opens PRs, or creates worktrees.
- The existing spec Artifact cached status is updated to `approved` after the approval commit succeeds.
- If file update, validation, commit, or Artifact cached-status persistence fails, the run remains at `spec.human_review` with a safe typed failure.
- Unit tests prove spec body content is not changed by the approval finalizer.
**Dependencies:** T-003, T-007, T-014.
### Story 7: Prove the full feature path

Add integration coverage that exercises the complete route from run creation through spec authoring, human gate pause, artifact feedback blocking, and unblocking.
#### Task T-016: Add successful feature and enhancement authoring integration tests

**Description:** Add integration tests with fake adapters or stub runners that return valid `SpecAuthorResult` payloads for both feature and enhancement workflows.
**Acceptance criteria:**
- A feature run writes and commits `context-human/specs/feature-.md`.
- An enhancement run writes and commits `context-human/specs/enhancement-.md`.
- Each generated file has valid frontmatter with `status: draft`.
- Each run records one file-canonical spec Artifact with the expected kind, location, `cachedStatus: draft`, and linked issue.
- Each run pauses at `spec.human_review` with `waiting_on: human`.
**Dependencies:** T-008, T-009, T-011.
#### Task T-017: Add malformed-result and side-effect-ordering integration tests

**Description:** Add integration coverage for unrepairable malformed `spec.author` output and failures during the ordered side-effect sequence.
**Acceptance criteria:**
- A malformed issue value, bad path, wrong kind, or invalid status fails before any spec commit or Artifact creation.
- A file write failure stops before commit and Artifact creation.
- A commit failure stops before Artifact creation.
- An Artifact persistence failure after commit surfaces a typed recoverable failure and does not silently advance the run.
- Failure logs and checkpoint data contain typed safe details only.
**Dependencies:** T-008.
#### Task T-018: Add feedback gate integration tests

**Description:** Add integration coverage proving artifact feedback blocks and unblocks advancement from `spec.human_review` through the core feedback lifecycle service/use-case seam. Do not add or depend on public HTTP feedback lifecycle routes in this slice.
**Acceptance criteria:**
- Creating open artifact feedback for the run blocks explicit advance from `spec.human_review`.
- Moving feedback to `addressed` blocks explicit advance when it belongs to a different reviewer than the approver.
- Multi-reviewer cases use first-thread-entry originator equality, not the Feedback `owner` field, to decide what the approver can co-resolve.
- Moving the approver's own feedback to `addressed` is co-resolved during explicit approval and does not dead-end the approval action.
- Resolving feedback allows explicit advance.
- Marking feedback `wont_fix` allows explicit advance unless the item is reopened.
- Reopening a `wont_fix` item moves it back to `open` and blocks again.
- Successful approval commits the spec frontmatter status as `approved`, updates the Artifact cached status to `approved`, and advances the run to `implementation.plan`.
- The tests prove `spec.human_review` itself does not dispatch an agent.
**Dependencies:** T-015, T-016.
### Story 8: Keep exports, docs, and validation current

Expose the new internal APIs through package boundaries where needed and update agent-owned navigation docs so later implementers can find the behavior.
#### Task T-019: Update package exports and boundary tests

**Description:** Export the new modules from the appropriate package entry points and update boundary tests so public contracts remain intentional.
**Acceptance criteria:**
- `@autocatalyst/api-contract` exports `spec-authoring` schemas and types.
- `@autocatalyst/execution` exports only the agreed result-contract registration and execution-completion handoff surface, including the resolved `workspaceRepoRoot` for immediate internal side effects and safe `workspaceHandle` for persisted state; it does not expose private tolerance or workspace-provisioning internals.
- `@autocatalyst/core` exports the spec frontmatter, spec authoring, spec approval finalizer, feedback lifecycle, and spec review gate use-case surfaces needed by composition and tests.
- Boundary tests continue to prevent provider adapters from importing core spec-authoring or feedback-gate modules.
**Dependencies:** T-002, T-007, T-012, T-013.
#### Task T-020: Update agent navigation and run the validation suite

**Description:** Update `context-agent/wiki/code-map.md` for new spec-authoring modules, result-contract registration, Artifact behavior, feedback lifecycle behavior, and gate checks. Run the relevant targeted and broad validation commands.
**Acceptance criteria:**
- `context-agent/wiki/code-map.md` points to the new files and summarizes their responsibilities.
- Targeted package tests for api-contract, execution, core, and persistence pass.
- The repository validation command or documented equivalent passes.
- Any unsupported provider behavior or intentionally permissive authorization limitation is documented in test names or comments and called out in handoff notes.
**Dependencies:** T-016, T-017, T-018, T-019.
### Dependency graph

- Critical path: T-001 → T-002 → T-003 → T-004 → T-005 → T-006 → T-007 → T-008 → T-009 → T-016.
- Feedback and approval gate path: T-010 → T-011 → T-012 → T-013 → T-014 → T-015 → T-018.
- Finalization path: T-019 depends on the implemented module surfaces; T-020 depends on the successful integration coverage and exports.
- Parallel work: T-003 can start after T-001 while T-002 is in progress. T-010 and T-011 can proceed in parallel with the spec-authoring service path until gate wiring needs T-012.
### Reviewer pass

- Requirements coverage: The tasks cover runtime `mm:planning` dispatch, `spec.author` result validation, committed spec files, Artifact persistence, `spec.human_review` pause behavior, artifact feedback lifecycle, gate blocking and unblocking, integration coverage, and code-map updates.
- Design coverage: The tasks preserve the backend-only design, use the agreed file-canonical Artifact handle, keep spec review explicit, and avoid adding UI or public HTTP feedback lifecycle endpoints.
- Technical coverage: The tasks map directly to the module surfaces and exported symbols described in this spec. They keep provider adapters unaware of spec files and feedback gates, validate before side effects, pass the resolved workspace repo root through the public execution/core boundary, update approval frontmatter before implementation, and avoid branch, push, merge, worktree, and PR operations.
- Dependency check: The critical path separates shared schemas, execution validation, core side effects, lifecycle wiring, feedback lifecycle, gate enforcement, and integration proof. No task depends on a missing phantom task.
- Sizing check: The largest tasks are implementation slices with focused module boundaries. Integration tests are split between successful authoring, malformed side-effect ordering, and feedback gate behavior so each remains reviewable.