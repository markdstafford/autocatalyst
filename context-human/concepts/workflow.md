---
created: 2026-06-06
last_updated: 2026-06-07
status: active
roadmap: flow
---

# Workflow

This concept defines what fills the run machine: the catalog of step primitives and how each one
behaves, the roles a step carries, the implementer-reviewer convergence inside a producing step and the
bound on its rounds, how a gate works, and how a workflow composes the catalog as data. `run` owns the
machine itself: the step list as a vocabulary, the `next(workflow, step, directive)` rule, and resume.
This concept owns the content those mechanics move through. It hands the per-round review exchange to
`review`, the pause-and-resume semantics at a `human` step to `hitl`, and the `Feedback` entity shape to
`domain-model`.

## Steps are code, a workflow is data

A **step** is an implemented code primitive — `spec.author`, `implementation.build`, and the rest are
each a unit of work with a definite behavior. A **workflow** is data: an ordered subset of one shared
step catalog together with the moves between those steps. Each work kind — `feature`, `enhancement`,
`bug`, `chore`, `file_issue`, `question` — is its own workflow, composing the steps it needs and the
transitions among them.

There is one shared catalog, and workflows compose from it freely. Two workflows may overlap on the
same steps, and a step may be used by only one work kind; neither is forced. A lighter chore composes a
short path straight into implementation; a feature composes the full path through spec, implementation,
and the pull request. The kinds differ in which steps they compose and in per-step policy, not in
machinery, so a small data table per kind expresses every path without a branching code path or a
hand-coded pipeline per kind (ADR-025).

## The step catalog

The catalog groups by phase. The spec-phase steps carry the `spec.*` prefix to match the `spec` phase;
`phase` is an explicit attribute on each step, authoritative over the prefix. A step's `waiting_on`
(`system`, `ai`, `human`, `none`) is the intrinsic property `run` reads behavioral sets from.

| Step | Phase | `waiting_on` | Roles |
| --- | --- | --- | --- |
| `intake` | — | `system` | — |
| `spec.author` | `spec` | `ai` | implementer + reviewer |
| `spec.awaiting_input` | `spec` | `human` | — |
| `spec.human_review` | `spec` | `human` (gate) | — |
| `implementation.plan` | `implementation` | `ai` | implementer |
| `implementation.build` | `implementation` | `ai` | implementer + reviewer |
| `implementation.awaiting_input` | `implementation` | `human` | — |
| `implementation.human_review` | `implementation` | `human` (gate) | — |
| `docs.update` | `docs` | `ai` | implementer |
| `docs.human_review` | `docs` | `human` (gate) | — |
| `pr.finalize` | `pr` | `ai` | reviewer |
| `pr.open` | `pr` | `system` | — |
| `pr.human_review` | `pr` | `human` (gate) | — |
| `issues.file` | — | `system` | — |
| `question.answer` | — | `ai` | implementer |
| `done` / `canceled` / `failed` | — | `none` | — |

- **`intake`** classifies the inbound work and selects the workflow the run pins for its life (`run`).
- **`spec.author`** produces the artifact (a feature spec, an enhancement spec, a bug triage, a chore
  plan) and carries both an implementer and a reviewer role; the two converge within the step before a
  person sees the result.
- **`spec.awaiting_input`** is a within-phase pause when the work needs a person mid-step (a model
  question, a convergence escalation). It is not a gate.
- **`spec.human_review`** is the spec gate: a person reviews the artifact and approves the run forward
  or sends it back. Approval here means "build from this" rather than a freeze; the artifact stays a
  working document through implementation, and `pr.finalize` is the single freeze.
- **`implementation.plan`** produces the implementation plan in the workspace scratch area.
- **`implementation.build`** completes the implementation from the agreed branch state and carries an
  implementer and a reviewer role.
- **`implementation.awaiting_input`** is the implementation-phase within-phase pause.
- **`implementation.human_review`** is the implementation gate.
- **`docs.update`** refreshes the durable docs bottom-up by invoking compaction: it proposes the
  human-owned doc changes (concept docs, ADRs, `spec.md`) as a **`DocDiffProposal`** and applies the
  agent-owned `context-agent` updates directly (ADR-029, `domain-model`).
- **`docs.human_review`** is the docs gate: a person approves the `DocDiffProposal`, dispositioning any
  `docs`-target feedback raised against it. When compaction proposes no human-owned change, the
  `DocDiffProposal` is empty, nothing holds the gate, and it advances without pausing (ADR-029).
- **`pr.finalize`** runs the security and pull-request-readiness review (an `ai` reviewer pass);
  freezing the artifact is a deterministic side effect of its validated result (below).
- **`pr.open`** opens the pull request and generates its title.
- **`pr.human_review`** is the pull-request gate: a person merges.
- **`issues.file`** is the deterministic `system` step that writes triaged items to the tracker in the
  `file_issue` workflow, so no agent writes the tracker (`trackers`, `run`).
- **`question.answer`** runs the answer in the standalone `question` workflow and advances to `done`,
  recording its own session and cost. A question asked while another run is waiting is the separate
  no-op `answer` directive that responds without moving that run (`run`, `intents`).
- **`done` / `canceled` / `failed`** are terminal; `canceled` keeps an operator stop distinct from a
  failure.

## `build` is the closing implementation step

`build` completes the implementation given whatever is already agreed on the branch. Finer precursor
steps such as `implementation.define_classes` and `implementation.define_public_api` are optional; when
a workflow composes them, they commit agreed class shells and interfaces, and `build` starts from those
and fills in the bodies. When a workflow composes none, `build` does the whole change. Every
implementation path ends on `build`. This works because steps hand off through the branch and workspace
rather than in-memory values, the same way resume re-materializes a stopped run (`run`).

Implementation depth is configurable workflow data: a workflow composes as many or as few convergence
steps as the work warrants. The granular path (`plan`, `define_classes`, `define_public_api`, `build`)
carries the most design weight and suits a feature; the coarse path (`plan`, `build`, or just `build`)
serves `bug` and `chore`. A complexity classification placed after planning, which picks the granular
or coarse continuation, is a deferred conditional branch the transition rule is designed to express,
taken when a workflow needs it; the straight-line tables stand without it (ADR-025, ADR-026).

## Roles and convergence within a step

A step carries one or more **roles** (`run`). A producing step (`spec.author`, `implementation.build`)
carries an `implementer` role and a `reviewer` role. The implementer produces the work; the reviewer
reads the committed branch state and either signals satisfaction or raises findings. The two exchange
in bounded **rounds** within the one step until the work converges, rather than the reviewer reacting
to a finished result after the fact (ADR-026).

The implementer decides convergence: the reviewer surfaces findings, the implementer disposes of each
by fixing it or declining it with a recorded reason, and the step is converged when the implementer
judges nothing worth fixing remains. The reviewer advises and never edits. `review` owns the per-round
mechanics — what one round contains, how a finding is recorded and disposed, and convergence authority.
This concept owns where the reviewer role sits and that a step with a reviewer role advances on
convergence or escalates on exhaustion.

A producing step also bears a **max rounds** bound: per-step workflow data, configurable, defaulting
to three. When the exchange reaches it without converging, the step does not advance on its own. It
escalates to a person at the matching `*.awaiting_input` step, carrying the open findings and both last
positions, and resumes on the reply (`hitl`). The bound guarantees a step terminates instead of
looping unboundedly.

When a step carries a reviewer role but routing cannot resolve a model distinct from the implementer's,
the review still runs with the same model and emits a warning that it is not adversarial; a fresh
session with no memory of the implementer's reasoning still adds value (`model-routing`). A step with
no reviewer role runs the implementer and advances; that is the coarse case, not a degraded one.

## Gates

A **gate** is a `human` step between phases: `spec.human_review`, `implementation.human_review`,
`docs.human_review`, `pr.human_review`. Each maps to one `Feedback` target — `artifact`,
`implementation`, `docs`, `pr` (`domain-model`). `spec.human_review`, `implementation.human_review`,
and `pr.human_review` always require an explicit human approval to advance, even with zero open
feedback; the run sits at the gate until an inbound message reduces to a directive (`run`, `hitl`).
`docs.human_review` is the one skip-when-empty gate: it advances without pausing when its
`DocDiffProposal` carries no human-owned change, because there is nothing to review — not because "no
feedback" counts as approval (ADR-029). A gate carries no cost record.

A gate advances only when every `Feedback` item for its target is dispositioned (resolved or set
aside), so sign-off has meaning: a run cannot leave a gate, or reach `done`, with open feedback for that
review (ADR-018, `domain-model`). The reviewer findings a producing step disposed of inside its
convergence loop are visible at the following gate as the final check, since the implementer, not the
reviewer, decided what shipped.

## The docs phase

Between the implementation gate and the pull request, a `docs` phase refreshes the durable docs against
the change the run made. `docs.update` invokes compaction; `docs.human_review` approves any human-owned
doc diffs and advances without pausing when there are none (ADR-029). The phase composes into the
workflows that carry an implementation and a pr phase (`feature`, `enhancement`, `bug`, `chore`), not
onto `question` or `file_issue`, which produce nothing to compact. Within those workflows it runs on
every run with no per-feature opt-out; the skip-when-empty gate keeps a change that moves no doc
friction-free. The doc changes land on the run's branch, so `pr.finalize` then freezes the spec and
summarizes a change set that already includes them.

## The pull-request phase and `revise`

The `pr` phase splits the final review from opening. `pr.finalize` is an `ai` reviewer pass over the
final branch state for security and pull-request readiness — a different view from the build reviewer,
which watches the work form rather than reading the settled result. Freezing the artifact (setting the
spec frontmatter to its shipped state and committing the final version) is a deterministic effect the
orchestrator applies once that reviewer result is validated, before `pr.open`, not a second `waiting_on`
on the step. `pr.open` then opens the pull request and generates the title.

The implementation result the run carries (an embedded value object, `domain-model`) is maintained
**cumulatively** across implementer rounds: each round folds its delta in rather than replacing the
prior. So `pr.finalize` reconciles a summary of the whole change set against the final branch state, and
the PR description `trackers` opens reflects every round the run took, not only the last.

A `revise` directive means "go back to where the workflow table designates." For most steps that is the
producing step the work came from. For `pr.finalize`, a material or user-visible finding routes `revise`
back to `implementation.human_review` so the change is re-approved; on re-approval the run returns
through `pr.finalize`. The directive vocabulary stays at its five values (`run`, ADR-012); a backward
edge is ordinary table data the transition rule carries (ADR-025).

## The command path

A deterministic path runs alongside the path classification chooses. A command (an authenticated
operator action such as cancel, set-step, or archiving a run) dispatches directly to its handler with no
model in the path, so a structured action with unambiguous intent avoids classification latency and its
failure mode. This concept owns only that the two paths run side by side; the command catalog, its
authentication, and its API surface belong to `commands` and `orchestrator`.

## A working catalog

The catalog is a working catalog rather than a frozen list. Adding a primitive is additive: a new code
unit plus a reference from workflow data, with the convergence loop a shared piece of machinery the
finer step reuses. Removing or renaming a primitive is bounded but costlier, because it touches the
workflows that reference it, the stored `RunStep` step identifiers, and the `(step, role)` routing
entries. The locked frame is therefore the phase boundaries, the phase gates, review-as-a-role, and the
session cost model rolled up to `(step, role)`; the exact implementation-phase steps stay extensible
(ADR-025).

## Relationships

- `run` — owns the step machine this concept fills: the step vocabulary and `waiting_on`, the
  `next(workflow, step, directive)` rule, and resume from a recorded step.
- `review` — owns the per-round convergence mechanics inside a producing step: a round's contents, how
  a finding is recorded and disposed, and convergence authority. This concept owns where the reviewer
  role sits and the max-rounds bound.
- `hitl` — owns pause-and-resume at a `human` step: the payload per pause, the valid reply directives,
  and that a reply re-dispatches. This concept owns where gates and `*.awaiting_input` steps sit.
- `domain-model` — owns the `Feedback`, `Artifact`, `RunStep`, and `Session` shapes a step produces
  and the gate reads.
- `intents` — classifies an inbound message into the workflow at `intake` and into the directive a gate
  acts on.
- `model-routing` — resolves the model for each `(step, role)`, including a reviewer role distinct from
  its implementer.
- `commands` / `orchestrator` — own the command catalog and the operator-action authentication the
  deterministic path uses.

## Constraints and decisions

- Steps are code primitives; a workflow is a data-defined ordered subset of one shared catalog; each
  work kind is its own workflow (ADR-025).
- The catalog groups by phase, the spec-phase steps are prefixed `spec.*`, and `phase` is an explicit
  step attribute authoritative over the prefix (ADR-025).
- `build` is the one closing implementation step; finer precursor steps are optional and seed the
  branch; implementation depth is configurable workflow data (ADR-025, ADR-026).
- A producing step converges its implementer and reviewer roles in bounded rounds within the step and
  advances on convergence or escalates on exhausting max rounds (ADR-026).
- A gate cannot be left with open feedback for its target; sign-off requires every item dispositioned
  (ADR-018).
- `pr.finalize` is the final `ai` reviewer pass; the spec freeze is a deterministic side effect of its
  validated result, applied before `pr.open`; a material finding routes `revise` to
  `implementation.human_review` (ADR-025).
- `revise` goes back to wherever the workflow table designates, carried as table data within the
  five-value directive vocabulary (ADR-025, ADR-012, ADR-015).
- The workflow selects the artifact kind, since there is a workflow per work kind (ADR-016, ADR-017).

## Open edges

- A **complexity classification** after planning that picks the granular or coarse continuation is a
  conditional branch the transition rule is designed for; it lands when the in-run classifier is built.
- **Parallel reviewers** in one producing step are expressible as independent sessions; one reviewer per
  step is the starting point.
- **A model at a gate** stays possible (a gate can carry a placeholder cost record), but the gates are
  human today.
- **Finer implementation steps** beyond `define_classes` and `define_public_api` compose additively as
  the work that needs them arrives.
- **New workflows** (a brainstorm, a prototype, or a new-application path) are additive tables over
  the same catalog, each selected by a new work kind.
