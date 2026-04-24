---
created: 2026-04-23
last_updated: 2026-04-24
status: complete
issue: 33
specced_by: markdstafford
implemented_by: markdstafford
superseded_by: null
---
# Feature: Multi-repo message routing

## What

This feature extends Slack message routing to support multiple repositories simultaneously. Where the service today binds to a single Slack channel and routes all messages to one repository — derived from the `--repo` flag at startup — this feature extends the `--repo` flag to accept multiple space-separated paths, so that each repository supplies its own channel binding and settings via its own [WORKFLOW.md](http://WORKFLOW.md). Existing single-repo deployments continue to work without modification.
## Why

Teams with multiple active repositories today must run one Autocatalyst instance per repo — separate processes, separate [WORKFLOW.md](http://WORKFLOW.md) files, and separate bots. The complexity grows linearly with the number of projects. Multi-repo routing collapses that overhead to a single process and a single bot, while each repository retains full ownership of its own [WORKFLOW.md](http://WORKFLOW.md).
## User stories

- Enzo can seed an idea in `#autocatalyst-amp` and receive a spec scoped to the AMP repository without specifying the repo in the message
- Enzo can seed a separate idea in `#autocatalyst-search` in the same Slack workspace simultaneously, and Autocatalyst processes it against the Search repository independently within the same running instance
- Phoebe can start Autocatalyst with `--repo /path/to/amp /path/to/search`, and the service reads each repository's own [WORKFLOW.md](http://WORKFLOW.md) for its channel name and settings — no shared configuration file required
- Enzo can use run-scoped commands (`:ac-run-status:`, `:ac-run-cancel:`) in any configured channel and have them apply to that channel's runs only
- Enzo can see a startup log entry listing each configured channel and its mapped repository, confirming the service is listening to the right channels before any messages arrive
- Phoebe can send a message in a channel that is not mapped to any repository and have the service ignore it silently, with no error posted to that channel
## Design changes

*(Added by design specs stage — frame as delta on the parent feature's design spec)*
## Technical changes

### Affected files

*(Populated during tech specs stage — list files that will change and why)*
- `src/types/config.ts` — add internal `RepoEntry` type for `ChannelRepoMap`; no changes to `WorkflowConfig` schema
- `src/core/config.ts` — add `loadConfigFromPath(repoPath)` to load and validate [WORKFLOW.md](http://WORKFLOW.md) from an arbitrary directory; delegate existing `loadConfig()` to it with `process.cwd()`
- `src/adapters/slack/slack-adapter.ts` — resolve channel IDs for all repos at startup; attach message and reaction handlers scoped to each configured channel; log startup channel list
- `src/core/orchestrator.ts` — replace the single `repo_url` constructor parameter with a `ChannelRepoMap`; resolve per-channel `repo_url` and `workspace_root` from each event's `channel_id`; discard events from unmapped channels with a warn log
- `src/core/workspace-manager.ts` — add explicit `workspace_root` parameter to `create()`; remove reliance on service-level config for workspace root path
- `src/index.ts` — parse `--repo` to accept multiple space-separated paths; load each repo's [WORKFLOW.md](http://WORKFLOW.md) via `loadConfigFromPath()`; resolve `repo_url` via `git remote get-url origin` per repo; build `ChannelRepoMap`; log startup mode and channel count
### Changes

*(Added by tech specs stage — frame as delta on the parent feature's tech spec)*
**CLI interface**
The `--repo` flag is extended to accept multiple space-separated paths. When more than one path is provided, the service starts in multi-repo mode:
```bash
# Existing single-repo form (unchanged)

autocatalyst start

# New multi-repo form

autocatalyst start --repo /path/to/amp /path/to/search
```
Each path must point to a local repository containing a valid [WORKFLOW.md](http://WORKFLOW.md) with a `slack.channel_name` field. No new [WORKFLOW.md](http://WORKFLOW.md) fields are required.
**Internal ****`RepoEntry`**** type**
```typescript
// src/types/config.ts — internal only; not reflected in WorkflowConfig
export interface RepoEntry {
  channel_id: string;      // resolved from WorkflowConfig.slack.channel_name at startup
  repo_url: string;        // from git remote get-url origin in the repo directory
  workspace_root: string;  // from WorkflowConfig or default (~/.autocatalyst/workspaces/)
}
```
`WorkflowConfig` schema is unchanged. No `repos` array is added.
**Startup logic in ****`src/index.ts`**
```javascript
If --repo is given multiple paths:
  → For each repo path:
    - Load /WORKFLOW.md via loadConfigFromPath()
    - Run git remote get-url origin from  to obtain repo_url
    - Extract channel_name and workspace_root from config
  → Pass all entries to SlackAdapter for channel ID resolution
  → Build ChannelRepoMap (channel_id resolved by SlackAdapter)
  → Log { event: "service.starting", mode: "multi-repo", channel_count: N }
Else (legacy single-repo):
  → Existing startup sequence unchanged
  → Log { event: "service.starting", mode: "single-repo" }
```
**`loadConfigFromPath()`**** in ****`src/core/config.ts`**
```typescript
export function loadConfigFromPath(repoPath: string): WorkflowConfig
```
Reads and validates [WORKFLOW.md](http://WORKFLOW.md) from the given directory. Existing `loadConfig()` delegates to this function with `process.cwd()`, preserving full backward compatibility.
**`SlackAdapter`**** startup changes**
`start()` iterates repo entries, calling `conversations.list` to resolve each channel name to its ID. Resolved mappings are stored as `Map`. If any channel name cannot be resolved, the adapter logs `slack.startup.channel_resolution_failed` at error level and throws — failing fast prevents the service from starting in a silently misconfigured state (e.g., a typo in `slack.channel_name` that would cause all messages in that repo's channel to be silently ignored). After resolving, the adapter registers `message` and `reaction_added` handlers scoped to configured channel IDs. Events from channels not in the map are dropped before the classifier is called and logged at debug level as `slack.event.channel_filtered`.
> **Why filtering unmapped channels is necessary**: A Slack bot receives events from every channel it is a member of in the workspace — not only the channels it was configured to handle. Without explicit filtering, messages from any channel the bot happens to be in would reach the classifier and be processed against an unknown repository. The adapter is the primary filter; the orchestrator adds a secondary check as defense in depth (see below).
**Orchestrator changes**
Constructor signature changes from accepting `repo_url: string` and `workspace_root: string` to accepting a `ChannelRepoMap`:
```typescript
type ChannelRepoMap = Map;
```
On every `new_idea` or `spec_feedback` event, the orchestrator looks up `event.payload.channel_id` in the map. If no entry is found, it logs `run.channel_unmapped` at warn level and discards the event without creating a run. This secondary check exists as defense in depth: the `SlackAdapter` is the primary filter and should prevent unmapped channel events from reaching the orchestrator, but the orchestrator handles them gracefully in case the adapter is bypassed (e.g., in tests or future transport integrations that don't go through `SlackAdapter`). The single-repo startup path constructs a `ChannelRepoMap` with one entry, so the `Orchestrator` interface is uniform across both modes.
**`WorkspaceManager.create()`**** signature change**
```typescript
// Before
create(idea_id: string, repo_url: string): Promise

// After
create(idea_id: string, repo_url: string, workspace_root: string): Promise
```
`workspace_root` is supplied by the orchestrator from the per-channel `RepoEntry`. Path construction (`/`) is unchanged.
**New log ****events**

Event
Level
Fields

`service.starting`
info
\`mode ("single-repo"\\

`slack.startup.channels_resolved`
info
`channels: [{ channel_name, channel_id, repo_url }]`

`slack.startup.channel_resolution_failed`
error
`channel_name, error`

`slack.event.channel_filtered`
debug
`channel_id, event_type`

`run.channel_unmapped`
warn
`channel_id`

## Test plan

### Automated

Layer
File
What is verified

Unit
`tests/core/config.test.ts`
`loadConfigFromPath()`: valid path returns parsed config; missing file throws with path in message; invalid schema throws with validation details; `loadConfig()` backward compatibility unchanged

Unit
`tests/core/workspace-manager.test.ts`
`create(idea_id, repo_url, workspace_root)` routes to provided root; two distinct `workspace_root` values produce non-overlapping paths

Unit
`tests/core/orchestrator.test.ts`
Mapped channel idea → correct `repo_url` and `workspace_root` passed to pipeline; unmapped channel → `run.channel_unmapped` at warn, no pipeline calls; single-entry `ChannelRepoMap` matches existing single-repo behavior

Integration
`tests/adapters/slack/slack-adapter.test.ts`
Two channels resolved at startup with `slack.startup.channels_resolved` logged; unresolvable channel emits `slack.startup.channel_resolution_failed` and throws; event from unconfigured channel logs `slack.event.channel_filtered` at debug and emits nothing; ideas from each configured channel dispatched with correct `channel_id`

Integration
`tests/index.test.ts`
`--repo /a /b` startup: `loadConfigFromPath()` and `git remote` called once per path; `service.starting` logged with `mode: "multi-repo"`; missing [WORKFLOW.md](http://WORKFLOW.md) at a path exits code 1 with path in message; single-repo startup logs `mode: "single-repo"` unchanged

### Manual smoke test

1. Start with `--repo /path/to/repo-a /path/to/repo-b` and confirm the startup log lists both channels with their mapped repos.
2. Post a message in repo-a's channel; verify a spec is created in repo-a's workspace only.
3. Post a message in repo-b's channel; verify it routes to repo-b's workspace with no interference with repo-a.
4. Post a message in an unconfigured channel; verify nothing is posted back and no run is created.
5. Start with a single repo (no `--repo`); verify behavior is identical to the pre-feature baseline.
## Task list

*(Added by task decomposition stage)*
- [x] **Story: CLI — multi-repo startup via ****`--repo`**** flag**
	- [x] **Task: Extend ****`--repo`**** to accept multiple space-separated paths**
		- **Description**: Update argument parsing in `src/index.ts` to allow `--repo` to accept multiple space-separated paths. When multiple paths are provided, collect them as an array. Single `--repo /path` or no flag preserves existing behavior.
		- **Acceptance criteria**:
			- [x] `--repo /a /b` parsed as `["/a", "/b"]`
			- [x] Single `--repo /a` or no flag → existing parse result unchanged
			- [x] `tsc --noEmit` passes
		- **Dependencies**: None
	- [x] **Task: Add ****`loadConfigFromPath()`**** to ****`src/core/config.ts`**
		- **Description**: Add `loadConfigFromPath(repoPath: string): WorkflowConfig` that reads and validates [WORKFLOW.md](http://WORKFLOW.md) from the given directory path. Update the existing `loadConfig()` to delegate to this with `process.cwd()`. Update `src/index.ts` multi-repo startup to call `loadConfigFromPath()` for each path in `--repo`.
		- **Acceptance criteria**:
			- [x] Valid [WORKFLOW.md](http://WORKFLOW.md) at given path → returns parsed `WorkflowConfig`
			- [x] Missing or invalid [WORKFLOW.md](http://WORKFLOW.md) → descriptive error including the path
			- [x] Existing `loadConfig()` behavior unchanged
			- [x] All config tests pass: `npm test`
		- **Dependencies**: Task: Extend `--repo` to accept multiple space-separated paths
	- [x] **Task: Resolve repo URLs and build ****`ChannelRepoMap`**** at startup**
		- **Description**: For each repo path in multi-repo mode, run `git remote get-url origin` from that directory to get `repo_url`. Combine with `channel_name` and `workspace_root` from the repo's [WORKFLOW.md](http://WORKFLOW.md). Pass the full entry list to `SlackAdapter` for channel ID resolution. Log `service.starting` with mode and channel count.
		- **Acceptance criteria**:
			- [x] Each repo's `repo_url` resolved via `git remote` in its directory
			- [x] `workspace_root` defaults to `~/.autocatalyst/workspaces/` when absent from [WORKFLOW.md](http://WORKFLOW.md)
			- [x] `service.starting` logged with `mode: "multi-repo"` and correct `channel_count`
			- [x] Single-repo startup logs `mode: "single-repo"` unchanged
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Add `loadConfigFromPath()`
	- [x] **Task: Tests for conditional startup modes**
		- **Description**: Extend entry point startup helper tests: multi-repo mode reads each repo's [WORKFLOW.md](http://WORKFLOW.md) and runs `git remote` per repo; single-repo mode unchanged; missing [WORKFLOW.md](http://WORKFLOW.md) at a `--repo` path exits with code 1 and descriptive message.
		- **Acceptance criteria**:
			- [x] Multi-repo mode: `loadConfigFromPath()` called once per repo path
			- [x] Multi-repo mode: `git remote get-url origin` called once per repo directory
			- [x] Multi-repo mode: `service.starting` logged with `mode: "multi-repo"`
			- [x] Single-repo mode: all existing startup tests pass unchanged
			- [x] Missing [WORKFLOW.md](http://WORKFLOW.md): exits code 1 with path in error message
			- [x] `npm test` passes
		- **Dependencies**: Task: Resolve repo URLs and build ChannelRepoMap
- [x] **Story: Config — internal ****`RepoEntry`**** type**
	- [x] **Task: Add ****`RepoEntry`**** internal type**
		- **Description**: Add `RepoEntry` interface to `src/types/config.ts` for internal `ChannelRepoMap` use. No changes to `WorkflowConfig`.
		- **Acceptance criteria**:
			- [x] `RepoEntry` has `channel_id: string`, `repo_url: string`, `workspace_root: string`
			- [x] `WorkflowConfig` schema unchanged
			- [x] `tsc --noEmit` passes
		- **Dependencies**: None
	- [x] **Task: Unit tests for ****`loadConfigFromPath()`**
		- **Description**: Extend `tests/core/config.test.ts`: valid path → parsed config; missing file → error with path; invalid [WORKFLOW.md](http://WORKFLOW.md) → validation error; existing `loadConfig()` tests unchanged.
		- **Acceptance criteria**:
			- [x] All cases pass
			- [x] No existing config tests broken
			- [x] `npm test` passes
		- **Dependencies**: Task: Add `loadConfigFromPath()`
- [x] **Story: SlackAdapter — multi-channel startup**
	- [x] **Task: Resolve multiple channel IDs at startup**
		- **Description**: Update `SlackAdapter.start()` to accept repo entries in multi-repo mode. Resolve each channel name to its ID via `conversations.list`. Store as `Map`. Log `slack.startup.channels_resolved`. If any channel cannot be resolved, log `slack.startup.channel_resolution_failed` at error and fail startup. Preserve the existing single-channel path in single-repo mode.
		- **Acceptance criteria**:
			- [x] All channel names resolved before any event handler is registered
			- [x] `slack.startup.channels_resolved` logged with `channels` array
			- [x] One unresolvable channel → `slack.startup.channel_resolution_failed` logged at error; startup fails with descriptive error
			- [x] Single-repo mode → existing `channel_name` resolution unchanged
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Resolve repo URLs and build ChannelRepoMap
	- [x] **Task: Scope event handlers to configured channels**
		- **Description**: Update `SlackAdapter` message and reaction handlers to drop events from channel IDs not in the resolved `ChannelRepoMap`. This check happens before the classifier is called. Dropped events are logged at debug level as `slack.event.channel_filtered`.
		- **Acceptance criteria**:
			- [x] Message in unconfigured channel → `slack.event.channel_filtered` logged at debug; no classifier call, no event emitted
			- [x] Reaction in unconfigured channel → no event emitted
			- [x] Message in configured channel → existing classify+emit behavior unchanged
			- [x] All existing `SlackAdapter` integration tests pass: `npm test`
		- **Dependencies**: Task: Resolve multiple channel IDs at startup
	- [x] **Task: Integration tests for multi-channel adapter**
		- **Description**: Extend `tests/adapters/slack/slack-adapter.test.ts` with multi-channel scenarios: two channels resolved at startup, ideas from each channel dispatched with correct `channel_id`, event from unconfigured channel logged as `slack.event.channel_filtered` and silently dropped, one unresolvable channel logs `slack.startup.channel_resolution_failed` and causes startup failure.
		- **Acceptance criteria**:
			- [x] Two configured channels: each `new_idea` emits with the correct `channel_id`
			- [x] Event from unconfigured channel: `slack.event.channel_filtered` logged at debug; no event emitted
			- [x] Unknown channel at startup: `slack.startup.channel_resolution_failed` logged at error; startup throws
			- [x] All tests pass: `npm test`
		- **Dependencies**: Task: Scope event handlers
- [x] **Story: WorkspaceManager — explicit workspace root**
	- [x] **Task: Add ****`workspace_root`**** parameter to ****`WorkspaceManager.create()`**
		- **Description**: Update `WorkspaceManager` interface and implementation to accept `workspace_root` as a third parameter to `create()`. Remove reliance on service-level config. Update `Orchestrator` and `src/index.ts` callers to pass the correct `workspace_root` from `ChannelRepoMap`.
		- **Acceptance criteria**:
			- [x] `create(idea_id, repo_url, workspace_root)` compiles and routes workspace creation to the provided root
			- [x] Orchestrator passes per-channel `workspace_root` from `ChannelRepoMap`
			- [x] `src/index.ts` single-repo path passes `workspace_root` from config (unchanged behavior)
			- [x] All existing workspace manager tests pass: `npm test`
		- **Dependencies**: None
	- [x] **Task: Unit tests for updated ****`WorkspaceManager`**
		- **Description**: Update `tests/core/workspace-manager.test.ts` to pass `workspace_root` explicitly. Add a case verifying two calls with different roots produce non-overlapping paths.
		- **Acceptance criteria**:
			- [x] All existing tests updated and passing
			- [x] Two distinct `workspace_root` values → non-overlapping `workspace_path`s
			- [x] `npm test` passes
		- **Dependencies**: Task: Add `workspace_root` parameter
- [x] **Story: Orchestrator — per-channel repo resolution**
	- [x] **Task: Replace single ****`repo_url`**** with ****`ChannelRepoMap`**
		- **Description**: Update `OrchestratorImpl` constructor to accept `ChannelRepoMap` instead of `repo_url: string`. On `new_idea` and `spec_feedback`: look up `channel_id`; if not found, log `run.channel_unmapped` at warn and discard; if found, pass `repo_url` and `workspace_root` to the pipeline.
		- **Acceptance criteria**:
			- [x] `new_idea` with mapped `channel_id` → `WorkspaceManager.create()` called with correct `repo_url` and `workspace_root`
			- [x] `new_idea` with unmapped `channel_id` → `run.channel_unmapped` logged at warn, no run created
			- [x] `spec_feedback` with unmapped `channel_id` → silently discarded
			- [x] All existing orchestrator tests updated and passing: `npm test`
		- **Dependencies**: Task: Add `workspace_root` parameter
	- [x] **Task: Unit tests for multi-repo orchestrator dispatch**
		- **Description**: Extend `tests/core/orchestrator.test.ts` with multi-repo cases: ideas from two different channels routed to different `repo_url`s, event from unmapped channel discarded, single-entry `ChannelRepoMap` matches existing behavior.
		- **Acceptance criteria**:
			- [x] Channel A idea → channel A's `repo_url` and `workspace_root` passed to pipeline
			- [x] Channel B idea → channel B's values; no interference with A
			- [x] Unmapped channel → `run.channel_unmapped` warn log; no WorkspaceManager, SpecGenerator, or CanvasPublisher calls
			- [x] All tests pass: `npm test`
		- **Dependencies**: Task: Replace single `repo_url`