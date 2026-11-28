---
date: 2026-11-27
status: accepted
superseded_by: null
---
# Web run action lifetime
**Decision:** Use the list's client/collection identity for data writes, and a separate operator-selection revision and action ticket for UI completions.
**Rationale:**
- A late result can update its own row without replacing another run's editor, dialog, or outcome.
- Automatic reselection does not revoke Archive's outcome or retarget Undo.
- A mutation response retires in-flight cursor reads and fences detail snapshots. Later reads can reconcile title and archive fields even when the lifecycle timestamp is unchanged.
**Constraints:** The list remains the source of displayed run state. Frames invalidate reads; their payloads never replace runs.
**Rejected:** Compare timestamps alone — topic title and archive membership can change without a new `updatedAt`.
