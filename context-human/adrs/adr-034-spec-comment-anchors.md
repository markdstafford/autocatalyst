---
created: 2026-10-30
last_updated: 2026-10-30
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-034: Spec comment anchors are source ranges with quoted text

## Status

Accepted

## Context

A comment on a spec concerns a passage. The spec is Markdown source, the operator reads a rendered view,
and a revision can change the text under an existing comment. Feedback already has an optional anchor
(ADR-018).

## Decision

**A spec anchor is a start and end offset into the spec's source text, counted in Unicode code points,
plus the quoted text those offsets cover. The control plane rejects an anchor whose offsets do not
reproduce the quoted text in the current spec. The anchor is optional at the control plane. The web client
requires one on every spec comment.**

- The client maps a selection in the rendered view back to source offsets.
- After a revision, a comment whose range no longer matches is marked stale and kept. It is not dropped.
- Comments from a channel without a rendered view, such as a chat thread, can arrive without an anchor.

## Consequences

**Pros:**
- Stale ranges are caught at write time and shown, never silently moved.
- Offsets are independent of how the client renders.

**Cons:**
- Mapping a rendered selection to source offsets is real client work, with edge cases in tables, lists,
  and code.
- Code point counting differs from the string length in JavaScript, so the client counts with care.

## Alternatives considered

### Anchor to a heading or block id

**Cons:** too coarse for a sentence-level comment.
**Why not chosen:** operators comment on phrases.

### Offsets without quoted text

**Cons:** cannot tell a stale range from a valid one.
**Why not chosen:** the quoted text is what makes the check possible.
