---
date: 2026-11-27
status: accepted
superseded_by: null
---
# Dispatch cancellation

**Decision:** The orchestrator owns one abort controller on each admitted tenant/run reservation and signals it after the guarded cancel commit, without waiting for provider shutdown.

**Rationale:**
- The run store stays authoritative. The occurrence guard discards late workflow effects even when the provider cannot stop.
- The execution boundary races reads and shutdown against abort. It records only a started session, with locally observed end time and available usage.
- Finishing a dispatch does not prove that a provider writer drained. Retire reviewed attempt custody without accepting its result; keep a repair's workspace hold when a session may still be writing.

**Constraints:** Queued work has no controller until its source occurrence passes admission. Cancellation is an internal discard outcome, not a fail directive or new public event.

**Rejected:** Waiting for provider acknowledgement — an uncooperative provider would retain the queue slot.
