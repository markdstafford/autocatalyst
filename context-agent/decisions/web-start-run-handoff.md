---
date: 2026-11-22
status: accepted
superseded_by: null
---
# Web start-run handoff

**Decision:** Give the create response row to the Runs collection once, in memory, after retiring the source list request generation.

**Rationale:**
- React Router navigation and render may commit separately. An in-flight source list must not replace the destination address in the meantime.
- The destination starts with the returned row and reads immediately. Keep the row until a list response includes its id, then follow normal server ordering and the existing freshness rule.

**Constraints:** No history state or browser storage for the handoff. Authorization and lookup generation are separate: stale issue results are ignored, but any active-client bearer 401 still updates the connection. The #141 lookup contract distinguishes adapter `trackerCode` from resolver-only `{ code }`. Only the two strict resolver setup variants (missing tracker or credential) share the corresponding adapter recovery; unknown envelopes remain retryable and no message is displayed from them.

**Rejected:** Wait for polling — it cannot reveal the created row immediately or repair a mismatched filter.
