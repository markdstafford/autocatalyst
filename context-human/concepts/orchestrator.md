---
created: 2026-06-04
last_updated: 2026-06-06
status: active
roadmap: core
---

# Orchestrator

The single authority that mutates scheduling and run state, and the scheduler that turns inbound work
into dispatched runs. It is the one component that admits an inbound event, decides whether it may start
or advance work, creates and transitions runs, and hands execution to the execution plane. This
concept owns **who may mutate** scheduling and run state, the **deduplication gate**, and the
**dispatch loop**. It does not own the `Run` record or its step vocabulary (see `domain-model` and
`run`), the per-step work a run performs (see `run` and `execution-runtime`), or the network surface
that feeds it (see `api`).

## Single authority

Exactly one component mutates scheduling and run state (ADR-003). Creating a run, transitioning its
step, and persisting it all flow through the orchestrator; nothing else writes that state. This keeps
the system race-free without distributed locking, and it aligns with the single-writer store (ADR-004):
one authority over scheduling state, one writer to the database.

## Ingestion through the service interface

Work reaches the orchestrator as classified intake from the **service interface**, the core's typed
contract (ADR-007). That interface has two front-ends, and the orchestrator treats a request the same
whichever one it arrived through:

- The **network API** (ADR-005) is the remote front-end for the desktop app, a mobile app, and external
  clients.
- **In-process adapters** (for example a chat adapter listening over a socket) call the service
  interface directly, with no network hop to their own process.

Ingestion is **push**: a person submitting work or sending a message makes a call into the service. A
poll/`tick` capability is retained as a fallback for sources that have no push mechanism.

## The deduplication gate

Before work is dispatched, the gate enforces the guarantee that an objective is not worked twice: **at
most one active run per topic**, as a durable uniqueness constraint in the store (ADR-014, ADR-004). A
second attempt to open an active run for a topic is rejected by the database; the duplicate is discarded
or attached to the existing run. Because the guarantee lives in the store, it is race-free and survives
a restart, and deduplication is **separate from step transitions**: advancing a run's step is never
used to block a duplicate. At the current single-instance scale the orchestrator also serializes
classification in process, but correctness rests on the constraint rather than on that serialization.

## Creating and transitioning runs

The orchestrator is the only place a run is born and the only path for a step change. It creates a run
under its topic, applies the run's transition rule (`run`) to move it between steps, records each
step occurrence and the sessions that run within it (whose cost rolls up to `(step, role)`,
`domain-model`), and persists the result. Handlers and the
execution plane never write run state directly; they return results that the orchestrator turns into
transitions.

## Dispatch across the `Runner` boundary

For a step that needs a model session, the orchestrator dispatches a self-contained unit of work, the
run's Execution Context (ADR-010), across the **`Runner` boundary** (ADR-003) and consumes the stream
of events and the validated result it returns. The orchestrator schedules and dispatches; the execution
plane runs the agent. By default the `Runner` is an in-process, co-located call, but the orchestrator
always goes through the interface, so execution can be extracted into separate workers without changing
how the orchestrator dispatches.

## Concurrency

The orchestrator bounds how many runs are in flight at once, per host. Over-capacity work waits its turn
rather than exhausting the host. A global or per-tenant fairness bound is a direction for multi-instance
operation; the per-host bound is what the single-host scheduler needs.

## Intent-upgrade at the gate

When an inbound message escalates a topic's objective, the gate **reclassifies** it rather than dropping
it (ADR-016). Where a message to a non-actionable run would otherwise be discarded, the orchestrator
instead starts a new run with the upgraded workflow under the same topic (`run`). The classification of
whether a message is an upgrade belongs to `intents`; the orchestrator acts on the verdict as a
scheduling-state mutation.

## Commands and operator actions

Operator actions — `cancel`, `set-step`, and the like — are authenticated operations on the service
interface, routed through the orchestrator so they preserve the single-authority guarantee (ADR-009).
An emoji or command typed in a chat surface is translated by the adapter into the same service call any
other client makes, so every operator action travels the one authenticated path. `set-step` is a
privileged operation, gated at the policy point.

## Recovery

On load, the orchestrator preserves each non-terminal run, re-registers its conversation, and records
the step where it stopped (`run`). Resuming a run is re-materializing its workspace and re-dispatching
from that stopped step: admitting a stopped run back for dispatch is the orchestrator's part, and
driving the re-created session is the execution plane's (`execution-runtime`).

## Relationships

- `run` — owns the step machine, workflows, and transition rule the orchestrator applies; the
  orchestrator is its sole writer.
- `domain-model` — owns the `Run`, `Topic`, and `RunStep` shapes the orchestrator creates and mutates,
  and the topic-keyed uniqueness the gate relies on.
- `execution-runtime` — receives the Execution Context across the `Runner` boundary and returns events
  and a validated result.
- `api` — exposes the service interface the orchestrator ingests from and the operator actions it
  routes.
- `intents` — classifies inbound messages into a workflow and a `MessageIntent`, including the
  upgrade verdict.

## Constraints and decisions

- One authority mutates scheduling and run state (ADR-003), aligned with the single-writer store
  (ADR-004).
- Deduplication is a durable topic-keyed uniqueness constraint, separate from step transitions
  (ADR-014).
- Ingestion is push through the service interface, with the network API as the remote front-end and
  in-process adapters calling it directly (ADR-005, ADR-007); a `tick` fallback is retained.
- Dispatch goes through the `Runner` interface even in-process (ADR-003), carrying the Execution Context
  (ADR-010).
- Intent-upgrade reclassifies rather than dropping a message (ADR-016).
- Operator actions are authenticated, single-authority-routed service operations (ADR-009).

## Open edges

- **Multi-instance** operation introduces the question of what enforces single-authority across
  processes — the store's constraints and conditional writes are the basis; a leasing or partitioning
  scheme builds on them (ADR-004 names the trigger for Postgres).
- **Global / per-tenant concurrency** fairness, and rate limiting, build on the per-host bound.
- A **dry-run** that traces routing without persisting a run, and a run-scoped profile override at the
  gate, are operator affordances the gate can add without disturbing its core path.
- The full **recover-and-redispatch** handler builds on the recorded stopped step.
