---
date: 2026-11-21
status: accepted
superseded_by: null
---
# Web pull request check selection lifetime
**Decision:** Keep selection reads and pull request check coordination in the Runs route, and open the event stream only while the pane is visible.
**Rationale:**
- Hiding the pane or reconnecting the stream must not consume or re-arm another automatic check.
- A new selection owns its own request state even when the selected run ID was previously visited.
**Constraints:** Run updates still pass through the list's stale-row protection; a successful check supersedes earlier in-flight PR reads.
**Rejected:** Tie the automatic check to the pane or stream mount — either can happen multiple times for the same selection.
