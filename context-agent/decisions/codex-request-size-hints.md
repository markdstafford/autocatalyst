---
date: 2026-11-23
status: accepted
superseded_by: null
---
# Codex request-size hints
**Decision:** Use only a separate owned delta matched to a single request as a size hint for an unsized Codex group.
**Rationale:**
- App-server 0.160.1 does not supply a request ID on `last` to establish its scope when the counters do not match the delta.
- Spec fixture 4 lists band 0 with `nearest_sample`, but size 120 under the general pricing rule selects band 101. Excluding the unverified hint preserves band 0 and 468000 and reports the actual method, `lowest_feasible`.
**Constraints:** Keep cumulative counts once; proven ceilings still bound band estimates independently of hints.
**Rejected:** Letting an unmatched `last` estimate its own delta, or changing the band clamp — neither preserves both fixture 4's amount and fixture 5's separate-sample behavior.
