---
created: 2026-06-04
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-020: Workspace isolation primitive

## Status

Accepted

## Context

A run needs an isolated filesystem to act in: a working tree on its own branch, where the agent
reads code, makes changes, and produces the diff that becomes a `PR`. Several runs execute
concurrently on one host (ADR-003), so this decision picks the primitive that materializes a per-run
working tree from the host repository.

Two facts about the surrounding model constrain the choice. The repository lives on the host
(ADR-003): the control plane reads it for intake and display, execution materializes per-run working
trees from it, and only Autocatalyst performs git operations against it as a single writer. The
workspace is re-creatable rather than the source of truth (ADR-004): a run's durable truth is its
branch plus its checkpointed results, so the working tree can be reconstructed from them.

The primitive must give each concurrent run isolation; keep the run's branch and committed
checkpoints durable independently of the working tree; let the control plane preview the run's diff
without the working tree present (ADR-003); and make creation and teardown cheap at run cadence.

## Decision

**A per-run workspace is a git worktree of the host repository, on a run-owned branch. A clone from
`repo_url` is the materialization variant for execution workers that do not share the host
filesystem.**

- A worktree shares the host repository's object store and ref namespace; the run's branch ref lives
  in the host repository.
- A run's commits land in the host repository's shared object store, so the branch and its
  checkpoints **persist after the worktree is removed**. The durable input that re-materialization
  (ADR-021) needs is already durable, with no separate push.
- The control plane computes a run's diff (`<default-branch>..<run-branch>`) directly from the host
  repository for any run, whether or not its workspace exists, which serves preview-over-the-API
  (ADR-003).
- The worktree inherits the host repository's history, so rebasing a run's branch onto an advanced
  default branch resolves locally.
- When execution is extracted to workers that do not share the host filesystem, a worktree cannot
  attach to a repository it cannot reach; materialization shifts to a clone from `repo_url`, with the
  branch pushed to a durable remote. This variant is taken with that extraction.

## Consequences

**Positive:**
- The branch and committed checkpoints are durable in the host repository without an extra step,
  which is what makes the re-creatable-workspace model (ADR-004) and re-materialization (ADR-021)
  work.
- A run's diff is previewable from the host repository over the API regardless of workspace state.
- Creation is a checkout from objects already present, with no per-run object transfer, and teardown
  leaves no duplicated object store to reclaim.
- Inherited history makes a local rebase onto an advanced default branch resolvable.

**Negative:**
- All worktrees share one object store and ref namespace, a weaker boundary than independent clones:
  a corrupt object or an ill-timed object-store compaction affects every worktree and the host
  repository. This is acceptable on a trusted single host; the stronger boundary is the sequenced
  container isolation (ADR-010).
- Removing a worktree directory out of band leaves administrative state in the host repository that
  the pruning step must clear (`git worktree prune`).
- The host repository's object store grows with each run's branch and needs periodic compaction.

## Alternatives considered

### A per-run clone

Each run gets an independent clone of the repository, shallow or full, under its own directory.

**Pros:**
- A strong filesystem boundary: each clone is self-contained and blast-isolated from the host
  repository and from other runs.
- The only model available when an execution worker does not share the host filesystem.

**Cons:**
- The branch and its commits live only inside the clone, so durability of the branch and a
  previewable diff require pushing the branch to a durable remote before teardown, an added step
  tied to every checkpoint.
- Creation copies objects per run: a shallow clone cannot hardlink the local object store, and a
  shallow history cannot compute the merge-base a local rebase needs; a full clone duplicates the
  object store outright.
- Teardown has a per-run object store to reclaim.

**Why not chosen:** On a co-located host the clone's one advantage over a worktree is a stronger
isolation boundary, and the sequenced container model (ADR-010) supplies that boundary anyway. The
costs the clone adds (branch durability as an explicit push, per-run object copies, shallow-history
rebase limits) are all things the worktree avoids. The clone is retained for the one case where its
advantage binds: execution on workers that do not share the host filesystem.

### A container per run

Each run executes in its own container, with the working tree inside it.

**Pros:**
- Strong isolation of filesystem and process, and with egress controls, network. Safe for untrusted
  or multi-tenant execution.

**Cons:**
- Heavy operational overhead on a trusted single host, for protection that only hosted or
  multi-tenant operation calls for.
- Orthogonal to how the working tree is materialized: inside a container the tree is still a worktree
  or a clone.

**Why not chosen:** Container isolation is the sequenced hardening of ADR-010, taken with
hosted or multi-tenant operation. It is the isolation *boundary*, not the materialization primitive,
and adopting it pays for protection a trusted host does not need. Inside a container that does not
share the host disk, materialization is a clone, the variant this decision already reserves.

### A shared workspace serialized by a lock

One working tree, reused across runs, guarded by a lock.

**Pros:**
- A single checkout to manage; no per-run materialization.

**Cons:**
- Serializes concurrent runs, or risks one run's changes overwriting another's.
- Defeats the per-run branch isolation the run model assumes: several runs are active at once, one
  per topic (`domain-model`).

**Why not chosen:** It trades away the isolation that is the whole purpose of a per-run workspace, to
save what a worktree already saves. A worktree shares the object store without sharing a working
tree, so concurrent runs stay isolated at no duplication cost.
