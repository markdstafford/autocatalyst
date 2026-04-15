---
created: 2026-04-15
last_updated: 2026-04-15
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR 004: Concurrent dispatch for the orchestrator run loop

## Status

Accepted

## Context

The orchestrator's `_runLoop` processes events serially: each handler must complete before the next event is dequeued. As the set of request types grows — spec generation, implementation, question answering — any long-running handler blocks every subsequent request regardless of type. A user asking a quick question waits behind another user's multi-minute implementation run.

The goal is to allow multiple handlers to run concurrently while preserving two safety properties:
1. **No duplicate dispatches** — two rapid approvals for the same run must not both trigger an implementation.
2. **Bounded resource use** — an unlimited number of concurrent agent processes would exhaust memory and subprocess limits on a constrained host.

## Decision

Adopt a **serial classification + concurrent dispatch** model:

- **Classification is serial and awaited in the main loop.** Each event is classified and a dispatch decision is committed (including any stage transition) before the next event is dequeued. This is the primary deduplication gate.
- **Dispatch is concurrent.** Once classified as `'dispatch'`, the heavy handler (`_handleRequest`) is launched without `await` and tracked in `_inFlight: Set<Promise<void>>`.
- **Concurrency is bounded.** A configurable `maxConcurrentRuns` option (default: 5) caps the number of simultaneous in-flight handlers. Events that arrive when the limit is reached are buffered in a FIFO `_queue: InboundEvent[]` and promoted as slots open.
- **`stop()` drains all in-flight work.** The run loop exits normally and then awaits `Promise.allSettled([..._inFlight])` in a while loop until the set is empty, including any handlers promoted from the queue during draining.

### Serial classification guarantee

`_classify` runs serially per event. For `thread_message` events it checks the run's current stage. If the stage is actionable (`reviewing_spec`, `reviewing_implementation`, `awaiting_impl_input`), it advances the stage atomically *before* returning `'dispatch'`. Any duplicate message that arrives while the first handler is processing sees the already-advanced stage and is classified `'discard'`. This window — between `_classify` advancing the stage and the handler actually processing the event — is deliberately narrow and entirely in-process with no I/O, making it race-free.

The stage guards inside `_handleRequest` and the individual handler methods remain as secondary safety nets but are not the primary deduplication mechanism.

## Trade-offs

**Positive:**
- Every new request starts processing immediately; no head-of-line blocking.
- Failure in one run (transition to `failed`, error posted to thread) cannot affect other in-flight runs — they are separate promises with their own error handling.
- Queue depth is directly observable; `run.queued` log events and the `orchestrator.queue_depth` gauge provide clear signals when the limit needs tuning.
- No new dependencies — the ~50-line implementation reuses existing pino logging and TypeScript Promise primitives.

**Negative:**
- The `_pendingStage` map adds a small amount of state to manage; it must be cleaned up in `_handleRequest` to avoid leaks.
- The `intake` stage intent-upgrade path (a question run receiving a follow-up classified as idea/bug) is no longer processed, because `_classify` discards `thread_message` events for runs in non-actionable stages. This is an acceptable simplification given the feature's scope.
- A self-transition log (`from_stage: implementing → to_stage: implementing`) is emitted when `_handleSpecApproval` calls `this.transition(run, 'implementing')` after `_classify` has already advanced the stage. This is cosmetically noisy but functionally harmless.

## Alternatives considered

**Fire-and-forget with no concurrency limit** — Simpler, but unbounded concurrency risks memory/process exhaustion on constrained hosts. A configurable limit with a sensible default is low-cost insurance.

**Back-pressure via async generator pause** — Pausing the `for await` loop when at capacity would block classification of subsequent events, violating the requirement that classification is always immediate. The explicit `_queue` array keeps classification and dispatch decoupled and makes queue depth directly measurable.

**Fully concurrent classification** — Dispatching every event to a concurrent handler and relying solely on stage guards inside `_handleRequest` for deduplication requires locks to prevent two handlers for the same run from both passing the guard before either writes back the new stage. The serial `_classify` step eliminates this window without introducing locks.

**Worker pool library (`p-limit`)** — A library like `p-limit` provides a bounded concurrency primitive. Rejected because the additional dependency adds little over the ~50-line custom implementation, which integrates naturally with the existing in-flight tracking needed by `stop()`.
