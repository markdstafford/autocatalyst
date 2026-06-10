---
created: 2026-06-10
last_updated: 2026-06-10
status: implementing
issue: 28
specced_by: autocatalyst
---
# Feature: Direct orchestrator, Anthropic direct adapter, and OpenAI direct adapter

## Product requirements

### What

Add the next three runner capabilities behind Autocatalyst's existing runner architecture:
1. a provider-neutral direct-mode orchestrator;
2. an Anthropic direct adapter for bounded, non-agentic calls;
3. an OpenAI direct adapter for bounded, non-agentic calls.
The runner layer should then cover three B1 cells: the existing Claude agent cell from issue 27, and two direct cells over two providers. Both direct cells must make one bounded model call through a direct orchestrator that is written once and parameterized by a provider adapter.
The feature must prove that the Claude agent cell plus the two direct cells each dispatch through their production seams, and that a direct bounded call, such as intent classification, returns a validated result through the same result-tolerance pipeline used elsewhere.
### Why

Autocatalyst's runner architecture is intentionally symmetric: one connection layer, one orchestrator per mode, and one provider adapter per provider/mode cell. Issue 27 established the shared connection layer, request-alteration boundary, agent orchestrator, adapter contract, dispatch lookup, and first Claude agent adapter. The platform now needs the remaining near-term cells to show the structure is real rather than Claude-specific.
Adding the direct orchestrator with Anthropic direct and OpenAI direct adapters proves bounded calls use the same connection, telemetry, result-validation, and dispatch principles while staying separate from tool-using sessions, and that the direct orchestrator is written once and parameterized by a provider adapter rather than branching per provider. Together with the existing Claude agent cell, these cells make later model routing credible because both modes share one dispatch and validation structure across providers.
### Goals

- Implement a direct-mode orchestrator once, parameterized by a direct provider adapter, for bounded one-shot model calls.
- Implement an Anthropic direct adapter that uses the shared connection layer and direct orchestrator to make a bounded call and extract a structured result.
- Implement an OpenAI direct adapter that uses the shared connection layer and direct orchestrator to make a bounded call and extract a structured result.
- Keep all provider access behind the issue 27 connection layer and ADR-023 request-alteration boundary.
- Keep provider-specific behavior inside provider adapters, not in orchestrators, core run lifecycle, or control-plane dispatch.
- Select adapters by resolved profile provider and mode through lookup registration, not by provider-specific branching.
- Translate profile inference settings into provider-specific settings with explicit degradation or typed failure when unsupported.
- Validate direct-call results through the existing `result-tolerance` pipeline before returning them across the runner boundary.
- Emit uniform session telemetry for agent and direct modes with run, phase, step, role, provider, model, inference settings, duration, token usage, outcome, and bounded-call metadata where relevant.
- Prove in integration coverage that the Claude agent cell and both direct cells dispatch through their production seams and that each direct cell returns a validated result.
- Update `context-agent/wiki/code-map.md` during implementation to record the direct orchestrator, Anthropic direct adapter, OpenAI direct adapter, and any package/module additions.
### Non-goals

- Model-routing table implementation, `(step, role)` specificity resolution, and automatic profile assembly. This feature may use explicitly constructed profiles in tests and composition seams.
- The OpenAI agent cell (OpenAI Agents SDK) for tool-using sessions. The `{openai, agent}` cell is out of scope and is a separate future issue. This feature pulls forward the `{openai, direct}` cell as the fourth runner-matrix cell instead.
- Full convergence-loop implementation that assigns implementer and reviewer roles over multiple rounds.
- Durable session-grain telemetry archive and cost-accounting persistence beyond emitting the uniform metadata that later observability features consume.
- Per-route least-privilege tool policy, network-egress controls, or runner registry expansion beyond entries needed to register and compose these cells.
- UI changes for viewing runner sessions or direct-call results.
- Branch creation, worktree management, push, merge, or PR creation.
### Personas

- **Enzo (Engineer)** needs to add provider cells by implementing adapter contracts, not by changing orchestrator logic for each provider.
- **Opal (Operator)** needs Anthropic and OpenAI calls to use configured endpoints, credentials, retries, timeouts, and redacted logs consistently.
- **Phoebe (PM)** needs proof that Autocatalyst can run bounded direct calls across multiple providers through one shared dispatch and validation path before model routing is automated.
- **Dani (Designer)** is not directly affected by this backend feature, but future progress surfaces depend on direct-call results flowing through the same validated result path regardless of provider.
### User stories

- As Enzo, I can register an Anthropic direct adapter and have a direct orchestrator make a bounded call without creating a tool-using agent session.
- As Enzo, I can register an OpenAI direct adapter and have the same direct orchestrator make a bounded call through it, without modifying direct orchestration logic.
- As Enzo, I can add a future direct provider adapter by implementing a direct adapter contract and registering it, without modifying direct orchestration logic.
- As Opal, I can configure provider profiles that reach Anthropic and OpenAI through the same connection layer and redacted request-alteration boundary.
- As Opal, I can inspect safe telemetry that shows which provider, model, mode, step, and role ran without exposing credentials, prompts, full responses, or raw transcripts.
- As Phoebe, I can see an integration proof that the Claude agent cell and both direct cells dispatch through their production seams.
- As Phoebe, I can see an integration proof that a direct Anthropic call and a direct OpenAI call each return a validated bounded result.
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
#### OpenAI direct adapter

- An OpenAI direct adapter implements the direct provider-adapter contract.
- The adapter constructs a fetch-compatible request through the shared connection layer's `connection.createFetchTransport()`. It does not implement its own header rewriting, timeout, retry, auth injection, or logging.
- The adapter makes a one-shot bounded chat-completions call suitable for direct work such as intent classification.
- The adapter forces structured output through OpenAI function calling with a single synthetic function `autocatalyst_direct_result` and extracts exactly one structured candidate for direct-orchestrator validation.
- OpenAI-specific model, inference-setting, response-shape, and token-usage mapping remain inside the adapter.
- Unsupported optional inference settings produce explicit degradation metadata. Unsupported required settings fail with a typed sanitized error before or during call setup.
#### Shared connection and request alteration

- All new adapters reach providers through the issue 27 connection layer and per-endpoint request-alteration boundary.
- No new adapter performs its own credential lookup, auth-header injection, `baseUrl` application, header strip/rewrite, timeout, retry, or redacted request logging outside that shared boundary.
- Both direct adapters are fetch-capable and use `createFetchTransport()` or an equivalent public connection-layer method. Endpoint/base URL, credential injection, timeout, retry, and redacted request/response logging are enforced by the connection layer; the adapter passes the request through.
- Endpoint behavior that cannot be represented for a provider is treated as a typed capability gap, not a silent provider-specific exception.
- Captured logs and telemetry never include known credential values, auth headers, raw prompts, message bodies, full provider responses, or raw transcripts.
#### Dispatch and symmetry

- Dispatch selects the Anthropic direct adapter and OpenAI direct adapter by resolved profile provider/mode through the same lookup strategy established in issue 27.
- Adding these cells is a matter of adapter registry entries and profile resolution data, not new provider-specific branches in orchestrators.
- The two direct adapters expose the same candidate, telemetry, inference-setting degradation, token-usage, and sanitized-failure contract to the direct orchestrator.
- The direct orchestrator and agent orchestrator both use shared telemetry tags and connection semantics, while keeping their mode-specific work distinct.
#### Event stream and result handoff

- The Anthropic direct adapter returns one bounded result candidate that the direct orchestrator validates before downstream use.
- The OpenAI direct adapter returns one bounded result candidate that the direct orchestrator validates before downstream use.
- Agent terminal results continue through the existing `ExecutionRunUnitOfWork.runWithCheckpoint()` → `consumeRunnerEvents()` path and become the `checkpointResult` passed into `Orchestrator.applyDirective()` / `recordRunStepTransition()` when the directive advances.
- Direct bounded results use the concrete direct entry point `createDirectCallFactory(...).call(input)`. The control-plane direct-step execution seam must wrap a successful `DirectOrchestratorCallResult.value` as the current step's `RunWorkResult` `{ directive: 'advance', result: value }` and pass that through the same `Orchestrator.applyDirective()` / `recordRunStepTransition()` checkpoint handoff as agent terminal results. Direct mode must not fabricate runner events solely to reach this handoff.
#### Integration coverage

- An integration test exercises all three working cells against mocked provider backends: existing Claude agent, new Anthropic direct, and new OpenAI direct.
- The integration test proves the Claude agent session streams canonical events through the event consumer.
- The integration test proves the Anthropic direct call returns a validated bounded result through the direct orchestrator.
- The integration test proves the OpenAI direct call returns a validated bounded result through the direct orchestrator.
- The integration test proves every new adapter and the direct orchestrator are invoked through production dispatch/composition seams, not only isolated unit tests.
- Tests use mocked backends or injected fetch transports and must not require live OpenAI or Anthropic credentials.
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

An operator configures provider profiles for Anthropic direct work and OpenAI direct work using the same service-owned configuration model already used by the Claude path. A run should fail before provider access when the selected profile is missing, uses an unregistered adapter, lacks a required credential, has an invalid endpoint, or requests a required capability the provider cell cannot support.
When a call starts, logs and telemetry should prove that the configured profile, endpoint, model, mode, and step context were used. They should not reveal credential values, raw prompt text, message bodies, provider transcripts, or full upstream response bodies. If a gateway or endpoint requires header changes, base URL overrides, timeout, or retry behavior, the operator should see redacted evidence that the connection layer applied or rejected that capability.
Direct-call failures should be as actionable as agent-session failures. A missing credential should identify a missing credential, not a generic provider error. A provider timeout should identify timeout or retry exhaustion. A result-shape mismatch should identify result validation failure. All three cases should use safe details only.
### Developer experience

A developer should encounter four clear seams:
1. **Agent adapter contract** — already used by Claude and unchanged by this feature.
2. **Direct adapter contract** — a new contract for one-shot bounded calls, implemented by both Anthropic and OpenAI.
3. **Agent orchestrator** — already shared by agent adapters and unchanged.
4. **Direct orchestrator** — new shared mode orchestrator for direct adapters.
A direct adapter should not know how model-routing tables will later resolve a profile. The direct orchestrator should not know Anthropic or OpenAI request or response names. These separations make contract gaps visible: if a provider cannot fit without a branch in shared code, the adapter contract should change deliberately.
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
### OpenAI direct adapter design

The OpenAI direct adapter implements the direct adapter contract for one-shot bounded calls. The path is fetch-capable, because OpenAI chat-completions calls can use the connection layer's fetch transport for request alteration, timeout, retry, and redacted request/response logging.
The adapter should:
- create a provider request through `connection.createFetchTransport()`;
- apply model and inference settings according to an explicit OpenAI direct capability matrix;
- encode the bounded-call input into the provider request body inside the adapter;
- parse the provider response and extract a structured result candidate;
- normalize token usage into the shared token breakdown when available;
- return safe degradation metadata for unsupported optional settings;
- fail safely for unsupported required settings, non-transient provider errors, malformed provider responses, and missing structured result candidates.
The adapter must not read provider credentials from environment variables. Credentials come from the connection layer and remain outside adapter-visible profile data.
For OpenAI, the adapter communicates the schema to the model through OpenAI function calling: it declares a single synthetic function `autocatalyst_direct_result` and forces it with `tool_choice`. The returned `tool_call` arguments are parsed as the candidate; a single JSON-only message content is the fallback. The adapter accepts only one structured candidate, treating multiple tool calls, extra message content alongside a tool call, malformed JSON, or missing candidates as adapter protocol failures.
### Dispatch proof

This feature does not implement full model routing. It should still prove that dispatch can construct and use explicit profiles across both modes and three cells. Tests may explicitly resolve profiles such as:
- Claude agent step → Claude agent adapter;
- direct classification step → Anthropic direct adapter;
- direct classification step → OpenAI direct adapter.
The proof has this runtime shape:
- The Claude agent cell dispatches through the production agent runner factory seam and streams canonical events through the event consumer.
- Each direct cell dispatches through the production `createDirectCallFactory(...)` seam, makes one bounded call, and returns a validated result.
- All cells use the same registry and dispatch seams that production composition uses; hard-coded provider branches in orchestrators are not allowed.
This feature has only one agent cell (Claude, from issue 27); it does not demonstrate two distinct agent providers. The second agent provider and the reviewer-vs-implementer two-provider convergence demonstration are a separate future `{openai, agent}` issue.
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
Add the Anthropic direct adapter as a provider-isolated package (the `{anthropic, direct}` cell):
- `packages/anthropic-direct-adapter/`
- Import path: `@autocatalyst/anthropic-direct-adapter`
- Tags: `type:lib`, `scope:adapter`, `plane:execution`
- Public factory: `createAnthropicDirectAdapter()`
- Public constants: Anthropic provider kind and Anthropic direct adapter id
- Tests: request construction, response parsing, structured result extraction, token usage mapping, error handling, and inference-setting degradation
Add the OpenAI direct adapter as a provider-isolated package (the `{openai, direct}` cell):
- `packages/openai-direct-adapter/`
- Import path: `@autocatalyst/openai-direct-adapter`
- Tags: `type:lib`, `scope:adapter`, `plane:execution`
- Public factory: `createOpenAIDirectAdapter()`
- Public constants: OpenAI provider kind and OpenAI direct adapter id
- Tests: request construction, response parsing, structured result extraction, token usage mapping, error handling, and inference-setting degradation
Update composition modules:
- `packages/execution/src/index.ts` exports direct contracts, direct orchestrator/factory APIs, and any shared direct result types.
- `packages/core/src/execution-run-unit-of-work.ts` adds mode selection between the existing agent `ExecutionEntryPoint` path and an injected direct-step execution port, while preserving `RunWorkInput` as the lifecycle input and `runWithCheckpoint()` as the checkpoint source.
- `apps/control-plane/src/server.ts` registers Anthropic direct and OpenAI direct adapters when real dispatch is enabled or when tests inject them.
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
- A thrown error may carry safe metadata for telemetry, such as provider kind, adapter id, model, duration, token usage availability, degraded capabilities observed before failure, upstream status code class, and safe error code. It must not carry raw prompts, raw request bodies, credentials, full provider responses, or transcripts.
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
### OpenAI direct adapter implementation

The shipped OpenAI direct adapter lives in `packages/openai-direct-adapter` and implements the direct contract.
Behavior:
- expose a public `createOpenAIDirectAdapter(options?)` factory and the constants `openaiProviderKind = 'openai'` and `openaiDirectAdapterId = 'openai-direct'`;
- declare `supportedConnectionMechanism = 'fetch_transport'`;
- call `connection.createFetchTransport()` and POST to `/v1/chat/completions` through that transport, so the connection layer owns base URL, auth header, timeout, retry, and redacted logging;
- build the chat-completions request body from `DirectCallRequest` and `ResolvedAgentRunnerProfile`, forcing structured output with a single synthetic function `autocatalyst_direct_result` via `tool_choice`;
- pass the request body as a single JSON string; the connection layer passes string bodies through unchanged and only stringifies non-string values;
- require bounded output by setting conservative `max_tokens` from profile settings or a direct-call default;
- extract exactly one structured candidate from the `tool_call` arguments, with a single JSON-only message content as the fallback;
- map token usage with `prompt_tokens → input` and `completion_tokens → output`, marking usage unavailable when absent;
- expose unsupported optional inference settings in `degradedCapabilities`;
- fail with safe provider/protocol errors for missing content, invalid JSON/structured result, multiple candidates, non-transient provider error, or required unsupported setting.
Tests inject a fetch transport rather than using live OpenAI endpoints. The adapter imports only public APIs from `@autocatalyst/execution`; it must not import `@autocatalyst/execution/src/*` or execution internals.
### Dispatch and composition

Extend dispatch without replacing the existing agent path.
Possible implementation paths:
- keep `createAgentRunnerFactory` focused on agent mode and add `createDirectRunnerFactory` for direct mode; or
- introduce a top-level provider dispatch module that owns separate `agentAdapters` and `directAdapters` registries and delegates to mode-specific factories.
In either case:
- adapter keys should include provider kind and adapter id, and mode should be validated explicitly;
- duplicate adapter registration should fail with a typed configuration error while building the direct adapter registry from an iterable/list of adapter instances; implementations must not rely on a caller-provided `ReadonlyMap` because duplicate keys are already lost by then;
- a profile whose mode does not match the selected registry should fail before provider access;
- tests should prove adding the Anthropic direct and OpenAI direct cells is registry data plus package factory wiring;
- `apps/control-plane/src/server.ts` should keep test injection seams so integration tests can use fake Anthropic and OpenAI backends.
For issue 28, profile resolution may stay explicit and deterministic. Do not add the model-routing table or specificity-order fallback logic.
### Result validation

The direct orchestrator should reuse the existing tolerance pipeline rather than creating a new validation path. Prefer these existing pieces:
- `createStepResultContractRegistry` and `resolveStepResultContract` for step/schema lookup when the direct call maps to a known step result;
- `validateStepResult` for candidate validation, deterministic normalization, correction, and degradation policy;
- existing correction requester seams only if the bounded direct call should be allowed to self-correct.
Direct-call result validation should return a typed failure when the schema is unknown, the candidate is malformed, correction is exhausted, or a normalizer fails. The failure reason persisted or returned to core should use safe codes, matching existing execution-entry-point sanitization.
### Integration testing plan

Add integration coverage with mocked backends and production dispatch seams:
- Register the existing Claude adapter with a fake Claude harness and assert it dispatches through the production agent runner factory seam.
- Register the new Anthropic direct adapter with an injected fetch backend that returns a structured direct result.
- Register the new OpenAI direct adapter with an injected fetch backend that returns a structured direct result.
- Configure explicit profiles for Claude agent, Anthropic direct, and OpenAI direct.
- Assert Claude agent runner events are consumed by the existing event consumer and available through the existing run-event/SSE path.
- Assert each direct result is validated through the result-tolerance pipeline, returned from `createDirectCallFactory(...).call()`, wrapped by the direct-step execution seam as `{ directive: 'advance', result: value }`, and persisted as the source `RunStep.checkpointResult` by `recordRunStepTransition()`. The integration assertion should verify the validated checkpoint value is exposed and that no runner event was fabricated for the direct call.
- Assert captured logs and telemetry do not include known fake credential values, prompt bodies, raw provider response bodies, or transcripts, for both direct cells.
- Assert the new adapters and direct orchestrator are reached through production factories, not only direct unit-test invocation.
Targeted unit tests should cover:
- direct adapter contract validation and direct orchestrator close/failure behavior;
- direct result validation success and failure;
- Anthropic request mapping, response parsing, token usage, and fetch error handling;
- OpenAI request mapping, response parsing, token usage, and fetch error handling;
- dispatch registry lookup, mode mismatch, duplicate registration, unsupported adapter, and connection mechanism mismatch;
- redaction of known secrets in all new logging paths.
Suggested validation commands after implementation:
```bash
pnpm nx test execution
pnpm nx test core
pnpm nx test control-plane
pnpm nx test anthropic-direct-adapter
pnpm nx test openai-direct-adapter
pnpm test:boundaries
pnpm validate
```
### Risks and open edges

- **Direct-call port shape:** Direct mode is not a streaming `Runner`. Forcing it into the agent runner shape could create fake events. Prefer a small direct-call port unless integration constraints require otherwise.
- **Result contract selection:** Direct calls need an explicit validation contract. Until model routing and workflow-owned direct call declarations exist, tests and composition may pass that contract explicitly.
- **Profile shape drift:** Add `mode: 'agent' | 'direct'` to `ResolvedAgentRunnerProfile` and reuse that one profile shape so issue 29 model routing can resolve profiles for both modes without intersection-type workarounds.
- **Structured-output reliability:** A direct call depends on the model returning exactly one structured candidate. Force the synthetic-function/tool path where supported and treat extra prose, multiple candidates, or malformed JSON as protocol failures rather than guessing.
- **Token usage availability:** Some provider responses may not include usage. Telemetry must mark usage unavailable rather than inventing counts.
- **Transcript sensitivity:** Never store raw provider responses or prompts as durable run results. Persist only safe metadata and validated result values.
- **Unsupported provider behavior:** Inference settings may not be fully supported by every provider. Optional gaps degrade explicitly; required gaps fail safely.
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
### Story 5: Implement the OpenAI direct adapter

#### Task 5.1: Create the OpenAI direct adapter package

**Description:** Add `packages/openai-direct-adapter/` with package metadata, TypeScript configuration, Nx project configuration, public entry point, and constants/factory exports for `@autocatalyst/openai-direct-adapter`.
**Acceptance criteria:**
- The package exposes `createOpenAIDirectAdapter`, `openaiProviderKind`, `openaiDirectAdapterId`, `OpenAIDirectAdapterOptions`, and `OpenAIDirectAdapterLogger`.
- Project tags are `type:lib`, `scope:adapter`, and `plane:execution`.
- The package imports direct-mode APIs only from `@autocatalyst/execution`.
- Workspace, lint, build, and test configuration follows the existing adapter package conventions.
**Dependencies:** Task 3.2.
#### Task 5.2: Implement OpenAI bounded-call request mapping

**Description:** Implement `packages/openai-direct-adapter/src/openai-direct-adapter.ts` so it creates OpenAI chat-completions bounded requests through the shared fetch transport.
**Acceptance criteria:**
- The adapter implements `DirectProviderAdapter` and declares the fetch-transport connection mechanism.
- Provider access goes through `connection.createFetchTransport()`, POSTing to `/v1/chat/completions`; the request body is passed as a single JSON string that the connection layer forwards unchanged.
- The adapter does not read credentials from environment variables and does not apply auth headers, base URLs, retries, timeouts, or redacted logging outside the connection layer.
- Request construction maps profile model, inference settings, bounded output limits, and direct-call input into the provider request body inside the adapter, forcing structured output with a single synthetic function `autocatalyst_direct_result` via `tool_choice`.
- Unsupported optional inference settings return degradation metadata, while unsupported required settings fail with a typed sanitized error.
**Dependencies:** Task 5.1.
#### Task 5.3: Implement OpenAI response parsing and metadata mapping

**Description:** Parse OpenAI direct responses into structured result candidates and shared metadata without persisting raw provider responses.
**Acceptance criteria:**
- The adapter extracts exactly one bounded structured result candidate from the `tool_call` arguments, with a single JSON-only message content as the fallback.
- Token usage maps to the shared usage shape (`prompt_tokens → input`, `completion_tokens → output`) when available and marks usage unavailable when absent.
- Missing content, invalid JSON or structured content, multiple candidates, and non-transient provider errors produce sanitized provider/protocol errors.
- The returned metadata includes outcome, token usage, degraded capabilities, model when available, and bounded-call purpose.
- Raw response bodies, prompts, request bodies, credentials, and transcripts do not appear in errors, logs, or durable results.
**Dependencies:** Task 5.2.
#### Task 5.4: Test OpenAI direct adapter behavior

**Description:** Add tests with injected fetch backends for request construction, response parsing, result extraction, token usage, capability degradation, and error handling.
**Acceptance criteria:**
- Tests do not require live OpenAI credentials or network access.
- Tests prove the adapter uses the shared fetch transport and does not perform independent credential/header handling.
- Tests cover successful structured-result extraction and token usage normalization.
- Tests cover unsupported optional settings, unsupported required settings, malformed responses, missing or multiple structured candidates, fetch failures, and provider error responses.
- Tests assert known fake secrets, prompt bodies, raw request bodies, and raw responses are absent from logs and thrown errors.
**Dependencies:** Tasks 5.2 and 5.3.
### Story 6: Compose new cells in control-plane dispatch

#### Task 6.1: Register Anthropic direct and OpenAI direct adapters

**Description:** Update real runner composition in `apps/control-plane/src/server.ts` so Anthropic direct and OpenAI direct adapters register through existing/testable dispatch seams when real dispatch is enabled.
**Acceptance criteria:**
- Anthropic direct and OpenAI direct registration use the direct-call factory and direct adapter registry, keyed by provider kind and adapter id.
- The existing Claude agent registration is unchanged.
- Test injection seams remain available for fake Anthropic and OpenAI backends.
- Missing package configuration or unregistered adapters fail with typed sanitized configuration errors.
- No provider-specific branches are added to shared orchestrators or core run lifecycle code.
**Dependencies:** Tasks 3.1, 4.4, and 5.4.
#### Task 6.2: Prove Claude-agent, OpenAI-direct, and Anthropic-direct dispatch through production seams

**Description:** Add integration coverage that dispatches the Claude agent cell and both direct cells through production registry and dispatch seams with fake provider backends, matching the rewritten integration test.
**Acceptance criteria:**
- The Claude agent cell dispatches through the production agent runner factory seam and its events flow through `consumeRunnerEvents` and the existing run-event/SSE contract.
- Each direct cell dispatches through the production `createDirectCallFactory(...)` seam against an injected fetch backend.
- Explicit profiles resolve each cell to its provider/mode without implementing model-routing tables or specificity fallback.
- The test asserts provider, adapter, mode, and step telemetry for each cell.
- The test asserts the cells are reached through production factories, not direct test-only construction.
**Dependencies:** Task 6.1.
#### Task 6.3: Prove direct dispatch and validated result handoff for both direct cells

**Description:** Add integration coverage for Anthropic direct and OpenAI direct bounded calls through production direct dispatch/composition seams and the result-tolerance pipeline.
**Acceptance criteria:**
- The tests register each direct adapter with an injected fetch backend.
- An explicit direct profile resolves to each provider's direct mode through the direct-call factory.
- The direct orchestrator validates the adapter candidate through result tolerance before returning it.
- The direct-step execution seam invokes `createDirectCallFactory(...).call(input)`, wraps the successful `DirectOrchestratorCallResult.value` as `{ directive: 'advance', result: value }`, and hands it to the existing orchestrator path so `recordRunStepTransition()` persists the value as the source `RunStep.checkpointResult`.
- The test asserts the persisted checkpoint value and that direct mode did not emit fabricated `runner_terminal_result` or other runner events.
- The test asserts direct telemetry includes bounded-call purpose, provider, adapter, model, outcome, duration, token usage availability, and no role.
**Dependencies:** Task 6.1.
#### Task 6.4: Add redaction integration assertions

**Description:** Extend integration tests to capture logs and telemetry for both direct cells and assert sensitive data is not exposed.
**Acceptance criteria:**
- Tests use known fake credential values, prompt bodies, request bodies, and raw provider responses.
- Captured logs, telemetry, thrown errors, persisted events, and step results do not contain those raw sensitive values.
- Safe metadata still includes provider kind, adapter id, model, mode, step, role where applicable, outcome, duration, usage availability, and sanitized error codes.
**Dependencies:** Tasks 6.2 and 6.3.
### Story 7: Update package boundaries and agent navigation docs

#### Task 7.1: Enforce package boundary rules for new adapter packages

**Description:** Update workspace, Nx, TypeScript, and lint/boundary configuration so the new Anthropic and OpenAI packages build and obey adapter-package boundaries.
**Acceptance criteria:**
- `anthropic-direct-adapter` and `openai-direct-adapter` appear in workspace and Nx project discovery.
- Boundary checks allow adapter packages to depend on public execution APIs and forbid imports from execution internals.
- Existing packages continue to pass boundary checks.
- Package names, import paths, and tags match this spec.
**Dependencies:** Tasks 4.1 and 5.1.
#### Task 7.2: Update `context-agent/wiki/code-map.md`

**Description:** Record the new direct orchestrator, direct dispatch, Anthropic direct adapter package, OpenAI direct adapter package, and control-plane composition changes in the agent code map.
**Acceptance criteria:**
- The code map points future agents to the direct-mode execution files and both new adapter packages.
- The code map notes that direct mode is a bounded-call port, not a streaming `Runner`.
- The code map notes that provider packages must import public execution APIs only.
- The update is committed with the implementation changes that introduce the modules.
**Dependencies:** Tasks 3.2, 4.4, 5.4, and 6.1.
### Story 8: Run validation and close implementation gaps

#### Task 8.1: Run targeted package tests

**Description:** Run targeted tests for execution, core, control-plane, Anthropic direct adapter, and OpenAI direct adapter after implementation.
**Acceptance criteria:**
- `pnpm nx test execution` passes.
- `pnpm nx test core` passes.
- `pnpm nx test control-plane` passes.
- `pnpm nx test anthropic-direct-adapter` passes.
- `pnpm nx test openai-direct-adapter` passes.
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