---
date: 2026-04-25
status: accepted
superseded_by: null
---

# Domain kernel artifacts

**Decision:** The core owns run lifecycle, scheduler state, deduplication, and artifact policy; specs, bug triage, and chore plans are one `Artifact` model with policy-driven lifecycle differences.

**Rationale:**
- Feature specs, bug triage, and chore plans all follow the same review loop: create artifact, publish artifact, accept feedback, approve artifact, then apply lifecycle policy.
- Lifecycle policy is the real difference: feature specs commit before implementation; bug and chore artifacts sync to an issue and are not committed.
- A single artifact pipeline keeps handlers testable and prevents parallel spec/bug/chore flows from drifting.
- The core remains a domain kernel, not a generic workflow engine: it understands runs, artifacts, stages, and artifact policies.

**Constraints:**
- Persisted runs use `artifact` as the canonical artifact state. Legacy `review_artifact`, `spec_path`, and `publisher_ref` fields are accepted only as load-time migration shims.
- Runtime code should read typed `artifact` refs only.
- `context-human/` remains human-owned; agents do not alter human specs without explicit approval.

**Rejected:**
- Separate `Spec`, `BugTriage`, and `ChorePlan` pipelines: duplicates lifecycle and feedback behavior while making policy differences harder to reason about.
- A generic workflow DAG: too abstract for the current product and weakens the agent-first domain vocabulary.
