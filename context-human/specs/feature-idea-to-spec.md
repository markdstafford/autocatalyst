---
created: 2026-04-08
last_updated: 2026-04-09
status: implemented
---

# Idea to spec to review

Spec generation from an idea, posted to Slack for iterative human review.

## Scope

- Receive classified idea from message router
- Run `claude` CLI with mm:planning to generate spec headlessly
- Post spec sections to the idea's Slack thread
- Collect human feedback from thread replies
- Iterate: feed feedback back to spec generation, repost updated sections
- Continue until human is satisfied (but approval is a separate feature)

## Task list

- [x] **Story: Run types**
  - [x] **Task: Define `RunStage` and `Run` types**
    - **Description**: Create `src/types/runs.ts` with the `RunStage` union type and `Run` interface as specified in Section 3. Export both from the file.
    - **Acceptance criteria**:
      - [x] `RunStage` is `'intake' | 'speccing' | 'review' | 'approved' | 'failed'`
      - [x] `Run` interface has all fields: `id`, `idea_id`, `stage`, `workspace_path`, `branch`, `spec_path`, `canvas_id`, `attempt`, `created_at`, `updated_at`
      - [x] `spec_path` and `canvas_id` are `string | undefined`
      - [x] File compiles without errors under `NodeNext` module resolution
    - **Dependencies**: None

- [x] **Story: WorkspaceManager**
  - [x] **Task: Implement `WorkspaceManager`**
    - **Description**: Create `src/core/workspace-manager.ts` with the `WorkspaceManager` interface and a concrete implementation. `create` runs `git clone --depth=1 <repo_url> <workspace_path>` then `git -C <workspace_path> checkout -b spec/<slug>` as child processes with `util.promisify(exec)`. The slug is derived from the first five words of `idea_id`, lowercased and hyphenated. If clone fails, remove the directory before throwing. `destroy` removes the directory recursively.
    - **Acceptance criteria**:
      - [x] `WorkspaceManager` interface exported: `create(idea_id, repo_url)` and `destroy(workspace_path)`
      - [x] `create` constructs `workspace_path` as `<config.workspace.root>/<idea_id>`
      - [x] `create` runs `git clone --depth=1 <repo_url> <workspace_path>` as a subprocess
      - [x] `create` runs `git -C <workspace_path> checkout -b spec/<slug>` after a successful clone
      - [x] `create` removes the cloned directory and re-throws if the clone command exits non-zero
      - [x] `create` throws if the checkout command exits non-zero
      - [x] `create` returns `{ workspace_path, branch }`
      - [x] `destroy` removes the directory recursively (equivalent to `rm -rf`)
      - [x] All relative imports use `.js` extensions
    - **Dependencies**: None

  - [x] **Task: Unit tests for `WorkspaceManager`**
    - **Description**: Create `tests/core/workspace-manager.test.ts`. Mock `child_process.exec` (via the promisified wrapper) with `vi.fn()`. Use a real temp directory for path construction assertions. Cover all cases from the testing plan's WorkspaceManager section.
    - **Acceptance criteria**:
      - [x] `create` issues the correct `git clone` command with `--depth=1` and the right path
      - [x] `create` issues the correct `git checkout -b` command after a successful clone
      - [x] `create` returns `{ workspace_path, branch }` with correct values
      - [x] `create` throws and removes the cloned directory if clone exits non-zero
      - [x] `create` throws if checkout exits non-zero
      - [x] `destroy` removes the workspace directory
      - [x] Two calls with different `idea_id`s produce non-overlapping paths
      - [x] All tests pass: `npm test`
    - **Dependencies**: "Task: Implement `WorkspaceManager`"

- [x] **Story: SpecGenerator**
  - [x] **Task: Implement `SpecGenerator`**
    - **Description**: Create `src/adapters/agent/spec-generator.ts` with the `SpecGenerator` interface and a concrete `OMCSpecGenerator` implementation. `create` spawns `omc ask claude --print "<prompt>"` with `cwd` set to `workspace_path`, reads the artifact at the path printed to stdout, extracts the `## Raw output` section, parses the `FILENAME:` line, validates it against `^(feature|enhancement)-[a-z0-9-]+\.md$`, writes the spec body to `<workspace_path>/context-human/specs/<filename>`, and returns the path. `revise` builds a prompt with the feedback content in `<<<`/`>>>` delimiters first, then the current spec content in `<<<`/`>>>` delimiters, invokes OMC identically, and overwrites the spec file in place with the revised content.
    - **Acceptance criteria**:
      - [x] `SpecGenerator` interface exported: `create(idea, workspace_path)` and `revise(feedback, spec_path, workspace_path)`
      - [x] `create` spawns OMC with `cwd: workspace_path` and the generation prompt from Section 3
      - [x] Generation prompt wraps `idea.content` in `<<<`/`>>>` and includes the `FILENAME:` instruction on the first line
      - [x] `create` reads the artifact file from the path printed to stdout
      - [x] `create` parses `FILENAME:` from within the `## Raw output` section
      - [x] `create` validates the filename against `^(feature|enhancement)-[a-z0-9-]+\.md$`; throws with a descriptive error if invalid or missing
      - [x] `create` writes the spec body (everything after the `FILENAME:` line) to `<workspace_path>/context-human/specs/<filename>`
      - [x] `create` returns the full spec path
      - [x] `create` throws if OMC exits non-zero
      - [x] `revise` prompt leads with feedback in `<<<`/`>>>`, follows with current spec content in `<<<`/`>>>`
      - [x] `revise` reads the current spec from `spec_path` before invoking OMC
      - [x] `revise` overwrites `spec_path` with the revised content from the artifact
      - [x] `revise` throws if OMC exits non-zero
      - [x] All relative imports use `.js` extensions
    - **Dependencies**: None

  - [x] **Task: Unit tests for `SpecGenerator`**
    - **Description**: Create `tests/adapters/agent/spec-generator.test.ts`. Mock the OMC subprocess with `vi.fn()` by intercepting the spawn/exec call. Use real temp directories for file I/O. Write fixture artifact files with varying `FILENAME:` values to test parsing. Cover all cases from the testing plan's SpecGenerator section.
    - **Acceptance criteria**:
      - [x] `create` spawns OMC with the correct `cwd` and prompt content
      - [x] `create` correctly parses `FILENAME: feature-setup-wizard.md`
      - [x] `create` correctly parses `FILENAME: enhancement-some-thing.md`
      - [x] `create` throws with a descriptive error on `FILENAME: invalid_name.md` (underscore)
      - [x] `create` throws on `FILENAME: setup-wizard.md` (missing `feature-`/`enhancement-` prefix)
      - [x] `create` throws when the `FILENAME:` line is absent
      - [x] `create` writes the correct spec body to the correct path and returns it
      - [x] `create` throws if OMC exits non-zero
      - [x] `revise` prompt leads with feedback in `<<<`/`>>>`, follows with spec content in `<<<`/`>>>`
      - [x] `revise` reads the current spec from `spec_path` before invoking OMC
      - [x] `revise` overwrites the spec file in place with revised content
      - [x] `revise` throws if OMC exits non-zero
      - [x] All tests pass: `npm test`
    - **Dependencies**: "Task: Implement `SpecGenerator`"

- [x] **Story: CanvasPublisher**
  - [x] **Task: Implement `CanvasPublisher`**
    - **Description**: Create `src/adapters/slack/canvas-publisher.ts` with the `CanvasPublisher` interface and a concrete `SlackCanvasPublisher` implementation. The implementation takes the Bolt `App` instance in its constructor. `create` reads the spec file, calls `app.client.canvases.create` with the content, then calls `app.client.chat.postMessage` with the canvas link posted to the thread. `update` reads the spec file and calls `app.client.canvases.edit` with the updated content.
    - **Acceptance criteria**:
      - [x] `CanvasPublisher` interface exported: `create(channel_id, thread_ts, spec_path)` and `update(canvas_id, spec_path)`
      - [x] `create` reads spec content from `spec_path`
      - [x] `create` calls `app.client.canvases.create` with the spec content as the canvas body
      - [x] `create` calls `app.client.chat.postMessage` after `canvases.create` with `channel_id`, `thread_ts`, and a message containing the canvas link
      - [x] `create` returns the `canvas_id` from the `canvases.create` response
      - [x] `create` throws if `canvases.create` rejects; `postMessage` is not called
      - [x] `update` reads spec content from `spec_path`
      - [x] `update` calls `app.client.canvases.edit` with the correct `canvas_id` and updated content
      - [x] `update` throws if `canvases.edit` rejects
      - [x] All relative imports use `.js` extensions
    - **Dependencies**: None

  - [x] **Task: Unit tests for `CanvasPublisher`**
    - **Description**: Create `tests/adapters/slack/canvas-publisher.test.ts`. Mock `app.client.canvases.create`, `app.client.canvases.edit`, and `app.client.chat.postMessage` with `vi.fn()`. Use real temp files for spec content. Cover all cases from the testing plan's CanvasPublisher section.
    - **Acceptance criteria**:
      - [x] `create` calls `canvases.create` with the correct spec file content
      - [x] `create` calls `postMessage` after `canvases.create` with `channel_id`, `thread_ts`, and a message containing the canvas link
      - [x] `create` returns the `canvas_id` from the response
      - [x] `create` does not call `postMessage` if `canvases.create` rejects
      - [x] `update` calls `canvases.edit` with the correct `canvas_id` and updated content
      - [x] `update` throws if `canvases.edit` rejects
      - [x] All tests pass: `npm test`
    - **Dependencies**: "Task: Implement `CanvasPublisher`"

- [x] **Story: Orchestrator**
  - [x] **Task: Implement `Orchestrator`**
    - **Description**: Create `src/core/orchestrator.ts` with the `Orchestrator` interface (`start(): Promise<void>`, `stop(): Promise<void>`) and a concrete implementation. The constructor accepts `SlackAdapter`, `WorkspaceManager`, `SpecGenerator`, `CanvasPublisher`, and `repo_url`. `start()` begins consuming `SlackAdapter.receive()` in an async loop, dispatching `new_idea` and `spec_feedback` events to the pipeline. The in-memory run registry is a `Map<string, Run>` keyed by `idea_id`. `stop()` signals the loop to exit and resolves after any in-flight pipeline step completes. Stage transitions and error handling follow Section 3 exactly: on failure, transition to `failed` and post an error message to the Slack thread via `SlackAdapter`.
    - **Acceptance criteria**:
      - [x] `Orchestrator` interface exported: `start()` and `stop()`
      - [x] `new_idea`: creates `Run` in `intake`, transitions through `speccing`, calls all four components in order, transitions to `review`
      - [x] `new_idea`: `workspace_path`, `branch`, `spec_path`, `canvas_id` stored on Run after each step
      - [x] `new_idea`: WorkspaceManager failure → `failed`, error posted to thread, no further components called
      - [x] `new_idea`: SpecGenerator failure → `failed`, error posted to thread, workspace destroyed
      - [x] `new_idea`: CanvasPublisher failure → `failed`, error posted to thread, workspace destroyed
      - [x] `spec_feedback`: transitions `review → speccing`, increments `attempt`, calls `revise` then `update`, transitions back to `review`
      - [x] `spec_feedback`: silently discarded if `idea_id` not found in registry
      - [x] `spec_feedback`: silently discarded if run is in `speccing` stage
      - [x] `spec_feedback`: silently discarded if run is in `failed` stage
      - [x] `spec_feedback`: SpecGenerator failure → `failed`, error posted to thread
      - [x] `spec_feedback`: CanvasPublisher failure → `failed`, error posted to thread
      - [x] `stop()` resolves only after any in-flight pipeline step completes
      - [x] All relative imports use `.js` extensions
    - **Dependencies**: "Task: Implement `WorkspaceManager`", "Task: Implement `SpecGenerator`", "Task: Implement `CanvasPublisher`", "Task: Define `RunStage` and `Run` types"

  - [x] **Task: Unit tests for Orchestrator — `new_idea` path**
    - **Description**: Create `tests/core/orchestrator.test.ts`. Mock all four dependencies with `vi.fn()`. Test the happy path and all failure paths for `new_idea`. Verify stage transitions in the run registry, component call arguments, and error message posting.
    - **Acceptance criteria**:
      - [x] Happy path: all four components called in order with correct arguments
      - [x] Happy path: run in `review` stage with `workspace_path`, `branch`, `spec_path`, `canvas_id` all populated
      - [x] WorkspaceManager failure: run transitions to `failed`, error posted to thread, no further components called
      - [x] SpecGenerator failure: run transitions to `failed`, error posted to thread, workspace destroyed
      - [x] CanvasPublisher failure: run transitions to `failed`, error posted to thread, workspace destroyed
      - [x] All tests pass: `npm test`
    - **Dependencies**: "Task: Implement `Orchestrator`"

  - [x] **Task: Unit tests for Orchestrator — `spec_feedback` path, guards, and concurrency**
    - **Description**: Extend `tests/core/orchestrator.test.ts`. Test the spec_feedback happy path, all three guard conditions, both failure paths, and two concurrent idea scenarios.
    - **Acceptance criteria**:
      - [x] Happy path: `attempt` incremented, `revise` and `update` called with correct arguments, run back in `review`
      - [x] Unknown `idea_id`: no components called, no error posted
      - [x] Run in `speccing` stage: discarded, no components called
      - [x] Run in `failed` stage: discarded, no components called
      - [x] SpecGenerator.revise failure: run transitions to `failed`, error posted to thread
      - [x] CanvasPublisher.update failure: run transitions to `failed`, error posted to thread
      - [x] Two concurrent ideas produce independent runs with no cross-contamination
      - [x] All tests pass: `npm test`
    - **Dependencies**: "Task: Unit tests for Orchestrator — `new_idea` path"

- [x] **Story: Service and entry point wiring**
  - [x] **Task: Update `Service` to accept and lifecycle the `Orchestrator`**
    - **Description**: Modify `src/core/service.ts` to extend `ServiceOptions` with `orchestrator?: Orchestrator`. `start()` calls `await orchestrator.start()` if provided. `stop()` calls `await orchestrator.stop()` during shutdown. No behavioral change when no orchestrator is provided.
    - **Acceptance criteria**:
      - [x] `ServiceOptions` has `orchestrator?: Orchestrator`
      - [x] `Service.start()` calls `orchestrator.start()` before the polling interval begins
      - [x] `Service.stop()` calls `orchestrator.stop()` during shutdown
      - [x] Service without an orchestrator behaves identically to before
      - [x] All existing `Service` tests still pass: `npm test`
    - **Dependencies**: "Task: Implement `Orchestrator`"

  - [x] **Task: Wire `SlackAdapter` and `Orchestrator` in `src/index.ts`**
    - **Description**: Modify `src/index.ts` to add four steps after config load: (1) run `git remote get-url origin` in `repoPath` via `child_process.execSync` — exit with code 1 and a descriptive error message if it fails; (2) validate `config.workspace.root` is non-empty — exit with code 1 if not; (3) create `SlackAdapter` from `config.slack`; (4) create `Orchestrator` with the adapter, `repo_url`, and `config.workspace.root`, then pass it to `Service` via `ServiceOptions`.
    - **Acceptance criteria**:
      - [x] `git remote get-url origin` is run in `repoPath` immediately after config is loaded
      - [x] Process exits with code 1 and a clear error message if no `origin` remote is configured
      - [x] Process exits with code 1 and a clear error message if `config.workspace.root` is empty or undefined
      - [x] `SlackAdapter` is created from `config.slack`
      - [x] `Orchestrator` is created with the adapter, resolved `repo_url`, and `config.workspace.root`
      - [x] `Orchestrator` is passed to `Service` via `ServiceOptions`
    - **Dependencies**: "Task: Update `Service` to accept and lifecycle the `Orchestrator`"

  - [x] **Task: Tests for Service wiring and entry point changes**
    - **Description**: Add tests to `tests/core/service.test.ts` for orchestrator delegation. For the `src/index.ts` changes, extract the startup wiring into a testable helper function and test it separately with mocked git and config inputs, verifying exit behavior on failure conditions.
    - **Acceptance criteria**:
      - [x] `Service` with a mock orchestrator: `start()` calls `orchestrator.start()`
      - [x] `Service` with a mock orchestrator: `stop()` calls `orchestrator.stop()`
      - [x] `Service` without an orchestrator: all prior tests pass unchanged
      - [x] Entry point helper: missing git `origin` remote causes exit with code 1 and descriptive message
      - [x] Entry point helper: missing `config.workspace.root` causes exit with code 1 and descriptive message
      - [x] All tests pass: `npm test`
    - **Dependencies**: "Task: Wire `SlackAdapter` and `Orchestrator` in `src/index.ts`"
