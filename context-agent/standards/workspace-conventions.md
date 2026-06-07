---
date: 2026-06-06
status: accepted
---
# Workspace and git-worktree conventions

The home for the workspace design is `context-human/concepts/workspace.md` (ADR-020, ADR-021); this
records the operational rules an implementer must follow when touching workspace code.

## Layout and naming
- **Per-run path:** `<workspaces_root>/<org>/<repo>/<run-id>/{repo,scratch}`. The host repo is at
  `<repos_root>/<org>/<repo>`. Roots come from DB config (never files); a `Project` may override its
  workspace root. Namespace by `org/repo` — never a bare repo name (cross-org collisions).
- **Branch name:** `<kind>/<topic-slug>-<short-run-id>`, `<kind>` ∈ `feature|bug|chore|enhancement`.
  One branch per run.
- **Repo root holds only what is committed; scratch root holds only ephemeral machinery.** Never write
  run machinery into the repo root; never treat scratch as a home of record. The validated result is
  persisted to the DB by the runner — scratch is discardable.
- **Scratch is flat.** No mandated sub-folders. Per-step results are files named
  `{run-id}_{step-id}.json`; everything else is free space.

## Git discipline
- **Materialize with a worktree**, not a clone, in the co-located default: `git worktree add <path>
  <base>` on the run branch. Clone-from-`repo_url` only for non-co-located execution workers.
- **Teardown is git-aware.** Remove a worktree with `git worktree remove` (and `git worktree prune` for
  out-of-band removals) — never `rm -rf` a worktree, which orphans `.git/worktrees/` admin state.
  Worktree removal keeps the branch ref.
- **Host repo is a full clone**, fetched from upstream before a run's branch is cut from the default.
- The host repo's object store grows with run branches — run `git gc` on it periodically (distinct from
  workspace garbage collection).
- **Commit messages follow `commit-and-title-conventions.md`** — the same `type: subject` form whose
  `type` derives from the run's work kind, so a commit message, a PR title, and an issue title share one
  derivation rather than each surface re-implementing it.

## Safety
- **Every deletion routes through the prune primitive:** containment guard against the *resolved* root →
  stat-before-remove → typed result (`deleted|missing|skipped|rejected|failed`) → structured log. No
  direct deletes.
- **Containment guards take the resolved root as a parameter** — never assume a single global root.
- A workspace is **created and torn down as a unit** keyed to the `Run`; roll the whole run-id directory
  back on any creation failure.

## Retention (per terminal state, two axes)
- `done` (= merged): destroy worktree, delete branch.
- `canceled`: commit the uncommitted tail to the branch, then destroy worktree; retain branch (branch TTL).
- `failed`: retain worktree (worktree TTL) and branch (branch TTL).
- Throwaway issue-filing: destroy scratch after filing.
- `branch TTL ≥ worktree TTL`; the scheduled workspace GC enforces both and reclaims crash orphans.

## Recovery
- **Never drop a non-terminal run for a missing workspace** — re-materialize it (`git worktree add` from
  the run branch for resume, or the fresh default for start-over) + a fresh empty scratch; the next
  step's inputs come from the DB, not old scratch.
