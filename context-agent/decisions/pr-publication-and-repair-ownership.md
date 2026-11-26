---
date: 2026-11-25
status: accepted
superseded_by: null
---
# PR publication and repair ownership
**Decision:** Keep initial publication attestation in step occurrences, and fence existing-PR repairs with SQLite occurrence/epoch comparisons and an expected-old-head Git push.
**Rationale:**
- A reviewed tree and a verified push receipt prove different things; neither a provider head nor publish intent establishes host provenance.
- Repairs can survive retries and restarts without replaying a claimed segment or reusing its original gate.
- A writer of unknown status holds only that run's workspace; terminal PR observations remain independent.
**Constraints:** Git, GitHub and SQLite cannot share a transaction. Use exact identities and repeated reads, and fail closed on unknown result or ownership.
**Rejected:** Automatically relaunching a stale claim — it can compete with a previously started writer or resend a push.
