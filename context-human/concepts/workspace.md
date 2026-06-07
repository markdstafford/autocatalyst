---
created: 2026-06-04
last_updated: 2026-06-06
status: active
roadmap: exec
---

# Workspace

The isolated, per-run filesystem environment a `Run` acts in: a working tree of the target repository
on its own branch, where the agent reads code, makes changes, and produces the diff that becomes a
`PR`. This concept owns the workspace's **structure and lifecycle** — how it is laid out and isolated,
how it is created and torn down, how it is retained or reclaimed at the end of a run, and how a
missing one is re-materialized. It does **not** own how the agent runs against the workspace — the
`Runner`, the event stream, result validation, the recovery that drives a resume (see
`execution-runtime`); the run's step machine and per-state resume policy (see `run`); runner and
provider plurality (see `agent-runners`); the configuration schema that resolves a workspace root (see
`settings`); or the host-side execution topology it sits inside (see `architecture` and ADR-003).

## The two roots

A workspace has two distinct, named roots, separated by one rule: **nothing in the repo root is
ephemeral, and nothing in the scratch root is durable.**

- The **repo root** is the worktree — what becomes the diff and the `PR`. Only what is meant to be
  committed lives here.
- The **scratch root** holds the ephemeral machinery of a run: the structured result the runner
  validates, working files the agent produces, issue bodies staged before they are filed, plan files,
  and anything else that must not enter the diff. It is never committed.

Anything that must survive a run leaves the scratch root: the runner validates each step's result and
persists the validated value to the database, so scratch is never a home of record. This lets scratch
be discarded and recreated at will, and keeps run machinery out of the repository (ADR-010).

The scratch root is otherwise unstructured: a single working area the agent uses as it needs. The one
convention is that a step writes its structured result to a known per-step path, named for the run
and step, so the runner can find and validate it; the rest is free space.

## The isolation primitive

A per-run workspace is a **git worktree** of the host repository, on a run-owned branch (ADR-020). The
host holds the repository (ADR-003) and is the single writer of git operations, so a worktree's shared
object store is safe across concurrent runs: each run is on its own branch, and several runs are active
at once, one per topic (`domain-model`). A worktree gives two properties the lifecycle depends on:

- The run's branch ref lives in the **host repository**, so its commits persist after the worktree is
  removed, and the durable branch costs no separate step.
- The control plane reads any run's diff (`<default-branch>..<run-branch>`) straight from the host
  repository, present workspace or not, which serves preview over the API (ADR-003).

A clone from `repo_url` is the materialization variant reserved for execution workers that do not
share the host filesystem; it is taken when execution is extracted (see Open edges).

## Provisioning shapes

Not every run needs both roots. The shape a run gets is resolved from its kind; the control plane
resolves it into the Execution Context (`execution-runtime`), and `workspace` owns the shapes and their
lifecycle:

- **No workspace** — a `question` run reads the host repository read-only and materializes nothing.
- **Scratch only** — a `file_issue` run produces issue-tracker content and never a diff, so it gets a
  scratch root for staged issue bodies and no worktree. It is throwaway: its scratch is destroyed once
  filing finishes.
- **Two roots** — an implementing workflow (`feature`, `enhancement`, `bug`, `chore`) gets a worktree
  and a scratch root, because it produces code that becomes a `PR`.

## Layout and canonical paths

A workspace's identity is the `Run` and the `Project` it serves. A `Project` resolves to a `repo_url`,
a host-repository location, and a workspace root, read from configuration in the database (ADR-008;
`settings`). At the current scale a `Project` corresponds to one repository, so the path mirrors the
repository's upstream identity (`org/repo`), which avoids collisions between same-named repositories in
different orgs and makes a workspace tree self-describing:

```
<repos_root>/<org>/<repo>                                <- the host repository
<workspaces_root>/<org>/<repo>/<run-id>/repo             <- the worktree (the diff / PR)
<workspaces_root>/<org>/<repo>/<run-id>/scratch          <- the scratch root (never committed)
```

`<repos_root>` and `<workspaces_root>` are operational configuration; a `Project` may override its
workspace root (for instance, to place a large repository's workspaces on a separate disk). A tenant
segment is the natural outer layer of this path when multi-tenant filesystem isolation is built; until
then tenancy is carried in the data (`tenant` on the row, ADR-009) rather than in the path.

The paths are **canonical and stable**, the same shape every run, so the agent reasons about a fixed
environment rather than discovering it (ADR-010). The agent's working directory is the repo root, and
the scratch root sits at a known sibling; these are communicated through the agent's environment, which
the runner materializes. The two named roots are themselves the legibility mechanism: the agent never
has to work out whether something it writes is part of the change or part of the run's machinery,
because the answer is which root it is in. Because execution is host-side (ADR-003), the agent's paths
are the host's paths, so there is no host-to-sandbox path translation. A worktree is transparent to git
tooling and to the provisioned language server, which operate in it as in any checkout.

## Containment

A workspace is contained by guards that route every path through a check against the resolved
workspace root, so an action cannot escape it: the run identifier cannot contain path-traversal
segments, a directory targeted for deletion must be a direct child of the resolved root, and a path the
agent plans to write is rejected if it resolves outside the workspace. A branch guard confirms the
worktree is still on its expected branch. These guards are parameterized by the **resolved** root that
travels with the run, so a multi-root deployment is contained without assuming a single global root.

This filesystem-path containment is the isolation posture for trusted single-host operation, alongside
broad, non-interactive tool permissions scoped to the workspace (ADR-010). Stronger isolation
(containers, network-egress controls, per-run least privilege) is sequenced for hosted and
multi-tenant operation (ADR-010). That hardening stays invisible to the agent because the canonical
roots are mounted at the same logical paths inside a container, so the agent's view of its environment
does not change when the boundary tightens.

## The branch

Each run owns exactly one branch, named for its work kind and topic: `<kind>/<topic-slug>-<short-run-id>`,
where `<kind>` is `feature`, `bug`, `chore`, or `enhancement`. The work-kind prefix keeps one
vocabulary across the run's workflow, its artifact, and its branch; the topic slug reads legibly; the
short run identifier makes the branch unique per run.

Checkpoints are **commits on this branch** rather than uncommitted snapshots, which is what makes
"branch plus checkpoints" the durable truth (ADR-004) and what re-materialization reconstructs from. The
branch is durable in the host repository from its first commit; it is pushed to the upstream remote when
the `PR` opens (the push and `PR` mechanics belong to `trackers`). Two keys therefore distinguish one
run's work from another's: committed work is identified by the **branch**; an uncommitted tail and
scratch are identified by the run-keyed **workspace directory**, and survive only while that directory is
retained.

The host repository is a **full clone**, maintained once and shared by every worktree, so history is
stored once rather than per run. Full history lets a run rebase its branch onto an advanced default
branch and lets any run that needs blame or bisect use them. Before a run's worktree is created, the
host repository fetches from the upstream remote, and the run's branch is cut from the freshly fetched
default branch, so a run starts from the current default. A run targets the default branch; a partial
clone is the lever held in reserve for a repository large enough that a full host clone is a problem
(see Open edges).

## Creation and teardown

A workspace is created and torn down as a unit keyed to the `Run` (ADR-021). Creation makes the
run-keyed directory, adds the worktree on the run's branch (cut from the fetched default branch), and
builds the scratch root; any failure rolls the whole directory back.

Teardown is asymmetric, because the two roots have different mechanics. The worktree is removed
git-aware: this drops the working tree and clears the worktree's administrative state in the host
repository while **keeping the branch ref**. The scratch root is a plain directory removal. Teardown
therefore never touches the durable branch, which is what makes destroying a workspace safe, since
the committed work and the validated result both live elsewhere. A controlled stop commits first: a
`canceled` run commits its uncommitted tail to its branch as a final checkpoint before its worktree is
removed, so a graceful teardown loses nothing. An abrupt failure cannot rely on committing, which is
why a `failed` run retains its worktree instead (see Retention and reclamation).

Every deletion — at terminal teardown, during garbage collection, or from an operator action — routes
through one **pruning step**: it runs the containment guard against the resolved root, confirms the
path exists before removing it (so an already-absent workspace is reported as missing rather than
silently succeeding), returns a typed outcome (`deleted`, `missing`, `skipped`, `rejected`, `failed`),
and emits a structured log carrying the run, the paths, the mode, and the duration. Deletion is thus
safe and observable wherever it is triggered.

## Retention and reclamation

Retention at a terminal state is set per state across two independent axes — the worktree and the
branch — because they have different costs and different salvage value (ADR-021):

| Terminal state | Worktree | Branch |
| --- | --- | --- |
| `done` (merged) | destroyed | deleted — the work is in the default branch |
| `canceled` | committed, then destroyed | retained, reclaimed after the branch window |
| `failed` | retained, reclaimed after the worktree window | retained, reclaimed after the branch window |

A `done` implementing run is a merged run — the merge signal is what ends it (`domain-model`) — so its
work is in the default branch and both roots and the branch are reclaimed; there is no separate
prune-on-merge step. A `canceled` run is a controlled stop, so its uncommitted tail is committed to its
branch before the worktree is removed; removing the worktree loses nothing, and the retained branch is
a complete record. A `failed` run keeps both: the worktree, because an abrupt stop may have left no
chance to commit and the uncommitted tail and scratch results are recoverable only from it; the branch,
because it holds the committed checkpoints.

Two retention windows bound the cost: a shorter **worktree window** bounds disk, and a longer **branch
window** bounds the host repository's object-store growth. Both are configurable, with the branch
window at least the worktree window.

A scheduled **workspace garbage collection** — running periodically and at startup — enforces the
windows and reclaims what an unattended host accumulates. It reconciles every on-disk workspace and
host-repository run branch against run state: it reclaims a terminal workspace or branch past its
window, reclaims a crash orphan that no live or non-terminal run claims, and leaves a non-terminal
run's workspace in place. Because reclaiming a workspace never loses durable work — the branch and the
validated result live elsewhere — garbage collection is safe to run unattended. (The `workspace`
qualifier distinguishes it from object-store compaction, `git gc`, which the host repository also needs
periodically.)

## Re-materialization

A non-terminal run whose workspace is missing is **re-materialized, never dropped** (ADR-021; ADR-004).
Re-materialization reconstructs the two roots from the durable truth: it adds a worktree at the canonical
path and makes a **fresh, empty scratch root**. Scratch is never restored, since nothing in it is
durable, and the next step's inputs come from the database rather than from old scratch files. The
branch guard then confirms the worktree is on the expected branch. An uncommitted tail since the last
checkpoint is not restored; the run re-invokes from its last validated checkpoint, which is the resume
`execution-runtime` provides.

The base the worktree is built from follows the run's per-state resume policy (`run`):

- **Resume from a step** — the worktree is built from the **run's branch**, restoring committed work,
  for a run that failed with checkpoints already committed.
- **Start over** — the worktree is built from the **freshly fetched default branch**, carrying no
  prior commits, for a run that failed before committing anything meaningful.

`workspace` provides both: the same worktree creation with a different base and a fresh scratch root.
`run` decides which a state takes, `orchestrator` admits a stopped run for dispatch, and
`execution-runtime` drives the re-invocation. Startup reconciliation walks each non-terminal run: a
present workspace on the right branch is left in place, a missing one is re-materialized and admitted,
and the one edge — a run whose branch is itself missing because the host repository was lost — cannot
reconstruct from a checkpoint and is escalated.

A run's branch is durable to the extent the host repository is. On a co-located host the host
repository and the database share a disk, so losing one loses the other; pushing a run's branch to the
upstream remote at every checkpoint, rather than only at `PR` open, is the lever for branch durability
that outlives the host disk, and it binds at the same point execution is extracted to ephemeral remote
workers (see Open edges).

## Relationships

- `execution-runtime` — drives the agent session against the workspace, validates the scratch result
  through the result contract, and owns the recovery that re-invokes a re-materialized run; this
  concept owns the workspace's own structure and lifecycle.
- `run` — the run entity, its step machine, and the per-state resume policy that selects a
  re-materialization base.
- `orchestrator` — admits a stopped run for dispatch; the single authority that mutates run state.
- `domain-model` — the `Run`, `Project`, `PR`, and `RunStep` shapes this concept's lifecycle serves;
  the merge signal that ends a run.
- `architecture` — host-side execution, the host repository, and the API that previews a diff
  (ADR-003), and the configuration store a workspace root resolves from.
- `settings` — the schema of the configuration that resolves `repo_url` and the workspace roots.
- `trackers` — opening the `PR` and pushing the branch to the upstream remote.

## Constraints and decisions

- **A per-run workspace is a git worktree on a run-owned branch** (ADR-020); a clone from `repo_url` is
  the reserved variant for non-co-located execution workers.
- **Two named roots, separated by durability** — nothing in the repo root is ephemeral, nothing in the
  scratch root is durable (ADR-010); the validated result is persisted to the database, so scratch is
  never a home of record.
- **The branch is the durable home of committed work** (ADR-004); checkpoints are commits on it;
  branches are named `<kind>/<topic-slug>-<short-run-id>`.
- **The host repository is a full clone**, shared by all worktrees and fetched before a run's branch is
  cut.
- **Workspace created and torn down as a unit keyed to the `Run`**, with asymmetric git-aware teardown
  that keeps the branch (ADR-021).
- **Retention is per terminal state across two axes** (worktree, branch) with two windows; a scheduled
  workspace garbage collection enforces them and reclaims crash orphans; every deletion routes through
  one safe, observable pruning step (ADR-021).
- **A missing workspace for a non-terminal run is re-materialized, never dropped** (ADR-021; ADR-004).
- **Containment guards parameterized by the resolved root**; filesystem-path containment is the posture
  now, with container isolation sequenced (ADR-010).

## Open edges

- **Extracted execution** — when execution moves to workers that do not share the host filesystem,
  materialization shifts from a worktree to a clone from `repo_url`, branch durability shifts to a
  per-checkpoint push to the upstream remote, and the canonical roots are mounted into a container at
  the same logical paths. These switch on together as one step.
- **Container isolation and egress controls** — the stronger boundary, sequenced for hosted and
  multi-tenant operation (ADR-010), with a tenant segment added to the workspace path.
- **Partial clone of the host repository** — `--filter=blob:none` to keep the full commit graph while
  fetching blobs on demand, taken if a repository grows large enough that a full host clone is a
  problem.
- **Targeting a non-default base branch** — for stacked work; the layout admits it, and only the
  default-branch base is fixed now.
