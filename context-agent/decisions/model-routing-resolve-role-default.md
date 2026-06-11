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
- Role-distinct routing (`resolveDistinctAgentRoutes`) is unreachable via the server's `createDelegatingExecutionEntryPoint` path until the per-step role catalog is wired in (#9 convergence loop).
- The routing substrate IS proven end-to-end: integration tests in `model-routing.integration.spec.ts` ("dispatch through createAgentRunnerFactory + consumeRunnerEvents") wire routing through `createAgentRunnerFactory` with explicit roles and `consumeRunnerEvents`, confirming implementer→Claude and reviewer→OpenAI dispatch through the production factory path.
- The gap is that the server's high-level entry point supplies `'implementer'` to the factory for all steps; this seam is where #9 will plug in the real per-step role.
- `resolveAgentRoute` now guards against silent bypass: if the active table has a `RoleDistinctRequirement` for the step, the single-role path throws `role_distinct_unsatisfied` directing the caller to use `resolveDistinctAgentRoutes`. This guard fires whether the caller is a production path or a test — any step with a table-defined requirement must go through group resolution.
**Rejected:** Hard-coding `'implementer'` at the call site without a seam — would require deeper surgery to replace later.
