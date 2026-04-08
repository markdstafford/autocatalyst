---
date: 2026-04-08
status: accepted
superseded_by: null
---

# Workspace isolation

**Decision:** Filesystem directory per run, populated by git clone of the target repo. Default root: `~/.autocatalyst/workspaces/`.

**Rationale:**
- Each run gets a fully isolated copy of the target repo — no interference between concurrent runs
- Git clone (shallow, depth 1) is simple and portable — no git worktree management needed
- Workspace persists across retries for the same idea — avoids re-cloning on continuation
- Path containment enforced before agent launch: workspace path must be under workspace root (prefix validation)
- Cleanup happens on terminal states; startup reconciliation removes orphaned workspaces

**Lifecycle:**
1. Run starts → create workspace directory under root, shallow clone target repo
2. Agent executes within workspace directory exclusively
3. Run retries → reuse existing workspace (agent resumes from current state)
4. Run reaches terminal state → workspace cleaned up
5. Service startup → scan for orphaned workspaces, clean up

**Constraints:**
- Agents must not access paths outside their workspace
- Workspaces must survive retries (agent may have built artifacts, installed dependencies)
- Startup reconciliation must handle crash recovery (orphaned workspaces from prior crashes)
- Directory names sanitized: only alphanumeric, dots, hyphens, underscores

**Rejected:**
- Git worktrees: tighter coupling to git; shared object store can cause issues with concurrent writes
- Docker containers per run: heavyweight for local development; adds container orchestration dependency
- Shared workspace with locking: defeats the purpose of isolation; concurrent runs interfere
