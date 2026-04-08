---
date: 2026-04-08
status: accepted
superseded_by: null
---

# State model

**Decision:** Layered state. In-memory orchestrator state with filesystem checkpoints for recovery. External state store (Postgres) for hosted deployments.

**Rationale:**
- In-memory state with filesystem recovery avoids database dependencies for local use (Symphony pattern)
- Layered separation prevents coupling: orchestrator state, workspace state, and loop state have different lifecycles
- Filesystem checkpoints enable crash recovery — on startup, reconcile by scanning active workspaces and polling tracker state
- Postgres is the natural upgrade path for hosted multi-instance deployments — structured, queryable, well-understood

**Layers:**
- **Orchestrator state** (in-memory, single-authority): running sessions, claimed ideas, retry queue, aggregate metrics. Only the orchestrator mutates this.
- **Workspace state** (filesystem): one directory per run, persisted across retries, cleaned on terminal states.
- **Loop state** (filesystem checkpoints → Postgres): per-run record of stage, spec content, approval history, implementation output, terminal reason. Required for resumability and observability.

**Constraints:**
- Single-authority orchestrator (app.md): only one component mutates scheduling state
- Must support crash recovery without losing in-progress run tracking
- No database required for local development
- Must scale to hosted deployment with multiple instances

**Rejected:**
- SQLite: adds a dependency without meaningful benefit over filesystem checkpoints for local use
- Redis: fast but volatile — not suitable as the durable state store; adds operational complexity
- Postgres from day one: unnecessary for local single-instance use; premature dependency
