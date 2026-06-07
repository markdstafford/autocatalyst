---
created: 2026-06-03
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-006: API versioning and evolution

## Status

Accepted

## Context

The API needs a rule for how it evolves so that growth never breaks a client that has not been
updated. Several long-lived clients consume it — the desktop app, the mobile app, and channel
adapters — and they cannot all be upgraded in lockstep with the service. Meanwhile the service's
surface grows continuously as capabilities are added.

Three facts shape the rule. Clients ship and update on their own cadence, so a deployed client may
lag the service. The surface should grow steadily without a coordinated cutover. And the evolution
rule must be simple enough that an agent extending the API follows it reliably, because an ambiguous
rule will be violated.

## Decision

**Version the API with a URL prefix (`/v1`), and require additive-only evolution within a
version. Breaking changes go in a new version path, and the prior version is supported through a
deprecation window.**

- The API is served under a version prefix, e.g. `/v1/...`.
- **Within a version, changes are additive only.** New endpoints and new *optional* fields may
  be added. Existing fields and endpoints are never removed, renamed, repurposed, or made
  stricter.
- **Anything breaking requires a new version path** (`/v2`), introduced alongside the existing
  one. The previous version remains available for a defined deprecation window so clients move to
  the new one on their own schedule.
- The rule is stated plainly in the API-contract package so it is the obvious default for anyone
  (human or agent) extending the surface.

## Consequences

**Positive:**
- Clients keep working as the API grows; no lockstep upgrades.
- The service can ship new capabilities continuously without coordinating a cutover.
- A simple, unambiguous rule that is easy for agents to follow correctly.
- Versioned paths are visible and trivially routable and testable (including by hand).

**Negative:**
- Supporting multiple versions during a deprecation window carries maintenance cost.
- Additive-only discipline can accumulate deprecated-but-present fields over a version's life.
- A breaking redesign still requires the effort of a new version and a deprecation window.

## Alternatives considered

### Header / media-type (content-negotiation) versioning

Select the version via a request header or `Accept` media type rather than the URL.

**Pros:**
- Keeps URLs free of version segments.
- Considered more "RESTful" by some conventions.

**Cons:**
- Less visible and legible: the version is hidden in headers, easy to overlook in logs, by
  hand, or by an agent.
- More error-prone with caches and proxies that key on the URL.
- Harder to test and reason about than a path segment.

**Why not chosen:** A URL prefix is more legible to both humans and agents and easy to route,
which matters more here than URL purity.

### Per-endpoint semantic versioning

Version each endpoint independently with its own semantic version.

**Pros:**
- Fine-grained control over each endpoint's evolution.
- Endpoints can advance at their own pace.

**Cons:**
- Combinatorial complexity: clients must track a matrix of per-endpoint versions.
- Hard to reason about a coherent API surface at a point in time.
- More machinery than the problem warrants.

**Why not chosen:** A single API-wide version with an additive rule is far simpler to operate and
to follow, with no meaningful loss for this surface.

### No versioning — evolve freely and coordinate clients

Change the API as needed and update clients together. With multiple long-lived clients on
independent release cadences, this breaks them in lockstep, which is the failure the API must
prevent.
