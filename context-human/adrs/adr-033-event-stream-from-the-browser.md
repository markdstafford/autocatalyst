---
created: 2026-10-30
last_updated: 2026-10-30
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-033: Browser clients read the event stream with fetch

## Status

Accepted

## Context

The event stream is SSE (ADR-005), and the server reads the bearer token only from the `Authorization`
header (ADR-009). A browser `EventSource` cannot set headers, so the web client cannot connect with it.

## Decision

**The web client opens the stream with `fetch`, sends the bearer token in the `Authorization` header, parses
the SSE frames itself, and reconnects with the last event id. The server does not change.**

- The SDK reads the stream the same way, so the client uses the SDK reader.
- The server never accepts the token in a URL, and it does not set a session cookie.

## Consequences

**Pros:**
- The token stays in a header, out of URLs, logs, and browser history.
- No server state or cookie handling is added.

**Cons:**
- The client owns reconnection and backoff.
- The server's replay buffer is bounded, so a client that reconnects after a long gap reads the run again
  from the API.

## Alternatives considered

### A token in the URL

**Cons:** the token appears in logs, referrers, and history.
**Why not chosen:** it leaks a credential.

### A session cookie

**Cons:** adds server-side session state and cross-site concerns.
**Why not chosen:** the API is stateless by design.
