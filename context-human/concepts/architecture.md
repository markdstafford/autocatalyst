---
created: 2026-06-03
last_updated: 2026-06-07
status: active
roadmap: fnd
---

# Architecture

Autocatalyst is a standalone, long-lived TypeScript/Node service that is the source of
truth, built around a single-authority orchestrator, fronted by a versioned network API,
with provider-specific concerns pushed behind ports and assembled at startup. This concept
owns the **static topology and the conventions** that shape it: the process and plane
structure, the hosting and deployment model, persistence, the API envelope, configuration,
the identity/tenancy seam, the extensibility model, and the repository layout. It does
**not** own the domain model or the concrete API surface (see `domain-model` and `api`), the
behavior of a run in motion (see `execution-runtime`), or the run lifecycle and state machine
(see `run`).

## The shape: one service, two planes

Autocatalyst runs as a **standalone network-API service** that is the single source of truth.
Every client (the desktop app, a lightweight mobile app, and optional channel adapters) is a
thin peer consumer of that API. The service is never embedded inside a client (ADR-003).

Inside the service are two planes:

- The **control plane** owns scheduling, run state, the API, and persistence. It is the
  **single authority**: exactly one component mutates scheduling and run state, which keeps the
  system race-free without distributed locking.
- The **execution plane** owns a run's workspace and the agent session that acts in it.

The two planes are separated by a **`Runner` interface**. By default they run **in one
process, co-located**, but the interface is written to **assume no shared memory**, so the
execution plane can later be extracted into separately deployed workers without changing the
contract (ADR-003). The repository layout enforces this boundary structurally: the control-plane
package may depend on the execution *interface* but not reach into its internals (ADR-002). The
mechanics of a run crossing this boundary belong to `execution-runtime`.

## Hosting and deployment

The control plane is deployable as a standalone service (on a developer machine for
single-operator use, or hosted centrally), and clients always reach it over the network API.
**Agent execution runs host-side, alongside the control plane.** Host-side execution is what
makes collaboration (a teammate joining a run), coherent repository access, and always-on
operation possible (ADR-003).

Extracting execution into separate workers is a deferred option, taken when execution must
scale out, be isolated from control-plane faults, or run across hosts. Extracted workers are
**centralized/cloud-hosted, never run on end-user machines**.

A human's local needs are served two ways: **previewing** a diff or PR is served by the API,
needing no local copy; **running and testing** a build is served by a **shallow clone of the
host workspace** to the local machine, managed by the desktop/mobile app. The repository lives
on the host: the control plane reads it for intake and display, and the execution plane clones
per-run workspaces from it.

## Persistence

Durable state lives in **SQLite**, accessed through **Drizzle**, with all reads and writes
behind a **repository abstraction** so the engine is swappable without touching call sites
(ADR-004). The single-writer model of SQLite suits the single-authority orchestrator, which is the
only writer of run state, and it removes the operational overhead of a separate database server
for the common case.

**Postgres is the documented upgrade path**, taken when the control plane goes multi-instance
(true cross-process write concurrency) or requires database-enforced tenant isolation. Drizzle's
shared schema DSL across both engines keeps that move inexpensive.

## The network API

The API is a **typed, contract-first REST** surface (ADR-005). Request and response shapes are
declared as **Zod schemas in a shared `api-contract` package (the single source of truth), from
which TypeScript types, an OpenAPI document, and a typed client SDK are all derived (ADR-007).
No API shape is written twice. The server is **Fastify**, whose native schema validation pairs
directly with the contract-first approach.

- **Streaming** uses **Server-Sent Events** for the server-to-client direction (run progress, live
  state); client actions (approve, send feedback) are ordinary REST calls. WebSocket is reserved
  for a future bidirectional need such as live collaborative editing (ADR-005).
- **Evolution** is governed by a hard rule: the API is served under a version prefix (`/v1`) and
  evolves **additively within a version**, adding new endpoints and optional fields only, never a
  removal or repurposing. Breaking changes go in a new version path with a deprecation window
  (ADR-006). This lets every client keep working as the surface grows, and lets the service ship
  capabilities without a coordinated cutover.

The API is **client-agnostic**: desktop and mobile are the primary clients today, and channel
adapters (chat platforms) and future surfaces are acknowledged peer consumers, so the contract is
never shaped to one client. The concrete endpoints and payloads are owned by `api`; this concept
fixes only the style, transport, streaming mechanism, and evolution rule.

## Configuration

Configuration is **service-owned and stored in the database**, read and written through the API,
schema-validated on write, and evolved under the same versioning rule as the rest of the API
(ADR-008). Operational configuration (providers, endpoints, credentials, model routing, the
repositories worked on, channel bindings, and policies) is data scoped by owner/tenant, which
lets the UX edit it and makes it multi-tenant-ready.

Only a **minimal bootstrap set** lives outside the database (the database location, the network
listen port, and the master secret that unlocks the secret store), because it is needed before
the store can be read. It is supplied by environment variables or launch flags. The schema of
operational configuration is owned by `settings`.

## Identity and tenancy seam

Multi-user collaboration is a committed mid-term direction, so its seam is placed now and wired
end-to-end (ADR-009):

- Every domain entity carries **owner and tenant attribution** fields.
- Every API request carries a **`Principal`** (identity + tenant) threaded through to the
  service, so all logic is written as if it knows who is acting and in which tenant.
- Authorization passes through a single **policy-decision point** in the API layer — present but
  permissive today.
- A **single hardcoded principal** is threaded through the whole stack now, so the seam is
  exercised rather than vestigial. A bearer token authenticates client-to-service calls.

Real authentication and RBAC enforcement (per-repo, possibly per-step) are built against this
seam as multi-user work lands. The full identity model is owned by `identity`.

## Extensibility: the registry and the provider boundary

Provider-specific concerns — channels, publishers, issue trackers, and model/agent runners — live
in **adapters**. The control plane, the shared types, and the configuration know only
provider-neutral references and ports; a concrete provider's concepts never leak into the core.
Composition wires the configured providers at startup.

The **extension registry is a descriptive catalog**, consulted uniformly across all pluggable
kinds: it declares what providers exist and what each can do, and it powers discovery in the UX.
It informs configuration validation as advisory metadata rather than governing it: a configured
provider is valid when its adapter id resolves to a real adapter or runner in code, and an id
absent from the registry only **warns**, never blocks. It **does not gate resolution** — which
runner a run uses is decided by routing, and which channel/publisher/tracker is active is decided
by configuration. **Registration is metadata, not permission:** a provider wired by
routing/configuration works whether or not it appears in the registry (ADR-011). A gating role is
introduced only if dynamic third-party plugins later make it worthwhile.

## Repository layout and tooling

The system is a single **Nx monorepo on pnpm** (ADR-002). The layout principle: `packages/` holds
libraries (the API contract, the control-plane core, the execution runtime, persistence, the
generated SDK), and `apps/` holds thin deployable targets, one per shippable artifact or
platform, with shared UI and logic factored into packages so platform shells stay thin. Provider
adapters are placed by role (provider libraries under `packages/`, standalone channel clients
under `apps/`), with Nx **tags** carrying adapter semantics and enforcing dependency boundaries,
including the control/execution boundary.

The repository is organized for **agent authorship**: explicit module boundaries enforced by
tooling (not convention), generators that scaffold new packages the one correct way, and a
structure where no module requires out-of-band human context to modify. This is a first-class
design goal, because the system is authored largely by agents.

## Relationships

- `execution-runtime` — how a run executes across the `Runner` boundary this concept defines
  structurally: the execution context, the event protocol, the result contract, and recovery.
- `domain-model` and `api` — the entities and the concrete API surface exposed over the envelope
  defined here.
- `run` — the run entity and its state machine; this concept provides the persistence and the
  single-authority orchestrator that hold run state.
- `settings` — the schema of service-owned configuration stored per this concept's config model.
- `agent-runners` and `model-routing` — the provider adapters and routing that resolve runners
  behind the ports defined here.
- `identity` — the full multi-user/RBAC model built against the seam placed here.
- `observability` — the structured logging and telemetry shared across the topology.
- `channels` and `mobile` — acknowledged future client surfaces the client-agnostic API
  anticipates.

## Constraints and decisions

- **Single-authority orchestrator** — exactly one component mutates scheduling and run state.
- **Standalone service, thin clients** — the source of truth is never embedded in a client.
- **Host-side execution** — required by collaboration, coherent repo access, and always-on
  operation (ADR-003).
- **Additive, versioned API** — the rule that lets clients and the surface evolve independently
  (ADR-006).
- **Schema-as-source** — one definition yields types, validation, OpenAPI, and the client SDK
  (ADR-007).
- **TypeScript/Node end to end** (ADR-001); **SQLite now, Postgres on a named trigger** (ADR-004);
  **Nx + pnpm with enforced boundaries** (ADR-002).
- **Seams placed now, builds deferred** — identity/tenancy (ADR-009) and execution extraction
  (ADR-003) are wired as seams without being fully built.

## Open edges

- **Execution extraction** — promoting the in-process `Runner` interface to a network/queue
  contract for centralized, scalable, isolated execution workers.
- **Postgres** — adopted when the control plane goes multi-instance or needs DB-enforced tenancy.
- **WebSocket** — added if a feature needs true bidirectional, low-latency communication (e.g.
  live collaborative editing).
- **Dynamic plugins** — a gating role for the registry, with versioning and sandboxing, if
  third-party extensions arrive.
- **Multi-user** — the full authentication and RBAC build against the identity/tenancy seam.
- **Additional client surfaces** — channels and mobile as peer consumers of the same API.
