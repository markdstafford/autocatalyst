---
created: 2026-06-04
last_updated: 2026-06-07
status: active
roadmap: core
---

# Run

How a single run moves through its work: the step machine it traverses, the workflow that drives it,
the rule that turns a result or a message into the next step, and how a run that stops is resumed.
This concept owns the **step-primitives catalog**, the **workflows** defined over it, the
**transition** rule, and the **resume** model. It does not own the `Run`/`Topic`/`Conversation` record
shapes (see `domain-model`), who may mutate run state (see `orchestrator`), or the mechanics of driving
an agent session and re-creating a workspace (see `execution-runtime`).

## Phase, step, session, role, gate

A run's lifecycle is named at three altitudes, plus two cross-cutting concepts:

- A **phase** is a major arc that groups related steps, bounded by a gate: `spec`, `implementation`,
  `docs`, `pr`.
- A **step** is the unit the workflow advances through — one bounded piece of work. It is the
  role-bearing unit cost rolls up to.
- A **session** is one model's single go: one agent or model session (an execution event), which
  internally runs many assistant turns. A step's work may take several sessions, and the session is the
  cost-bearing unit.
- A **role** is the dimension within a step a session plays: `implementer`, `reviewer`, and later
  others such as `mediator`. Roles are extensible, data-defined, snake_case.
- A **gate** is a human-review pause between phases: the `spec`, `implementation`, `docs`, and `pr`
  reviews.

## A run executes one workflow

A run serves a topic by executing exactly one **workflow**, pinned for the life of the run. The
workflow is the run's objective (`feature`, `enhancement`, `bug`, `chore`, `file_issue`, or
`question`), selected at intake from the message's intent (ADR-016). Pinning the workflow keeps a run's
path stable even as the topic's objective changes over time: an escalation does not rewrite a running
workflow, it starts a new run (see Intent-upgrade).

## Steps and `waiting_on`

A run's position is a **step**, and every step declares one intrinsic property — **`waiting_on`** —
with one of four values (ADR-015):

- **`system`** — Autocatalyst is doing internal work (classifying, routing).
- **`ai`** — a model session is doing the work.
- **`human`** — the run is paused for a person.
- **`none`** — the run is terminal.

The behavioral sets a run cares about are read from this one property rather than kept as separate
lists: the message-accepting steps are exactly the `human` ones, the model-active steps are the `ai`
ones, and the terminal steps are the `none` ones. A step's class therefore cannot drift from the
step list.

## The step-primitives catalog

The catalog of steps, grouped by phase. The four `*.human_review` steps are the phase **gates**
(`spec`, `implementation`, `docs`, `pr`); the `*.awaiting_input` steps are within-phase pauses for a
person; the rest are `ai` or `system` steps:

| Step | Phase | `waiting_on` |
| --- | --- | --- |
| `intake` | — | `system` |
| `spec.author` | `spec` | `ai` |
| `spec.awaiting_input` | `spec` | `human` |
| `spec.human_review` | `spec` | `human` |
| `implementation.plan` | `implementation` | `ai` |
| `implementation.build` | `implementation` | `ai` |
| `implementation.awaiting_input` | `implementation` | `human` |
| `implementation.human_review` | `implementation` | `human` |
| `docs.update` | `docs` | `ai` |
| `docs.human_review` | `docs` | `human` |
| `pr.finalize` | `pr` | `ai` |
| `pr.open` | `pr` | `system` |
| `pr.human_review` | `pr` | `human` |
| `issues.file` | — | `system` |
| `question.answer` | — | `ai` |
| `done` / `canceled` / `failed` | — | `none` |

`phase` is an explicit attribute on each step, authoritative over the prefix. `canceled` is its own
terminal state, so an operator cancellation is never recorded or metered as a failure; `done` is the
only non-failed completion.

The catalog's per-step behavior is owned by the workflow concept: the roles each step carries, where
the reviewer role sits, the implementer-and-reviewer converge loop and its **max rounds**, and the
mechanics of a gate. This concept fixes the vocabulary (phase, step, session, role, gate) and the cost
model; the step sequence above is the working catalog those workflows draw from.

## Cost: the session unit

The cost unit is the **session** (ADR-015): one model's single go within a `(step, role, round)`,
carrying one model at one rate and one `Cost`. A step's sessions roll up to `(step, role)`, step, and
phase totals, and on up the hierarchy, by summation; `(step, role)` and above are query aggregations
over the session rows, not stored cost records. A **gate**, and any human- or system-driven step, runs
no session and bears no cost. The `Session` record lives in `domain-model`; `observability` records its
execution metadata and `cost` prices its tokens.

## Workflows as data

A **workflow** is a described transition table over a subset of the catalog — the steps it uses and
the moves between them. The named workflows are defined as data and selected by intent:

- **`feature`** — the full path: `intake -> spec.author -> spec.human_review -> implementation.plan ->
  implementation.build -> implementation.human_review -> docs.update -> docs.human_review -> pr.finalize ->
  pr.open -> pr.human_review -> done`. Model review is a `reviewer` role within `spec.author` and
  `implementation.build`, not a separate step (`workflow`, ADR-026).
- **`enhancement`** — its own workflow (and its own `enhancement_spec` artifact kind); an enhancement is
  treated distinctly from a feature even where its steps currently match.
- **`bug`** and **`chore`** — their own workflows, with fewer convergence steps than `feature`; both
  carry an implementation and a pr phase, so both include the `docs` phase.
- **`file_issue`** — `intake -> spec.author -> issues.file -> done`, filing issues without an
  implementation, docs, or pr phase. `spec.author` triages and enriches the items (`mm:issue-triage`);
  `issues.file` is the deterministic `system` step that writes them to the tracker, so no agent writes
  the tracker (`trackers`). The workflow authors no `Artifact`; it records each filed issue as a
  run-to-issue reference (`domain-model`).
- **`question`** — `intake -> question.answer -> done`.

Defining workflows as data lets several different paths coexist without one branchy
table, and it is the seam a future workflow engine (configuration-loaded or per-tenant workflows) grows
into: such an engine loads the tables from a different source rather than replacing hardcoded edges.
That engine is out of scope here; the data structure is what this concept fixes.

## Transitions and directives

A run advances through one rule: `next(workflow, step, directive) -> next step`. The **directive** is
a small, shared vocabulary that both a model result and a human message reduce into:

- **`advance`** — proceed to the workflow's next step.
- **`revise`** — go back to where the workflow table designates: usually the producing step
  (`spec.author` or `implementation.build`); for `pr.finalize`, the implementation gate; for
  `docs.human_review`, `docs.update`.
- **`needs_input`** — pause for a person at the matching `*.awaiting_input` step.
- **`cancel`** — go to `canceled`.
- **`fail`** — go to `failed`.

The sources stay distinct front-ends that each normalize into a directive: a model result runs through
the tolerance pipeline (ADR-012) before yielding one, and a human message yields one from its
`MessageIntent`. A `question`-intent message arriving at an active run yields an `answer` directive, a
no-op on the machine: the run gets a response without changing its step, and the session is attributed
to that active run for cost. A question that opens fresh work is the `question` workflow instead
(below): its `question.answer` step runs the answer and advances to `done`.

## The review loop

The gates put work in front of a person: `spec.human_review` (the authored spec, enhancement spec,
triage, or plan), `implementation.human_review` (the build), and `pr.human_review` (the pull request).
Each review is driven by `Feedback` (see `domain-model`): a reviewer's comments become tracked items, a
`revise` directive sends the run back to address them, and the run returns to the gate. The run cannot
`advance` out of a gate, or reach `done`, while that gate has open feedback — sign-off means every item
for that review is dispositioned. Model review is not a separate step: a producing step (`spec.author`,
`implementation.build`) carries an `implementer` and a `reviewer` role that converge within the step
before a person sees the result, so a person reviews work the model reviewer has already passed.
`pr.finalize` is an `ai` step: a final reviewer pass over the implementation for security and
PR-readiness. Freezing the spec artifact and reconciling the cumulative PR summary is a deterministic
effect the orchestrator applies once that reviewer result is validated, on the way to `pr.open`, not a
second `waiting_on` on the step. A finding that needs a human re-decision routes back to
`implementation.human_review` (`workflow`, ADR-026).

## Intent-upgrade

When a topic's objective escalates — a `file_issue` thread becomes "now fix it" — the run does not
mutate its workflow. Its current run reaches a terminal step, and a **new run** starts under the same
topic with the upgraded workflow, carrying the prior output forward as input (ADR-016, ADR-014). The
topic is the durable home of this sequence; the message that escalates is reclassified at intake rather
than dropped.

## Resume and recovery policy

A run survives a missing workspace — the workspace is re-creatable (ADR-010) — and the step at which
a run stopped is recorded, so the run can be resumed by re-materializing its workspace and
re-dispatching from that step. Driving the re-materialization and the agent session belongs to
`execution-runtime`; admitting a stopped run back for dispatch belongs to `orchestrator`. Nothing
re-dispatches on its own: recovery is an explicit operator action (`hitl`).

Recovery is **per-state**: where a run stopped decides whether it resumes from its step or starts over,
and which base its workspace re-materializes from. The base is the run's branch when committed work is
restored, or a freshly fetched default branch when none is (`workspace`). This table is the policy the
workspace, orchestrator, and `hitl` cite (ADR-015, ADR-021):

| Stopped at | Recovery | Materialization base | Re-dispatch from | Operator confirms |
| --- | --- | --- | --- | --- |
| Failed in the `spec` phase | Start over | Default branch (freshly fetched) | `spec.author` | yes |
| Failed in the `implementation`, `docs`, or `pr` phase, with committed checkpoints | Resume | Run branch | The failed step | yes |
| Failed before any meaningful commit | Start over | Default branch (freshly fetched) | The phase's first step | yes |
| `canceled` | Not recovered | — | — | — |
| `done` | Terminal | — | — | — |

A spec-phase failure starts over because little durable work precedes it; an implementation, docs, or
pr failure resumes from the failed step over the committed branch. Every recovery is operator-initiated;
there is no automatic re-dispatch.

## Relationships

- `domain-model` — owns the `Run`, `Topic`, `Conversation`, `Artifact`, `Feedback`, `RunStep`, and
  `Session` shapes this concept advances through steps.
- `orchestrator` — the single authority that creates a run, applies the transition rule, and admits a
  stopped run for resume.
- `execution-runtime` — drives the agent session for an `ai` step, validates its result, and
  re-creates the workspace.
- `intents` — classifies a message into the workflow (at intake) and the `MessageIntent` (per message)
  this concept acts on.
- `workflow` — owns the per-step behavior and the review-and-extract loops; a future workflow engine
  owns configurable workflow catalogs.

## Constraints and decisions

- Each step declares an intrinsic `waiting_on`; behavioral sets derive from it (ADR-015).
- The cost unit is the session; `(step, role)` and above are rollups over the session rows, and gates
  carry no cost (ADR-015).
- A run pins one workflow; workflows are described tables over the step-primitives catalog (ADR-015).
- Transitions run through one `(workflow, step, directive) -> next step` rule; model results and human
  messages normalize into the directive vocabulary (ADR-012 for result tolerance).
- A run cannot leave a review with open feedback for that review (ADR-018).
- Intent-upgrade starts a new run under the same topic rather than mutating a workflow (ADR-016,
  ADR-014).

## Open edges

- A **workflow engine** — configuration-loaded, per-tenant, or user-edited workflows — grows on the
  workflows-as-data seam; only the data structure and the named workflows are fixed here.
- The **review counts** for `bug` and `chore` are starting points to tune.
- The full **recover-and-redispatch** handler implements the recovery-policy table above; the
  do-not-drop-the-run guarantee is in place independently.
- New intents (a new-app workflow, a brainstorm or prototype flow) are additive workflows over the same
  catalog.
- A **complexity classification** after planning that picks a granular or coarse implementation
  continuation is a conditional branch the transition rule is built to express; the straight-line
  tables come first (`workflow`, ADR-025).
