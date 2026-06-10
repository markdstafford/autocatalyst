---
created: 2026-06-10
last_updated: 2026-06-10
status: implementing
issue: 27
specced_by: autocatalyst
---
# Feature: Runner connection layer and Claude agent adapter

## Product requirements

### What

Add the first real agent-runner path behind Autocatalyst's existing `Runner` boundary. The feature builds the shared runner connection layer, the per-endpoint request-alteration boundary from ADR-023, a provider-neutral agent-mode orchestrator, the agent provider-adapter contract, and the first provider cell: a Claude Agent SDK adapter.
A dispatched run should be able to drive a real Claude agent session through the same execution, event, result-validation, and control-plane consumer path that the stub runner currently proves. The Claude path must emit canonical `RunnerEvent` values, hand its raw terminal result event to the existing execution entry point for result-tolerance validation, close the session cleanly, and flow through the existing event consumer so clients see persisted and re-streamed events and `RunStep` stores the validated result checkpoint.
The request-alteration boundary is a connection-layer contract, not a single transport technology. This feature must support two application mechanisms behind that contract:
1. **Fetch/transport application** for SDKs that expose custom `fetch`, transport, or `baseURL` hooks. This is the path expected for later direct Anthropic Messages and OpenAI client cells.
2. **Env/process-launch application** for subprocess-based agent harnesses such as `@anthropic-ai/claude-agent-sdk`, which launches the `claude` binary and whose HTTPS calls occur outside the Node process.
### Why

The platform has the runner boundary, workspace materialization, result-tolerance pipeline, event consumer, configuration records, secret store, and provider composition seams. It still lacks a real model-backed runner that uses those seams together. Without this feature, execution remains limited to the stub path and later routing, observability, and workflow features cannot be proven against an actual agent SDK.
The runner architecture deliberately separates shared connection behavior from mode orchestration and provider-specific adaptation. Building the Claude Agent SDK adapter first proves that split with one concrete provider while keeping direct-mode calls, OpenAI adapters, model routing, durable session telemetry, and stricter hosted controls out of this slice.
### Goals

- Resolve a configured provider profile, endpoint, and credential into a Claude-capable launch/client configuration without exposing secret material outside the connection layer.
- Route provider access through the per-endpoint request-alteration boundary described by ADR-023, using the mechanism supported by the selected provider cell.
- Implement endpoint-local header rewrite/strip, `base_url` application, auth injection, timeout, bounded retry, and redacted logging for both supported mechanisms where the mechanism can faithfully apply them.
- Scope Claude Agent SDK redacted logging to redacted launch configuration plus SDK/session diagnostics, because its subprocess owns individual HTTP requests and responses.
- Provide one agent-mode orchestrator that is parameterized by a provider adapter rather than hard-coded to Claude.
- Define the provider-adapter contract for agent sessions: start the backend, map native events to canonical `RunnerEvent` values, translate inference settings with explicit degradation, read tools/skills/prompt from the materialized environment, and extract the structured terminal result.
- Implement the Claude Agent SDK adapter as the first provider-and-agent-mode cell.
- Select the adapter by resolved profile/provider through a lookup that can accept another adapter without adding branchy dispatch logic.
- Emit uniform session telemetry signals for lifecycle, counts, duration, token usage, model, inference settings, degraded capabilities, and outcome.
- Send Claude agent events through the existing `consumeRunnerEvents` path unchanged, including persisted/re-streamed runner events and validated terminal-result storage on `RunStep`.
- Prove the production dispatch path with integration coverage that verifies the Claude env/process launch configuration and event/result path.
### Non-goals

- Direct-mode orchestration or direct provider adapters.
- OpenAI agent or direct adapters.
- Full model-routing table resolution by `(step, role)` or `(step)`.
- Durable session-grain telemetry archive, cost accounting, or permanent turn-grain transcript storage.
- Per-route least-privilege tool policy, network-egress controls, or runner registry expansion beyond what this issue needs to register and compose the Claude adapter.
- Tunable per-call timeout or thinking-budget ceiling beyond the default timeout and bounded retry posture.
- Per-HTTP-request/response logging for the Claude Agent SDK subprocess path without a future local proxy or SDK-supported hook.
- UI changes for viewing runner events.
- Branch creation, worktree management, pushing, merging, or PR opening as part of this feature spec.
### Personas

- **Opal (Operator)** needs a run to use a real configured Claude backend while keeping provider credentials and launch details observable only in redacted form.
- **Enzo (Engineer)** needs one agent orchestrator and one adapter contract so adding another agent provider is a new adapter, not a rewritten runner.
- **Phoebe (PM)** needs confidence that the first real agent path works through the same run lifecycle and review surfaces as the stub path.
- **Dani (Designer)** is not a direct user of this backend feature, but future progress views depend on a real adapter emitting stable typed events and importance hints.
### User stories

- As Opal, I can configure a Claude provider profile with an endpoint and credential and dispatch a run without putting the secret in ordinary logs or run records.
- As Opal, I can use an endpoint that needs a custom `base_url`, header rewrite, timeout, or retry behavior and know those changes apply only to that endpoint through the provider cell's supported mechanism.
- As Enzo, I can add an agent provider adapter by implementing the adapter contract and registering it in the lookup, without changing the agent orchestrator.
- As Enzo, I can test the Claude adapter with a fake Claude Agent SDK launch seam and prove the production dispatch path invokes it.
- As Phoebe, I can watch the run's typed event stream and see the validated terminal result land on the run step, just as it does for the stub runner.
- As Dani, I can rely on assistant turns, tool activity, progress, notifications, and importance hints arriving in the existing client-visible event vocabulary.
### Acceptance criteria

#### Connection layer and endpoint resolution

- The execution layer exposes a shared connection layer used by agent runners and structured so direct runners can use it later.
- The connection layer resolves an explicit provider profile from service-owned configuration data for this issue. Resolution produces the public `ResolvedAgentRunnerProfile` plus a separate typed `ResolvedAgentCredentialReference` when a credential is required; the credential reference carries the secret handle to the connection factory only and is not part of the adapter-visible profile.
- Credential resolution uses the existing secret-resolution seam and never reads provider credentials from ambient environment variables.
- Missing profile, missing endpoint data, missing credential, locked secret store, or unsupported adapter selection fails before a provider session starts with a sanitized error code and no raw secret value.
- Provider identity is present in the resolved profile and adapter lookup, not scattered through the orchestrator.
- `ResolvedAgentRunnerProfile` is the explicit-construction seam for this issue and should be the same profile shape that model routing in issue #29 later resolves to, avoiding parallel profile models.
#### Request-alteration boundary

- Every provider cell applies ADR-023 responsibilities through a declared connection mechanism before provider access begins.
- Fetch-capable cells use the in-process altered transport/request path for header rewrite/strip, `base_url`, auth injection, timeout, bounded retry, and redacted request/response logging.
- The Claude Agent SDK cell uses env/process launch configuration because `@anthropic-ai/claude-agent-sdk` spawns the `claude` binary, which makes HTTPS calls outside the Node process and does not expose a supported custom `fetch`, `baseURL`, timeout, or per-request header hook.
- For the Claude Agent SDK cell, endpoint settings map to launch environment/process options as follows: `baseUrl` to `ANTHROPIC_BASE_URL`; resolved credential to `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` according to profile/adapter configuration; header rewrite to `ANTHROPIC_CUSTOM_HEADERS` when representable; timeout to `API_TIMEOUT_MS`; bounded retry to `CLAUDE_CODE_MAX_RETRIES`.
- Header rewrite/strip behavior for env/process cells is capability-limited. Rewrites that can be represented in `ANTHROPIC_CUSTOM_HEADERS` are applied; strip rules that cannot affect the subprocess SDK's own default headers are recorded as degraded capability metadata unless marked required, in which case session start fails with a typed sanitized error.
- `base_url` is applied from endpoint configuration when present; an endpoint with no `base_url` uses the provider default.
- Auth injection derives the credential value from the resolved secret and never from ordinary configuration settings or ambient process environment.
- Provider-owned launch and transport settings are authoritative. User-supplied or materialized environment values must not supply or override provider credentials, `base_url`, custom headers, timeout, retry settings, or other endpoint-owned connection values.
- Timeout and retry semantics are tied to the selected mechanism: fetch transports enforce them in the connection wrapper before session acceptance; the Claude Agent SDK path sets the SDK/CLI retry and timeout environment variables and records that retry is delegated to the subprocess.
- Non-transient provider responses and exhausted retries return typed, sanitized failures where observable; they do not leak request body, credential text, launch env values, or full upstream response bodies into persisted run results.
- Endpoints that need no alteration pass traffic or launch config through unchanged except for telemetry context and redacted logging.
#### Redacted logging

- The connection layer emits uniform structured logs with run, phase, step, role, provider, model, endpoint/profile id, mechanism, attempt or launch id where available, duration, status/outcome, and sanitized error code where available.
- Fetch-capable cells log redacted request/response/retry/failure projections because the connection wrapper owns the HTTP attempt.
- The Claude Agent SDK cell logs only redacted launch configuration, capability application/degradation, process/session lifecycle, and SDK event-stream diagnostics. It must not claim to log or redact every provider HTTP request/response body unless a future supported SDK hook or local proxy is introduced.
- Logs redact auth headers, credential values, secret handles when paired with secret material, launch environment values carrying secrets, request body secret material where available, and provider response fields likely to contain secrets where available.
- Tests assert that a known secret value does not appear in captured fetch-path logs and does not appear in Claude launch/session logs.
- Redaction preserves enough safe metadata to debug endpoint routing, launch configuration, capability degradation, and retry behavior.
#### Agent-mode orchestrator

- The agent orchestrator is written once and parameterized by an `AgentProviderAdapter`-style contract.
- The orchestrator implements the existing `Runner` contract: `run(input)` yields canonical `RunnerEvent` values and `close()` tears down active session resources.
- The orchestrator starts the session through the adapter inside `run(input)`, passes the authoritative `RunnerRunInput` containing `input.environment` to the adapter, consumes the adapter event stream, counts assistant turns and tool calls, tracks duration, records token usage when available, and emits lifecycle/telemetry signals.
- The orchestrator preserves the existing `Runner` boundary by yielding raw canonical `RunnerEvent` values, including exactly one raw `runner_terminal_result`; `createExecutionEntryPoint` remains the owner of result-tolerance validation and post-validation terminal boundary-event construction.
- `close()` runs in success, provider failure, cancellation/error paths, and after a raw terminal event is produced before execution-entry-point result validation surfaces any validation failure. Close failure handling follows the existing runner close semantics.
- Adapter or provider errors before a valid raw terminal result become sanitized execution failures compatible with the existing execution entry point and core unit-of-work behavior.
#### Provider-adapter contract

- The adapter contract has two high-level responsibilities: map run inputs to the backend session and extract structured results/events back from that session.
- The contract receives one authoritative `RunnerRunInput` and reads prompt, workspace, scoped variables, tool policy, requested skills/plugins, and allowed tools from `runInput.environment`. It must not duplicate those fields as separate `skillIntent`, `tools`, or parallel materialization types unless a documented derived projection is added later.
- The contract receives the resolved profile, connection handle, and telemetry context needed for one session.
- The contract returns an `AgentProviderSession` whose `events` stream yields canonical `RunnerEvent` values; callers do not parse provider-native event shapes outside the adapter.
- The contract exposes provider token usage, final outcome metadata, launch mechanism, and degraded capability metadata through a per-session metadata promise/accessor returned by `startSession`; those metadata are not encoded as synthetic `RunnerEvent` values unless the canonical event contract is expanded by a later feature.
- The contract makes unsupported backend capabilities explicit, with typed degradation or typed failure rather than silent omission.
- The contract is exported from the execution package's public entry point so adapter packages can implement it without importing execution internals.
#### Claude Agent SDK adapter

- The Claude adapter imports `@anthropic-ai/claude-agent-sdk` as a library and uses it to launch and drive the subprocess-managed `claude` agent session.
- The adapter does not attempt to install an in-process custom `fetch` transport into the Claude Agent SDK. It obtains a redacted process launch configuration from the connection layer and passes the configured environment/process settings to the SDK launch seam.
- The adapter maps the materialized workspace, prompt, scoped environment variables, broad non-interactive workspace tool posture, and requested skills/plugins from `MaterializedExecutionEnvironment` into the SDK's supported session configuration.
- The adapter translates profile inference settings into Claude Agent SDK-compatible settings according to an explicit capability matrix. Model selection maps only where the SDK exposes it. Temperature, top-p, max output tokens, adaptive thinking, and reasoning effort map only when the selected SDK version exposes a documented option; otherwise they produce explicit degradation metadata unless a setting is marked required.
- Native SDK assistant turns, tool calls/results, progress-tool calls, and terminal/result signals map to canonical `RunnerEvent` values; native token usage maps to `AgentProviderSession.metadata` when the SDK exposes it.
- The adapter exposes structured progress tools equivalent to `update_plan`, `report_progress`, and `notify`; valid calls become typed progress or notification events with importance hints when present.
- If the SDK cannot natively support a requested skill, plugin, tool posture, inference setting, or progress tool shape, the adapter documents and tests the degradation path. Unsupported capability must not crash the run unless the capability is required for the step result.
- Provider-specific code remains inside the Claude adapter package/module and does not leak into core orchestration, run lifecycle, or generic execution modules.
#### Dispatch and composition

- Production dispatch can select the Claude agent adapter by the resolved profile's provider/adapter key.
- With one provider cell, dispatch is still a lookup table or map, not an `if provider === "claude"` branch in the agent orchestrator.
- The profile is built explicitly from configuration record data plus endpoint and credential data for this issue. Full routing-table resolution is deferred to issue #29.
- The existing stub runner remains available for tests and development paths that intentionally choose it.
- The real Claude adapter path is reachable from the control-plane composition root and is invoked by the integration test through the same dispatch path used by normal runs.
#### Event stream, result handoff, and `RunStep` checkpoint

- Events emitted by the Claude path pass through the existing runner event consumer without a Claude-specific consumer.
- The consumer persists and re-streams assistant turns, tool activity, progress, notifications, checkpoints, and terminal events over `GET /v1/runs/:id/events` using the existing client-visible event contract.
- The validated terminal result is recorded on the run's current `RunStep` using the existing step-result checkpoint behavior.
- Raw provider-native events, raw terminal candidates, request bodies, launch secrets, and transcripts are not stored as durable step results.
- Existing runner protocol checks still reject malformed events, wrong run ids, duplicate terminals, and events after terminal.
#### Integration coverage

- An integration test dispatches a run through the production dispatch path using the Claude Agent SDK adapter and a fake/mock SDK launch seam that represents the subprocess agent harness.
- The test asserts that configured `baseUrl`, auth credential, representable custom headers, timeout, and retry values are applied at the env/process launch layer for the Claude cell.
- The test asserts that unsupported strip/header behavior is recorded as degradation metadata, or fails before session start when marked required.
- The test asserts that the known credential value does not appear in captured launch/session logs.
- The test asserts that the existing execution entry point validates the raw terminal result through the tolerance pipeline after the orchestrator yields the raw terminal event.
- The test asserts that events are persisted and re-streamed through the existing event consumer/SSE path.
- The test asserts that the validated terminal result lands on the current `RunStep`.
- The test fails if the adapter is only exercised in isolated unit tests and not through the production dispatch seam.
## Design spec

### Design scope

This is a backend execution-plane and service-composition feature. It does not add screens, visual components, or human-facing product copy. The design work is the operator and developer experience around safely reaching a real provider, observing a session, and keeping provider-specific behavior isolated.
### Operator experience

An operator configures a Claude-capable provider profile with an endpoint and a credential reference. When the run dispatches, the operator should see normal run progress over the existing event stream. If the endpoint points at an upstream gateway, the operator can configure endpoint-local request alteration without changing other endpoints.
For the Claude Agent SDK cell, the configured endpoint is applied to the agent subprocess launch environment. Operators should see redacted evidence that `ANTHROPIC_BASE_URL`, auth, custom headers, timeout, and retry settings were prepared, but they should not see raw token values or per-HTTP bodies. Failures should be actionable without exposing secrets. A missing credential should say the credential cannot be resolved. A timeout should say the provider session timed out or the SDK subprocess reported timeout after bounded retry settings. A provider protocol mismatch should say the adapter failed to map or validate the session. None of those errors should include an auth token, secret body field, raw request payload, raw launch environment, or full provider transcript.
### Developer experience

A developer should find a small set of seams:
1. A connection layer that resolves credentials and applies endpoint policy through a declared mechanism: fetch transport or env/process launch configuration.
2. An agent orchestrator that owns session lifecycle, telemetry, raw event protocol enforcement, and the `Runner` contract.
3. An agent provider-adapter contract that owns provider-specific input mapping and native-event extraction.
4. A Claude adapter that implements that contract and imports the Claude Agent SDK.
5. A dispatch lookup that binds the resolved profile to the registered adapter.
The agent orchestrator should not know Claude event names, Claude option names, subprocess environment variable names, or SDK lifecycle details. The Claude adapter should not know how SSE frames are formatted, how retained event replay works, how run transitions are persisted, or how `RunStep` rows are updated.
### Connection flow

The dispatch path resolves a profile before a session starts:
1. Core receives a run dispatch and builds the `RunWorkInput` as it does today.
2. The execution entry point materializes the run's workspace, secrets, tool policy, requested skills/plugins, scoped environment, and prompt, then passes the `MaterializedExecutionEnvironment` through `Runner.run(input)` as it does today.
3. The real runner path resolves the selected provider profile from composed configuration, not from a hard-coded provider.
4. The connection layer resolves the endpoint and credential, determines the selected adapter's connection mechanism, prepares either an altered fetch transport or a redacted process launch configuration, and attaches telemetry context.
5. The agent orchestrator receives the selected adapter and connection handle at construction time, then starts the selected adapter from `run(input)` using the authoritative `input.environment`.
For this feature, profile selection can be explicit: a test or composition option may name the configuration record or default profile to use. The routing table and role-aware selection rules belong to the later model-routing issue.
### Request-alteration flow

The request-alteration boundary applies ADR-023 responsibilities at the last shared point the provider cell supports before provider access begins.
For fetch-capable SDKs:
1. Start with the SDK/provider request as the adapter intends to send it.
2. Apply endpoint-local header strip and rewrite rules.
3. Apply `base_url` when the endpoint config supplies one.
4. Inject the auth header from the resolved credential.
5. Send the request with the default timeout.
6. Retry only bounded transient transport failures before session acceptance.
7. Emit redacted structured log records for attempts and completion/failure.
For subprocess-based SDKs such as the Claude Agent SDK:
1. Start with the provider profile and scoped materialized environment.
2. Build a subprocess launch environment by first removing provider-owned credential/configuration variables from `MaterializedExecutionEnvironment.environment.variables`, then overlaying only the provider variables owned by the connection layer.
3. Set `ANTHROPIC_BASE_URL` when `baseUrl` is configured.
4. Set either `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` from the resolved credential, based on adapter/profile configuration.
5. Encode representable header rewrites in `ANTHROPIC_CUSTOM_HEADERS`; record unsupported strip/rewrite requirements as degraded capability metadata or fail if required.
6. Set `API_TIMEOUT_MS` and `CLAUDE_CODE_MAX_RETRIES` from bounded endpoint settings.
7. Emit redacted launch configuration and session outcome logs, not per-HTTP request/response logs.
This preserves ADR-023's ownership and per-endpoint semantics without pretending that subprocess SDK traffic can be intercepted by an in-process `fetch` hook. The Claude Agent SDK subprocess path is an accepted ADR-023 capability exception for redacted request/response logging: it satisfies the request-alteration boundary through redacted launch/session diagnostics and explicit degradation metadata, but it cannot provide per-HTTP request/response projections until a future supported SDK hook or local proxy exists.
### Agent session flow

The agent orchestrator owns the session lifecycle:
1. Emit or record session-start telemetry with run, phase, step, role, model, connection mechanism, and inference settings.
2. Ask the adapter to start the backend session with the `RunnerRunInput` that contains the materialized execution environment.
3. Drain canonical events from the adapter and yield them through the existing runner stream.
4. Count assistant turns and tool calls as events pass.
5. Capture token usage, outcome, launch mechanism, and degradation metadata from the adapter session metadata when the adapter surfaces them.
6. Ensure the adapter stream yields exactly one raw canonical `runner_terminal_result` and no events after it.
7. Yield the raw terminal event expected by the existing execution entry point; the entry point buffers that event, calls `runner.close()`, runs the result-tolerance pipeline, and yields the post-validation execution boundary event consumed by core.
8. Close the adapter/session and emit completion telemetry.
The orchestrator should treat optional progress signals as helpful detail, not as run-critical output. Required terminal result validation remains strict and stays in `createExecutionEntryPoint`: downstream core logic only receives a validated terminal directive after the entry point transforms the raw runner terminal event.
### Event and result design

The canonical event stream remains the product contract. Provider-native events are temporary adapter inputs and should disappear at the adapter boundary. The Claude adapter maps them into existing event types such as assistant turn, tool activity, progress, notification, checkpoint, and terminal result.
Structured progress tools provide the cleanest path for model-authored progress. `update_plan` maps to plan progress, `report_progress` maps to task progress or intent progress, and `notify` maps to notifications with severity and importance. If the SDK emits tool-call data differently than the stub runner, the adapter normalizes that difference before yielding events.
The terminal result should not be a raw transcript parse. The adapter should either write the declared scratch-root result file and emit the existing raw `runner_terminal_result` directive, or surface a provider structured result candidate only by translating it into that existing raw terminal event schema. `createExecutionEntryPoint` then runs the tolerance pipeline, validates/corrects when configured, degrades only where allowed, and returns the safe execution-boundary handoff shape consumed by core.
### Telemetry and logging design

Telemetry is session-oriented in this feature. It should include start/completion, duration, assistant-turn count, tool-call count, token usage when available, outcome, provider, model, inference settings, connection mechanism, run id, phase, step, and role. The feature does not create the durable observability archive; it emits the metadata that archive will later consume.
Connection logs are separate from session telemetry. They describe outbound provider attempts for fetch transports and launch/session configuration for subprocess transports. They must be redacted by construction, and tests should capture logger output to prove known secret values are absent.
### Inference-settings design

Use one store/profile shape for inference settings, but require each provider cell to publish a small translation matrix. The matrix must distinguish:
- settings that map directly to the selected backend;
- settings that are ignored with explicit degradation metadata;
- settings that are required by profile policy and therefore fail session start if unsupported.
For the Claude Agent SDK cell in this issue:
- Model selection maps only if the SDK exposes a supported model option or launch environment setting.
- Adaptive thinking, reasoning effort, temperature, top-p, and max output tokens do not automatically map just because the Messages API supports them. Each maps only through a documented Agent SDK option for the selected package/version.
- Unsupported optional settings are listed in `AgentProviderSession.metadata.degradedCapabilities` with safe setting names and reasons, not raw prompts or secrets.
- Unsupported required settings fail before or at session start with a typed sanitized error.
### Failure and degradation design

The feature distinguishes these cases:
- **Configuration failure:** missing profile, unknown adapter, invalid endpoint, missing credential, or locked secret store. Fail before session start with sanitized details.
- **Connection-mechanism failure:** endpoint requirements cannot be represented by the adapter's mechanism. Optional requirements become degradation metadata; required requirements fail before session start.
- **Fetch connection failure:** timeout, retry exhaustion, transient network error, or non-transient provider error observed by a fetch transport. Return a typed failure with redacted diagnostics.
- **Process launch/session failure:** Claude Agent SDK launch failure, subprocess timeout, subprocess retry exhaustion as surfaced by the SDK, or unsupported env configuration. Return a typed failure with redacted diagnostics.
- **Provider protocol failure:** the adapter cannot map a required native event or receives an impossible session sequence. Fail through `RunnerProtocolError` or an adapter-specific sanitized error that the execution entry point can map safely.
- **Result validation failure:** use the existing result-tolerance behavior and sanitized failure terminal.
- **Optional capability degradation:** unsupported non-required skill materialization, unsupported inference setting, unsupported header strip, or malformed optional progress signal should reduce stream detail and emit safe metadata, not fail the run.
## Tech spec

### Current state

- `packages/execution/src/runner.ts` defines the `Runner` contract used across the control/execution boundary.
- `packages/execution/src/execution-entry-point.ts` materializes execution, drains raw runner events, validates terminal handoffs through the result-validation configuration, and calls `runner.close()` in a `finally` block.
- `packages/execution/src/result-tolerance.ts`, `result-contracts.ts`, `result-correction.ts`, and `result-file.ts` implement the ADR-012 result pipeline.
- `packages/execution/src/materialized-environment.ts` already carries the authoritative workspace, prompt context, scoped environment variables, `secretVariableNames`, tool policy, and requested skills/plugins for one run.
- `packages/execution/src/stub-runner.ts` is the only current runner implementation and emits deterministic typed events without network or SDK calls.
- `packages/core/src/execution-run-unit-of-work.ts` wires execution into orchestration and maps validated terminal directives into `RunWorkResult`.
- `packages/core/src/runner-event-consumer.ts` and related run-event modules persist, replay, and re-stream typed runner events and record validated results on `RunStep`.
- `packages/core/src/provider-composition.ts` composes provider configuration records into provider bindings but keeps adapters typed as `unknown` today.
- `packages/api-contract/src/configuration-record.ts` has a minimal `provider_profile` settings shape with `profileName` and optional `credentialSecretHandle`.
- `packages/persistence/src/secret-store.ts` implements `resolveSecret(handle)` for credential retrieval.
- `apps/control-plane/src/server.ts` is the composition root for persistence, provider composition, event bus/store, orchestrator, and execution unit of work.
### Module ownership

Add shared execution-runner modules under `packages/execution/src/`:
- `agent-provider-adapter.ts` — public adapter contract, provider profile types consumed by the orchestrator, adapter session/event types, connection mechanism types, and sanitized adapter error types.
- `agent-orchestrator-runner.ts` — `Runner` implementation that drives one agent-mode session through an `AgentProviderAdapter`.
- `connection.ts` — provider connection factory, credential resolution, fetch transport handle, process launch configuration handle, timeout/retry policy, and redacted connection logging.
- `request-alteration.ts` — pure alteration primitives: header strip/rewrite, base URL application, auth injection, timeout/retry decision helpers, env/process mapping helpers, and redaction helpers.
- `runner-dispatch.ts` or an adjacent public factory — lookup-based creation of an agent runner from a resolved profile and registered adapter map.
Add the Claude provider cell as either a new adapter package or a provider-isolated module. Prefer a new package if the SDK dependency is non-trivial:
- `packages/claude-agent-adapter/` with tags `type:lib`, `scope:adapter`, `plane:execution`.
- Public export: a `createClaudeAgentAdapter()` factory implementing the execution package's `AgentProviderAdapter` contract.
- Package dependency: `@anthropic-ai/claude-agent-sdk`, isolated from generic `@autocatalyst/execution` modules when practical.
- SDK surface documentation must record the package name, version range, subprocess launch/configuration options, environment variables used by the adapter, and native event surface. It must explicitly state that the Agent SDK does not expose a supported custom `fetch` transport for model traffic.
Update composition modules:
- `packages/core/src/provider-composition.ts` can remain provider-neutral, but the control-plane composition root must narrow composed adapter instances to the execution adapter contract before giving them to the real runner dispatch path.
- `apps/control-plane/src/server.ts` should register the Claude adapter factory in `providerAdapters`, keep existing test injection seams, and construct the execution unit of work with either the stub runner or resolved real runner path based on explicit configuration/test options.
- `context-agent/wiki/code-map.md` must record the connection layer, request-alteration boundary, agent orchestrator, adapter contract, and Claude adapter after implementation.
### Configuration and profile shape

Extend the provider-profile settings schema additively. Existing minimal records must continue to validate.
Suggested shape inside `configurationRecordSettingsSchema`:
```typescript
{
  profileName: string;
  credentialSecretHandle?: SecretHandle;
  model?: {
    provider: string;
    model: string;
    displayName?: string;
  };
  inferenceSettings?: InferenceSettings;
  endpoint?: {
    baseUrl?: string;
    authHeaderName?: string;
    authEnvironmentVariable?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';
    requestTimeoutMs?: number;
    maxRetries?: number;
    headersToStrip?: string[];
    headersToRewrite?: Record;
    requiredAlterations?: {
      headerStrip?: boolean;
      headerRewrite?: boolean;
      inferenceSettings?: string[];
    };
  };
}
```
Rules:
- `providerKind` and `adapterId` remain the composition key.
- `settings.model.provider` should match the provider identity or be rejected by profile resolution.
- `requestTimeoutMs` and `maxRetries` are bounded by conservative defaults and maximums. Invalid values fail configuration validation before dispatch.
- Header names are validated as HTTP token-like strings. Redaction treats configured auth headers, custom header names, launch auth variables, and known sensitive names case-insensitively.
- The credential secret handle remains optional at schema level for additive compatibility, but the Claude adapter requires it unless tests inject an explicit no-auth mock profile.
- For Claude, `authEnvironmentVariable` defaults to the adapter's selected safe default and is used only to decide whether the connection layer emits `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` for the subprocess launch.
If schema expansion is too large for this issue, implementation may keep the public API shape minimal and introduce an internal `ResolvedAgentRunnerProfile` built from existing configuration plus explicit composition/test options. It must still leave a clear typed path for endpoint, model, inference settings, request alteration, and mechanism capability requirements, because this feature's tests need those fields.
### Public contracts

Expose these types from `@autocatalyst/execution` or equivalent public execution entry points:
```typescript
export type ProviderConnectionMechanism = 'fetch_transport' | 'process_environment';

export interface ResolvedAgentRunnerProfile {
  readonly providerKind: string;
  readonly adapterId: string;
  readonly profileName: string;
  readonly configurationRecordId?: string;
  readonly model: ModelIdentity;
  readonly inferenceSettings: InferenceSettings;
  readonly endpoint: RunnerEndpointConfig;
  readonly connectionMechanism: ProviderConnectionMechanism;
}

export interface ResolvedAgentCredentialReference {
  readonly required: boolean;
  readonly secretHandle?: SecretHandle;
  readonly authTarget?: 'header' | 'process_environment';
}

export interface RunnerEndpointConfig {
  readonly baseUrl?: string;
  readonly authHeaderName?: string;
  readonly authEnvironmentVariable?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  readonly requestTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly headersToStrip?: readonly string[];
  readonly headersToRewrite?: Readonly>;
  readonly requiredAlterations?: RunnerEndpointRequiredAlterations;
}

export interface AgentProviderAdapter {
  readonly providerKind: string;
  readonly adapterId: string;
  readonly supportedConnectionMechanism: ProviderConnectionMechanism;
  startSession(input: AgentProviderSessionInput): AgentProviderSession;
  close?(): Promise;
}

export interface AgentProviderSessionInput {
  readonly runInput: RunnerRunInput;
  readonly profile: ResolvedAgentRunnerProfile;
  readonly connection: AgentConnection;
  readonly telemetryContext: AgentConnectionTelemetryContext;
}

export interface AgentProviderSession {
  readonly events: AsyncIterable;
  readonly metadata: Promise;
  close?(): Promise;
}
```
The final names can differ, but the ownership should stay the same: execution exports generic contracts, adapter packages implement them, and core/app composition wires concrete instances without importing execution internals. `ResolvedAgentCredentialReference` is consumed only by profile resolution and `createAgentConnection`; adapters receive the adapter-visible profile and the resulting `AgentConnection`, not the credential reference or raw credential. Logs and telemetry may record safe booleans such as `credentialRequired`/`credentialResolved`, but must not include raw credential values and should not include secret handles unless an explicitly redacted diagnostic mode is added. `AgentProviderSessionInput` intentionally avoids separate skill/tool/prompt fields; adapters read them from `runInput.environment` so `MaterializedExecutionEnvironment` remains the single source of truth.
### Request alteration and connection implementation

Implement request alteration as a small, testable pipeline with two outputs.
Fetch output:
- Use a provider request abstraction close enough to `fetch` that SDKs with custom transport hooks can use it directly.
- Normalize header names for matching while preserving legal outbound casing where needed.
- Strip headers before rewrite, so an endpoint can remove a default SDK header and replace it with a gateway-compatible value.
- Apply `base_url` with URL parsing rather than string concatenation.
- Inject auth after rewrite/strip so auth cannot be accidentally removed by earlier rules unless the endpoint explicitly chooses a different auth header name.
- Use `AbortSignal.timeout()` or an equivalent Node 22-compatible abort path for request timeout.
- Retry only safe transient transport errors and transient HTTP status codes selected by the implementation, such as 408, 429, 500, 502, 503, and 504. Do not retry validation errors, auth failures, malformed requests, or accepted streaming sessions.
- Redact before logging. Tests should inspect the logger sink, not console output.
Process environment output:
- Start from `MaterializedExecutionEnvironment.environment.variables`, remove provider-owned credential/configuration variables, and overlay provider-owned variables without mutating the original environment.
- Provider-owned variables include, at minimum for Claude, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`, `API_TIMEOUT_MS`, and `CLAUDE_CODE_MAX_RETRIES`; user/materialized values for these names are ignored for provider launch.
- Preserve `secretVariableNames` and mark injected credential variables as secret for redaction and diagnostics.
- Map endpoint `baseUrl` to `ANTHROPIC_BASE_URL` for Claude.
- Map the resolved credential to `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` for Claude, never both unless explicitly supported and tested.
- Encode `headersToRewrite` into `ANTHROPIC_CUSTOM_HEADERS` for Claude using the SDK/CLI documented format. Redact the full value in logs.
- Treat `headersToStrip` as unsupported for Claude unless the selected SDK/CLI documents a strip capability; record degradation or fail if required.
- Map bounded timeout and retry settings to `API_TIMEOUT_MS` and `CLAUDE_CODE_MAX_RETRIES` for Claude.
- Return a redacted launch projection for logs and an unredacted launch environment only to the adapter launch seam.
`AgentConnection` should expose mechanism-specific methods rather than implying every adapter can use every path. For example, it may expose `createFetchTransport()` for fetch-capable cells and `createProcessLaunchConfig()` for subprocess cells. Calling an unsupported method for the selected mechanism must fail with a typed sanitized error.
### Agent orchestrator implementation

`createAgentOrchestratorRunner(options)` should accept:
- an `AgentProviderAdapter`;
- a `ResolvedAgentRunnerProfile`;
- an already-created connection handle or a lazy connection handle factory that does not require duplicating the materialized environment;
- a logger/telemetry emitter;
- a clock/id generator where useful for tests.
The runner should consume `RunnerRunInput.environment` as the authoritative materialized environment when `run(input)` is called, pass the `RunnerRunInput` into `adapter.startSession(...)`, and yield only valid raw `RunnerEvent` values. It should validate adapter-emitted events against the shared runner-event schema before yielding or rely on the existing entry-point validation plus targeted tests around adapter mapping. Prefer early validation inside the orchestrator for clearer adapter errors, while keeping the existing boundary validation as the final guard. Terminal result validation remains exclusively in `createExecutionEntryPoint`; the orchestrator must not yield a post-validation execution boundary event.
The runner should keep local counters for assistant turns and tool activity. It should collect token usage, outcome, launch mechanism, and degraded capability data from the returned `AgentProviderSession.metadata` when available. If token usage is unavailable, emit `usageAvailable: false` in telemetry and do not invent counts.
### Claude adapter implementation

The Claude adapter should be provider-specific and thin:
- Build the SDK session through `@anthropic-ai/claude-agent-sdk` using a connection-layer process launch configuration. Do not attempt to route model traffic through `AgentConnection.createFetchTransport()` for this SDK.
- Pass only the redacted-safe diagnostics to logs; pass the unredacted launch environment only to the SDK launch seam.
- Translate `ResolvedAgentRunnerProfile.inferenceSettings` into SDK options using the documented capability matrix. `reasoningEffort`, adaptive-thinking settings, temperature, top-p, and max output tokens map only when the Agent SDK exposes compatible options; otherwise record safe degradation metadata or fail if required.
- Materialize the prompt, workspace roots, scratch roots, scoped environment variables, tool policy, and requested skills/plugins from `runInput.environment`.
- Register/describe structured progress tools so SDK tool calls map to `runner_progress` and `runner_notification` events where the SDK supports custom tools.
- Convert native assistant, tool, progress, and terminal signals into canonical raw `RunnerEvent` values.
- Surface provider token usage, final outcome, launch mechanism, and unsupported optional capability degradation through `AgentProviderSession.metadata`.
- Surface final structured result candidates only by writing the expected scratch result file or by emitting the existing raw `runner_terminal_result` schema that the execution entry point already validates.
The adapter must not import from `packages/execution/src/internal/*`. If it needs a helper, promote that helper to the public execution package API or keep the helper inside the adapter package.
### Control-plane dispatch integration

The production path should stay aligned with the existing orchestrator/unit-of-work design:
1. `apps/control-plane/src/server.ts` reads configuration records and composes provider adapters during startup.
2. The execution unit of work receives a runner factory rather than a single fixed runner instance when real provider dispatch is enabled.
3. The runner factory resolves the profile for the current run. For this issue, the selection may be explicit and deterministic, such as a configured default provider-profile id.
4. The factory looks up the adapter by `(providerKind, adapterId)` and verifies the profile's `connectionMechanism` matches the adapter.
5. The factory creates an agent orchestrator runner with the adapter, profile, and connection layer; it does not materialize the environment or accept result-validation configuration.
6. The rest of the path remains unchanged: `createExecutionEntryPoint` materializes the environment, calls `runner.run({ environment, correlationId })`, validates the raw terminal result through its existing result-validation configuration, yields boundary events, core consumes them, events persist/re-stream, and the run lifecycle records the step result.
Do not introduce model-routing fallback logic in this issue. A missing explicit profile should fail fast with a typed configuration error.
### Testing plan

Targeted unit tests:
- Fetch request alteration applies base URL, header strip/rewrite, auth injection, timeout, bounded retry, and no-alteration pass-through.
- Process launch alteration maps Claude endpoint settings to `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`, `API_TIMEOUT_MS`, and `CLAUDE_CODE_MAX_RETRIES` without mutating `MaterializedExecutionEnvironment`.
- Redaction removes a known secret value from fetch request logs, response logs, retry logs, failure logs, and Claude launch/session logs.
- Profile resolution rejects missing credential, mismatched provider/model, invalid header names, unsupported adapter, unsupported required mechanism capability, and invalid timeout/retry values.
- Agent orchestrator/session cleanup runs on successful raw stream completion, adapter error, stream error, cancellation, and entry-point close.
- Agent orchestrator counts assistant turns/tool calls and reports token usage availability correctly.
- Claude adapter maps mocked native SDK events to canonical `RunnerEvent` values, including progress tools and terminal results.
- Claude adapter inference-setting tests prove supported settings map and unsupported settings produce degradation or typed failure according to required/optional policy.
Integration tests:
- A control-plane or service-level integration test registers the Claude adapter, configures a provider profile and secret, dispatches a run through the production dispatch path, and asserts the adapter is invoked.
- The fake Claude SDK launch seam verifies configured `baseUrl`, auth environment variable, custom headers, timeout, and retry behavior at the env/process launch layer.
- The test captures logs and asserts the credential value is absent.
- The run emits events that are persisted and re-streamed through `GET /v1/runs/:id/events`.
- The terminal result passes the result-tolerance pipeline and appears on the current `RunStep` checkpoint.
Suggested validation commands after implementation:
```bash
pnpm nx test execution
pnpm nx test core
pnpm nx test control-plane
pnpm nx test api-contract
pnpm nx test claude-agent-adapter
pnpm test:boundaries
pnpm validate
```
### Risks and open edges

- **Claude Agent SDK subprocess boundary:** The Claude Agent SDK does not expose a supported in-process custom `fetch`/`baseURL`/timeout/header hook for model traffic. This spec intentionally uses env/process launch configuration for that provider cell. Per-HTTP request/response logging for Claude remains unsupported unless a future SDK hook or local proxy is added.
- **Header strip weakness for subprocess cells:** `ANTHROPIC_CUSTOM_HEADERS` can represent custom headers, but it does not necessarily strip SDK default headers. Required strip behavior must fail safely if not supported; optional strip behavior must be recorded as degraded.
- **Retry semantics differ by mechanism:** Fetch cells can retry only before provider session acceptance. Claude Agent SDK retry is delegated to `CLAUDE_CODE_MAX_RETRIES`, so tests should assert launch configuration and sanitized SDK-surfaced outcomes rather than in-process attempt counts.
- **Configuration shape drift:** Existing provider-profile records are minimal. The implementation must either extend the public schema additively or keep a well-typed internal profile bridge so later model routing can reuse it.
- **Model-routing forward compatibility:** `ResolvedAgentRunnerProfile` should remain the type that issue #29's routing resolver returns. The explicit profile construction in this issue is the seam routing replaces.
- **Transcript sensitivity:** Native SDK events may contain large assistant text or tool output. Persist only canonical event fields and validated terminal results; never persist raw provider transcripts as checkpoints.
- **Unsupported provider behavior:** Skill materialization, inference settings, token usage, structured progress tools, or header operations may not be fully supported by the first SDK version. Unsupported optional behavior should degrade explicitly; unsupported required behavior should fail before dispatch or at session start with a typed sanitized error.
## Task list

### Story 1 — Extend provider-profile configuration for agent runner inputs

**Description:** Add the schema-facing provider-profile fields needed to build a resolved agent runner profile while keeping existing minimal provider-profile records valid.
**Dependencies:** None.
#### Task 1.1 — Extend provider-profile settings schema

**Description:** Add optional `model`, `inferenceSettings`, `endpoint`, and `credentialSecretHandle` fields to `packages/api-contract/src/configuration-record.ts` using the spec shapes. Keep `profileName`-only records valid.
**Acceptance criteria:**
- `provider_profile` settings accept the additive fields from the spec.
- Existing minimal provider-profile tests continue to pass.
- Endpoint settings validate header strip/rewrite arrays/maps, timeout, retry, auth-header name, Claude auth environment variable, base URL, and required alteration flags as schema-facing values.
- Exported TypeScript types include `ProviderProfileSettings`, `RunnerEndpointSettings`, and `InferenceSettings`.
#### Task 1.2 — Cover configuration compatibility and validation

**Description:** Add focused api-contract tests for minimal records, fully populated Claude-capable records, invalid endpoint field shapes, and credential handle removal behavior if existing update tests cover nullable removal.
**Acceptance criteria:**
- Tests prove old provider-profile records still parse.
- Tests prove a fully populated profile with endpoint alteration settings parses.
- Tests reject malformed endpoint settings.
- Tests cover public exports from `packages/api-contract/src/index.ts`.
### Story 2 — Build request alteration, launch mapping, and redaction primitives

**Description:** Implement pure provider alteration primitives used by all provider mechanisms before credentials or SDK-specific behavior are involved.
**Dependencies:** Story 1 for endpoint type alignment.
#### Task 2.1 — Add request alteration module

**Description:** Create `packages/execution/src/request-alteration.ts` with `ProviderRequest`, `AlteredProviderRequest`, `RequestAlterationOptions`, `RetryPolicy`, `applyRequestAlteration`, `isTransientProviderFailure`, and `validateHttpHeaderName` for fetch-capable mechanisms.
**Acceptance criteria:**
- Header matching is case-insensitive while legal outbound header casing remains usable.
- Header strip rules run before rewrite rules.
- `baseUrl` uses URL parsing and preserves request path/query correctly.
- Auth injection happens after strip/rewrite using the selected auth header name.
- Timeout and retry settings are bounded by defaults and maximums.
- Transient retry classification includes safe transport errors and selected HTTP statuses only.
#### Task 2.2 — Add process launch mapping helpers

**Description:** Add helpers that convert endpoint/profile/credential data into a provider launch environment projection for subprocess SDKs, starting with Claude Agent SDK mappings.
**Acceptance criteria:**
- User/materialized values for provider-owned variables are stripped before connection-layer values are applied.
- Claude `baseUrl` maps to `ANTHROPIC_BASE_URL`.
- The resolved credential maps to exactly one selected auth variable, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`.
- Header rewrites map to `ANTHROPIC_CUSTOM_HEADERS` when representable.
- Header strips that cannot be represented produce typed degradation metadata or typed failure when required.
- Timeout and retry map to bounded `API_TIMEOUT_MS` and `CLAUDE_CODE_MAX_RETRIES` values.
- Helpers do not mutate `MaterializedExecutionEnvironment.environment.variables` or its `secretVariableNames`.
#### Task 2.3 — Add redaction helpers

**Description:** Add `redactProviderRequestForLog`, `redactProviderResponseForLog`, and process launch/session redaction helpers to the alteration module.
**Acceptance criteria:**
- Auth headers, configured sensitive headers, known secret values, secret launch variables, and selected body fields are redacted case-insensitively.
- Secret handles are not logged next to secret material.
- Redacted projections preserve safe routing, mechanism, launch, attempt, status, duration, provider, model, endpoint/profile, degradation, and error-code metadata.
- The helpers never mutate the original request, response, or launch config objects.
#### Task 2.4 — Test alteration, launch mapping, and redaction

**Description:** Add execution unit tests covering fetch alteration order, pass-through behavior, invalid header names, invalid base URLs, retry classification, Claude launch mapping, unsupported capability degradation, and redaction.
**Acceptance criteria:**
- Tests prove strip-before-rewrite and auth-after-rewrite behavior for fetch.
- Tests prove no-alteration endpoints pass through except for safe defaults.
- Tests prove Claude process launch mapping sets the expected environment variable names and redacts their values in logs.
- Tests prove known secret values do not appear in redacted request, response, retry, failure, launch, or session log projections.
- Tests prove non-transient provider responses are not classified for retry.
### Story 3 — Implement the provider connection layer

**Description:** Resolve credentials and expose a provider connection handle that applies endpoint alteration through fetch transport or process launch configuration, with timeout/retry policy and redacted logs matched to the selected mechanism.
**Dependencies:** Story 2.
#### Task 3.1 — Add public connection factory and types

**Description:** Create `packages/execution/src/connection.ts` with `AgentConnection`, `AgentConnectionFactoryOptions`, `AgentConnectionTelemetryContext`, `ProviderCredentialResolver`, `ProviderConnectionLogger`, and `createAgentConnection`.
**Acceptance criteria:**
- `createAgentConnection` resolves credentials only through the supplied credential resolver.
- `createAgentConnection` receives the separate typed `ResolvedAgentCredentialReference`; `ResolvedAgentRunnerProfile` remains adapter-visible and does not carry the secret handle.
- Missing required credentials, locked secret-store causes, invalid endpoint values, unsupported required mechanism capability, and out-of-bounds timeout/retry settings fail before a provider session starts.
- The connection exposes mechanism-specific request paths, such as `createFetchTransport()` for fetch-capable cells and `createProcessLaunchConfig()` for subprocess cells.
- Calling a request path unsupported by the selected profile/adapter mechanism fails safely rather than bypassing ADR-023.
- The connection does not expose raw credential values except inside the returned launch/transport object passed directly to the adapter's provider launch seam.
#### Task 3.2 — Implement fetch timeout, retry, and redacted connection logging

**Description:** Wrap fetch-compatible provider requests with timeout, bounded retry, transient-failure classification, and structured request/response/failure logs.
**Acceptance criteria:**
- Each attempt emits safe structured fields for run, phase, step, role, provider, model, profile/configuration id, mechanism, attempt, duration, status/outcome, and sanitized error code.
- Retry stops after the configured bounded limit.
- Retry only applies before provider session acceptance as documented by the public retry policy.
- Exhausted retries and non-transient failures throw `ProviderConnectionError` with safe details only.
- Captured logs never include the known credential value.
#### Task 3.3 — Implement process launch config and redacted logging

**Description:** Build and log redacted process launch configuration for subprocess SDKs, starting with the Claude Agent SDK environment-variable mapping.
**Acceptance criteria:**
- The launch config strips user/materialized values for provider-owned variables, then overlays connection-layer-owned values without mutating the materialized environment.
- Redacted launch logs include variable names and safe routing metadata, not secret values.
- `ANTHROPIC_CUSTOM_HEADERS` values are redacted in full or by sensitive-value replacement.
- Timeout/retry configuration is logged as bounded numeric values.
- Unsupported optional capabilities are recorded in launch/session metadata; unsupported required capabilities fail before SDK launch.
#### Task 3.4 — Test connection failure and logging paths

**Description:** Add execution tests for successful fetch request, custom transport creation, process launch config creation, credential resolution failures, timeout, retry exhaustion, non-transient response handling, unsupported mechanism calls, and redaction.
**Acceptance criteria:**
- Tests use injected fetch, launch, and logger seams instead of real network calls or real subprocesses.
- Tests prove missing/locked/missing-secret credential cases become sanitized connection/configuration errors.
- Tests prove the known secret is absent across request, retry, response, failure, launch, and session logs.
- Tests prove adapters cannot call an unsupported connection mechanism without receiving a typed sanitized error.
### Story 4 — Define the agent provider adapter contract and errors

**Description:** Add the provider-neutral contract that adapter packages implement and the orchestrator consumes.
**Dependencies:** Story 3 for connection types.
#### Task 4.1 — Add adapter contract module

**Description:** Create `packages/execution/src/agent-provider-adapter.ts` with `ResolvedAgentRunnerProfile`, `ResolvedAgentCredentialReference`, `ModelIdentity`, `InferenceSettings`, `RunnerEndpointConfig`, `ProviderConnectionMechanism`, `AgentProviderAdapter`, `AgentProviderSession`, `AgentProviderSessionInput`, session metadata/outcome, token usage, degraded capability metadata, and sanitized provider error classes.
**Acceptance criteria:**
- `ResolvedAgentRunnerProfile` is documented as the same shape issue #29 model routing should later produce.
- `ResolvedAgentCredentialReference` is documented as connection-factory-only input that may carry the secret handle; adapters, logs, and telemetry receive only the profile, connection handle, and safe credential resolution status.
- `AgentProviderAdapter.startSession(...)` returns an `AgentProviderSession` containing `events`, a `metadata` promise/accessor, and optional per-session close support; metadata is not delivered through non-canonical runner events.
- `AgentProviderSessionInput` includes `runInput`, resolved profile, connection, and telemetry context only; adapters read prompt, tools, skills, scoped variables, and workspace data from `runInput.environment`.
- No invented `DeclaredSkillIntent` or `AgentToolMaterialization` type is required unless it is a documented derived projection in a later feature.
- Unsupported capabilities are represented by typed degradation or `UnsupportedProviderCapabilityError`.
- Error classes include safe codes/details without raw upstream request, response, transcript, launch environment, or secret text.
#### Task 4.2 — Export public execution APIs

**Description:** Update `packages/execution/src/index.ts` to export the adapter contract, connection types, alteration types, redaction helpers, logger/telemetry/test seams, and provider error classes.
**Acceptance criteria:**
- Adapter packages and composition roots can import all public types from `@autocatalyst/execution`.
- No consumer needs to import from `@autocatalyst/execution/src/*`.
- Existing public execution exports remain available.
- Boundary tests still reject execution-internal imports.
### Story 5 — Build the generic agent orchestrator runner

**Description:** Implement the provider-neutral `Runner` that starts one adapter session from `Runner.run(input)`, yields raw canonical events, records telemetry, and closes resources on every path. Terminal result validation remains in `createExecutionEntryPoint`.
**Dependencies:** Stories 3 and 4.
#### Task 5.1 — Add agent orchestrator runner

**Description:** Create `packages/execution/src/agent-orchestrator-runner.ts` with `createAgentOrchestratorRunner`, option types, telemetry types, logger seam, clock seam, and id-generator seam.
**Acceptance criteria:**
- The factory returns an object implementing the existing `Runner` contract.
- Adapter identity and supported connection mechanism must match the resolved profile before session start.
- The runner starts the adapter from `run(input)` with the full `RunnerRunInput`; no pre-materialized environment or duplicate tool/skill projection is accepted by the orchestrator factory.
- The runner yields only raw canonical `RunnerEvent` values and never yields execution-boundary-only post-validation terminal shapes.
- The runner tracks assistant-turn count, tool-call count, duration, outcome, token usage availability, degraded capabilities, model, provider, adapter, connection mechanism, and inference settings.
#### Task 5.2 — Preserve raw terminal event protocol

**Description:** Ensure the orchestrator enforces the raw runner-event protocol around adapter terminal output while leaving result-tolerance validation to the existing execution entry point.
**Acceptance criteria:**
- A valid adapter terminal signal is yielded as the existing raw canonical `runner_terminal_result` event schema.
- Result validation failures continue to be produced by `createExecutionEntryPoint` and remain compatible with current core handling.
- Duplicate terminal events, events after terminal, malformed events, and missing terminal results become `ProviderProtocolError` or existing runner protocol errors with safe details.
- Raw terminal candidates and provider-native events are not stored as step results.
#### Task 5.3 — Guarantee close semantics and telemetry

**Description:** Make `close()` and adapter/session cleanup run on success, raw terminal stream completion before entry-point validation, provider failure, stream error, and cancellation/error paths.
**Acceptance criteria:**
- Close behavior follows existing runner close semantics.
- Close failures are surfaced only where current execution-entry-point semantics allow them.
- Completion/failure telemetry emits in all raw stream terminal paths and close/error paths observable by the runner.
- Token usage, outcome, launch mechanism, and degraded capability metadata are recorded when the adapter session provides them; otherwise telemetry uses `usageAvailable: false` without invented counts.
#### Task 5.4 — Test orchestrator lifecycle and protocol behavior

**Description:** Add execution tests with fake adapters for success, raw terminal completion followed by entry-point validation failure, adapter error before terminal, stream error, malformed event, duplicate terminal, no terminal, close failure, counters, token usage, and degraded capability metadata.
**Acceptance criteria:**
- Tests prove `close()` is called on every path.
- Tests prove terminal events remain raw `RunnerEvent` values and execution-entry-point tests continue to prove result-tolerance validation uses existing configuration.
- Tests prove telemetry fields and counters are correct.
- Tests prove provider errors do not leak unsafe messages into persisted failure reasons.
### Story 6 — Add lookup-based real runner dispatch

**Description:** Create the dispatch seam that resolves explicit profiles and selects adapters by registry lookup without provider-specific branching.
**Dependencies:** Stories 4 and 5.
#### Task 6.1 — Add runner dispatch module

**Description:** Create `packages/execution/src/runner-dispatch.ts` with `AgentProviderAdapterRegistry`, `AgentRunnerFactoryOptions`, `getAgentProviderAdapterKey`, and `createAgentRunnerFactory`.
**Acceptance criteria:**
- Adapter lookup uses `(providerKind, adapterId)` keys.
- Missing explicit profiles, unknown adapter keys, provider/model mismatches, mechanism mismatches, invalid endpoint settings, unsupported required capabilities, and connection failures fail fast with typed sanitized errors.
- The orchestrator does not contain `if provider === "claude"` or equivalent provider-specific dispatch logic.
- The factory accepts injected profile, connection, logger, and telemetry seams for tests, and does not accept environment materialization or result-validation seams.
#### Task 6.2 — Test registry and dispatch behavior

**Description:** Add execution tests for adapter key generation, successful runner creation, unknown adapter, duplicate/mismatched profile data, mechanism mismatch, connection failure, and profile resolver failure.
**Acceptance criteria:**
- Tests prove adapter selection is lookup-based.
- Tests prove missing or unsupported profile state fails before adapter session start.
- Tests prove the stub runner remains unaffected.
### Story 7 — Compose provider adapter registry in core

**Description:** Narrow composed provider bindings into the execution-layer adapter registry shape while keeping core provider-neutral.
**Dependencies:** Story 6.
#### Task 7.1 — Add adapter registry composition

**Description:** Update `packages/core/src/provider-composition.ts` with `composeAgentProviderAdapterRegistry` while preserving existing composition diagnostics.
**Acceptance criteria:**
- The function accepts existing provider bindings and returns an `AgentProviderAdapterRegistry`.
- Invalid adapter instances selected for real dispatch fail with `ProviderConfigurationError`.
- Duplicate adapter keys fail with a typed sanitized error.
- Core remains provider-neutral and does not import Claude adapter code.
#### Task 7.2 — Test core registry composition

**Description:** Add or extend provider-composition tests for valid adapter bindings, invalid shape, duplicate key, empty registry, and preservation of existing diagnostics.
**Acceptance criteria:**
- Tests prove registry composition can be used by the control-plane composition root.
- Existing provider-composition tests continue to pass.
- No execution internals are imported by core tests or source.
### Story 8 — Implement the Claude Agent SDK adapter package

**Description:** Add the first provider cell that imports the Claude Agent SDK, obtains process launch configuration from the connection layer, maps session inputs into the SDK, and maps native events into canonical runner events.
**Dependencies:** Stories 3, 4, and 5.
#### Task 8.0 — Select and document the Claude Agent SDK surface

**Description:** Before generating or implementing the adapter package, document the intended Claude Agent SDK package surface: exact npm package name, supported version range, subprocess launch API, environment/process configuration options, and native session event shapes that the adapter will consume.
**Acceptance criteria:**
- The selected SDK npm package is `@anthropic-ai/claude-agent-sdk` unless implementation discovers a blocking package/version issue that must be brought back for human decision.
- The package version range is recorded in adapter package metadata or implementation notes.
- The documented SDK surface states that model traffic is performed by the spawned `claude` binary and that there is no supported custom in-process `fetch`/`baseURL`/timeout/header hook.
- The documented configuration surface includes `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`, `API_TIMEOUT_MS`, and `CLAUDE_CODE_MAX_RETRIES`.
- The documented native event surface covers assistant turns, tool calls/results, progress-tool calls, terminal/result signals, and token usage when available.
- Downstream Claude adapter implementation tasks do not proceed until this selection is recorded.
#### Task 8.1 — Generate and configure adapter package

**Description:** Create `packages/claude-agent-adapter/` as an Nx JavaScript library with package tags `type:lib`, `scope:adapter`, and `plane:execution`, public import path `@autocatalyst/claude-agent-adapter`, and dependency metadata for `@anthropic-ai/claude-agent-sdk`.
**Acceptance criteria:**
- The package builds, lints, and runs tests through Nx.
- The package exports only from `src/index.ts`.
- The package imports public execution APIs from `@autocatalyst/execution`, not execution internals.
- Boundary rules allow the adapter package to depend on public execution contracts.
#### Task 8.2 — Implement `createClaudeAgentAdapter`

**Description:** Add `ClaudeAgentAdapterOptions`, SDK/test launch seams, logger seam, capability flags, inference-setting capability matrix, and `createClaudeAgentAdapter()` returning `AgentProviderAdapter`.
**Acceptance criteria:**
- Default identity is Claude provider kind and adapter id as agreed by profile records.
- The adapter declares `process_environment` as its supported connection mechanism.
- The adapter obtains provider endpoint/auth/header/timeout/retry configuration through `AgentConnection.createProcessLaunchConfig()` or equivalent.
- The adapter never attempts to use `AgentConnection.createFetchTransport()` for Claude Agent SDK model traffic.
- Claude-specific code remains inside the adapter package.
#### Task 8.3 — Map inputs and inference settings to Claude session options

**Description:** Convert `AgentProviderSessionInput` into Claude Agent SDK session configuration, including prompt, workspace roots, scoped environment variables, broad non-interactive workspace tool posture, requested skills/plugins, and inference settings.
**Acceptance criteria:**
- Workspace and scratch roots come from `runInput.environment`.
- Prompt comes from `runInput.environment.context.task` or the existing materialized prompt location.
- Scoped environment variables are passed only through the materialized environment plus connection-layer provider launch overlays.
- Tool policy and requested skills/plugins are read from `MaterializedExecutionEnvironment` and not from duplicate session-input fields.
- Model, temperature, max output tokens, top-p, reasoning effort, and adaptive-thinking settings map only when supported by the selected Agent SDK version.
- Unsupported optional settings produce explicit degradation metadata.
- Unsupported required capabilities fail before or at session start with typed sanitized errors.
#### Task 8.4 — Map Claude native events to canonical runner events

**Description:** Convert mocked/native SDK assistant turns, tool calls/results, progress tools, notifications, and terminal/result signals into canonical `RunnerEvent` values, while delivering token usage through `AgentProviderSession.metadata`.
**Acceptance criteria:**
- Assistant turns map to `runner_assistant_turn`.
- Tool calls and results map to `runner_tool_activity`.
- `update_plan`, `report_progress`, and `notify` map to typed progress or notification events with importance hints when present.
- Token usage, outcome, launch mechanism, and degraded capability metadata are surfaced through `AgentProviderSession.metadata` when available.
- Provider-native event shapes do not escape the adapter boundary.
#### Task 8.5 — Test Claude adapter mapping and degradation

**Description:** Add adapter package tests using SDK launch test doubles and mocked event streams.
**Acceptance criteria:**
- Tests cover session start with process launch configuration.
- Tests cover assistant, tool, progress, notification, usage, and terminal mappings.
- Tests cover unsupported optional capability degradation and unsupported required capability failure.
- Tests cover inference-setting translation and degradation for Claude Agent SDK-supported versus unsupported knobs.
- Tests prove raw credential values are not logged by adapter-specific logging.
### Story 9 — Wire real agent dispatch into the control-plane composition root

**Description:** Register the Claude adapter and make the real runner path reachable behind explicit configuration/test options while preserving the stub runner path.
**Dependencies:** Stories 6, 7, and 8.
#### Task 9.1 — Update server composition options

**Description:** Update `apps/control-plane/src/server.ts` and related option types so the execution unit of work can receive a runner factory when real provider dispatch is enabled.
**Acceptance criteria:**
- Existing stub-runner development and test paths remain available.
- Real dispatch is enabled only by explicit configuration/test options for this issue.
- The server can register the Claude adapter factory in `providerAdapters`.
- Existing control-plane startup composition diagnostics remain sanitized.
#### Task 9.2 — Resolve explicit profiles for real dispatch

**Description:** Build a deterministic profile resolver from configuration record data plus endpoint and credential data for this issue.
**Acceptance criteria:**
- The resolver returns `ResolvedAgentRunnerProfile` for the configured provider-profile id or default explicit profile.
- The resolver sets `connectionMechanism: 'process_environment'` for the Claude Agent SDK adapter.
- Missing profile, unsupported adapter, provider/model mismatch, invalid endpoint, unsupported required mechanism capability, and missing credential fail before session start.
- The resolver does not implement full model-routing fallback logic.
- Credential secret handles are passed only to the connection factory.
#### Task 9.3 — Connect event consumer and step-result checkpoint path unchanged

**Description:** Ensure the real runner path still flows through `createExecutionEntryPoint`, `createExecutionRunUnitOfWork`, `consumeRunnerEvents`, retained event replay, SSE, and `RunStep` checkpoint storage.
**Acceptance criteria:**
- No Claude-specific event consumer is added.
- Existing runner protocol checks still apply.
- Validated terminal results land on the current `RunStep` through the existing checkpoint behavior.
- Raw provider-native events, request bodies, launch secrets, transcripts, and raw terminal candidates are not persisted as durable step results.
### Story 10 — Prove the production path with integration coverage

**Description:** Add service-level integration coverage that exercises the Claude adapter through the production dispatch seam against a fake Claude Agent SDK launch seam and controlled event stream.
**Dependencies:** Stories 2 through 9.
#### Task 10.1 — Add fake Claude Agent SDK launch harness

**Description:** Add test utilities for a fake SDK launch seam that can assert process environment configuration and return controlled Claude-like event streams.
**Acceptance criteria:**
- The harness records redacted launch configuration without logging raw credential values.
- The harness can assert `ANTHROPIC_BASE_URL`, selected auth variable name, representable custom headers, `API_TIMEOUT_MS`, and `CLAUDE_CODE_MAX_RETRIES` are present when configured.
- The harness can simulate launch failure, SDK-surfaced retry exhaustion, provider protocol failure, and success.
- The harness can emit assistant, tool, progress, usage, and terminal events used by adapter and integration tests.
#### Task 10.2 — Add control-plane real dispatch integration test

**Description:** Add a control-plane or service-level integration test that registers the Claude adapter, creates a provider profile and secret, dispatches a run, and observes persisted/re-streamed events and step result checkpoint storage.
**Acceptance criteria:**
- The test invokes the same dispatch path used by normal runs, not an isolated adapter unit test.
- The fake SDK launch seam verifies configured `baseUrl`, auth environment variable, custom header rewrite, timeout, and retry behavior at launch.
- Unsupported header strip behavior is asserted as degradation metadata unless marked required.
- Captured logs do not contain the known credential value.
- Events are persisted and re-streamed through `GET /v1/runs/:id/events`.
- The terminal result passes the result-tolerance pipeline.
- The validated terminal result appears on the current `RunStep`.
#### Task 10.3 — Add failure-path integration coverage

**Description:** Add integration tests for missing profile/credential, unsupported adapter, unsupported required mechanism capability, SDK launch failure/retry exhaustion, provider protocol failure, and result validation failure where practical.
**Acceptance criteria:**
- Configuration failures occur before backend session start.
- Unsupported required mechanism capabilities fail before SDK launch.
- SDK launch failure and retry exhaustion produce sanitized failure results.
- Provider protocol failures do not leak native event payloads or transcripts.
- Result validation failure follows existing tolerance-pipeline behavior.
### Story 11 — Update agent-facing documentation and validation

**Description:** Record the new module map and run targeted validation so future agents can find and verify the feature.
**Dependencies:** Stories 1 through 10.
#### Task 11.1 — Update code map and durable agent notes

**Description:** Update `context-agent/wiki/code-map.md` after implementation with the connection layer, request-alteration boundary, agent orchestrator, adapter contract, runner dispatch, Claude adapter package, and new validation commands. Add a terse decision note only if implementation makes a new durable technical decision beyond this spec.
**Acceptance criteria:**
- Code map entries name the new modules and their responsibilities.
- New package generation details and test commands are accurate.
- Any new decision is recorded under `context-agent/decisions/` using the repository format.
#### Task 11.2 — Run implementation validation

**Description:** Run targeted tests first, then broader validation required by the repository after implementation.
**Acceptance criteria:**
- Targeted tests include `pnpm nx test execution`, `pnpm nx test core`, `pnpm nx test control-plane`, `pnpm nx test api-contract`, and the Claude adapter package tests.
- Boundary validation runs with `pnpm test:boundaries`.
- Full validation runs with `pnpm validate` when practical.
- Any skipped command is documented with the exact reason.