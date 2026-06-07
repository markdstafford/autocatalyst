---
created: 2026-06-05
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-022: Runner structure and the provider-adapter abstraction

## Status

Accepted

## Context

Autocatalyst drives more than one model backend in more than one way: tool-using **agent sessions**
and bounded **direct-model calls**, each across more than one provider family. That yields four
behaviors: anthropic and openai, agent and direct.

These four behaviors share a great deal (reaching an endpoint, threading telemetry, structured
logging, lifecycle events) and differ only in provider-specific particulars: the actual call, the
shape of the events it streams back, how inference settings are named, and how tools and skills are
expressed to the backend. The runner layer must be factored so the implementations behave alike, so
provider-specific behavior is contained, and so adding or adjusting a provider is a bounded change.
The `Runner` boundary itself, the no-shared-memory contract between the control and execution planes,
is fixed by ADR-003; this decision is about the structure *inside* that boundary.

## Decision

**Factor the runner layer into one connection layer, two mode orchestrators (agent and direct), and
one provider adapter per provider-and-mode cell, with dispatch selecting the adapter by the resolved
provider.**

- **One connection layer, shared by all runners.** It resolves an endpoint and credential into a
  provider client, routes every request through the per-endpoint request-alteration boundary
  (ADR-023), threads the telemetry context, and emits uniform structured logging. This is the one
  place the four behaviors meet.
- **Two mode orchestrators, each written once.** The **agent orchestrator** drives a tool-using
  session through its adapter, consumes the typed event stream, validates the result through the
  tolerance pipeline (ADR-012), emits telemetry, lifecycle events, and durable step checkpoints, and
  tears the session down. The **direct orchestrator** makes one bounded call through its adapter and
  returns a validated result. Each orchestrator is parameterized by a provider adapter, so the two
  agent runners are one implementation and the two direct runners are one implementation.
- **One provider adapter per cell** (currently four: anthropic-direct, openai-direct, the Claude
  agent SDK, the OpenAI Agents SDK). The adapter is the single place a provider's identity appears.
  It constructs the client, invokes the backend (streaming a session or making a one-shot call), maps
  the backend's events onto the canonical typed event, translates the profile's inference settings,
  and materializes the run's declared tool and skill intent onto the backend.
- **Symmetric dispatch.** The resolved profile's provider selects its adapter by lookup, so every
  provider is reached through its own adapter on equal footing.
- **Each adapter imports its provider SDK as a library** and consumes its interface in-process,
  giving the orchestrator direct control of the event stream and the session lifecycle.

One orchestrator per mode makes the runners alike by construction rather than kept in step by
maintenance, so uniform telemetry, preconditions, and dispatch hold across providers.

## Consequences

**Positive:**
- Uniform behavior, telemetry, and logging across providers, because the cross-cutting work lives in
  one connection layer and one orchestrator per mode.
- Adding or adjusting a provider is writing or changing one adapter; nothing else moves.
- Provider-specific particulars are confined to the adapter, so the orchestrators and the control
  plane stay provider-agnostic.
- Dispatch is a lookup, so no provider is special.

**Negative:**
- The adapter contract must be expressive enough for every backend; a backend that resists it shows
  up as adapter complexity, which is the signal to revisit the contract.
- The orchestrator-plus-adapter split is a layer of indirection over a direct provider call.

## Alternatives considered

### A shared base class with one runner subclass per provider

Express the common work in a base class and let each provider subclass fill in the particulars.

**Pros:**
- A familiar object-oriented shape.
- Some logic is shared through inheritance.

**Cons:**
- Likeness is maintained rather than structural: two agent subclasses are kept similar by discipline
  and drift apart over time.
- Behavior is spread across an inheritance tree, so understanding one runner means reading several
  classes.

**Why not chosen:** A single orchestrator parameterized by an adapter makes likeness structural,
because there is only one agent implementation, which is the property the divergence problem needs.

### Four independent runners, one per provider-and-mode

Build each of the four as its own implementation, tuned to its backend.

**Pros:**
- Each runner can be shaped exactly to its backend.

**Cons:**
- Telemetry, logging, preconditions, and dispatch drift apart as the four evolve unevenly.
- Cross-cutting logic is re-implemented per runner.

**Why not chosen:** That divergence is precisely the problem this decision exists to remove.

### An external CLI subprocess per backend

Drive each backend by shelling out to a packaged command-line tool.

**Pros:**
- Reuses an existing packaged tool rather than integrating a library.

**Cons:**
- Process management and version-dependency overhead for each backend.
- Weaker control over streaming and telemetry than an in-process library gives.

**Why not chosen:** Importing the SDK as a library gives the orchestrator direct, uniform control of
the event stream and the session lifecycle.

### One runner for both modes, parameterized by mode and provider

Collapse the agent and direct orchestrators into a single runner.

**Pros:**
- One runner type rather than two.

**Cons:**
- The two modes' orchestration differs (a streaming tool-using session versus a single bounded
  call), so one runner becomes a branchy hybrid.

**Why not chosen:** Two mode orchestrators over a shared connection layer match the actual shape of
the work; a combined runner manufactures conditional complexity.
