---
created: 2026-06-03
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-005: API style, transport, and streaming

## Status

Accepted

## Context

The core service exposes its capabilities over a network API consumed by every client: the
desktop app, a lightweight mobile app, and optional channel adapters, with potential external
or non-TypeScript consumers. We must choose the API style, its transport, and how the API
streams a run's progress and live state. Several things shape that choice.

The clients are TypeScript, and end-to-end type safety across the boundary is desired. Additive,
versioned evolution is a hard requirement (ADR-006): clients must keep working as the API grows.
Channels and webhooks are HTTP-native, since they are inbound callbacks from chat platforms and
trackers. Long-running runs stream: progress, tool activity, and live run-state must flow to
clients as they happen, while client actions (approve, send feedback) are discrete commands.
Finally, the contract should be legible to the agents that author and operate the system.

## Decision

**A typed, contract-first REST API: schemas are the single source of truth, served by Fastify,
defined with Zod. Server-to-client streaming uses Server-Sent Events (SSE); client-to-server
actions are ordinary REST calls. WebSocket is reserved for a future need.**

- The API is **contract-first**: request/response shapes are declared as **Zod schemas**
  (in the shared API-contract package, ADR-007), from which TypeScript types, runtime
  validation, and an OpenAPI document are derived.
- **Fastify** serves the API. It is TypeScript-first, with native schema validation that pairs
  directly with the contract-first approach.
- **SSE** carries the server-to-client stream (run progress, live state). It is HTTP-native, with
  automatic reconnection, over the same API and auth. **REST** carries commands. The SSE stream and its
  `Last-Event-ID` reconnect are bounded to an active run plus the telemetry retention window; a run's
  durable history is the session-grain record read over REST, not a permanent turn-grain replay
  (ADR-030).
- **WebSocket** is an explicit open edge, reserved only for a future feature that needs true
  low-latency bidirectional communication (e.g. live collaborative editing).

## Consequences

**Positive:**
- Additive versioning is natural over versioned HTTP paths (ADR-006).
- Channels, webhooks, and any non-TypeScript consumer are first-class, since it is just HTTP with
  an OpenAPI contract.
- An explicit contract is more legible to humans and agents than inferred procedure signatures.
- SSE gives streaming progress with minimal machinery and straightforward composition with the rest of the
  API.
- Type safety is preserved end-to-end through the shared schema package.

**Negative:**
- More ceremony than fully-inferred RPC: the contract is an explicit artifact to maintain.
- Type safety is contract-mediated (schema to generated types) rather than purely inferred.
- SSE is one-directional; a genuinely bidirectional future feature requires adding WebSocket.

## Alternatives considered

### tRPC

End-to-end typesafe RPC for TypeScript, calling server procedures from the client with inferred
types and no code generation.

**Pros:**
- Best-in-class developer experience for an all-TypeScript codebase.
- Zero code generation; types flow automatically from server to client.
- Very fast to build against in a shared monorepo.

**Cons:**
- Procedures, not a versioned wire contract — additive versioning is weaker and leans on
  monorepo type-checking rather than an explicit contract.
- Not HTTP-native for channels, webhooks, or non-TypeScript consumers without a bridge.
- Couples client and server to a shared TypeScript surface, and the contract is less legible to
  an agent reading it cold.

**Why not chosen:** The additive-versioning requirement, HTTP-native channels/webhooks, and
agent-legibility of an explicit contract outweigh tRPC's authoring convenience.

### GraphQL

A query language and runtime letting clients request exactly the fields they need, with a typed
schema and subscriptions for streaming.

**Pros:**
- Flexible client-driven queries and a single typed schema.
- Subscriptions provide a streaming mechanism.
- Strong tooling and codegen.

**Cons:**
- The domain is command/RPC-shaped (start a run, approve a spec, send feedback) rather than
  graph-query-shaped, so much of GraphQL's value goes unused.
- Adds query-complexity and caching concerns disproportionate to the need.
- Heavier to operate and reason about for this surface.

**Why not chosen:** It optimizes for flexible read queries this domain does not center on, at a
complexity cost that is not justified.

### gRPC

A high-performance, contract-first RPC framework with first-class streaming. Not a genuine
alternative here: it has poor fit for browser/webview clients (it needs a grpc-web proxy), which
makes it the wrong choice for a desktop-and-mobile, web-technology UX.

### WebSocket as the primary transport

Running the whole API over a bidirectional socket. Not a genuine alternative for the general
case: client actions are discrete commands that fit request/response, and a socket adds
operational cost (sticky sessions, scaling, reconnection logic) without a corresponding need.
The right shape is SSE for the server push plus REST for commands, with WebSocket held in
reserve for a specific bidirectional feature.
