---
date: 2026-10-27
status: accepted
superseded_by: null
---
# Provider model memory in scratch
**Decision:** Cache optional provider conversation continuity in per-run scratch files through the shared `AgentModelMemoryStore` interface.
**Rationale:**
- Continuity tokens are execution machinery; validated review results remain durable database records.
- Mixing provider memory into strict convergence checkpoints failed round-2 review in run `run_6e8cc3e9-55ed-4979-9d51-8eeb923bd2e3` (issue #123).
- Missing or invalid cache data starts fresh; cache I/O and diagnostic failures must not discard completed model work.
**Constraints:** Bind in the shared agent orchestrator after materialization and profile resolution. Isolate by run, role, provider, adapter, and profile; hash the tuple for filenames; write atomically with owner-only permissions. Scratch recreation resets continuity. No database migration or fallback to old checkpoint memory. Provider-specific resume support remains adapter-owned. Explicitly injected stores retain their existing semantics.
**Rejected:**
- Widening the convergence schema to accept provider memory — keeps disposable machinery in the durable review record and couples independent writers.
- A dedicated database table — unnecessary durability for optional continuity, given fresh-context recovery.
