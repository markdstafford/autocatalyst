---
created: 2026-06-04
last_updated: 2026-06-06
status: active
roadmap: core
---

# API

The surface through which the outside world drives Autocatalyst and through which Autocatalyst reaches
back. It is a **service interface**, the core's typed contract, exposed two ways: over the network for
remote clients, and in-process for co-located adapters. This concept owns the **resource surface**, the
**naming and casing conventions**, the **read and streaming** shapes, and the operator and intake
entry points. It does not own the entities the surface moves (see `domain-model`), the style of the
envelope (typed REST, SSE, schema-as-source, decided in `architecture` and ADR-005/006/007), or who
may mutate state behind it (see `orchestrator`).

## The service interface and its front-ends

The contract clients drive is a service interface, and it has two front-ends (see `orchestrator`):

- The **network API**: a versioned HTTP surface for remote clients (the desktop app, a mobile app,
  external consumers), served by Fastify (ADR-005).
- **In-process adapters**: a co-located adapter (for example a chat adapter) calls the service
  interface directly, with no network round-trip to its own process.

Both front-ends move the same shapes and reach the same single authority. The sections below describe
the network surface; an in-process caller invokes the same operations without the HTTP framing.

## Contract-first, schema as the source

Request and response shapes are declared once as **Zod schemas** in the `api-contract` package, and the
TypeScript types, runtime validation, and an OpenAPI document are all derived from them (ADR-007). No
shape is written twice. This is what keeps the wire contract and the in-process callers in step, and it
makes the surface legible to the agents that extend it.

## The resource surface

Resources mirror the domain entities (see `domain-model`), under the version prefix `/v1`:
`projects`, `conversations`, `topics`, `runs`, `messages`, and a run's children (`artifacts`,
`feedback`, `publications`, `pr`, `steps`).

Reads follow containment, but the entities referenced everywhere stay directly addressable:

- Nested listing under a parent: `GET /conversations/{id}/topics`, `GET /topics/{id}/runs`.
- Flat addressing of the entities that are referenced widely (`GET /runs/{id}`,
  `GET /conversations/{id}`), so a known resource is reached without a deep path, and a run's children
  hang off it (`/runs/{id}/feedback`). Deep nesting is for listing under a parent, not for addressing a
  known resource.

## Intake

Submitting work is creating resources:

- `POST /conversations` opens a conversation, its main topic, and the first run.
- `POST /conversations/{id}/messages` adds a message, which routes to the active topic.

This is the same intake the in-process adapters feed; the orchestrator's gate decides whether each call
starts or advances work.

## Operator actions and feedback

Operator actions are action sub-resources, authenticated and routed through the single authority
(`orchestrator`, ADR-009): `POST /runs/{id}/cancel`, `POST /runs/{id}/set-step`. `Feedback` has
first-class endpoints because it gates run completion: `POST /runs/{id}/feedback` raises an item, and
`PATCH /runs/{id}/feedback/{id}` resolves, reopens, or marks it `wont_fix`.

## Reads and streaming

Reads are ordinary REST:

- `GET /runs/{id}` returns a run's state; `GET /runs?status=&topicId=&conversationId=&projectId=`
  filters across runs.
- `GET /runs/{id}/steps` returns the run's step occurrences (the timeline and its cost rolled up to
  `(step, role)`). Cost rides on the resource it belongs to: a run, topic, conversation, or project
  exposes its cost as integer minor units (nano-dollars, not a float), computed live from the session
  rows; a cached `aggregateCost` is a deferred optimization (see `domain-model`, `cost`).

A run's live progress is a **stream**:

- `GET /runs/{id}/events` is a Server-Sent Events stream of the run's typed events: progress, step
  transitions, feedback raised and resolved, completion (ADR-005). The event *schema* is the event
  protocol owned by `execution-runtime`; the API transports it.
- This live turn-grain stream supports `Last-Event-ID` reconnect, bounded to an active run plus the
  telemetry retention window; it is not a permanent archive. The **durable history** of a run (its
  steps, sessions, cost, outcome, and feedback) is read from the session-grain endpoints
  (`GET /runs/{id}`, `/runs/{id}/steps`) for the life of the conversation, so a client replaying a run
  beyond that window reads the session-grain record, not the turn-grain stream (`observability`,
  ADR-030).

## Naming and casing conventions

Three layers, each with its own convention (the detail is also recorded as a coding standard in
`context-agent/standards/`):

- **URL paths**: lowercase, plural-noun collections (`/runs`, `/conversations`), kebab-case for
  multi-word action sub-resources (`/runs/{id}/set-step`).
- **JSON field names**: camelCase (`aggregateCost`, `mainTopic`), so the TypeScript types derived from
  the schemas match the wire shape with no transform.
- **Enum and literal values**: snake_case, with `.` for hierarchical steps: `wont_fix`, `file_issue`,
  `start_topic`, `spec.author`, `implementation.human_review`.

## Versioning

The surface is served under `/v1` and evolves **additively** within a version: new endpoints and new
optional fields only; nothing existing is removed, renamed, or made stricter (ADR-006). A breaking
change goes in a new version path alongside the current one.

## Health, auth, and scoping

- A minimal **health** endpoint (`GET /health`, reporting that the process is alive and the database is
  reachable) is operational and **unversioned**, kept out of `/v1`. Rich operational visibility (running
  agents, queue depth, token totals) is an observability concern, not part of this surface.
- Every request carries a **`Principal`** (identity and tenant) and is authenticated by a bearer token
  (ADR-009). The policy point that reads the principal sits in the API layer.
- Events scope by principal and tenant, and by the conversation's repository binding (`domain-model`),
  so multi-repository work is scoped per conversation rather than funneled through one shared inbound
  token.

## Relationships

- `domain-model`: owns the entities the resources expose and the `Principal` the requests carry.
- `orchestrator`: the single authority the surface drives; intake and operator actions route to it.
- `execution-runtime`: owns the event protocol the run-events stream transports.
- `architecture`: owns the envelope (typed REST, SSE, Fastify, schema-as-source) this surface is built
  within.

## Constraints and decisions

- The surface is a service interface with a remote network front-end and in-process adapter callers
  (ADR-005, ADR-007).
- Resources mirror the domain entities; containment nests for listing, with flat addressing for
  widely-referenced entities.
- Server-to-client streaming is SSE with `Last-Event-ID` resume, bounded to an active run plus the
  telemetry window; durable run history is the session-grain reads; client-to-server is REST (ADR-005,
  ADR-030).
- `/v1`, additive-only within a version (ADR-006).
- Casing: kebab-case paths, camelCase JSON fields, snake_case (dotted for steps) values.
- A minimal unversioned health endpoint; rich visibility is observability.
- Every request carries a `Principal`; the policy point is in the API layer (ADR-009).

## Open edges

- **Optimistic concurrency** (`If-Match`/ETags) is not used now: server-sent events cover live data and
  the single authority serializes scheduling writes; it can be added on a specific mutable resource (for
  example configuration) if concurrent editors arrive.
- A **conversation-level** aggregate event stream (all of a conversation's runs) is an additive surface
  over the per-run stream.
- **WebSocket** is reserved for a genuinely bidirectional feature; the surface uses SSE plus REST until
  one exists (ADR-005).
