---
created: 2026-06-03
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-009: Authentication and RBAC envelope

## Status

Accepted

## Context

Autocatalyst runs as a single-operator system, and multi-user collaboration is a committed
direction: several people working on the same repositories, specs, and runs, with per-repo (and
possibly per-step) permissions. Building full authentication and authorization now would delay
more pressing work and commit to a design before the collaboration requirements are known. Adding
them later means threading identity, ownership, and policy checks through an already-built system,
which is costly rework if no seam exists. The decision is how much of the auth/RBAC story to put
in place now.

## Decision

**Place an authentication/RBAC envelope as a seam now, and wire it end-to-end with a single
hardcoded principal, deferring real authentication and policy enforcement.**

- **Attribution on every entity.** Domain entities carry owner and tenant fields from the start,
  so ownership and tenancy are representable everywhere.
- **A `Principal` in request context.** Every API request carries a `Principal` (identity +
  tenant) threaded through to the service, so all logic is written as if it knows who is acting
  and in which tenant.
- **A `kind` on the `Principal`.** A principal is one of `human`, `model`, or `system`. A `model`
  principal's identity is its resolved provider and model, and it is an **author only**: never an
  owner, never the subject the policy point authorizes, and not tenant-scoped, since the same model
  serves every tenant. This lets a model reviewer's finding be attributed like a person's (one
  `Feedback`, by the authoring principal's `kind`) without a separate origin flag (`domain-model`,
  ADR-018).
- **A policy-decision seam.** Authorization checks pass through a single policy point in the API
  layer, a no-op-but-present gate, so enforcement has one home to grow into.
- **A hardcoded principal threaded through the stack.** A single hardcoded principal runs through
  the whole stack, so the seam is used end-to-end rather than sitting as dead scaffolding.
- **Transport auth.** A bearer token authenticates client-to-service calls now (and service-to-runner
  calls if and when execution is extracted, ADR-003).
- Real authentication (interactive sign-in, sessions/OAuth) and RBAC enforcement (per-repo, and
  possibly per-step) are built against this seam as multi-user work lands.

## Consequences

**Positive:**
- The expensive-to-retrofit parts (entity attribution, principal threading, the policy point)
  exist from day one, so multi-user is an additive build rather than a rewrite.
- Wiring the seam with a real (if hardcoded) principal proves it works end-to-end and prevents it
  from rotting.
- Tenancy is representable immediately, aligning with the configuration and persistence models.

**Negative:**
- A small amount of machinery (principal plumbing, a no-op policy gate) is carried before it is
  strictly needed.
- The hardcoded principal is a placeholder that must not be mistaken for real authentication.
- The authentication and enforcement design is deferred, so some shape remains intentionally open.

## Alternatives considered

### Build full authentication and RBAC now

Implement interactive authentication, sessions, and per-repo/per-step authorization immediately.

**Pros:**
- Real security and multi-user support from the start.
- One coherent build rather than a seam plus a later fill-in.

**Cons:**
- Significant scope that delays the initial release.
- Commits to an authorization design before collaboration requirements are well understood.
- Much of it would be speculative for a system that is single-operator today.

**Why not chosen:** The collaboration requirements are not yet concrete enough to design against,
and the work would delay the initial release. Placing the seam captures the cheap-now,
expensive-later parts without the speculation.

### Adopt a third-party auth provider now

Integrate a hosted identity provider (e.g. an OAuth/identity service) up front.

**Pros:**
- Offloads authentication to a mature, maintained service.
- Standard sign-in flows out of the box.

**Cons:**
- A premature external dependency before the requirements that would shape the choice exist.
- The internal `Principal`/attribution/policy seam is still required regardless of provider.
- Couples early to a vendor that may not fit the eventual collaboration model.

**Why not chosen:** The seam is provider-agnostic, so a provider can be slotted in at the seam
when authentication is built. Adopting one now buys nothing and adds a dependency.

### No seam — add auth when it is needed

Defer all of it, including attribution and principal threading. Retrofitting ownership fields and
principal context across a fully built system is the costly rework that placing a seam now avoids,
and avoiding that rework is the reason to decide this at the foundation.
