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

The control plane borrows an existing trusted host supervisor through an executable bridge. A writer identity is reserved before changing the scope owner, used for one native launch, then sealed against delayed launches. Only a matching, restart-stable receipt for the sealed writer and its descendant group releases its home or scopes. An adapter's completion callback, bridge process exit, and PID disappearance are not such receipts. Deployments without this authority run without disk-backed continuity. The in-process alternative reuses ephemeral provider sessions with a verified workspace and compatible route, guarded by an exclusive run/step/role lease. No handle is published to SQLite by this path. It expires on server shutdown and uses the normal fresh handoff the next time the role runs.


# Live lease lifecycle (#212)

**Decision:** Bind the provisional spec lease after host candidate acceptance; bind a compatible build lease to the first host-verified repair. Retire live leases at terminal or workspace-instance changes, or under bounded idle retention.

**Rationale:** A result envelope, human-gate delay, and newly observed PR are not by themselves changes to the work or the authorized provider role. Scope and PR binding are separate; turn submission and accounting are attempt-specific.

**Constraints:** Fresh final review, unchanged tool policy, verified workspace/generation and occurrence ownership, no retry after possible prompt submission, no durable native handle or provider identity in operational logs.

**Rejected:** Hashing PR identity into the stable key (prevents first adoption); binding a user/model path without core acceptance; recording cumulative Claude totals for a reused query; deleting native transcripts based on an in-process lease. This does not qualify disk-backed continuity.
