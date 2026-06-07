---
created: 2026-06-06
last_updated: 2026-06-07
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-025: Workflow step catalog and composition

## Status

Accepted

## Context

A run advances by step over a workflow-driven table (ADR-015), and several work kinds
(`feature`, `enhancement`, `bug`, `chore`, `file_issue`, `question`) need different paths
without one branchy table. ADR-015 fixed the machine and the working catalog but left the catalog's
content and the per-kind composition to settle. This decision settles them, against three constraints.

The implementation phase must support incremental convergence (ADR-026) at a depth that varies by
work kind. A complex feature wants finer convergence steps; a small chore wants none. The catalog has to
express both without a separate pipeline per kind.

A step is a unit of work that recurs and is referenced by stored records and routing entries. A
step is named, its occurrences are timeline rows, and routing keys on `(step, role)` (ADR-024). A
step is therefore a durable, code-level thing, while the order it runs in varies per run.

The spec phase produces an `Artifact` but is still the `spec` phase. The phase is named `spec`, so
the steps inside it read most clearly when their names match the phase.

Not every workflow produces an `Artifact`. `file_issue` files issues to the tracker and `question`
returns a response; neither authors a committed artifact. Filing is also a tracker write, and agents
never write the tracker (`trackers`), so `file_issue` needs a deterministic step of its own for the
write.

This ADR decides the catalog's content, how a workflow composes it, how the implementation phase's depth is
expressed, and how the spec freeze and the final review sit relative to opening the PR.

## Decision

**A step is a code primitive; a workflow is data composing an ordered subset of the catalog; the catalog
groups by phase; implementation depth is configurable workflow data; `build` completes the implementation
from agreed branch state; `pr.finalize` is the final `ai` reviewer pass, with the spec freeze a
deterministic side effect of its validated result; and `file_issue` writes the tracker through a
deterministic `issues.file` step.**

- **Steps are code; workflows are data.** Each step (`spec.author`, `implementation.build`, …) is an
  implemented unit. A workflow is a data-defined ordered subset of the shared catalog with its
  transitions. There is one shared catalog and workflows compose from it freely: subsets may overlap,
  and a step may be used by only one work kind.
- **The catalog groups by phase**, and the spec-phase steps are prefixed `spec.*` to match the `spec`
  phase: `intake`; `spec.author`, `spec.awaiting_input`, `spec.human_review`; `implementation.plan`,
  `implementation.build`, `implementation.awaiting_input`, `implementation.human_review`; `docs.update`,
  `docs.human_review` (ADR-029); `pr.finalize`, `pr.open`, `pr.human_review`; `issues.file`;
  `question.answer`; `done` / `canceled` / `failed`. `phase` is an explicit attribute on each step,
  authoritative over the prefix.
- **`build` is the closing implementation step:** it completes the implementation given whatever is
  already agreed on the branch. Finer precursor steps (for example `implementation.define_classes`,
  `implementation.define_public_api`) are optional; when present they commit agreed class shells and
  interfaces, and `build` starts from those and fills in the bodies. When absent, `build` does the whole
  change. Every implementation path ends on `build`.
- **Implementation depth is configurable workflow data.** A workflow composes as many or as few
  convergence steps as the work warrants. The granular path is built first; the coarse `build`
  serves `bug` and `chore`. A complexity classification placed after planning, which picks the granular
  or coarse continuation, is a deferred conditional branch the transition rule is designed to express
  but is not built now.
- **`pr.finalize` is the final `ai` reviewer pass, separate from `pr.open`.** It runs the lighter
  security and PR-readiness review over the final branch state. Freezing the artifact (writing the
  shipped frontmatter, committing the final version) is a deterministic side effect the orchestrator
  applies once that reviewer result is validated, on the way to `pr.open`, so the step keeps a single
  `waiting_on: ai` (ADR-015). `pr.open` opens the PR and generates the title. A material change at
  `pr.finalize` routes the run back to `implementation.human_review`.
- **`file_issue` writes the tracker through a deterministic `issues.file` step.** `file_issue` composes
  `intake -> spec.author -> issues.file -> done`: `spec.author` triages and enriches the items, and
  `issues.file` is a `system` step that performs the tracker write, so no agent writes the tracker
  (`trackers`). `file_issue` authors no `Artifact`; it records each filed issue as a run-to-issue
  reference (`domain-model`).
- **`revise` means "go back to where the workflow table designates."** For most steps that is the
  producing step; for `pr.finalize` it is the implementation gate. The directive vocabulary stays at the
  five values of ADR-012/ADR-015; backward edges are ordinary table data.

## Consequences

**Positive:**
- Several genuinely different paths are small data tables over one code-level catalog, and a new work
  kind is a new table.
- Adding a finer implementation step is additive (a new code unit referenced by workflow data), because
  the convergence loop is shared machinery a finer step reuses.
- Depth is tuned per work kind without branching code, and the coarse and granular paths share one
  `build` with one meaning.
- The final review has an explicit home distinct from opening the PR, the spec freeze rides its
  validated result, and `pr.finalize` keeps a single `waiting_on`.
- Filing issues is a deterministic tracker-write step (`issues.file`), so "agents never write the
  tracker" holds mechanically rather than by convention.

**Negative:**
- A conditional branch (the complexity classifier) is a capability the transition rule must grow when it
  is built; the straight-line table does not express it yet.
- Carrying `phase` explicitly is a small redundancy where the prefix already implies it for the
  implementation steps.
- The catalog is a working catalog, so some finer steps are named before they are exercised.

## Alternatives considered

### A separately coded pipeline per work kind

Give `feature`, `bug`, and `chore` each its own hand-coded path.

**Pros:**
- Each kind's behavior is local to its own code.

**Cons:**
- It is the arrangement that produced one growing set of conditionals, and it makes a new kind a new code
  path rather than a new data table.
- Shared behavior (the converge loop, the gates) is duplicated across pipelines.

**Why not chosen:** The kinds differ in which steps they compose and in per-step policy, not in machinery,
so data-defined workflows over one catalog express the difference without duplicated code.

### A fixed fine-grained implementation phase

Make every implementation always run `plan -> define_classes -> define_public_api -> build`.

**Pros:**
- Every run gets the full incremental-convergence treatment with no decision to make.

**Cons:**
- It assumes a class-based code shape that does not fit a small chore or a configuration change.
- It multiplies cost and latency for work that does not need it.

**Why not chosen:** Depth that varies by work kind delivers incremental convergence where it pays and
stays cheap where it does not, and the finer steps remain available to compose.

### A fixed coarse implementation phase

Make every implementation run `plan -> build`, with `build` converging on the whole change at once.

**Pros:**
- The fewest steps and the simplest table.

**Cons:**
- A single whole-change review is close to reviewing a finished result after the fact, which misses the
  early structural review that incremental convergence is for.

**Why not chosen:** Some work benefits from agreeing on the shape before the bodies exist, which a single
`build` step cannot provide; configurable depth keeps that option.
