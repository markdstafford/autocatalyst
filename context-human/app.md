---
created: 2026-05-31
last_updated: 2026-06-07
status: active
---

# Autocatalyst

Autocatalyst runs an AI-led loop from idea to merged code, and reserves the human for the few
decisions that need judgment. This document is the product overview: what the system is and why it
exists. The central technical overview, maintained by compaction, is `spec.md` (`docs-model`); it and
the [concept index](concepts/index.md) and [ADR index](adrs/index.md) map into the detail.

## What

A person seeds an idea, most often "work on issue N". The system turns it into a structured spec and
presents it for approval. On approval a coding agent implements and verifies the change, and the person
tests the build and gives feedback if something is off. A docs phase then refreshes the durable docs,
pausing for approval only when compaction proposes a human-owned doc change. The person merges or
approves the pull request to finish. The human's decision points are: seed the idea, approve the spec,
test the implementation, approve any human-owned doc changes, and merge the PR — the docs review skips
when there is nothing to review.

Autocatalyst is a purpose-built harness for that one development loop, opinionated at every stage,
rather than a general-purpose coding assistant. A headless service holds the state and the logic; a
dedicated desktop and lightweight mobile app are the primary surfaces; chat and issue trackers are
adapters into the same loop.

## Why

Human attention is the scarcest resource in software development, and the most valuable use of it is
the work AI does not do well: deciding what matters, developing taste for what a good product feels
like, and judging whether a feature actually works for a real user. Autocatalyst hands the execution
loop — spec drafting, implementation, verification — to AI and keeps human attention for the
decisions that compound: what to build, whether the design is right, and whether the result is good.

## Personas

- **Phoebe (PM)** seeds ideas, writes briefs, and approves specs before implementation.
- **Enzo (Engineer)** reviews technical specs, tests completed work, and gives implementation feedback.
- **Dani (Designer)** reviews design decisions, assesses usability, and seeds ideas grounded in user
  experience.

The system runs single-operator today, with the identity and tenancy seam in place so multi-user
collaboration across these personas is an additive step rather than a teardown.

## How the loop runs

A person's interaction with Autocatalyst is a `Conversation`. Within it, each focused objective is a
`Topic` ("ship feature X", "fix bug Y"), and each attempt at a topic is a `Run`. `Message`s flow
through a topic in both directions. A run executes one **workflow**, pinned for its life and selected
from the work's intent: `feature`, `enhancement`, `bug`, `chore`, `file_issue`, or `question`.

A run advances through **steps**, grouped into **phases** — `spec`, `implementation`, `docs`, `pr` —
each closed by a human-review **gate**. A **session** is one model's single go and is the unit cost is
priced at. Within a producing step, two **roles** converge: an `implementer` does the work and a
`reviewer` reads the result and raises findings, so a person reviews work the model reviewer has
already passed. Review comments become tracked `Feedback` items, and a run cannot leave a gate, or
reach `done`, while that review has open feedback. The full path for a feature runs from intake
through the spec, implementation, docs, and pr phases to `done`; smaller kinds compose fewer steps. A
standalone `question` run answers and finishes; a question asked while another run is waiting is
answered without moving that run.

## Architecture

The decisions below are settled in `concepts/` and `adrs/`. Each paragraph is the short version with a
link down to the full contract.

**The service and its planes.** A standalone control plane fronts everything behind a network API,
and agent execution runs host-side alongside it, behind a no-shared-memory `Runner` boundary.
Extracting execution into separate workers is a deferred option, taken when execution must scale out
or run across hosts. See [architecture](concepts/architecture.md) and
[ADR-003](adrs/adr-003-hosting-and-plane-boundary.md).

**The domain model.** The noun layer is the `Conversation`/`Topic`/`Run`/`Message` spine plus the
records that hang off a run: `Artifact`, `Feedback`, `Publication`, `PR`, `RunStep`, `Session`,
`TestResult`, and the `Project` and `Principal` that own them. See
[domain-model](concepts/domain-model.md) and ADRs
[013](adrs/adr-013-core-domain-vocabulary.md) to [019](adrs/adr-019-persistence-layout.md).

**The run lifecycle.** The lifecycle is a workflow-driven step machine: each step carries an intrinsic
`waiting_on`, workflows are described transition tables over a catalog of step primitives, and one
rule maps `(workflow, step, directive)` to the next step. See [run](concepts/run.md) and
[ADR-015](adrs/adr-015-run-lifecycle.md).

**Workflows and convergence review.** Workflows compose the step catalog as data, so several
lifecycles coexist without one branchy table. Inside a producing step the implementer and reviewer
converge over bounded rounds, the implementer decides convergence, and each step's result is verified
against its declared shape before downstream logic runs. See [workflow](concepts/workflow.md),
[review](concepts/review.md), and ADRs
[025](adrs/adr-025-workflow-step-catalog.md) to [027](adrs/adr-027-step-contract-verification.md).

**The orchestrator.** A single authority mutates scheduling and run state, dedups work by topic, and
dispatches across the `Runner` boundary. Intake and operator actions route through it. See
[orchestrator](concepts/orchestrator.md) and [ADR-009](adrs/adr-009-auth-rbac-envelope.md).

**Execution runtime and workspaces.** Beneath a run, a declarative per-run Execution Context drives an
agent session and emits a typed event stream. Each run gets its own filesystem workspace — a git
worktree of the host repository on a run-owned branch — that is re-creatable, so a run is never
dropped for a missing workspace. See [execution-runtime](concepts/execution-runtime.md),
[workspace](concepts/workspace.md), and ADRs
[010](adrs/adr-010-agent-execution-context.md), [020](adrs/adr-020-workspace-isolation-primitive.md),
[021](adrs/adr-021-workspace-lifecycle-reclamation.md).

**Agent runners, model routing, and skills.** A runner layer of one connection layer, two mode
orchestrators (agent and direct), and one provider adapter per cell dispatches work symmetrically and
keeps provider identity confined to the adapter. Work routes to a model on `(step, role)` through a
declarative table, and a runtime-owned catalog provisions skills per backend. See
[agent-runners](concepts/agent-runners.md), [model-routing](concepts/model-routing.md),
[runtime-skills](concepts/runtime-skills.md), and ADRs
[022](adrs/adr-022-runner-structure.md) to [024](adrs/adr-024-role-aware-routing-key.md).

**The API and persistence.** The surface is a typed contract-first REST service plus an SSE event
stream, with all shapes declared once as Zod schemas. Durable state lives in SQLite through Drizzle,
behind a repository abstraction, as normalized tables for entities and embedded JSON for value
objects. See [api](concepts/api.md), ADRs
[004](adrs/adr-004-persistence-state-store.md) to [007](adrs/adr-007-shared-types.md), and
[019](adrs/adr-019-persistence-layout.md).

**Intake, feedback, and the human pause.** Work enters as resource creation and binds to a
conversation, topic, and run; each message is classified into its impact on the run. `Feedback` is a
first-class, run-gating record, and a single pause-and-resume mechanism handles gates, model
questions, and convergence escalations. See [intake](concepts/intake.md), [intents](concepts/intents.md),
[feedback](concepts/feedback.md), [hitl](concepts/hitl.md), and ADRs
[016](adrs/adr-016-intent-model.md), [018](adrs/adr-018-feedback-first-class.md),
[028](adrs/adr-028-spec-amendable-through-implementation.md).

**Trackers, specs, and the docs model.** Issue and code-host integration runs through provider-neutral
ports, and a run records the `PR` it opens. A spec is a durable versioned document with a frozen
point-in-time form, and the wider corpus is maintained bottom-up by a compaction step in the `docs`
phase. See [trackers](concepts/trackers.md), [spec-lifecycle](concepts/spec-lifecycle.md),
[docs-model](concepts/docs-model.md), and [ADR-029](adrs/adr-029-compaction-doc-update-step.md).

**Acceptance testing, cost, and observability.** A human test pass is captured as a run-parented
result built around `Feedback` and gated before completion. Cost is priced per session in integer
nano-dollars and rolled up live by summation. A two-store model keeps a durable session-grain record
in the database and ephemeral logs and metrics in an OTLP/Victoria backend. See
[acceptance-testing](concepts/acceptance-testing.md), [cost](concepts/cost.md),
[observability](concepts/observability.md), and [ADR-030](adrs/adr-030-observability-two-store-telemetry.md).

**Commands and micromanager.** Operator commands are authenticated, channel-agnostic actions carrying
a `Principal` on every call. Workflow and planning methods — planning, issue triage, and compaction —
are provided by micromanager and invoked rather than built in. See
[commands](concepts/commands.md) and [mm-integration](concepts/mm-integration.md).

## Narratives

**A small idea, end to end.** Enzo notices first-time users struggle with a CLI's initial
configuration. He seeds it in a sentence. Within a minute the spec is drafted, and he pushes back on
one point: the wizard should not require every setting up front. His comment becomes a feedback item,
the run revises the spec, and he approves. Twenty minutes later the build is ready and tests pass. He
runs it and flags one confusing setting; the run proposes a fix, he confirms, and the second build is
right. Idea to merged feature in under an hour, with two sentences written and two tests run.

**A large idea, shaped over days.** Phoebe seeds a paragraph describing composable workflows — a new
data model, UI, and API surface. The first-draft spec lists open questions; she answers several and
brings Enzo and Dani in on the rest, each as a reviewer whose comments land as feedback on the run.
Dani is not convinced by the composition UI, and that takes a working session to resolve. Phoebe feeds
the result back in, the run incorporates the decisions, and the team approves on the second day.
Implementation runs across parallel agents; testing surfaces a usage assumption the spec never
considered, the spec is amended, and the second implementation ships.

**The loop improves itself.** After that restart, the system flags the pattern: a spec was approved
without surfacing a usage assumption. During a later docs phase it extends the spec template to
include a usage-assumptions section and begins populating it from the idea, codebase context, and
prior feedback. The next spec Phoebe reviews has the section filled in; she corrects one assumption
and approves, and the implementation ships on the first try.

## Finding your way

`AGENTS.md` is the entry point and map. From it, the hubs are the central overview `spec.md`, the
[concept index](concepts/index.md), and the [ADR index](adrs/index.md); this product overview frames
the what and why, and from a hub each concept doc and ADR holds the full detail. Read top-down and go
only as deep as the task needs.
