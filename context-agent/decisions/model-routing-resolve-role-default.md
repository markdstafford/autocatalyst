---
date: 2026-06-10
status: accepted
superseded_by: null
---
# model-routing-resolve-role-default
**Decision:** In `createControlPlaneServer`, the `resolveRole` seam passed to `createDelegatingExecutionEntryPoint` defaults every step to `'implementer'`.
**Rationale:**
- Per-step role catalog does not yet exist in the codebase.
- Using `'implementer'` as universal default enables routing to work end-to-end today without breaking existing runs.
- Keeps the seam explicit so a real per-step resolver can be substituted later without changing call sites.
**Constraints:**
- Role-distinct routing (`resolveDistinctAgentRoutes`) is unreachable via the wired server path until the per-step role catalog is wired in.
- This is a known limitation to be tracked; do not mistake absence of role-distinct dispatch in integration tests for a routing bug.
**Rejected:** Hard-coding `'implementer'` at the call site without a seam — would require deeper surgery to replace later.
