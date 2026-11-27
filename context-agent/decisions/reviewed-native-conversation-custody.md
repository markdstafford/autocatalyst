---
date: 2026-11-27
status: accepted
superseded_by: null
---
# Reviewed native conversation custody
**Decision:** A role's native handle is an internal, workspace-generation-fenced pointer; the release allowlist stays empty until exact production confinement, writer exit evidence, and native recall are verified.
**Rationale:**
- The run branch and validated evidence recover work independently of provider history.
- Native output and cumulative usage cannot establish current-turn work.
- A private directory and environment override alone do not separate same-host tool access from native writes.
**Constraints:** Only proven pre-execution refusal permits a replay. A runner launch, not a conversation, owns usage. Unknown writer state must not authorize deletion.
**Rejected:** Retaining native history in scratch, reading ancient checkpoints as handles, or enabling retention on adapter name or version string alone.
