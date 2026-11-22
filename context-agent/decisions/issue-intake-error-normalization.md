---
date: 2026-11-21
status: accepted
superseded_by: null
---
# Issue intake error normalization

**Decision:** Keep tracker failures internal until the control-plane service maps them to the shared lookup and conversation intake error contract.

**Rationale:**
- Resolver and adapter failures for the same cause share one public code. Only typed adapter failures include `trackerCode`.
- The resolver captures the configured provider, repository and requested number at read time. The service copies those trusted values only when the adapter supplies matching fields.

**Constraints:** Lookup maps only a typed `issue_not_found` to a resource-scoped 404; start preserves the existing 400 and message. No adapter message, credential reference, cause, or raw output crosses the boundary.

**Rejected:** Forward adapter `safeDetails` — the name does not guarantee that the contents are safe or match the request.
