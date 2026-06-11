---
date: 2026-06-10
status: accepted
superseded_by: null
---
# model-routing-distinct-by-precedence
**Decision:** Table-defined `RoleDistinctRequirement.distinctBy` overrides caller-provided `distinctBy` in `resolveDistinctAgentRoutes`.
**Rationale:**
- Table is configuration-as-code; callers are runtime code.
- Configuration takes precedence to enable per-step overrides without changing call sites.
- Consistent with the principle that the routing table is the single source of truth for dispatch behavior.
**Constraints:** The override only applies when the table entry has an explicit `distinctBy`; absent table value leaves caller's `distinctBy` in effect.
**Rejected:** Caller-wins — was briefly coded this way and caught in review; reversed because it would prevent table-level per-step overrides.
