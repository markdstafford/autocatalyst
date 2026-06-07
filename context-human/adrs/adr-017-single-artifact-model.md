---
created: 2026-06-04
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-017: A single Artifact model

## Status

Accepted

## Context

Each review document Autocatalyst produces (a feature spec, an enhancement spec, a bug triage, a chore
plan) could be its own entity with its own pipeline, or all of them could share one model with a kind.
A human reviews these documents before work proceeds. The choice shapes the domain core and the workflow
layer, and it interacts with a prior question: what counts as an "artifact", as opposed to an ephemeral
review surface like a testing guide.

## Decision

**Use a single `Artifact` entity, defined by externally-visible durability, with its kind derived from
the run's workflow. The behavioral differences between kinds live in workflows, not in separate
entities.**

- **One `Artifact` entity** with a `kind` (feature spec, enhancement spec, bug triage, chore plan). The
  fields that matter (location, status, publication, linked issue) are common across kinds; only the
  behavior around them differs, and that behavior is carried by the workflow (ADR-015), not by the entity
  shape.
- **An artifact is defined by what becomes visible *outside* Autocatalyst when it is approved.** A spec
  is committed to the repository; a bug or chore's authoritative form is the issue-tracker content. Both
  leave the system, so both are artifacts. A review surface that stays *inside* Autocatalyst (a testing
  guide) is a `Publication`, a view-and-feedback surface (see `domain-model`), not an artifact.
- **`Artifact.kind` derives from the workflow.** Since there is a workflow per intent (ADR-016), there is
  effectively a workflow per artifact kind; the kind is a projection of the workflow, derived from it.
- **An artifact attaches to the `Run`** that authors it. A topic's successive runs can author different
  artifacts; the "current" artifact for a topic is its active run's.

## Consequences

**Positive:**
- One model to build, query, and publish; the fields are shared across the kinds.
- The "visible outside Autocatalyst on approval" test separates artifacts (durable, external)
  from publications (ephemeral, internal) without special-casing the bug/chore-as-issue path.
- Behavioral differentiation lives in workflows, where it is already expressed as data, so the artifact
  entity stays simple.

**Negative:**
- A single model must accommodate kind-specific nuances as they arise; a kind that grows a meaningfully
  different shape would need a typed sub-shape (an additive change), not a separate entity.
- "Artifact" carries a precise meaning (externally durable) that must be taught, since a testing guide
  looks artifact-like but is deliberately not one.

## Alternatives considered

### A separate pipeline per kind

Give each kind (feature spec, enhancement spec, bug triage, chore plan) its own entity and its own
pipeline, coordinated by a general workflow graph.

**Pros:**
- Each kind can diverge freely in shape and behavior.
- No shared model to accommodate differences.

**Cons:**
- The kinds do not diverge in *shape*: they share location, status, publication, and issue
  link; only behavior differs, and that is already captured by per-workflow tables.
- Multiplies entities and pipelines for a difference the workflow layer already expresses, which is the
  multiplicity this design otherwise avoids.

**Why not chosen:** the behavioral difference is real but lives in the workflow (ADR-015), so separate
entities buy nothing the workflow does not already provide, at the cost of a pipeline per kind instead
of one.

### Treat the testing guide as an artifact

Model the implementation's testing guide as another artifact kind.

**Pros:**
- One uniform "generated document" model for everything shown to a human.

**Cons:**
- The testing guide is derived from the implementation result and feedback and stays inside the system.
  It is never committed or filed, so giving it the artifact lifecycle (and the "externally durable"
  semantics) misrepresents it.

**Why not chosen:** it fails the defining test (nothing of it becomes externally visible on approval); it
is a `Publication` of the implementation review, not an artifact.
