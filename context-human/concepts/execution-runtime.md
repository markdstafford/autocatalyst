---
created: 2026-06-03
last_updated: 2026-06-06
status: active
roadmap: fnd
---

# Execution runtime

Where and how a run's agent work executes. The execution runtime is the layer beneath the run
lifecycle: it takes a unit of work, gives it an isolated environment to act in, drives a
tool-using agent session against that environment while streaming typed events back, validates
what the agent produces, and recovers a run that is interrupted. This concept owns the mechanics
of a run in motion: the `Runner` boundary, the per-run execution context, the event protocol, the
result contract, concurrency, recovery, and how a finished build reaches a human. It does not own
the run's state machine and per-state policy (see `run`), the workspace's own lifecycle of cleanup
and pruning (see `workspace`), runner plurality and provider/model selection (see `agent-runners`
and `model-routing`), or the static topology it sits inside (see `architecture`).

## The two planes and the `Runner` boundary

The control plane is the single authority over scheduling and run state; it decides when a run
may start and assigns it to the execution plane. The execution plane owns the run's workspace and
the agent session that acts in it. A `Runner` interface separates them (ADR-003).

By default the planes run in one process, co-located, so the `Runner` is an in-process call. The
interface assumes no shared memory: the control plane hands the execution plane a self-contained
unit of work and receives back a stream of events and a validated result; it never reaches into
the execution plane's filesystem or memory. This lets execution later be extracted into separate,
centralized workers (a network or queue contract) without changing the contract. Until then, the
no-shared-memory discipline costs nothing and keeps the boundary honest.

## The execution context

Each run executes under a single declarative **Execution Context**, resolved by the control plane
from the run's kind and route, and materialized and enforced by the execution plane (ADR-010). It
is the one place that determines everything the agent's environment contains, so nothing is left
ambient or implicit:

- **The resolved task**: the prompt and task-specific inputs. Operational configuration is input
  the control plane resolves *from*; it is not handed to the agent.
- **A two-root workspace**: a writable **repo** clone (what becomes the diff and the PR) and a
  separate **scratch root** (working files, structured results, run metadata; never committed).
  The two roots are distinct and named, so the agent never confuses "what becomes the change" with
  "the machinery of the run," and ephemeral artifacts never pollute the repository.
- **Per-run secrets**: only the secrets the route requires, injected into the agent's scoped
  environment from the secret store, never drawn from the ambient host environment.
- **A per-run tool policy**: the tools the run may use, resolved from its route.
- **Declared skill/plugin intent**: the skills the run should load; each runner adapter maps the
  intent onto its backend's capability and degrades where a backend does not support it.
- **Provisioned capabilities**: environment affordances the runner sets up: a predictable shell
  (bash), canonical and stable paths the agent reads and writes directly (no host-to-sandbox path
  translation), and a language server (LSP) for the repository's language so the agent reasons
  about code from real signals rather than guesswork.

Least privilege is the model. The initial posture grants broad, non-interactive tool permissions
scoped to the workspace, appropriate to a trusted single host. Tightening to per-run least
privilege and adding network-egress controls is sequenced for hosted/multi-tenant operation, a
sequencing decision rather than an open question (ADR-010).

## Driving an agent session

The runtime drives a tool-using agent by importing an **agent SDK as a library** and consuming
its streaming interface, rather than shelling out to an external CLI of its own. Streaming is
essential: the runtime observes assistant turns, tool activity, and progress *as they happen*,
not just a final exit. The runner contract is a single async generator (a `run()` that yields a
stream of events plus a `close()` for teardown), uniform across runner implementations.

A second, narrower port handles **bounded direct-model calls** (for example, classification),
distinct from the tool-using **agent runner**. Routing resolves which concrete runner a run uses
and how providers and models are selected, owned by `agent-runners` and `model-routing`; this
concept treats the runner as a contract and describes how the runtime drives it.

## The event protocol

A run reports back over a **typed, extensible event stream**, structured rather than free text to
be parsed. The vocabulary carries both mechanics and agent-emitted intent:

- assistant turns and tool activity;
- **structured progress/intent**: a plan (the task list), task-progress (`starting n/m`), and
  notifications tagged by severity (for example, important or error);
- an **importance hint** marking which messages matter to a human;
- **durable step-checkpoints** (below);
- a **terminal result**.

The progress/intent vocabulary is a **soft contract**: the agent emits it best-effort, and the
runtime degrades when a signal is missing or malformed (the stream still works, just with less
structure; see ADR-012). What gets rendered is a control-plane and channel decision, not the
runner's: the runner emits the full typed stream, the control plane persists it and re-streams it
to clients over Server-Sent Events (see `architecture`), and each surface decides what to show. A
desktop progress view may show everything while a chat channel surfaces only important
notifications.

The persisted stream backs live updates and `Last-Event-ID` reconnect for an active run, within the
telemetry retention window; it is not a permanent turn-grain archive. The durable history of a
finished run is the session-grain record (its steps, sessions, cost, outcome, and feedback), owned
by `observability` (ADR-030). A client replaying a run beyond the retention window reads that
session-grain record, not the turn-grain event stream.

## The result contract

A run's structured result is governed by a contract, so downstream logic never consumes malformed
output. Each step declares its expected result as a schema (reusing the shared schema toolchain;
see `architecture` and ADR-007). The agent writes its result into the **scratch root**, and the
runner reads and validates it through a tolerance pipeline (ADR-012):

1. **Deterministic normalization**: safe, unambiguous repairs first (for example, a known
   filename alias, or extracting an identifier from a URL), extensible as patterns are observed.
2. **Schema validation** against the declared contract.
3. **A bounded correction loop**: only if it still does not conform, the agent is asked to fix the
   output *before* the run proceeds on it.
4. **Graceful degradation** for missing optional signals.

The hard rule is that a coercion is applied only when it is deterministic and unambiguous; any
ambiguity falls through to the correction loop rather than a silent guess. Because the control
plane never reads the execution plane's filesystem, the runner reads and validates the
scratch-root result and passes the validated value across the boundary, which keeps a future
execution extraction (no shared disk) a contract-preserving change.

## Concurrency

The runtime is **event-driven**: it reacts to work the single-authority control plane dispatches
rather than waking on a wall-clock schedule. Classification of incoming events is serialized so a
dispatch decision is committed before the next event is processed (the deduplication gate), while
the heavy, tool-using work runs under **bounded concurrency**: a configurable cap on simultaneous
in-flight runs, with queued work promoted as slots free. A periodic tick is not required by this
model, but the option is kept latent for a future need (for example, reconciliation in a hosted
deployment).

## Recovery and resume

Durable run state lives in the control-plane database. The workspace is re-creatable, not the
source of truth; the durable truth is the run's branch plus its checkpointed results. Two
consequences follow:

- A non-terminal run whose workspace is missing is re-materialized, never dropped. Startup
  reconciliation runs against the database, treating a missing workspace as something to re-create
  rather than a lost run.
- Resume means re-materialize the workspace and re-invoke from the last durable checkpoint: the
  run's branch plus its last validated step result. This requires the runner to report per-step
  durable checkpoints as it goes, which also feeds richer run history. True in-flight resume of an
  interrupted agent session is not available from the SDKs today and is a named open edge;
  re-invoke-from-checkpoint is the resume the runtime provides.

Which states resume from a step versus start over is **per-state policy owned by `run`**; this
concept provides the mechanism that makes either possible.

## Delivering a build to a human

Reviewing a produced build is a core human touchpoint, served two ways (see `architecture` and
`acceptance-testing`):

- **Previewing** a diff or what will go into a PR is served over the API, with no local copy needed.
- **Running and testing** a build is served by a **shallow clone of the host workspace** to the
  local machine, managed by the desktop/mobile app.

During a run, an agent that needs a human decision uses an **exit-and-re-invoke** pattern: it
ends with a structured question rather than guessing, the control plane surfaces it, and a human
reply re-invokes the agent with the answer as added context.

## Execution-plane infrastructure

The path between a runner and a model provider is a seam where provider-compatibility concerns
live — for example, filtering or rewriting provider request headers and handling gateway-specific
timeouts. Isolating these at the execution-plane boundary keeps provider quirks out of the control
plane and the agent.

## Relationships

- `architecture` — the static topology, the `Runner` boundary's structural enforcement, the API
  and SSE transport that re-streams events, and persistence.
- `run` — the run entity and state machine this runtime advances; per-state recovery policy.
- `workspace` — the per-run clone and branch a run executes against, and workspace cleanup/pruning.
- `acceptance-testing` — the human-test step and result capture that consume the build this runtime
  produces.
- `agent-runners` and `model-routing` — runner plurality and provider/model selection behind the
  runner contract.

## Constraints and decisions

- **No shared memory across the `Runner` boundary** — so execution can later be extracted without
  changing the contract (ADR-003).
- **One declarative execution context per run**, resolved by control and enforced by execution
  (ADR-010); least privilege is the model, with hardening sequenced.
- **Two-root workspace** — repo (becomes the diff) and scratch (ephemeral), always distinct.
- **Typed event stream with a soft-contract intent vocabulary**; rendering is decided downstream.
- **Result contract with a tolerance pipeline** — normalize, validate, bounded fix-loop, degrade;
  never silently guess (ADR-012).
- **The workspace is re-creatable; a run is never dropped for a missing workspace** — resume is
  re-invoke-from-last-durable-checkpoint.
- **Single-authority, event-driven dispatch** with bounded concurrency.

## Open edges

- **Execution extraction** — promoting the in-process `Runner` boundary to a network/queue contract
  for centralized, scalable, isolated execution workers; the file-based scratch result becomes a
  transmitted validated message.
- **True agent-session resume** — resuming an interrupted SDK session in place, if backends support
  it.
- **A hardened sandbox** — containers, network-egress controls, and per-run least-privilege
  enforcement, sequenced for hosted/multi-tenant operation.
- **Session granularity** — splitting a run's planning and execution into separate agent sessions;
  the runtime's contract permits it, and where the boundary sits is a `run`/workflow decision.
