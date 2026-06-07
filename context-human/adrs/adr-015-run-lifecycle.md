---
created: 2026-06-04
last_updated: 2026-06-07
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-015: Run lifecycle — a workflow-driven step machine

## Status

Accepted.

## Context

A run advances through steps: authoring an artifact, reviewing it, planning, building, reviewing the
build, opening a PR. Four things shape how the lifecycle is modeled.

A step's behavioral class — whether the model is working, whether a human's input is awaited, whether
it is terminal — needs a single source of truth, not a set of hand-maintained lists that drift apart.
A feature, an enhancement, a bug, a chore, a question, and an "open an issue" request are different
paths, not one path with conditionals. Each cost-bearing model activity must be attributable to the
session it belongs to and roll up through `(step, role)`, step, phase, and run. And customizable
workflows are a direction worth keeping reachable, so the model should make reaching them an additive
step.

## Decision

**Model the run lifecycle at three altitudes (phase, step, session), plus a role dimension within a
step and a gate between phases, with the run advancing by step over a workflow-driven table of step
primitives, and cost attributed per session (rolled up through `(step, role)`, step, phase, and run).**

- **Three altitudes.** A **phase** is a major arc that groups related steps and is bounded by a gate
  (`spec`, `implementation`, `docs`, `pr`; the `docs` phase between implementation and pr is added by
  ADR-029). A **step** is the unit the workflow advances through — one bounded piece of work. A
  **session** is one model's single go (an execution event); a step's work may take several sessions,
  and a session internally runs many assistant turns.
- **Role within a step.** A **role** is the dimension within a step a session plays — `implementer`,
  `reviewer`, and later others such as `mediator`. Roles are extensible, data-defined, snake_case.
- **Gate between phases.** A **gate** is a human-review pause between phases (`spec`, `implementation`,
  `docs`, `pr`). A gate has no sessions, so it bears no cost (a degenerate zero); adding a model to a
  gate later simply gives it sessions.
- **Each step carries an intrinsic `waiting_on`: `system` | `ai` | `human` | `none`.** The
  message-accepting set (`human`), the model-active set (`ai`), and the terminal set (`none`) are all
  *derived* from this single property, so they cannot drift out of step with the step list.
- **Cost unit = the session.** A session is one model's single go, so it has one model, one set of
  token counts, and one cost — the natural atomic unit to price. Each session carries a cost record
  (model, inference settings, token breakdown, `usd`); `(step, role)`, step, phase, and run totals are
  sums *over sessions*. A session is tagged `(run, phase, step, role)` and emits per-invocation
  metadata (model, inference settings, duration, turns, tokens); whoever owns cost prices it. The
  per-session cost+telemetry record lives in `domain-model` (the `Session` record). `(step, role)`
  is the routing key (ADR-024) and a rollup grain, not a stored cost record.
- **Rollups are computed live; a cached aggregate is a deferred option.** `(step, role)`, step, and
  phase totals are dedicated `GROUP BY` queries over sessions. A cached, present-when-complete
  `aggregateCost` with null-and-propagate invalidation is a deferred optimization, taken when read load
  makes live summing slow. Summing the session rows live is correct and fast.
- **Step primitives + workflows-as-data.** There is a catalog of step primitives (e.g.
  `spec.author`, `implementation.build`, the `*.human_review` gates, `done`/`canceled`/`failed`).
  A **workflow** is a *described transition table* over a subset of those primitives. The run **pins one
  workflow** (immutable for that run), and the lifecycle is driven by looking up the workflow's table.
  Several named workflows (feature, enhancement, bug, chore, file-issue, question) are defined as data,
  selected by the run's intent (ADR-016).
- **Transitions are driven by a small directive vocabulary.** Both a model result and a human message
  normalize into one of `advance | revise | needs_input | cancel | fail`, and a single function maps
  `(workflow, step, directive) -> next step`. The source vocabularies (a model-result status, a
  message intent, a review disposition) stay distinct front-ends that reduce to a directive.
- **Two bounds, two owners.** **Max turns** caps the assistant turns within one session before it stops
  (the runner owns this). **Max rounds** caps the round-trips between the implementer and reviewer within one step
  before it escalates instead of advancing (the workflow owns this).
- **Resume-leaning recovery.** A run is never dropped because its workspace is missing — the workspace
  is re-creatable (ADR-010) — and the step at which a run stopped is recorded, so the run can be
  resumed by re-materializing its workspace and re-dispatching from that step. Recovery is **per-state**:
  where a run stopped decides whether it resumes from its step or starts over, and which base its
  workspace re-materializes from. The recovery-policy table that maps stopped state to that outcome is
  owned by `run` and referenced by ADR-021; recovery is an explicit operator action, never automatic.
- **This decision fixes the workflow *data structure*, not a workflow *engine*.** Configuration-loaded,
  per-tenant, or user-edited workflows are out of scope here. Expressing workflows as data makes such an
  engine an additive change — loading the tables from a different source — rather than a teardown of
  hardcoded transitions, so it can be added when it is wanted.

## Consequences

**Positive:**
- The behavioral classification of a step cannot drift, because it is one intrinsic property, not
  several lists.
- Cost is priced at the session — one model, one rate, one record — and `(step, role)`, step, phase,
  and run totals roll up by summation, so per-session and per-round detail is preserved rather than
  aggregated away. Convergence-depth and thinking-level analytics are queries over the session rows.
- Adding a role to a step (a `reviewer`, later a `mediator`) is additive, and adding a model to a gate
  stays reachable by giving the gate its first session.
- Several genuinely different lifecycles are expressed as separate small tables instead of one branchy
  table, and a new lifecycle is a new table.
- The customizable-workflow direction is reachable additively.

**Negative:**
- The cost rollup has several levels (session, `(step, role)`, step, phase, run), summed at query
  time, and `(step, role)` and higher totals are query-time sums over sessions rather than stored
  records, so a future high-read-volume need may want the deferred cached aggregate.
- The role dimension is a new axis every cost record and routing decision carries.
- The directive normalization is a small piece of logic to keep correct for each source vocabulary.

## Alternatives considered

### A flat step enum with hand-maintained behavioral sets

One flat list of steps, with separate sets enumerating which are model-active and which accept messages.

**Pros:**
- Conceptually minimal — just an enum and a couple of sets.
- Easy to read at a glance.

**Cons:**
- The sets are maintained independently of the enum and reliably drift apart (a review step
  wrongly marked model-active is the canonical bug).
- A single enum forces one lifecycle, so different paths become conditionals on the side.

**Why not chosen:** intrinsic `waiting_on` removes the drift, and workflows-as-data removes the
single-lifecycle limitation — both failures of the flat model.

### A two-axis model: phase × activity

Decompose state into an orthogonal `phase` (spec/plan/build/review/pr) and `activity`
(working/awaiting/terminal).

**Pros:**
- Appealing in the abstract; separates "where in the pipeline" from "who is acting".

**Cons:**
- The axes are not independent — activity is a function of phase — so the product space is full of
  impossible combinations (`authoring` + `awaiting-human`, `human-review` + `working`) that must be
  constrained away.

**Why not chosen:** it manufactures illegal states; an intrinsic `waiting_on` per step gets the
single-source-of-truth benefit without the impossible combinations.

### A single hardcoded workflow

Express one rigid lifecycle directly in code and special-case the exceptions.

**Pros:**
- Simplest possible thing for exactly one path.

**Cons:**
- There is genuinely more than one lifecycle, so the exceptions accrete as conditionals — the scattered
  edges that make a customizable-workflow direction a rewrite.

**Why not chosen:** the multiplicity is real and present, so a described-table-per-workflow is the
simpler model for the actual shape of the problem.

### `(step, role)` as the stored cost unit

Store cost as a per-`(step, role)` record (a `RunStepRole`) that aggregates a role's sessions, rather
than pricing each session.

**Pros:**
- One record per role per step — marginally fewer rows than one per session.
- `(step, role)` is also the routing key (ADR-024), so the cost grain and the routing grain coincide.

**Cons:**
- A role can run several sessions within one step — a session continued past max turns, an
  exit-and-re-invoke, or convergence rounds — so a stored `(step, role)` record aggregates them and
  loses the per-session and per-round detail that convergence-depth (cross-cutting #17) and
  thinking-level (cross-cutting #18) analytics need.
- When a role's sessions span more than one model, the record's single `model` cannot represent them;
  a session always has exactly one model.
- `(step, role)` is recoverable as a `GROUP BY` over sessions at any time, so storing it as its own
  record buys little.

**Why not chosen:** the session is the grain that prices as one model at one rate (one cost) and
preserves the detail the analytics need; `(step, role)` stays a routing key and a query-time rollup,
recomputable from the session rows.
