---
date: 2026-11-28
status: accepted
superseded_by: null
---
# Testing guide pass commits

**Decision:** Pass a private decision payload from the locked reply handler to the occurrence-checked SQLite transition.

**Rationale:**
- One synchronous transaction can insert feedback, persist each failed-check link, finalize the pass, and move the run before event publication or dispatch.
- The same commit owns draft deletion on any undecided review exit, including a same-step exit.

**Constraints:** SQLite transaction callbacks are synchronous. Keep authoring, outcome, and carry rules in core; the repository validates the occurrence and revision before writing.

**Rejected:** Async repository calls in a transaction callback — they can outlive the SQLite transaction. A guide revision as the pass key — later occurrences can reuse it.
