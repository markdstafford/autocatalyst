---
created: 2026-06-09
last_updated: 2026-06-09
status: implementing
issue: 19
specced_by: markdstafford
---
# Feature: Safe workspace teardown by terminal state

## Product requirements

### What

Implement the first terminal-state workspace teardown capability for Autocatalyst runs. When a run reaches a terminal state, execution code applies that state's retention policy to the run's workspace and branch. The feature introduces one safe prune primitive for all workspace filesystem deletion, then builds teardown behavior on top of it.
The teardown policy is:
- `done` implementing runs remove the git worktree, remove scratch with the run directory, and delete the run branch because the work is already in the default branch.
- `canceled` implementing runs commit any uncommitted tail as a final checkpoint using an explicit Autocatalyst git committer identity, remove the git worktree and run directory, and keep the branch.
- `failed` implementing runs keep both worktree and branch for inspection.
- `file_issue` runs remove their scratch-only run directory for every terminal step (`done`, `canceled`, or `failed`) because they have no durable branch or worktree state.
The prune primitive is the only policy code path that may request workspace path removal, and its owned lifecycle driver methods are the only implementation code that may perform recursive directory removal or `git worktree remove`. The primitive checks containment against the resolved root, stats the target before deletion, returns a typed outcome, emits a structured log, and handles git-aware worktree removal without deleting the branch. It also reconciles orphaned git worktree administrative state by running `git worktree prune` when a worktree directory was removed outside Autocatalyst.
### Why

Autocatalyst already provisions isolated run workspaces, but it does not yet reclaim them when a run ends. Without teardown, successful and canceled runs leave worktrees and scratch directories behind, and out-of-band worktree deletion can leave stale `.git/worktrees/` state in the host repository.
The workspace concept and ADR-021 decide the policy: retain only what can still be useful, route every filesystem deletion through one observable primitive, and never lose a canceled run's work before removing its worktree. This feature turns that policy into execution-plane behavior while leaving scheduled garbage collection and automatic orchestrator wiring for later work.
### Goals

- Add one prune primitive in `packages/execution` for all workspace filesystem deletion.
- Support git-aware worktree removal through `git worktree remove`, while preserving the branch ref.
- Support plain scratch/run-directory removal for scratch-only and post-worktree cleanup paths.
- Return a typed prune result: `deleted`, `missing`, `skipped`, `rejected`, or `failed`; `skipped` is reserved for callers or future retention flows and is not produced by the destructive pruner in this slice.
- Reject out-of-root prune targets before deletion by using the resolved workspace root supplied by the caller.
- Report an already-absent target as `missing` instead of silently succeeding.
- Reconcile stale worktree administrative state with `git worktree prune` when the worktree directory is already absent.
- Emit structured logs for prune attempts with run id, target paths, mode, result, and duration.
- Add terminal-state teardown behavior for `done`, `canceled`, `failed`, and scratch-only `file_issue` runs.
- For `canceled` runs, commit the uncommitted tail with an explicit Autocatalyst git identity before worktree removal and keep the branch.
- For `done` runs, remove the worktree through the prune primitive and delete the run branch.
- For `failed` runs, perform no destructive workspace or branch action.
- Prove behavior with an integration test using real git worktrees and scratch directories.
- Update `context-agent/wiki/code-map.md` during implementation to record the new prune and teardown modules.
### Non-goals

- Driving teardown automatically from orchestrator dispatch or run terminal transitions.
- Scheduled workspace garbage collection, startup reconciliation, retention windows, or window-based reclamation.
- Re-materializing missing non-terminal workspaces.
- Remote-worker clone teardown, branch push-on-checkpoint, or non-co-located execution.
- User interface or API endpoints for manual workspace cleanup.
- Object-store compaction with `git gc`.
- Changing the existing workspace provisioning layout, branch naming, or run step catalog.
- Opening, pushing, merging, or deleting pull requests.
### Personas

- **Enzo (Engineer)** needs a small execution-plane API that applies workspace retention rules without duplicating git and filesystem deletion logic.
- **Opal (Operator)** needs terminal runs to stop leaking disk, while failed runs remain inspectable until later garbage-collection work exists.
- **Phoebe (PM)** needs `done`, `canceled`, `failed`, and throwaway issue-filing runs to have predictable, explainable retention behavior.
- **Dani (Designer)** is not a direct user of this backend feature, but later progress and review surfaces depend on run artifacts being reclaimed safely.
### User stories

- As Enzo, I can call one prune primitive for a worktree or scratch path and receive a typed result.
- As Enzo, I can call a teardown operation for a terminal run and avoid reimplementing retention policy in control-plane code.
- As Enzo, I can test teardown against a real temporary git repository and verify actual worktree and branch behavior.
- As Opal, I can trust that a prune of an out-of-root path is rejected and does not delete anything.
- As Opal, I can see from structured logs whether a workspace path was deleted, missing, rejected, or failed, and future or caller-level skip decisions can use the reserved `skipped` status without changing the result type.
- As Opal, I can cancel a run and know its uncommitted tail is committed before the worktree is destroyed.
- As Phoebe, I can rely on successful runs reclaiming worktrees and branches while failed runs keep inspection state.
### Acceptance criteria

#### Prune primitive

- A public execution package API exposes a prune primitive or service method for workspace deletion.
- The primitive supports at least two modes: git-aware worktree removal and plain directory removal.
- Every prune request takes the resolved root used for containment, not a process-wide global root.
- The primitive resolves and checks the target path against the resolved root before any deletion without following the final target symlink before stat classification.
- An out-of-root target returns `rejected` with typed context and does not delete anything.
- An absent target returns `missing` instead of `deleted`.
- A worktree target is removed with `git worktree remove`, not plain directory removal.
- A scratch or run-directory target is removed with plain filesystem removal after containment succeeds.
- A worktree prune keeps the run branch ref unless the higher-level teardown policy deletes the branch separately.
- The primitive returns one of `deleted`, `missing`, `skipped`, `rejected`, or `failed` for every request. In this slice the destructive pruner produces `deleted`, `missing`, `rejected`, or `failed`; `skipped` is a reserved status for caller-level retention decisions or future non-destructive prune policies and must be documented as reserved in the type comments.
- The primitive emits a structured log with stable fields for run id, root, target path, mode, result, error code when present, and duration.
- Logged fields are redacted and do not include credentials, secrets, prompt text, issue bodies, or model output.
#### Orphaned worktree state reconciliation

- When a worktree directory is absent but the host repository may still contain stale worktree administration state, the primitive runs `git worktree prune` against the host repository.
- A prune of an already-absent worktree directory still returns `missing` after reconciliation succeeds.
- If stale-state reconciliation fails, the result is `failed` with sanitized context rather than a silent success.
- Reconciliation is limited to git worktree administrative state and does not delete branches.
#### Terminal-state teardown policy

- Teardown accepts enough run/workspace context to know the run id, run kind, terminal step, resolved workspace paths, expected branch, and host repository path when a worktree exists.
- A `done` implementing run removes the worktree through the prune primitive, removes the run directory/scratch through the prune primitive when needed, and deletes the run branch.
- A `canceled` implementing run commits the uncommitted tail to the run branch with an explicit Autocatalyst git identity before worktree removal, removes the worktree through the prune primitive, removes the run directory/scratch through the prune primitive when needed, and keeps the branch.
- A `failed` implementing run returns a skipped or retained result and leaves the worktree and branch in place.
- A `file_issue` run removes the scratch-only run directory through the prune primitive for `done`, `canceled`, and `failed` terminal steps.
- A `question` run at any terminal step (`done`, `canceled`, or `failed`) performs no filesystem or branch action and reports that no workspace exists to tear down.
- Unsupported run kinds or non-terminal steps fail with typed errors.
- Branch deletion for `done` runs happens only after the worktree is no longer checked out at that branch.
- If branch deletion fails after worktree deletion, teardown reports a partial failure with enough context for recovery.
#### Canceled final checkpoint

- Before a `canceled` worktree is pruned, teardown checks for uncommitted changes in the worktree.
- If there are changes, teardown stages and commits them on the run branch as a final checkpoint.
- The final-checkpoint commit supplies explicit Autocatalyst git identity through command-local git configuration, not ambient host, global, or repository `user.name` / `user.email`.
- The commit message follows `context-agent/standards/commit-and-title-conventions.md`: `feat: ...` for `feature` or `enhancement`, `fix: ...` for `bug`, and `chore: ...` for `chore`, with a lower-case subject and no trailing period. `checkpointKind` selects the prefix; when it is omitted, teardown uses `chore`. `checkpointSubject` is the unprefixed subject; when it is omitted or normalizes to empty, teardown uses the exact fallback subject `final checkpoint`.
- Checkpoint subject normalization trims surrounding whitespace, collapses internal spaces and tabs to single spaces, lowercases the subject, and removes trailing periods. Subjects containing line breaks or an embedded conventional prefix such as `feat:`, `fix:`, or `chore:` are invalid API input and fail with a typed `invalid_checkpoint_subject` error before staging, committing, or pruning.
- If there are no uncommitted changes, teardown skips the final checkpoint commit without failing.
- If checkpoint commit fails, teardown does not remove the worktree and returns a typed failure.
- If the worktree is already missing when `canceled` teardown starts, teardown keeps the branch, reports a retained outcome, and may reconcile stale git worktree admin state through the prune primitive; re-materializing the worktree is out of scope.
#### No deletion bypasses

- Workspace path deletion is owned by the prune primitive and its lifecycle driver only. The pruner-owned driver methods may invoke recursive directory removal and `git worktree remove`; teardown policy code and other workspace lifecycle policy code must call the prune primitive instead of invoking those driver methods or shell/filesystem deletion directly.
- Workspace provisioning rollback must route worktree and directory deletion through the prune primitive, preserving the original provisioning error while recording any rollback prune result.
- Tests or static checks cover that teardown routes all workspace path deletion through the primitive.
#### Integration tests

- An integration test creates a real temporary upstream repository, host clone, worktree, and scratch root using the provisioning API from issue 17.
- For a `done` run, the test asserts that the worktree and run branch are gone.
- For a `canceled` run with an uncommitted change, the test asserts that the final checkpoint commit exists on the retained branch and that the worktree is gone.
- For a `failed` run, the test asserts that the worktree and branch remain.
- For `file_issue` runs, tests assert that the scratch-only run directory is removed for `done`, `canceled`, and `failed` terminal steps while any parent scratch root remains unless it is the same path.
- The test asserts that pruning an already-absent path returns `missing`.
- The test asserts that pruning an out-of-root target returns `rejected` and leaves the filesystem unchanged.
- The test asserts that pruning an in-root symlink, including a symlink whose target points outside the workspace root, returns `rejected` with `target_not_directory` and does not delete or reconcile anything.
## Design spec

### Design scope

This is a backend execution-plane feature. It has no human-facing screen, layout, visual component, or product copy.
The design work is the developer and operator experience around a safe cleanup API: the request shape, the result shape, the retention outcomes, and the logs that explain what happened. The feature should make destructive behavior explicit and hard to call incorrectly.
### Developer experience

A future caller should treat teardown as one operation over a terminal run, not as a sequence of ad hoc git and filesystem commands.
The caller should be able to:
1. Build a teardown request from a terminal run, its work kind, its resolved workspace paths, and its expected branch.
2. Call a public function or service exported by `@autocatalyst/execution`.
3. Receive a typed result that names which actions were deleted, missing, skipped, retained, rejected, or failed.
4. Persist or surface the result without parsing git output or filesystem errors.
The prune primitive should also be callable directly by later garbage-collection and operator-action work. That direct API should still require the caller to choose a mode and supply the resolved root, so the safe path is the only convenient path.
### Operator experience

Operators should see predictable retention behavior without needing to inspect implementation details:
- Successful merged work does not leave worktrees or run branches behind.
- Canceled work remains recoverable from the retained branch, including any final uncommitted tail.
- Failed work keeps its worktree and branch for inspection.
- Throwaway issue-filing scratch disappears after filing.
- A cleanup attempt against a missing path is reported as `missing`.
- A cleanup attempt outside the resolved root is reported as `rejected`.
Structured logs are enough for this slice. There is no new UI, but log fields should be stable because later operational surfaces may read them.
### Prune flow

For both prune modes, containment uses the caller-supplied workspace root after resolving that
root to its real filesystem path. The target path is converted to an absolute, normalized path for
the containment check, but the pruner must not follow the final target path component before
`statPath`/`lstat` classifies it. This preserves the guard against path traversal while allowing a
symlink entry inside the workspace root, including one whose target points outside the root, to be
classified and rejected as `target_not_directory`. A target whose normalized path itself escapes the
resolved root is rejected as `out_of_root_path` before any stat, git reconciliation, or deletion
call.
For a plain directory prune, the flow is:
1. Record the start time.
2. Resolve the configured root and target path.
3. Run containment against the resolved root without following the final target symlink.
4. Stat the target with symlink-aware classification.
5. If absent, emit a `missing` log and return `missing`.
6. If present but not a directory, including a regular file, symlink, or other special filesystem entry, emit `rejected` with `target_not_directory` and do not delete it.
7. Remove the directory recursively.
8. Emit a `deleted` log with duration and return `deleted`.
9. Convert expected guard and filesystem failures into typed `rejected` or `failed` results.
For a git worktree prune, the flow is:
1. Record the start time.
2. Resolve and check the worktree path against the resolved workspace root without following the
	final target symlink.
3. Stat the worktree path with symlink-aware classification.
4. If the worktree path exists but is not a directory, including a regular file, symlink, or other special filesystem entry, emit `rejected` with `target_not_directory` and do not run any git removal command.
5. If the worktree path exists as a directory, run `git worktree remove` from the host repository.
6. If the worktree path is absent, run `git worktree prune` from the host repository to reconcile stale administration state, then return `missing`.
7. Emit a structured log with the result and duration.
The primitive should not delete branches. Branch deletion is a retention-policy action above the prune primitive.
### Teardown flow

For a `done` implementing run:
1. Verify the run is terminal at `done` and has two-root workspace context.
2. Prune the worktree in git-aware mode.
3. Prune the run directory in plain mode if it still exists after worktree removal.
4. Delete the run branch from the host repository after worktree prune succeeds, even if the post-worktree run-directory prune reports `failed` or `rejected`.
5. Return a teardown result that records each action.
For a `canceled` implementing run:
1. Verify the run is terminal at `canceled` and has two-root workspace context.
2. Confirm the worktree is present and on the expected branch.
3. Detect uncommitted changes.
4. If changes exist, stage and commit them with the final-checkpoint message.
5. Prune the worktree in git-aware mode.
6. Prune the run directory in plain mode if it still exists after worktree removal.
7. Keep the branch and return a teardown result that records the retained branch.
For a `failed` implementing run, teardown should return a retained result without pruning or branch deletion. For a `file_issue` run at any terminal step (`done`, `canceled`, or `failed`), teardown should prune the scratch-only run directory (`runRoot`) in plain mode, not the parent scratch root unless the two paths are identical. For a `question` run at any terminal step, teardown should return a no-workspace skipped result.
### Result shape

The prune result should be small and explicit. A representative shape is:
```typescript
type WorkspacePruneResult = {
  runId: string;
  mode: 'worktree' | 'directory';
  // 'skipped' is reserved for caller-level or future retention decisions;
  // the destructive pruner in this feature normally returns deleted/missing/rejected/failed.
  status: 'deleted' | 'missing' | 'skipped' | 'rejected' | 'failed';
  root: string;
  targetPath: string;
  durationMs: number;
  errorCode?: string;
};
```
The teardown result can aggregate prune results and branch/checkpoint actions:
```typescript
type WorkspaceTeardownResult = {
  runId: string;
  runKind: WorkspaceRunKind;
  terminalStep: 'done' | 'canceled' | 'failed';
  outcome: 'completed' | 'retained' | 'skipped' | 'partial_failure' | 'failed';
  prunes: WorkspacePruneResult[];
  branch?: {
    name: string;
    action: 'deleted' | 'retained' | 'not_applicable' | 'failed';
  };
  checkpoint?: {
    action: 'committed' | 'no_changes' | 'not_applicable' | 'failed';
    commitSha?: string;
  };
};
```
Exact field names may follow implementation conventions, but callers must not need to parse prose to know what happened.
### Error design

Expected failures should be typed and sanitized:
- Invalid terminal state for teardown.
- Unsupported run kind.
- Missing required workspace context for the selected run kind.
- Out-of-root target path.
- Non-directory target for directory or worktree pruning.
- Missing host repository for worktree operations.
- Worktree branch mismatch before a canceled final checkpoint.
- Git worktree removal failure.
- Git worktree stale-state prune failure.
- Plain directory removal failure.
- Final-checkpoint commit failure.
- Branch deletion failure.
Error context should include run id, run kind, terminal step, action, target path, root kind, expected branch, and actual branch when available. Public error context should not include raw git command strings, raw command environments, credentials, full remote URLs with embedded credentials, secret values, prompts, model output, or issue bodies. Exit status may be kept as sanitized internal diagnostics when useful, but public lifecycle error summaries should use one shared redacted shape rather than parallel provisioning/prune/teardown cause-summary types.
### Empty, missing, and partial states

A missing target is not exceptional for the prune primitive. It should return `missing` and still reconcile git worktree administrative state when the mode is `worktree`.
A `failed` terminal run intentionally keeps workspace state. Teardown should make that explicit with a retained or skipped result instead of treating it as no-op success.
A partial teardown can happen after one destructive action succeeds and a later one fails. For example, a `done` run may remove its worktree and then fail to delete the branch. The result must make the partial state explicit so later recovery or operator cleanup can act on the remaining branch.
After a worktree prune succeeds for `done` or `canceled`, teardown still attempts the post-worktree run-directory prune. If that run-directory prune fails or is rejected, teardown records the prune action with purpose `run_directory`, the target path, and the prune error code. For `done`, branch deletion still proceeds after a run-directory prune failure because the worktree is no longer checked out and branch deletion is a separate retention action; the aggregate outcome is `partial_failure` if either the run-directory prune or branch deletion fails. For `canceled`, the branch remains retained by policy and a run-directory prune failure after successful worktree prune yields `partial_failure`. The result must make remaining cleanup explicit through the failed prune action and, when applicable, `branch.action: 'failed'`.
## Tech spec

### Current state

The repository already has the contracts this feature must follow:
- `context-human/concepts/workspace.md` defines creation and teardown, terminal-state retention, containment, and the safe pruning step.
- ADR-020 chooses git worktrees on a shared host repository for co-located execution and requires `git worktree prune` for out-of-band removed worktrees.
- ADR-021 defines terminal-state retention and the one safe-delete primitive.
- `context-agent/standards/workspace-conventions.md` records the operational rules for worktree removal, prune results, and retention.
- `context-agent/standards/commit-and-title-conventions.md` defines the final-checkpoint commit message prefix and format.
- `packages/core/src/run-step-catalog.ts` defines terminal steps through `terminalSteps` and `deriveRunTerminal`.
- `packages/execution/src/workspace.ts` currently exports workspace provisioning types and `provisionWorkspace`.
- `packages/execution/src/internal/workspace-paths.ts` owns path resolution, segment validation, branch-name derivation, and `assertPathInsideRoot`.
- `packages/execution/src/internal/workspace-driver.ts` owns git commands and guarded filesystem operations used by provisioning.
- `packages/execution/src/internal/workspace-provisioner.ts` orchestrates no-workspace, scratch-only, and two-root provisioning plus rollback.
- `packages/execution/src/workspace.integration.spec.ts` already creates real temporary git repositories and proves provisioning behavior.
This feature should extend the execution workspace modules rather than introduce cleanup logic in the control plane.
### Proposed package shape

Keep the implementation inside `packages/execution`.
Recommended files:
- `packages/execution/src/workspace.ts` — add public prune and teardown request/result types, error codes, and exported functions such as `pruneWorkspacePath` and `teardownWorkspace`.
- `packages/execution/src/internal/workspace-driver.ts` — extend the existing workspace driver, or expose an internal lifecycle interface that extends it, with methods for `git worktree remove`, `git worktree prune`, status detection, staging, committing with explicit identity, branch deletion, and plain directory removal. Avoid creating an unrelated parallel driver shape.
- `packages/execution/src/internal/workspace-pruner.ts` — implement the single prune primitive, containment checks, stat-before-remove behavior, typed results, structured logging, and git stale-state reconciliation.
- `packages/execution/src/internal/workspace-teardown.ts` — implement terminal-state retention policy by composing checkpoint, prune, and branch operations.
- `packages/execution/src/workspace-pruner.spec.ts` — unit coverage for result mapping, containment rejection, missing targets, file and symlink target rejection, logging fields, and failure mapping with a fake driver.
- `packages/execution/src/workspace-teardown.spec.ts` — unit coverage for policy selection, checkpoint-before-prune ordering, branch retention/deletion, and partial failure results with a fake driver.
- `packages/execution/src/workspace-teardown.integration.spec.ts` — real git proof for `done`, `canceled`, `failed`, `file_issue`, `missing`, and `rejected` cases.
The public entry point remains `packages/execution/src/index.ts`; control-plane packages continue to import only `@autocatalyst/execution`.
### Public API additions

Add types that let callers provide explicit context without reaching into execution internals:
```typescript
type WorkspacePruneMode = 'worktree' | 'directory';
type WorkspacePruneStatus = 'deleted' | 'missing' | 'skipped' | 'rejected' | 'failed'; // skipped is reserved; see result semantics below.

interface PruneWorkspacePathRequest {
  readonly runId: string;
  readonly mode: WorkspacePruneMode;
  readonly workspaceRoot: string;
  readonly targetPath: string;
  readonly hostRepositoryPath?: string;
}

interface TeardownWorkspaceRequest {
  readonly runId: string;
  readonly runKind: WorkspaceRunKind;
  readonly terminalStep: 'done' | 'canceled' | 'failed';
  readonly workspaceRoot?: string;
  readonly runRoot?: string;
  readonly repoRoot?: string;
  readonly scratchRoot?: string;
  readonly hostRepositoryPath?: string;
  readonly branchName?: string;
  readonly checkpointKind?: 'feature' | 'enhancement' | 'bug' | 'chore';
  readonly checkpointSubject?: string;
}
```
Implementation may choose narrower names, but the request must carry the resolved paths from provisioning or execution context. The teardown API should not recompute project paths from partial data unless it delegates to the existing path resolver with a full `Project` and roots request.
### Prune primitive implementation

`workspace-pruner.ts` should be the only module that requests workspace path removal; the lifecycle driver methods it owns are the only implementation points that may perform recursive directory removal or `git worktree remove`. It should:
1. Start a monotonic timer.
2. Call `assertPathInsideRoot({ root: workspaceRoot, rootKind: 'workspace', targetPath, intent: 'delete' }, deps)` after resolving the root but without following the final target symlink.
3. Stat the target with driver support that distinguishes absent from other stat failures and classifies symlink entries with `lstat` semantics.
4. Reject present non-directory targets, including files, symlinks, and special filesystem entries, with `target_not_directory` before any deletion or git cleanup call.
5. For `directory` mode, call one driver method that performs plain recursive directory removal.
6. For `worktree` mode with a present directory target, call one driver method that runs `git worktree remove --force ` from the host repository.
7. For `worktree` mode with an absent target, call one driver method that runs `git worktree prune` from the host repository, then return `missing`.
8. Map containment errors and non-directory targets to `rejected`, and operational errors to `failed`.
9. Emit one structured log per prune attempt, including failures.
The existing `WorkspaceProvisioningError` may be generalized to a workspace lifecycle error, or new `WorkspacePruneError` and `WorkspaceTeardownError` types may be added. If new types are added, they should reuse the existing redaction helpers or move those helpers to a neutral workspace diagnostics section. The existing provisioning cause-summary shape from issue 17 should be renamed or generalized into one shared `WorkspaceErrorCauseSummary`; do not add a second parallel cause-summary type for teardown. Public summaries should omit raw command strings and raw environments, and should include only sanitized diagnostic fields.
### Teardown policy implementation

`workspace-teardown.ts` should compose smaller operations and avoid direct deletion.
Policy table:

Run kind / terminal step
Worktree action
Scratch/run directory action
Branch action
Checkpoint action

implementing + `done`
prune worktree
prune run directory if present
delete branch
none

implementing + `canceled`
prune worktree
prune run directory if present
retain branch
commit uncommitted tail first

implementing + `failed`
retain
retain
retain
none

`file_issue`  • `done`
not applicable
prune scratch-only run directory (`runRoot`)
not applicable
none

`file_issue`  • `canceled`
not applicable
prune scratch-only run directory (`runRoot`)
not applicable
none

`file_issue`  • `failed`
not applicable
prune scratch-only run directory (`runRoot`)
not applicable
none

`question`  • `done`
not applicable
not applicable
not applicable
none

`question`  • `canceled`
not applicable
not applicable
not applicable
none

`question`  • `failed`
not applicable
not applicable
not applicable
none

For `done`, delete the branch after the worktree is removed. Use `git branch -D ` or the repository driver's equivalent from the host repository. Do not delete the branch if worktree prune fails. Do proceed to branch deletion after a post-worktree run-directory prune failure, and return `partial_failure` with both the failed prune action and the branch action.
For `canceled`, verify the worktree branch before committing. Detect uncommitted changes with a porcelain status command or equivalent. When changes exist, stage all worktree changes and commit them with a message derived from `checkpointKind` and `checkpointSubject`. The prefix is `feat` for `feature` or `enhancement`, `fix` for `bug`, and `chore` for `chore` or an omitted `checkpointKind`; the subject is normalized as specified in the canceled final checkpoint criteria, falling back to `final checkpoint` when omitted. For example, an omitted kind and subject produce the exact commit message `chore: final checkpoint`. The commit must pass explicit Autocatalyst identity via git configuration for the command, for example `git -c user.name=Autocatalyst -c user.email=autocatalyst@example.invalid commit ...`, rather than relying on ambient global or repository config. If the checkpoint input is invalid or the checkpoint fails, return failure and do not prune the worktree. If the worktree is already missing at teardown, do not try to re-materialize it; reconcile any stale worktree admin state through the prune primitive, keep the branch, mark the checkpoint as not applicable, and report a retained outcome.
For `failed`, return a retained result without calling the prune primitive. This makes the policy observable and prevents accidental cleanup.
For a `question` run at any terminal step (`done`, `canceled`, or `failed`), return `outcome: 'skipped'` with no branch, checkpoint, or prune actions. Non-terminal steps for `question` runs remain invalid terminal teardown requests.
### Logging and telemetry

Use the repository logging convention: emit through a `createLogger(component)` facade when available. If the facade does not exist yet, introduce only the smallest execution-local structured-emitter seam needed for stable event payloads and unit tests. Do not build a broader logging facade, telemetry abstraction, or OpenTelemetry integration in this feature; later observability work owns that.
Suggested stable event codes:
- `workspace.prune.started`
- `workspace.prune.completed`
- `workspace.teardown.started`
- `workspace.teardown.completed`
- `workspace.teardown.partial_failure`
Each prune log should include `component`, `event`, `runId`, `mode`, `rootKind`, `targetPath`, `status`, and `durationMs`. Each teardown log should include `runId`, `runKind`, `terminalStep`, `outcome`, branch action, checkpoint action, and aggregate prune statuses. Do not log prompt, issue body, model output, environment variables, credentials, or raw remote URLs.
### Driver changes

Extend the existing `WorkspaceDriver` or define an internal `WorkspaceLifecycleDriver` interface that extends/reuses the existing driver instead of duplicating it. Lifecycle methods include:
- `statPath(targetPath): Promise`
- `removeDirectory({ workspaceRoot, targetPath })`
- `removeWorktree({ hostRepositoryPath, repoRoot })`
- `pruneWorktreeAdminState({ hostRepositoryPath })`
- `currentBranch(repoRoot)`
- `hasUncommittedChanges(repoRoot)`
- `stageAll(repoRoot)`
- `commit(repoRoot, message, identity): Promise`
- `deleteBranch({ hostRepositoryPath, branchName })`
Keep git calls as argument arrays through `execFile`, as the current driver does. Sanitize wrapped stdout/stderr and error messages before they enter public result context or logs.
### Interaction with provisioning rollback

The issue requires no workspace deletion to bypass the prune primitive. Provisioning rollback currently removes a just-created worktree and run directory through driver methods, which violates the invariant once this feature exists. Refactor rollback to call the new prune primitive for both worktree and directory deletion. Rollback should inspect the typed prune results, preserve the original provisioning failure as the primary error, and attach sanitized rollback cleanup context when prune fails or is rejected. There is no documentation-only exception for rollback.
The final code should make it easy to audit that `git worktree remove` and recursive workspace directory removal live only in the lifecycle driver methods owned by the prune primitive, and that policy code reaches them only through the pruner.
### Testing strategy

Unit tests should cover:
- Prune status mapping for `deleted`, `missing`, `rejected`, and `failed`.
- Containment rejection before driver deletion calls.
- Worktree mode running git-aware removal for present targets.
- Worktree mode running `git worktree prune` for absent targets.
- Directory mode using plain removal only after containment succeeds.
- Directory and worktree modes rejecting file, symlink, and other non-directory targets without deletion.
- Teardown policy selection for implementing `done`/`canceled`/`failed`, all-terminal `file_issue`, and all-terminal `question`.
- `canceled` ordering: branch guard, status check, optional commit, worktree prune, directory prune.
- `done` ordering: worktree prune before branch deletion.
- Partial failure reporting when branch deletion fails after prune success.
- Sanitized error context and log fields.
Integration tests should use the existing temporary-git style from `workspace.integration.spec.ts`. Use `provisionWorkspace` to create the real workspace, write an uncommitted file for the `canceled` case, call teardown, and assert with git commands and filesystem stats.
Recommended targeted validation uses Vitest's positional file filters through the Nx Vite test
target. If a future Nx/Vitest version does not pass positional filters through, run
`pnpm nx test execution` instead of inventing a Jest-only option.
```bash
pnpm nx test execution -- workspace-paths.spec.ts
pnpm nx test execution -- workspace-provisioner.spec.ts
pnpm nx test execution -- workspace.integration.spec.ts
pnpm nx test execution -- workspace-teardown.integration.spec.ts
pnpm nx build execution
pnpm nx lint execution
```
Run broader validation with `pnpm validate` when implementation changes are complete.
### Risks and constraints

- Git refuses to delete a branch that is still checked out in any worktree, so `done` teardown must remove the worktree before branch deletion.
- A canceled final-checkpoint commit must supply an explicit Autocatalyst committer identity so clean hosts without global `user.name` or `user.email` still satisfy the canceled-run preservation guarantee. Hooks, locked indexes, or malformed branch state can still make the commit fail; in those cases, preserving the worktree remains the fail-safe backstop.
- An absent worktree directory can still leave administrative state in the host repository; `git worktree prune` handles that but may fail if the host repository is unavailable.
- Scheduled garbage collection and automatic teardown wiring are out of scope, so this feature provides callable behavior before it is invoked automatically by the run lifecycle.
## Task list

### Story 1: Expose workspace lifecycle API types

**Description:** Define the public prune and teardown API surface in `packages/execution/src/workspace.ts` and re-export it from `packages/execution/src/index.ts` following the public API additions described in this spec.
**Acceptance criteria:**
- `workspace.ts` exports the new prune mode/status/result types, teardown outcome/action/result types, lifecycle error codes, error context types, `WorkspacePruneError`, `WorkspaceTeardownError`, `pruneWorkspacePath`, and `teardownWorkspace`.
- `index.ts` re-exports every new public type and function from `workspace.ts`.
- Existing provisioning exports remain source-compatible for current callers and tests.
- Public error context uses the neutral `WorkspaceErrorCauseSummary` while retaining existing redaction behavior.
- `pnpm nx test execution -- index.spec.ts` passes or is updated to prove the new exports.
**Dependencies:** None.
#### Task 1.1: Refactor shared workspace diagnostics

**Description:** Rename or generalize the provisioning-only cause summary helpers so prune and teardown errors can reuse the same redaction path.
**Acceptance criteria:**
- `WorkspaceErrorCauseSummary` is available from `workspace.ts`.
- `WorkspaceProvisioningErrorCauseSummary` from the provisioning work is renamed, aliased, or otherwise reconciled into the single shared `WorkspaceErrorCauseSummary`; prune and teardown do not introduce parallel public cause-summary shapes.
- Existing `summarizeWorkspaceCause` and `redactWorkspaceDiagnostic` behavior stays compatible.
- Existing provisioning error contexts continue to expose sanitized messages and credential-redacted URLs.
- Public lifecycle error context does not expose raw git command strings, raw command environments, or credential-bearing URLs; exit status, if surfaced, is sanitized and not coupled to command text.
- Unit tests cover credential redaction for at least one new lifecycle error path.
**Dependencies:** None.
#### Task 1.2: Add public prune types and entrypoint

**Description:** Add `WorkspacePruneMode`, `WorkspacePruneStatus`, `PruneWorkspacePathRequest`, `WorkspacePruneResult`, prune error codes/context, `WorkspacePruneError`, and the public `pruneWorkspacePath` function.
**Acceptance criteria:**
- Type names and status values match the public API additions in this spec.
- `pruneWorkspacePath` constructs the node workspace driver and delegates to the internal pruner.
- Invalid API usage that prevents a typed result throws `WorkspacePruneError`; expected operational outcomes return `WorkspacePruneResult`.
- The function accepts caller-supplied resolved paths and does not infer a process-global root.
**Dependencies:** Task 1.1.
#### Task 1.3: Add public teardown types and entrypoint

**Description:** Add terminal teardown types, branch/checkpoint/prune action shapes, teardown errors, and the public `teardownWorkspace` function.
**Acceptance criteria:**
- Type names and outcome/action values match the public API additions in this spec.
- `teardownWorkspace` constructs the node workspace driver, injects the public prune primitive, and delegates to the internal teardown module.
- Invalid terminal teardown requests throw `WorkspaceTeardownError`.
- Operational failures after policy execution starts are represented in `WorkspaceTeardownResult`.
**Dependencies:** Tasks 1.1 and 1.2.
#### Task 1.4: Re-export lifecycle API from the package entrypoint

**Description:** Update `packages/execution/src/index.ts` so control-plane and future callers import only from `@autocatalyst/execution`.
**Acceptance criteria:**
- All public API additions listed in this spec are exported from `index.ts`.
- No execution internals are exported.
- Existing package entrypoint tests still pass.
**Dependencies:** Tasks 1.2 and 1.3.
### Story 2: Extend the workspace driver for lifecycle operations

**Description:** Add the low-level git and filesystem operations that pruning and teardown need while keeping git calls argument-array based and diagnostics sanitized.
**Acceptance criteria:**
- Lifecycle operations extend or reuse the existing `WorkspaceDriver`; the resulting internal driver surface supports `statPath`, guarded `removeDirectory`, `removeWorktree`, `pruneWorktreeAdminState`, `currentBranch`, `hasUncommittedChanges`, `stageAll`, `commit` with explicit identity, and `deleteBranch`.
- Existing provisioning driver behavior remains intact.
- Git commands use `execFile` with argument arrays.
- Driver methods wrap failures with sanitized context and stable error codes.
**Dependencies:** Story 1.
#### Task 2.1: Add path stat support

**Description:** Add `statPath(targetPath): Promise` to distinguish `file`, `directory`, `symlink`, `other`, and `missing` without conflating absent paths with other filesystem failures.
**Acceptance criteria:**
- Missing paths return `missing`.
- Directories return `directory`.
- Files return `file`.
- Symlinks return `symlink`, even when they point at a directory.
- Symlinks return `symlink`, even when they point outside the workspace root.
- Non-file, non-directory, non-symlink special filesystem entries return `other`.
- Permission or unexpected stat failures propagate as typed/sanitized operational failures for the pruner to map.
**Dependencies:** Task 1.2.
#### Task 2.2: Add git worktree lifecycle operations

**Description:** Add driver methods for git-aware worktree removal and stale worktree administration reconciliation.
**Acceptance criteria:**
- `removeWorktree` runs `git worktree remove --force ` from `hostRepositoryPath`.
- `pruneWorktreeAdminState` runs `git worktree prune` from `hostRepositoryPath`.
- Neither method deletes the run branch.
- Failures expose sanitized causes and map to worktree lifecycle error codes.
**Dependencies:** Task 2.1.
#### Task 2.3: Add branch and checkpoint operations

**Description:** Add driver methods for branch inspection, dirty-worktree detection, staging, committing, and branch deletion.
**Acceptance criteria:**
- `currentBranch` returns the named branch or `null` for detached/unknown state.
- `hasUncommittedChanges` uses porcelain status or equivalent and treats staged, unstaged, deleted, and untracked files as changes.
- `stageAll` stages additions, modifications, deletions, and renames.
- `commit` receives explicit Autocatalyst `user.name` and `user.email` configuration and returns the created commit SHA.
- `deleteBranch` deletes the local host-repository branch only after teardown asks for it.
- Git failure diagnostics are sanitized before they reach public contexts or logs.
**Dependencies:** Task 2.2.
#### Task 2.4: Keep guarded directory removal as the only plain filesystem deletion method

**Description:** Ensure plain recursive directory removal remains behind one lifecycle driver method that receives both `workspaceRoot` and `targetPath`.
**Acceptance criteria:**
- The driver validates containment with `assertPathInsideRoot` before calling `fs.rm`.
- The pruner passes the validated root and target into this method.
- No new direct `fs.rm` call sites are added outside the driver method that the pruner uses.
**Dependencies:** Task 2.1.
### Story 3: Implement the safe prune primitive

**Description:** Create `packages/execution/src/internal/workspace-pruner.ts` as the single safe workspace deletion primitive for directory and worktree cleanup.
**Acceptance criteria:**
- Prune checks containment against the caller-supplied resolved `workspaceRoot` before deletion.
- Prune stats the target before removing it.
- Directory mode removes plain directories through the lifecycle driver.
- Worktree mode removes present worktrees through `git worktree remove`.
- Missing worktree mode runs `git worktree prune` and returns `missing` after reconciliation succeeds.
- Every prune returns one of the declared statuses. This feature's destructive pruner produces `deleted`, `missing`, `rejected`, or `failed`; `skipped` is reserved for caller-level retention decisions or future prune policies and should be documented as such in the type comments.
- Every prune emits one structured completion log with stable sanitized fields.
**Dependencies:** Stories 1 and 2.
#### Task 3.1: Build the pruner factory and dependency seam

**Description:** Add `WorkspacePrunerDependencies` and `createWorkspacePruner` with injectable driver, containment dependencies, clock/timer, and logger seams suitable for unit tests.
**Acceptance criteria:**
- The public `pruneWorkspacePath` entrypoint can construct the pruner with the node driver.
- Unit tests can inject fake drivers and deterministic timers.
- The pruner module does not import control-plane packages.
**Dependencies:** Tasks 1.2 and 2.1.
#### Task 3.2: Implement containment and stat-before-remove

**Description:** Resolve and validate `workspaceRoot` and `targetPath` with `assertPathInsideRoot`, then stat the target before any deletion call.
**Acceptance criteria:**
- Out-of-root targets return `status: 'rejected'` with `errorCode: 'out_of_root_path'`.
- Rejected targets do not call driver deletion or git reconciliation methods.
- Missing directory targets return `status: 'missing'`.
- File, symlink, and other non-directory targets return `status: 'rejected'` with `errorCode: 'target_not_directory'` in both directory and worktree modes.
- An in-root symlink whose target points outside the workspace root returns `status: 'rejected'` with `errorCode: 'target_not_directory'`, not `out_of_root_path`, because containment does not follow the final symlink before stat classification.
- Unexpected stat failures return `status: 'failed'` with `errorCode: 'target_stat_failed'`.
**Dependencies:** Task 3.1.
#### Task 3.3: Implement directory and worktree deletion modes

**Description:** Route directory mode to guarded plain removal and worktree mode to git-aware removal or stale-state reconciliation.
**Acceptance criteria:**
- Present directory targets call only `driver.removeDirectory`.
- Present worktree targets call only `driver.removeWorktree`.
- Missing worktree targets call `driver.pruneWorktreeAdminState` and return `missing` when reconciliation succeeds.
- Missing worktree reconciliation failure returns `failed` with `worktree_admin_prune_failed`.
- Missing `hostRepositoryPath` for worktree mode returns `failed` with `missing_host_repository`.
- File, symlink, and other non-directory targets never call `removeDirectory`, `removeWorktree`, or `pruneWorktreeAdminState`.
- Unsupported mode throws `WorkspacePruneError` with `unsupported_prune_mode`.
**Dependencies:** Tasks 3.1 and 3.2.
#### Task 3.4: Emit structured prune logs

**Description:** Add the smallest execution-local logging seam needed for stable prune events without introducing control-plane coupling.
**Acceptance criteria:**
- Logs include `component`, `event`, `runId`, `mode`, `rootKind`, `targetPath`, `status`, `errorCode` when present, and `durationMs`.
- Logs do not include credentials, prompt text, issue bodies, model output, environment variables, or raw remote URLs.
- Unit tests assert log payload shape for success and failure cases.
**Dependencies:** Task 3.3.
#### Task 3.5: Cover prune behavior with unit tests

**Description:** Add `packages/execution/src/workspace-pruner.spec.ts` using a fake lifecycle driver.
**Acceptance criteria:**
- Tests cover `deleted`, `missing`, `rejected`, and `failed` status mapping.
- Tests prove containment rejection happens before deletion calls.
- Tests prove file and symlink targets are rejected in both directory and worktree modes without deletion.
- Tests prove an in-root symlink pointing outside the workspace root is rejected as `target_not_directory` without deletion or git reconciliation.
- Tests prove present worktree deletion and missing worktree admin reconciliation use the expected driver methods.
- Tests prove sanitized log and error fields.
**Dependencies:** Tasks 3.1 through 3.4.
### Story 4: Implement terminal-state teardown policy

**Description:** Create `packages/execution/src/internal/workspace-teardown.ts` to apply terminal retention policy by composing checkpoint, prune, and branch operations.
**Acceptance criteria:**
- Implementing `done`, `canceled`, and `failed` runs follow the retention table.
- `file_issue` runs prune scratch-only run directories for every terminal step.
- `question` runs report no workspace action for `done`, `canceled`, and `failed`.
- Unsupported run kinds and invalid terminal steps fail with typed errors.
- Teardown never directly calls filesystem deletion or git worktree deletion driver methods; it uses the injected prune primitive.
**Dependencies:** Story 3.
#### Task 4.1: Build teardown factory and request validation

**Description:** Add `WorkspaceTeardownDependencies` and `createWorkspaceTeardown`, then validate run kind, terminal step, and required workspace context for each policy branch.
**Acceptance criteria:**
- Implementing runs require `workspaceRoot`, `runRoot`, `repoRoot`, `hostRepositoryPath`, and `branchName` for destructive or checkpoint paths.
- `file_issue` cleanup at `done`, `canceled`, or `failed` requires the scratch-only run directory as `runRoot` and a containing workspace root; it does not target the parent scratch root unless that path is identical to `runRoot`.
- `question` teardown does not require workspace paths.
- Non-terminal or unsupported requests throw `WorkspaceTeardownError` with sanitized context.
**Dependencies:** Task 3.1.
#### Task 4.2: Implement `done` policy

**Description:** For implementing runs at `done`, prune the worktree, prune the run directory when needed, then delete the branch.
**Acceptance criteria:**
- Worktree prune runs before branch deletion.
- Branch deletion is skipped when worktree prune fails.
- Run-directory prune records its own action and result.
- Branch deletion still runs after a run-directory prune failure or rejection, and the aggregate result remains `partial_failure`.
- Run-directory prune failure or rejection after worktree removal is represented by a failed `run_directory` prune action with the target path and error code.
- Branch deletion failure after successful prune returns `outcome: 'partial_failure'` and `branch.action: 'failed'`.
- Successful policy returns `outcome: 'completed'` and `branch.action: 'deleted'`.
**Dependencies:** Task 4.1.
#### Task 4.3: Implement `canceled` final checkpoint and retention policy

**Description:** For implementing runs at `canceled`, verify the branch, commit any uncommitted tail, prune workspace paths, and retain the branch.
**Acceptance criteria:**
- Teardown checks the current branch before staging or committing.
- Branch mismatch returns a typed failure and does not prune.
- No changes produce `checkpoint.action: 'no_changes'`.
- Changes produce `checkpoint.action: 'committed'` with a commit SHA.
- The commit message uses the conventional prefix derived from `checkpointKind`, or `chore` when `checkpointKind` is omitted, and a normalized lower-case subject with no trailing period. When `checkpointSubject` is omitted, the exact message is `chore: final checkpoint` unless `checkpointKind` supplies a different prefix. Invalid checkpoint subjects fail before staging, committing, or pruning. The git commit command supplies explicit Autocatalyst `user.name` and `user.email` values so it does not depend on host identity config.
- Checkpoint failure returns `outcome: 'failed'` and does not prune.
- If the worktree is already missing before checkpoint inspection, teardown does not fail or re-materialize it; it keeps the branch, records `checkpoint.action: 'not_applicable'`, optionally records a `missing` worktree prune/reconciliation result, and returns `outcome: 'retained'` unless reconciliation itself fails.
- Run-directory prune failure or rejection after worktree removal returns `outcome: 'partial_failure'` while keeping `branch.action: 'retained'`.
- Successful cancellation returns branch action `retained`.
**Dependencies:** Tasks 4.1 and 2.3.
#### Task 4.4: Implement retained, scratch-only, and no-workspace policies

**Description:** Add the non-destructive `failed` implementing behavior plus all-terminal `file_issue` scratch cleanup and `question` handling.
**Acceptance criteria:**
- Implementing `failed` returns `outcome: 'retained'` and performs no prune or branch deletion.
- `file_issue` at `done`, `canceled`, or `failed` prunes the scratch-only run directory (`runRoot`) in directory mode, records the prune purpose as `run_directory`, and returns a completed or failed outcome based on that result.
- `question` at `done`, `canceled`, or `failed` returns `outcome: 'skipped'` with no branch, checkpoint, or prune actions.
- Unsupported run kind / terminal-step combinations fail with typed errors.
**Dependencies:** Task 4.1.
#### Task 4.5: Emit structured teardown logs

**Description:** Add structured started/completed/partial-failure teardown logs through the same execution-local logging seam.
**Acceptance criteria:**
- Logs include `runId`, `runKind`, `terminalStep`, `outcome`, branch action, checkpoint action, and aggregate prune statuses.
- Logs omit prompts, issue bodies, model output, credentials, raw environments, and raw credential-bearing remote URLs.
- Unit tests assert log payloads for completed, retained, failed, and partial-failure outcomes.
**Dependencies:** Tasks 4.2 through 4.4.
#### Task 4.6: Cover teardown behavior with unit tests

**Description:** Add `packages/execution/src/workspace-teardown.spec.ts` with fake drivers and a fake prune primitive.
**Acceptance criteria:**
- Tests cover policy selection for implementing `done`, `canceled`, `failed`, `file_issue`, and `question` at `done`, `canceled`, and `failed`.
- Tests prove canceled ordering: branch guard, dirty check, stage, commit, worktree prune, run-directory prune.
- Tests assert canceled checkpoint message normalization, the `chore: final checkpoint` fallback when no subject is supplied, and typed failure for invalid checkpoint subjects.
- Tests prove done ordering: worktree prune before branch deletion.
- Tests prove partial failure when branch deletion fails after pruning.
- Tests prove teardown does not directly call `removeDirectory` or `removeWorktree`; only the injected prune primitive may trigger deletion.
**Dependencies:** Tasks 4.1 through 4.5.
### Story 5: Remove or isolate deletion bypasses

**Description:** Make workspace deletion auditable by routing terminal teardown and provisioning rollback deletion through the prune primitive.
**Acceptance criteria:**
- New teardown code has no direct `fs.rm`, `rm -rf`, or `git worktree remove` calls.
- New direct workspace deletion behavior exists only in the pruner and the lifecycle driver methods it owns.
- Provisioning rollback is refactored to use the prune primitive for worktree and run-directory cleanup; no direct rollback deletion path remains.
- Tests or static assertions cover the no-deletion-bypass invariant for teardown.
**Dependencies:** Stories 3 and 4.
#### Task 5.1: Audit existing deletion call sites

**Description:** Search the repository for direct workspace deletion commands and classify each occurrence as pruner-owned, driver-owned, test-only, or a rollback bypass that must be removed.
**Acceptance criteria:**
- The implementation notes or test comments identify the allowed production deletion call sites.
- No production code outside the pruner-owned path introduces or retains direct workspace deletion calls.
- Test fixtures that mention deletion commands are not mistaken for production bypasses.
**Dependencies:** Story 3.
#### Task 5.2: Refactor provisioning rollback through prune

**Description:** Change `workspace-provisioner.ts` rollback to call the same prune primitive for created worktrees and run roots.
**Acceptance criteria:**
- Rollback still removes a created worktree before deleting the run root.
- Rollback preserves the original provisioning failure and includes sanitized rollback context when cleanup fails.
- Existing `workspace-provisioner.spec.ts` rollback tests pass after the refactor.
- No direct `driver.removeWorktree`, `driver.removeDirectory`, `fs.rm`, or equivalent rollback deletion remains outside the prune primitive.
**Dependencies:** Stories 3 and 4.
#### Task 5.3: Add no-bypass test coverage

**Description:** Add tests that fail if teardown bypasses the prune primitive for filesystem or worktree deletion.
**Acceptance criteria:**
- Teardown fake driver throws if `removeDirectory` or `removeWorktree` is called directly.
- Tests verify successful teardown when only the injected prune primitive performs delete actions.
- Rollback tests verify provisioning cleanup calls the prune primitive and does not call `driver.removeWorktree`, `driver.removeDirectory`, `fs.rm`, or equivalent deletion directly from rollback policy code.
- The invariant is named clearly so future maintainers know why the test exists.
**Dependencies:** Task 4.6.
### Story 6: Prove behavior with real git integration tests

**Description:** Add `packages/execution/src/workspace-teardown.integration.spec.ts` using the existing temporary real-git style to prove terminal teardown behavior end to end.
**Acceptance criteria:**
- Tests create a bare upstream repository, a source clone, a host clone, worktrees, and scratch roots using the existing provisioning API style.
- Tests cover `done`, `canceled`, `failed`, `file_issue`, missing prune, and rejected out-of-root prune behavior.
- Real git assertions verify branch deletion, branch retention, checkpoint commits, and worktree removal.
- Tests clean up temporary directories after each run.
**Dependencies:** Stories 3, 4, and 5.
#### Task 6.1: Extract or reuse temporary git setup helpers

**Description:** Reuse the setup pattern from `workspace.integration.spec.ts` and avoid duplicating fragile git initialization logic more than necessary.
**Acceptance criteria:**
- Test setup may configure git identity for ordinary setup commits, but the canceled teardown assertion also proves the final-checkpoint commit succeeds in a host/worktree context without relying on ambient host global identity because teardown supplies the explicit Autocatalyst identity.
- The upstream default branch is deterministic.
- Temporary repos and workspace roots are isolated per test.
- Helper code stays local to tests unless a clear shared test helper already exists.
**Dependencies:** Story 2.
#### Task 6.2: Add real-git `done` teardown coverage

**Description:** Provision a two-root implementing workspace, call `teardownWorkspace` at `done`, and assert the worktree and branch are gone.
**Acceptance criteria:**
- Result outcome is `completed`.
- Worktree path no longer exists.
- Run branch no longer appears in the host repository.
- Branch deletion happens only after worktree removal succeeds.
**Dependencies:** Task 6.1 and Story 4.
#### Task 6.3: Add real-git `canceled` teardown coverage

**Description:** Provision a two-root implementing workspace, write an uncommitted change, call `teardownWorkspace` at `canceled`, and assert the final checkpoint exists on the retained branch.
**Acceptance criteria:**
- Result outcome is `completed`.
- Checkpoint action is `committed` and includes a commit SHA.
- The retained branch contains the committed file/change.
- Worktree path no longer exists.
- Branch still exists in the host repository.
**Dependencies:** Task 6.1 and Task 4.3.
#### Task 6.4: Add real-git retained and scratch cleanup coverage

**Description:** Prove `failed` implementing runs retain worktree and branch, and `file_issue` runs remove scratch-only run directories for every terminal step.
**Acceptance criteria:**
- Failed-run teardown returns `retained`.
- Failed-run worktree and branch remain present.
- File-issue teardown returns completed when scratch/run directory removal succeeds for `done`, `canceled`, and `failed`.
- File-issue run directory no longer exists after teardown for each terminal step.
**Dependencies:** Task 6.1 and Task 4.4.
#### Task 6.5: Add real filesystem missing and rejected prune coverage

**Description:** Exercise the public `pruneWorkspacePath` API for already-absent and out-of-root targets.
**Acceptance criteria:**
- Already-absent directory prune returns `missing`.
- Already-absent worktree prune reconciles admin state when applicable and returns `missing`.
- Out-of-root target returns `rejected`.
- In-root symlink targets, including symlinks pointing outside the root, return `rejected` with `target_not_directory`.
- The out-of-root test proves the target filesystem path remains unchanged.
**Dependencies:** Story 3.
### Story 7: Update agent documentation and run validation

**Description:** Update agent-maintained navigation docs and run targeted validation for the execution package.
**Acceptance criteria:**
- `context-agent/wiki/code-map.md` records the new pruner, teardown modules, public exports, and tests.
- Targeted execution tests pass.
- `pnpm nx build execution` and `pnpm nx lint execution` pass.
- Any skipped broader validation is documented with the reason.
**Dependencies:** Stories 1 through 6.
#### Task 7.1: Update the code map

**Description:** Record the new execution workspace lifecycle modules and test files in `context-agent/wiki/code-map.md`.
**Acceptance criteria:**
- The execution package section mentions `workspace-pruner.ts`, `workspace-teardown.ts`, `workspace-pruner.spec.ts`, `workspace-teardown.spec.ts`, and `workspace-teardown.integration.spec.ts`.
- The public entrypoint description includes prune and teardown exports.
- The command list includes the new targeted teardown integration test command.
**Dependencies:** Stories 1 through 6.
#### Task 7.2: Run targeted execution validation

**Description:** Run the fast tests most likely to catch workspace lifecycle regressions before broader validation.
**Acceptance criteria:**
Use Vitest's positional file filters through the Nx Vite test target. If file filtering is not
supported in the installed Nx/Vitest combination, run `pnpm nx test execution` and document that
fallback.
- Run `pnpm nx test execution -- workspace-paths.spec.ts`.
- Run `pnpm nx test execution -- workspace-provisioner.spec.ts`.
- Run `pnpm nx test execution -- workspace-pruner.spec.ts`.
- Run `pnpm nx test execution -- workspace-teardown.spec.ts`.
- Run `pnpm nx test execution -- workspace.integration.spec.ts`.
- Run `pnpm nx test execution -- workspace-teardown.integration.spec.ts`.
**Dependencies:** Stories 3, 4, and 6.
#### Task 7.3: Run package build and lint

**Description:** Verify the execution package compiles and passes lint after the lifecycle additions.
**Acceptance criteria:**
- Run `pnpm nx build execution`.
- Run `pnpm nx lint execution`.
- If these fail, record the failing command and fix or document the blocker before handoff.
**Dependencies:** Task 7.2.
#### Task 7.4: Run broader validation when practical

**Description:** Run the repository validation command after targeted checks when time and environment permit.
**Acceptance criteria:**
- Run `pnpm validate` when practical.
- If `pnpm validate` is skipped, document the exact reason.
- If `pnpm validate` fails outside the changed execution area, capture the failure and note whether it appears related.
**Dependencies:** Task 7.3.