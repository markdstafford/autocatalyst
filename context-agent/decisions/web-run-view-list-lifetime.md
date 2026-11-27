---
date: 2026-11-27
status: accepted
superseded_by: null
---
# Run view list read lifetime
**Decision:** Scope raw rows, cursor, and loaded page depth by SDK client and effective request; scope in-flight results by active view as well.
**Rationale:**
- Switching compatible views keeps later-page selection while refreshing.
- Only a current read can reconcile rows, replace the run address, or report connection state.
**Constraints:** Keep the existing SDK and HTTP endpoint. The provider defers collection GET 401s to the list hook's generation guard; other calls retain provider-level 401 handling.
**Rejected:** Include view id in the raw row scope — discards compatible pages and later-page selection. Observe list 401s in the generic fetch wrapper — a response from a retired view could navigate to Connection.
