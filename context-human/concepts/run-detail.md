---
created: 2026-10-30
last_updated: 2026-10-30
status: draft
roadmap: web-client
doc_id: 502f5c8e-710e-4697-b0f8-db342a2de826
---

# Run detail

Run detail is what the detail pane shows when the selected item is a run. It gives the operator a summary
of where the run is, a record of what happened, and the artifacts they review at each gate, along with the
means to approve a gate or send feedback. It does not own the list the run is chosen from (`collection`),
the shell around the pane (`ux`), the run's state and gates (`run`, `workflow`, `hitl`), or how feedback
and specs are stored (`feedback`, `spec-lifecycle`).

## The header and tabs

The pane's header shows the run's title, which comes from its issue and which the operator can rename, the
issue number, the work kind, and the status. Below it are four tabs: **Summary**, **Spec**, **Acceptance**,
and **Activity**.

Every tab is present on every run. A tab with nothing to show says why and what happens next, such as a
Spec tab on a bug or a chore, which have no spec, or an Acceptance tab before the implementation is ready. Showing the
same tabs for every run keeps the pane predictable, and the operator never wonders whether an artifact
exists.

## Summary

The summary answers where the run is. It shows the issue (with a link), the work kind, the state and what
the run is waiting on, the pull request once one exists, and totals for time, tokens, and cost. A progress
bar shows the run's phases, with the current phase and step marked and gates shown within their phase.

The phases come from the run's workflow, so a workflow that adds, drops, or reorders phases needs no change
to the client. The bar labels each phase from the workflow's data and compacts itself when there are many.

## Activity

Activity is the record of what happened. It lists the run's steps, with each step's sessions and live events
nested under it. It shows the run's whole expected path: steps not yet reached appear as not started, and
steps the run skipped appear as skipped. A step that repeats, such as a spec revision, appears as a new
attempt. Live events keep a running run from looking stalled.

## Spec

The Spec tab renders the spec as a document, with comments beside it. A comment is anchored to a range of
the spec. The operator highlights text to comment on it, and sees each comment next to the text it
concerns. Every open comment blocks approval, and it is easy to see which comments are still open and which
are resolved. The tab can expand to a larger view when the document needs more room.

## Acceptance and the implementation gate

The Acceptance tab holds the testing guide. It has instructions for getting the build running and a list of
things to try. The operator marks each item pass or fail, or leaves it unanswered, and can add a note to any
item. The operator can also add general feedback that is not tied to an item, for something they noticed
while testing. This feedback goes to the implementation. When the operator is satisfied, they
approve the gate.

## The pull request

The pull request appears in the summary once the run opens one. The client asks the control plane to check
its state when the run is selected and when the operator asks, and the run reaches done when the pull
request merges. A pull request closed without merging is shown as such.

## Gate decisions

A run waiting at a gate shows one decision at a time. At the spec gate, the button reads Approve when no
comment is open, and Request changes, with the number of open comments, when any is open. A run that is not
waiting at a gate shows no decision button. The same button handles the implementation gate. The pane's
footer controls show the open and resolved comment counts and move between comments.

## Relationships

- Reads `api` for the run, its steps, sessions, and events, the spec, the testing guide, and feedback, and
  writes replies and feedback.
- `run`, `workflow`, and `hitl` define the state, phases, gates, and waiting that the pane shows.
- `domain-model` defines anchors, and `feedback` defines how feedback reaches a step. `spec-lifecycle`
  defines the spec document. `acceptance-testing` defines the testing guide and its results.
- `collection` chooses the run, and keeps the selected tab as the operator moves between runs.
- `ux` defines the pane's place in the shell and the action registry behind its menu.

## Constraints and decisions

- The client requires every comment on a spec to be anchored to a range. The control plane does not
  require one, so a comment from a chat channel can arrive without a region, but it rejects an anchor
  that does not resolve in the current spec. Feedback at the implementation gate can also be general,
  because testing turns up things that belong to no item.
- An anchor refers to the spec's source text, not to the rendered view (ADR-033). Mapping a selection in the
  rendered view back to the source is a core part of the client.
- The progress bar and the Activity tab take their phases and steps from the run's workflow, never from a
  fixed list in the client.
- The pull request is checked when the run is selected or when the operator asks, so the client does not
  poll.
- Review at a gate is feedback and a decision. The operator does not edit the artifact.

## Open edges

- **The docs gate and the pauses for input** use the same decision button and comment model, taken up when
  operators need a screen for them.
- **Recording test results** needs a route for the testing guide's results, taken up when the Acceptance
  tab records them.
- **Other kinds of item** can use the same pane with their own tabs, taken up when the client shows items
  other than runs.
