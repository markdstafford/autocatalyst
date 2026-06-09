---
created: 2026-06-09
last_updated: 2026-06-09
status: complete
issue: 17
specced_by: markdstafford
---
# Feature: Isolated per-run workspace

## Product requirements

### What

Create the first workspace provisioning capability for Autocatalyst execution runs. A run that produces code gets an isolated filesystem workspace made of two roots: a git worktree at `repo` and a sibling scratch directory at `scratch`. For those two-root implementing runs, provisioning resolves the canonical path from caller-supplied roots and project repository identity, ensures a shared host clone exists, fetches the upstream default branch, cuts a run-owned branch, creates the worktree, creates scratch, and rolls the whole run directory back if any step fails. Non-implementing runs use the lighter shapes described below and do not touch git.
The canonical layout is:
```plain text
//
////repo
////scratch
```
Here `` means the effective workspace root supplied by the caller after applying any `Project.workspaceRootOverride`.
The feature also implements the first safety guards around that layout. A traversal-bearing run id is rejected, paths are checked against the resolved workspace root, and the worktree branch is verified before a run uses it.
### Why

Autocatalyst cannot safely run implementation agents until each run has a predictable, isolated filesystem. The workspace concept and ADRs already decide the model: the host keeps a shared full clone, each implementing run acts in its own git worktree on a run-owned branch, and scratch is a disposable sibling that never becomes part of the diff.
This feature turns those decisions into executable infrastructure inside `packages/execution`. It gives later execution-context and runner work a concrete environment to target, without also taking on teardown, retention, garbage collection, re-materialization, or orchestrator dispatch wiring.
### Goals

- Resolve repository and workspace paths from caller-supplied root inputs and the `Project` host repository identity.
- For two-root implementing runs, ensure one shared full host clone exists per project at `//`.
- For two-root implementing runs, fetch the host clone from its upstream remote before cutting a run branch.
- Create a run worktree at `////repo`.
- Create a scratch root at `////scratch`.
- Name run branches as `/-`, where `` is `feature`, `bug`, `chore`, or `enhancement`.
- Select the provisioning shape from the run kind: no workspace for `question`, scratch only for `file_issue`, and both roots for implementing runs.
- Treat worktree and scratch creation as one unit, with rollback of the whole run directory on provisioning failure.
- Reject path traversal in run identifiers, reject per-run workspace writes or deletes that resolve outside the resolved workspace root, and keep host-clone writes contained to the resolved repos root.
- Verify that a worktree is on its expected run branch before returning it as usable.
- Prove the behavior with an integration test that uses a real temporary git repository.
- Keep the public execution package boundary stable: control-plane code may import `@autocatalyst/execution`, but not execution internals.
- Update `context-agent/wiki/code-map.md` during implementation with the new workspace provisioning modules.
### Non-goals

- Teardown, pruning, terminal-state retention, scheduled workspace garbage collection, and branch reclamation.
- Re-materializing a missing non-terminal workspace.
- Wiring provisioning into orchestrator dispatch, `ExecutionContext` resolution, or the `Runner` boundary.
- Opening, pushing, updating, or merging pull requests.
- Pushing run branches to the upstream remote at checkpoints.
- Container isolation, network egress controls, tenant path segments, or non-co-located execution workers.
- Clone-from-`repo_url` for remote workers.
- Resolving `` or `` from service-owned database configuration inside `packages/execution`; later execution-context or runner work should read service configuration in the caller and pass roots into this API.
- Partial clone, non-default base branches, per-run dependency caches, language-server setup, or agent process execution.
- A user interface for workspace status or workspace cleanup.
### Personas

- **Enzo (Engineer)** needs a small execution-plane API that reliably provisions a run workspace without importing git or filesystem internals into control-plane code.
- **Opal (Operator)** needs workspace paths to stay inside the configured root and cleanup-on-failure to avoid orphaned partial directories.
- **Phoebe (PM)** needs confidence that implementation runs now have the isolation primitive required for later automated coding work.
- **Dani (Designer)** is not a direct user of this backend feature, but later progress and review surfaces depend on runs producing changes from a predictable branch and workspace.
### User stories

- As Enzo, I can request a workspace for a feature run and receive the resolved repo and scratch paths plus expected branch name.
- As Enzo, I can run provisioning against a real git repository and see the worktree branch cut from the freshly fetched default branch.
- As Enzo, I can request a scratch-only workspace for an issue-filing run without creating a worktree or branch.
- As Enzo, I can request a question run and see that no filesystem workspace is materialized.
- As Opal, I can configure roots per service and per project and know that all per-run paths are resolved beneath the correct root.
- As Opal, I can trust provisioning failure to remove the whole run directory instead of leaving half-created workspaces behind.
- As Opal, I can rely on containment guards to reject traversal-bearing run ids and out-of-root resolved paths.
- As a future runner author, I can consume the returned repo and scratch roots without rediscovering path conventions.
### Acceptance criteria

#### Path resolution and configuration

- `` and the service default `` arrive as caller-supplied request inputs, not hard-coded constants inside `packages/execution`.
- `Project.workspaceRootOverride` overrides only the workspace root for that project.
- `Project.hostRepository.owner` and `Project.hostRepository.name` resolve the `/` path segment.
- The host repository path resolves to `//`.
- The per-run repo path resolves to `////repo`.
- The per-run scratch path resolves to `////scratch`.
- The effective workspace root, after applying `Project.workspaceRootOverride ?? roots.workspacesRoot`, flows into every containment check instead of relying on a single global root.
- Path resolution is deterministic and testable without running git commands.
#### Host clone management for two-root runs

- Two-root implementing provisioning ensures the shared host clone exists at `//`.
- Host clone creation and mutation use a separate repos-root containment policy: the host clone path and any parent directories created for it must resolve inside ``.
- The only dynamic path segments under `` are the validated `Project.hostRepository.owner` and `Project.hostRepository.name` segments; invalid or traversal-bearing owner/name values fail before any host clone filesystem write.
- If the host clone is absent for a two-root run, provisioning creates a full clone from the configured upstream repository URL.
- If the host clone already exists for a two-root run, provisioning reuses it rather than cloning a second copy.
- Before cutting a run worktree, two-root provisioning fetches the host clone from its upstream remote.
- The branch base for two-root worktrees is the freshly fetched default branch.
- The implementation does not use a per-run clone for the co-located default path.
- `question` and `file_issue` provisioning do not ensure, fetch, inspect, or mutate the host git clone.
#### Provisioning shape by run kind

- A `question` run materializes no repo root and no scratch root.
- A `file_issue` run materializes a scratch root and no worktree.
- A `feature`, `enhancement`, `bug`, or `chore` run materializes both roots.
- Unsupported run kinds fail with a typed error instead of falling back to an unsafe default.
- The returned provisioning result distinguishes the three shapes so callers can avoid guessing which roots exist.
#### Worktree and branch behavior

- Implementing runs create a git worktree at the resolved `repo` path.
- The worktree is created on a run-owned branch named `/-`.
- `` is one of `feature`, `bug`, `chore`, or `enhancement`.
- The topic slug is sanitized for a git branch path segment.
- The short run id makes branch names unique for repeated runs on the same topic slug.
- The branch is cut from the freshly fetched default branch.
- A branch guard confirms the worktree is on the expected branch before provisioning returns success.
#### Scratch root behavior

- Scratch is created as a sibling of the worktree under the run directory.
- Scratch is created for both scratch-only and two-root shapes.
- Scratch is not nested inside the repo worktree.
- The implementation does not impose a durable subdirectory structure under scratch.
- The implementation never treats scratch as a source of durable data.
#### Atomicity and rollback

- Worktree and scratch creation are treated as one provisioning unit keyed to the run id.
- Any failure after the run directory is created rolls back the whole `` directory.
- A failure during worktree creation leaves no residual run directory under `//`.
- A failure after worktree creation but before final success removes the worktree through git-aware cleanup when possible and removes the run directory.
- Rollback errors are surfaced or logged without hiding the original provisioning failure.
- Provisioning is safe to retry after a failed attempt because no partial run directory remains.
#### Containment and guard behavior

- A run id containing `..`, path separators, or other traversal-bearing segments is rejected before any filesystem write.
- Per-run workspace writes and deletes for `runRoot`, `repo`, and `scratch` are rejected when they resolve outside the effective workspace root after realpath or equivalent canonical resolution supplied by the guarded filesystem layer.
- Host clone creation, verification, and fetch paths are rejected when they resolve outside the supplied `` after the same canonical containment policy.
- Guards take the relevant resolved root as an explicit parameter: effective workspace root for run workspace operations and repos root for host clone operations.
- Guards do not assume one process-wide global workspace root or repos root.
- The branch guard fails if the worktree is absent, not a worktree, or on a different branch from the expected branch.
- Guard failures return typed errors suitable for callers and tests.
#### Package boundary and tests

- The public API needed by control-plane callers is exported from `packages/execution/src/index.ts`.
- Internal git and filesystem helpers live under execution internals and are not imported directly by control-plane packages.
- Existing boundary tests continue to reject imports from `@autocatalyst/execution/src/*`.
- Unit tests cover path resolution, branch-name derivation, provisioning-shape selection, and guard failures.
- An integration test creates a real temporary upstream git repository and asserts the host clone, worktree, expected branch, scratch root, traversal rejection, out-of-root path rejection, and rollback on induced failure.
- `context-agent/wiki/code-map.md` is updated during implementation to record the workspace provisioning modules.
## Design spec

### Design scope

This is a backend execution-plane feature. There is no human-facing screen, layout, visual component, or product copy in this pass.
The design work is the developer and operator experience: the inputs needed to provision a workspace, the shape of the result a caller receives, the errors a caller can handle, and the safety checks that keep filesystem operations inside the configured root.
### Developer experience

Provisioning should feel like one small execution-plane operation, not a set of git and filesystem chores spread across the control plane.
A future control-plane caller should be able to:
1. Build a provisioning request from a `Project`, a run id, a run kind, a topic title or slug, and service workspace settings.
2. Call a public function or service exported by `@autocatalyst/execution`.
3. Receive a typed result that names the provisioning shape and includes only the roots that exist for that shape.
4. Pass those paths into the future execution context and runner without recomputing branch or layout rules.
The public result should make invalid use hard. For example, a `question` result should not expose undefined repo and scratch paths as if they were optional conveniences; it should explicitly say no workspace was materialized. A scratch-only result should expose `scratchRoot` and omit or null out `repoRoot` in a way TypeScript callers must handle.
### Operator experience

Operators configure high-level roots and projects; they should not need to inspect git command details for normal runs.
The important operator-facing behaviors are:
- Paths are self-describing because they include `org/repo/run-id`.
- A project-level workspace-root override can place one repository's workspaces on a different disk.
- A failed provisioning attempt does not leak a partial `` directory.
- A rejected traversal or out-of-root path produces a clear error and does not write to disk.
- The branch name is readable enough to connect a filesystem workspace back to its run and topic.
This feature does not need a UI or API endpoint for operators. Logs and typed errors are enough for this slice.
### Provisioning flow

For an implementing run, the flow is:
1. Validate the run id and derive the branch name.
2. Resolve ``, effective ``, host repo path, run directory, repo root, and scratch root.
3. Ensure the host clone exists at `//`.
4. Fetch the host clone from its upstream remote.
5. Resolve the default branch reference after fetch.
6. Create the run directory.
7. Create the worktree at the repo root on the run-owned branch cut from the fetched default branch.
8. Create the scratch root beside the repo root.
9. Confirm the worktree is on the expected branch.
10. Return the two-root result.
For a `file_issue` run, the flow stops after creating the run directory and scratch root. For a `question` run, the flow returns a no-workspace result after validation and shape selection, without creating directories.
### Result shape

The result should be a discriminated union or equivalent typed shape. A representative shape is:
```typescript
type ProvisionWorkspaceResult =
  | {
      shape: 'none';
      runId: string;
    }
  | {
      shape: 'scratch_only';
      runId: string;
      workspaceRoot: string;
      runRoot: string;
      scratchRoot: string;
    }
  | {
      shape: 'two_roots';
      runId: string;
      workspaceRoot: string;
      runRoot: string;
      repoRoot: string;
      scratchRoot: string;
      hostRepositoryPath: string;
      branchName: string;
    };
```
The exact field names may follow implementation conventions, but the result must distinguish absent roots from present roots without making callers infer behavior from a run kind string.
### Error design

Provisioning should raise typed errors for expected failure classes:
- Invalid run id or traversal-bearing path segment.
- Unsupported run kind.
- Invalid or missing project repository identity.
- Host clone creation failure.
- Fetch failure.
- Worktree creation failure.
- Scratch creation failure.
- Rollback failure or rollback partial failure.
- Out-of-root resolved path.
- Branch guard mismatch.
Errors should include enough context for tests and logs, such as run id, shape, target path, expected branch, and actual branch when available. They must not include credentials, full remote URLs with embedded credentials, or secret values. Wrapped process or rollback failures must be converted to sanitized structured summaries before they are placed in messages, context, or logs; raw `Error`, stderr, stdout, command, environment, or unknown objects are not exposed through the public error context.
### Git command design

Git operations should be isolated behind a small internal driver. The provisioning service should not scatter `child_process` calls across path resolution and shape-selection code.
The driver should expose operations such as:
- Ensure or clone the host repository.
- Fetch the host repository.
- Resolve the fetched default branch.
- Add a worktree on a new branch from a base ref.
- Read the current branch of a worktree.
- Remove a just-created worktree during rollback when needed.
The integration test should use real git commands through this driver because the acceptance criteria depend on true worktree behavior. Unit tests can use a fake driver to induce failure points and assert rollback without depending on git.
### Empty and conflict states

For two-root implementing runs, a missing host clone is not an error if the project has enough information to clone it. Two-root provisioning should create it and continue.
For two-root implementing runs, an existing host clone is the normal repeated-run case. Provisioning should reuse it and fetch.
An existing run directory for the same run id should fail before creating or overwriting anything. This feature should not try to recover or reuse a partially present run directory; recovery and re-materialization are separate follow-up work.
An existing branch with the computed run branch name should fail as a collision unless implementation can prove it belongs to the same run and that reuse is safe. The short run id is expected to make this rare.
## Tech spec

### Current state

The repository already has the architectural contracts this feature must follow:
- `context-human/concepts/workspace.md` defines the two-root workspace layout, provisioning shapes, branch naming, containment rules, and creation-as-a-unit behavior.
- ADR-020 chooses git worktrees of a shared host clone for co-located execution.
- ADR-021 requires workspace creation and teardown as a unit and rollback on creation failure.
- `context-agent/standards/workspace-conventions.md` records the implementation rules for layout, git discipline, safety, retention, and recovery.
- `packages/api-contract/src/project.ts` already defines `Project`, including `hostRepository.owner`, `hostRepository.name`, and `workspaceRootOverride`.
- `packages/execution` is currently a scaffold. Its public entry point is `packages/execution/src/index.ts`, and `packages/execution/src/internal/workspace-driver.ts` is an internal stub.
- Boundary tooling already prevents control-plane packages from importing execution internals.
This feature should fill `packages/execution` with workspace provisioning while preserving the existing package boundary.
### Proposed package shape

Keep the implementation inside `packages/execution`.
Recommended files:
- `packages/execution/src/workspace.ts` — public workspace provisioning types, request/result shapes, error types, and the public provisioning function or service class.
- `packages/execution/src/internal/workspace-paths.ts` — path resolution, run-id validation, branch-name derivation, and containment helpers.
- `packages/execution/src/internal/workspace-driver.ts` — git and filesystem driver implementation. This can replace the current stub.
- `packages/execution/src/internal/workspace-provisioner.ts` — orchestration of shape selection, two-root-only host clone ensure/fetch, worktree creation, scratch creation, guard checks, and rollback.
- `packages/execution/src/workspace.spec.ts` or focused internal specs — unit coverage for pure behavior and typed errors.
- `packages/execution/src/workspace.integration.spec.ts` — real temporary git repository coverage.
Export only the public types and provisioning API from `packages/execution/src/index.ts`. Do not export internal driver or path modules.
### Public API

The public API should accept a request shaped around already-known domain and configuration values. A representative request is:
```typescript
interface ProvisionWorkspaceRequest {
  readonly runId: string;
  readonly runKind: 'feature' | 'enhancement' | 'bug' | 'chore' | 'file_issue' | 'question';
  readonly topicSlug: string;
  readonly shortRunId: string;
  readonly defaultBranch?: string;
  readonly project: {
    readonly hostRepository: {
      readonly owner: string;
      readonly name: string;
      readonly url: string;
    };
    readonly workspaceRootOverride?: string | null;
  };
  readonly roots: {
    readonly reposRoot: string;
    readonly workspacesRoot: string;
  };
}
```
The exact `Project` fields should match `@autocatalyst/api-contract` rather than duplicating a parallel project model. If `Project.hostRepository` does not currently expose a clone URL, or if a caller needs to provide an explicit default branch fallback, implementation should introduce the smallest typed input needed at the execution boundary instead of inventing database configuration in this feature.
The API should return the discriminated provisioning result described in the design spec and throw or return typed `WorkspaceProvisioningError` values for expected failures. Follow existing project conventions for errors if the execution package has them by implementation time.
### Path resolution and validation

Path logic should be pure and heavily unit-tested.
Implementation requirements:
- Normalize and validate `Project.hostRepository.owner` and `Project.hostRepository.name` as path segments.
- Reject run ids with path separators, `..`, empty segments, or other traversal-bearing content.
- Build paths with Node's `path` module rather than string concatenation.
- Resolve the effective workspace root as `Project.workspaceRootOverride ?? roots.workspacesRoot`.
- Pass the effective workspace root explicitly into every containment check.
- Use `fs.realpath` or equivalent canonical resolution for paths that already exist.
- For paths not yet created, validate the canonical existing parent and the final resolved path relationship to the effective root. The containment helper is internal but asynchronous because canonicalization is filesystem-backed.
- Keep branch-name derivation separate from filesystem path derivation.
Branch-name derivation should sanitize the topic slug for git branch use and reject or replace unsafe characters. It should preserve the required `/-` shape for implementing run kinds. The complete branch name must be at most 240 characters. `shortRunId` is accepted only when it matches `^[A-Za-z0-9][A-Za-z0-9_-]{5,31}$`.
The topic slug sanitizer is deterministic and must use this algorithm:
1. Trim leading and trailing Unicode whitespace.
2. Convert to lowercase.
3. Normalize with Unicode NFKD and remove combining marks in `\p{Mark}`.
4. Replace every character other than ASCII `a` through `z`, `0` through `9`, `.`, `_`, or `-` with `-`. This includes spaces, path separators, backslashes, ref metacharacters, control characters, and remaining non-ASCII characters.
5. Replace every run of two or more dots with `-` so the topic segment can never contain `..`.
6. Replace every run of one or more hyphens with a single `-`.
7. Remove leading and trailing `.`, `_`, and `-` characters.
8. While the topic segment ends with `.lock`, remove that suffix and repeat step 7.
9. If the topic segment is empty, use `run`.
10. Build the branch as `/-`.
11. If the complete branch would exceed 240 characters, truncate only the topic segment to fit `240 - "/".length - "-".length - shortRunId.length`, then repeat steps 7 through 9 on the truncated topic segment before building the final branch.
Examples with `kind = feature` and `shortRunId = Abc123`:

Input topic slug
Sanitized topic segment
Branch

`Hello World`
`hello-world`
`feature/hello-world-Abc123`

`feat/foo bar`
`feat-foo-bar`
`feature/feat-foo-bar-Abc123`

`Über Café`
`uber-cafe`
`feature/uber-cafe-Abc123`

`release..candidate`
`release-candidate`
`feature/release-candidate-Abc123`

`topic.lock`
`topic`
`feature/topic-Abc123`

`ends.`
`ends`
`feature/ends-Abc123`

`@{bad}`
`bad`
`feature/bad-Abc123`

`🚀`
`run`
`feature/run-Abc123`

300 `a` characters
enough `a` characters for a 240-character branch
`feature/-Abc123`

### Git and filesystem driver

The internal driver can use Node's `child_process` APIs to run `git`, but command construction must avoid shell interpolation. Prefer `spawnFile` or `execFile` with argument arrays over shell commands.
Driver operations should include:
- `ensureHostRepository(...)`: if the host path is absent, create parent directories and run a full `git clone`; otherwise verify the path is a git repository.
- `fetchHostRepository(...)`: run `git fetch` against the host clone's upstream remote.
- `resolveDefaultBranch(...)`: determine the fetched default branch or use the project-provided default branch when present.
- `addWorktree(...)`: run `git worktree add` to create the repo root on the run branch from the base ref.
- `currentBranch(...)`: read the current branch for branch-guard verification.
- `removeWorktree(...)`: remove a worktree during rollback when a worktree was successfully created.
- `mkdirp(...)` and guarded directory removal for non-worktree paths.
The driver should capture stderr for diagnostics but redact remote credentials before attaching messages to errors or logs. Driver and provisioner code should convert caught failures to `WorkspaceProvisioningErrorCauseSummary` values before adding them to `WorkspaceProvisioningErrorContext`.
### Provisioning algorithm

The provisioner should coordinate pure path logic and driver operations.
For two-root runs:
1. Validate input and select the `two_roots` shape.
2. Resolve all paths.
3. Ensure the run root does not already exist.
4. Ensure and fetch the host repository.
5. Resolve the base ref from the fetched default branch.
6. Create the run root.
7. Add the worktree on the run branch.
8. Create the scratch root.
9. Run the branch guard.
10. Return the result.
For scratch-only runs:
1. Validate input and select `scratch_only`.
2. Resolve paths.
3. Ensure the run root does not already exist.
4. Create the run root.
5. Create the scratch root.
6. Return the result.
For no-workspace runs:
1. Validate input and select `none`.
2. Return without creating directories or touching git.
Wrap the filesystem-mutating parts in failure handling. Once run-root creation begins, a later failure should call rollback. Rollback should use `git worktree remove` if a worktree was added, then remove the run root through a containment-checked delete. The containment-checked `removeDirectory` helper is the seam the future prune primitive will route through, so this implementation keeps rollback deletions in that one helper rather than scattering ad-hoc removals. If rollback itself fails, preserve sanitized summaries for the original failure and rollback failure and attach those rollback details.
### Integration test design

The integration test should create real repositories under a temporary directory:
1. Create an upstream bare repository.
2. Create a source checkout on an explicit default branch, configure local test `user.name` and `user.email`, commit an initial file on that branch, and push it to upstream.
3. Configure temporary `` and `` directories.
4. Provision a `feature` run.
5. Assert that the host clone exists at `//`.
6. Assert that the worktree exists at `////repo`.
7. Assert that `git -C  branch --show-current` returns the expected branch.
8. Assert that the scratch root exists beside the worktree.
9. Assert that the worktree branch starts from the fetched default branch by checking the initial commit or file.
10. Assert that traversal-bearing run ids are rejected before directories are created.
11. Assert that an out-of-root write or delete path is rejected by the containment helper.
12. Induce a mid-provisioning failure with a fake or configurable driver and assert no residual `` directory remains.
Use real git for the success path because worktree behavior is the product behavior. Use a fake driver for failure injection if inducing a precise real git failure would make the test brittle.
### Boundary and documentation updates

Implementation must keep the execution package boundary intact:
- `packages/core` and `apps/control-plane` may import `@autocatalyst/execution`.
- They must not import `@autocatalyst/execution/src/internal/*` or any relative execution internals.
- `pnpm test:boundaries` should continue to pass.
Update `context-agent/wiki/code-map.md` during implementation to record:
- The public workspace provisioning entry point.
- Internal path and driver modules.
- Test locations and the real-git integration proof.
- Any new targeted test command if one is useful.
No human-owned ADR or concept document change is expected for this issue because the current docs already define the desired behavior. If implementation discovers a mismatch, stop and surface it rather than silently changing the architecture.
### Risks and open decisions

- **Clone URL source:** Issue 17 names `Project.hostRepository.owner` and `name`, but the clone operation also needs an upstream URL or configured remote source. If the current `Project` contract lacks that exact field, implementation must add the smallest boundary input needed or use the existing project setting that already carries it.
- **Default branch detection:** The spec assumes a freshly fetched default branch. Implementation must choose a deterministic fallback when remote symbolic `HEAD` is unavailable, preferably a project-provided default branch.
- **Branch-name sanitization:** Git branch names have more rules than filesystem slugs. The sanitizer must avoid invalid ref names while preserving the required prefix and uniqueness.
- **Rollback after partial git success:** `git worktree add` can leave administrative state even if later steps fail. Rollback should prefer git-aware worktree removal and report any cleanup failures.
- **Filesystem race conditions:** A concurrent attempt to provision the same run id could race on run-root creation. The implementation should fail safely when the directory already exists.
- **Provider behavior:** This feature assumes local `git` is installed and available to the execution host. Non-local git providers, remote workers, and upstream branch pushing are unsupported in this issue.
## Task list

### Story 1: Public execution API surface

Expose the agreed workspace provisioning API from `@autocatalyst/execution` without leaking internal git, filesystem, or path helpers.
#### Task 1.1: Add public workspace types and errors

**Description:** Create `packages/execution/src/workspace.ts` with the public request type, root type, run-kind unions, result union, typed error code union, error context type, `WorkspaceProvisioningError` class, and `provisionWorkspace` function signature described in this spec.
**Acceptance criteria:**
- `ProvisionWorkspaceRequest` uses the existing `Project` type from `@autocatalyst/api-contract`.
- `ProvisionWorkspaceRequest.defaultBranch` is a direct optional field on the request.
- Result types are discriminated by `shape: 'none' | 'scratch_only' | 'two_roots'`.
- `WorkspaceProvisioningError` carries a stable `code`, credential-redacted `message`, and optional structured `context`.
- No internal driver, provisioner, or path helper is exported from this file.
**Dependencies:** None.
#### Task 1.2: Re-export the public API from the package entry point

**Description:** Update `packages/execution/src/index.ts` so public callers can import the workspace provisioning symbols from `@autocatalyst/execution` while the existing runner scaffold exports remain intact.
**Acceptance criteria:**
- `RunnerInput`, `RunnerResult`, `Runner`, and `executionPackageName` remain exported.
- The public workspace provisioning types, errors, and `provisionWorkspace` function are available from `packages/execution/src/index.ts`.
- No `packages/execution/src/internal/*` symbol is exported through the package entry point.
**Dependencies:** Task 1.1.
### Story 2: Pure workspace path, shape, and branch helpers

Implement deterministic helpers for shape selection, safe path resolution, containment checks, and run branch derivation so the provisioner can stay small and testable.
#### Task 2.1: Implement provisioning-shape selection

**Description:** Add `selectWorkspaceProvisioningShape` in `packages/execution/src/internal/workspace-paths.ts` to map supported run kinds to `none`, `scratch_only`, or `two_roots`.
**Acceptance criteria:**
- `question` returns `none`.
- `file_issue` returns `scratch_only`.
- `feature`, `enhancement`, `bug`, and `chore` return `two_roots`.
- Unknown values fail with `WorkspaceProvisioningError` code `unsupported_run_kind`.
- The helper has no filesystem or git side effects.
**Dependencies:** Task 1.1.
#### Task 2.2: Implement safe segment validation and path resolution

**Description:** Add `validateRunIdSegment`, `validateRepositoryPathSegment`, and `resolveWorkspacePaths` in `workspace-paths.ts`.
**Acceptance criteria:**
- Run ids that are empty, contain `..`, contain path separators, or are otherwise unsafe as one path segment fail with `invalid_run_id`.
- Repository owner and name values that are empty or unsafe fail with `invalid_project_repository`.
- `Project.workspaceRootOverride ?? roots.workspacesRoot` selects the effective workspace root.
- Host repository paths resolve to `//`.
- Run, repo, and scratch paths resolve to `////{repo,scratch}`.
- Paths are built with Node `path` APIs, not string concatenation.
- The helper is deterministic and can be unit-tested without git.
**Dependencies:** Task 1.1.
#### Task 2.3: Implement explicit containment checks

**Description:** Add `assertPathInsideRoot` in `workspace-paths.ts` for guarded writes and deletes.
**Required signature:**
```typescript
async function assertPathInsideRoot(
  input: {
    readonly root: string;
    readonly rootKind: 'workspace' | 'repos';
    readonly targetPath: string;
    readonly intent: 'write' | 'delete' | 'git';
  },
  deps: { readonly pathExists: (path: string) => Promise; readonly realpath: (path: string) => Promise },
): Promise
```
**Acceptance criteria:**
- The relevant root is an explicit input to every containment check: effective workspace root for per-run workspace operations and repos root for host clone operations.
- `assertPathInsideRoot` lives in `workspace-paths.ts` and owns canonical containment policy for both root kinds; the Node driver supplies `fs.realpath`/existence dependencies and fake tests supply deterministic dependencies.
- Existing paths use canonical resolution through the injected `realpath`.
- Not-yet-created paths walk upward to the nearest existing parent, canonicalize that parent, and validate both the canonical parent and final resolved target relationship to the canonical root.
- The resolved canonical or would-be target path is returned for the driver operation to use.
- Out-of-root targets fail with `WorkspaceProvisioningError` code `out_of_root_path`.
- The helper does not assume a process-wide global workspace root or repos root.
**Dependencies:** Task 2.2.
#### Task 2.4: Implement run branch derivation

**Description:** Add `deriveRunBranchName` in `workspace-paths.ts` with the sanitizer and branch format described in this spec.
**Acceptance criteria:**
- Implementing run kinds produce `/-`.
- The topic segment follows the deterministic sanitizer algorithm in the Path resolution and validation section, including exact character replacement, dot-sequence cleanup, `.lock` suffix cleanup, empty fallback to `run`, and truncation behavior.
- Unsafe `shortRunId` values fail with `invalid_run_id`; valid values match `^[A-Za-z0-9][A-Za-z0-9_-]{5,31}$`.
- The implementation preserves the suffix and truncates only the topic segment when needed to keep the complete branch name at or below 240 characters.
- The helper keeps branch-name derivation separate from filesystem path derivation.
**Dependencies:** Task 1.1.
### Story 3: Internal workspace driver

Provide one internal driver that owns git and filesystem effects, uses argument-array process execution, and supports fake-driver testing.
#### Task 3.1: Define the driver contract and Node driver factory

**Description:** Replace the current `packages/execution/src/internal/workspace-driver.ts` stub with internal interfaces and a `createNodeWorkspaceDriver` factory that satisfy the driver contract in this spec.
**Acceptance criteria:**
- `WorkspaceDriver` includes host repository, fetch, default branch, worktree, branch, mkdir, existence, realpath, and remove-directory operations.
- Input interfaces use field names consistent with the public request shape and driver operations described in this spec.
- Driver types are importable by package-local tests and internal modules.
- Driver types are not exported from `@autocatalyst/execution`.
**Dependencies:** Task 1.1.
#### Task 3.2: Implement safe git command execution and redaction

**Description:** Implement the Node driver's git execution through `execFile` or equivalent argument-array APIs, with credential redaction for diagnostics.
**Acceptance criteria:**
- No git command is built through shell interpolation.
- Stderr and command-failure diagnostics can be attached to typed errors without exposing embedded credentials.
- Remote URLs with embedded credentials are redacted before they appear in errors or logs.
- Git failures are mapped to the relevant `WorkspaceProvisioningErrorCode`.
**Dependencies:** Task 3.1.
#### Task 3.3: Implement host clone, fetch, and default branch operations

**Description:** Implement `ensureHostRepository`, `fetchHostRepository`, and `resolveDefaultBranch` in the Node driver.
**Acceptance criteria:**
- Missing host clones create parent directories and run a full `git clone`.
- Host clone parent creation, host repository verification, and fetch operations validate their target paths against `` containment rather than the effective workspace root.
- Existing host paths are reused after verification that they are git repositories.
- Fetch runs against the host clone's upstream remote before worktree creation.
- Default branch resolution prefers fetched remote information and uses `request.defaultBranch` only as the explicit fallback.
- If no branch can be resolved, provisioning can fail with `default_branch_resolution_failed`.
**Dependencies:** Task 3.2.
#### Task 3.4: Implement worktree and branch operations

**Description:** Implement `addWorktree`, `currentBranch`, and `removeWorktree` in the Node driver.
**Acceptance criteria:**
- `addWorktree` creates the worktree at the requested path on the requested new branch from the requested base ref.
- Branch collisions fail instead of silently reusing an unsafe branch.
- `currentBranch` returns the current branch name or `null` when it cannot identify one.
- `removeWorktree` can be called during rollback after a worktree was created.
- Worktree operation failures map to `worktree_creation_failed` or rollback context as appropriate.
**Dependencies:** Task 3.2.
#### Task 3.5: Implement guarded filesystem operations

**Description:** Implement `mkdirp`, `pathExists`, `realpath`, and `removeDirectory` in the Node driver.
**Acceptance criteria:**
- Directory creation supports run-root and scratch-root creation.
- `pathExists` lets the provisioner fail before overwriting an existing run root.
- `realpath` wraps `fs.realpath` for containment helper dependencies and fake-driver tests.
- `removeDirectory` requires a `workspaceRoot` argument and performs containment-checked deletion.
- Deletion never removes a target outside the effective workspace root.
**Dependencies:** Tasks 2.3, 3.1.
### Story 4: Provisioning orchestration and rollback

Coordinate pure helpers and driver operations into one provisioning service that creates no workspace, scratch-only workspace, or two-root workspace as requested.
#### Task 4.1: Add the internal provisioner factory

**Description:** Create `packages/execution/src/internal/workspace-provisioner.ts` with `createWorkspaceProvisioner` and dependency injection points for the driver and pure helpers.
**Acceptance criteria:**
- `WorkspaceProvisionerDependencies` includes the driver and pure-helper dependency seams needed by this spec.
- Package-local tests can inject a fake `WorkspaceDriver`.
- Public callers do not need to know the provisioner factory exists.
- Input validation runs before any filesystem or git mutation.
**Dependencies:** Tasks 2.1, 2.2, 2.4, 3.1.
#### Task 4.2: Implement no-workspace and scratch-only flows

**Description:** Implement the `question` and `file_issue` provisioning paths in the provisioner.
**Acceptance criteria:**
- `question` validates input, returns `{ shape: 'none', runId }`, and creates no directories.
- `file_issue` validates input, fails if the run root already exists, creates the run root, creates scratch, and returns the scratch-only result.
- Scratch-only provisioning does not ensure, fetch, or otherwise touch the host git clone.
- Scratch root is a sibling location where the repo root would be, not nested under a repo.
**Dependencies:** Task 4.1.
#### Task 4.3: Implement two-root provisioning flow

**Description:** Implement the `feature`, `enhancement`, `bug`, and `chore` provisioning path in the provisioner.
**Acceptance criteria:**
- The provisioner fails with `run_workspace_exists` if the run root already exists before provisioning begins.
- The host repository is ensured and fetched before the branch base is resolved.
- The worktree is created at the resolved repo root on the derived run branch.
- Scratch is created beside the repo root.
- The branch guard confirms the worktree is on the expected branch before success.
- The returned result includes `workspaceRoot`, `runRoot`, `repoRoot`, `scratchRoot`, `hostRepositoryPath`, and `branchName`.
**Dependencies:** Tasks 3.3, 3.4, 3.5, 4.1.
#### Task 4.4: Implement rollback after provisioning failure

**Description:** Add failure handling so any failure after run-root creation attempts to clean up the worktree and remove the whole run directory.
**Acceptance criteria:**
- A failure during worktree creation leaves no residual run directory when rollback succeeds.
- A failure after worktree creation first attempts git-aware worktree removal, then removes the run root.
- Rollback uses the effective workspace root for containment.
- Rollback failures preserve the original error and attach rollback details through `rollback_failed` context.
- Provisioning is safe to retry after a failed attempt when rollback succeeds.
**Dependencies:** Tasks 3.4, 3.5, 4.2, 4.3.
#### Task 4.5: Wire the public `provisionWorkspace` function

**Description:** Implement the public function in `workspace.ts` so it constructs the default Node workspace driver and delegates to the internal provisioner.
**Acceptance criteria:**
- Public callers need only call `provisionWorkspace(request)`.
- Internal dependency injection remains available for tests through `createWorkspaceProvisioner`.
- The public function does not export or expose the driver instance.
- Expected failure classes surface as `WorkspaceProvisioningError`.
**Dependencies:** Tasks 1.1, 3.1, 4.1, 4.2, 4.3, 4.4.
### Story 5: Unit coverage for deterministic behavior

Add fast tests for pure helpers, public exports, error behavior, and provisioner orchestration using fake drivers.
#### Task 5.1: Cover path, shape, containment, and branch helpers

**Description:** Add unit tests in `packages/execution/src/workspace.spec.ts` or focused package-local specs for deterministic helper behavior.
**Acceptance criteria:**
- Tests cover all supported run-kind to shape mappings.
- Tests cover unsupported run kinds and typed `unsupported_run_kind` failures.
- Tests cover valid and invalid run ids.
- Tests cover repository owner/name validation.
- Tests cover workspace root override path resolution.
- Tests cover out-of-root containment failure.
- Tests cover branch-name sanitizer edge cases, accepted `shortRunId` pattern `^[A-Za-z0-9][A-Za-z0-9_-]{5,31}$`, unsafe `shortRunId`, empty sanitized slug fallback, and 240-character max-length truncation.
**Dependencies:** Story 2.
#### Task 5.2: Cover public API exports and package boundary assumptions

**Description:** Update the existing execution scaffold tests to include workspace public exports without importing internals through the public entry point.
**Acceptance criteria:**
- Tests can import public workspace types or values from `./index.js`.
- Existing `Runner` scaffold behavior remains covered.
- No test depends on internal modules through `@autocatalyst/execution`.
- Boundary tests remain compatible with the new files.
**Dependencies:** Tasks 1.1, 1.2.
#### Task 5.3: Cover provisioner flows with a fake driver

**Description:** Add fake-driver tests for no-workspace, scratch-only, and two-root orchestration.
**Acceptance criteria:**
- `question` returns without calling filesystem or git mutation methods.
- `file_issue` creates run root and scratch only.
- Implementing runs call host ensure, fetch, default branch resolution, worktree creation, scratch creation, and branch guard in order.
- Branch guard mismatch fails with `branch_guard_failed`.
- Existing run root fails with `run_workspace_exists`.
**Dependencies:** Story 4.
#### Task 5.4: Cover rollback and typed failure preservation

**Description:** Use fake-driver failure injection to prove cleanup and error preservation for mid-provisioning failures.
**Acceptance criteria:**
- A failure during worktree creation removes the run root.
- A failure after worktree creation attempts `removeWorktree` before run-root deletion.
- A rollback deletion failure surfaces `rollback_failed` and preserves the original provisioning failure in context as a sanitized summary.
- Rollback errors do not hide the cleanup step that failed.
- Tests assert credentials and embedded remote URLs are redacted from both error messages and `WorkspaceProvisioningErrorContext` summaries.
**Dependencies:** Task 4.4.
### Story 6: Real-git integration proof

Prove the success path against temporary real git repositories while keeping brittle failure injection in unit tests.
#### Task 6.1: Build the temporary git repository fixture

**Description:** Add `packages/execution/src/workspace.integration.spec.ts` setup that creates a bare upstream repository, a source checkout, an initial commit on the default branch, and temporary repos/workspaces roots.
**Acceptance criteria:**
- The fixture uses real `git` commands and temporary directories.
- The fixture creates or checks out an explicit default branch, such as `main`, before the initial commit.
- The source checkout configures local test `user.name` and `user.email` before committing so clean CI environments do not depend on global git identity.
- The initial commit is pushed to the bare upstream.
- Test setup skips or fails clearly when local `git` is unavailable.
- Temporary directories are isolated per test and cleaned up by the test framework or fixture.
**Dependencies:** Story 3.
#### Task 6.2: Prove successful two-root provisioning with real git

**Description:** Add an integration test that provisions a `feature` run against the temporary upstream repository.
**Acceptance criteria:**
- The host clone exists at `//`.
- The worktree exists at `////repo`.
- `git -C  branch --show-current` returns the expected branch.
- The scratch root exists at `////scratch`.
- The worktree contains the initial committed file from the fetched default branch.
- The result shape is `two_roots` and includes the expected paths and branch name.
**Dependencies:** Tasks 4.3, 4.5, 6.1.
#### Task 6.3: Prove host clone reuse and safety failures

**Description:** Extend integration coverage for repeated provisioning and safety guards that do not need brittle git failure simulation.
**Acceptance criteria:**
- A second run for the same project reuses the existing host clone instead of cloning to a second host path.
- Traversal-bearing run ids are rejected before run directories are created.
- Out-of-root containment helper behavior is asserted with temporary paths.
- The test does not push run branches to the upstream remote.
**Dependencies:** Tasks 2.3, 4.3, 6.2.
#### Task 6.4: Keep precise rollback failure injection in package-local tests

**Description:** Add the rollback sub-test described in Task 5.4 using `createWorkspaceProvisioner` and a fake or configurable driver rather than relying on filesystem permission tricks.
**Acceptance criteria:**
- The induced failure occurs after run-root creation.
- The test asserts no residual `` directory remains when rollback succeeds.
- The test imports internals only from within the execution package's own test code.
- The integration success path remains based on real git behavior.
**Dependencies:** Tasks 4.4, 5.4.
### Story 7: Boundary, documentation, and validation

Keep agent-facing navigation current and prove the implementation respects the existing package boundary.
#### Task 7.1: Update the agent code map

**Description:** Update `context-agent/wiki/code-map.md` during implementation to record the new public entry point, internal modules, test seams, integration-test strategy, and any useful targeted validation commands.
**Acceptance criteria:**
- The code map lists `packages/execution/src/workspace.ts`.
- The code map lists `workspace-paths.ts`, `workspace-driver.ts`, and `workspace-provisioner.ts` as internal modules.
- The code map notes that fake-driver tests may use the internal provisioner from package-local tests.
- The code map records the real-git integration test file.
- Any new targeted command used during implementation is documented.
**Dependencies:** Stories 1, 2, 3, 4, 5, 6.
#### Task 7.2: Run targeted and boundary validation

**Description:** Run the relevant execution-package checks and the repository boundary test after implementation.
**Acceptance criteria:**
- `pnpm nx test execution` passes.
- `pnpm nx build execution` passes.
- `pnpm nx lint execution` passes.
- `pnpm test:boundaries` passes.
- If a broader validation command is run, any failure outside this feature is documented separately from feature regressions.
**Dependencies:** Stories 1, 2, 3, 4, 5, 6, and Task 7.1.