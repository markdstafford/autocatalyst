---
date: 2026-11-25
status: accepted
superseded_by: null
---
# Subscription provider dispatch

**Decision:** Use separate Codex Business and Claude subscription adapter IDs for host sign-in.
**Rationale:** An explicit adapter keeps each profile's authentication and billing mode visible. Both routing resolution and configuration validation honor external authentication for the matching composed adapter. The Claude SDK requires an object-root reviewer transport schema, so canonical validation checks the branch rules after capture.
**Constraints:** Reject API credential handles and gateway overrides for subscription profiles. Keep the existing Codex Enterprise plan check and version pin. Pass explicit Claude effort through to the SDK and use the host CLI for subscription sessions.
**Rejected:** Reusing API or Enterprise adapter IDs for subscription sign-in, which would change authentication requirements for existing profiles.
