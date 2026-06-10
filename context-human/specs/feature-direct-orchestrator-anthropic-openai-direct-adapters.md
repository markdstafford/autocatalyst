---
created: 2026-06-10
last_updated: 2026-06-10
status: implementing
issue: 28
specced_by: autocatalyst
---
# Feature: Direct orchestrator, OpenAI agent adapter, and Anthropic direct adapter

## Product requirements

### What

Add the next three runner capabilities behind Autocatalyst's existing runner architecture:
1. a provider-neutral direct-mode orchestrator;
2. an OpenAI Agents SDK adapter for agent-mode sessions;
3. an Anthropic direct-runner adapter for bounded, non-agentic calls.
The runner layer should then cover three B1 cells across two providers and both modes: the existing Claude agent cell from issue 27, a new OpenAI agent cell, and a new Anthropic direct cell. The two agent cells must both drive tool-using sessions through the same agent orchestrator contract. The direct cell must make one bounded model call through a direct orchestrator that is written once and parameterized by a provider adapter.
The feature must prove that one run step can dispatch distinct agent roles to distinct providers, such as an `implementer` session on Claude and a `reviewer` session on OpenAI. It must also prove that a direct bounded call, such as intent classification, returns a validated result through the same result-tolerance pipeline used elsewhere.
### Why

Autocatalyst's runner architecture is intentionally symmetric: one connection layer, one orchestrator per mode, and one provider adapter per provider/mode cell. Issue 27 established the shared connection layer, request-alteration boundary, agent orchestrator, adapter contract, dispatch lookup, and first Claude agent adapter. The platform now needs the remaining near-term cells to show the structure is real rather than Claude-specific.
Adding the OpenAI agent adapter proves the existing agent orchestrator can drive another provider without new provider branches. Adding the direct orchestrator and Anthropic direct adapter proves bounded calls use the same connection, telemetry, result-validation, and dispatch principles while staying separate from tool-using sessions. Together, these cells make later model routing and convergence review credible because implementer and reviewer roles can be assigned to different provider families.
### Goals

- Implement a direct-mode orchestrator once, parameterized by a direct provider adapter, for bounded one-shot model calls.
- Implement an Anthropic direct adapter that uses the shared connection layer and direct orchestrator to make a bounded call and extract a structured result.
- Implement an OpenAI Agents SDK adapter that uses the existing agent orchestrator to drive a tool-using session.
- Keep all provider access behind the issue 27 connection layer and ADR-023 request-alteration boundary.
- Keep provider-specific behavior inside provider adapters, not in orchestrators, core run lifecycle, or control-plane dispatch.
- Select adapters by resolved profile provider and mode through lookup registration, not by provider-specific branching.
- Map OpenAI agent native events onto canonical `RunnerEvent` values, including assistant turns, tool activity, structured progress, notifications, and terminal result.
- Translate profile inference settings into provider-specific settings with explicit degradation or typed failure when unsupported.
- Validate direct-call results through the existing `result-tolerance` pipeline before returning them across the runner boundary.
- Emit uniform session telemetry for agent and direct modes with run, phase, step, role, provider, model, inference settings, duration, token usage, outcome, and bounded-call metadata where relevant.
- Prove in integration coverage that Claude and OpenAI agent cells can serve distinct roles in one step and that the Anthropic direct cell returns a validated result.
- Update `context-agent/wiki/code-map.md` during implementation to record the direct orchestrator, OpenAI adapter, Anthropic direct adapter, and any package/module additions.
### Non-goals

- Model-routing table implementation, `(step, role)` specificity resolution, and automatic profile assembly. This feature may use explicitly constructed profiles in tests and composition seams.
- The fourth B1 cell: OpenAI direct mode.
- Full convergence-loop implementation that assigns implementer and reviewer roles over multiple rounds.
- Durable session-grain telemetry archive and cost-accounting persistence beyond emitting the uniform metadata that later observability features consume.
- Per-route least-privilege tool policy, network-egress controls, or runner registry expansion beyond entries needed to register and compose these cells.
- UI changes for viewing runner sessions or direct-call results.
- Branch creation, worktree management, push, merge, or PR creation.
### Personas

- **Enzo (Engineer)** needs to add provider cells by implementing adapter contracts, not by changing orchestrator logic for each provider.
- **Opal (Operator)** needs OpenAI and Anthropic calls to use configured endpoints, credentials, retries, timeouts, and redacted logs consistently.
- **Phoebe (PM)** needs proof that Autocatalyst can assign different AI providers to different roles before model routing and convergence review are automated.
- **Dani (Designer)** is not directly affected by this backend feature, but future progress surfaces depend on both agent providers emitting the same typed event vocabulary.
### User stories

- As Enzo, I can register an OpenAI agent adapter and have the existing agent orchestrator drive it through the same contract as the Claude agent adapter.
- As Enzo, I can register an Anthropic direct adapter and have a direct orchestrator make a bounded call without creating a tool-using agent session.
- As Enzo, I can add a future direct provider adapter by implementing a direct adapter contract and registering it, without modifying direct orchestration logic.
- As Opal, I can configure provider profiles that reach OpenAI and Anthropic through the same connection layer and redacted request-alteration boundary.
- As Opal, I can inspect safe telemetry that shows which provider, model, mode, step, and role ran without exposing credentials, prompts, full responses, or raw transcripts.
- As Phoebe, I can see an integration proof that one role uses Claude while another role uses OpenAI in the same step.
- As Phoebe, I can see an integration proof that a direct Anthropic call returns a validated bounded result.
- As Dani, I can rely on OpenAI agent progress, notifications, assistant turns, tool activity, and terminal result being normalized into existing runner events.
### Acceptance criteria

#### Direct-mode orchestrator

- A direct-mode orchestrator is written once and parameterized by a provider adapter.
- The direct orchestrator makes one bounded non-agentic call through the selected adapter. It does not start a tool-using session and does not expose agent progress tools.
- The direct orchestrator validates the adapter's result through the existing `result-tolerance` pipeline before returning the value across its boundary.
- The direct orchestrator emits the same telemetry shape as agent sessions where fields apply: start, completion, duration, token usage availability, outcome, provider, model, inference settings, run, phase, step, and `role: none` or equivalent for direct calls.
- Direct-call failures are typed and sanitized. They do not persist raw prompts, raw request bodies, provider credentials, full upstream responses, or transcripts.
#### Anthropic direct adapter

- An Anthropic direct adapter implements the direct provider-adapter contract.
- The adapter constructs an Anthropic client or fetch-compatible request through the shared connection layer. It does not implement its own header rewriting, timeout, retry, auth injection, or logging.
- The adapter makes a one-shot bounded call suitable for direct work such as intent classification.
- The adapter extracts a structured result candidate for direct-orchestrator validation.
- Anthropic-specific model, inference-setting, response-shape, and token-usage mapping remain inside the adapter.
- Unsupported optional inference settings produce explicit degradation metadata. Unsupported required settings fail with a typed sanitized error before or during call setup.
#### OpenAI Agents SDK adapter

- An OpenAI Agents SDK adapter implements the existing agent provider-adapter contract for agent mode.
- The adapter imports the OpenAI Agents SDK as a library or uses an injectable SDK harness for tests. It does not shell out to an uncontrolled process.
- The adapter drives a tool-using session through the existing agent orchestrator and yields canonical `RunnerEvent` values only.
- The adapter maps native OpenAI assistant turns, tool calls/results, structured progress, notification tools, and terminal result signals onto the canonical runner event vocabulary.
- The adapter exposes progress tools equivalent to `update_plan`, `report_progress`, and `notify` where the SDK supports custom tools or tool-like callbacks.
- The adapter translates profile inference settings, including reasoning effort where supported, into OpenAI's provider form. Unsupported optional settings produce degradation metadata; unsupported required settings fail safely.
- Provider-native events, raw transcripts, and raw terminal candidates are not persisted as step results.
#### Shared connection and request alteration

- All new adapters reach providers through the issue 27 connection layer and per-endpoint request-alteration boundary.
- No new adapter performs its own credential lookup, auth-header injection, `baseUrl` application, header strip/rewrite, timeout, retry, or redacted request logging outside that shared boundary.
- Fetch-capable adapters use `createFetchTransport()` or an equivalent public connection-layer method.
- A production-capable OpenAI agent path that delegates all provider HTTP to the shared connection transport is required for this feature to count the OpenAI agent cell as a working B1 cell. An injected SDK harness alone is not sufficient for feature completion.
- The production OpenAI agent adapter is fetch-transport-capable only when the selected OpenAI Agents SDK path can accept the connection layer's `ProviderFetchTransport` or an SDK-supported equivalent that delegates actual HTTP requests to that transport. In that supported path, endpoint/base URL, credential injection, timeout, retry, and redacted request/response logging are enforced by the connection layer; the adapter only passes the transport/session configuration through.
- The production OpenAI agent adapter must bind the selected connection transport to a per-session or per-agent OpenAI client/model passed into that session or `Runner`; it must not call `setDefaultOpenAIClient` or any other process-wide OpenAI SDK configuration because concurrent runs use distinct endpoints, credentials, and request-alteration policy.
- If the selected OpenAI Agents SDK version cannot delegate provider HTTP access to the connection layer transport, production OpenAI real calls must fail before provider access with a typed `UnsupportedProviderCapabilityError` or `ProviderConnectionError`; that state is an unresolved implementation blocker for the working OpenAI B1 cell, not an acceptable final production behavior. The adapter may still run tests through an injected SDK harness, but it must not bypass the connection layer with independent endpoint, auth, timeout, retry, or logging behavior.
- Endpoint behavior that cannot be represented for a provider is treated as a typed capability gap, not a silent provider-specific exception.
- Captured logs and telemetry never include known credential values, auth headers, raw prompts, message bodies, full provider responses, or raw transcripts.
#### Dispatch and symmetry

- Dispatch selects the OpenAI agent adapter and Anthropic direct adapter by resolved profile provider/mode through the same lookup strategy established in issue 27.
- Adding these cells is a matter of adapter registry entries and profile resolution data, not new provider-specific branches in orchestrators.
- The two agent adapters expose the same event, telemetry, inference-setting degradation, structured-progress, and terminal-result contract to the agent orchestrator.
- The direct orchestrator and agent orchestrator both use shared telemetry tags and connection semantics, while keeping their mode-specific work distinct.
#### Event stream and result handoff

- Events from the OpenAI agent cell flow through `consumeRunnerEvents` unchanged and are persisted/re-streamed over `GET /v1/runs/:id/events` using the existing client-visible contract.
- The OpenAI adapter emits exactly one raw `runner_terminal_result` and no events after terminal.
- The Anthropic direct adapter returns one bounded result candidate that the direct orchestrator validates before downstream use.
- Agent terminal results continue through the existing `ExecutionRunUnitOfWork.runWithCheckpoint()` → `consumeRunnerEvents()` path and become the `checkpointResult` passed into `Orchestrator.applyDirective()` / `recordRunStepTransition()` when the directive advances.
- Direct bounded results use the concrete direct entry point `createDirectCallFactory(...).call(input)`. The control-plane direct-step execution seam must wrap a successful `DirectOrchestratorCallResult.value` as the current step's `RunWorkResult` `{ directive: 'advance', result: value }` and pass that through the same `Orchestrator.applyDirective()` / `recordRunStepTransition()` checkpoint handoff as agent terminal results. Direct mode must not fabricate runner events solely to reach this handoff.
- A multi-role agent step remains one logical workflow step and one source `RunStep` lifecycle transition in core. The control-plane fan-out creates one role-scoped agent session per role, each with its own `run`, `phase`, `step`, `role`, provider, adapter, session id, event stream, telemetry record, and terminal result. It does not create separate workflow steps or allow an individual role terminal result to advance the run on its own.
- For issue 28, multi-role role sessions execute sequentially in deterministic role order unless a later spec adds a parallel-safe scheduler. Sequential execution avoids races against the single `RunStep.checkpointResult` and the existing `Orchestrator.applyDirective()` handoff.
- The multi-role step checkpoint handed to `Orchestrator.applyDirective()` is an aggregate JSON object keyed by role, for example `{ roles: { implementer: , reviewer:  } }`, plus only safe role/provider/adapter metadata needed by tests or telemetry. Each role's terminal result remains isolated in its role entry; core treats only the aggregate as the source step's `checkpointResult`.
#### Integration coverage

- An integration test exercises all three working cells against mocked provider backends: existing Claude agent, new OpenAI agent, and new Anthropic direct.
- The integration test proves the OpenAI agent session streams canonical events through the event consumer like the Claude cell.
- The integration test proves the Anthropic direct call returns a validated bounded result through the direct orchestrator.
- The integration test dispatches two roles in one step to two distinct agent providers, such as Claude for `implementer` and OpenAI for `reviewer`.
- The integration test asserts the multi-role step uses one source `RunStep`, two role-scoped sessions/event streams attributed by role, deterministic execution order, isolated role terminal results, and one aggregate checkpoint result handed to the orchestrator.
- The integration test proves every new adapter and the direct orchestrator are invoked through production dispatch/composition seams, not only isolated unit tests.
- Tests use mocked backends or injectable SDK seams and must not require live OpenAI or Anthropic credentials.
### References

- Issue: [https://github.com/markdstafford/autocatalyst/issues/28](https://github.com/markdstafford/autocatalyst/issues/28)
- `context-human/spec.md`
- `context-human/concepts/agent-runners.md`
- `context-human/concepts/execution-runtime.md`
- `context-human/concepts/model-routing.md`
- `context-human/concepts/observability.md`
- `context-human/adrs/adr-022-runner-structure.md`
- `context-human/adrs/adr-023-request-alteration-boundary.md`
- `context-agent/standards/logging.md`
- `context-agent/standards/telemetry-conventions.md`
- Prior spec: `context-human/specs/feature-runner-connection-layer-claude-agent-adapter.md`
## Design spec

### Design scope

This is a backend execution-plane feature. It does not add screens, visual components, or user-facing product copy. The design work is the runtime shape for two modes, the operator/developer experience around provider setup, and the observable behavior of events, telemetry, and sanitized failures.
The core product promise is symmetry: a provider changes how inputs and outputs map, not how Autocatalyst dispatches, validates, records, or observes a session.
### Operator experience

An operator configures provider profiles for OpenAI agent work and Anthropic direct work using the same service-owned configuration model already used by the Claude path. A run should fail before provider access when the selected profile is missing, uses an unregistered adapter, lacks a required credential, has an invalid endpoint, or requests a required capability the provider cell cannot support.
When a call starts, logs and telemetry should prove that the configured profile, endpoint, model, mode, and step context were used. They should not reveal credential values, raw prompt text, message bodies, provider transcripts, or full upstream response bodies. If a gateway or endpoint requires header changes, base URL overrides, timeout, or retry behavior, the operator should see redacted evidence that the connection layer applied or rejected that capability.
Direct-call failures should be as actionable as agent-session failures. A missing credential should identify a missing credential, not a generic provider error. A provider timeout should identify timeout or retry exhaustion. A result-shape mismatch should identify result validation failure. All three cases should use safe details only.
### Developer experience

A developer should encounter four clear seams:
1. **Agent adapter contract** — already used by Claude and now implemented by OpenAI.
2. **Direct adapter contract** — a new contract for one-shot bounded calls.
3. **Agent orchestrator** — already shared by agent adapters and unchanged except for any contract gaps found while adding OpenAI.
4. **Direct orchestrator** — new shared mode orchestrator for direct adapters.
The OpenAI adapter should not know how core persists run events, how SSE replay works, or how `RunStep` checkpoint storage works. The Anthropic direct adapter should not know how model-routing tables will later resolve a profile. The direct orchestrator should not know Anthropic request or response names. These separations make contract gaps visible: if a provider cannot fit without a branch in shared code, the adapter contract should change deliberately.
### Mode flow

Agent mode continues to work as issue 27 defined it:
1. Dispatch resolves an explicit profile for a `(run, phase, step, role)` context.
2. Dispatch looks up an agent adapter by `(providerKind, adapterId)`.
3. The connection layer resolves credentials and endpoint behavior.
4. The agent orchestrator starts the adapter session with `RunnerRunInput`.
5. The adapter maps provider-native streaming events to canonical `RunnerEvent` values.
6. The existing execution entry point validates the terminal result and core consumes the event stream.
Direct mode uses a parallel but narrower flow:
1. Dispatch resolves an explicit profile for a direct-call context, usually `(run, phase, step)` with no role.
2. Dispatch looks up a direct adapter by `(providerKind, adapterId)` and verifies the profile declares direct mode.
3. The connection layer resolves credentials and endpoint behavior.
4. The direct orchestrator calls the adapter once with bounded input, expected schema/contract, telemetry context, and connection handle.
5. The adapter makes the provider call and returns a structured result candidate plus metadata.
6. The direct orchestrator runs the result-tolerance pipeline and returns the validated result or a sanitized failure.
Direct mode should not emit assistant-turn or tool-activity events because there is no tool-using session. It may emit telemetry and, if a future caller needs it, a small lifecycle event vocabulary. That event vocabulary should not be invented in this issue unless implementation needs it for an existing consumer.
### Direct-step control-plane seam

Direct mode plugs into the existing lifecycle at the control-plane unit-of-work boundary, not through `RunnerEvent` fabrication.
The owning implementation seam is `packages/core/src/execution-run-unit-of-work.ts` plus the control-plane composition in `apps/control-plane/src/server.ts`. Add a public direct execution port that those modules can inject alongside the existing agent `ExecutionEntryPoint`:
```typescript
export interface DirectStepExecutionPort {
  call(input: DirectStepWorkInput): Promise;
}

export interface DirectStepWorkInput {
  readonly runId: string;
  readonly tenant: string;
  readonly run: Run;
  readonly phase: string;
  readonly step: string;
  readonly directCall: DirectCallRequest;
  readonly resultValidation: DirectResultValidationConfig;
}
```
Final names may differ, but the runtime contract must be concrete:
- **Selection rule:** `RunWorkInput` remains the core lifecycle input, but context resolution must identify the current workflow step's execution mode. A step declares direct mode through workflow/step execution metadata or an injected resolver result, not by provider-specific code. If the resolved mode is `agent`, `ExecutionRunUnitOfWork.runWithCheckpoint()` uses the existing `ExecutionEntryPoint` and `consumeRunnerEvents()` path. If the resolved mode is `direct`, it calls `DirectStepExecutionPort.call()` / `createDirectCallFactory(...).call(input)`.
- **Input shape:** direct-step input includes run id, tenant, current phase/step, no role, the provider-neutral `DirectCallRequest`, the resolved direct profile, and the result-validation contract. Raw prompts or provider request bodies are not added to `RunWorkInput` or persisted.
- **Result mapping:** on success, the seam maps `DirectOrchestratorCallResult.value` to `RunWorkResult` `{ directive: 'advance', result: value }` and returns the same value as `checkpointResult` from `runWithCheckpoint()`, matching the agent terminal-result handoff.
- **Error mapping:** typed direct configuration, connection, adapter protocol, cancellation, and validation failures map to sanitized `RunWorkResult` failure reasons or propagated typed errors according to the existing `ExecutionRunUnitOfWork` error style. Safe error codes may be logged/telemetried; raw prompts, request bodies, credentials, full provider responses, and transcripts must not be included.
- **Lifecycle handoff:** `DefaultOrchestrator` continues to call `applyDirective()` with the `RunWorkResult.directive` and optional checkpoint from `runWithCheckpoint()`. `recordRunStepTransition()` persists the source `RunStep.checkpointResult`. Direct mode does not call `consumeRunnerEvents()` and does not emit `runner_terminal_result`.
### OpenAI agent adapter design

The OpenAI adapter is a peer to the Claude adapter. It implements the public `AgentProviderAdapter` contract and registers under an OpenAI provider kind and an OpenAI agent adapter id. It should use an injectable SDK harness in tests and the real OpenAI Agents SDK behind a thin launch/client seam in production.
The adapter maps Autocatalyst's materialized environment into the SDK's session configuration:
- prompt and task context from `runInput.environment`;
- workspace and scratch roots from the materialized workspace;
- scoped environment variables after connection-owned provider settings are handled by the connection layer;
- allowed tools and broad non-interactive tool posture from tool policy;
- requested skills/plugins where the SDK has a compatible capability;
- progress tools for `update_plan`, `report_progress`, and `notify` where supported.
The adapter should normalize OpenAI native events into existing runner event types. Provider-native event names and shapes must not leak past the adapter. If the SDK reports token usage only at completion, the adapter should surface it through session metadata. If usage is unavailable, telemetry should report `usageAvailable: false` rather than invented zeros.
#### OpenAI connection mechanism

The only acceptable production OpenAI provider-access mechanism for this issue is an SDK launch/session path that accepts the connection layer's `ProviderFetchTransport` or an SDK-supported HTTP client hook that delegates every provider request to that transport. The adapter must create that transport through `connection.createFetchTransport()` and pass it to the SDK seam; the connection layer remains the owner of endpoint/base URL application, credential injection, timeout, retry, transient-failure classification, and redacted request/response logging.
When the SDK hook expects standard `fetch(url, init): Promise` rather than Autocatalyst's single-object `ProviderFetchTransport.fetch(request)`, the adapter must pass a thin bridge that extracts `url`, `method`, `headers`, `body`, and `signal` from `RequestInfo`/`RequestInit` and calls `transport.fetch({ url, method, headers, body, signal })`; headers and bodies must still flow through the connection-layer alteration and redaction path. The production adapter must bind that bridged transport to a per-session or per-agent OpenAI client/model supplied to the launched session or `Runner`. It must not use `setDefaultOpenAIClient`, global default clients, global base URLs, or any process-wide OpenAI SDK setting.
If the OpenAI Agents SDK version selected during implementation cannot use such a transport hook, the real OpenAI adapter must fail before starting any real session with a typed sanitized capability/connection error. It must report the unsupported mechanism in safe metadata and tests may continue to use the injectable `OpenAISessionLaunch` harness. The adapter must not add an alternate production path that reads credentials, sets auth headers, applies endpoint URLs, implements retries/timeouts, or logs requests outside the shared connection layer.
#### OpenAI native-event mapping

The OpenAI adapter must map supported native or harness events to canonical `RunnerEvent` variants as follows. Native type names are illustrative seam names; implementation may adapt SDK-specific names behind `OpenAINativeEvent`, but the emitted canonical payloads and protocol behavior are required.

Native event category
Required native data
Canonical output
Payload requirements
Protocol behavior

Assistant output/message delta or completed assistant message
Assistant text content after provider-specific aggregation
`runner_assistant_turn`
`message.role` is `assistant`; `message.content` is the safe assistant text only, not a raw native payload.
May emit multiple assistant turns before terminal. Empty content may be dropped only if the SDK marks it as non-user-visible.

Generic tool call started/completed
Tool name plus action/status; output may be summarized safely
`runner_tool_activity`
`tool.name`, `tool.action`, and `tool.status` use existing canonical strings such as `started`, `completed`, or `failed`; raw tool input/output objects are not persisted.
Tool activity after terminal is a protocol failure.

Generic tool result
Tool name plus completion/failure status
`runner_tool_activity`
Same as generic tool call; safe result summaries may affect `status`, not raw output persistence.
Missing matching tool call is tolerated only if the SDK emits result-only events; otherwise treat impossible sequences as protocol failures.

Progress tool `update_plan`
Plan title and non-empty ordered steps
`runner_progress`
`progress: { kind: 'plan', title, steps }` and `importance: 'normal'` unless caller policy requests otherwise.
Invalid plan payload is an adapter protocol failure.

Progress tool `report_progress`
Label, completed count, total count
`runner_progress`
`progress: { kind: 'task_progress', label, completed, total }` with `completed 
Invalid counts are an adapter protocol failure.

Progress/intent notification tool `notify`
Severity and message
`runner_notification`
\`notification: \{ severity: 'debug'
'info'
'warn'
'error', message \}\`.
Invalid severity/message is an adapter protocol failure.

Terminal result
Valid terminal directive and optional safe question/reason
`runner_terminal_result`
`result` conforms to the existing terminal result schema; raw terminal candidates are not persisted.
Exactly one terminal event is emitted. The adapter stops yielding after terminal.

Usage update or completion usage
Input/output/total token counts when SDK supplies them
No `RunnerEvent`; session metadata only
`AgentProviderSession.metadata.tokenUsage` records available counts, or `usageAvailable: false` when unavailable.
Usage after terminal may update metadata only before session close; it must not create events after terminal.

Unmappable required native event
Event is required to preserve semantics but has no supported mapping
None
Safe error code/details only.
Fail with `ProviderProtocolError`; do not leak raw native payload.

Unmappable optional native event
Event is explicitly optional/no-op for user-visible state
None
Optional degradation metadata if useful.
May be ignored with safe degradation; raw payload is not persisted.

Duplicate terminal
Second terminal signal
None
Safe protocol error.
Fail with `ProviderProtocolError` and do not emit a second terminal event.

Event after terminal
Any non-usage native event after terminal
None
Safe protocol error.
Fail with `ProviderProtocolError`; no canonical events are emitted after terminal.

### Direct orchestrator design

The direct orchestrator owns mode behavior that is not provider-specific:
- verify adapter/profile provider and connection mechanism match;
- emit direct-call start telemetry;
- call the adapter exactly once with bounded input, profile, connection, validation contract, and telemetry context;
- record duration, token usage availability, degraded capabilities, and outcome;
- validate the adapter result candidate through `validateStepResult` or an equivalent existing result-tolerance API;
- return a validated value or a typed sanitized failure;
- close adapter resources if the adapter exposes close semantics.
The direct orchestrator should not implement prompt shaping for a specific direct use case unless that shaping is part of a provider-neutral direct input contract. For example, intent classification input can be represented as direct-call input data with a declared schema, while Anthropic message formatting remains inside the adapter.
### Anthropic direct adapter design

The Anthropic direct adapter implements the direct adapter contract for one-shot bounded calls. The preferred path is fetch-capable, because Anthropic Messages-style calls can use the connection layer's fetch transport for request alteration, timeout, retry, and redacted request/response logging.
The adapter should:
- create a provider request through `AgentConnection.createFetchTransport()` or the direct connection equivalent;
- apply model and inference settings according to an explicit Anthropic direct capability matrix;
- encode the bounded-call input into the provider request body inside the adapter;
- parse the provider response and extract a structured result candidate;
- normalize token usage into the shared token breakdown when available;
- return safe degradation metadata for unsupported optional settings;
- fail safely for unsupported required settings, non-transient provider errors, malformed provider responses, and missing structured result candidates.
The adapter must not read provider credentials from environment variables. Credentials come from the connection layer and remain outside adapter-visible profile data.
#### Direct-call prompt and structured-output contract

`DirectCallRequest` is provider-neutral. It describes what the bounded call should decide and the exact validation contract for the result; it does not contain Anthropic-specific message names or OpenAI-specific response-format options.
The request must include:
- `purpose`: a short safe identifier such as `intent_classification`;
- `input`: structured task data supplied by Autocatalyst, treated as sensitive and never logged raw;
- `resultValidation`: a schema id or inline JSON-schema-compatible contract plus tolerance/normalization policy;
- optional bounded-output settings such as maximum output tokens, timeout class, or correction policy when supported by the direct orchestrator.
The direct orchestrator passes this request unchanged to the adapter and separately passes the validation config to the result-tolerance pipeline. Provider adapters are responsible for converting the request into provider prompt/messages. For Anthropic, the adapter must communicate the schema to the model by one of these bounded structured-output protocols:
1. preferred: an Anthropic tool-use request with a single synthetic tool such as `autocatalyst_direct_result`, whose input schema is derived from `resultValidation`; the returned `tool_use.input` is the candidate;
2. fallback: a Messages request that instructs the model to return exactly one JSON object matching the schema, with no prose, markdown, or surrounding text; the parsed object is the candidate.
The Anthropic adapter accepts only one structured candidate. Extra assistant prose, multiple tool calls, malformed JSON, schema fields that cannot be represented, or additional non-whitespace output outside the single JSON object/tool input are adapter protocol failures. Unknown extra JSON properties are handled by the declared validation schema/tolerance policy, not silently accepted by the adapter.
Anthropic adapter tests must include fixtures for: successful tool-use structured output, successful JSON-only fallback output, malformed JSON, extra prose around JSON, multiple structured candidates, missing candidate, and a candidate that parses but fails result validation.
### Dispatch and role-distinct proof

This feature does not implement full model routing. It should still prove that dispatch can construct and use multiple profiles in one step. Tests may explicitly resolve profiles such as:
- `implementer` → Claude agent adapter;
- `reviewer` → OpenAI agent adapter;
- direct classification step → Anthropic direct adapter.
That proof should use the same registry and dispatch seams that production composition uses. A role-specific test-only resolver is acceptable; hard-coded provider branches in orchestrators are not.
The multi-role proof has this runtime shape:
- Core still has one source `RunStep` for the workflow step. Role fan-out is execution-plane/session behavior attached to that `runId`/`phase`/`step`, not new workflow-step creation.
- Control-plane creates two role-scoped agent sessions for the same step. Each session is attributed with its role in canonical events, telemetry, and any session id/correlation id. Event consumers and SSE replay must be able to distinguish `implementer` events from `reviewer` events by the existing role field or a safe role attribute.
- Sessions run sequentially in deterministic configured role order for issue 28. A later parallel scheduler may relax this only after defining checkpoint merge and event ordering rules.
- Each role terminal result is validated through the existing agent path and kept isolated. The checkpoint result for the source `RunStep` is one aggregate JSON value keyed by role; that aggregate is the only value handed to `Orchestrator.applyDirective()` for the step.
- If any required role fails, the aggregate step fails with a sanitized reason and does not advance with partial role results. Safe partial role metadata may appear in telemetry only.
### Telemetry and logging design

Telemetry records should follow `context-agent/standards/telemetry-conventions.md`. Agent and direct records should share field names where possible. Direct records may use `role: none` or omit role consistently according to the existing logging convention, but they must remain attributable to a run, phase, and step.
Required telemetry fields include:
- event code for start/completion/failure;
- run id, phase, step, and role where applicable;
- provider kind, adapter id, model, inference settings, and connection mechanism;
- duration and outcome;
- token usage with an explicit availability flag;
- degraded capabilities;
- sanitized error code on failure.
Connection logs remain distinct from session telemetry. Fetch-capable OpenAI and Anthropic paths should use redacted request/response/retry logs from the connection layer. No component should log prompt content, issue bodies, message bodies, raw model responses, raw transcripts, credentials, or full launch/request environments.
### Failure and degradation design

The feature should distinguish these failures:
- **Configuration failure:** no profile, unsupported adapter, duplicate registration, invalid endpoint, missing credential, mismatched mode, or required unsupported capability.
- **Connection failure:** timeout, retry exhaustion, non-transient provider response, locked secret store, or unsupported connection mechanism.
- **Adapter protocol failure:** native event cannot be mapped, direct response lacks a structured result, duplicate terminal event, event after terminal, or impossible provider sequence.
- **Result validation failure:** direct or terminal result candidate cannot satisfy the declared schema after tolerance behavior.
- **Optional capability degradation:** unsupported optional inference setting, unsupported optional skill/tool feature, missing token usage, or less-rich progress mapping.
Only optional capability degradation should allow a call to continue. Required capability gaps and malformed required outputs should fail before downstream core logic consumes them.
## Tech spec

### Current state

The current branch already contains the issue 27 runner foundation:
- `packages/execution/src/agent-provider-adapter.ts` defines the agent adapter contract, `ResolvedAgentRunnerProfile`, credential-reference separation, connection handle types, session metadata, and sanitized provider error classes.
- `packages/execution/src/connection.ts` resolves credentials, exposes fetch transport and process launch configuration paths, and logs redacted provider connection attempts.
- `packages/execution/src/request-alteration.ts` applies fetch request alteration, Claude process-launch mapping, retry/timeout defaults, transient-failure classification, and redaction helpers.
- `packages/execution/src/agent-orchestrator-runner.ts` wraps an `AgentProviderAdapter` into the existing `Runner` interface, validates canonical runner events, enforces terminal protocol, and emits agent-session telemetry.
- `packages/execution/src/runner-dispatch.ts` resolves explicit profiles, looks up agent adapters by provider/adapter key, creates connections, and returns an agent orchestrator runner.
- `packages/claude-agent-adapter/` implements the Claude Agent SDK agent adapter using the process-environment mechanism.
- `apps/control-plane/src/server.ts` can compose real runner dispatch with the Claude adapter when configured.
- `packages/core/src/runner-event-consumer.ts` and related API-contract event modules persist and re-stream canonical runner events.
- `packages/execution/src/result-tolerance.ts`, `result-contracts.ts`, `result-correction.ts`, and `result-file.ts` own the result-validation pipeline.
Issue 28 should build on these modules rather than replacing them.
### Module ownership

Add direct-runner contracts and orchestration under `packages/execution/src/`:
- `direct-provider-adapter.ts` — direct adapter contract, direct-call input/result candidate types, direct session metadata, token usage/degradation metadata reuse, and direct-specific sanitized protocol errors if the existing provider errors are not sufficient.
- `direct-orchestrator.ts` or `direct-orchestrator-runner.ts` — provider-neutral direct orchestrator for one bounded call and result validation.
- `direct-runner-dispatch.ts` or an additive extension to `runner-dispatch.ts` — lookup-based direct adapter selection by resolved profile.
Add the OpenAI agent adapter as a provider-isolated package:
- `packages/openai-agent-adapter/`
- Import path: `@autocatalyst/openai-agent-adapter`
- Tags: `type:lib`, `scope:adapter`, `plane:execution`
- Public factory: `createOpenAIAgentAdapter()`
- Public constants: OpenAI provider kind and OpenAI agent adapter id
- Tests: OpenAI native-event mapping, progress tools, inference settings, token usage, terminal result, and redaction behavior through injected SDK harness
Add the Anthropic direct adapter as a provider-isolated package or a provider-isolated module. Prefer a package if it introduces provider SDK dependencies:
- `packages/anthropic-direct-adapter/`
- Import path: `@autocatalyst/anthropic-direct-adapter`
- Tags: `type:lib`, `scope:adapter`, `plane:execution`
- Public factory: `createAnthropicDirectAdapter()`
- Public constants: Anthropic provider kind and Anthropic direct adapter id
- Tests: request construction, response parsing, structured result extraction, token usage mapping, error handling, and inference-setting degradation
Update composition modules:
- `packages/execution/src/index.ts` exports direct contracts, direct orchestrator/factory APIs, and any shared direct result types.
- `packages/core/src/execution-run-unit-of-work.ts` adds mode selection between the existing agent `ExecutionEntryPoint` path and an injected direct-step execution port, while preserving `RunWorkInput` as the lifecycle input and `runWithCheckpoint()` as the checkpoint source.
- `apps/control-plane/src/server.ts` registers OpenAI agent and Anthropic direct adapters when real dispatch is enabled or when tests inject them.
- `context-agent/wiki/code-map.md` is updated during implementation to record new modules and packages.
### Execution profile contract

Extend the public `ResolvedAgentRunnerProfile` execution contract additively with `readonly mode: 'agent' | 'direct'`. Issue 27's profile already carries `connectionMechanism`; issue 28 should make mode a real field on that same profile type instead of using intersection types such as `ResolvedAgentRunnerProfile & { readonly mode: 'direct' }` in direct-only call sites.
Agent profiles must populate `mode: 'agent'`, direct profiles must populate `mode: 'direct'`, and dispatch/orchestrator compatibility checks must use that field. Issue 29's routing resolver must also populate this field when it starts returning routed profiles so model routing keeps one shared profile shape for both modes.
### Direct adapter contract

Suggested public shape:
```typescript
export interface DirectProviderAdapter {
  readonly providerKind: string;
  readonly adapterId: string;
  readonly supportedConnectionMechanism: ProviderConnectionMechanism;
  call(input: DirectProviderCallInput): Promise;
  close?(): Promise;
}

export interface DirectProviderCallInput {
  readonly call: DirectCallRequest;
  readonly profile: ResolvedAgentRunnerProfile;
  readonly connection: AgentConnection;
  readonly telemetryContext: AgentConnectionTelemetryContext;
}

export interface DirectCallRequest {
  readonly purpose: string;
  readonly input: unknown;
  readonly resultValidation: DirectResultValidationConfig;
}

export interface DirectProviderCallResult {
  readonly candidate: unknown;
  readonly metadata: DirectProviderCallMetadata;
}

export interface DirectProviderCallMetadata {
  readonly outcome: 'succeeded';
  readonly tokenUsage: AgentTokenUsage;
  readonly degradedCapabilities: readonly ProviderCapabilityDegradation[];
  readonly model?: ModelIdentity;
}
```
The final names can differ. The key ownership must remain: direct orchestrator validates and records mode behavior; direct adapter constructs provider-specific request/response mapping. The adapter returns a candidate, not a trusted value.
Use the shared `ResolvedAgentRunnerProfile` shape with its real `mode` field for both agent and direct profiles rather than creating a parallel profile model.
Direct adapter failure contract:
- `DirectProviderCallResult` is a success-only return value. It must include exactly one candidate and metadata with `outcome: 'succeeded'`.
- Configuration failures, connection failures, provider cancellations/timeouts, adapter protocol failures, malformed or missing structured candidates, and unsupported required capabilities throw typed sanitized errors such as the existing provider errors or a direct-specific `DirectProviderProtocolError`.
- A thrown error may carry safe metadata for telemetry, such as provider kind, adapter id, model, duration, token usage availability, degraded capabilities observed before failure, upstream status code class, and safe error code. It must not carry raw prompts, raw request bodies, credentials, full provider responses, native event payloads, or transcripts.
- Adapters must not return `{ outcome: 'failed' }` or `{ outcome: 'canceled' }` at all. Failure and cancellation are represented by typed errors so the direct orchestrator has one failure path.
- The direct orchestrator is responsible for recording failed/canceled telemetry outcomes from caught typed errors and for preserving only safe metadata during cleanup. Partial metadata from errors is telemetry-only unless a later core contract explicitly persists it.
- Result validation failures belong to the direct orchestrator after a successful adapter return. The adapter only extracts the provider candidate; it does not decide whether the candidate satisfies Autocatalyst's schema except for provider-protocol requirements such as "exactly one structured candidate exists."
### Direct orchestrator implementation

Create a direct orchestrator factory that accepts:
- a `DirectProviderAdapter`;
- a `ResolvedAgentRunnerProfile`;
- an `AgentConnection`;
- an `AgentConnectionTelemetryContext`;
- a result-validation config compatible with the existing result-tolerance pipeline;
- injectable telemetry/logger/clock seams for tests.
The orchestrator should:
1. validate adapter/profile provider kind, adapter id, mode, and connection mechanism;
2. emit `direct_orchestrator_call_start` telemetry or the repo's chosen stable event code;
3. call the adapter once with direct input and connection handle;
4. validate the returned candidate through `validateStepResult` or the same lower-level result-tolerance API used by execution entry point;
5. return the validated value to the caller;
6. emit completion/failure telemetry with duration, token usage availability, degraded capabilities, and sanitized error code;
7. call adapter close hooks on completion and failure where applicable.
If `adapter.call()` resolves with missing candidate data, non-success outcome metadata, or malformed safe metadata, the orchestrator must treat that as an adapter protocol failure and emit failure telemetry. If `adapter.call()` throws a typed sanitized error, the orchestrator preserves safe metadata for telemetry, calls cleanup hooks, and rethrows or maps the error according to the direct-step seam. Untyped errors are wrapped in a sanitized provider/adapter failure.
Do not make the direct orchestrator implement `Runner` unless implementation has a concrete reason. A direct call is a narrower port than the agent event stream. If an existing call path only accepts `Runner`, add a small direct-call factory/port rather than forcing direct mode to invent fake agent events.
### Anthropic direct adapter implementation

Implement the Anthropic direct adapter against the direct contract.
Recommended behavior:
- support `fetch_transport` as the primary connection mechanism;
- call `connection.createFetchTransport()` and send provider requests through that transport;
- bridge the connection transport to the Anthropic SDK's standard `fetch(url, init)` option when using the SDK, by calling `transport.fetch({ url, method: init?.method, headers: init?.headers, body: init?.body, signal: init?.signal })` so request alteration and redaction still apply;
- use the profile endpoint for base URL, auth header, timeout, retry, and redacted logging through the connection layer;
- build Anthropic request bodies from `DirectCallRequest` and `ResolvedAgentRunnerProfile`;
- require bounded output by setting conservative max token limits from profile settings or direct-call defaults;
- parse provider responses into a structured result candidate;
- normalize token usage into `{ input, output, cache_read, cache_write }` when available;
- expose unsupported optional inference settings in `degradedCapabilities`;
- fail with safe provider errors for missing content, invalid JSON/structured result, non-transient provider error, or required unsupported setting.
Tests should inject a fetch implementation rather than using live Anthropic endpoints.
### OpenAI agent adapter implementation

Implement the OpenAI adapter against the existing `AgentProviderAdapter` contract.
Recommended behavior:
- create `packages/openai-agent-adapter` with a public `createOpenAIAgentAdapter(options?)` factory;
- define an injectable SDK launch/session seam so tests do not require live OpenAI credentials;
- obtain provider access through `connection.createFetchTransport()` if the SDK exposes a compatible transport/fetch hook;
- bridge `ProviderFetchTransport.fetch(request)` to any SDK-required `fetch(url, init)` signature without bypassing connection-layer header/body alteration or redaction;
- construct or receive an OpenAI client/model per launch/session and pass it into that session or `Runner`; never configure the OpenAI SDK through `setDefaultOpenAIClient` or any process-wide default;
- if the selected OpenAI SDK does not expose a compatible transport hook, fail real OpenAI sessions before provider access with a typed sanitized capability/connection error and treat the missing production transport path as an implementation blocker for feature completion; do not accept an injected harness-only OpenAI cell as the working B1 provider cell;
- read prompt, workspace, scoped variables, tool policy, and skills from `runInput.environment` only;
- materialize structured progress tools as `update_plan`, `report_progress`, and `notify` where the SDK supports tool registration;
- map native assistant, tool, progress, notification, and terminal signals to canonical `RunnerEvent` values;
- emit exactly one raw `runner_terminal_result` and no events after terminal;
- expose token usage, outcome, launch mechanism, and degraded capabilities through `AgentProviderSession.metadata`;
- keep raw provider event shapes and SDK-specific option names inside the package.
The adapter must import only public APIs from `@autocatalyst/execution`. It must not import `@autocatalyst/execution/src/*` or execution internals.
### Dispatch and composition

Extend dispatch without replacing the existing agent path.
Possible implementation paths:
- keep `createAgentRunnerFactory` focused on agent mode and add `createDirectRunnerFactory` for direct mode; or
- introduce a top-level provider dispatch module that owns separate `agentAdapters` and `directAdapters` registries and delegates to mode-specific factories.
In either case:
- adapter keys should include provider kind and adapter id, and mode should be validated explicitly;
- duplicate adapter registration should fail with a typed configuration error while building the direct adapter registry from an iterable/list of adapter instances; implementations must not rely on a caller-provided `ReadonlyMap` because duplicate keys are already lost by then;
- a profile whose mode does not match the selected registry should fail before provider access;
- tests should prove adding OpenAI agent and Anthropic direct cells is registry data plus package factory wiring;
- `apps/control-plane/src/server.ts` should keep test injection seams so integration tests can use fake OpenAI and Anthropic backends.
For issue 28, profile resolution may stay explicit and deterministic. Do not add the model-routing table or specificity-order fallback logic.
### Result validation

The direct orchestrator should reuse the existing tolerance pipeline rather than creating a new validation path. Prefer these existing pieces:
- `createStepResultContractRegistry` and `resolveStepResultContract` for step/schema lookup when the direct call maps to a known step result;
- `validateStepResult` for candidate validation, deterministic normalization, correction, and degradation policy;
- existing correction requester seams only if the bounded direct call should be allowed to self-correct.
Direct-call result validation should return a typed failure when the schema is unknown, the candidate is malformed, correction is exhausted, or a normalizer fails. The failure reason persisted or returned to core should use safe codes, matching existing execution-entry-point sanitization.
### Integration testing plan

Add integration coverage with mocked backends and production dispatch seams:
- Register the existing Claude adapter with a fake Claude harness.
- Register the new OpenAI adapter with a fake OpenAI harness that emits assistant, tool, progress, notification, and result events.
- Register the new Anthropic direct adapter with an injected fetch backend that returns a structured direct result.
- Configure explicit profiles for Claude agent, OpenAI agent, and Anthropic direct.
- Dispatch one step with two role contexts and assert the implementer and reviewer resolve to different agent providers.
- Assert the multi-role dispatch produces one source `RunStep`, two sequential role-scoped sessions with role-attributed events/telemetry, isolated terminal results, and one aggregate role-keyed checkpoint handed to `Orchestrator.applyDirective()`.
- Assert OpenAI runner events are consumed by the existing event consumer and available through the existing run-event/SSE path.
- Assert the Anthropic direct result is validated through the result-tolerance pipeline, returned from `DirectCallFactory.call()`, wrapped by the direct-step execution seam as `{ directive: 'advance', result: value }`, and persisted as the source `RunStep.checkpointResult` by `recordRunStepTransition()`. The integration assertion should verify `GET /v1/runs/:id/steps` (or the repository result used by that endpoint) exposes the validated checkpoint value and that no runner event was fabricated for the direct call.
- Assert captured logs and telemetry do not include known fake credential values, prompt bodies, raw provider response bodies, or transcripts.
- Assert the new adapters and direct orchestrator are reached through production factories, not only direct unit-test invocation.
Targeted unit tests should cover:
- direct adapter contract validation and direct orchestrator close/failure behavior;
- direct result validation success and failure;
- Anthropic request mapping, response parsing, token usage, and fetch error handling;
- OpenAI native event mapping, terminal protocol, progress tools, token usage, inference-setting translation, and SDK errors;
- dispatch registry lookup, mode mismatch, duplicate registration, unsupported adapter, and connection mechanism mismatch;
- redaction of known secrets in all new logging paths.
Suggested validation commands after implementation:
```bash
pnpm nx test execution
pnpm nx test core
pnpm nx test control-plane
pnpm nx test openai-agent-adapter
pnpm nx test anthropic-direct-adapter
pnpm test:boundaries
pnpm validate
```
### Risks and open edges

- **OpenAI SDK transport support:** The working OpenAI B1 cell requires a production SDK path that delegates all provider HTTP to the connection layer's fetch transport or an SDK-supported equivalent. If no such hook exists in the selected SDK version, real OpenAI calls must fail safely before provider access and the feature remains incomplete until a compatible SDK path or human-approved product narrowing is chosen.
- **Direct-call port shape:** Direct mode is not a streaming `Runner`. Forcing it into the agent runner shape could create fake events. Prefer a small direct-call port unless integration constraints require otherwise.
- **Result contract selection:** Direct calls need an explicit validation contract. Until model routing and workflow-owned direct call declarations exist, tests and composition may pass that contract explicitly.
- **Profile shape drift:** Add `mode: 'agent' | 'direct'` to `ResolvedAgentRunnerProfile` and reuse that one profile shape so issue 29 model routing can resolve profiles for both modes without intersection-type workarounds.
- **Provider event variability:** OpenAI native event shapes may differ by SDK version. Keep the native event seam injectable and version-gated, and treat unmappable required events as protocol failures.
- **Token usage availability:** Some SDK paths may not surface usage. Telemetry must mark usage unavailable rather than inventing counts.
- **Transcript sensitivity:** Never store raw provider transcripts or full direct responses as durable run results. Persist only canonical events, safe metadata, and validated result values.
- **Unsupported provider behavior:** Inference settings, structured progress tools, skill materialization, and endpoint alterations may not be fully supported by the selected SDK versions. Optional gaps degrade explicitly; required gaps fail safely.
## Task list

### Story 1: Establish direct-mode execution contracts

#### Task 1.1: Add public direct adapter types

**Description:** Create `packages/execution/src/direct-provider-adapter.ts` with the direct-mode adapter contract and supporting direct-call request, result, metadata, outcome, and protocol-error types described in this spec.
**Acceptance criteria:**
- Exports use stable public names consistent with this spec and stay available through `packages/execution/src/index.ts`.
- The contract reuses existing public execution types for profile, connection, telemetry context, token usage, model identity, and capability degradation.
- `ResolvedAgentRunnerProfile` is extended with a real `mode: 'agent' | 'direct'` field and direct contracts use that profile type directly, not an intersection-type mode workaround.
- Direct adapters return a candidate result, not a trusted validated value.
- Direct adapter return values are success-only; failures and cancellations throw typed sanitized errors and may expose only safe telemetry metadata.
- Direct protocol errors carry safe codes and safe details only.
- No provider-specific names, request bodies, or Anthropic/OpenAI assumptions appear in the provider-neutral contract.
**Dependencies:** None.
#### Task 1.2: Add direct result-validation configuration plumbing

**Description:** Wire `DirectResultValidationConfig` to the existing result-tolerance types and APIs so direct calls can validate candidates without creating a second validation path.
**Acceptance criteria:**
- `DirectResultValidationConfig` can express the schema, schema id, optional step, normalizers, correction requester, max correction attempts, and degradation policy described by the direct adapter contract in this spec.
- The implementation imports result-tolerance types through public or existing package-local APIs, not duplicated local definitions.
- Unknown schemas, malformed candidates, exhausted correction, and normalizer failures surface as typed sanitized validation failures.
- Unit tests cover a successful validation and at least one validation rejection path.
**Dependencies:** Task 1.1.
### Story 2: Implement the provider-neutral direct orchestrator

#### Task 2.1: Build `createDirectOrchestrator`

**Description:** Implement `packages/execution/src/direct-orchestrator.ts` with a direct orchestrator that validates adapter/profile/connection compatibility, calls the selected adapter exactly once, validates the candidate through result tolerance, emits telemetry, and closes adapter resources.
**Acceptance criteria:**
- `createDirectOrchestrator`, `DirectOrchestrator`, option types, result types, telemetry emitter, and logger types are exported as stable public execution APIs consistent with this spec.
- The orchestrator rejects provider kind, adapter id, mode, and connection-mechanism mismatches before provider access.
- Each `call()` invokes `adapter.call()` exactly once and never creates agent-runner events or progress tools.
- Successful calls return `{ value, validation, metadata }` where `value` comes from the existing validation pipeline.
- Completion and failure telemetry includes run, phase, step, provider, adapter, model, inference settings where available, duration, outcome, token usage availability, degraded capabilities, and safe error code when applicable.
- `close()` and failure cleanup call the adapter close hook when present.
**Dependencies:** Tasks 1.1 and 1.2.
#### Task 2.2: Cover direct orchestrator protocol and failure behavior

**Description:** Add targeted tests for direct orchestrator compatibility checks, single-call behavior, result validation, telemetry, cleanup, and sanitized failure paths.
**Acceptance criteria:**
- Tests prove mode mismatch, provider mismatch, adapter id mismatch, and connection mechanism mismatch fail before adapter invocation.
- Tests prove malformed adapter metadata, missing candidates, non-success outcome metadata, thrown typed adapter errors, and validation rejection produce safe typed failures.
- Tests prove successful calls emit start and completion telemetry and preserve safe degraded-capability metadata.
- Tests prove failure paths emit failure telemetry and call `close()` when available.
- Tests assert raw prompts, raw request bodies, credentials, raw provider responses, and transcripts are not logged by the orchestrator.
**Dependencies:** Task 2.1.
### Story 3: Add direct dispatch and composition seams

#### Task 3.1: Implement lookup-based direct call factory

**Description:** Add `packages/execution/src/direct-runner-dispatch.ts` with registry-key generation and a direct-call factory that resolves direct profiles, creates shared connections, and constructs direct orchestrators without provider branches.
**Acceptance criteria:**
- `getDirectProviderAdapterKey`, `createDirectCallFactory`, registry, profile-resolution, input, factory, and option types are exported as stable public execution APIs consistent with this spec.
- `createDirectCallFactory` accepts an iterable/list of direct adapters and builds the registry internally; `createDirectProviderAdapterRegistry` exposes the same builder for callers that need a registry object.
- Duplicate direct adapter keys fail during registry/factory setup with a typed configuration error before any map lookup can collapse the duplicate entries.
- Missing profiles, unregistered adapters, non-direct profiles, and mechanism mismatches fail before provider access.
- The factory delegates provider access to the shared connection factory and passes `AgentConnectionTelemetryContext` into the orchestrator.
- Direct dispatch has no Anthropic-specific or OpenAI-specific branches.
**Dependencies:** Task 2.1.
#### Task 3.2: Export direct-mode APIs from execution

**Description:** Update `packages/execution/src/index.ts` so adapter packages and control-plane composition can import the direct contract, orchestrator, dispatch factory, and supporting types from public execution APIs only.
**Acceptance criteria:**
- All direct-mode contracts, orchestrator APIs, dispatch APIs, and supporting types described in this spec are available from `@autocatalyst/execution`.
- Provider packages do not need to import `@autocatalyst/execution/src/*`.
- Existing agent-runner exports remain backward compatible.
- Type-only exports are marked consistently with existing project conventions.
**Dependencies:** Tasks 1.1, 2.1, and 3.1.
#### Task 3.3: Test direct dispatch registry behavior

**Description:** Add unit tests for direct adapter registry lookup, duplicate registration, profile resolution, connection creation, and mode validation.
**Acceptance criteria:**
- Tests cover successful factory invocation through a fake direct adapter and fake connection.
- Tests cover duplicate adapter keys, missing adapter, profile mode mismatch, provider mismatch, adapter id mismatch, and connection-mechanism mismatch.
- Tests prove direct-call telemetry context includes run, phase, step, provider, adapter, and no role.
- Tests prove the adapter is reached through the dispatch factory, not direct test-only construction.
**Dependencies:** Task 3.1.
#### Task 3.4: Add direct-step unit-of-work integration seam

**Description:** Update `packages/core/src/execution-run-unit-of-work.ts` and control-plane composition so the current workflow step can select direct mode, invoke `createDirectCallFactory(...).call(input)` through an injected direct-step execution port, and hand the validated direct result to the existing orchestrator checkpoint path without runner events.
**Acceptance criteria:**
- Step execution mode is selected from workflow/step execution metadata or an injected resolver result; provider kind or adapter id is never inspected in core lifecycle code.
- Agent mode continues to use the existing `ExecutionEntryPoint` → `consumeRunnerEvents()` path unchanged.
- Direct mode calls the direct-step port with run id, tenant, current phase/step, no role, provider-neutral `DirectCallRequest`, direct profile, and result-validation config.
- A successful `DirectOrchestratorCallResult.value` maps to `RunWorkResult` `{ directive: 'advance', result: value }` and to the `runWithCheckpoint()` checkpoint returned to `DefaultOrchestrator.applyDirective()`.
- Typed direct configuration, connection, protocol, cancellation, and validation errors map to sanitized failure behavior consistent with existing `ExecutionRunUnitOfWork` errors.
- Tests prove direct mode does not invoke `consumeRunnerEvents()`, does not fabricate `runner_terminal_result`, and persists the validated value through `recordRunStepTransition()`.
**Dependencies:** Tasks 3.1 and 3.2.
### Story 4: Implement the Anthropic direct adapter

#### Task 4.1: Create the Anthropic direct adapter package

**Description:** Add `packages/anthropic-direct-adapter/` with package metadata, TypeScript configuration, Nx project configuration, public entry point, and constants/factory exports for `@autocatalyst/anthropic-direct-adapter`.
**Acceptance criteria:**
- The package exposes `createAnthropicDirectAdapter`, `anthropicProviderKind`, `anthropicDirectAdapterId`, `AnthropicDirectAdapterOptions`, and `AnthropicDirectAdapterLogger`.
- Project tags are `type:lib`, `scope:adapter`, and `plane:execution`.
- The package imports direct-mode APIs only from `@autocatalyst/execution`.
- Workspace, lint, build, and test configuration follows the existing adapter package conventions.
**Dependencies:** Task 3.2.
#### Task 4.2: Implement Anthropic bounded-call request mapping

**Description:** Implement `packages/anthropic-direct-adapter/src/anthropic-direct-adapter.ts` so it creates Anthropic Messages-style bounded requests through the shared fetch transport.
**Acceptance criteria:**
- The adapter implements `DirectProviderAdapter` and declares the fetch-transport connection mechanism.
- Provider access goes through `connection.createFetchTransport()` or the equivalent public connection-layer method.
- If an Anthropic SDK client is used, the adapter bridges the connection transport to the SDK's `fetch(url, init)` option by forwarding `url`, `method`, `headers`, `body`, and `signal` into `transport.fetch({ ... })`; it must not pass raw fetches around the connection layer.
- The adapter does not read credentials from environment variables and does not apply auth headers, base URLs, retries, timeouts, or redacted logging outside the connection layer.
- Request construction maps profile model, inference settings, bounded output limits, and direct-call input into the provider request body inside the adapter.
- Unsupported optional inference settings return degradation metadata, while unsupported required settings fail with a typed sanitized error.
**Dependencies:** Task 4.1.
#### Task 4.3: Implement Anthropic response parsing and metadata mapping

**Description:** Parse Anthropic direct responses into structured result candidates and shared metadata without persisting raw provider responses.
**Acceptance criteria:**
- The adapter extracts exactly one bounded structured result candidate for orchestrator validation.
- Token usage maps to the shared usage shape when available and marks usage unavailable when absent.
- Missing content, invalid JSON or structured content, malformed usage, and non-transient provider errors produce sanitized provider/protocol errors.
- The returned metadata includes outcome, token usage, degraded capabilities, model when available, and bounded-call purpose.
- Raw response bodies, prompts, request bodies, credentials, and transcripts do not appear in errors, logs, or durable results.
**Dependencies:** Task 4.2.
#### Task 4.4: Test Anthropic direct adapter behavior

**Description:** Add tests with injected fetch backends for request construction, response parsing, result extraction, token usage, capability degradation, and error handling.
**Acceptance criteria:**
- Tests do not require live Anthropic credentials or network access.
- Tests prove the adapter uses the shared fetch transport and does not perform independent credential/header handling.
- Tests cover successful structured-result extraction and token usage normalization.
- Tests cover unsupported optional settings, unsupported required settings, malformed responses, missing structured candidates, fetch failures, and provider error responses.
- Tests assert known fake secrets, prompt bodies, raw request bodies, and raw responses are absent from logs and thrown errors.
**Dependencies:** Tasks 4.2 and 4.3.
### Story 5: Implement the OpenAI Agents SDK adapter

#### Task 5.1: Create the OpenAI agent adapter package

**Description:** Add `packages/openai-agent-adapter/` with package metadata, TypeScript configuration, Nx project configuration, public entry point, and constants/factory exports for `@autocatalyst/openai-agent-adapter`.
**Acceptance criteria:**
- The package exposes `createOpenAIAgentAdapter`, `openaiProviderKind`, `openaiAgentAdapterId`, `OpenAIAgentAdapterOptions`, `OpenAIAgentAdapterLogger`, `OpenAISessionLaunch`, `OpenAISessionLaunchOptions`, and `OpenAINativeEvent`.
- Project tags are `type:lib`, `scope:adapter`, and `plane:execution`.
- The package imports only public APIs from `@autocatalyst/execution`.
- Tests can inject an OpenAI session launcher so no live credentials or network access are required.
**Dependencies:** None.
#### Task 5.2: Implement OpenAI session launch and environment mapping

**Description:** Implement the OpenAI adapter factory and session-launch seam so the adapter materializes agent-mode input for the OpenAI Agents SDK or injected harness.
**Acceptance criteria:**
- The adapter implements the existing `AgentProviderAdapter` contract.
- The adapter maps prompt, task context, workspace roots, scratch roots, scoped environment variables, tool policy, requested skills/plugins, model, and inference settings from `RunnerRunInput` and the resolved profile.
- Provider access uses `connection.createFetchTransport()` when the selected SDK path supports it.
- The production launch path binds the connection transport to a per-session or per-agent OpenAI client/model passed into the session or `Runner`, using a `fetch(url, init)` bridge when required by the SDK. It must not call `setDefaultOpenAIClient`, set a global default client, or rely on any process-wide SDK configuration.
- If the SDK cannot use the shared fetch transport or an equivalent SDK-supported hook that delegates all provider HTTP requests to it, the production adapter fails real calls before provider access with a typed sanitized capability/connection error and the feature is not complete as a working OpenAI B1 cell. The injectable test harness may still run without live provider access, but production code must not use independent credential lookup, endpoint configuration, auth injection, retries/timeouts, or request logging.
- The adapter does not shell out to an uncontrolled process and does not perform independent credential lookup or auth-header injection.
**Dependencies:** Task 5.1.
#### Task 5.3: Map OpenAI native events to canonical runner events

**Description:** Translate OpenAI native assistant, tool, progress, notification, and terminal-result events into canonical `RunnerEvent` values while preserving terminal protocol.
**Acceptance criteria:**
- Provider-native event names and raw native shapes do not cross the adapter boundary.
- Assistant turns, tool calls/results, `update_plan`, `report_progress`, `notify`, and terminal result signals map to existing runner event types.
- The adapter emits exactly one raw `runner_terminal_result`.
- Events after terminal and duplicate terminal results fail with `ProviderProtocolError` or the existing typed sanitized equivalent.
- The adapter exposes token usage, outcome, launch mechanism, and degraded capabilities through `AgentProviderSession.metadata`.
**Dependencies:** Task 5.2.
#### Task 5.4: Implement OpenAI inference-setting and capability handling

**Description:** Translate profile inference settings, including reasoning effort where supported, into OpenAI provider options and represent unsupported settings safely.
**Acceptance criteria:**
- Supported inference settings map to the OpenAI SDK/session-launch options through a provider-isolated mapping function.
- Unsupported optional settings are returned as degradation metadata and allow the session to continue.
- Unsupported required settings fail before or during setup with a typed sanitized error.
- Missing token usage reports `usageAvailable: false` rather than zero counts.
- Skill, plugin, and progress-tool support gaps are represented as optional degradation or required failure according to profile requirements.
**Dependencies:** Task 5.2.
#### Task 5.5: Test OpenAI adapter behavior

**Description:** Add tests with an injected OpenAI SDK harness for event mapping, terminal protocol, progress tools, inference settings, token usage, and sanitized errors.
**Acceptance criteria:**
- Tests do not require live OpenAI credentials or network access.
- Tests cover assistant, tool, progress, notification, terminal result, token usage, and degraded-capability events/metadata.
- Tests cover duplicate terminal events, events after terminal, unmappable required native events, SDK errors, unsupported required settings, and unsupported optional settings.
- Tests prove no raw transcripts, prompts, credentials, full launch environment, or raw native event payloads are persisted as step results or logged.
- Tests prove the adapter can be driven by the existing agent orchestrator contract.
**Dependencies:** Tasks 5.3 and 5.4.
### Story 6: Compose new cells in control-plane dispatch

#### Task 6.1: Register OpenAI agent and Anthropic direct adapters

**Description:** Update real runner composition in `apps/control-plane/src/server.ts` so OpenAI agent and Anthropic direct adapters register through existing/testable dispatch seams when real dispatch is enabled.
**Acceptance criteria:**
- OpenAI agent registration uses the existing agent dispatch lookup and does not change agent orchestrator provider-neutral behavior.
- Anthropic direct registration uses the direct-call factory and direct adapter registry.
- Test injection seams remain available for fake OpenAI and Anthropic backends.
- Missing package configuration or unregistered adapters fail with typed sanitized configuration errors.
- No provider-specific branches are added to shared orchestrators or core run lifecycle code.
**Dependencies:** Tasks 3.1, 4.4, and 5.5.
#### Task 6.2: Prove role-distinct agent dispatch in one step

**Description:** Add integration coverage that dispatches two role contexts in one step, such as `implementer` on Claude and `reviewer` on OpenAI, using production registry and dispatch seams with fake provider harnesses.
**Acceptance criteria:**
- The test registers the existing Claude agent adapter and new OpenAI agent adapter through the same agent registry mechanism.
- Explicit profiles resolve `implementer` to Claude and `reviewer` to OpenAI without implementing model-routing tables or specificity fallback.
- Both sessions are driven through the agent orchestrator contract.
- The sessions run sequentially in deterministic role order for one source `RunStep`; they do not create separate workflow steps.
- The OpenAI event stream flows through `consumeRunnerEvents` and the existing run-event/SSE contract like the Claude cell.
- The test asserts provider, adapter, mode, step, and role telemetry for both sessions.
- The test asserts each role terminal result remains isolated and the source step checkpoint is one aggregate role-keyed JSON value.
**Dependencies:** Task 6.1.
#### Task 6.3: Prove Anthropic direct dispatch and validated result handoff

**Description:** Add integration coverage for an Anthropic direct bounded call through production direct dispatch/composition seams and the result-tolerance pipeline.
**Acceptance criteria:**
- The test registers the Anthropic direct adapter with an injected fetch backend.
- An explicit direct profile resolves to Anthropic direct mode through the direct-call factory.
- The direct orchestrator validates the adapter candidate through result tolerance before returning it.
- The direct-step execution seam invokes `createDirectCallFactory(...).call(input)`, wraps the successful `DirectOrchestratorCallResult.value` as `{ directive: 'advance', result: value }`, and hands it to the existing orchestrator path so `recordRunStepTransition()` persists the value as the source `RunStep.checkpointResult`.
- The test asserts the persisted checkpoint value through the `GET /v1/runs/:id/steps` response or the repository result that backs it, and also asserts direct mode did not emit fabricated `runner_terminal_result` or other runner events.
- The test asserts direct telemetry includes bounded-call purpose, provider, adapter, model, outcome, duration, token usage availability, and no role.
**Dependencies:** Task 6.1.
#### Task 6.4: Add redaction integration assertions

**Description:** Extend integration tests to capture logs and telemetry for all three working cells and assert sensitive data is not exposed.
**Acceptance criteria:**
- Tests use known fake credential values, prompt bodies, request bodies, raw provider responses, and transcript-like native events.
- Captured logs, telemetry, thrown errors, persisted events, and step results do not contain those raw sensitive values.
- Safe metadata still includes provider kind, adapter id, model, mode, step, role where applicable, outcome, duration, usage availability, and sanitized error codes.
**Dependencies:** Tasks 6.2 and 6.3.
### Story 7: Update package boundaries and agent navigation docs

#### Task 7.1: Enforce package boundary rules for new adapter packages

**Description:** Update workspace, Nx, TypeScript, and lint/boundary configuration so the new OpenAI and Anthropic packages build and obey adapter-package boundaries.
**Acceptance criteria:**
- `openai-agent-adapter` and `anthropic-direct-adapter` appear in workspace and Nx project discovery.
- Boundary checks allow adapter packages to depend on public execution APIs and forbid imports from execution internals.
- Existing packages continue to pass boundary checks.
- Package names, import paths, and tags match this spec.
**Dependencies:** Tasks 4.1 and 5.1.
#### Task 7.2: Update `context-agent/wiki/code-map.md`

**Description:** Record the new direct orchestrator, direct dispatch, OpenAI adapter package, Anthropic direct adapter package, and control-plane composition changes in the agent code map.
**Acceptance criteria:**
- The code map points future agents to the direct-mode execution files and both new adapter packages.
- The code map notes that direct mode is a bounded-call port, not a streaming `Runner`.
- The code map notes that provider packages must import public execution APIs only.
- The update is committed with the implementation changes that introduce the modules.
**Dependencies:** Tasks 3.2, 4.4, 5.5, and 6.1.
### Story 8: Run validation and close implementation gaps

#### Task 8.1: Run targeted package tests

**Description:** Run targeted tests for execution, core, control-plane, OpenAI adapter, and Anthropic direct adapter after implementation.
**Acceptance criteria:**
- `pnpm nx test execution` passes.
- `pnpm nx test core` passes.
- `pnpm nx test control-plane` passes.
- `pnpm nx test openai-agent-adapter` passes.
- `pnpm nx test anthropic-direct-adapter` passes.
- Any skipped command is documented with the exact reason and risk.
**Dependencies:** Stories 1 through 7.
#### Task 8.2: Run boundary and full validation checks

**Description:** Run package boundary validation and the repository’s broad validation command to catch integration, lint, type, and generated-project issues.
**Acceptance criteria:**
- `pnpm test:boundaries` passes.
- `pnpm validate` passes.
- Failures are fixed or documented as known blockers with owner, command output summary, and affected tasks.
- No live OpenAI or Anthropic credentials are required for the validation suite.
**Dependencies:** Task 8.1.