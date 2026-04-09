---
created: 2026-04-08
last_updated: 2026-04-08
status: stub
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
      - [ ] `RunStage` is `'intake' | 'speccing' | 'review' | 'approved' | 'failed'`
      - [ ] `Run` interface has all fields: `id`, `idea_id`, `stage`, `workspace_path`, `branch`, `spec_path`, `canvas_id`, `attempt`, `created_at`, `updated_at`
      - [ ] `spec_path` and `canvas_id` are `string | undefined`
      - [ ] File compiles without errors under `NodeNext` module resolution
    - **Dependencies**: None

- [x] **Story: WorkspaceManager**
  - [x] **Task: Implement `WorkspaceManager`**
    - **Description**: Create `src/core/workspace-manager.ts` with the `WorkspaceManager` interface and a concrete implementation. `create` runs `git clone --depth=1 <repo_url> <workspace_path>` then `git -C <workspace_path> checkout -b spec/<slug>` as child processes with `util.promisify(exec)`. The slug is derived from the first five words of `idea_id`, lowercased and hyphenated. If clone fails, remove the directory before throwing. `destroy` removes the directory recursively.
    - **Acceptance criteria**:
      - [ ] `WorkspaceManager` interface exported: `create(idea_id, repo_url)` and `destroy(workspace_path)`
      - [ ] `create` constructs `workspace_path` as `<config.workspace.root>/<idea_id>`
      - [ ] `create` runs `git clone --depth=1 <repo_url> <workspace_path>` as a subprocess
      - [ ] `create` runs `git -C <workspace_path> checkout -b spec/<slug>` after a successful clone
      - [ ] `create` removes the cloned directory and re-throws if the clone command exits non-zero
      - [ ] `create` throws if the checkout command exits non-zero
      - [ ] `create` returns `{ workspace_path, branch }`
      - [ ] `destroy` removes the directory recursively (equivalent to `rm -rf`)
      - [ ] All relative imports use `.js` extensions
    - **Dependencies**: None

  - [x] **Task: Unit tests for `WorkspaceManager`**
    - **Description**: Create `tests/core/workspace-manager.test.ts`. Mock `child_process.exec` (via the promisified wrapper) with `vi.fn()`. Use a real temp directory for path construction assertions. Cover all cases from the testing plan's WorkspaceManager section.
    - **Acceptance criteria**:
      - [ ] `create` issues the correct `git clone` command with `--depth=1` and the right path
      - [ ] `create` issues the correct `git checkout -b` command after a successful clone
      - [ ] `create` returns `{ workspace_path, branch }` with correct values
      - [ ] `create` throws and removes the cloned directory if clone exits non-zero
      - [ ] `create` throws if checkout exits non-zero
      - [ ] `destroy` removes the workspace directory
      - [ ] Two calls with different `idea_id`s produce non-overlapping paths
      - [ ] All tests pass: `npm test`
    - **Dependencies**: "Task: Implement `WorkspaceManager`"

- [ ] **Story: SpecGenerator**
  - [ ] **Task: Implement `SpecGenerator`**
    - **Description**: Create `src/adapters/agent/spec-generator.ts` with the `SpecGenerator` interface and a concrete `OMCSpecGenerator` implementation. `create` spawns `omc ask claude --print "<prompt>"` with `cwd` set to `workspace_path`, reads the artifact at the path printed to stdout, extracts the `## Raw output` section, parses the `FILENAME:` line, validates it against `^(feature|enhancement)-[a-z0-9-]+\.md$`, writes the spec body to `<workspace_path>/context-human/specs/<filename>`, and returns the path. `revise` builds a prompt with the feedback content in `<<<`/`>>>` delimiters first, then the current spec content in `<<<`/`>>>` delimiters, invokes OMC identically, and overwrites the spec file in place with the revised content.
    - **Acceptance criteria**:
      - [ ] `SpecGenerator` interface exported: `create(idea, workspace_path)` and `revise(feedback, spec_path, workspace_path)`
      - [ ] `create` spawns OMC with `cwd: workspace_path` and the generation prompt from Section 3
      - [ ] Generation prompt wraps `idea.content` in `<<<`/`>>>` and includes the `FILENAME:` instruction on the first line
      - [ ] `create` reads the artifact file from the path printed to stdout
      - [ ] `create` parses `FILENAME:` from within the `## Raw output` section
      - [ ] `create` validates the filename against `^(feature|enhancement)-[a-z0-9-]+\.md$`; throws with a descriptive error if invalid or missing
      - [ ] `create` writes the spec body (everything after the `FILENAME:` line) to `<workspace_path>/context-human/specs/<filename>`
      - [ ] `create` returns the full spec path
      - [ ] `create` throws if OMC exits non-zero
      - [ ] `revise` prompt leads with feedback in `<<<`/`>>>`, follows with current spec content in `<<<`/`>>>`
      - [ ] `revise` reads the current spec from `spec_path` before invoking OMC
      - [ ] `revise` overwrites `spec_path` with the revised content from the artifact
      - [ ] `revise` throws if OMC exits non-zero
      - [ ] All relative imports use `.js` extensions
    - **Dependencies**: None

  - [ ] **Task: Unit tests for `SpecGenerator`**
    - **Description**: Create `tests/adapters/agent/spec-generator.test.ts`. Mock the OMC subprocess with `vi.fn()` by intercepting the spawn/exec call. Use real temp directories for file I/O. Write fixture artifact files with varying `FILENAME:` values to test parsing. Cover all cases from the testing plan's SpecGenerator section.
    - **Acceptance criteria**:
      - [ ] `create` spawns OMC with the correct `cwd` and prompt content
      - [ ] `create` correctly parses `FILENAME: feature-setup-wizard.md`
      - [ ] `create` correctly parses `FILENAME: enhancement-some-thing.md`
      - [ ] `create` throws with a descriptive error on `FILENAME: invalid_name.md` (underscore)
      - [ ] `create` throws on `FILENAME: setup-wizard.md` (missing `feature-`/`enhancement-` prefix)
      - [ ] `create` throws when the `FILENAME:` line is absent
      - [ ] `create` writes the correct spec body to the correct path and returns it
      - [ ] `create` throws if OMC exits non-zero
      - [ ] `revise` prompt leads with feedback in `<<<`/`>>>`, follows with spec content in `<<<`/`>>>`
      - [ ] `revise` reads the current spec from `spec_path` before invoking OMC
      - [ ] `revise` overwrites the spec file in place with revised content
      - [ ] `revise` throws if OMC exits non-zero
      - [ ] All tests pass: `npm test`
    - **Dependencies**: "Task: Implement `SpecGenerator`"

- [ ] **Story: CanvasPublisher**
  - [ ] **Task: Implement `CanvasPublisher`**
    - **Description**: Create `src/adapters/slack/canvas-publisher.ts` with the `CanvasPublisher` interface and a concrete `SlackCanvasPublisher` implementation. The implementation takes the Bolt `App` instance in its constructor. `create` reads the spec file, calls `app.client.canvases.create` with the content, then calls `app.client.chat.postMessage` with the canvas link posted to the thread. `update` reads the spec file and calls `app.client.canvases.edit` with the updated content.
    - **Acceptance criteria**:
      - [ ] `CanvasPublisher` interface exported: `create(channel_id, thread_ts, spec_path)` and `update(canvas_id, spec_path)`
      - [ ] `create` reads spec content from `spec_path`
      - [ ] `create` calls `app.client.canvases.create` with the spec content as the canvas body
      - [ ] `create` calls `app.client.chat.postMessage` after `canvases.create` with `channel_id`, `thread_ts`, and a message containing the canvas link
      - [ ] `create` returns the `canvas_id` from the `canvases.create` response
      - [ ] `create` throws if `canvases.create` rejects; `postMessage` is not called
      - [ ] `update` reads spec content from `spec_path`
      - [ ] `update` calls `app.client.canvases.edit` with the correct `canvas_id` and updated content
      - [ ] `update` throws if `canvases.edit` rejects
      - [ ] All relative imports use `.js` extensions
    - **Dependencies**: None

  - [ ] **Task: Unit tests for `CanvasPublisher`**
    - **Description**: Create `tests/adapters/slack/canvas-publisher.test.ts`. Mock `app.client.canvases.create`, `app.client.canvases.edit`, and `app.client.chat.postMessage` with `vi.fn()`. Use real temp files for spec content. Cover all cases from the testing plan's CanvasPublisher section.
    - **Acceptance criteria**:
      - [ ] `create` calls `canvases.create` with the correct spec file content
      - [ ] `create` calls `postMessage` after `canvases.create` with `channel_id`, `thread_ts`, and a message containing the canvas link
      - [ ] `create` returns the `canvas_id` from the response
      - [ ] `create` does not call `postMessage` if `canvases.create` rejects
      - [ ] `update` calls `canvases.edit` with the correct `canvas_id` and updated content
      - [ ] `update` throws if `canvases.edit` rejects
      - [ ] All tests pass: `npm test`
    - **Dependencies**: "Task: Implement `CanvasPublisher`"

- [ ] **Story: Orchestrator**
  - [ ] **Task: Implement `Orchestrator`**
    - **Description**: Create `src/core/orchestrator.ts` with the `Orchestrator` interface (`start(): Promise<void>`, `stop(): Promise<void>`) and a concrete implementation. The constructor accepts `SlackAdapter`, `WorkspaceManager`, `SpecGenerator`, `CanvasPublisher`, and `repo_url`. `start()` begins consuming `SlackAdapter.receive()` in an async loop, dispatching `new_idea` and `spec_feedback` events to the pipeline. The in-memory run registry is a `Map<string, Run>` keyed by `idea_id`. `stop()` signals the loop to exit and resolves after any in-flight pipeline step completes. Stage transitions and error handling follow Section 3 exactly: on failure, transition to `failed` and post an error message to the Slack thread via `SlackAdapter`.
    - **Acceptance criteria**:
      - [ ] `Orchestrator` interface exported: `start()` and `stop()`
      - [ ] `new_idea`: creates `Run` in `intake`, transitions through `speccing`, calls all four components in order, transitions to `review`
      - [ ] `new_idea`: `workspace_path`, `branch`, `spec_path`, `canvas_id` stored on Run after each step
      - [ ] `new_idea`: WorkspaceManager failure → `failed`, error posted to thread, no further components called
      - [ ] `new_idea`: SpecGenerator failure → `failed`, error posted to thread, workspace destroyed
      - [ ] `new_idea`: CanvasPublisher failure → `failed`, error posted to thread, workspace destroyed
      - [ ] `spec_feedback`: transitions `review → speccing`, increments `attempt`, calls `revise` then `update`, transitions back to `review`
      - [ ] `spec_feedback`: silently discarded if `idea_id` not found in registry
      - [ ] `spec_feedback`: silently discarded if run is in `speccing` stage
      - [ ] `spec_feedback`: silently discarded if run is in `failed` stage
      - [ ] `spec_feedback`: SpecGenerator failure → `failed`, error posted to thread
      - [ ] `spec_feedback`: CanvasPublisher failure → `failed`, error posted to thread
      - [ ] `stop()` resolves only after any in-flight pipeline step completes
      - [ ] All relative imports use `.js` extensions
    - **Dependencies**: "Task: Implement `WorkspaceManager`", "Task: Implement `SpecGenerator`", "Task: Implement `CanvasPublisher`", "Task: Define `RunStage` and `Run` types"

  - [ ] **Task: Unit tests for Orchestrator — `new_idea` path**
    - **Description**: Create `tests/core/orchestrator.test.ts`. Mock all four dependencies with `vi.fn()`. Test the happy path and all failure paths for `new_idea`. Verify stage transitions in the run registry, component call arguments, and error message posting.
    - **Acceptance criteria**:
      - [ ] Happy path: all four components called in order with correct arguments
      - [ ] Happy path: run in `review` stage with `workspace_path`, `branch`, `spec_path`, `canvas_id` all populated
      - [ ] WorkspaceManager failure: run transitions to `failed`, error posted to thread, no further components called
      - [ ] SpecGenerator failure: run transitions to `failed`, error posted to thread, workspace destroyed
      - [ ] CanvasPublisher failure: run transitions to `failed`, error posted to thread, workspace destroyed
      - [ ] All tests pass: `npm test`
    - **Dependencies**: "Task: Implement `Orchestrator`"

  - [ ] **Task: Unit tests for Orchestrator — `spec_feedback` path, guards, and concurrency**
    - **Description**: Extend `tests/core/orchestrator.test.ts`. Test the spec_feedback happy path, all three guard conditions, both failure paths, and two concurrent idea scenarios.
    - **Acceptance criteria**:
      - [ ] Happy path: `attempt` incremented, `revise` and `update` called with correct arguments, run back in `review`
      - [ ] Unknown `idea_id`: no components called, no error posted
      - [ ] Run in `speccing` stage: discarded, no components called
      - [ ] Run in `failed` stage: discarded, no components called
      - [ ] SpecGenerator.revise failure: run transitions to `failed`, error posted to thread
      - [ ] CanvasPublisher.update failure: run transitions to `failed`, error posted to thread
      - [ ] Two concurrent ideas produce independent runs with no cross-contamination
      - [ ] All tests pass: `npm test`
    - **Dependencies**: "Task: Unit tests for Orchestrator — `new_idea` path"

- [ ] **Story: Service and entry point wiring**
  - [ ] **Task: Update `Service` to accept and lifecycle the `Orchestrator`**
    - **Description**: Modify `src/core/service.ts` to extend `ServiceOptions` with `orchestrator?: Orchestrator`. `start()` calls `await orchestrator.start()` if provided. `stop()` calls `await orchestrator.stop()` during shutdown. No behavioral change when no orchestrator is provided.
    - **Acceptance criteria**:
      - [ ] `ServiceOptions` has `orchestrator?: Orchestrator`
      - [ ] `Service.start()` calls `orchestrator.start()` before the polling interval begins
      - [ ] `Service.stop()` calls `orchestrator.stop()` during shutdown
      - [ ] Service without an orchestrator behaves identically to before
      - [ ] All existing `Service` tests still pass: `npm test`
    - **Dependencies**: "Task: Implement `Orchestrator`"

  - [ ] **Task: Wire `SlackAdapter` and `Orchestrator` in `src/index.ts`**
    - **Description**: Modify `src/index.ts` to add four steps after config load: (1) run `git remote get-url origin` in `repoPath` via `child_process.execSync` — exit with code 1 and a descriptive error message if it fails; (2) validate `config.workspace.root` is non-empty — exit with code 1 if not; (3) create `SlackAdapter` from `config.slack`; (4) create `Orchestrator` with the adapter, `repo_url`, and `config.workspace.root`, then pass it to `Service` via `ServiceOptions`.
    - **Acceptance criteria**:
      - [ ] `git remote get-url origin` is run in `repoPath` immediately after config is loaded
      - [ ] Process exits with code 1 and a clear error message if no `origin` remote is configured
      - [ ] Process exits with code 1 and a clear error message if `config.workspace.root` is empty or undefined
      - [ ] `SlackAdapter` is created from `config.slack`
      - [ ] `Orchestrator` is created with the adapter, resolved `repo_url`, and `config.workspace.root`
      - [ ] `Orchestrator` is passed to `Service` via `ServiceOptions`
    - **Dependencies**: "Task: Update `Service` to accept and lifecycle the `Orchestrator`"

  - [ ] **Task: Tests for Service wiring and entry point changes**
    - **Description**: Add tests to `tests/core/service.test.ts` for orchestrator delegation. For the `src/index.ts` changes, extract the startup wiring into a testable helper function and test it separately with mocked git and config inputs, verifying exit behavior on failure conditions.
    - **Acceptance criteria**:
      - [ ] `Service` with a mock orchestrator: `start()` calls `orchestrator.start()`
      - [ ] `Service` with a mock orchestrator: `stop()` calls `orchestrator.stop()`
      - [ ] `Service` without an orchestrator: all prior tests pass unchanged
      - [ ] Entry point helper: missing git `origin` remote causes exit with code 1 and descriptive message
      - [ ] Entry point helper: missing `config.workspace.root` causes exit with code 1 and descriptive message
      - [ ] All tests pass: `npm test`
    - **Dependencies**: "Task: Wire `SlackAdapter` and `Orchestrator` in `src/index.ts`"
