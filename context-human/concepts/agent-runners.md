---
created: 2026-06-05
last_updated: 2026-06-06
status: active
roadmap: ai
---

# Agent runners

The concrete machinery that drives a model backend behind the `Runner` contract. A run's work reaches
a provider in one of two ways, a tool-using **agent session** or a bounded **direct-model call**,
across more than one provider family. This concept owns **runner plurality and everything around it**:
the structure that factors those behaviors, the connectivity configuration a runner needs to reach a
provider, the boundary where provider-compatibility concerns are handled, how a runner drives a
session and emits its typed events and telemetry, and how a runner applies the run's declared tool and
skill intent to its backend.

It does **not** own the `Runner` contract itself or the result-tolerance pipeline (see
`execution-runtime`), which model or runner a route resolves to (see `model-routing`), the skills
catalog and the route-to-skill mapping (see `runtime-skills`), the workspace (see `workspace`), or
cost semantics (see `cost`). It emits the metadata those concepts consume; it does not assemble their
records.

## Runner structure

The runner layer is one **connection layer**, two **mode orchestrators**, and one **provider adapter**
per provider-and-mode cell (ADR-022).

- The **connection layer** is shared by every runner. It resolves an endpoint and credential into a
  provider client, routes traffic through the request-alteration boundary, threads the telemetry
  context, and emits uniform structured logging.
- The two **mode orchestrators** — one for agent work, one for direct calls — are each written once
  and parameterized by a provider adapter, so the two agent runners are a single implementation and
  the two direct runners are a single implementation.
- The **provider adapter** is the one place a provider's identity appears.

Dispatch selects an adapter by the resolved profile's provider, so every provider is reached through
its own adapter on equal footing. Each adapter imports its provider SDK as a library and consumes its
interface in-process, which gives the orchestrator direct control of the event stream and the session
lifecycle.

## The mode orchestrators

The **agent orchestrator** drives a tool-using session: it starts the session through its adapter,
consumes the typed event stream, validates the result through the tolerance pipeline (ADR-012),
emits telemetry, lifecycle events, and durable step checkpoints, and tears the session down. Its
contract is a single async generator: a `run()` that yields a stream of events plus a `close()` for
teardown.

The **direct orchestrator** makes one bounded, non-agentic call, for example classifying an incoming
message's intent, and returns a validated result. A bounded call does not get a tool-using session;
the two orchestrators stay distinct because the work genuinely differs.

## The provider adapter

An adapter is about two things: mapping the run's inputs to start the backend, and extracting the
structured result back out. Concretely it constructs the provider client, invokes the backend
(streaming a session or making a one-shot call), maps the backend's native events onto the canonical
typed event, translates the profile's inference settings into the provider's own form, and
materializes the run's declared tool and skill intent onto the backend. A backend difference that
cannot be expressed as different input mapping or different output extraction is the signal the
adapter contract is wrong, not a reason to special-case a runner.

## Connectivity configuration

A runner reaches a provider through a small configuration graph: a **credential** holds the secret or
identity for a provider account; an **endpoint** names a protocol, references a credential, and may
set a `base_url` and region; a **profile** names an endpoint, a model, a runner kind, and the
provider's inference settings. This configuration is service-owned data in the database, read and
written through the API and validated by the shared schemas (ADR-008, ADR-007). Validation runs before
any session starts: every endpoint must reference a known credential and every profile a known
endpoint, so a misconfiguration fails at the boundary rather than mid-run.

## The request-alteration boundary

The path between a runner and a provider is where provider-compatibility concerns are handled, owned
by the connection layer and configured per endpoint (ADR-023). Each endpoint that needs it configures
its own alteration; an endpoint that needs none passes traffic through. The boundary owns four
responsibilities: rewriting or stripping request headers an upstream gateway rejects; applying the
`base_url` and injecting the auth header; a request timeout with bounded retry on transient transport
failures; and redacted request/response logging at the single point all traffic passes through. The
initial timeout posture is a default with bounded retry; a tunable per-call timeout and a
thinking-budget ceiling are taken when hosted or cost-controlled operation calls for them.

## Driving a session and the typed event stream

A run reports back over the typed, extensible event stream owned by `execution-runtime`, not free
text to be parsed. A runner gives the agent a small set of **structured progress tools**
(backend-agnostic affordances the adapter materializes onto its backend) through which the agent emits
a plan, task progress, and notifications carrying an importance hint. The agent calls these tools, so
the signals arrive structured; the tolerance pipeline (ADR-012) is the fallback that normalizes a
recognizable prose marker and degrades gracefully when a signal is absent.

The orchestrator validates the run's structured result against the step's schema through the tolerance
pipeline and passes the **validated value** across the `Runner` boundary, so the control plane never
reads the execution plane's filesystem. The events themselves are consumed by a generic control-plane
consumer that persists each one and re-streams it over Server-Sent Events (see `api`); rendering is a
per-surface decision keyed on the importance hint, not the runner's choice. The runner emits the full
stream; it does not decide what a human sees.

## Telemetry

Every runner emits the same telemetry as it goes, rather than a post-hoc tally: session start and
completion, assistant-turn and tool counts, duration, token usage, and outcome, with redacted
diagnostics captured on failure. Each record is tagged with its `(run, phase, step, role)` context
and the resolved model and inference settings. Direct calls thread the same telemetry context as
agent sessions, so a bounded call's tokens correlate back to its run. This metadata is the raw
material `cost` prices into each session's embedded `Cost` (ADR-015), which `cost` and `run` then roll
up to `(step, role)` and above; the runner emits the metadata and owns no cost record itself.
Uniformity across all runners holds because the work lives in the shared connection layer and one
orchestrator per mode.

## Tool policy and skill materialization

A run executes under a declarative tool policy and declared skill intent, both resolved from its route
into the Execution Context (ADR-010) and materialized by the adapter onto its backend. Tool policy and
skills travel together as route-resolved configuration; the adapter maps each onto the backend's own
form: a tool allowlist and permission posture, and the backend's skill representation. The initial
posture is broad, non-interactive, and workspace-scoped, because the agent runs autonomously with no
human present to answer a tool prompt; tightening to per-route least privilege and adding
network-egress controls is sequenced for hosted operation. The provider-neutral skill refs and the
catalog they resolve against are owned by `runtime-skills`; this concept owns the per-backend
materialization.

## The runner registry

The extension registry lists every runner adapter with light capability metadata: agent or direct,
provider, whether it streams, its skill-materialization form. Its purposes are discovery and fail-fast
configuration validation; it is never consulted to resolve which runner a run uses (ADR-011).
Capability metadata is used for validation — catching a profile that routes an agent step to a
direct-only runner, or a role constraint a configuration cannot satisfy — and never for resolution.

## Relationships

- `execution-runtime` — owns the `Runner` contract, the typed event protocol and importance hint, the
  result-tolerance pipeline, and the declarative Execution Context this concept materializes.
- `model-routing` — resolves a route to a profile and a runner kind; this concept constructs and
  dispatches the concrete runner behind that resolution.
- `runtime-skills` — owns the skills catalog, the provider-neutral refs, and the route-to-skill
  mapping; this concept materializes resolved refs onto each backend.
- `workspace` — the per-run repo and scratch roots a session acts in.
- `observability` and `cost` — consume the telemetry this concept emits.
- `api` — re-streams the persisted event stream over Server-Sent Events.

## Constraints and decisions

- **One connection layer, two mode orchestrators, one adapter per cell; symmetric dispatch** (ADR-022).
- **Provider identity is confined to the adapter**; each adapter imports its SDK as a library.
- **Request alteration is a per-endpoint boundary owned by the connection layer**, used by every
  runner (ADR-023).
- **Configuration is service-owned data in the database**, validated before a session starts (ADR-008,
  ADR-007).
- **Progress and intent are typed events emitted through structured tools**, with tolerance fallback;
  rendering is decided per surface (ADR-012, `execution-runtime`).
- **Telemetry is uniform across runners and tagged `(run, phase, step, role)`**; the runner emits it
  and owns no cost record (ADR-015).
- **Tool policy and skill intent are route-resolved and materialized per backend**; the initial
  posture is broad, non-interactive, workspace-scoped, with hardening sequenced (ADR-010).
- **The registry is descriptive**: discovery and validation, never resolution (ADR-011).

## Open edges

- **Execution extraction**: promoting the in-process `Runner` boundary to a network or queue contract
  moves the validated result from an in-process value to a transmitted message; the adapter and
  orchestrator structure is unchanged (`execution-runtime`).
- **A tunable per-call timeout and thinking-budget ceiling** at the request-alteration boundary, taken
  when hosted or cost-controlled operation calls for it.
- **Per-route least-privilege tool policy and network-egress controls**, sequenced for
  hosted/multi-tenant operation (ADR-010).
