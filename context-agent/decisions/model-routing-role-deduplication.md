---
date: 2026-06-10
status: accepted
superseded_by: null
---
# model-routing-role-deduplication
**Decision:** Deduplicate `input.roles` with `new Set(...)` before running distinct collision detection in `resolveDistinctAgentRoutes`.
**Rationale:**
- Duplicate roles are not semantically meaningful — asking for the same role twice does not imply two separate assignments.
- Without deduplication, the second occurrence of a duplicate role falsely triggers `role_distinct_unsatisfied` collision detection, making valid inputs appear invalid.
**Constraints:** Deduplication happens inside `resolveDistinctAgentRoutes` only, not at schema level — callers may still pass duplicates and they are silently collapsed.
**Rejected:** Schema-level deduplication (too early in the pipeline; would break callers that rely on passing repeated roles from structured inputs without pre-processing).
