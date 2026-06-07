---
created: 2026-06-07
last_updated: 2026-06-07
status: active
---

# Autocatalyst — central technical overview

Autocatalyst is a headless TypeScript service that runs an AI-led loop from a filed issue to a merged
pull request, together with the surfaces that drive it. This document is the central technical
overview: the system's pieces and the contracts that hold them together, held to a length you can read
first and in full. The product framing — what the loop is for and who uses it — is [app.md](app.md).
The full detail lives one link down, in the [concept index](concepts/index.md) and the
[ADR index](adrs/index.md); this overview points into them and is lossy by design (`docs-model`).

## The composed application

The codebase is an Nx monorepo on pnpm with module boundaries enforced by tooling
([ADR-001](adrs/adr-001-language-runtime.md), [ADR-002](adrs/adr-002-monorepo-tooling.md)). It composes
three pieces:

- **The service** — a headless control plane that holds all state and logic behind a typed network
  API. This is the system's substance, and everything below describes it.
- **The desktop app** — the primary surface, a client over the API. Planned; see app.md.
- **The mobile app** — a lightweight surface for approvals, notifications, and viewing. Planned.

Chat and issue trackers are adapters into the same API rather than separate sources of truth. The
repository layout and the human-owned / agent-owned documentation split are
[architecture](concepts/architecture.md).

## Service shape and planes

A standalone control plane fronts everything behind the network API, and agent execution runs
host-side alongside it, behind a no-shared-memory `Runner` boundary. Extracting execution into
separate workers is a deferred option, taken when execution must scale out or run across hosts. See
[architecture](concepts/architecture.md) and [ADR-003](adrs/adr-003-hosting-and-plane-boundary.md).

## Persistence and the API envelope

The surface is a contract-first REST service plus a Server-Sent-Events stream, served by Fastify, with
every shape declared once as Zod schemas from which types, validation, and the OpenAPI document are
derived. The surface is versioned under a `/v1` prefix and evolves additively within a version.
Durable state lives in SQLite through Drizzle, behind a repository abstraction that keeps a later move
to Postgres on a named trigger, stored as normalized tables for entities and embedded JSON for value
objects. See [api](concepts/api.md), [architecture](concepts/architecture.md), and ADRs
[004](adrs/adr-004-persistence-state-store.md)–[007](adrs/adr-007-shared-types.md),
[019](adrs/adr-019-persistence-layout.md).

## The domain model

The noun layer is the `Conversation` / `Topic` / `Run` / `Message` spine plus the records that hang off
a run: `Artifact`, `Feedback`, `Publication`, `PR`, `RunStep`, `Session`, `TestResult`, and the
`Project` and `Principal` that own them. A `Principal` carries a `kind` of human, model, or system, so
a model reviewer's finding is attributed the same way a person's is. See
[domain-model](concepts/domain-model.md) and ADRs
[013](adrs/adr-013-core-domain-vocabulary.md)–[019](adrs/adr-019-persistence-layout.md).

## Run lifecycle, workflows, and convergence review

A run executes one workflow, pinned for its life and selected from the work's intent (`feature`,
`enhancement`, `bug`, `chore`, `file_issue`, `question`). The lifecycle is a workflow-driven step
machine: steps are code primitives grouped into the `spec`, `implementation`, `docs`, and `pr` phases,
each step carries an intrinsic `waiting_on`, and one rule maps `(workflow, step, directive)` to the
next step. Workflows compose the catalog as data, so several lifecycles coexist without one branching
table. Inside a producing step an `implementer` does the work and a `reviewer` reads the result and
raises findings; they converge over bounded rounds, the implementer decides convergence, and review
can step down through altitudes — layout, public API, private API, then the full build — so design is
agreed before code. Each step's result is verified against its declared shape before downstream logic
runs. See [run](concepts/run.md), [workflow](concepts/workflow.md), [review](concepts/review.md), and
ADRs [015](adrs/adr-015-run-lifecycle.md), [016](adrs/adr-016-intent-model.md),
[025](adrs/adr-025-workflow-step-catalog.md)–[027](adrs/adr-027-step-contract-verification.md).

## The orchestrator

A single authority mutates scheduling and run state, dedups work by topic through a durable
constraint, dispatches across the `Runner` boundary, and bounds concurrency per host. Intake and
operator actions route through it. See [orchestrator](concepts/orchestrator.md).

## Execution runtime and workspaces

Beneath a run, a declarative per-run Execution Context drives an agent session and emits a typed event
stream that the control plane persists and re-streams to clients. Model output is treated as a soft
contract through a tolerance pipeline that normalizes, validates, and asks the agent to fix before it
gives up. Each run gets its own filesystem workspace — a git worktree of the host repository on a
run-owned branch, with a scratch root beside it — that is re-creatable, so a run is never dropped for a
missing workspace, and is torn down per a retention policy keyed to its terminal state. See
[execution-runtime](concepts/execution-runtime.md), [workspace](concepts/workspace.md), and ADRs
[010](adrs/adr-010-agent-execution-context.md), [012](adrs/adr-012-llm-output-tolerance.md),
[020](adrs/adr-020-workspace-isolation-primitive.md),
[021](adrs/adr-021-workspace-lifecycle-reclamation.md).

## Agent runners, model routing, and skills

A runner layer of one connection layer, two mode orchestrators (agent and direct), and one provider
adapter per cell dispatches work symmetrically and keeps provider identity confined to the adapter. A
per-endpoint request-alteration boundary, used by every runner, handles header rewriting, base URL and
auth, timeouts and retries, and redacted logging. Work routes to a model on `(step, role)` for agent
work and `(step)` for direct calls through a declarative table, so a reviewer and an implementer can be
distinct models. A runtime-owned catalog resolves skills and materializes them per backend. See
[agent-runners](concepts/agent-runners.md), [model-routing](concepts/model-routing.md),
[runtime-skills](concepts/runtime-skills.md), and ADRs
[022](adrs/adr-022-runner-structure.md)–[024](adrs/adr-024-role-aware-routing-key.md).

## Intake, feedback, and the human pause

Work enters as resource creation and binds to a conversation, topic, and run; an entry-boundary guard
refuses a submission it cannot resolve to a project rather than dropping it. Each message is classified
into its impact on the run (`create`, `advance`, `revise`, `answer`), and a free-form issue reference
resolves in two stages. `Feedback` is a first-class, run-parented, run-gating record with a per-item
thread, and feedback raised during implementation can amend the still-mutable spec. A single
pause-and-resume mechanism handles human gates, model questions, and convergence escalations. See
[intake](concepts/intake.md), [intents](concepts/intents.md), [feedback](concepts/feedback.md),
[hitl](concepts/hitl.md), and ADRs [016](adrs/adr-016-intent-model.md),
[018](adrs/adr-018-feedback-first-class.md),
[028](adrs/adr-028-spec-amendable-through-implementation.md).

## Trackers, specs, and the docs model

Issue and code-host integration runs through provider-neutral ports, agents read the tracker only
through defined tools and never write it, and a run records the `PR` it opens with a detected merge
status. Titles across commits, PRs, and issues follow one conventional-commit derivation. A spec is a
durable versioned document with a frozen point-in-time form committed under `specs/`, and the wider
corpus is refreshed bottom-up by a compaction step in the `docs` phase, which proposes human-owned doc
diffs at a gate and applies agent-owned context updates directly. See [trackers](concepts/trackers.md),
[spec-lifecycle](concepts/spec-lifecycle.md), [docs-model](concepts/docs-model.md), the
[commit-and-title-conventions](../context-agent/standards/commit-and-title-conventions.md) standard, and
[ADR-029](adrs/adr-029-compaction-doc-update-step.md).

## Observability, cost, and acceptance testing

A two-store model keeps a durable session-grain record of every run in the database, written from the
first run, and ephemeral logs and metrics in an OTLP/Victoria backend through the OpenTelemetry SDK.
Cost is priced per session in integer nano-dollars against a service-owned rate table and rolled up
live by summation. A human test pass is captured as a run-parented `TestResult` built around
`Feedback` and gated before completion. See [observability](concepts/observability.md),
[cost](concepts/cost.md), [acceptance-testing](concepts/acceptance-testing.md), and
[ADR-030](adrs/adr-030-observability-two-store-telemetry.md).

## Commands, micromanager, configuration, and identity

Operator commands are authenticated, channel-agnostic actions that carry a `Principal` on every call,
while informational reads collapse into ordinary API reads. Planning methods — planning, issue triage,
and compaction — are provided by micromanager and invoked rather than built in. Configuration is
service-owned, held in the database and managed through the API, with a minimal bootstrap loader and a
secret store outside it. Identity is wired as a seam: a `Principal` and a policy-decision point are
threaded through the stack now, with one hardcoded principal and a permissive policy, so authentication
and per-repository access control are an additive step. See [commands](concepts/commands.md),
[mm-integration](concepts/mm-integration.md), [settings](concepts/settings.md), and ADRs
[008](adrs/adr-008-config-model.md), [009](adrs/adr-009-auth-rbac-envelope.md),
[011](adrs/adr-011-extension-registry-role.md).

## Status

The architecture decisions and concept docs are settled; the service is pre-implementation. The build
proceeds as a sequence of issues, each a vertically complete capability that lands as one mergeable
pull request. This overview is updated by compaction as the system grows, so its shape and depth change
over time.
