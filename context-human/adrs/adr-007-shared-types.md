---
created: 2026-06-03
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-007: Shared types

## Status

Accepted

## Context

The API surface is consumed by the core service itself and by every client (desktop, mobile,
channel adapters). The same shapes (request/response bodies, entities, event payloads) are
referenced on both sides of the boundary. We must decide how those shapes are defined and shared
so that the service and its clients never drift out of agreement, while also validating input at
the boundary (TypeScript types are erased at runtime, ADR-001) and remaining consumable by a
non-TypeScript client.

## Decision

**A single `api-contract` package holds the API shapes as Zod schemas, the one source of truth.
TypeScript types, an OpenAPI document, and a generated client SDK are all derived from those
schemas. No API shape is ever hand-written twice.**

- The schemas live in `packages/api-contract` and are imported by the core (for runtime
  validation at the boundary) and by the client SDK.
- Everything else is derived, never duplicated: TypeScript types come from the schemas via
  inference; the OpenAPI document is generated from them (for non-TypeScript consumers and
  documentation); the typed client SDK is generated from the contract.
- A change to a shape happens in exactly one place; every consumer picks it up through
  regeneration/inference.

## Consequences

**Positive:**
- The service and clients cannot drift, because there is a single definition.
- The boundary gets runtime validation and static types from the same artifact.
- Non-TypeScript consumers are served by the generated OpenAPI document.
- A change has one obvious home, which is easy for an agent to do correctly.

**Negative:**
- A generation/build step ties the SDK and OpenAPI document to the schemas.
- All consumers depend on the contract package, so its changes ripple (intended, but it means
  the package must be evolved carefully under the additive rule of ADR-006).
- Schema-first authoring is a discipline that must be held to (the temptation to inline a
  one-off type must be resisted).

## Alternatives considered

### OpenAPI specification as the source, with codegen

Author an OpenAPI document by hand as the source of truth and generate types and clients from it.

**Pros:**
- Language-agnostic source artifact.
- A widely supported standard with mature tooling.
- Clear separation of contract from implementation.

**Cons:**
- Authoring OpenAPI by hand (YAML/JSON) is less ergonomic and less legible than code-first
  schemas.
- Runtime validation must be wired separately rather than coming from the same artifact.
- A heavier two-step codegen loop than inferring from schemas.

**Why not chosen:** Defining shapes as Zod schemas in code yields the types, the runtime
validation, *and* the OpenAPI document from one ergonomic source. The language-agnostic output is
kept without the cost of hand-authoring the spec.

### Shared TypeScript types only (no runtime validation)

Share plain TypeScript type definitions across the boundary, with no schema or validation layer.

**Pros:**
- The simplest possible type-sharing.
- No generation step.

**Cons:**
- No runtime validation at the boundary, so invalid input is not caught, since types vanish at
  runtime.
- Nothing to generate an OpenAPI document from, so non-TypeScript consumers are unserved.
- Types-only sharing tempts hand-maintained duplicates.

**Why not chosen:** The boundary must validate input at runtime and must publish a contract for
non-TypeScript consumers, neither of which plain shared types provide.
