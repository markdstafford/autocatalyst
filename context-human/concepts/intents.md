---
created: 2026-06-06
last_updated: 2026-06-06
status: active
roadmap: flow
---

# Intents

How an inbound message becomes its impact on the run. This concept owns **per-message
classification**: turning a message into the effect it has on the active run, selecting a workflow
when a run is created, and distinguishing an objective that grew (an upgrade) from one that branches
off (a divert). It does not define workflows or the steps they compose (see `run`/`workflow`), it
carries no durable work-kind field (the workflow is the durable objective, ADR-016), it does not pull
or enrich issue-tracker content (see `intake`), and it does not apply the result, which is the
orchestrator's job. The classifier produces a verdict; the orchestrator acts on it.

## The impact a message has on the run

Classification names what a message *does to the run*, not what it says in the abstract. Four impacts
cover every inbound message:

- **`create`** — start a run. It carries a workflow (the work kind) and an attachment (where the new
  run hangs).
- **`advance`** — approve. The run moves forward to the workflow's next step.
- **`revise`** — feedback. The run moves back to address it.
- **`answer`** — a question. The run does not move; the message gets a response.

This framing refines ADR-016's `MessageIntent`. The impacts align with the directive vocabulary the
run already uses (see `run`), which makes them straightforward to act on: `advance` and `revise` *are* the
transition directives that `next(workflow, step, directive)` consumes, `create` is an orchestrator
action that starts a run, and `answer` is the no-op-with-response. Two impacts that messages never
carry — `cancel` and `fail` — come from operators and the system, not from a person's message, so
they are not classification outcomes.

## Only `create` carries a workflow

Every impact but `create` is a single value: an `advance`, a `revise`, or an `answer` says all it
needs to about an active run, because the run already holds its workflow. `create` is the one impact
that has to know the work kind, so it alone carries a workflow — `feature`, `enhancement`, `bug`,
`chore`, `file_issue`, or `question`, selected from the catalog `run`/`workflow` define. There is no second classification axis: a `create`
includes a workflow, and the other impacts stay single values.

## Where a created run attaches

A `create` also names where the new run sits in the work hierarchy (`Conversation -> Topic -> Run`,
ADR-014). The attachment is one of three:

- **A new main topic** — a fresh thread with its own objective.
- **The same topic with a new run** — an **upgrade**: the topic's objective grew, and a new run takes
  it on under the existing topic (ADR-014, ADR-016).
- **A side topic** — a **divert**: a separate objective opens alongside the main one.

Upgrade and divert are the attachment the classifier picks for a `create`, not separate impacts. The
choice turns on whether the new objective continues the current topic or branches off it. The classifier
reads that continuation question against the active run's current state; the verdict it returns is the
attachment the orchestrator acts on (see `orchestrator`).

## One classification call, read against the run

There is a single classification call, and its context is the active run's **current step** — or "no
active run" when there is none. The context is derived from the step itself, not kept as a separate
list of recognized contexts: a step already says where the run sits, so the same words classify
differently at different points, and nothing can drift between the step and a parallel context
registry.

The two readings follow from that one context:

- **No active target run** — the impact is a `create`, and the classifier also selects the workflow.
- **An active target run** — the impact is classified against the run's current step. A reply at a
  human-review gate reads as `advance`, `revise`, or `answer`; a message whose objective has moved
  beyond the running one reads as a `create` that attaches as an upgrade or a divert.

The same message therefore means different things in different positions — feedback while a spec is
under review, an approval at a PR gate, an upgrade against a run that has finished its narrower
objective.

## The two-stage create for an issue reference

A general `create` is one stage: classify, and the workflow is settled. A free-form message that names
an existing tracker issue in its text ("work on issue #N") is a `create` too, but a deliberate
**two-stage** one. The classifier recognizes that a lookup is needed before the work kind can be known;
`intake` pulls the issue and enriches it; only then is the workflow determined (a `feature`, `bug`, or
`chore`, depending on what the enriched issue turns out to be). Recognizing that a lookup is needed is
the classifier's part; pulling and enriching the issue is `intake`'s. The two-stage path is the
**free-form** issue-reference case alone: a structured issue-reference entry carries an explicit
pointer, so it skips the recognition step and goes straight to pull-and-enrich (`intake`), and a general
free-form trigger that names no issue stays one-stage.

## Classification as a bounded model call

`intent.classify` is a bounded direct-model call routed on `(step)` with no role facet (ADR-024). It
is a direct call rather than an agent session: it does not open a workspace, drive a multi-turn agent,
or carry a role. The step is the whole routing key — the same step the run advances through — so there
is no separate task taxonomy beside the step list. The work kind a `create` selects is an upstream
selector that chooses the workflow, not a routing facet of its own (ADR-024).

## Relationships

- `run` — owns the workflow catalog a `create` selects from, the step catalog the classification
  context reads against, and the `next(workflow, step, directive)` rule that `advance` and `revise`
  feed.
- `orchestrator` — applies the verdict: it starts a run for a `create`, transitions a run for an
  `advance` or `revise`, responds for an `answer`, and acts on the upgrade/divert attachment. It is
  the single authority over scheduling and run state.
- `intake` — pulls and enriches a referenced tracker issue in the second stage of an issue-reference
  `create`; `intents` only recognizes that the lookup is needed.
- `hitl` — owns the pause-and-resume semantics of a human step; `intents` classifies the reply that
  resumes it into a directive.
- `domain-model` — owns the `MessageIntent` shape this concept produces and the
  `Conversation -> Topic -> Run` hierarchy a `create` attaches into.
- `model-routing` — resolves the `(step)` profile for the `intent.classify` call (ADR-024).

## Constraints and decisions

- The classification names a message's impact on the run — `create`, `advance`, `revise`, `answer` —
  refining the `MessageIntent` framing of ADR-016. `cancel` and `fail` come from operators and the
  system, not messages.
- Only `create` carries a workflow; the workflow is the durable objective and there is no separate
  durable work-kind field (ADR-016).
- Upgrade and divert are the attachment a `create` picks, not separate impacts; an upgrade starts a
  new run under the same topic, a divert opens a side topic (ADR-014, ADR-016).
- One classification call, context-dependent: the context is the run's current step, or "no active
  run", derived from the step rather than a separate context list.
- A free-form "work on issue #N" is a two-stage `create` — recognize the lookup, hand the pull and
  enrich to `intake`, then settle the workflow; a structured issue-reference entry skips recognition,
  and a general free-form `create` stays one-stage.
- `intent.classify` is a bounded direct-model call routed on `(step)` with no role facet (ADR-024);
  the work kind a `create` selects is an upstream selector, not a routing facet.

## Open edges

- **Additive workflows** — `prototype`, `brainstorm`, and `new_app` — are each a `create` selecting a
  new workflow over the existing catalog. They are additive over the catalog and gated on building
  those workflows, not on this concept.
- **Near-neighbor quality** — distinguishing a brainstorm from a question, or a new-app scope from a
  feature — is classification quality (the prompt and the workflow descriptions the model reads), tuned
  when the workflows that need the distinction are built.
- **A channel-independent message identity** — what routes a message to its run once a channel is
  optional — is owned by `domain-model`/identity; this concept cross-references it.
- **Channel-message feedback extraction** — turning a feedback message on a chat surface into a
  tracked item — is an additive surface gated on the channel adapter; when it lands it reuses a
  `revise` classification and the run's current gate to pick the target.
