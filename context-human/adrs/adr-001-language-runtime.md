---
created: 2026-06-03
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-001: Core language and runtime

## Status

Accepted

## Context

Autocatalyst is a headless core service that is the source of truth, fronted by a network
API, with a dedicated UX (desktop and mobile) and optional channel adapters as clients. The
language and runtime must serve the long-lived control-plane service and the execution
runtime that drives agent sessions.

The service orchestrates **agent SDKs**: the Claude Agent SDK and the OpenAI Agents SDK are
both libraries we import and stream from directly. The clients are React/TypeScript, and
**end-to-end type sharing** across the API boundary is a primary lever for correctness and
velocity. The workload is **I/O-bound orchestration**: streaming events, network calls to
model providers, and supervising child processes, rather than CPU-bound computation. The
codebase is **authored largely by AI agents**, so language familiarity and ecosystem
ubiquity directly affect output quality.

## Decision

The core service and the execution runtime are written in **TypeScript on Node.js LTS**.

TypeScript is the native language of the agent SDKs we orchestrate. It shares types with the
React clients across the API boundary at no cost, and it fits an I/O-bound, streaming,
network-heavy workload. Node.js LTS (22+) is the runtime, chosen for SDK compatibility and
operational maturity.

## Consequences

**Positive:**
- One language across the core, the execution runtime, and all clients, giving a single type
  graph and one mental model for the agents authoring the system.
- Direct, first-class use of the agent SDKs with no FFI or subprocess shim.
- Excellent fit for asynchronous, streaming, network-heavy work.
- The largest training corpus of the candidate languages, so AI-authored code is more
  idiomatic.

**Negative:**
- No compiler-enforced memory safety or the raw throughput of a systems language (acceptable:
  the work is I/O-bound, not CPU-bound).
- Node's single-threaded model means any future CPU-heavy work needs worker threads or
  offloading.
- TypeScript's types are erased at runtime, so boundary validation must be explicit (addressed
  by the schema-as-source contract in ADR-007).

## Alternatives considered

### Rust

A systems language with memory safety and high performance.

**Pros:**
- Memory safety without a garbage collector, and excellent raw performance.
- Single-binary distribution and a small runtime footprint.
- A strong type system that catches whole classes of bugs at compile time.

**Cons:**
- The agent SDKs are not Rust-native; we would shell out to them or reimplement, losing the
  typed streaming integration that is central to the runtime.
- No type sharing with the React clients — the API boundary loses its biggest advantage.
- Slower for AI agents to author idiomatically, given a smaller training corpus.

**Why not chosen:** Rust's strengths (CPU performance, memory control, single binary) sit away
from this system's costs, while its weaknesses (SDK integration, client type-sharing, agent
authorship) land on the parts where the system's value concentrates.

### Go

A pragmatic, concurrent language well suited to long-lived network services.

**Pros:**
- Simple concurrency model and a strong standard library for services.
- Fast compilation, single-binary deployment, good operational story.
- Easier to read than Rust.

**Cons:**
- Agent SDKs are not Go-native; the same integration cost as Rust.
- No type sharing with the TypeScript clients.
- Less expressive type system for modeling the domain than TypeScript.

**Why not chosen:** The same mismatch as Rust (no SDK-native integration and no client
type-sharing), without enough offsetting benefit for an I/O-bound workload.

### Python

The language with the deepest AI/ML ecosystem.

**Pros:**
- Rich AI tooling ecosystem and strong agent-framework support.
- Fast to write; familiar to most AI practitioners.
- First-class agent-SDK support.

**Cons:**
- No type sharing with the React clients, and weaker static typing for a large, long-lived
  service even with type hints.
- A weaker concurrency/async story for a long-lived streaming service than Node's.
- A smaller, less consistent story for a single typed codebase spanning service and clients.

**Why not chosen:** The client type-sharing argument dominates, and the agent SDKs are driven
comfortably from TypeScript, so Python's main advantage does not apply here.

### Bun / Deno (runtime, not language)

Alternative JavaScript/TypeScript runtimes. Not a genuine alternative for this decision: they
keep the language while trading Node's ecosystem maturity and SDK compatibility for raw speed
that an I/O-bound service does not need. A deferred option, taken as a drop-in runtime swap if
a concrete need appears.
