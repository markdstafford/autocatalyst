---
date: 2026-04-25
status: accepted
superseded_by: null
---

# Handler registry orchestrator boundary

**Decision:** The orchestrator owns scheduling, classification gates, concurrency, queueing, run persistence, and transitions; route-specific pipeline work lives behind a `HandlerRegistry`.

**Rationale:**
- The orchestrator is the single authority for when work may start, whether duplicate approval should be discarded, and how active runs are persisted.
- Handler routes are explicit keys: event type, stage, and intent. This avoids hidden first-match ordering and makes extension points inspectable.
- Handler construction lives outside the orchestrator in default built-in wiring, keeping pipeline dependencies narrow and independently testable.
- New route behavior should be added by registering a handler, not by expanding orchestrator conditionals.

**Constraints:**
- Classification remains serial in the orchestrator to preserve duplicate-approval safety.
- Built-in handlers are static for now; dynamic plugin loading is out of scope.
- Handler code may transition runs only through the transition port it receives.

**Rejected:**
- Private orchestrator methods for every pipeline: simple initially, but it turned the orchestrator into the owner of every product behavior.
- First-match `canHandle()` handlers: flexible, but route priority becomes implicit and error-prone.
