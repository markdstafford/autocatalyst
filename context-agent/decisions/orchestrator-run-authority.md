---
date: 2026-06-08
status: accepted
superseded_by: null
---
# orchestrator-run-authority

**Decision:** `packages/core/src/orchestrator.ts` (`DefaultOrchestrator`) owns all run
mutation authority. Units of work return a `RunWorkResult` directive; only the orchestrator
calls `applyRunDirective` / `startRunLifecycle` and only the orchestrator publishes
`run_state_transition` events — strictly after the persistence call returns successfully.

**Rationale:**
- Single mutation chokepoint keeps event-publication invariants enforceable in one place.
- Units of work stay pure handlers (no repo writes), which is easier to test and replace.
- Conflict mapping (`active_run_conflict`) and lifecycle error mapping live next to the
  state machine so HTTP and other ingress layers consume a stable `OrchestratorError` API.

**Constraints:**
- `packages/core` MUST NOT import from `packages/persistence`. The active-run conflict
  detector defaults to duck-typing `error.name === 'ActiveRunConflictPersistenceError'`,
  and unwraps one `cause` level so it works whether persistence throws directly or via
  `RunLifecycleError('start_persistence_failed', …, { cause })`. Constructor accepts an
  override `isActiveRunConflict` for tests or alternate persistence drivers.
- Dispatch goes through `RunDispatchQueue.enqueue` so a failed unit-of-work still releases
  the slot via the queue's `.finally()` drain.
- Events are constructed via `createRunStateTransitionEvent` (zod-validated), which means
  `start` is allowed at create-time only (matches `runStateTransitionKindSchema`).

**Rejected:**
- Letting unit-of-work writes touch repositories directly — rejected: splits authority,
  makes the "no event without persistence" rule unenforceable.
- Importing `ActiveRunConflictPersistenceError` from persistence — rejected: violates the
  core → persistence boundary; duck-typing keeps core dependency-free.
