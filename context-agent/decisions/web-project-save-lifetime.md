---
date: 2026-11-22
status: accepted
superseded_by: null
---
# Web project save lifetime

**Decision:** Keep credential drafts and staged uploads in one editor session; publish only the saved project response into a directory scoped to the active SDK client.

**Rationale:**
- Two API calls cannot make uploading and attaching a credential atomic. Retry unchanged inputs with their confirmed handles rather than creating duplicates.
- Changing a credential, changing its provider, or a field-specific 422 invalidates that section's staged handle. Cancel and route or client changes discard the draft and all staged handles.
- A successful mutation updates sidebar names and Settings immediately. Reconciliation invalidates reads started before the write and keeps the published record if refresh fails.

**Constraints:** No browser persistence, provider checks, or automatic retries. A successful upload can remain unreferenced if its project write fails or is abandoned.

**Rejected:** Shared draft or stored credential cache — increases exposure and can carry credentials between projects or clients.
