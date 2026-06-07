---
created: 2026-06-04
last_updated: 2026-06-07
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-021: Workspace lifecycle and reclamation

## Status

Accepted

## Context

A workspace exists only while a run needs it. A run's durable truth is its branch plus its
checkpointed results (ADR-004), so the workspace is re-creatable. The policy must decide when a
workspace is created and destroyed, what is kept when a run ends, and how a missing workspace is
restored, without losing recoverable work or leaking disk.

The terminal states differ in what is worth keeping (ADR-015 fixes the set: `done`, `canceled`,
`failed`):

- A `done` run's work is merged — the diff is in the default branch.
- A `canceled` run's work is abandoned but not landed — its branch is the only record of it.
- A `failed` run's working tree may hold an uncommitted tail and scratch results worth inspecting.

Two facts about workspaces also bear on the policy. A crash can leave a workspace whose run is still
non-terminal, or a workspace directory that no run claims. And the two things a workspace carries have
different costs and different salvage value: its **worktree** (a disk-heavy working tree plus scratch)
and its **branch** (a cheap, durable record in the host repository, ADR-020).

## Decision

**A workspace is created and torn down as a unit keyed to the `Run`. Retention at a terminal state is
set per state across two independent axes — the worktree and the branch. A non-terminal run whose
workspace is missing is re-materialized, never dropped. A scheduled workspace garbage collection
reconciles on-disk workspaces and run branches against run state, reclaiming each past its retention
window.**

- **Creation and teardown as a unit.** Creating a workspace makes the run-keyed directory, adds the
  worktree on the run's branch, and builds the scratch root; any failure rolls the whole directory
  back. Teardown is asymmetric: the worktree is removed git-aware (which clears its administrative
  state and **keeps the branch ref**), and the scratch root is a plain removal. Teardown never touches
  the durable branch.
- **A controlled stop commits before it destroys.** A `canceled` run commits its uncommitted tail to
  its branch as a final checkpoint before its worktree is removed, so a graceful teardown loses no work
  and the retained branch is a complete record. An abrupt `failed` run cannot rely on committing,
  because the stop may have left no chance to, so it retains its worktree for inspection instead.
- **Retention per terminal state, two axes:**

  | Terminal state | Worktree | Branch |
  | --- | --- | --- |
  | `done` (merged) | destroyed | deleted (the work is in the default branch) |
  | `canceled` | committed, then destroyed | retained, reclaimed after the **branch window** |
  | `failed` | retained, reclaimed after the **worktree window** | retained, reclaimed after the **branch window** |

  A throwaway issue-filing run, which has scratch but no worktree or branch, destroys its scratch when
  it finishes filing.
- **Two retention windows.** A shorter **worktree window** bounds disk (the working tree and scratch);
  a longer **branch window** bounds object-store growth (a branch is cheap and is the salvage record).
  Both are configurable, with the branch window at least the worktree window.
- **Re-materialize a missing workspace.** Startup reconciliation reconstructs a non-terminal run whose
  workspace is missing from its branch and checkpoints (ADR-004). The base it reconstructs from — the
  run's branch when committed work is restored, or a freshly fetched default branch when the run starts
  over — follows the per-state recovery-policy table owned by `run` (ADR-015). The mechanics are owned
  by `workspace`, the recovery driving by `execution-runtime`.
- **Workspace garbage collection.** A scheduled pass — periodic and at startup — reconciles every
  on-disk workspace and host-repository run branch against run state: it reclaims a terminal
  workspace or branch past its window, reclaims a crash orphan that no live or non-terminal run claims,
  and leaves a non-terminal run's workspace in place. The `workspace` qualifier distinguishes it from
  object-store compaction (`git gc`).
- **One safe-delete primitive.** Every deletion routes through a pruning step that runs a containment
  guard against the resolved workspace root, checks the path's existence before removing it, returns a
  typed outcome, and emits a structured log — so deletion is safe and observable wherever it is
  triggered (terminal teardown, garbage collection, or an operator action).

## Consequences

**Positive:**
- No run is lost to a missing workspace; recoverable work is reconstructed from the branch and
  checkpoints.
- A canceled run loses no work — its uncommitted tail is committed before teardown — so destroying its
  worktree is safe.
- Disk and object-store growth are both bounded, including the crash orphans an unattended host
  accumulates.
- Retaining only `failed` worktrees keeps the inspection affordance where it is useful and spares the
  common successful and canceled cases its cost.
- Sizing the two windows independently reclaims each artifact in proportion to its cost.

**Negative:**
- Garbage collection and startup reconciliation are machinery the system must implement and keep
  correct.
- A `failed` worktree is reclaimed once its window elapses, so an uncommitted tail not inspected in
  time is lost; only the committed branch survives past the window.
- The host repository accumulates retained `canceled` and `failed` branches until their window
  elapses, which the branch window and periodic compaction bound rather than prevent instantaneously.

## Alternatives considered

### Drop a non-terminal run whose workspace is missing

When a workspace referenced by a non-terminal run is absent on load, discard the run.

**Pros:**
- Trivial — no reconciliation, and the store never references a workspace that is not there.

**Cons:**
- Loses a run that crashed or whose workspace was reclaimed, even though its branch and checkpoints
  are durable and sufficient to reconstruct it.
- Treats the re-creatable workspace as if it were the source of truth.

**Why not chosen:** It contradicts the re-creatable-workspace model (ADR-004), where the branch plus
checkpoints are enough to reconstruct, so dropping the run discards recoverable work for no benefit
beyond avoiding the reconciliation step.

### Retain every workspace until an operator removes it

Never reclaim automatically; keep every run's working tree until a human deletes it.

**Pros:**
- Every run's working tree stays available for inspection indefinitely.
- No garbage-collection machinery.

**Cons:**
- Unbounded disk growth, and crash orphans accumulate with nothing to reclaim them.
- Makes the common successful case pay the storage cost of the rare inspection case.

**Why not chosen:** Successful and canceled runs have nothing to inspect, since their work is merged or
held in the branch, so retaining their worktrees is pure cost. Bounded, per-state retention keeps the
inspection affordance only at failure, where it is useful.

### A single retention window for the whole workspace

One window and one timer governing the workspace as a whole.

**Pros:**
- One policy and one timer to reason about.

**Cons:**
- The worktree and the branch have different costs and different salvage value, so a single window
  either reclaims the cheap, durable branch too early or holds the heavy working tree too long.

**Why not chosen:** Two windows — a shorter one for the worktree, a longer one for the branch —
reclaim each in proportion to its cost, which a single window cannot.
