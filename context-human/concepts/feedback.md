---
created: 2026-06-06
last_updated: 2026-06-07
status: active
roadmap: flow
---

# Feedback

The loop that turns review into change: how a `Feedback` item comes into being, who may move it
through its dispositions, when open feedback holds a run at a gate, how a single revise pass addresses
a whole target's items, how an implementation amends the spec it was built from, and the contract check
that keeps a resolution honest. This concept owns the *behavior* around feedback. The `Feedback` record
shape — its anchor, target, embedded thread, and the `open -> addressed -> resolved | wont_fix` lifecycle
— belongs to `domain-model` and ADR-018; the convergence loop between the implementer and reviewer belongs to `review`;
the human gates as a pause-and-resume mechanism belong to `hitl`. This concept is what happens to a
feedback item between those parts.

## One item type, attributed to principals

A single `Feedback` item covers both a person's comment and a model reviewer's finding. Both are the
same record, distinguished only by who authored them. Attribution is uniform: the item, and every
comment in its thread, is authored by a `Principal`. A model reviewer's critique becomes a tracked
`Feedback` item the same way a person's comment does.

To make a model's finding attributable like any other, a model is a `Principal`. A principal carries a
`kind` — `human`, `model`, or `system` — and a model principal's identity is the resolved
provider-and-model it ran as. A model principal is an author only: not an owner, not an
authorization subject, and not tenant-scoped the way a person is, because the same model serves every
tenant. Owner, authorization, and tenancy semantics stay with human and system principals. (The
`Principal` entity, its `kind` discriminator, and a model standing as a principal are owned by
`domain-model` and ADR-009 — this concept depends on that shape and does not define it.)

Because authorship already carries the `kind`, there is no separate field recording whether an item came
from a person or a reviewer. Human-versus-reviewer is read from the authoring principal's `kind`, and the
difference in how the two are handled follows from where the item sits rather than from a flag on the
item. A finding raised inside a convergence step is disposed by the implementer in that loop, while an
item standing at a human-review gate holds the gate until the person acts.

## How feedback is created

Feedback is created natively, at the place it is raised, with no extraction step in between. In the app,
a person reads the work under review, anchors a comment on a region of it, and that comment is written
as a `Feedback` row. The model reviewer writes its findings directly as rows during a convergence step.
In both paths the row exists from the moment the feedback is raised; nothing has to be recovered from a
surface afterward.

The item's anchor records which region of the spec, which part of the implementation, which proposed
doc change, or which part of the pull request it concerns; the target (`artifact`, `implementation`,
`docs`, or `pr`) records which gate review it belongs to — one target per gate that accepts feedback
(`domain-model`). A person's anchored comment carries the region they selected; a reviewer's finding
carries the part of the change it points at. An item with no region is target-level: it concerns the
whole work under that review rather than a specific place in it.

## Disposition authority

A feedback item moves through its lifecycle under a fixed division of authority, so that no actor can
close out work that is not done without a recorded action.

- The implementer can move an `open` item to `addressed` or to `wont_fix`. Either transition requires a
  written response in the item's thread; no state change is silent. `addressed` means the
  implementer believes the item is handled and is awaiting confirmation; `wont_fix` is a deliberate,
  recorded decision not to make the change, with the reason in the thread.
- Only the principal who raised an item can move it from `addressed` to `resolved`. The originator
  accepts the fix; another person cannot accept it on their behalf. At a single-reviewer scale this is
  one person, but the rule is what makes multi-reviewer sign-off work: each reviewer confirms their own
  items.
- A reviewer's finding is raised by a model principal, which never returns to confirm it, so the
  originator-confirms rule cannot resolve it. The system instead resolves a reviewer-originated
  `addressed` finding when its step advances: convergence is the implementer's acceptance, and the step
  advancing finalizes it. A finding the implementer set to `wont_fix` stays `wont_fix` and is
  visible at the following human gate, the final check on that decision.
- A `wont_fix` item is dispositioned but not final: the originator can reopen it back to `open`,
  which sends the run to revise. A reviewer's declined-and-`wont_fix` finding is not the end of
  the matter if the person who raised the underlying concern disagrees.

## Gating at a human-review gate

A human-review gate is a step a person actively passes; approval is never inferred from item state
alone. The person reviewing the work approves to advance the run. The work does not advance on its own
even when every item looks handled. This holds for `spec.human_review`, `implementation.human_review`,
and `pr.human_review` even with zero open feedback. The lone exception is `docs.human_review`, which
advances without a person when its `DocDiffProposal` carries no human-owned change — there is nothing to
review, which is not the same as inferring approval from an empty item set (`workflow`, ADR-029).

The precondition for advancing is that every item for that gate's target is `resolved` or `wont_fix`:
nothing `open`, and nothing still `addressed` and unconfirmed. The gate is per-target and every item must
be dispositioned (ADR-018), so a run cannot leave the gate, or reach `done`, while an item for that
review is still open or sitting unconfirmed in `addressed`.

Approving the gate confirms the approver's own `addressed` items, moving them to `resolved` in the same
action; the approval is the originator's acceptance of the items they raised. A model therefore cannot
carry a run past a gate by marking everything `wont_fix`: the person still has to approve, and before
approving can reopen any item they think was waved off rather than handled.

## Batch addressing and reviewer findings

A revise pass addresses all open items for the target in one cycle. When the run returns to its producing
step to revise, the implementer takes up every open item for that target together and moves each to
`addressed` with its thread response, not one item per round. A target whose review raised several
comments is worked through in a single revise pass rather than cycling the run once per item.

Reviewer findings raised inside a convergence step are disposed by the implementer within that loop
(fixed, or declined with a recorded reason) without a separate human confirmation step. The human gate
that follows is the final check: a person reviewing the work sees the findings and their dispositions and
can reopen anything they disagree with. The convergence loop's round mechanics, and the implementer's
authority to judge it converged, belong to `review`; this concept's part is that those findings are
`Feedback` items dispositioned the same way a person's are, minus the per-item human confirm.

## The resolution contract check

An implementer's resolution must key to a real `Feedback` item by its ID. A resolution that references an
item that does not exist, by an invented or malformed ID, is a contract violation, not a recorded
resolution. The malformed reference goes back through the tolerance pipeline (ADR-012): deterministic
repair is attempted first, and if the reference still does not resolve to a real item the agent is asked
to correct it before the resolution is recorded (ADR-027). The run does not record a resolution against a
phantom item and does not proceed on the bad reference; it records the resolution only once the reference
keys to a real item.

## Amending the spec from implementation feedback

The spec gate approves the spec to build from; it does not freeze it. The spec stays a mutable working
document through implementation (ADR-028). When implementation feedback requires a change the spec
contradicts, the implementer amends the spec file (committed) as part of addressing that feedback, then
makes the code change. The order is amend-then-change rather than change-and-flag-a-conflict.

The committed spec history is the record of what changed; the reason the spec was amended is a response
in the prompting feedback item's thread. The amendment is confirmed at the implementation gate, not
mid-build: the person reviewing the build sees that the spec was amended and why, and confirms it by
approving the gate, or pushes back by reopening, which sends the run to revise. There is no route back
through the spec gate for an amendment, because nothing was frozen there. The spec freezes at
`pr.finalize` and is durable once the PR merges and the run reaches `done`; `spec-lifecycle` owns the
frozen-at-ship rule and the committed frontmatter the freeze writes.

## Feedback after the PR opens

Feedback raised at `pr.human_review` reduces to a `revise` directive and routes the run back to the
producing step the workflow table designates. The PR updates in place: the step that opened it sees it
is already open and updates it rather than opening a second one. On the way back through implementation
the spec re-opens for amendment, and it re-freezes when the run passes `pr.finalize` again on the return
pass. This is the same revise machinery the earlier gates use, applied at the PR gate; there is no
separate post-PR feedback mechanism.

## Relationships

- `domain-model` — owns the `Feedback` record shape (anchor, target, embedded thread), its
  `open -> addressed -> resolved | wont_fix` lifecycle, and the `Principal` entity with its `kind`
  discriminator; this concept drives items through that shape.
- `review` — owns the convergence loop between the implementer and reviewer, its rounds, and the implementer's
  convergence authority; the findings that loop produces are `Feedback` items this concept disposes.
- `hitl` — owns the human-review gate as a pause-and-resume mechanism, its payload, and the valid
  replies; this concept owns the disposition precondition the gate advances on.
- `run` — owns the step catalog, the workflows, and the `next(workflow, step, directive)` rule a
  `revise` directive moves through.
- `spec-lifecycle` — owns the frozen-at-ship rule and the committed frontmatter an amendment writes
  through and `pr.finalize` freezes.
- `intents` — classifies an inbound message into the directive a gate reply acts on.

## Constraints and decisions

- One `Feedback` item for both human comments and reviewer findings, attributed uniformly per
  `Principal`; a model is a `Principal` of `kind` `model`, author-only (ADR-018, ADR-009).
- Authorship carries the human-versus-reviewer distinction, so there is no separate origin field; how an
  item is handled follows from where it sits (ADR-018).
- The implementer may set `addressed` or `wont_fix`, each requiring a thread response; only the
  originator confirms `addressed -> resolved` and may reopen a `wont_fix` (ADR-018).
- A human-review gate is actively approved by a person; its precondition is every item for that target
  `resolved` or `wont_fix`, and approving confirms the approver's own `addressed` items (ADR-018).
- Gating is per-target and requires every item dispositioned; a revise pass addresses all of a target's
  open items in one cycle (ADR-018).
- A resolution must key to a real `Feedback` item; a malformed reference goes through the tolerance
  pipeline before any resolution is recorded (ADR-012, ADR-027).
- Implementation feedback that contradicts the spec amends the spec in place, confirmed at the
  implementation gate, frozen at `pr.finalize` (ADR-028).

## Open edges

- **Channel-message extraction** is an additive surface, capability-gated on the channel adapter. When it
  lands, it turns a feedback message into a tracked item: a per-message classification recognizes the
  feedback impact, the run's current gate picks the target (`artifact` at the spec gate, `implementation`
  at the implementation gate, `docs` at the docs gate, `pr` at the pull-request gate), the anchor is
  optional and target-level when the message names no region,
  the author is the sender's `Principal`, and the message runs through the tolerance pipeline and the
  resolution contract check. Initial creation is native only; this surface is carried in the design, not
  built.
- **Per-round spec versioning** — keeping each committed version of the spec addressable across revise
  rounds — is groundwork the amend-in-place model leaves room for, not a built capability.
- **Parallel reviewers** raising findings on one target at once compose with this model (each finding is
  an item attributed to its own model principal), but a single reviewer per convergence step is the
  starting shape; the multi-reviewer confirm rule is already in place for when it arrives.
