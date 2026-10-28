---
created: 2026-10-28
last_updated: 2026-10-28
status: complete
issue: 120
specced_by: markdstafford
---
# Enhancement: Re-create run workspace

## Parent feature

`feature-isolated-per-run-workspace.md` — the per-run workspace feature that gives implementing runs an isolated git worktree on a run-owned branch plus a separate scratch root. This enhancement also extends the execution-runtime recovery behavior described in `workspace`, `execution-runtime`, `run`, ADR-004, and ADR-021.

## What

Autocatalyst can materialize a missing two-root run workspace from either the run's existing branch or from a freshly fetched default branch. The workspace provisioner keeps its existing default behavior for new runs, but gains an explicit base choice for recovery paths. On service startup, the control plane reconciles every non-terminal run that uses a workspace: present workspaces are left alone, missing workspaces are recreated from the run branch with a fresh scratch root, and runs whose branch is missing are failed safely through the orchestrator without dispatching or advancing any run.

## Why

A workspace is intentionally re-creatable: the durable truth is the run branch plus persisted checkpoints, not the on-disk workspace directory. Today, deleting a non-terminal run's workspace and restarting the service can strand the run because provisioning always tries to create a new branch from default and fails when the run branch already exists. This enhancement closes that gap, makes startup resilient to missing workspace directories, and provides the materialization primitives needed by a later recover action without adding automatic re-dispatch.

## User stories

- An operator can delete a non-terminal run's workspace directory and restart the service, and the run remains intact with its committed branch work back on disk.
- The control plane can recreate a missing workspace for a non-terminal implementing run from that run's own branch without advancing the run.
- The control plane can start a run over from a freshly fetched default branch, removing only the run's own derived branch and workspace root first so prior run commits are not carried forward.
- A recovery flow can request explicit materialization from either the run branch or the default branch while preserving the current provisioning behavior when no explicit base is requested.
- An operator can see a safe failure reason when a missing workspace cannot be recreated because the run branch is missing, without exposing filesystem paths, credentials, or raw git diagnostics.

## Design changes

*(Not applicable — this enhancement does not change any user interface. The observable operator-facing behavior is through run state, safe failure reasons, logs, and restored filesystem materialization.)*

## Technical changes

### Affected files

- `packages/execution/src/internal/workspace-driver.ts` — add a worktree-add operation that checks out an existing branch without `-b`; add safe branch existence and run-branch removal helpers if they do not already exist.
- `packages/execution/src/internal/workspace-provisioner.ts` — accept an optional explicit materialization base, preserve default behavior when absent, create fresh scratch roots on both explicit paths, update `provisionedBaseRef` for default-branch rebuilds, and rollback partial worktrees/directories on failures.
- `packages/execution/src/workspace.ts` and `packages/execution/src/index.ts` — expose the new provisioner option/result/error types needed by the control plane without leaking internal modules.
- `packages/execution/src/internal/workspace-pruner.ts` — reuse safe, containment-checked removal for run-root cleanup and git-aware worktree removal during default-branch rebuilds and rollback.
- `packages/execution/src/internal/execution-materializer.ts` — pass through the explicit base option when materializing recovery/startup workspaces, while keeping ordinary dispatch materialization unchanged.
- `packages/core/src/orchestrator.ts` and related lifecycle modules — add or reuse an orchestrator-owned failure path that can fail a run with safe reason `run_branch_missing` during startup reconciliation.
- `packages/core/src/control-plane-service.ts` or a new core startup reconciler module — implement the non-terminal workspace startup walk without dispatching, advancing, or recovering runs.
- `apps/control-plane/src/server.ts` and startup integration wiring — invoke the startup reconciliation after persistence/configuration is available and before the service begins normal dispatch behavior, without preventing startup when one run fails to reconcile.
- `apps/control-plane/src/*.spec.ts` — add a production startup-path integration test for deleting and recreating a committed run workspace.
- `packages/execution/src/workspace-provisioner.spec.ts` and `packages/execution/src/workspace.integration.spec.ts` — add real-git coverage for both materialization bases, missing branch, present workspace, and rollback.
- `context-agent/wiki/code-map.md` — document the new provisioner option, typed missing-branch error, and startup walk.

### Changes

#### Provisioning base contract

Add an optional explicit materialization base to the workspace provisioning API for two-root workspaces. The option should be a small discriminated value, for example:

```ts
type WorkspaceMaterializationBase =
  | { kind: 'current_default_branch' }
  | { kind: 'run_branch' };
```

Naming may follow existing package conventions, but the semantics are fixed:

- When the option is absent, provisioning keeps today's behavior: if the run root is missing, fetch the default branch and create the run branch/worktree from that base.
- `run_branch` means the host repository must already contain the run branch, and the worktree is added by checking out that branch without creating it.
- `current_default_branch` means start over from the freshly fetched default branch, after removing only this run's derived branch and run root if present.

The provisioner should report whether the workspace was already present versus newly materialized so startup can log accurately without treating an already-present workspace as recovery work.

#### Existing branch worktree materialization

The workspace driver gains a git operation equivalent to:

```bash
git worktree add <workspace-repo-root> <existing-run-branch>
```

It must not pass `-b`, because the branch already exists. Before calling it, the provisioner verifies the run branch exists in the host repository. If the branch is missing, provisioning fails with a typed error code such as `run_branch_missing`, creates nothing, and leaves no partial worktree or scratch directory. If any later step fails, rollback removes the run root and any registered worktree administrative state through the existing safe pruner path.

After materializing from the run branch, the provisioner creates a fresh empty scratch root and runs the branch guard. It does not restore old scratch contents and does not attempt to reconstruct an uncommitted tail.

#### Default-branch start-over materialization

When explicitly materializing from the current default branch, the provisioner first fetches the default branch. It then removes only the run's own derived branch and run root before creating a new branch/worktree from the fetched default branch. Removal must be constrained to the run's derived branch name and canonical run root; no shared default branch, unrelated branch, parent workspace directory, or other run directory may be removed.

This path updates stored workspace metadata so `provisionedBaseRef` reflects the newly fetched default base. This intentionally changes the current behavior where an existing `provisionedBaseRef` may be preserved.

The resulting workspace has no prior run commits, a fresh empty scratch root, and passes the branch guard before success is returned.

#### Already-present workspace behavior

For all provisioning bases, if the expected workspace is already present on the expected branch, the provisioner leaves it in place and reports it as present. It still runs the branch guard. It must not wipe scratch merely because explicit base was provided; fresh scratch creation applies to newly materialized workspaces.

If the run root exists but is not on the expected branch, existing branch-guard failure behavior remains the safety boundary rather than silently deleting or repairing the directory, except for the explicit `current_default_branch` path where the run's own root is intentionally removed before rebuilding.

#### Startup reconciliation walk

At control-plane startup, walk every non-terminal run whose workflow uses a two-root workspace. For each run:

1. Resolve the same workspace metadata/settings used by normal execution materialization.
2. If the workspace is present and passes the branch guard, leave it alone.
3. If the workspace is missing, call the provisioner with `run_branch`.
4. If provisioning reports `run_branch_missing`, fail the run through the orchestrator with safe reason `run_branch_missing`.
5. For any other failure, log a safe diagnostic and continue the walk; do not stop service startup.

The walk never dispatches a run, never calls the recovery policy table, never changes the run step except for the explicit orchestrator failure on missing branch, and never advances a run. This preserves the separation between startup materialization and the separate recover action.

Safe startup logs may include stable ids and typed error codes, but must not include filesystem paths, credentials, raw git stderr/stdout, provider diagnostics, or secret handles. A failure on one run must not prevent later runs from being reconciled or the service from starting.

#### Errors, failure reasons, and observability

Add `run_branch_missing` as a typed workspace provisioning error and a safe run failure reason. Preserve existing sanitized error wrapping so raw subprocess output cannot enter persisted run failure reasons or API/SSE responses. Where detailed operational diagnostics are useful, emit structured logs through the existing workspace logger with redacted fields.

#### Testing plan

- Unit tests for the driver command construction prove existing-branch worktree add omits `-b`, while new-branch creation keeps the existing behavior.
- Real-git integration tests in a temporary repository cover:
  - materializing from an existing run branch restores a committed file;
  - missing run branch fails with `run_branch_missing` and leaves no worktree or scratch root;
  - explicit default-branch materialization fetches default, removes only the derived run branch/root, creates a branch with no prior commits, and updates `provisionedBaseRef`;
  - an already-present workspace is reported as present and left in place;
  - failure after partial worktree creation rolls back registered worktree state and filesystem directories.
- Core/control-plane tests cover the startup walk over multiple non-terminal runs, including continue-on-error behavior and orchestrator failure for missing branches.
- A real end-to-end startup test drives production server wiring: start service, create a run with a committed file in its workspace branch, stop service, delete the workspace directory, restart service, and assert the workspace is restored on the run branch with the file present, scratch is empty, and the run remains non-terminal at the same step.

### Non-goals

- Implementing the operator recover action or the recovery policy table.
- Restoring uncommitted work or old scratch contents.
- Scheduled workspace garbage collection.
- Pushing run branches to the upstream remote or clone-based remote worker materialization.
- Resuming an interrupted provider/agent SDK session in place.

### Risks

- Git worktree administrative state can become stale after manual deletion. Mitigation: use git-aware worktree removal/prune paths during rollback and rebuild, and cover stale/partial state with real-git tests.
- Startup reconciliation could accidentally become dispatch or recovery. Mitigation: keep it in a narrow reconciler with tests asserting no advancement and no dispatch calls.
- Safe logging can regress by including raw git errors or paths. Mitigation: route errors through typed codes and existing redaction helpers, and add no-leak assertions for persisted failure reasons/log payloads where feasible.
- Default-branch rebuild removes a branch by design. Mitigation: derive the branch name from run metadata, guard it against the run's expected derived branch, and only perform this removal for explicit `current_default_branch` materialization.

## Task list

- [ ] **Story: Workspace driver supports both worktree bases**
  - [ ] **Task: Add existing-branch worktree checkout driver operation**
    - **Description**: Extend `packages/execution/src/internal/workspace-driver.ts` with a worktree-add operation that checks out an existing run branch without `-b`, plus any branch-existence helper needed by the provisioner. Keep subprocess execution argument-array based and preserve redaction behavior for git failures.
    - **Acceptance criteria**:
      - [ ] Existing-branch worktree add invokes git without `-b`
      - [ ] New-branch worktree creation keeps the existing `-b` behavior
      - [ ] Branch existence can be checked without creating or modifying worktrees
      - [ ] Driver errors expose typed/sanitized information only
    - **Dependencies**: None
  - [ ] **Task: Add safe derived branch removal for start-over materialization**
    - **Description**: Add or expose a driver/pruner path that removes only the run's own derived branch and canonical run root before explicit default-branch rebuilds. Use existing containment and branch-name derivation guards.
    - **Acceptance criteria**:
      - [ ] Only the expected run branch name can be removed
      - [ ] Only the canonical run root can be removed
      - [ ] Attempts to remove default, unrelated, or path-escaping targets are rejected
      - [ ] Removal uses git-aware worktree cleanup where applicable
    - **Dependencies**: Task: Add existing-branch worktree checkout driver operation

- [ ] **Story: Provisioner materializes missing workspaces explicitly and safely**
  - [ ] **Task: Add explicit materialization base option to the provisioner API**
    - **Description**: Extend the public workspace provisioning input/types with an optional base choice for `run_branch` or `current_default_branch`. Preserve current behavior when the option is omitted, and return an outcome that distinguishes already-present from newly materialized workspaces.
    - **Acceptance criteria**:
      - [ ] Public execution workspace exports include the new option and outcome types
      - [ ] No-option provisioning behavior remains backward-compatible
      - [ ] `run_branch` and `current_default_branch` are represented as explicit typed choices
      - [ ] Callers can tell whether the workspace was already present
    - **Dependencies**: Story: Workspace driver supports both worktree bases
  - [ ] **Task: Implement run-branch materialization path**
    - **Description**: In `workspace-provisioner.ts`, implement missing-workspace creation from an existing run branch. Verify the branch exists first, create the worktree without `-b`, create a fresh empty scratch root, run the branch guard, and rollback all partial state on failure.
    - **Acceptance criteria**:
      - [ ] Committed files on the run branch appear in the recreated repo root
      - [ ] Missing branch fails with typed `run_branch_missing`
      - [ ] Missing branch creates no repo root or scratch root
      - [ ] Scratch root is fresh and empty on successful materialization
      - [ ] Branch guard runs before success
      - [ ] Partial failures leave no registered worktree or run root behind
    - **Dependencies**: Task: Add explicit materialization base option to the provisioner API
  - [ ] **Task: Implement default-branch start-over materialization path**
    - **Description**: In `workspace-provisioner.ts`, implement explicit default-branch materialization. Fetch default first, remove only the run's derived branch and root, create a new worktree/branch from the fetched default, create a fresh empty scratch root, run the branch guard, and update `provisionedBaseRef` to the new base.
    - **Acceptance criteria**:
      - [ ] Default branch is fetched before branch creation
      - [ ] Existing run worktree/root and derived branch are removed before rebuilding
      - [ ] No prior run commits are present in the rebuilt branch
      - [ ] `provisionedBaseRef` is updated to the new fetched base
      - [ ] Scratch root is fresh and empty
      - [ ] Branch guard runs before success
    - **Dependencies**: Task: Add explicit materialization base option to the provisioner API, Task: Add safe derived branch removal for start-over materialization
  - [ ] **Task: Preserve already-present workspace behavior across base choices**
    - **Description**: Ensure the provisioner leaves an existing workspace in place when it is already present on the expected branch, reports it as present, and does not wipe scratch except when rebuilding through the explicit default-branch path.
    - **Acceptance criteria**:
      - [ ] Present workspace on expected branch is not recreated
      - [ ] Present workspace still runs branch guard
      - [ ] Present workspace result is reported distinctly from new materialization
      - [ ] Scratch contents are not deleted for already-present workspaces
    - **Dependencies**: Task: Implement run-branch materialization path, Task: Implement default-branch start-over materialization path

- [ ] **Story: Startup reconciles non-terminal run workspaces without dispatch**
  - [ ] **Task: Add startup workspace reconciliation service**
    - **Description**: Add a core/control-plane startup reconciler that queries every non-terminal run requiring a two-root workspace, resolves workspace settings, checks whether the workspace is present, and recreates missing workspaces from the run branch. Keep this separate from recovery/dispatch logic.
    - **Acceptance criteria**:
      - [ ] Only non-terminal runs that use workspaces are considered
      - [ ] Present workspaces are left alone
      - [ ] Missing workspaces are provisioned with the `run_branch` base
      - [ ] The walk never dispatches a run
      - [ ] The walk never advances a run step
    - **Dependencies**: Story: Provisioner materializes missing workspaces explicitly and safely
  - [ ] **Task: Fail missing-branch runs through the orchestrator with a safe reason**
    - **Description**: When startup reconciliation receives `run_branch_missing`, call the orchestrator-owned failure path to transition the run to failed with reason `run_branch_missing`. Ensure API/SSE serialization uses the safe reason only.
    - **Acceptance criteria**:
      - [ ] `run_branch_missing` is an accepted safe failure reason
      - [ ] Missing branch transitions the run through orchestrator authority
      - [ ] Persisted/API/SSE failure reason is exactly safe and contains no paths or git output
      - [ ] Other reconciliation failures do not incorrectly mark runs as missing-branch failures
    - **Dependencies**: Task: Add startup workspace reconciliation service
  - [ ] **Task: Wire reconciliation into production service startup**
    - **Description**: Invoke the reconciler from the control-plane server startup path after repositories/configuration are ready. A failure for one run must be logged safely and must not prevent later runs from being processed or the service from accepting traffic.
    - **Acceptance criteria**:
      - [ ] Production startup invokes the reconciliation walk
      - [ ] One run failure does not stop the walk
      - [ ] One run failure does not stop service startup
      - [ ] Logs include typed code and stable ids but no paths, credentials, or raw subprocess diagnostics
    - **Dependencies**: Task: Fail missing-branch runs through the orchestrator with a safe reason

- [ ] **Story: Verification covers git behavior, startup behavior, and rollback**
  - [ ] **Task: Add real-git workspace provisioning tests**
    - **Description**: Add temporary-repository tests that exercise both explicit bases, missing branch handling, already-present workspaces, and rollback after partial provisioning failure using real git rather than command mocks alone.
    - **Acceptance criteria**:
      - [ ] Run-branch materialization restores a committed file
      - [ ] Default-branch materialization carries no prior run commits
      - [ ] Missing branch returns `run_branch_missing` and leaves no partial workspace
      - [ ] Already-present workspace is reported as present and left untouched
      - [ ] Simulated partway failure rolls back worktree metadata and directories
    - **Dependencies**: Story: Provisioner materializes missing workspaces explicitly and safely
  - [ ] **Task: Add startup reconciliation unit/integration tests**
    - **Description**: Cover the startup walk with multiple runs: present workspace, missing workspace recreated from branch, missing branch failed through orchestrator, and unrelated failure logged/continued. Assert no dispatch or advancement occurs.
    - **Acceptance criteria**:
      - [ ] Present run remains unchanged
      - [ ] Missing workspace is recreated from run branch
      - [ ] Missing branch run is failed with safe reason
      - [ ] A reconciliation failure for one run does not stop subsequent runs
      - [ ] Dispatch seam is not called
      - [ ] Non-failed runs keep their current step
    - **Dependencies**: Story: Startup reconciles non-terminal run workspaces without dispatch
  - [ ] **Task: Add production startup end-to-end test**
    - **Description**: Add a real control-plane startup test that starts the service, creates a run whose workspace branch contains a committed file, stops the service, deletes the workspace directory, restarts the service, and observes the restored workspace and unchanged run state.
    - **Acceptance criteria**:
      - [ ] Restart recreates the workspace on the run branch
      - [ ] The committed file is present after restart
      - [ ] Scratch root exists and is empty after restart
      - [ ] Run remains non-terminal
      - [ ] Run step is not advanced by startup
    - **Dependencies**: Task: Add startup reconciliation unit/integration tests

- [ ] **Story: Agent navigation docs reflect the new workspace recovery paths**
  - [ ] **Task: Update `context-agent/wiki/code-map.md`**
    - **Description**: Document the new provisioner base option, the `run_branch_missing` typed error/failure reason, the startup reconciliation walk, and the key tests/commands future agents should use.
    - **Acceptance criteria**:
      - [ ] Code map names the changed workspace provisioner/driver modules
      - [ ] Code map records the startup walk entry point
      - [ ] Code map records the safe missing-branch error/failure reason
      - [ ] Code map lists the targeted tests added for this enhancement
    - **Dependencies**: Story: Startup reconciles non-terminal run workspaces without dispatch, Story: Verification covers git behavior, startup behavior, and rollback
