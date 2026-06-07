---
created: 2026-06-06
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-028: Spec amendable through implementation

## Status

Accepted

## Context

The spec a run authors is approved at its gate and then built from. The spec is not always right going
into implementation: building can reveal a contradiction, where the change the implementation needs
conflicts with what the spec says.

A spec is a working document until the work ships. Approving it at the spec gate means "good enough to
build from," and the single durable freeze belongs at ship, not at that approval (cross-cutting #19,
ADR-017). A person approved the spec, so any change to it should be visible to that person; an amendment
cannot be a silent rewrite of the contract they signed off on. And a spec change made separately, before
the work that needs it, costs a round: gating the change on a prior, separate spec update means an extra
round-trip every time building reveals the spec needs to change.

This decision settles where the spec freezes, how an implementation-phase amendment is made and recorded,
and whether a person confirms it.

## Decision

**The spec gate approves the spec to build from and keeps it mutable; when implementation feedback
contradicts the spec, the implementer amends the spec in place and then makes the change; the amendment is
confirmed at the implementation gate; and the spec freezes at `pr.finalize`, durable once the PR merges.**

- **`spec.human_review` approves the spec to build from; it does not freeze it.** The spec stays a mutable
  working document through implementation.
- **The implementer amends the spec, then makes the change.** When implementation feedback requires
  something the spec contradicts, the implementer edits the spec file (committed) as part of addressing
  the feedback and then makes the code change. The committed history is the record; the reason is a
  response in the prompting feedback item's thread.
- **The amendment is confirmed at the implementation gate.** The person reviewing the build sees that the
  spec was amended and why, and confirms by approving or pushes back by reopening, which sends the run to
  revise. There is no route back through the spec gate, because nothing was frozen there.
- **The spec freezes at `pr.finalize`** (ADR-025). The freeze is re-applied on each pass that reaches
  `pr.finalize` and is durable once the PR merges and the run reaches `done`.
- **Coordinated with `spec-lifecycle`,** which owns the frozen-at-ship rule and the committed frontmatter
  the freeze writes.

## Consequences

**Positive:**
- Building can correct a spec it finds wrong without a separate up-front round, while the person stays in
  control at the implementation gate.
- The single freeze point is unambiguous — `pr.finalize`, durable at merge — and the spec's mutability
  through implementation is explicit.
- An amendment is a real committed edit with a recorded reason, so the spec's history shows how it changed.

**Negative:**
- A spec the person approved can change during implementation, so the implementation gate has to surface
  amendments clearly or one could pass unnoticed.
- Re-entering implementation after `pr.finalize` re-opens the spec for amendment, so the freeze holds per
  pass rather than once and for all before merge.

## Alternatives considered

### Freeze the spec at its gate

Treat spec approval as the freeze, and require a separate, explicit spec update before any contradicting
change during implementation.

**Pros:**
- The spec the person approved is fixed for the whole of implementation.

**Cons:**
- Building often reveals a spec is imperfect, so the run reverts the change and waits for a separate
  spec update, a round of friction every time.
- It treats the spec as more settled than it is at approval time.

**Why not chosen:** The spec is a working document until ship, so amend-and-proceed with confirmation at
the implementation gate removes the friction while keeping the person in control.

### Re-open the spec gate for every amendment

Route any implementation-phase amendment back through `spec.human_review` for re-approval before the build
continues.

**Pros:**
- Every spec change is re-approved at the same gate the spec was first approved at.

**Cons:**
- It reintroduces the revert-and-ask-first friction this decision removes, for a document that is still
  legitimately in flight.
- It blocks the build on a gate round for changes the implementation gate already surfaces.

**Why not chosen:** Nothing was frozen at the spec gate, so the amendment is confirmed where its effect is
seen — the implementation gate — rather than routed back to a gate it never left frozen.
