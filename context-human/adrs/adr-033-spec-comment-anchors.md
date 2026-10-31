---
created: 2026-10-30
last_updated: 2026-10-30
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-033: Spec comment anchors are quoted text, resolved against the current spec

## Status

Accepted

## Context

A comment on a spec concerns a passage. The spec is Markdown source, the operator reads a rendered view, and
a revision changes the text under an existing comment. Feedback already has an optional anchor (ADR-018).

A revision is a new version of the whole spec written by an agent, not a series of edits, so the system has
no record of what moved. Offsets stored with a comment stop pointing at the same text as soon as anything
before it changes, whatever the length of the text itself.

## Decision

**A spec anchor is the quoted text, a short run of text before and after it, the offsets in code points where
the operator selected it, and the spec revision it was made against. The anchor is never rewritten. The
control plane resolves it against the current spec when it is read: it looks for the quoted text near the old
offsets, uses the surrounding text to choose between matches, and returns the current range. If the text is
no longer there, the anchor is returned as stale. A stale comment is kept and shown with its quote.**

- On write, the control plane rejects an anchor whose offsets do not reproduce the quoted text in the
  revision it names.
- Resolution happens in the control plane, so every client sees the same range for the same comment.
- The anchor is optional at the control plane. The web client requires one on every spec comment.
- The web client maps a selection in the rendered view back to source offsets before it sends the anchor.

## Consequences

**Pros:**
- Nothing has to be updated when the spec changes, and a comment survives revisions that leave its text alone.
- Stale comments are visible and recoverable, never silently moved to the wrong text.
- Offsets do not depend on how a client renders.

**Cons:**
- Resolution is a search, so a passage that repeats can resolve to the wrong copy. The surrounding text
  makes this rare but not impossible.
- Mapping a rendered selection to source offsets is real client work, with edge cases in tables, lists, and
  code.
- Code point counting differs from string length in JavaScript, so the client counts with care.

## Alternatives considered

### Offsets that are rewritten whenever the spec changes

**Pros:** no search at read time.
**Cons:** the system must know what changed. An agent rewrites the whole spec, so there is no edit record
to shift offsets by, and the only way to rewrite them is the same search.
**Why not chosen:** it does the search anyway and makes every revision write to every comment.

### Anchor to a heading or block id

**Cons:** too coarse for a comment on a phrase.
**Why not chosen:** operators comment on sentences.

### Offsets without quoted text

**Cons:** cannot tell a stale range from a valid one.
**Why not chosen:** the quoted text is what makes the check and the search possible.
