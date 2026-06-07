---
created: 2026-06-05
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-024: Role-aware routing key

## Status

Accepted

## Context

Routing turns a unit of agent work into a resolved model profile. Two facts about how agent work
runs determine what the routing key should be.

A step can be worked by more than one model in distinct roles. A run converges incrementally by
having an `implementer` propose and a `reviewer` critique within the same step, and a workflow may
add further roles such as a `mediator`. Routing must resolve a different model for each role of the
same step.

The lifecycle also advances by step (ADR-015). The unit that agent work routes against and the unit
the run advances through coincide, so the routing key for agent work is the step itself, with no
second taxonomy to maintain beside it.

This ADR decides the routing key, how it resolves, and how it supports role-distinct model
selection, the mechanism a workflow uses to run convergence across distinct models.

## Decision

**Agent work routes on `(step, role)`; bounded direct calls route on `(step)`; resolution is
specificity-ordered with a typed error on a genuine miss; the base table is per-tenant data in the
database.**

- **The agent routing key is `(step, role)`**: the step the run advances through plus the role the
  session plays. Roles (`implementer`, `reviewer`, and others such as `mediator`) are extensible,
  data-defined, and snake_case.
- **Bounded direct-model calls route on `(step)` alone**, for example classifying an incoming
  message's intent at intake.
- **Work intent and work kind are upstream selectors.** They choose the workflow (ADR-016), and the
  workflow determines which steps exist; they shape routing by selecting the steps, so they are not
  themselves routing facets.
- **Resolution is specificity-ordered.** A `(step, role)` resolves to its profile, then falls back to
  a step-level default; a genuine miss is a typed error surfaced at the configuration boundary.
- **The base routing table is per-tenant data in the database** (ADR-008), validated by the shared
  schemas (ADR-007). Resolution reads it directly and explicitly; the extension registry is not on
  that path (ADR-011).
- **Role-distinct models are expressible.** A workflow can require that a step's roles use distinct
  models (a reviewer distinct from its implementer), and routing surfaces a signal when it cannot
  satisfy the requirement, so the workflow can degrade or escalate. Assigning roles and running the
  convergence loop belong to the workflow; routing provides the role-distinct resolution it draws on.
- **Override layers are additive.** A per-run or per-user override over the base table is taken when a
  concrete need arrives, layered on the same key.

## Consequences

**Positive:**
- One key serves both model selection and the convergence mechanism a workflow runs across distinct
  models.
- The step is the single taxonomy for agent work — there is no separate task list to keep beside it.
- Roles are an open, data-defined set, so a new role is data, not code.
- Resolution stays explicit and config-driven, which is where behavior is read.

**Negative:**
- Role is a new axis every routing entry and every cost record carries.
- Specificity-ordered resolution with a default is a little more than a flat lookup.

## Alternatives considered

### Key on the task alone

Route on a single flat task name, as a one-level lookup.

**Pros:**
- The simplest possible resolution.

**Cons:**
- It cannot express role-distinct models for one step, so convergence across distinct models has no
  mechanism.
- It keeps a task taxonomy parallel to the step taxonomy, two overlapping lists to maintain.

**Why not chosen:** The role dimension is required for convergence, and once the run advances by step
the task list and the step list are the same, so the key is `(step, role)`.

### A composite runner that dispatches several models within one step

Have a single runner fan a step out to several models at once and gather their results.

**Pros:**
- A single call site for multi-model work.

**Cons:**
- One step would emit several cost records, reopening the per-`(step, role)` cost unit (ADR-015).
- It duplicates the sequencing and concurrency the run already owns.

**Why not chosen:** Role-keyed resolution plus the run's own sequencing covers multi-model work
without a composite runner and keeps cost attributed per `(step, role)`.

### A wide key of task, intent, artifact kind, step, and role

Carry every available facet in the routing key for maximal flexibility.

**Pros:**
- Any conceivable routing distinction is expressible.

**Cons:**
- It is a large matrix for distinctions with no present binding need, and intent and artifact kind
  already shape routing upstream by selecting the workflow.

**Why not chosen:** The key carries only what binds — `(step, role)` — and the upstream selectors do
the rest.

### Per-user and per-route override layers from the start

Build the full stack of override layers immediately.

**Pros:**
- Fine-grained control over routing per user and per route.

**Cons:**
- Per-user precedence presupposes multi-user operation, which arrives later as identity is built out
  (ADR-009).

**Why not chosen:** Overrides are additive over the base table and are taken when the need is real,
so the base table is the whole of the initial decision.
