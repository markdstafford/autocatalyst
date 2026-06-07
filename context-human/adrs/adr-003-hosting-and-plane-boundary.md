---
created: 2026-06-03
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-003: Hosting model and the control/execution-plane boundary

## Status

Accepted

## Context

Autocatalyst has two responsibilities that pull in different directions. It is a **source of
truth** (runs, specs, the domain, to be queried, collaborated on, and surfaced in a UX) and it
is an **executor of agent work** (cloning a repo into a workspace, driving a tool-using agent
session, producing a build). We must decide where each runs, how they relate, and how a human
inspects and tests a build a run produces.

Four requirements bear on the choice. More than one person may need to participate in a run, a
spec, or a review, so the design supports **collaboration**. Reviewing a produced build,
running it and previewing the diff that becomes a PR, is a core human touchpoint that must stay
easy. The product is heading toward proactive, scheduled work that continues when no human is at
a keyboard, so it needs **always-on operation**. And desktop, mobile, and optional channel
adapters are all peer consumers of one service, which means **one source of truth, many
clients**.

The terms: the **control plane** owns scheduling, run state (single-authority), the API, and
persistence. The **execution plane** owns a run's workspace and the agent session that acts in
it.

## Decision

**The control plane is a standalone, network-API service that is the source of truth, and
agent execution runs host-side alongside it. An internal `Runner` interface splits the two
planes. It is in-process and co-located by default, and assumes no shared memory so the
boundary can later become a network/queue contract without redesign.**

- The control plane runs as a standalone service (on a developer machine or a hosted host);
  clients reach it only over the network API. It is never embedded inside a client.
- Execution runs **on the same host** as the control plane. Host-side execution is what makes
  collaboration, coherent repository access, and always-on operation possible.
- The control/execution split is a real interface boundary enforced in the codebase (ADR-002),
  but the planes run in one process by default. Because the interface assumes no shared memory,
  extracting execution into separately deployed workers later requires no change to the
  contract.
- **Extracting execution** into separate workers is a deferred option, taken when execution
  must scale out, be isolated from control-plane faults, or run across multiple hosts. Extracted
  workers are **centralized/cloud-hosted, never run on end-user machines.**
- **Local needs are served two ways:** previewing a diff or a PR is served by the **API** (no
  local copy required); running and testing a build is served by a **shallow clone of the host
  workspace** to the local machine, managed by the desktop/mobile app.
- The repository lives on the host: the control plane reads it (specs, concept docs) for intake
  and display, and execution clones per-run workspaces from it.

## Consequences

**Positive:**
- Collaboration, coherent repo access, and always-on operation all follow from host-side
  execution.
- The single-host default keeps operations simple (one service, one process, no inter-plane
  network) while the enforced interface preserves the seam to scale out later.
- A clear, single source of truth that every client consumes identically.
- Local testing remains a first-class, low-friction path via shallow clone.

**Negative:**
- Agent work consumes host resources (CPU, disk for workspaces); a busy host needs capacity
  planning, and the eventual answer is execution extraction.
- A co-located agent child process that misbehaves can affect the host until execution is
  extracted for isolation.
- Testing a build on a remote host requires a clone-down step rather than the build already
  being on the tester's machine.

## Alternatives considered

### Execution on a runner that lives on the user's own machine

The control plane is central, but a runner registered to it executes runs on the individual
user's local machine.

**Pros:**
- Testing a build is local: it is already on the tester's machine.
- Uses the user's own compute and credentials, kept on their machine.
- No host capacity planning for execution.

**Cons:**
- Fragments collaboration: a teammate cannot join a run executing on someone else's laptop.
- Splits repository access: the central control plane needs its own copy to read specs while
  the local runner holds the workspace.
- Cannot support always-on/proactive operation, which needs a host that is up when no human is.

**Why not chosen:** Collaboration, coherent repo access, and always-on operation each
independently require host-side execution. The only thing local execution protects, easy
testing, is served more cheaply by a shallow clone.

### Control plane embedded inside the desktop app

The source-of-truth service is bundled into the desktop application rather than standing alone.

**Pros:**
- Simplest possible local experience: one thing to launch.
- No separate service process to manage on a single-operator machine.

**Cons:**
- Couples the source of truth to one client, breaking the peer-client model that mobile and
  channel adapters depend on.
- No path to a hosted, collaborative, or always-on deployment.
- The source of truth becomes unavailable whenever the desktop app is closed.

**Why not chosen:** It forecloses collaboration, mobile, and hosting. (A desktop installer may
still *bundle and supervise* the standalone service for a frictionless local launch; that is
packaging convenience, not embedding.)

### A network/queue boundary between the planes from day one

Make the control/execution split a deployed network boundary immediately, with execution as a
separate service.

**Pros:**
- Execution can scale and be isolated from the start.
- Forces a fully decoupled contract early.

**Cons:**
- Imposes distributed-systems complexity (a wire protocol, worker registration, reconnection,
  backpressure) on a workload that is single-host for the foreseeable future.
- More moving parts to operate and debug for no near-term benefit.

**Why not chosen:** Co-located in-process execution behind a no-shared-memory interface gets the
seam without the operational cost; the network boundary is added only when extraction is
actually warranted.

### Local-first-only service

A service that runs only locally, exposing remote access solely for mobile notifications. It
caps collaboration and always-on operation, two of the four driving requirements, so it cannot
carry the product where it is going.
