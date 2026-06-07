---
created: 2026-06-04
last_updated: 2026-06-07
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-018: Feedback as a first-class, run-gating entity

## Status

Accepted

## Context

When a person reviews a spec or an implementation, they leave feedback and expect it to be acted
on. That feedback can arrive on several surfaces: comments on a published spec page, items on a testing
guide, or a message typed in a channel. Feedback that is not structured and tracked gets lost or only
partially addressed: a comment in a channel goes unrecorded, a review item is marked done without being
resolved, a later cycle reprocesses stale state. The domain core must decide whether feedback is a
tracked thing in its own right or a kind of message.

## Decision

**Model `Feedback` as a first-class, structured entity (a small tracked item, like a mini-issue),
distinct from `Message`, parented to the `Run`, and gating that run's completion.**

- **First-class and structured.** A `Feedback` item is a discrete record: what needs fixing, an optional
  **anchor** (which region of the spec, which part of the implementation, which proposed doc change, or
  which part of the pull request), a **`target`** (`artifact`, `implementation`, `docs`, or `pr`) naming
  which gate review it concerns — one target per gate that accepts feedback — and attribution.
- **A discussion thread per item.** A `Feedback` item carries the back-and-forth about resolving it (the
  originating comment, the model's response, and any further replies) as an ordered, embedded list
  of comments, each attributed to a `Principal`. It need not be elaborate (an embedded value object
  suffices), but per-comment `Principal` attribution is required, since several people may take part in
  one item's thread.
- **Distinct from `Message`.** A message conveys; a `Feedback` item is a commitment to fix. Commentary
  that conveys is a message; commentary that expects a change is feedback.
- **A reopenable lifecycle:** `open -> addressed -> resolved | wont_fix`, with an explicit
  **reopen** when an item was not properly handled. `wont_fix` is a deliberate, recorded non-fix.
- **Parented to the `Run`.** A topic that fixes several things in succession produces distinct feedback
  per run, so feedback belongs to the run it concerns, not to the topic. The run owns its feedback
  directly, by composition.
- **Surfaces are extracted into `Feedback`.** Spec-page comments, testing-guide items, and channel
  messages carrying feedback intent are all extracted into the one `Feedback` model (the extraction
  behavior belongs to the feedback/review concept; the record shape belongs to `domain-model`), so no
  feedback is left detached on a side surface.
- **Feedback gates completion.** A run cannot advance out of a human-review gate, or reach `done`, while
  it has open feedback **for that review** (the `target` makes the gate per-review). Sign-off is "all
  feedback dispositioned" (resolved or `wont_fix`).

## Consequences

**Positive:**
- Every piece of review feedback is individually tracked, checkable, and reopenable, so a reviewer can be
  confident each point is handled rather than hoping a re-run addressed it.
- One feedback model across all surfaces means channel feedback is no longer second-class or lost.
- Gating completion on open feedback makes "addressed without being resolved" structurally
  impossible.

**Negative:**
- A distinct entity and lifecycle to build and maintain, versus reusing the message timeline.
- Extraction from free-form surfaces into structured items is real work and an imperfect step (the
  tolerance pipeline of ADR-012 applies).

## Alternatives considered

### Feedback as a kind of message

Treat feedback as a message with a `feedback` intent, and recover the to-fix items by reading the
timeline.

**Pros:**
- One fewer entity; reuses the message model directly.
- All human input lives in one place.

**Cons:**
- A message is a communication event, not a tracked commitment. It has no resolved/reopen lifecycle, no
  anchor, and no natural way to gate completion on "are all of these handled".
- Recovering structured to-fix items by scanning prose is exactly the lossy, ad-hoc handling that lets
  feedback slip.

**Why not chosen:** feedback needs to be tracked, checked off, and reopened, which a conveyance-only
message cannot support. Conflating the two recreates the loss this decision prevents.

### A separate feedback model per surface

Keep distinct feedback shapes for spec comments, testing-guide items, and channel feedback.

**Pros:**
- Each surface's native structure is preserved exactly.

**Cons:**
- Re-fragments feedback across surfaces (the detached, inconsistent feedback this decision solves), and
  forces every consumer to handle several shapes.

**Why not chosen:** one structured model with an optional anchor captures each surface's content while
keeping a single lifecycle and a single place to ask "is anything still open".
