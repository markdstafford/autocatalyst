---
created: 2026-06-04
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-016: Intent model — window intent is the workflow

## Status

Accepted

## Context

Two different things look like "intent". A single inbound **message** has a communicative purpose:
the start of a topic, feedback, an approval, a question, a request to file an issue. Separately, a
**topic** pursues an objective: build a feature, enhance an existing one, fix a bug, do a chore,
answer a question. These operate on different timescales. A message's purpose is per-message and can
change with every message, while an objective persists across many messages and several runs. A model
that collapses both into one classification cannot represent a conversation that starts as "file an
issue" and then escalates to "now fix it."

## Decision

**Separate the transient per-message axis from the durable per-objective axis, and make the durable
axis the workflow itself.**

- **`MessageIntent` is transient, per inbound message** — `start_topic`, `feedback`, `approval`,
  `question`, `file_issue`, `switch_topic`, and so on. It is classified for each message and lives only
  for that message.
- **The durable objective axis is the topic's active run's *workflow*.** "What is this part of the
  conversation trying to do" equals "which workflow is the active run executing." Feature, enhancement,
  bug, chore, file-issue, and question are each a *workflow* (ADR-015).
- **The kind of work product is a property of the workflow.** What kind of work product a run yields
  (which drives the artifact kind, ADR-017) is a **tag on its workflow**, derived from it: a workflow
  per intent yields a workflow per artifact kind.
- **Trajectory changes are of two kinds** (mechanics in ADR-014):
  - **Upgrade** — the topic's objective escalates (a `file_issue` lead-in becomes a bug fix). This stays
    *one topic* whose objective settles, served by sequential runs; the escalated objective is the
    topic's **main** objective. This is the origin of the word "upgrade".
  - **Divert** — a genuinely separate objective opens as a **side topic** alongside the main, switched to
    and returned from.

## Consequences

**Positive:**
- Each message is classified for what it is doing now, independent of the objective, so the same topic
  can take feedback, a question, and an approval without the objective shifting.
- Collapsing the durable axis into "which workflow" removes a redundant field: the workflow already says
  what kind of work it is, and the artifact kind derives from it.
- Upgrade and divert have distinct definitions, which keeps escalation (one topic) from being
  confused with diversion (a new topic).

**Negative:**
- "The objective is the workflow" is an indirection: to know what a topic is doing, read its active run's
  workflow rather than a single labelled field.
- Classifying a message's intent (especially detecting an upgrade) is real logic, owned by the intent
  classifier, that the lifecycle then acts on.

## Alternatives considered

### Two durable axes: message intent × work kind

Keep `MessageIntent` transient, but also carry a durable `WorkKind` (feature/enhancement/bug/chore) field
on the run
alongside the workflow.

**Pros:**
- An explicit, directly-readable label for "what kind of work this is".
- Familiar — a single field answers "what is this".

**Cons:**
- Redundant with the workflow, which already encodes the kind and from which the artifact kind derives;
  two sources of the same truth invite drift.
- A standalone field implies the kind can vary independently of the workflow, which it cannot.

**Why not chosen:** the workflow is already the durable objective; a separate `WorkKind` duplicates it.
The kind survives as a *tag on the workflow*, not a second field.

### A single combined intent enum

One enumeration mixing message purpose (`question`, `file_issue`) and work kind (`feature`, `bug`,
`chore`) on the run.

**Pros:**
- One field, one classification step.

**Cons:**
- Conflates a per-message property with a per-objective one, so a message that changes the trajectory has
  nowhere coherent to land, and the durable record carries a value that was really about a single message.

**Why not chosen:** the two axes have different lifetimes; one enum cannot serve both without the
conflation this decision exists to remove.
