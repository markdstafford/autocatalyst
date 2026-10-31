---
created: 2026-10-30
last_updated: 2026-10-30
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-031: The web client is one stateless web app

## Status

Accepted

## Context

Autocatalyst needs a first real client for operators: a place to start a run from an issue, follow it,
review it at each gate, and recover it. The control plane already holds all run state (ADR-003). Operators
will want the same client on a desktop and, for a subset of tasks, on a phone. Keeping a web, a desktop,
and a mobile client in step is a cost that grows with every screen.

## Decision

**The client is one web app that talks only to the control plane's HTTP and SSE API. It keeps no run or
project state of its own. The browser stores only the operator's preferences. The desktop app wraps the
same web app and adds device features such as a keychain, and a mobile mode shows a subset.**

- The client uses the typed SDK and the API contract (ADR-005, ADR-007) and nothing else for data.
- A run is not tied to a device. An operator starts a run on one device and continues it on another.
- The control plane serves the built client, so the client needs no separate host. This is a deployment
  detail and does not change the rule above.

## Consequences

**Pros:**
- One code base for every device.
- Run state lives in one place, so devices cannot disagree.
- Testing the client against a scripted control plane covers the whole client.

**Cons:**
- The mobile mode and the desktop wrapper depend on the web app's layout and input model.
- Any state the operator expects to follow them, such as saved views, must be stored by the control plane
  to follow them across devices. Preferences in the browser do not.

## Alternatives considered

### A native desktop app and a native mobile app

**Pros:** device features without a wrapper.
**Cons:** three code bases to keep in step for one operator workflow.
**Why not chosen:** a wrapper adds the device features that matter, such as a keychain, at far lower cost.

### A client that keeps a local copy of run state

**Pros:** faster to draw and usable offline.
**Cons:** two copies of state that can disagree, and a sync problem for every run.
**Why not chosen:** the control plane is the single source of truth.
