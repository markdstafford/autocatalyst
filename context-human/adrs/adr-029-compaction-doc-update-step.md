---
created: 2026-06-06
last_updated: 2026-06-07
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-029: Compaction and doc-update step with a human doc-diff gate

## Status

Accepted

## Context

The durable docs that describe the system are its source of truth: the living concept docs, the ADRs, and
the central `spec.md` overview. A run changes the system, so unless something refreshes those docs against
what the code now does, they drift out of date.

Where to refresh those docs, and how, runs into a few constraints. Docs that are not refreshed as part of
the work rot: doing it as a separate later chore loses the context of the change that motivated the update
and lets the gap between docs and code grow. The human-owned docs carry a human decision — concept docs,
ADRs, and `spec.md` live in `context-human/`, and an edit to them needs a person's approval rather than a
silent agent rewrite. The agent-owned context is the agent's to maintain: the `context-agent` wiki, code
map, decisions, and standards are its working context and do not need a human gate to change. And a small
change should not pay for heavy doc machinery, where a one-line fix that touches no concept stalls behind a
doc review with nothing to review.

This ADR decides where doc-refresh happens in a run, how human-owned doc edits are approved, and how
agent-owned context updates flow.

## Decision

**A `docs` phase runs between the implementation phase and the PR phase. Its `docs.update` step invokes
compaction to refresh the durable docs bottom-up; a `docs.human_review` gate approves the human-owned doc
changes and advances without pausing when there are none; the doc changes land on the same branch as the
code.**

- **The `docs` phase sits after `implementation.human_review` and before `pr.finalize`,** mirroring the
  phase-then-gate shape of the spec, implementation, and pr phases.
- **`docs.update` (an AI step) invokes the micromanager compaction skill.** Compaction works bottom-up
  through the disclosure layers: it reads the frozen specs and the implementation the run produced to
  refresh the living concept docs and ADRs, then rolls the concepts up into the bounded central `spec.md`.
  It proposes the human-owned changes (concept docs, ADRs, `spec.md`) as a **`DocDiffProposal`** — the
  validated result of the step, carrying the human-owned doc changes and surfaced for review as a
  `Publication` (`domain-model`) — and applies the agent-owned context updates (`context-agent` wiki,
  code map, decisions, standards) directly.
- **`docs.human_review` (a gate) approves the `DocDiffProposal`** or sends it back to revise, with any
  `docs`-target feedback dispositioned (`feedback`). Its precondition is that the proposed human-owned
  changes are approved. When the `DocDiffProposal` carries no human-owned change — a small change that
  moves no concept, or only `context-agent` updates — there is nothing to review, so the gate advances
  without pausing. This skip is specific to the docs gate and its empty diff object, not a general rule
  that any gate auto-passes with no open feedback (`hitl`). A reviewer who believes docs should have
  changed but did not can still raise it at `pr.human_review`, where the whole change is in front of them.
- **The doc updates land on the same branch as the code.** `pr.finalize` then freezes the spec and
  summarizes the cumulative change, which now includes the doc updates.
- **Compaction's depth is proportional to the change** and configurable in the same way as implementation
  depth (ADR-025) and convergence depth (ADR-026). The docs phase composes into the workflows that carry
  an implementation and a pr phase — `feature`, `enhancement`, `bug`, `chore` — not onto `question` or
  `file_issue`, which produce nothing to compact. "Run-always" means **no per-feature opt-out within
  those workflows**, not a phase forced onto every run: the default runs the step on every run of a
  build-bearing workflow, scoped to the change, so a small change yields little or no diff and a quiet
  gate.
- **The compaction method stays a micromanager skill the step invokes** (`mm-integration`). Autocatalyst
  owns the step, the gate, and where the diffs go; the method of refreshing docs belongs to the skill.

## Consequences

**Positive:**
- Docs refresh as part of the work, while the context of the change is still present.
- A person keeps control of the human-owned docs through a real gate, and that gate's authority is distinct
  from approving the code.
- The agent maintains its own `context-agent` context directly, without a gate.
- The skip-when-empty rule keeps a small change friction-free — the phase is a near no-op when there is
  nothing to compact.
- Docs and code ship together in one pull request, and the PR summary covers both.

**Negative:**
- Every build-bearing run carries a phase and a gate it may not need on a small change, relying on the
  skip to stay cheap.
- The compaction skill is a composite of narrower skills today, so the single method the step depends on is
  not fully built yet and is carried as a dependency on micromanager.
- A doc-heavy change adds a human gate the team has to staff.

## Alternatives considered

### Fold the doc diffs into the existing PR gate

Run compaction but route the doc changes into the pull request and let a person approve them as part of the
normal `pr.human_review`, with no dedicated docs phase or gate.

**Pros:**
- Fewer gates; one less stop in the loop.
- The person sees the doc changes in the PR diff anyway.

**Cons:**
- It blurs approving edits to the human-owned docs into approving the code, so a deliberate authority
  decision becomes an implicit one.
- It loses the phase-then-gate symmetry the rest of the lifecycle has.

**Why not chosen:** Editing the human-owned docs is its own authority decision and deserves its own moment;
the skip-when-empty rule already removes the cost of the gate for changes that touch no human-owned doc.

### Refresh docs in a separate later pass

Leave the run lean and refresh the docs in a standalone pass — a scheduled job or a maintenance run — rather
than inside the run that changed the system.

**Pros:**
- The run stays focused on the code change.
- Doc work can be batched across many changes.

**Cons:**
- The pass runs without the context of the change that motivated it.
- Docs rot between passes, and one change is split across two units of work.

**Why not chosen:** The value is refreshing the docs while the change's context is present. A standalone
whole-corpus pass is a separate capability, taken up when a repo-health workflow exists, not a replacement
for in-run compaction.
