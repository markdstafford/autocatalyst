---
date: 2026-06-18
status: accepted
superseded_by: null
---
# PR reconciliation service result coupling
**Decision:** `ServiceReconcilePullRequestsResult` aliases the sanitized `ReconcilePullRequestsResponse` API wire type for B1.
**Rationale:**
- The explicit endpoint and background ticker both need the same bounded count summary already returned by orchestrator merge detection.
- No internal-only reconciliation fields are needed for B1.
- Reusing the shared strict schema reduces translation code and keeps client-visible counts aligned with `detectPullRequestMerges` semantics.
**Constraints:**
- Routes and ticker must not expose provider coordinates, raw provider output, secrets, or tenant ids supplied by callers.
- The orchestrator and `pr-lifecycle.ts` remain the state-transition authority.
- The service result can diverge later if operators need internal-only fields.
**Rejected:** Separate service DTO with identical fields — rejected because it adds mapping boilerplate without a B1 consumer or safety benefit.
