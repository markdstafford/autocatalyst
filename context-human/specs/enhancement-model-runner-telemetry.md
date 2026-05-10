---
created: 2026-05-10
last_updated: 2026-05-10
status: complete
issue: 120
specced_by: markdstafford
implemented_by: markdstafford
superseded_by: null
---
# Enhancement: Model runner telemetry

## Parent features

- `feature-foundation.md` — `AnthropicDirectModelRunner` and `ClaudeAgentSdkAgentRunner`
- `feature-openai-direct-model-runner.md` — `OpenAIDirectModelRunner`
## What

All three model/agent runners gain structured telemetry sufficient to diagnose production issues. The two direct model runners (`AnthropicDirectModelRunner`, `OpenAIDirectModelRunner`) gain pino logger injection and emit `model.run` / `model.run_failed` log events on every `run()` call, covering resolved model name, route task, token counts, and latency. The `ClaudeAgentSdkAgentRunner` gains model name as an attribute on its existing OTel metrics, token usage extracted from the terminal `result` SDK message, and a success/failure outcome counter.
## Why

Operators currently have no structured signal for which model served a request, how many tokens it consumed, or whether it succeeded. The only observable on failure is the thrown exception. This makes it impossible to confirm routing behavior, attribute cost to specific tasks, or detect degraded models without instrumenting the callers. Uniform telemetry across all runners gives operators actionable production visibility without changing caller code.
## User stories

- An operator can inspect structured logs and confirm which model and route task handled each direct model run
- An operator can see input and output token counts in logs for every Anthropic and OpenAI direct model run
- An operator can observe latency per direct model run in structured log output
- An operator can correlate a failed direct model run back to its model, route, and error without scanning exception stack traces
- An operator can query OTel metrics and filter by model name to identify cost or failure patterns in the agent runner
- An operator can observe total input and output token usage across agent runner sessions in OTel metrics
- An operator can see success vs. error outcomes for agent runner sessions in OTel metrics without relying on error log scraping
## Design changes

No UI or design changes — this is a backend-only enhancement.
## Technical changes

### Affected files

- `src/adapters/anthropic/direct-model-runner.ts` — add pino logger injection; emit `model.run` on success and `model.run_failed` on error; add `performance.now()` timing
- `src/adapters/openai/direct-model-runner.ts` — same as above, using OpenAI token field names
- `src/adapters/anthropic/claude-agent-sdk-agent-runner.ts` — add model attribute to existing OTel metrics; add `_agentRunOutcome` counter; extract token usage from terminal `result` SDK message
- `src/types/ai.ts` — no changes required
- `tests/adapters/anthropic/direct-model-runner.test.ts` — add/extend tests for log emission
- `tests/adapters/openai/direct-model-runner.test.ts` — add/extend tests for log emission
- `tests/adapters/anthropic/claude-agent-sdk-agent-runner.test.ts` — add/extend tests for new metrics attributes and token usage recording
### Changes

#### 1. Introduction and overview

**Prerequisites and assumptions**
- Depends on `feature-foundation.md` (complete) — `AnthropicDirectModelRunner`, `ClaudeAgentSdkAgentRunner`, `createLogger`, and the OTel telemetry bootstrap in `src/core/telemetry.ts` and `src/core/logger.ts`
- Depends on `feature-openai-direct-model-runner.md` (complete) — `OpenAIDirectModelRunner`
- `createLogger(component, { destination?, loggerProvider? })` already exists and bridges pino to OTel when `loggerProvider` is supplied — no new logger infrastructure required
- The Anthropic `messages.create()` response carries `usage: { input_tokens, output_tokens }` on the raw response object
- The OpenAI `chat.completions.create()` response carries `usage: { prompt_tokens, completion_tokens }` on the raw response object
- The Claude Agent SDK emits a terminal `SDKResultMessage` (type `'result'`) with `subtype: 'success' | 'error_*'`, `is_error: boolean`, and `usage: NonNullableUsage` (which has `input_tokens`, `output_tokens`)
- No new npm packages are required
**Technical goals**
- Direct runners emit a `model.run` log event on every successful `run()` with: `model`, `task` (from `request.route.task`), `input_tokens`, `output_tokens`, `latency_ms`
- Direct runners emit a `model.run_failed` log event on error with: `model`, `task`, `error` string; the original error is re-thrown unchanged
- Direct runners accept an optional `logDestination` and `loggerProvider` in their options, consistent with existing adapter patterns
- Agent runner attaches `model` attribute to all existing OTel metric increments where a model is resolvable
- Agent runner records token usage (`input_tokens`, `output_tokens`) via a new `autocatalyst.agent.token_usage` histogram (or two counters — see below) on run completion
- Agent runner records a success or failure outcome via a new `autocatalyst.agent.runs` counter on run completion
- All instrumentation degrades gracefully: if no OTLP endpoints are configured, metrics are no-ops; if `logDestination` / `loggerProvider` are omitted, logs go to stderr only
**Non-goals**
- Exposing token usage through `DirectModelRunResult` — callers can already access `raw` if needed
- Cache token tracking for Anthropic (`cache_creation_input_tokens`, `cache_read_input_tokens`) — not in scope for this issue
- Per-turn token counts for the agent runner — only terminal (session-total) counts are tracked
- Changing how `runtime-composition.ts` wires runners — logger and meter are already passed through the existing DI pattern
---
#### 2. Direct model runner changes (Anthropic and OpenAI)

**Options interface additions**
Both runners add two optional fields to their existing options type:
```typescript
import type pino from 'pino';
import type { LoggerProvider } from '@opentelemetry/api-logs';

export interface AnthropicDirectModelRunnerOptions {
  createFn?: AnthropicCreateFn;
  defaultModel?: string;
  logDestination?: pino.DestinationStream;   // ← new
  loggerProvider?: LoggerProvider;           // ← new
}
```
(Same additions to `OpenAIDirectModelRunnerOptions`.)
**Constructor change**
Add `private readonly logger: pino.Logger` field, initialized in the constructor:
```typescript
import { createLogger } from '../../core/logger.js';
import { performance } from 'node:perf_hooks';

constructor(apiKey: string, options?: AnthropicDirectModelRunnerOptions) {
  // ... existing createFn and defaultModel setup ...
  this.logger = createLogger('anthropic-direct-model-runner', {
    destination: options?.logDestination,
    loggerProvider: options?.loggerProvider,
  });
}
```
OpenAI runner uses component name `'openai-direct-model-runner'`.
**`run()`**** method change**
Wrap the `createFn` call with timing and structured log emission:
```typescript
async run(request: DirectModelRunRequest): Promise {
  const model = request.model ?? request.profile?.model ?? this.defaultModel;
  if (!model) {
    throw new Error(`Direct model route ${request.route.task} requires a model`);
  }

  const startMs = performance.now();
  try {
    const raw = await this.createFn({ model, max_tokens: request.max_tokens ?? 1024, messages: request.messages });
    const latency_ms = Math.round(performance.now() - startMs);
    const usage = (raw as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    this.logger.info(
      {
        event: 'model.run',
        model,
        task: request.route.task,
        input_tokens: usage?.input_tokens ?? null,
        output_tokens: usage?.output_tokens ?? null,
        latency_ms,
      },
      'Model run completed',
    );
    return { text: raw.content.find(block => block.type === 'text')?.text ?? '', raw };
  } catch (err) {
    this.logger.error(
      {
        event: 'model.run_failed',
        model,
        task: request.route.task,
        error: String(err),
      },
      'Model run failed',
    );
    throw err;
  }
}
```
For the OpenAI runner, the token field names differ:
```typescript
const usage = (raw as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
this.logger.info({
  event: 'model.run',
  model,
  task: request.route.task,
  input_tokens: usage?.prompt_tokens ?? null,
  output_tokens: usage?.completion_tokens ?? null,
  latency_ms,
}, 'Model run completed');
```
---
#### 3. Agent runner changes (ClaudeAgentSdkAgentRunner)

**New metrics instruments**
Add two instruments alongside the existing `_agentTurns` counter and `_adapterLatency` histogram:
```typescript
private readonly _agentRunOutcome: Counter;      // ← new
private readonly _agentTokenUsage: Histogram;    // ← new
```
Initialized in the constructor:
```typescript
this._agentRunOutcome = meter.createCounter('autocatalyst.agent.runs', {
  unit: '{run}',
  description: 'Agent runs completed, by outcome',
});
this._agentTokenUsage = meter.createHistogram('autocatalyst.agent.token_usage', {
  unit: '{token}',
  description: 'Token usage per agent run',
});
```
**Model attribute on existing metrics**
The model name is available from `profile.model` (may be undefined if the caller relies on the runner default). Resolve it from the options passed to `makeClaudeAgentSdkOptions`, which already receives `profile`:
```typescript
// In run():
const model = request.profile?.model ?? 'unknown';

// Existing turn counter — add model attribute:
this._agentTurns.add(1, { component: 'claude-agent-sdk', model });
```
**Token extraction from terminal result message**
The SDK emits a `SDKResultMessage` with `type === 'result'` as the last message in the stream. Import the `SDKResultMessage` type (it is already exported from `@anthropic-ai/claude-agent-sdk`) and narrow on it:
```typescript
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

// In the run() async generator loop:
for await (const message of this.queryFn({ ... })) {
  if ((message as SDKMessage).type === 'result') {
    const result = message as unknown as SDKResultMessage;
    const outcome = result.is_error ? 'error' : 'success';
    this._agentRunOutcome.add(1, { component: 'claude-agent-sdk', model, outcome });
    this._agentTokenUsage.record(result.usage.input_tokens, {
      component: 'claude-agent-sdk', model, token_type: 'input',
    });
    this._agentTokenUsage.record(result.usage.output_tokens, {
      component: 'claude-agent-sdk', model, token_type: 'output',
    });
  }
  const event = normalizeSdkMessage(message as SDKMessage);
  if (event.type === 'assistant') {
    this._agentTurns.add(1, { component: 'claude-agent-sdk', model });
  }
  yield event;
}
// After loop, record latency as before:
this._adapterLatency.record(performance.now() - startMs, { adapter: 'agent-sdk', operation: 'query', model });
```
Note: `SDKResultMessage` is a union of `SDKResultSuccess | SDKResultError`; both carry `usage: NonNullableUsage` with `input_tokens` and `output_tokens`, so no further narrowing is required to read token counts.
---
#### 4. Runtime composition wiring

`src/adapters/runtime-composition.ts` constructs all three runners. Check whether it already threads `loggerProvider` and `meter` from the `TelemetryHandles` returned by `initTelemetry()`. If not, pass them through:
- `AnthropicDirectModelRunner`: add `loggerProvider` from telemetry handles to options
- `OpenAIDirectModelRunner`: add `loggerProvider` from telemetry handles to options
- `ClaudeAgentSdkAgentRunner`: already receives `meter` — no wiring change needed
If `runtime-composition.ts` does not yet receive `TelemetryHandles`, thread them from `src/index.ts` where `initTelemetry()` is called. This is a minimal plumbing change.
---
#### 5. Testing

All test files use the injectable `createFn` / `queryFn` pattern for the runners, and `logDestination` / `loggerProvider` injection for loggers — no mocking of module internals is needed.
**Direct runner tests (Anthropic and OpenAI)**
The existing test files use an injectable `createFn`. For each runner:
1. **`model.run`**** event on success** — inject a `createFn` that resolves with a stub response including a `usage` block; capture pino output via an injectable `logDestination` (a `pino.destination` backed by a `Writable`); assert the emitted JSON contains `event: 'model.run'`, `model`, `task`, `input_tokens`, `output_tokens`, and a numeric `latency_ms ≥ 0`
2. **`model.run_failed`**** event on error** — inject a `createFn` that rejects; assert the captured log contains `event: 'model.run_failed'`, `model`, `task`, and `error`; assert the original error is re-thrown
3. **Token fields are ****`null`**** when usage is absent** — inject a `createFn` that resolves without a `usage` field; assert `input_tokens` and `output_tokens` are `null` in the log
**Agent runner tests**
The existing test file uses an injectable `queryFn` and `meter`. For the agent runner:
1. **Model attribute on turn counter** — inject a `queryFn` that yields one assistant message then a result message; inject a mock `meter` that records `.add()` calls; assert `_agentTurns.add` was called with `{ component: 'claude-agent-sdk', model: 'claude-3-5-sonnet-20241022' }`
2. **Outcome counter on success** — inject a `queryFn` that yields a `result` message with `subtype: 'success'` and `is_error: false`; assert `_agentRunOutcome.add(1, { ..., outcome: 'success' })` was called
3. **Outcome counter on error** — inject a `queryFn` that yields a `result` message with `subtype: 'error_max_turns'` and `is_error: true`; assert `_agentRunOutcome.add(1, { ..., outcome: 'error' })` was called
4. **Token usage recorded** — assert `_agentTokenUsage.record` was called twice (once for `input`, once for `output`) with values from the stub `result.usage`
5. **`model: 'unknown'`**** when profile has no model** — inject a request with no `profile.model`; assert all metric attributes use `model: 'unknown'`
## Task list

### Story 1 — Add telemetry to AnthropicDirectModelRunner

**Task 1.1 — Extend options and add logger to AnthropicDirectModelRunner**
Extend `AnthropicDirectModelRunnerOptions` with `logDestination?: pino.DestinationStream` and `loggerProvider?: LoggerProvider`. Add `private readonly logger: pino.Logger` field. Initialize via `createLogger('anthropic-direct-model-runner', { destination, loggerProvider })` in the constructor.
*Acceptance criteria*:
- `AnthropicDirectModelRunnerOptions` has `logDestination` and `loggerProvider` fields
- Constructor initializes `this.logger` using `createLogger`
- When options are omitted, the logger writes to stderr (existing pino default behavior)
*Dependencies*: none
---
**Task 1.2 — Emit ****`model.run`**** and ****`model.run_failed`**** log events**
Wrap the `createFn` call in `run()` with a `performance.now()` timer and try/catch. On success, call `this.logger.info` with `event: 'model.run'`, `model`, `task`, `input_tokens`, `output_tokens`, `latency_ms`. On error, call `this.logger.error` with `event: 'model.run_failed'`, `model`, `task`, `error`, then re-throw.
*Acceptance criteria*:
- Successful run emits one log line with all five fields
- `input_tokens` and `output_tokens` are extracted from `raw.usage`; are `null` when absent
- `latency_ms` is a non-negative integer
- Failed run emits one error log line with `model`, `task`, and `error` string; original error propagates to caller unchanged
*Dependencies*: Task 1.1
---
**Task 1.3 — Write tests for AnthropicDirectModelRunner telemetry**
Add test cases to the existing Anthropic direct model runner test file covering: `model.run` event shape on success, `model.run_failed` event on error (error re-thrown), and `null` token fields when `usage` is absent. Use injectable `logDestination` to capture pino output.
*Acceptance criteria*:
- All three new test cases pass
- No existing tests broken
*Dependencies*: Task 1.2
---
### Story 2 — Add telemetry to OpenAIDirectModelRunner

**Task 2.1 — Extend options and add logger to OpenAIDirectModelRunner**
Same as Task 1.1, for `OpenAIDirectModelRunnerOptions` and the OpenAI runner constructor. Component name: `'openai-direct-model-runner'`.
*Acceptance criteria*:
- `OpenAIDirectModelRunnerOptions` has `logDestination` and `loggerProvider` fields
- Constructor initializes `this.logger`
*Dependencies*: none
---
**Task 2.2 — Emit ****`model.run`**** and ****`model.run_failed`**** log events (OpenAI)**
Same pattern as Task 1.2, but token fields come from `raw.usage.prompt_tokens` (mapped to `input_tokens`) and `raw.usage.completion_tokens` (mapped to `output_tokens`).
*Acceptance criteria*:
- Same criteria as Task 1.2, with OpenAI field name mapping applied
- `input_tokens` sourced from `prompt_tokens`, `output_tokens` from `completion_tokens`
*Dependencies*: Task 2.1
---
**Task 2.3 — Write tests for OpenAIDirectModelRunner telemetry**
Same scope as Task 1.3, for the OpenAI runner test file. Stub responses must include `usage: { prompt_tokens, completion_tokens }`.
*Acceptance criteria*:
- All three new test cases pass
- No existing tests broken
*Dependencies*: Task 2.2
---
### Story 3 — Enhance ClaudeAgentSdkAgentRunner metrics

**Task 3.1 — Add ****`model`**** attribute to existing turn and latency metrics**
Resolve `model` from `request.profile?.model ?? 'unknown'` at the top of `run()`. Pass `model` as an attribute to `_agentTurns.add()` and `_adapterLatency.record()`.
*Acceptance criteria*:
- `autocatalyst.agent.turns` counter increments include `{ component: 'claude-agent-sdk', model }` attribute
- `autocatalyst.adapter.latency` histogram records include `{ adapter: 'agent-sdk', operation: 'query', model }` attribute
- Attribute is `'unknown'` when no profile model is set
*Dependencies*: none
---
**Task 3.2 — Add ****`autocatalyst.agent.runs`**** outcome counter**
Create `private readonly _agentRunOutcome: Counter` in the constructor. On each `result` SDK message, call `_agentRunOutcome.add(1, { component: 'claude-agent-sdk', model, outcome })` where `outcome` is `'success'` if `result.is_error === false`, `'error'` otherwise.
*Acceptance criteria*:
- Counter named `autocatalyst.agent.runs` with `unit: '{run}'` and a description is created
- Incremented exactly once per `run()` call when the stream completes with a `result` message
- `outcome` attribute is `'success'` for `SDKResultSuccess`, `'error'` for `SDKResultError`
*Dependencies*: Task 3.1
---
**Task 3.3 — Add ****`autocatalyst.agent.token_usage`**** histogram and extract usage from result message**
Create `private readonly _agentTokenUsage: Histogram`. On each `result` SDK message, record `result.usage.input_tokens` with `{ ..., token_type: 'input' }` and `result.usage.output_tokens` with `{ ..., token_type: 'output' }`.
*Acceptance criteria*:
- Histogram named `autocatalyst.agent.token_usage` with `unit: '{token}'` and a description is created
- `record()` called twice per completed run (once for input, once for output)
- Values match `usage.input_tokens` and `usage.output_tokens` from the terminal result message
*Dependencies*: Task 3.2
---
**Task 3.4 — Write tests for enhanced agent runner metrics**
Add test cases to the agent runner test file covering: model attribute on turn counter, outcome `'success'` counter, outcome `'error'` counter, token usage recorded, and `model: 'unknown'` fallback. Use injectable `meter` (mock or `@opentelemetry/sdk-metrics` in-memory exporter).
*Acceptance criteria*:
- All five test cases pass
- No existing tests broken
*Dependencies*: Task 3.3
---
### Story 4 — Wire loggerProvider through runtime composition

**Task 4.1 — Thread ****`loggerProvider`**** into direct runner construction**
In `src/adapters/runtime-composition.ts`, pass `loggerProvider` from `TelemetryHandles` into the options for `AnthropicDirectModelRunner` and `OpenAIDirectModelRunner`. If `runtime-composition.ts` does not yet receive `TelemetryHandles`, update its interface and thread it from `src/index.ts`.
*Acceptance criteria*:
- Both direct runners receive `loggerProvider` from `initTelemetry()` output
- When `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set, direct runner log events flow to the OTel log exporter
- When the endpoint is not set, logs go to stderr only (no regression)
*Dependencies*: Tasks 1.1, 2.1