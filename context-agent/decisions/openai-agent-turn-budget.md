---
date: 2026-10-21
status: accepted
superseded_by: null
---
# OpenAI agent turn budget
**Decision:** Every OpenAI SDK agent session has an explicit maximum of 250 turns and fails terminally when that budget is exhausted.
**Rationale:**
- The SDK default of ten turns interrupts ordinary repository reviews before their verdict.
- 250 retains a finite per-session bound while covering the validated review workload and matching the earlier runtime allowance.
- A real-SDK mocked-HTTP regression covers completion on turn eleven and exhaustion at 250, with no automatic session restart.
**Constraints:** This bounds turns rather than dollars or elapsed time. Exhaustion logs the static SDK error class and configured limit without raw error text, model state, prompts, or credentials. Existing transport retry policy is separate; the adapter never retries a whole paid session.
**Rejected:** Unbounded sessions — uncontrolled resource use; SDK default — demonstrated review interruption; automatic restart — duplicate paid work and lost failure evidence.
