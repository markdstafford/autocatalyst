---
date: 2026-11-22
status: accepted
superseded_by: null
---
# Reviewed spec artifact custody
**Decision:** Keep candidate bytes in contained scratch and have the layered spec strategy complete only digest-verified, independently reviewed bytes; durably record private resume state beside a public checkpoint audit.
**Rationale:**
- The canonical file and gate do not exist until a reviewed draft is selected; result capture and feedback intake cannot depend on either.
- Pending candidates survive a role question; a missing candidate needs a replacement review, not a guessed verdict.
- HEAD is the commit recovery marker. The selected checkpoint, stable IDs, and status CAS prevent duplicate commits, findings, and disposition entries.
**Constraints:** Keep build and issue-canonical behavior unchanged; do not expose raw quotes or scratch paths in audit or telemetry. Approval stays human and uses the normal feedback predicate.
**Rejected:** Commit every candidate — exposes intermediate unapproved work, complicates retries, and produces irrelevant commits.
