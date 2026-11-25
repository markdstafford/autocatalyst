---
date: 2026-11-24
status: accepted
superseded_by: null
---
# Private spec activity projection

**Decision:** Publish content-free assistant, tool, and progress events for private spec roles from the existing runner event consumer.

**Rationale:**
- The event stream must expose live activity during spec authoring, including in fake mode.
- The former blanket filter also suppressed the scripted prelude and delay ticks, but raw role output can contain unpublished candidate text and scratch details.

**Constraints:** Preserve the event type, timestamp and safe progress counts; replace free-form text and tool fields with fixed labels. Keep private checkpoints, notifications, and terminal result bytes out of the stream. No fake-mode branch or direct publication in the fake adapter.

**Rejected:** Publish raw private role events — violates artifact custody. Bypass the runner consumer just for fake mode — tests would no longer verify the production publication path.
