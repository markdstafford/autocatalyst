---
date: 2026-11-27
status: accepted
superseded_by: null
---
# Pull request mutation lock
**Decision:** Serialize per-run PR commits, directives, operator lifecycle actions, dispatch reservations, and the failed-only recovery reopen in `DefaultOrchestrator` with an in-process tenant/run lock independent of the dispatch queue.
**Rationale:**
- Refresh must run when all runner slots are occupied.
- PR and run writes are separate. Holding the lock across both stops refresh from treating a batch transition in progress as an interrupted one.
- Releasing the lock for provider I/O keeps a slow read from blocking cancel or revise; the PR ID and gate occurrence detect stale observations when it returns.
**Constraints:**
- Do not acquire the lock again from a PR commit. Use the lock-held directive path. Leave host reads and recovery workspace preparation outside the lock.
- Reserve the open source occurrence under the lock. Enqueue and execute outside it. Keep occupancy until the job ends or passes directly to an eligible automatic continuation.
- A dispatch rechecks its reserved occurrence under the lock before committing effects. Ordinary results commit their local effects and directive in one lock section; convergence takes the lock per durable write or batch, including canonical spec completion. Sessions and session telemetry remain outside these sections.
- Storage independently guards the expected source step, the expected open occurrence for dispatch writes, and the unarchived failed state for recovery. Cancel retries only a source-step mismatch. This is not a distributed lock.
**Rejected:** `RunDispatchQueue.enqueueForRun` — it consumes a runner slot and waits behind unrelated work.
