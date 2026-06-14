---
created: 2026-06-05
last_updated: 2026-06-14
status: accepted
decided_by: markdstafford
superseded_by: null
related:
  - context-agent/decisions/loopback-proxy-supersedes-subprocess-header-exception.md
---

# ADR-023: Per-endpoint request-alteration boundary

## Status

Accepted

## Context

The path between a runner and a model provider is where provider-compatibility concerns live:
rewriting request headers an upstream gateway rejects, applying a provider `base_url` and an auth
header, handling gateway timeouts, and capturing redacted request and response records for debugging.
The execution-runtime concept and ADR-003 already keep these out of the control plane and the agent,
at the boundary where a runner reaches a provider.

This ADR decides the structure of that boundary and what it owns. One natural shape is a single
process-wide component that all traffic flows through. That shape forces every configuration that uses
it to agree, because one instance cannot hold conflicting settings for different endpoints.

## Decision

**Request alteration is a per-endpoint boundary, owned by the connection layer (ADR-022) and used by
every runner.**

- **Per-endpoint.** Each endpoint configures its own request alteration; an endpoint that needs none
  passes traffic through unchanged. Configuration belongs to the endpoint that needs it, so two
  endpoints can rewrite headers differently without affecting each other.
- **Used by every runner** — agent and direct, across providers — so provider-compatibility handling
  is applied the same way everywhere.
- **It owns four responsibilities:**
  1. **Header rewrite and strip** — removing or adjusting request headers an upstream gateway
     rejects.
  2. **`base_url` application and auth-header injection** — directing traffic at the configured
     endpoint with the credential it requires.
  3. **Request timeout and bounded retry** — a request timeout and a bounded retry on transient
     transport failures.
  4. **Redacted request and response logging** — capturing redacted records at the single point all
     traffic passes through, feeding observability.
- **The initial timeout posture is a sane default with bounded retry.** A tunable per-call timeout and
  a thinking-budget ceiling are taken when hosted or cost-controlled operation calls for them.

## Consequences

**Positive:**
- Provider quirks stay out of the control plane and the agent, isolated at one boundary.
- One place captures uniform, redacted request/response logging for every runner.
- Per-endpoint configuration lets each endpoint carry its own settings, with no shared-configuration
  agreement required across endpoints.
- Timeout and retry have a single, consistent home.

**Negative:**
- A per-endpoint boundary is more instances to configure than a single shared one.
- Redacted logging must be maintained carefully so it never records a secret.

## Alternatives considered

### A single process-wide request-alteration component

One shared component that all provider traffic flows through.

**Pros:**
- Exactly one instance to build and run.

**Cons:**
- Every configuration that uses it must agree on one setting, because a single instance cannot hold
  conflicting per-endpoint settings. Its configuration must stay consistent for every endpoint at once.

**Why not chosen:** Per-endpoint scoping puts the configuration where it belongs and removes the
forced agreement a shared instance imposes.

### Request alteration inside each runner

Let every runner do its own header rewriting, timeouts, and logging.

**Pros:**
- The handling sits next to the call it affects.

**Cons:**
- The logic is re-implemented per runner and drifts, and logging becomes inconsistent across runners.

**Why not chosen:** The connection layer is the shared point every runner already uses, so it owns
this once.

### Request alteration in the control plane

Handle provider-compatibility concerns above the `Runner` boundary, in the control plane.

**Why not chosen:** It would pull provider-specific quirks into the control plane, which the plane
boundary (ADR-003) exists to keep free of them.

## Subsequent decisions

**Loopback proxy supersedes subprocess header-control exception (2026-06-14)**

ADR-023 originally accepted that Claude process-environment sessions could not strip SDK default
headers or place credentials on arbitrary headers because the subprocess path had no in-process
transport hook. The execution loopback proxy (feature: loopback-runner-proxy) removes that
exception for cells that can be pointed at a loopback base URL. Auth-header injection, header
stripping/filtering, and request dumps are now available through the proxy for process-environment
sessions. See `context-agent/decisions/loopback-proxy-supersedes-subprocess-header-exception.md`.
