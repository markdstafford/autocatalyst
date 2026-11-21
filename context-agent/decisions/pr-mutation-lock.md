---
date: 2026-11-21
status: accepted
superseded_by: null
---
# Pull request mutation lock
**Decision:** Serialize per-run PR commits, directives, and the failed-only recovery reopen in `DefaultOrchestrator` with an in-process tenant/run lock independent of the dispatch queue.
**Rationale:**
- Refresh must run when all runner slots are occupied.
- PR and run writes are separate. Holding the lock across both stops refresh from treating a batch transition in progress as an interrupted one.
- Releasing the lock for provider I/O keeps a slow read from blocking cancel or revise; the PR ID and gate occurrence detect stale observations when it returns.
**Constraints:** Do not acquire the lock again from a PR commit. Use the lock-held directive path and leave host reads, workspace preparation for recovery, and dispatch admission outside the lock. This is not a distributed lock.
**Rejected:** `RunDispatchQueue.enqueueForRun` — it consumes a runner slot and waits behind unrelated work.
