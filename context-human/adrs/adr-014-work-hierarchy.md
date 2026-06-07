---
created: 2026-06-04
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-014: Work hierarchy — Conversation, Topic, Run

## Status

Accepted

## Context

Given the domain vocabulary (ADR-013), the structural relationships among `Conversation`, `Topic`, and
`Run` must be fixed: how they nest, how many of each, which one is "current", and how the system
prevents two executions from racing the same objective. The single-authority control plane (ADR-003)
must be able to guarantee that a person's objective is not worked twice in parallel, and it must do so
durably on a real store (ADR-004), not as an in-memory timing trick.

A person's interaction is rarely a single shot. A conversation usually pursues one objective, but it can
divert (file an issue mid-feature, answer a question, then return) and it can refine an objective into
a heavier one. The hierarchy must represent that while staying orderly.

## Decision

**A `Conversation` holds one or more `Topic`s with exactly one designated *main* topic; a `Topic` owns
a sequence of `Run`s with at most one active (non-terminal) run; and the "one execution per objective"
guarantee is a durable database invariant keyed on the topic, decoupled from step transitions.**

- **`Conversation` to `Topic` (1:many), one main.** A conversation has a single **main topic** (its
  principal objective, what a client UI centers on) and zero or more **side topics** (diversions).
  Exactly one topic is the **active topic** at any moment: the one inbound messages route to. A
  conversation often pursues a single objective, but the model admits several topics (one main, the
  rest side) so an interaction can diverge to a side topic and return to the main.
- **`Message` is subordinate to `Topic`.** Every message belongs to the topic that was active when it
  arrived. Because exactly one topic is active, an ambiguous instruction ("approve") is unambiguous: it
  applies to the active topic. A conversation's transcript is the time-ordered union of its topics'
  messages.
- **`Topic` to `Run` (1:many), at most one active *per topic*.** A topic's runs are strictly sequential:
  a run reaches a terminal step before the next begins, so a single topic never has two live runs at
  once. This is the "do not work an objective twice" guarantee, attached to the objective rather than to
  any single submission. The bound is strictly **per topic**: a conversation with
  several topics can have several runs active at once, one per topic.
- **Dedup is a durable database invariant.** The at-most-one-active-run-per-topic rule is enforced by a
  uniqueness constraint in the store (ADR-004). Starting a
  second active run for a topic is rejected by the database; the duplicate is discarded or attached to
  the existing run. Deduplication is therefore **decoupled from step transitions**: advancing a run's
  step is never used as a dedup mechanism.
- **Three orthogonal notions stay distinct:** the **active topic** (per conversation, where
  messages route), the **active run** (per topic, the single non-terminal execution), and a run's
  **step** (where its work sits, ADR-015). A side topic's run can still be executing in the background
  while another topic is active; it waits when it reaches a human-facing step.

## Consequences

**Positive:**
- The duplicate-work guarantee is both race-free and durable: it survives a restart, because it lives
  in the database rather than in process memory.
- Decoupling dedup from step transitions removes a source of tangled state (a step no
  longer has to be advanced just to block a duplicate).
- A topic gives a durable home to an objective served by several sequential runs (a clarifying step,
  then the real work; or a fresh run resuming a stopped one).
- The main/side distinction gives a multi-objective conversation a center of gravity for the UX to
  build around.

**Negative:**
- More structure than a flat "one execution per submission" model: three levels to understand.
- The active-topic and active-run pointers are state the control plane must keep correct.
- Determining the main topic in a genuinely ambiguous chain (several unrelated fixes in a row) needs a
  heuristic and tolerates the occasional wrong guess.

## Alternatives considered

### One active execution per submission (keyed on the submitted unit)

Guarantee at most one active run per submitted unit of work, keyed on the submission itself.

**Pros:**
- Simple: the submission is the natural key, and there is no objective layer to maintain.
- Sufficient when every interaction is a single objective.

**Cons:**
- The guarantee attaches to the wrong thing. It is really about the *objective*, not the submission, so
  an interaction that refines or diverts cannot be represented without ad-hoc fields.
- Leaves nowhere to sequence several runs against one objective.

**Why not chosen:** the invariant belongs on the topic (the objective), which is exactly what makes
refine-and-resume representable.

### A run that hosts many workflows

Make the `Run` the durable container and let it host a sequence (or stack) of workflow executions.

**Pros:**
- One fewer entity; the "thread" and the "execution container" are the same thing.

**Cons:**
- Forces steps and cost off the run and onto a sub-entity, dissolving the model where a run carries its
  own steps and their `(step, role)` cost (ADR-015).
- Overloads "run" as both a container and an execution.

**Why not chosen:** keeping a run as exactly one execution (with the topic as the container) preserves the
run's per-`(step, role)` cost model; the container role belongs to the topic.

### An in-memory deduplication window

Prevent duplicates by serializing classification in process and advancing a step so a concurrent
duplicate sees a non-actionable state. This is not a genuine alternative on a real store: it is race-free only
while everything is in one process with no I/O, it does not survive a restart, and it forces dedup and
step-advancement to be the same act. The database uniqueness constraint provides the same guarantee
durably and keeps the two concerns separate.
