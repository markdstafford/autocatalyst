---
created: 2026-04-12
last_updated: 2026-04-13
status: implementing
issue: 28
specced_by: markdstafford
implemented_by: markdstafford
superseded_by: null
---

# Run persistence

## What

Run state lives only in memory today. When the server stops, it's gone. This feature writes run state to disk on every change and loads it back on startup — specs waiting for approval keep waiting, feedback cycles resume, interrupted runs get a notification.

## Why

The approval-to-implementation cycle spans hours. Any restart today silently resets it: threads go quiet and the human starts over. This is especially painful while developing Autocatalyst itself, where fixing a bug requires a restart and every restart destroys the run under test.

## Goals

- In-progress runs survive server restarts without human intervention
- Runs in terminal or indeterminate states at restart time are surfaced clearly rather than silently dropped
- No change to normal operation: a running server behaves identically whether persistence is enabled or not
- The persistence file is written synchronously on every run mutation so no state is lost even on hard crash

## Personas

- **Enzo: Engineer** — tests completed features against real Slack/Notion interactions; restarts the server when testing reveals a bug that needs a code fix

## Narratives

### A bug fix doesn't reset the testing session

Enzo is testing the approval-to-implementation flow. He's posted an idea, the spec came back looking good, and he's just approved it. The implementation starts. While it's running, Enzo notices in the logs that the spec committer is using yesterday's date in the frontmatter — a one-line bug. He fixes it and restarts the server.

Without persistence, the run is gone. The implementation agent is still running in a detached workspace, but Autocatalyst has forgotten it ever existed. The Slack thread goes silent. Enzo would have to post the idea again, wait for a new spec, and re-approve.

With persistence, Enzo restarts and the server loads the run from disk. The run was in `implementing` when the server stopped — the agent process didn't survive the restart — so the server marks it `failed` and posts a message in the thread: "Server restarted while implementation was running. Reply to try again." Enzo re-approves and the corrected implementation runs. The workspace still has whatever the agent wrote before the restart.

### A spec waits through a restart

Phoebe posted an idea yesterday and a spec came back. She hasn't had time to review it yet. The server is restarted overnight for a deployment. When Phoebe checks Slack in the morning and replies to the thread with her approval, Autocatalyst handles it normally — the run was in `reviewing_spec` when the server stopped, it loaded back in the same state, and the approval message is processed without any indication that a restart happened.

## User stories

**A bug fix doesn't reset the testing session**

- Enzo can see a notification in the Slack thread when a run is interrupted by a server restart
- Enzo can re-trigger implementation by replying to the thread after a restart

**A spec waits through a restart**

- Phoebe can approve a spec after a server restart with no special action required
- Phoebe can add implementation feedback after a server restart with no special action required
- Phoebe can request a PR after a server restart with no special action required

## Tech spec

### 1. Introduction and overview

**Dependencies**
- Feature: Approval to implementation — provides the `Run` type, `RunStage`, and `OrchestratorImpl` where all run mutations occur
- Feature: Foundation — provides `WorkspaceManager` and the workspace root path used as the persistence directory

**Technical goals**
- Run state survives a clean shutdown, a crash, and a `kill -9`
- Startup run loading completes in under 100ms for up to 1,000 persisted runs
- No mutation to run state is ever lost: the file is written synchronously before `_persistRuns` returns

**Non-goals**
- Resuming in-progress agent processes after a restart (agent processes are external subprocesses; they do not survive restarts and cannot be reconnected)
- Distributed state or multi-instance coordination
- Migrating the persistence format when the `Run` schema changes (format migration is out of scope for this feature; a future enhancement can add a version field)

**Glossary**
- **Stale run** — a run whose `stage` at load time indicates an agent process was running when the server stopped; that process no longer exists
- **Persistence file** — `<workspace_root>/.autocatalyst/runs.json`

### 2. System design and architecture

**Modified and new components**

*New*
- `src/core/run-store.ts` — `RunStore` interface and `FileRunStore` implementation

*Modified*
- `src/core/orchestrator.ts` — accepts an optional `RunStore` in `OrchestratorDeps`; calls `runStore.save(this.runs)` after every mutation; loads runs from `runStore.load()` in the constructor
- `src/index.ts` — creates `FileRunStore` and passes it to `OrchestratorImpl`

**High-level flow**

```
Startup:
  FileRunStore.load() → reads runs.json → filters workspace-missing runs
                      → resets stale stages → returns Run[]
  OrchestratorImpl constructor → populates this.runs from loaded runs

Normal operation (unchanged):
  run mutation (transition, increment attempt, set ref) → _persistRuns()
  _persistRuns() → runStore.save(this.runs) → sync write to runs.json
```

**Stale stage handling on load**

| Stage at load time | Action | Reason |
|---|---|---|
| `intake` | mark `failed` | idea intake process is dead |
| `speccing` | mark `failed` | spec generation process is dead |
| `implementing` | mark `failed` | implementation agent process is dead |
| `reviewing_spec` | keep | no active process; human can still act |
| `awaiting_impl_input` | keep | question already posted to Slack; human reply re-invokes the agent normally |
| `reviewing_implementation` | keep | no active process; human can still act |
| `done` | keep | terminal state, historical record |
| `failed` | keep | terminal state, historical record |

Runs whose `workspace_path` no longer exists on disk at load time are dropped silently (logged at debug level). The workspace was likely cleaned up manually.

**Slack notification for failed-on-load runs**

Runs marked `failed` during startup (from `implementing`, `intake`, or `speccing`) need a Slack notification posted to their thread so the human knows what happened. This requires access to `postMessage` from within the load path, which the `RunStore` itself does not have.

The orchestrator handles this as a post-load step: after populating `this.runs` from loaded data, it iterates over any runs that were marked `failed` during load (tracked by a flag on the loaded run or by comparing loaded stage vs. original stage) and enqueues a `_notifyRestartFailure` message to each run's Slack thread. This runs on the first tick of the event loop, not synchronously in the constructor.

### 3. Detailed design

**`RunStore` interface**

```typescript
// src/core/run-store.ts

export interface RunStore {
  /** Load all persisted runs. Called once at startup. */
  load(): Run[];

  /** Persist the current run Map. Called after every mutation. */
  save(runs: Map<string, Run>): void;
}
```

**`FileRunStore` implementation**

```typescript
export class FileRunStore implements RunStore {
  private readonly filePath: string;
  private readonly logger: pino.Logger;

  constructor(workspaceRoot: string, options?: { logDestination?: pino.DestinationStream }) {
    this.filePath = path.join(workspaceRoot, '.autocatalyst', 'runs.json');
    this.logger = createLogger('run-store', { destination: options?.logDestination });
  }

  load(): Run[] { ... }
  save(runs: Map<string, Run>): void { ... }
}
```

`load()`:
1. If the file does not exist, return `[]`
2. Read and parse the JSON file; if parsing fails, log a warning and return `[]`
3. Validate the parsed value is an array; if not, log a warning and return `[]`
4. For each entry: if `workspace_path` does not exist on disk, log at debug level and skip it
5. Apply stale stage transitions (see table above); set `updated_at` to now on any transition
6. Return the filtered, cleaned Run array

`save(runs)`:
1. Ensure the `.autocatalyst` directory exists (create if needed)
2. Serialize `[...runs.values()]` to JSON
3. Write synchronously using `writeFileSync` with `'utf-8'` encoding
4. On write failure: log error, do not throw (best-effort persistence — a write failure should never crash the orchestrator)

**OrchestratorDeps change**

```typescript
interface OrchestratorDeps {
  // ... existing fields ...
  runStore?: RunStore;  // optional: if absent, runs are not persisted
}
```

**Mutation points in `orchestrator.ts`**

Every place that modifies run state calls `this._persistRuns()` afterward:

| Location | Mutation |
|---|---|
| `createRun` | `this.runs.set(idea_id, run)` |
| `transition` | `run.stage = ...`, `run.updated_at = ...` |
| `_handleSpecApproval` | `run.attempt += 1` |
| `_handleImplementationFeedback` | `run.attempt += 1` |
| `_runImplementation` | `run.impl_feedback_ref = pageId` |

`_persistRuns` is a private synchronous method:

```typescript
private _persistRuns(): void {
  this.deps.runStore?.save(this.runs);
}
```

**Constructor load and restart notification**

```typescript
constructor(deps: OrchestratorDeps) {
  this.deps = deps;
  this.runs = new Map();

  if (deps.runStore) {
    const loaded = deps.runStore.load();
    const restarted: Run[] = [];
    for (const run of loaded) {
      this.runs.set(run.idea_id, run);
      // any run that was previously in a process-dependent stage
      // and is now 'failed' was transitioned by the store on load
      if (run.stage === 'failed' && run._restart_failed) {
        restarted.push(run);
      }
    }
    // Schedule restart notifications on next tick
    if (restarted.length > 0) {
      setImmediate(() => this._notifyRestartFailures(restarted));
    }
  }
}
```

Rather than a `_restart_failed` flag on the Run type (which would pollute the domain model), the orchestrator detects this differently: `FileRunStore.load()` returns runs tagged with a separate signal. The simplest approach is for `load()` to return a tuple or for `FileRunStore` to expose the set of `idea_id`s that were demoted. This avoids modifying the `Run` interface.

Revised approach: `FileRunStore` exposes `demotedIds: Set<string>` as a public property populated during `load()`. The orchestrator reads this after calling `load()`:

```typescript
if (deps.runStore instanceof FileRunStore) {
  const demoted = deps.runStore.demotedIds;
  // ...schedule notifications for demoted idea_ids
}
```

This is a minor coupling but avoids polluting the `Run` interface or the `RunStore` contract with startup-only state.

**`_notifyRestartFailures`**

Posts a message to each affected run's Slack thread:

```
"Server restarted while this was running. The run has been marked as failed. Reply in this thread to try again."
```

Uses `this.deps.postMessage(run.channel_id, run.thread_ts, message)`.

Note: `Run` does not currently include `channel_id` or `thread_ts` — these are on the `Idea` but not copied to the `Run`. The orchestrator will need to store these on the `Run` so it can post to the thread after a restart.

**`Run` interface additions**

```typescript
export interface Run {
  // existing fields unchanged
  channel_id: string;   // Slack channel ID for posting restart notifications
  thread_ts: string;    // Slack thread timestamp for posting restart notifications
}
```

These are populated when the run is created in `createRun` (already has access to the `Idea`).

### 4. Security, privacy, and compliance

**Data at rest**
- `runs.json` is written to `<workspace_root>/.autocatalyst/runs.json` — a local path under the operator's control
- The file contains run metadata: idea_id, stage, workspace_path, branch, spec_path, publisher_ref, attempt counts, and timestamps
- It does not contain message content, spec text, or any sensitive user data
- No encryption is applied — this is a developer tool for local operation; the file's security follows the filesystem permissions of the workspace_root directory

**Input validation**
- The JSON file is parsed with `JSON.parse`; a corrupt or tampered file causes `load()` to return `[]` gracefully (logged as warning)
- workspace_path from the file is validated via `fs.existsSync` before the run is rehydrated — no filesystem operations are performed on the path beyond this check

### 5. Observability

**Logging**

| Event | Level | Component |
|---|---|---|
| `run_store.loaded` | info | run-store |
| `run_store.load_failed` | warn | run-store |
| `run_store.run_dropped` | debug | run-store |
| `run_store.run_demoted` | info | run-store |
| `run_store.saved` | debug | run-store |
| `run_store.save_failed` | error | run-store |

`run_store.loaded` includes `total_loaded`, `dropped_count`, `demoted_count`.
`run_store.run_demoted` includes `idea_id`, `from_stage`, `to_stage` (always `failed`).
`run_store.save_failed` includes `error` — this is the only case where persistence silently degrades.

### 6. Testing plan

All tests use Vitest. Real temp directories used for filesystem operations. Log output captured via `destination` injection.

---

**FileRunStore**

_`load` — file not found_
- Returns `[]` when the persistence file does not exist
- No error thrown; `run_store.loaded` emitted with `total_loaded: 0`

_`load` — corrupt file_
- `load()` returns `[]` when the file contains invalid JSON
- `run_store.load_failed` emitted with the parse error

_`load` — not an array_
- `load()` returns `[]` when the file contains valid JSON but not an array
- `run_store.load_failed` emitted

_`load` — workspace path missing_
- Run with a `workspace_path` that does not exist on disk is excluded from the returned array
- `run_store.run_dropped` emitted with `idea_id`
- Run with an existing `workspace_path` is included

_`load` — stale stage demotion_
- Run in `implementing` stage is returned with `stage: 'failed'` and updated `updated_at`
- `run_store.run_demoted` emitted with `from_stage: 'implementing'`, `to_stage: 'failed'`
- Run in `speccing` stage is returned with `stage: 'failed'`
- Run in `intake` stage is returned with `stage: 'failed'`
- Run in `reviewing_spec` stage is returned unchanged
- Run in `awaiting_impl_input` stage is returned unchanged
- Run in `reviewing_implementation` stage is returned unchanged
- Run in `done` stage is returned unchanged
- Run in `failed` stage is returned unchanged

_`load` — mixed_
- File with 5 runs: 1 missing workspace, 1 implementing, 1 reviewing_spec, 1 done, 1 failed
- Returns 4 runs: implementing demoted to failed, others unchanged, missing workspace excluded
- `total_loaded: 4`, `dropped_count: 1`, `demoted_count: 1`

_`save`_
- Creates the `.autocatalyst` directory if it does not exist
- Writes all runs from the Map as a JSON array to the file
- `save` then `load` round-trips all run fields correctly
- `run_store.saved` emitted at debug level

_`save` — write failure_
- When `writeFileSync` throws (e.g., readonly filesystem), `run_store.save_failed` emitted with error
- `save` does not throw; caller is unaffected

_`demotedIds`_
- After `load()`, `demotedIds` contains the `idea_id` of every run that was demoted
- `demotedIds` is empty before `load()` is called
- `demotedIds` is empty when no runs are demoted

---

**Orchestrator — persistence integration**

_Loads runs on construction_
- OrchestratorImpl constructed with a `RunStore` that returns two runs
- `this.runs` is populated with both runs immediately after construction
- No run mutations occur during construction for `reviewing_spec`/`reviewing_implementation` runs

_Persists after `createRun`_
- After `new_idea` event processed and run created, `runStore.save` called once with the new run in the Map

_Persists after `transition`_
- After any stage transition, `runStore.save` called with updated run state
- The persisted run's `stage` reflects the new stage

_Persists after `attempt` increment_
- After `attempt` is incremented (on spec approval or impl feedback), `runStore.save` called

_Persists after `impl_feedback_ref` set_
- After implementation feedback page created and `impl_feedback_ref` stored, `runStore.save` called

_No persistence without RunStore_
- OrchestratorImpl constructed without `runStore` — no errors; runs are in-memory only
- All existing orchestrator tests remain passing (RunStore is optional)

_Notifies Slack for demoted runs_
- OrchestratorImpl constructed with FileRunStore whose `demotedIds` contains one idea_id
- On next tick, `postMessage` called with the run's `channel_id`, `thread_ts`, and restart notification message

---

**Run interface — channel_id and thread_ts**

_`createRun` populates new fields_
- Run created from an `Idea` has `channel_id` and `thread_ts` matching the idea
- Round-trip through `FileRunStore`: `channel_id` and `thread_ts` survive save/load

### 7. Alternatives considered

**Persist only on graceful shutdown**

Writing to disk only when the server receives SIGTERM/SIGINT rather than after every mutation. Simpler write path, but doesn't survive hard crashes or `kill -9`. Since the primary motivation is surviving restarts during debugging (where the process may be killed abruptly), this was rejected.

**SQLite instead of JSON**

A SQLite database would handle concurrent access and provide transactional writes. Rejected because there's no concurrent access (single-process, single-thread event loop), and SQLite adds a native dependency with no benefit here. A flat JSON file written synchronously is sufficient.

**Persist in the target repo's working directory**

Writing `runs.json` to the target repo being developed (the repo Autocatalyst is pointed at) rather than the workspace root. Rejected because it would pollute the target repo and would need to be gitignored in each target repo. The workspace root is Autocatalyst's own scratch space and is the right location.

**Async file writes**

Using `writeFile` (async) instead of `writeFileSync`. Async writes are non-blocking but require care around concurrent mutations — two rapid transitions could race and the second write could complete before the first, leaving stale data on disk. Synchronous writes are safe given the single-threaded event loop and the infrequency of mutations (at most a few per minute). If write latency becomes a problem, a debounced async write with a version counter can be added later.

### 8. Risks

**Corrupt persistence file blocks startup**

If `runs.json` is corrupt, `load()` returns `[]` and the service starts clean. Active threads in Slack go silent (the runs are lost). Mitigation: log a clear warning at startup (`run_store.load_failed`) so the operator knows state was discarded. Future enhancement: keep a rolling backup (`runs.json.bak`) written before each overwrite, so a corrupt primary file can be recovered manually.

**Workspace path check is a race**

Between `load()` checking `existsSync(run.workspace_path)` and the orchestrator actually using the run, the workspace could be deleted. Mitigation: this is the same race that exists today (the workspace is always assumed to exist when the run references it); the persistence feature doesn't make it worse.

**`channel_id`/`thread_ts` additions to `Run`**

Adding two new required fields to `Run` requires updating every `createRun` call and every test that constructs a Run directly. The test helpers (`makeRun`) in the orchestrator test suite will need these fields added. The `Idea` already carries `channel_id` and `thread_ts`, so the data is available at run creation time. This is straightforward but touches a lot of test code. Mitigation: update `makeRun` once; all tests that use it inherit the defaults automatically.

## Task list

- [x] **Story: Run interface — add Slack thread fields**
  - [x] **Task: Add `channel_id` and `thread_ts` to `Run` interface**
    - **Description**: Add `channel_id: string` and `thread_ts: string` to the `Run` interface in `src/types/runs.ts`. Update `createRun` in `src/core/orchestrator.ts` to populate these fields from the `Idea`. Update `makeRun` in `tests/core/orchestrator.test.ts` with default values (`channel_id: 'C001'`, `thread_ts: '1000.0000'`) so all existing tests continue to compile. Run `npx tsc --noEmit` and `npx vitest run` to confirm no regressions.
    - **Acceptance criteria**:
      - [x] `Run` interface includes `channel_id: string` and `thread_ts: string`
      - [x] `createRun` in orchestrator populates both fields from the `Idea` argument
      - [x] `makeRun` test helper includes default values for both fields
      - [x] `npx tsc --noEmit` — no errors
      - [x] `npx vitest run` — all tests pass
    - **Dependencies**: None

- [x] **Story: FileRunStore**
  - [x] **Task: Unit tests for `FileRunStore`**
    - **Description**: Create `tests/core/run-store.test.ts`. Use real temp directories (created in `beforeEach`, cleaned in `afterEach`). Cover all cases from the testing plan: `load` (file not found, corrupt JSON, non-array JSON, missing workspace path, stale stage demotion for all affected stages, unchanged stages, mixed scenarios), `save` (directory creation, round-trip, write failure as non-fatal), and `demotedIds` lifecycle. Assert all logging events with correct fields.
    - **Acceptance criteria**:
      - [x] `load` returns `[]` for missing file, corrupt JSON, non-array JSON
      - [x] `load` drops runs with non-existent `workspace_path`; `run_store.run_dropped` emitted
      - [x] `load` demotes `implementing`, `speccing`, `intake` → `failed`; `run_store.run_demoted` emitted with `from_stage`/`to_stage`
      - [x] `load` preserves `reviewing_spec`, `awaiting_impl_input`, `reviewing_implementation`, `done`, `failed` unchanged
      - [x] `load` emits `run_store.loaded` with correct counts
      - [x] `save` creates the `.autocatalyst` directory if absent
      - [x] `save`/`load` round-trip preserves all `Run` fields including new `channel_id`/`thread_ts`
      - [x] `save` failure is non-fatal; `run_store.save_failed` emitted
      - [x] `demotedIds` populated after `load`; empty before `load` and when no demotions
      - [x] All tests pass: `npx vitest run`
    - **Dependencies**: "Task: Add `channel_id` and `thread_ts` to `Run` interface"

  - [x] **Task: Implement `FileRunStore`**
    - **Description**: Create `src/core/run-store.ts`. Export the `RunStore` interface and `FileRunStore` class. Constructor takes `workspaceRoot: string` and optional `logDestination`. `load()` reads and parses `<workspaceRoot>/.autocatalyst/runs.json`, applies workspace-exists filtering and stale stage demotion, populates `demotedIds`, and returns the cleaned array. `save()` ensures the directory exists, serializes the Map values to JSON, and writes synchronously with `writeFileSync`. Write failure is caught and logged without re-throwing. Uses `createLogger('run-store')`.
    - **Acceptance criteria**:
      - [x] `RunStore` interface exported with `load(): Run[]` and `save(runs: Map<string, Run>): void`
      - [x] `FileRunStore` constructor takes `workspaceRoot` and optional log destination
      - [x] `load()` implements all filtering and demotion logic from the spec
      - [x] `save()` writes synchronously; directory created if absent; failure non-fatal
      - [x] `demotedIds: Set<string>` public property populated during `load()`
      - [x] All tests from preceding task pass: `npx vitest run`
    - **Dependencies**: "Task: Unit tests for `FileRunStore`"

- [x] **Story: Orchestrator persistence integration**
  - [x] **Task: Add persistence tests to orchestrator test suite**
    - **Description**: Add a new describe block `"Orchestrator — run persistence"` in `tests/core/orchestrator.test.ts`. Use a mock `RunStore` (`{ load: vi.fn().mockReturnValue([]), save: vi.fn() }`). Test: runs loaded from store on construction; `save` called after `createRun`; `save` called after each stage transition; `save` called after `attempt` increment; `save` called after `impl_feedback_ref` set; no errors when `runStore` is absent (existing tests unchanged). Also test the Slack restart notification: construct with a `FileRunStore` mock where `demotedIds` contains one `idea_id` matching a pre-loaded run; verify `postMessage` is called on the next tick with the restart notification message.
    - **Acceptance criteria**:
      - [x] `runStore.save` called once after `createRun`
      - [x] `runStore.save` called after every `transition` call
      - [x] `runStore.save` called after `attempt` increment
      - [x] `runStore.save` called after `impl_feedback_ref` set on run
      - [x] Runs from `runStore.load()` are available in orchestrator on construction
      - [x] No `runStore` in deps → no errors; all existing tests pass
      - [x] `postMessage` called on next tick for each demoted run with correct `channel_id`, `thread_ts`, and restart message text
      - [x] All tests pass: `npx vitest run`
    - **Dependencies**: "Task: Implement `FileRunStore`"

  - [x] **Task: Wire `RunStore` into `OrchestratorImpl`**
    - **Description**: Update `src/core/orchestrator.ts`. Add `runStore?: RunStore` to `OrchestratorDeps`. In the constructor, call `deps.runStore?.load()` and populate `this.runs` from the returned array; schedule `_notifyRestartFailures` on `setImmediate` for any `idea_id`s in `FileRunStore.demotedIds`. Add `_persistRuns(): void` private method that calls `this.deps.runStore?.save(this.runs)`. Call `_persistRuns()` at each of the 5 mutation points: after `this.runs.set` in `createRun`, after each `run.stage =` / `run.updated_at =` assignment in `transition`, after `run.attempt +=` in both handlers, and after `run.impl_feedback_ref =` in `_runImplementation`. Add `_notifyRestartFailures(runs: Run[])` that calls `postMessage` for each.
    - **Acceptance criteria**:
      - [x] `runStore` optional field added to `OrchestratorDeps`
      - [x] Constructor loads runs from store and populates `this.runs`
      - [x] `_persistRuns()` called at all 5 mutation points
      - [x] `_notifyRestartFailures` posts restart message to correct Slack thread per run
      - [x] All tests from preceding task pass: `npx vitest run`
    - **Dependencies**: "Task: Add persistence tests to orchestrator test suite"

- [x] **Story: Service wiring**
  - [x] **Task: Wire `FileRunStore` in `src/index.ts` and run full test suite**
    - **Description**: Update `src/index.ts` to create a `FileRunStore` using the resolved `workspaceRoot` and pass it to `OrchestratorImpl` via `OrchestratorDeps`. Ensure the `.autocatalyst` directory creation is handled by `FileRunStore` itself (no extra setup needed in `index.ts`). After wiring, run `npx vitest run` and `npx tsc --noEmit` to verify no regressions.
    - **Acceptance criteria**:
      - [x] `FileRunStore` created with `workspaceRoot` and passed to `OrchestratorImpl`
      - [x] No extra directory creation needed in `index.ts`
      - [x] `npx tsc --noEmit` — no type errors
      - [x] `npx vitest run` — all tests pass
    - **Dependencies**: "Task: Wire `RunStore` into `OrchestratorImpl`"
