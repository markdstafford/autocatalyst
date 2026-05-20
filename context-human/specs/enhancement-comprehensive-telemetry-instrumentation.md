---
created: 2026-05-20
last_updated: 2026-05-20
status: implementing
issue: 165
specced_by: autocatalyst
implemented_by: markdstafford
superseded_by: null
---
# Enhancement: Comprehensive telemetry instrumentation

## Parent features

- `feature-victoriametrics-integration.md` — establishes OpenTelemetry export, VictoriaMetrics/VictoriaLogs, pino logging, and operator observability expectations.
- `enhancement-model-runner-telemetry.md` — adds first-pass runner metrics and direct model runner logging; this enhancement closes remaining parity gaps and extends telemetry to the rest of the run loop.
- `enhancement-existing-issue-work-routing.md` and `enhancement-concurrent-run-processing.md` — add routing and concurrency paths that make complete `run_id` / `request_id` correlation more important.
## What

Autocatalyst gains complete, consistent telemetry across agent runners, handler dispatch, review coordination, adapters, and supporting infrastructure. A single VictoriaLogs query by `run_id` or `request_id` should show the full timeline for a run: intake, classification, handler dispatch, agent runner activity, progress relay, result-file validation, implementation review, publication, and terminal outcome.
The first priority is parity between the Claude Agent SDK runner and the OpenAI Agent SDK runner. Claude runs must emit `agent.run_started`, debug-level `agent.sdk_item`, `agent.run_completed`, and `agent.run_failed` logs with the same core schema used by the OpenAI runner. They must also report outcome, latency, assistant turns, token usage, route metadata, model, and stderr diagnostics in the drain summary when the SDK reports success but the expected Autocatalyst result file is missing.
The second priority is making the rest of the control flow visible. Handler execution, `drainAgentRunner`, implementation review rounds, runner selection, Slack delivery, Notion API calls, config reloads, branch guard checks, workspace operations, sandbox environment resolution, and the Anthropic beta-header proxy should all emit structured events with timing and correlation fields where those fields are available. Because `AgentRunRequest` does not currently carry `run_id` or `request_id`, this work must introduce a small telemetry context and pass it through agent services, runner requests, handler wrappers, and external adapters before the top-level queryability goals can be met.
## Why

Issue #163 exposed a critical observability gap: an implementation agent could exit with `is_error: false`, fail to write the required result file, and leave operators with no clear evidence except manual workspace inspection. The progress thread was silent for minutes, non-relay model output was discarded, and the Claude SDK runner did not emit the lifecycle events that the OpenAI runner already emits.
This problem is broader than one runner. The handler registry is mostly a black box, several infrastructure components have no logger, and many metrics or logs do not carry enough correlation fields to reconstruct a run. That makes failures expensive to diagnose and prevents agents from querying telemetry without human help.
Autocatalyst is designed around agent-first operation. If a run fails, the next agent should be able to query logs and metrics, understand what happened, and propose a fix without asking a human to inspect the workspace. This enhancement turns telemetry from partial breadcrumbs into a complete diagnostic record.
## Personas

- **Enzo: Engineer/operator** — investigates failed runs and needs enough structured logs to diagnose failures without opening the workspace by hand.
- **Autocatalyst agent** — queries VictoriaLogs/VictoriaMetrics during triage and needs stable event names, correlation fields, and outcome fields to reconstruct a run automatically.
- **Phoebe: Product manager** — tracks whether the automation loop is reliable and needs failures to produce useful evidence rather than vague status messages.
## Narratives

### Enzo diagnoses a missing result file without opening the workspace

Enzo sees a Slack thread report that an implementation failed after several minutes. He copies the `run_id` from the failure message and queries VictoriaLogs. The log timeline starts with `run.created`, shows classification and handler entry, then shows `agent.run_started` for the Claude Agent SDK runner with the selected model and route task.
During the silent period, Enzo sees debug-level `agent.sdk_item` events showing assistant turns and safe tool-activity summaries. The final Claude SDK result says `outcome: success` and includes token usage. Immediately after that, `agent.result_file_missing` records the expected path, route task, phase, and `diagnostics.stderr_excerpt_redacted` from the `AgentDrainSummary` when buffered stderr is available. The implementation handler then logs `handler.completed` with `outcome: error`.
Enzo does not need to inspect the workspace. The telemetry shows that the SDK subprocess completed, Autocatalyst validated the result-file contract, the expected file was absent, and stderr contained the useful clue.
### An agent reconstructs a failed run from VictoriaLogs

A follow-up Autocatalyst agent is asked to fix a failure from a prior run. It queries `run_id:` and receives a chronological log trail with stable event names. It can see the route task, handler name, phase, selected runner, model, token usage, workspace path, branch guard checks, Slack delivery attempts, and terminal error.
Because every major component includes `run_id` or `request_id` when available, the agent does not need to combine manual notes from Slack with ad hoc workspace inspection. It can identify the failing component and write a focused patch.
### Phoebe checks whether failures are becoming diagnosable

Phoebe reviews weekly run health. Instead of only counting failed runs, she can ask whether failures have diagnostic coverage. Runs that fail after this enhancement include handler outcomes, agent outcomes, and result-file validation outcomes. The team can distinguish model/tool failures from orchestration bugs, missing credentials, Slack delivery failures, and Git branch guard blocks.
## User stories

**Run diagnosis**
- Enzo can query VictoriaLogs by `run_id` and see a complete run timeline from intake to terminal success or failure.
- Enzo can query by `request_id` when a `run_id` is not known yet and still find intake, workspace, and adapter events.
- Enzo can tell which handler ran, how long it took, and whether it completed, failed, skipped, or returned a user-input status.
- Enzo can diagnose the #163 missing-result-file scenario without opening the workspace.
**Agent runner parity**
- Enzo can inspect Claude Agent SDK runs with the same lifecycle event shape used by OpenAI Agent SDK runs.
- Enzo can see Claude SDK token usage from terminal `SDKResultMessage` data.
- Enzo can see Claude SDK item-level diagnostics at debug level, including message type, content block types, and tool call/output summaries.
- Enzo can see buffered Claude stderr when the SDK reports success but Autocatalyst result-file validation fails.
**Control-flow visibility**
- Enzo can see `drainAgentRunner` totals: drained event count, assistant turns, relay count, tool call count, tool result count, elapsed time, phase, component, outcome, and safe runner diagnostics when available.
- Enzo can see implementation review round timings and finding counts by severity.
- Enzo can see runner selection decisions when routing-aware runners choose Claude vs. OpenAI.
- Enzo can see Slack message/reaction delivery timings and failures with enough context to identify the thread and request.
- Enzo can see Notion page operations and API latencies by page ID.
- Enzo can see config reloads, branch guard checks, workspace create/destroy timings, proxy errors, and sandbox environment token resolution summaries.
**Correlation and queryability**
- An Autocatalyst agent can use stable `event`, `component`, `run_id`, `request_id`, `phase`, `route_task`, and `handler` fields to group logs without parsing prose.
- Operators can distinguish agent runner kind (`claude_agent_sdk`, `openai_agent_sdk`) in metrics and logs.
- Token usage is recorded for every supported agent run where the provider exposes usage data.
## Goals

- A VictoriaLogs query `run_id:` returns the complete timeline for a run after the run has a `run_id`; meeting this requires a propagated telemetry context rather than assuming runner requests already contain correlation IDs.
- A VictoriaLogs query `request_id:` returns intake, workspace, and adapter events for work that has not yet been linked to a known `run_id` in the operator's notes.
- Claude Agent SDK runs emit lifecycle and diagnostic logs at the same fidelity as OpenAI Agent SDK runs.
- Missing required result files are logged as explicit contract-validation failures before the service throws the final wrapper error, with `diagnostics.stderr_excerpt_redacted` included when buffered stderr is available.
- `drainAgentRunner` emits a structured summary for every drained run, even when no `[Relay]` messages appear.
- Handler dispatch emits standardized entry and completion events with duration and outcome.
- New telemetry follows the existing `context-agent/standards/logging.md` rule: structured JSON to stderr, stable keys, no secrets.
- Logging overhead remains low enough for normal operation: lifecycle and outcome events at `info`, detailed SDK/tool diagnostics at `debug`, and no full prompt/body logging by default.
## Non-goals

- Adding a new observability backend. VictoriaMetrics, VictoriaLogs, pino, and OpenTelemetry remain the chosen stack.
- Adding distributed tracing spans. This enhancement focuses on structured logs and existing metric instruments.
- Logging full prompts, full model responses, full tool inputs, full tool outputs, API tokens, credential values, authorization headers, custom API-key headers, or raw environment variables.
- Changing Slack, Notion, GitHub, or agent runner business behavior except where necessary to validate and log result-file contracts.
- Guaranteeing identical provider telemetry when the provider does not expose usage or item-level data. Unsupported values should be recorded as `null` or omitted with an explicit `usage_available: false` field.
- Building dashboards or alerting rules. Queryable telemetry is the scope; dashboards can follow later.
## Design changes

No dedicated UI changes are required. User-visible behavior changes only through better failure explanations and more reliable progress reporting.
- When an agent exits but the expected result file is missing, the user-facing failure should still be concise. The detailed diagnostics go to logs.
- Progress updates remain driven by `[Relay]` messages, but lack of relay messages no longer means lack of telemetry. Non-relay activity is logged at debug level for operators and agents.
- Slack delivery logs should include timing and target thread context, but they should not expose private message contents beyond existing safe event summaries.
## Technical changes

### Affected files

- `src/adapters/anthropic/claude-agent-sdk-agent-runner.ts` — add lifecycle log parity, SDK item diagnostics, outcome logging in `finally`, and success-with-stderr diagnostic support.
- `src/adapters/openai/agent-sdk-agent-runner.ts` — ensure schema stays canonical; add token usage fields if exposed by generated events or results; align route helper reuse with Claude.
- `src/core/ai/agent-services.ts` — add telemetry context propagation, `drainAgentRunner` counters and summaries; validate expected result files immediately after drain; log missing result files with route, phase, expected path, and runner diagnostics when available.
- `src/core/default-handler-registry.ts` — wrap registered handlers with standardized `handler.entered`, `handler.completed`, and `handler.failed` logging while preserving and returning handler results.
- `src/core/handlers/*` — add or align handler-specific outcome fields where wrapper logs cannot infer semantic status.
- `src/core/ai/implementation-review-coordinator.ts` — log each review round with round number, reviewer profile, finding counts by severity, duration, and outcome.
- `src/adapters/runtime-composition.ts` — pass `loggerProvider` and telemetry context into agent runners; log runner profile resolution and routing-aware dispatch decisions.
- `src/adapters/slack/slack-adapter.ts` — correct thread timestamp logging, add message/reaction delivery timing, delivery confirmation logs, and safe classification metadata.
- `src/adapters/notion/notion-publisher.ts` — measure Notion API latencies and include page/data source IDs for create, update, status update, markdown read, and filename lookup operations.
- `src/core/config-watcher.ts` — add logger injection and reload/watch lifecycle events.
- `src/core/git-branch-guard.ts` — add logger injection and allowed/blocked branch guard decision logs.
- `src/core/workspace-manager.ts` — add create/destroy timing and error logs while preserving cleanup behavior.
- `src/adapters/sandbox-environment.ts` — add safe token-resolution summary logging via caller-provided logger or a small result object consumed by runners.
- `src/adapters/anthropic/anthropic-beta-header-filter-proxy.ts` — add logger injection and proxy start/stop/request/error counters or logs.
- `src/types/ai.ts` — add a small telemetry context type and thread it into `AgentRunRequest` / normalized events without making provider-specific fields unsafe.
- `context-agent/standards/logging.md` and root `AGENTS.md` — document telemetry requirements for new control-flow changes.
- Tests under `tests/adapters/**` and `tests/core/**` — add focused assertions for new structured events, timings, correlation fields, and redaction behavior.
### Prerequisites and assumptions

- `context-agent/decisions/observability-stack.md` currently contains stale guidance about structured JSON to stdout and VictoriaTraces; this enhancement must update or supersede that decision so future agents follow stderr logging and the non-tracing scope of this spec.
- `context-agent/standards/logging.md` already defines stable structured logging fields and the no-secrets rule.
- `createLogger(component, { destination, loggerProvider })` already bridges pino logs to OpenTelemetry when a logger provider is supplied. Components constructed inside runtime composition should receive `loggerProvider` explicitly where constructors support it; components that only call `createLogger()` directly may rely on the process-global OpenTelemetry provider only if the logging standard documents that fallback.
- `ClaudeAgentSdkAgentRunner` already receives an injectable `meter`, optional `loggerProvider`, and terminal `SDKResultMessage` usage data. Current code records some metrics and stderr-on-error, but it does not yet emit lifecycle log parity.
- `OpenAIAgentSdkAgentRunner` is the canonical reference for `agent.run_started`, `agent.sdk_item`, and `agent.run_completed` shape.
- Result-file paths are known inside `AgentRunnerArtifactAuthoringAgent`, `AgentRunnerImplementationAgent`, `AgentRunnerQuestionAnsweringAgent`, and `AgentRunnerIssueTriageAgent`.
- `run_id` is not available in every low-level helper today. Add an `AgentTelemetryContext` / `TelemetryContext` carrying `run_id`, `request_id`, `phase`, `route_task`, `handler`, and safe route metadata; pass it through agent services, runner requests, handler wrappers, and external adapter calls so low-level helpers do not need to infer correlation from workspace paths. Where only partial context exists, log the available fields and merge in `run_id` at the caller boundary as soon as practical.
### Telemetry field conventions

New events should use these stable field names unless an existing standard field already applies:

Field
Meaning

`event`
Stable event name, e.g. `agent.run_started`

`component`
Logger component from `createLogger()`

`run_id`
Autocatalyst run ID, when available

`request_id`
Original request ID, when available

`phase`
Lifecycle phase such as `triage`, `speccing`, `implementation`, `reviewing`, `filing`, `question_answering`

`route_task`
Agent or model route task, e.g. `implementation.run`

`handler`
Handler class or logical handler name

`runner`
Runner kind: `claude_agent_sdk`, `openai_agent_sdk`, `anthropic_direct`, `openai_direct`

`model`
Resolved model name, or `unknown` if unavailable

`outcome`
`success`, `error`, `skipped`, `needs_input`, `missing_result_file`, or another documented finite value

`duration_ms` / `latency_ms`
Rounded elapsed time in milliseconds

`token_type`
`input`, `output`, `cache_read`, or `cache_write` where supported

`expected_path`
Expected Autocatalyst result-file path for contract validation

`diagnostics.stderr_excerpt_redacted`
Bounded, redacted stderr excerpt carried in drain/result diagnostics when available

Event names should remain specific but queryable. Prefer `agent.result_file_missing` over a generic `error` event. Do not include secrets, raw prompts, raw credentials, or full tool outputs.
### 1. Claude Agent SDK lifecycle parity

Add lifecycle logging to `ClaudeAgentSdkAgentRunner.run()`:
- Emit `agent.run_started` at `info` before invoking `queryFn`.
- Emit `agent.sdk_item` at `debug` for every `SDKMessage` before normalization.
- Emit `agent.run_completed` at `info` in a `finally` block with `outcome`, `latency_ms`, `model`, route fields, `assistant_turn_count`, `sdk_message_count`, and token usage if seen.
- Emit `agent.run_failed` at `error` when the async iterator throws.
- Preserve existing outcome and token metrics, but ensure they are recorded exactly once per terminal SDK result.
- If no terminal result message is seen, record `outcome: error` or `outcome: incomplete` and log `agent.result_missing` before rethrowing or completing, depending on actual SDK behavior.
Mirror the OpenAI runner schema where possible:
```typescript
this.logger.info({
  event: 'agent.run_started',
  model,
  ...routeLogAttributes(request.route),
  working_directory: request.working_directory,
}, 'Claude Agent SDK run started');
```
The Claude runner should include SDK-specific fields only in addition to common fields, not instead of them. For example, `sdk_message_type`, `sdk_subtype`, `content_block_types`, `tool_call_names`, and `is_error` are acceptable debug fields.
### 2. SDK item diagnostics and redaction

Add a `claudeSdkMessageDiagnostic(message)` helper near `normalizeSdkMessage()`.
The helper should return safe summaries:
- `sdk_message_type`
- `sdk_subtype` when present
- `content_block_types` for assistant/user content arrays
- `tool_call_count` and `tool_call_names` when tool-use blocks are present
- `tool_result_count` when tool-result blocks are present
- `is_error` for result messages
- `usage_available` for result messages
Do not log full text blocks, full tool input, full tool output, prompts, or raw message objects. The goal is to reconstruct activity shape, not content. If normalized `AgentRunEvent` objects are used by `drainAgentRunner` for tool counts, extend them with safe diagnostic fields such as `tool_call_count`, `tool_result_count`, and sanitized `tool_call_names`; do not require drain logic to recover details from provider raw messages that Claude already drops.
Keep stderr redaction using the existing `redactSecrets()` patterns and extend those patterns/tests to cover `github_pat_...`, `gho_...` / `ghs_...`, Slack `xapp-...` tokens, `Authorization: Bearer ...`, `ANTHROPIC_CUSTOM_HEADERS=api-key: ...`, generic API-key strings, and password-like values in stderr excerpts.
### 3. Result-file contract validation

Replace the current pattern where `readRequiredFile()` is the first place that detects a missing result file after runner drain. Each agent service should validate the expected result file immediately after `drainAgentRunner()` returns and before parsing.
Add a helper in `agent-services.ts`:
```typescript
async function validateRequiredResultFile(options: {
  readFileFn: ReadFileFn;
  path: string;
  label: string;
  logger: Pick;
  phase: string;
  route_task: string;
  request_id?: string;
  run_id?: string;
  drainSummary?: AgentDrainSummary;
}): Promise
```
Behavior:
- On success, log `agent.result_file_found` with `expected_path`, `phase`, `route_task`, and file byte length.
- On `ENOENT`, log `agent.result_file_missing` with `expected_path`, `phase`, `route_task`, available correlation fields, and `diagnostics.stderr_excerpt_redacted` from `drainSummary` when available; then throw the same clear error used today.
- On other read errors, log `agent.result_file_read_failed` and rethrow.
To surface Claude stderr from success exits, expose runner diagnostics through normalized terminal events and the drain summary. Add an optional `diagnostics` object to terminal `AgentRunEvent` result events; when the runner has buffered stderr, populate `diagnostics.stderr_excerpt_redacted` with a bounded `redactSecrets()` excerpt. `drainAgentRunner` must remember the latest diagnostics and return them in a summary object; `validateRequiredResultFile()` must include `diagnostics.stderr_excerpt_redacted` on `agent.result_file_missing` when available rather than relying on a separate debug log that may be filtered out.
### 4. `drainAgentRunner` telemetry

Change `drainAgentRunner()` to return a summary:
```typescript
export interface AgentDrainSummary {
  event_count: number;
  assistant_turn_count: number;
  relay_count: number;
  tool_call_count: number;
  tool_result_count: number;
  elapsed_ms: number;
  diagnostics?: {
    stderr_excerpt_redacted?: string;
  };
}
```
Tool counts should come from safe normalized diagnostic fields populated by provider runners. If a provider cannot expose safe tool metadata, record `tool_call_count` / `tool_result_count` as `0` or omit provider-specific names with `tool_metadata_available: false`; do not inspect raw tool payloads in drain logic.
Log `agent.drain_started` and `agent.drain_completed` around the loop. The completion event should include `phase`, counts, `duration_ms`, `outcome`, `tool_metadata_available` when relevant, and `diagnostics.stderr_excerpt_redacted` only when available and already redacted. If the iterator throws, log `agent.drain_failed` with partial counts and rethrow.
At debug level, log non-relay tool activity as `agent.tool_activity` with safe fields derived from normalized diagnostics (`phase`, sanitized `tool_name`, `has_input`, `has_output`, `event_index`). Do not log full tool inputs or outputs.
### 5. Standardized handler instrumentation

Add a wrapper helper inside `default-handler-registry.ts` so every registered handler emits consistent entry and completion logs without duplicating code in each handler class.
The wrapper should log:
- `handler.entered` at `info` with `handler`, `event_type`, `stage`, `intent`, `run_id`, `request_id`, and `phase` if derivable.
- `handler.completed` at `info` with the same fields plus `outcome` and `duration_ms`.
- `handler.failed` at `error` with `error`, same fields, and `duration_ms`, then rethrow.
A simple outcome inference is acceptable for the wrapper:
- If the handler resolves, default to `success`.
- Wrapped closures must return the underlying handler result instead of discarding it; if the returned object has `status`, use that status.
- If semantic outcome is not represented in a return value because the handler calls `transition()`, `failRun()`, or a nested helper, allow explicit handler metadata or the final run stage to override the wrapper default.
- If it throws, use `error`.
Handler-specific logs can still record semantic events such as `implementation.needs_input`; the wrapper provides the universal envelope.
### 6. Implementation review coordinator telemetry

`ImplementationReviewCoordinator` already logs started, completed, skipped, and failed events. Extend it with per-round events:
- `implementation.review.round_started`
- `implementation.review.round_completed`
- `implementation.review.round_failed`
Each event should include `run_id`, `request_id` where available, `phase`, `round`, `review_profile`, `implementation_profile`, `duration_ms`, and finding counts matching the current severity union: `blocker_count`, `warning_count`, and `info_count` when the result is available. If future review severities change, add an explicit severity-mapping rule in this section and tests.
### 7. Adapter and infrastructure instrumentation

Add focused instrumentation without changing business behavior:
- **Slack adapter**: log correct `thread_ts` for top-level and thread messages; include `message_ts` separately. Measure `chat.postMessage` and `reactions.add` latency. Log `slack.message.delivered`, `slack.reaction.sent`, and failure events with `channel_id`, `thread_ts`, `message_ts`, `request_id` when known, and `duration_ms`.
- **Notion publisher**: wrap Notion client calls with timing logs. Include `page_id`, `data_source_id`, filename, status, and operation. Avoid logging full Markdown content.
- **Runtime composition**: log `runner.selection` when building direct and agent runners, and `runner.dispatched` inside routing-aware runners with `profile`, `runner`, `route_task`, and `model`. It is responsible for creating and propagating telemetry context and `loggerProvider` into agent services/runners and adapters that support explicit injection.
- **Config watcher**: add optional logger injection. Log watch start/stop, reload scheduled, reload fired, [fs.watch](http://fs.watch) fallback, and watcher errors. Use the injected logger provider when constructed by runtime composition; otherwise document reliance on the global provider fallback.
- **Git branch guard**: add optional logger injection. Log `branch_guard.checked` with `outcome: allowed` or `blocked`, expected branch, actual branch, and workspace path. Prefer explicit logger/loggerProvider injection from the caller over implicit globals.
- **Workspace manager**: log clone start/completion/failure, checkout start/completion/failure, destroy start/completion/failure, and `duration_ms`. Prefer explicit logger/loggerProvider injection from runtime composition.
- **Sandbox environment**: log a safe summary of allowed token names and exported sandbox key names, never values. Prefer `token_count`, `sandbox_keys`, and `missing_tokens` fields; pass the summary to runners or log through a caller-provided logger so the same telemetry context is attached.
- **Anthropic beta-header filter proxy**: add optional logger injection. Log proxy start/stop, request count or per-request debug events, upstream status, stripped beta value count, and proxy errors.
### 8. Documentation and standards

Update `context-agent/standards/logging.md`, root `AGENTS.md`, and the stale observability decision with a short telemetry requirement for future implementation work:
- New async operations log start/completion with timing.
- New decision points log the decision and safe inputs.
- New external calls log the operation, target identifier, duration, and outcome.
- Errors log the causal chain or original error string while preserving secret redaction.
- New control-flow code carries `run_id`, `request_id`, `phase`, and `route_task` when available.
- Structured logs are JSON to stderr; this spec does not introduce VictoriaTraces/distributed tracing.
Keep this documentation concise so agents can follow it during future code changes.
### Testing plan

Targeted tests should verify logs by capturing pino output through injectable destinations or fake loggers.
- `tests/adapters/anthropic/claude-agent-sdk-agent-runner.test.ts`
	- emits `agent.run_started` and `agent.run_completed` on successful result.
	- emits `agent.run_failed` when `queryFn` throws.
	- emits debug `agent.sdk_item` with safe summary fields and no raw text/tool payload.
	- records token usage and outcome once from terminal `SDKResultMessage`.
	- logs redacted stderr on error and carries success-with-stderr excerpts through terminal diagnostics into `AgentDrainSummary.diagnostics.stderr_excerpt_redacted`.
- `tests/core/ai/agent-services.test.ts`
	- `drainAgentRunner` logs start/completion summaries with counts and diagnostics.
	- `drainAgentRunner` logs failure summaries and rethrows iterator errors.
	- missing result files log `agent.result_file_missing` before throwing and include `diagnostics.stderr_excerpt_redacted` when available.
	- existing result files log `agent.result_file_found` and parse as before.
- `tests/core/default-handler-registry.test.ts`
	- registered new-request and thread-message handlers emit `handler.entered` and `handler.completed`.
	- thrown handler errors emit `handler.failed` and still propagate.
- `tests/core/ai/implementation-review-coordinator.test.ts`
	- each review round emits round start/completion and `blocker_count`, `warning_count`, and `info_count`.
- `tests/adapters/slack/slack-adapter.test.ts`
	- top-level message logs use `thread_ts: msg.ts` and `message_ts: msg.ts`.
	- thread replies log root `thread_ts` and reply `message_ts` separately.
	- reaction and reply logs include timing and failures.
- `tests/adapters/notion/notion-publisher.test.ts`
	- create/update/status methods log operation latency and page IDs without content.
- `tests/core/config-watcher.test.ts`, `tests/core/git-branch-guard.test.ts`, `tests/core/workspace-manager.test.ts`, `tests/adapters/anthropic/anthropic-beta-header-filter-proxy.test.ts`, and `tests/adapters/sandbox-environment.test.ts`
	- cover new events, outcomes, timing fields, and secret-safe summaries.
Run `npm test` and `npm run lint` after implementation. If the full suite is slow, run targeted tests first, then the full suite before handoff.
## Acceptance criteria

- [ ] A VictoriaLogs query `run_id:` returns a coherent timeline for a run from intake through terminal success or failure after telemetry context has been propagated to the emitting component.
- [ ] A VictoriaLogs query `request_id:` returns intake, workspace, adapter, and handler events for the request.
- [ ] Claude Agent SDK runs emit `agent.run_started`, `agent.sdk_item`, `agent.run_completed`, and `agent.run_failed` with schema parity to OpenAI Agent SDK logs.
- [ ] Claude Agent SDK token usage is recorded from terminal `SDKResultMessage` data when available.
- [ ] `drainAgentRunner` emits start/completion/failure telemetry with counts and duration for every drain.
- [ ] Missing Autocatalyst result files emit `agent.result_file_missing` with expected path, phase, route task, correlation fields, and `diagnostics.stderr_excerpt_redacted` when available before the service throws.
- [ ] Handler dispatch emits standardized entry/completion/failure logs for every default handler route.
- [ ] Implementation review rounds are individually timed and counted with `blocker_count`, `warning_count`, and `info_count`.
- [ ] Slack, Notion, runtime composition, config watcher, branch guard, workspace manager, sandbox environment, agent services, and beta-header proxy operations emit safe structured telemetry for key decisions and external calls using explicit logger/loggerProvider injection or a documented global-provider fallback.
- [ ] New logs do not include secrets, raw credentials, full prompts, full model responses, or full tool payloads; redaction covers GitHub PAT/OAuth tokens, Slack app tokens, bearer authorization headers, Anthropic custom API-key headers, generic API-key strings, and password-like values.
- [ ] Documentation instructs future agents to add structured telemetry for new async operations, decision points, external calls, and errors.
- [ ] `npm test` and `npm run lint` pass.
## Task list

### Story 0 — Propagate telemetry context and logger providers

**Task 0.1 — Add telemetry context types and request plumbing**
Description: Add a small `TelemetryContext` / `AgentTelemetryContext` in `src/types/ai.ts` and thread it through agent services, `AgentRunRequest`, runner wrappers, handler wrappers, and external adapter calls.
Acceptance criteria:
- `run_id`, `request_id`, `phase`, `route_task`, `handler`, and safe route metadata can be attached without each helper inventing its own parameters.
- Agent runners and `drainAgentRunner` receive the context from callers instead of deriving correlation from workspace paths.
- Existing call sites compile with explicit context construction or an intentional empty context.
Dependencies: None.
**Task 0.2 — Clarify logger provider injection boundaries**
Description: Decide and document which components receive explicit `loggerProvider` / logger injection and which rely on the global OpenTelemetry provider fallback. Apply that boundary to Slack, Notion, workspace manager, config watcher, branch guard, agent services, runtime composition, and proxy construction.
Acceptance criteria:
- Runtime composition passes `loggerProvider` explicitly into constructed components that support it.
- Components using `createLogger()` without injection are listed in the logging standard with the global provider fallback behavior.
- Tests or constructor assertions cover at least one explicit-injection path outside agent runners.
Dependencies: Task 0.1.
### Story 1 — Bring Claude Agent SDK telemetry to OpenAI parity

**Task 1.1 — Add canonical route and diagnostic helpers**
Description: Add shared or local helpers for route log attributes and safe Claude SDK message diagnostics. Keep diagnostic fields summary-only.
Acceptance criteria:
- `route_task`, `route_stage`, `route_intent`, and `artifact_kind` are emitted when present.
- Claude SDK item diagnostics include message type, subtype, content block types, tool counts, usage availability, and safe normalized diagnostic fields consumable by `drainAgentRunner`.
- Tests prove raw text blocks and raw tool payloads are not logged.
Dependencies: None.
**Task 1.2 — Add Claude lifecycle logs**
Description: Emit `agent.run_started`, `agent.run_completed`, and `agent.run_failed` in `ClaudeAgentSdkAgentRunner.run()`.
Acceptance criteria:
- Success emits started and completed events with model, route fields, working directory, outcome, latency, and counts.
- Iterator errors emit failed and completed/error events without double-counting outcome metrics.
- Existing normalized event output is unchanged.
Dependencies: Task 1.1.
**Task 1.3 — Add debug SDK item logging**
Description: Log each Claude `SDKMessage` as `agent.sdk_item` at debug level using the safe diagnostic helper.
Acceptance criteria:
- Every yielded SDK message produces one debug diagnostic log.
- Logs include route and model fields.
- Logs exclude full prompt, full assistant text, full tool input, and full tool output.
Dependencies: Task 1.1.
**Task 1.4 — Harden Claude outcome, token, and stderr telemetry**
Description: Ensure terminal result usage and outcome metrics/log fields are recorded once. Preserve and test stderr redaction for both error and success exits with stderr.
Acceptance criteria:
- Terminal `SDKResultMessage` usage appears in metrics and completed log fields.
- Missing terminal result is logged explicitly.
- Stderr excerpts are redacted, bounded, and propagated as `diagnostics.stderr_excerpt_redacted` on terminal events/drain summaries when available.
Dependencies: Task 1.2.
### Story 2 — Validate result-file contracts and drain telemetry

**Task 2.1 — Return and log ****`drainAgentRunner`**** summaries**
Description: Change `drainAgentRunner()` to count events, assistant turns, relay messages, tool calls, tool results, elapsed time, and safe runner diagnostics.
Acceptance criteria:
- Drain start, completion, and failure events are logged.
- Completion logs include phase, duration, counts, outcome, `tool_metadata_available` when relevant, and redacted diagnostics when available.
- Existing progress relay behavior remains unchanged.
Dependencies: None.
**Task 2.2 — Add safe tool activity debug logs**
Description: Log non-relay tool activity at debug level while draining normalized agent events, using only safe diagnostic fields supplied by provider runners.
Acceptance criteria:
- Tool calls and tool results can be counted and queried without inspecting raw provider payloads.
- Tool logs include safe summaries only.
- No full tool input/output content appears in captured logs.
Dependencies: Task 2.1.
**Task 2.3 — Add result-file validation helper**
Description: Replace direct `readRequiredFile()` calls after drains with a helper that logs found, missing, and read-failed outcomes.
Acceptance criteria:
- Artifact creation, artifact revision, implementation, question answering, and issue triage all validate expected result files through the helper.
- Missing file logs `agent.result_file_missing` before throwing, including `diagnostics.stderr_excerpt_redacted` from the drain summary when available.
- Found file logs byte length and expected path.
Dependencies: Task 2.1.
### Story 3 — Instrument handler dispatch and review coordination

**Task 3.1 — Wrap default registry handlers**
Description: Add a handler wrapper in `buildDefaultHandlerRegistry()` that logs entry, completion, failure, duration, event type, stage, intent, handler name, `run_id`, and `request_id`, while returning the underlying handler result.
Acceptance criteria:
- Every registered new-request and thread-message default route uses the wrapper.
- Successful handlers log `handler.completed` and preserve the original handler return value for callers and outcome inference.
- Thrown errors log `handler.failed` and still propagate.
Dependencies: None.
**Task 3.2 — Align handler semantic outcomes**
Description: Adjust handler methods that return status objects or semantic statuses so wrapper logs can include useful outcomes.
Acceptance criteria:
- Approval, feedback, implementation, PR merge, issue filing, and question handlers produce meaningful outcomes via returned `status`, explicit handler metadata, or final run-stage mapping where available.
- Existing handler behavior and tests remain valid.
Dependencies: Task 3.1.
**Task 3.3 — Add implementation review round telemetry**
Description: Add per-round timing and finding-count logs in `ImplementationReviewCoordinator`.
Acceptance criteria:
- Each review round logs started and completed or failed.
- Completion includes `blocker_count`, `warning_count`, `info_count`, and duration.
- Skipped review policy remains logged as today.
Dependencies: None.
### Story 4 — Add adapter and infrastructure telemetry

**Task 4.1 — Add runtime runner selection logs**
Description: Log profile resolution and dispatch decisions in runtime composition and routing-aware runners.
Acceptance criteria:
- Startup logs show configured runner kind, profile, model, and provider without secrets.
- Per-run dispatch logs show selected runner and route task.
- Agent runners and other constructed telemetry-aware components receive `loggerProvider` where supported; any global-provider fallback is documented.
Dependencies: Story 1 for Claude logger provider parity if not already wired.
**Task 4.2 — Improve Slack adapter telemetry**
Description: Add correct `thread_ts` / `message_ts` fields, delivery timing, and delivery outcome logs for messages and reactions.
Acceptance criteria:
- Top-level and thread messages log root thread and message timestamps correctly.
- `reply()` and `reactToMessage()` log duration and success/failure.
- Tests cover the issue #99 timestamp bug path.
Dependencies: None.
**Task 4.3 — Add Notion publisher API timing**
Description: Wrap Notion database/page/markdown calls with structured timing logs.
Acceptance criteria:
- Create, update, status update, get content, and filename lookup operations log duration and IDs.
- Logs do not include Markdown content.
- Errors include operation name and target ID when known.
Dependencies: None.
**Task 4.4 — Add config watcher telemetry**
Description: Add optional logger injection and watch/reload lifecycle logs to `ConfigWatcher`.
Acceptance criteria:
- Start, stop, reload scheduled, reload fired, [fs.watch](http://fs.watch) error, and fallback behavior are logged.
- Existing debounce behavior is unchanged.
Dependencies: None.
**Task 4.5 — Add branch guard telemetry**
Description: Add optional logger injection to `GitBranchGuard` and log allowed/blocked decisions.
Acceptance criteria:
- Successful checks log expected and actual branch with `outcome: allowed`.
- Mismatches log `outcome: blocked` before throwing.
- Git command failures log a failed check without hiding the original error.
Dependencies: None.
**Task 4.6 — Add workspace manager timing**
Description: Add timing and failure logs around clone, checkout, create, and destroy operations.
Acceptance criteria:
- Workspace create/destroy logs include duration and paths.
- Clone and checkout failures are logged before cleanup/throw.
- No cleanup behavior changes.
Dependencies: None.
**Task 4.7 — Add sandbox environment and proxy telemetry**
Description: Add safe token-resolution summaries and Anthropic beta-header proxy start/stop/request/error logs.
Acceptance criteria:
- Sandbox logs list token names and exported sandbox keys, never values.
- Proxy logs start/stop, upstream status, stripped beta value count, and errors.
- Tests verify no token values are logged.
Dependencies: None.
### Story 5 — Document telemetry requirements and validate the suite

**Task 5.0 — Update or supersede stale observability decision**
Description: Update or supersede `context-agent/decisions/observability-stack.md` so it no longer instructs agents to emit structured JSON to stdout or to use VictoriaTraces for this work.
Acceptance criteria:
- The decision points to structured JSON logs on stderr, matching `context-agent/standards/logging.md`.
- The decision states that this enhancement excludes distributed tracing / VictoriaTraces.
- Future agents reading decisions and standards receive consistent guidance.
Dependencies: None.
**Task 5.1 — Update logging standards and agent instructions**
Description: Document telemetry expectations for future control-flow work in `context-agent/standards/logging.md` and root `AGENTS.md`.
Acceptance criteria:
- Instructions cover async operation timing, decision-point logs, external-call logs, error causal chains, correlation fields, loggerProvider/global-provider boundaries, and stderr structured logging.
- Documentation is concise and consistent with existing logging standards.
Dependencies: Stories 1-4 inform final wording.
**Task 5.2 — Add regression tests for correlation and no-secret logging**
Description: Add cross-cutting tests or assertions that new telemetry carries correlation fields and redacts sensitive values.
Acceptance criteria:
- Representative logs include `run_id` or `request_id` where available.
- Redaction tests cover API keys, `github_pat_`, `gho_` / `ghs_`, Slack `xapp-`, `Authorization: Bearer ...`, `ANTHROPIC_CUSTOM_HEADERS=api-key: ...`, and password-like strings.
- No test snapshots require unstable timestamps beyond checking numeric duration fields.
Dependencies: Stories 1-4.
**Task 5.3 — Run verification**
Description: Run targeted tests as stories are implemented, then run the full project checks.
Acceptance criteria:
- `npm test` passes.
- `npm run lint` passes.
- Any skipped checks are documented with the reason.
Dependencies: All implementation tasks.