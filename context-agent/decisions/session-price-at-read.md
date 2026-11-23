---
date: 2026-11-23
status: accepted
superseded_by: null
---
# Session price at read
**Decision:** Price disjoint usage in core from a consistent SQLite snapshot of ordered sessions and relevant rate revisions.
**Rationale:**
- The same snapshot serves the sessions and logical rollups.
- Backdated rates and immutable revision history require no evidence rewrite.
**Constraints:** Providers interpret counters; runners only carry evidence; clients only format amounts.
**Rejected:** Per-session frozen prices or browser sums — inconsistent under rate correction and partial coverage.
