---
created: 2026-10-30
last_updated: 2026-10-30
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-033: Spec comment anchors are offsets with the quoted text, reconciled when read

## Status

Accepted

## Context

A comment on a spec concerns a passage. The spec is Markdown source, the operator reads a rendered view, and
a revision changes the text under an existing comment. Feedback already has an optional anchor (ADR-018).

A revision is a new version of the whole spec written by an agent, not a series of edits, so the system has
no record of what moved. Offsets stored with a comment stop pointing at the same text as soon as anything
before it changes, whatever the length of the text itself.

## Decision

**A spec anchor is a start and end offset into the spec's source text, counted in Unicode code points, plus
the quoted text those offsets cover. Most of the time the offsets are right. When the control plane reads a
comment, it checks that the text at the offsets equals the quoted text. If it does, nothing changes. If it
does not, the control plane searches the spec for the quoted text. When it finds it, it stores the new
offsets. When it does not, it marks the anchor stale. A stale comment is kept and shown with its quote.**

- On write, the control plane rejects an anchor whose offsets do not reproduce the quoted text in the
  current spec.
- Reconciliation happens in the control plane, so every client sees the same range for the same comment.
- The anchor is optional at the control plane. The web client requires one on every spec comment.
- The web client maps a selection in the rendered view back to source offsets before it sends the anchor.
- The agent that revises a spec is not asked to maintain offsets. Counting code points is unreliable for a
  model, and the check against the quoted text catches any mistake.

## Consequences

**Pros:**
- The common case costs one comparison, and a changed spec repairs its comments the next time they are read.
- A comment whose text is gone is visible and recoverable, never silently moved to the wrong text.
- Offsets do not depend on how a client renders.

**Cons:**
- The search takes the first match, so a phrase that appears twice can move a comment to the wrong copy.
  Storing a little text on each side of the quote would reduce this, and is taken up if it happens in
  practice.
- Mapping a rendered selection to source offsets is real client work, with edge cases in tables, lists, and
  code.
- Code point counting differs from string length in JavaScript, so the client counts with care.

## Alternatives considered

### Resolve from the quoted text alone, never storing offsets

**Pros:** nothing to keep current.
**Cons:** a search on every read, and no cheap way to tell a moved passage from an unchanged one.
**Why not chosen:** offsets make the common case a single comparison.

### Ask the revising agent to update the offsets

**Cons:** models miscount code points, and a wrong offset looks valid until a reader notices.
**Why not chosen:** the control plane can repair offsets from the quoted text without trusting the agent.

### Anchor to a heading or block id

**Cons:** too coarse for a comment on a phrase.
**Why not chosen:** operators comment on sentences.
