---
created: 2026-06-10
last_updated: 2026-06-10
status: implementing
issue: 32
specced_by: autocatalyst
---
# Feature: OpenAI agent runner cell on the OpenAI Agents SDK

## Product requirements

### What

Add the OpenAI agent runner cell behind Autocatalyst's existing agent-mode runner architecture. A run should be able to drive a real OpenAI Agents SDK session through an `AgentProviderAdapter`, using the existing agent orchestrator, shared connection layer, request-alteration boundary, runner-event stream, result-tolerance path, and control-plane event consumer.
The adapter must use the OpenAI Agents SDK agent harness, not the OpenAI direct chat-completions cell. The session runs through the SDK's `SandboxAgent`, with a local sandbox client supplied at run time through the SDK's run configuration and bound to the run's materialized workspace roots. Snapshotting is disabled by explicitly passing the JS SDK's `NoopSnapshotSpec` snapshot spec (`type: 'noop'`) so the SDK never persists sandbox contents or workspace snapshots to disk.
The completed slice gives the runner layer two real agent providers: the existing Claude agent cell and the new OpenAI agent cell. Model-routing table resolution remains out of scope, but explicit profiles should be able to dispatch an `implementer` session to Claude and a `reviewer` session to OpenAI in the same step through production seams.
### Why

Autocatalyst's runner design is one connection layer, one orchestrator per mode, and one provider adapter per provider-and-mode cell. Issues 27 and 28 established the connection layer, request-alteration boundary, agent orchestrator, adapter contract, Claude agent cell, direct orchestrator, and Anthropic/OpenAI direct cells. The remaining near-term gap is the OpenAI tool-using agent cell.
This feature proves the agent-mode abstraction is truly provider-neutral. It also gives the convergence loop a credible two-provider shape: one role can use Claude Agent SDK and another can use OpenAI Agents SDK without branching the orchestrator or bypassing the event consumer. The hard safety reason for a dedicated OpenAI agent cell is sandbox behavior: tool execution must happen in the SDK sandbox, and snapshot persistence must be explicitly disabled.
### Goals

- Implement a new OpenAI agent adapter package that imports OpenAI Agents SDK APIs as a library and implements the existing `AgentProviderAdapter` contract.
- Use the SDK's `SandboxAgent` for tool-using agent sessions and provide a local sandbox client at run time.
- Bind the local sandbox client to the run's materialized workspace roots; hosted or remote sandbox providers are out of scope for this slice.
- Disable SDK snapshotting by explicitly passing `NoopSnapshotSpec`, and prove no snapshot or workspace content is persisted to disk.
- Reach OpenAI through a per-session client or transport created from `connection.createFetchTransport()`, never through a process-global default OpenAI client.
- Resolve explicit OpenAI agent profiles with `connectionMechanism: 'fetch_transport'` and header-target credential handling so production dispatch reaches the OpenAI adapter instead of failing the mechanism match before session start.
- Keep provider-specific SDK types, event names, sandbox configuration, and capability mapping inside the OpenAI adapter package.
- Map OpenAI native agent events to canonical `RunnerEvent` values: assistant turns, tool activity, progress, notifications, step checkpoints when available, and exactly one terminal result.
- Materialize the run's declared tool policy, broad non-interactive workspace posture, and skill intent onto the SDK session as far as the SDK supports them.
- Expose unsupported optional capabilities as explicit degradation metadata and fail required unsupported capabilities with typed sanitized errors.
- Emit uniform session telemetry tagged with run, phase, step, role, provider, model, inference settings, connection mechanism, duration, token usage availability, outcome, and degraded capabilities.
- Flow events through the existing `consumeRunnerEvents` consumer unchanged, including persistence, SSE re-streaming, and terminal-result checkpointing on the run's `RunStep`.
- Dispatch the cell by resolved profile provider/mode/adapter lookup through existing production factories.
- Prove integration behavior against mocked OpenAI Agents SDK and sandbox seams without live OpenAI credentials.
- Update agent-owned code navigation docs during implementation so future agents can find the OpenAI agent adapter and its `SandboxAgent`/`NoopSnapshotSpec` behavior.
### Non-goals

- Implementing model-routing table resolution, specificity fallback, role-distinct routing policy, or automatic profile assembly. Explicit profiles are enough for this feature.
- Reusing or changing the OpenAI direct cell. The direct cell is a bounded one-shot chat-completions path and must not be used for this tool-using agent feature.
- Implementing the in-step convergence loop that assigns implementer/reviewer rounds.
- Implementing durable session-grain telemetry archive, cost accounting, or permanent turn-grain transcript storage.
- Adding per-route least-privilege tool policy, hardened network-egress controls, hosted/remote sandbox support, or hosted multi-tenant sandbox hardening beyond the broad workspace-scoped default already sequenced.
- Adding UI changes for viewing runner events or provider setup.
- Adding branch, worktree, push, merge, or PR-management behavior.
### Personas

- **Enzo (Engineer)** needs a second agent provider cell by implementing an adapter, not by forking the agent orchestrator.
- **Opal (Operator)** needs OpenAI agent sessions to use configured endpoints, credentials, retries, timeouts, and redacted logs safely under concurrent runs.
- **Phoebe (PM)** needs proof that Autocatalyst can dispatch genuinely distinct agent providers for different roles before model routing automates that choice.
- **Dani (Designer)** is not directly affected by this backend feature, but future progress views depend on provider-neutral events and importance hints arriving consistently.
### User stories

- As Enzo, I can create an OpenAI agent adapter package that implements `AgentProviderAdapter` using only public `@autocatalyst/execution` APIs.
- As Enzo, I can register the OpenAI agent cell and have the existing agent orchestrator run it without OpenAI-specific branches.
- As Enzo, I can mock the OpenAI Agents SDK and sandbox client in tests and prove production dispatch invokes the adapter.
- As Opal, I can configure an explicit OpenAI agent profile with endpoint and credential data and dispatch a run without leaking credential values or raw provider responses.
- As Opal, I can trust that OpenAI provider traffic goes through the per-session connection-layer fetch transport, not a process-global OpenAI client.
- As Opal, I can trust that the OpenAI SDK sandbox does not write snapshots or workspace contents to disk because `NoopSnapshotSpec` is configured.
- As Phoebe, I can see an integration proof that one step can dispatch a Claude implementer session and an OpenAI reviewer session through two real agent-provider cells.
- As Dani, I can rely on assistant turns, tool activity, structured progress, notifications, and terminal results using the same runner-event vocabulary as other agent sessions.
### Acceptance criteria

#### OpenAI agent adapter package

- A new package, expected to be `packages/openai-agent-adapter/` with import path `@autocatalyst/openai-agent-adapter`, implements the existing `AgentProviderAdapter` contract.
- The package exports `createOpenAIAgentAdapter`, `openaiProviderKind`, `openaiAgentAdapterId`, and public option/logger/test seam types.
- The adapter declares `providerKind: 'openai'`, an agent-mode adapter id such as `openai-agents-sdk`, and `supportedConnectionMechanism: 'fetch_transport'`.
- The package depends on `@autocatalyst/execution` public APIs and does not import from `@autocatalyst/execution/src/*` or other execution internals.
- The OpenAI adapter package is distinct from `packages/openai-direct-adapter/`; neither package imports from the other.
- If `@openai/agents` is optional or peer-installed, missing SDK availability fails at adapter construction or session start with a typed sanitized configuration error.
#### OpenAI Agents SDK and sandbox session

- The adapter uses the OpenAI Agents SDK as an agent harness for a tool-using loop.
- The adapter starts sessions through the SDK's `SandboxAgent`, not through `/v1/chat/completions` or the existing OpenAI direct adapter.
- The sandbox client is a local client, such as `UnixLocalSandboxClient` or `DockerSandboxClient` from `@openai/agents/sandbox/local`, supplied at run time through the SDK's run configuration and allowing tests to inject a fake sandbox client.
- Hosted or remote sandbox providers are excluded from production for this slice because they would not operate on the run's actual materialized git worktree and are the class of providers associated with remote storage mounts and snapshot persistence.
- Snapshotting is disabled through an explicit `NoopSnapshotSpec` configured as the SDK `snapshot` option.
- Tests assert that a snapshot spec with `type: 'noop'` is passed into the SDK configuration, using `isNoopSnapshotSpec()` where available, and that no snapshot writer or snapshot path is invoked during a run.
- The adapter maps Autocatalyst's materialized workspace roots into the SDK sandbox in a way that keeps tool execution sandboxed and avoids ambient host paths outside the materialized workspace.
- If the SDK cannot support a requested sandbox or snapshot behavior, session start fails before provider work begins with a sanitized required-capability error.
#### Connection layer and OpenAI client construction

- The adapter reaches OpenAI through a per-session OpenAI client, fetch adapter, or transport bound to `connection.createFetchTransport()`.
- The implementation never calls or relies on process-global OpenAI client configuration such as `setDefaultOpenAIClient`.
- Credential resolution, auth injection, base URL application, timeout, retry, header rewrite/strip, and redacted request/response logging remain owned by the existing connection layer.
- The adapter does not read OpenAI credentials from ambient environment variables or ordinary profile settings.
- Concurrent OpenAI sessions can use different endpoints or credentials because each session owns its own connection-bound client/transport.
- Tests prove the SDK receives the injected per-session transport/client and that the process-global client path is not used.
#### Event stream and terminal-result protocol

- The adapter yields only canonical `RunnerEvent` values outside the adapter boundary.
- Native SDK assistant messages map to `runner_assistant_turn` events.
- Native SDK tool calls and tool results map to `runner_tool_activity` events unless they are Autocatalyst progress tools.
- Calls to `update_plan`, `report_progress`, and `notify` map to `runner_progress` or `runner_notification` using the existing progress-tool schemas.
- The adapter yields exactly one `runner_terminal_result` event and yields no events after that terminal event.
- Token usage, model metadata, outcome, and degraded capabilities surface through `AgentProviderSession.metadata`, not as synthetic runner events.
- Malformed SDK events, impossible session ordering, duplicate terminal results, and events after terminal become typed provider protocol errors or runner protocol errors with sanitized details.
- Raw SDK events, raw transcripts, raw request bodies, raw response bodies, provider credentials, and sandbox snapshot contents are not persisted as run events or step checkpoint data.
#### Tool policy, skills, inference settings, and capability degradation

- The adapter reads prompt, workspace, scoped environment variables, tool policy, requested skills, and allowed tools from the authoritative `RunnerRunInput.environment`.
- The adapter materializes Autocatalyst progress tools into SDK tools with schemas matching `updatePlanToolInputSchema`, `reportProgressToolInputSchema`, and `notifyToolInputSchema`.
- The adapter materializes the broad, non-interactive, workspace-scoped default tool posture where the SDK supports it.
- The adapter materializes requested skill intent where the SDK supports it, and reports unsupported optional skills through degradation metadata.
- The adapter translates model identity and OpenAI-supported inference settings through an explicit capability matrix.
- Unsupported optional inference settings become safe degradation metadata. Unsupported required inference settings fail with a typed sanitized error before or during session setup.
- Capability metadata uses safe names and reasons only. It does not include prompts, raw tool input, file contents, credentials, or full provider messages.
#### Dispatch and composition

- Production dispatch can select the OpenAI agent adapter by resolved profile provider and adapter id through `createAgentRunnerFactory` and `getAgentProviderAdapterKey`.
- The agent orchestrator remains provider-neutral. It does not import OpenAI SDK types or branch on `providerKind === 'openai'`.
- Control-plane real-runner composition can register both the existing Claude agent adapter and the new OpenAI agent adapter in the agent adapter registry.
- The explicit profile resolver/composition path in `apps/control-plane/src/server.ts` no longer hardcodes all agent profiles to `connectionMechanism: 'process_environment'` or `authTarget: 'process_environment'`. After it locates the selected provider-profile record and registered adapter, it derives the resolved profile `connectionMechanism` from the adapter's `supportedConnectionMechanism`: Claude agent profiles remain `process_environment`, while OpenAI agent profiles resolve to `fetch_transport`.
- For `fetch_transport` agent profiles, credential references use `authTarget: 'header'` and preserve the configured `credentialSecretHandle` for the connection layer; they do not synthesize process-environment credentials. Required credential behavior remains enforced by `createAgentConnection` before provider work starts.
- Explicit profile resolution is enough for this issue. The later model-routing table may resolve the same `ResolvedAgentRunnerProfile` shape without introducing a parallel profile model.
- The existing stub runner remains available for test and development paths that intentionally choose it.
#### Event consumer and run-step checkpointing

- OpenAI agent events flow through the existing execution entry point, runner-event protocol checks, `consumeRunnerEvents`, retained event store, and SSE route without an OpenAI-specific consumer.
- Persisted/re-streamed events over `GET /v1/runs/:id/events` use the existing client-visible event contract.
- The raw terminal runner result is validated by the existing result-tolerance pipeline before core receives the execution-boundary terminal result.
- The validated terminal result is recorded on the current `RunStep` through the same checkpoint handoff as other agent runs.
- Existing protocol checks still reject malformed events, wrong run ids, duplicate terminal results, missing terminal results, and events after terminal.
#### Integration coverage

- Integration tests run with mocked OpenAI Agents SDK and sandbox seams and require no live OpenAI credentials or network access.
- A test dispatches the OpenAI adapter through the production agent runner factory seam, not by invoking adapter internals only.
- The test asserts that `SandboxAgent` is constructed or run with the supplied local sandbox client and `NoopSnapshotSpec` configuration.
- The test asserts that OpenAI provider access uses the per-session fetch transport from the connection layer and not a process-global default client.
- The test asserts assistant turns, tool activity, progress, notifications, and terminal result events pass through the existing consumer and SSE path.
- The test asserts terminal result validation and `RunStep` checkpoint persistence still happen after the raw terminal event.
- A test dispatches an `implementer` session through the Claude agent cell and a `reviewer` session through the OpenAI agent cell using explicitly constructed profiles, proving two distinct agent providers in one step without implementing model routing.
- Tests assert known fake secrets, raw prompts, raw request bodies, raw response bodies, and sandbox file contents do not appear in captured logs, telemetry, persisted events, terminal results, or thrown error messages.
### References

- Issue: [https://github.com/markdstafford/autocatalyst/issues/32](https://github.com/markdstafford/autocatalyst/issues/32)
- `context-human/spec.md`
- `context-human/concepts/agent-runners.md`
- `context-human/concepts/execution-runtime.md`
- `context-human/concepts/model-routing.md`
- `context-human/concepts/runtime-skills.md`
- `context-human/concepts/workspace.md`
- `context-human/adrs/adr-010-agent-execution-context.md`
- `context-human/adrs/adr-022-runner-structure.md`
- `context-human/adrs/adr-023-request-alteration-boundary.md`
- `context-human/adrs/adr-024-role-aware-routing-key.md`
- `context-agent/standards/api-conventions.md`
- `context-agent/standards/logging.md`
- `context-agent/standards/telemetry-conventions.md`
- Prior spec: `context-human/specs/feature-runner-connection-layer-claude-agent-adapter.md`
- Prior spec: `context-human/specs/feature-direct-orchestrator-anthropic-openai-direct-adapters.md`
- OpenAI Agents SDK sandbox-agents guide: [https://openai.github.io/openai-agents-js/guides/sandbox-agents/clients/](https://openai.github.io/openai-agents-js/guides/sandbox-agents/clients/)
- OpenAI Agents JS no-op snapshot definition: [https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/sandbox/snapshot.ts](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/sandbox/snapshot.ts)
- OpenAI Agents JS sandbox memory example showing disk-backed local snapshots to avoid: [https://github.com/openai/openai-agents-js/blob/main/examples/sandbox/memory.ts](https://github.com/openai/openai-agents-js/blob/main/examples/sandbox/memory.ts)
- OpenAI Agents JS basic `SandboxAgent` example: [https://github.com/openai/openai-agents-js/blob/main/examples/sandbox/basic.ts](https://github.com/openai/openai-agents-js/blob/main/examples/sandbox/basic.ts)
## Design spec

### Design scope

This is a backend execution-plane feature. It does not add screens, visual components, or user-facing copy. The design work is the runtime shape for a second agent provider, the safe sandbox behavior around OpenAI Agents SDK sessions, and the observable behavior of events, telemetry, and sanitized failures.
The core product promise is symmetry. OpenAI changes provider-specific input and output mapping, not how Autocatalyst dispatches, validates, records, or observes an agent session.
### Operator experience

An operator configures an explicit OpenAI agent profile with endpoint and credential data in the same service-owned configuration model used by existing provider cells. When the run dispatches, the operator should see normal run progress through the existing event stream. The provider, model, mode, step, role, endpoint/profile id, outcome, duration, and token-usage availability should appear in safe logs or telemetry.
Failures should be actionable without exposing sensitive data. A missing credential identifies credential resolution. A rejected endpoint identifies connection or provider failure with a safe code. A sandbox setup failure identifies sandbox configuration. A snapshot-safety failure identifies unsupported snapshot configuration. None of those paths should include a raw OpenAI key, secret handle paired with secret material, raw prompt, raw request body, raw provider response, transcript, or workspace file content.
Snapshot safety should be observable as a positive assertion, not an assumption. In test logs or telemetry, safe metadata may record that the session used the no-op snapshot mode. It must not record snapshot paths or file contents because no snapshot should be written.
### Developer experience

A developer should encounter the same seams as the Claude agent cell:
1. **Connection layer** — resolves endpoint and credential data, builds a per-session altered fetch transport, and owns redacted request logging.
2. **Agent orchestrator** — owns session lifecycle, telemetry, protocol checks, and the `Runner` contract.
3. **Agent provider-adapter contract** — owns provider-specific session setup and event extraction.
4. **OpenAI agent adapter** — imports OpenAI Agents SDK, constructs the sandboxed session, configures no-op snapshots, maps native events, and reports metadata.
5. **Dispatch lookup** — binds the explicit resolved profile to the registered OpenAI adapter.
The agent orchestrator should not know OpenAI SDK class names, event names, tool representations, sandbox client types, or snapshot configuration. The OpenAI adapter should not know how SSE replay works, how run transitions are persisted, or how `RunStep` rows are updated.
### Dispatch and session flow

The flow stays inside the existing agent-mode path:
1. Core receives a run dispatch and builds `RunWorkInput`.
2. The execution entry point materializes the workspace, scoped environment, tool policy, skills, secrets, and prompt.
3. The real runner path resolves an explicit `ResolvedAgentRunnerProfile` for the current run, phase, step, and role.
4. `createAgentRunnerFactory` looks up the OpenAI adapter by `(providerKind, adapterId)`.
5. The connection layer resolves the endpoint and credential and returns an `AgentConnection` whose `createFetchTransport()` uses ADR-023 request alteration.
6. The agent orchestrator starts the OpenAI adapter with the authoritative `RunnerRunInput` and drains canonical events.
7. The adapter drives the OpenAI Agents SDK `SandboxAgent` session and maps native events to canonical `RunnerEvent` values.
8. The execution entry point validates the raw terminal result and yields the post-validation execution-boundary result to core.
9. Core consumes the event stream and stores the validated checkpoint on `RunStep` through the existing lifecycle handoff.
No step in this flow should branch on OpenAI outside adapter lookup and registration.
### OpenAI SDK and sandbox flow

The adapter owns all SDK-specific work. At session start it constructs a per-session OpenAI client or SDK transport that uses `connection.createFetchTransport()`. It then creates or configures a `SandboxAgent` with the run prompt, model, supported inference settings, materialized progress tools, allowed workspace tools, and a run configuration that supplies a local sandbox client.
The sandbox client is not ambient. Tests and production composition should be able to supply it through adapter options or the SDK run configuration. Production must use a local sandbox client, such as `UnixLocalSandboxClient` or `DockerSandboxClient` from `@openai/agents/sandbox/local`, bound to the run's materialized workspace roots. Hosted or remote sandbox providers are out of scope for this slice: the `implementer` and `reviewer` roles must operate on the actual git worktree materialized for the run, and hosted/remote sandboxes are the providers most likely to introduce remote storage mounts or snapshot persistence. The adapter maps Autocatalyst workspace roots to the SDK's sandbox model so tool execution stays inside the materialized run workspace. If the materialized workspace shape is `none`, the adapter may run without workspace file tools when the step permits it, or fail with a required capability error when the selected step needs workspace tools.
Snapshotting is disabled at the same boundary where the local sandbox client is configured. The adapter explicitly passes `new NoopSnapshotSpec()` as the `snapshot` option on the local sandbox client or sandbox run configuration. The disk-safety guarantee is the combination of a local sandbox client bound to the materialized workspace and an explicit no-op snapshot spec. The adapter must not rely on omitting `snapshot`, because SDK runtimes may default to a disk-backed local snapshot path before falling back to no-op behavior. The adapter must also avoid disk-persisting patterns such as `snapshot: { type: 'local', ... }`. If the SDK API changes and `NoopSnapshotSpec` is unavailable, the adapter should keep the product contract stable by failing before session start. It must not silently fall back to SDK default snapshot behavior.
### Event and result design

The canonical event stream remains the product contract. Provider-native OpenAI events are temporary adapter inputs and disappear at the adapter boundary.

OpenAI session signal
Autocatalyst event or metadata

Assistant message/turn
`runner_assistant_turn`

Tool call start/end for ordinary tools
`runner_tool_activity`

Tool call to `update_plan`
`runner_progress` with `kind: plan`

Tool call to `report_progress` with counts
`runner_progress` with `kind: task_progress`

Tool call to `report_progress` with summary only
`runner_progress` with `kind: intent`

Tool call to `notify`
`runner_notification`

Durable checkpoint signal, if the SDK or adapter has one
`runner_step_checkpoint` with safe JSON data

Final answer/result candidate
one `runner_terminal_result`

Token usage and model metadata
`AgentProviderSession.metadata`

Unsupported optional capability
`AgentProviderSession.metadata.degradedCapabilities`

The adapter should prefer structured progress tools for model-authored progress. If the SDK exposes tool-call arguments as strings or provider-native values, the adapter validates them with the existing progress-tool schemas before emitting progress events. Invalid progress-tool calls become low-importance tool activity or safe degradation metadata rather than malformed runner events.
The terminal result should follow the existing agent-runner contract. The adapter may write the declared result into the scratch root when the SDK produces a structured output candidate, then emit the raw terminal event. The execution entry point remains responsible for result-file reading, normalization, correction, validation, and the post-validation terminal handoff.
### Tool policy and skills design

Autocatalyst tool policy and skill intent come from `RunnerRunInput.environment`; the OpenAI adapter does not invent a second source. The adapter maps the broad non-interactive workspace posture to SDK sandbox tools where possible. It should expose progress tools in every session because they are provider-neutral and drive a better event stream.
Skill materialization is capability-based. If the SDK has a native skill/plugin mechanism, the adapter maps requested skill refs onto it. If a skill cannot be represented and the skill is optional for the route, the adapter records a safe degradation. If a requested skill is required for the step result, the adapter fails before model work starts. The first implementation may support only the core progress tools and workspace tools, but unsupported behavior must be explicit.
### Telemetry and logging design

Telemetry remains session-oriented. It should include session start and completion, duration, assistant-turn count, tool-activity count, token usage when available, outcome, provider, adapter id, model, inference settings, connection mechanism, run id, phase, step, role, degraded capabilities, and whether no-op snapshot mode was configured.
Connection logs remain separate from session telemetry. Fetch attempts, retries, timeouts, auth injection, base URL application, and response status are logged by the connection layer using redacted request/response projections. The OpenAI adapter logs only safe SDK/session facts such as adapter id, SDK availability, sandbox configuration outcome, no-op snapshot mode, event-mapping failures, and sanitized provider protocol codes.
Tests should capture logs and telemetry with known fake secrets and sensitive prompt text. Those values must not appear in logs, errors, events, terminal results, or checkpoint data.
### Integration design

The main integration test should run through the production dispatch path with fake seams:
1. Register the existing Claude adapter with a fake Claude session seam.
2. Register the OpenAI agent adapter with a mocked OpenAI Agents SDK factory and fake sandbox client.
3. Resolve explicit profiles for `implementer` and `reviewer`: Claude for `implementer`, OpenAI for `reviewer`.
4. Dispatch both sessions through `createAgentRunnerFactory` and the agent orchestrator.
5. Assert both sessions yielded canonical events and exactly one terminal result.
6. Assert OpenAI used `SandboxAgent`, received the supplied local sandbox client, configured `NoopSnapshotSpec`, and used the per-session fetch transport for model access.
7. Separately assert, with a single OpenAI reviewer invocation, that events flowed through the existing consumer/SSE path and terminal validation persisted the run-step checkpoint.
The role-distinct Claude/OpenAI proof is a production-seam dispatch proof, not a converged lifecycle loop. It uses two role-scoped `createAgentRunnerFactory` invocations with explicitly constructed profiles in the same run id and step name: one invocation has role `implementer` and resolves Claude, and one invocation has role `reviewer` and resolves OpenAI. Each invocation has its own runner event stream and exactly one terminal result. The test must not merge those streams into one runner protocol stream, must not expect one combined terminal result, and must not require both role invocations to write a single shared `RunStep` checkpoint. Run-step checkpoint persistence remains covered by the single-session consumer test above until the convergence loop defines multi-role checkpoint semantics.
A narrower adapter test should cover native event mapping, progress-tool validation, token usage metadata, capability degradation, SDK failure mapping, and no-events-after-terminal enforcement. These tests should mock the SDK and must not call the network.
### Unsupported provider behavior

Some SDK capabilities may be unavailable or may change by SDK version. The implementation must handle those differences explicitly:
- Missing OpenAI Agents SDK package: sanitized configuration failure.
- Missing `SandboxAgent` support: sanitized required-capability failure.
- Missing no-op snapshot support: sanitized required-capability failure; no silent fallback to default snapshots.
- Missing custom client/transport support: sanitized required-capability failure because ADR-023 per-session request alteration is mandatory.
- Missing optional inference setting support: degradation metadata.
- Missing required inference setting, tool, skill, sandbox, or snapshot support: typed failure before session start.
## Tech spec

### Architecture fit

The OpenAI agent cell is an adapter package plus composition wiring. It plugs into the existing `AgentProviderAdapter` contract in `packages/execution/src/agent-provider-adapter.ts` and is dispatched by `createAgentRunnerFactory` from `packages/execution/src/runner-dispatch.ts`. The existing `createAgentOrchestratorRunner` remains the only agent-mode orchestrator.
Provider-specific code lives in the new OpenAI adapter package. Shared execution modules may receive small provider-neutral extensions only if the adapter cannot express required behavior through the existing public contract. Any such extension must remain generic, such as adding a test seam for per-session client construction or exposing an existing progress-tool helper from the public entry point.
### Package and dependency shape

Create a new adapter package following the existing adapter package conventions:
- directory: `packages/openai-agent-adapter/`;
- package name: `@autocatalyst/openai-agent-adapter`;
- Nx tags: `type:lib`, `scope:adapter`, and `plane:execution`;
- public entry point: `src/index.ts`;
- main implementation: `src/openai-agent-adapter.ts`;
- tests: `src/openai-agent-adapter.spec.ts` plus integration coverage from control-plane or execution composition tests.
The package should depend on `@autocatalyst/execution` and, if needed for event types or schema helpers, `@autocatalyst/api-contract`. The OpenAI Agents SDK dependency should be chosen to match package-management policy. If the SDK is optional at install time, declare it as an optional peer dependency and inject SDK factories in tests. If it is a normal dependency, tests still inject fake SDK objects and never require live credentials.
The package must import execution APIs only from `@autocatalyst/execution`. Boundary tests should continue to reject imports from execution internals.
### Public adapter API

The package should export constants and a factory similar to the Claude adapter:
```typescript
export const openaiProviderKind = 'openai' as const;
export const openaiAgentAdapterId = 'openai-agents-sdk' as const;

export interface OpenAIAgentAdapterOptions {
  readonly sdk?: OpenAIAgentsSdkFacade;
  readonly sandboxClientFactory?: OpenAISandboxClientFactory;
  readonly clock?: () => Date;
  readonly eventIdGenerator?: () => string;
  readonly logger?: OpenAIAgentAdapterLogger;
}

export function createOpenAIAgentAdapter(options?: OpenAIAgentAdapterOptions): AgentProviderAdapter;
```
Final type names may differ, but the factory must allow tests to inject a fake SDK and fake sandbox client. The default production path imports or resolves the real SDK facade.
The returned adapter has:
- `providerKind: openaiProviderKind`;
- `adapterId: openaiAgentAdapterId`;
- `supportedConnectionMechanism: 'fetch_transport'`;
- `startSession(input)` that returns `AgentProviderSession` with `events` and `metadata`;
- optional `close()` or per-session `close()` when the SDK exposes teardown.
### SDK facade and per-session client construction

Add a narrow internal facade around the OpenAI Agents SDK rather than spreading SDK imports throughout the adapter. The facade should include only what the adapter needs: `SandboxAgent`, run/session start, `NoopSnapshotSpec` construction and `isNoopSnapshotSpec` validation where available, local sandbox client construction, OpenAI client construction if required, and native event stream types as unknown/provider-local values.
At session start:
1. call `connection.createFetchTransport()`;
2. build a per-session OpenAI client or SDK transport that delegates every request to that transport;
3. pass that client/transport into the SDK run configuration;
4. never call global SDK client setters;
5. include safe telemetry context but no raw credential in adapter-visible state.
If the SDK requires a `fetch`-compatible function, adapt `ProviderFetchTransport.fetch(request)` to the SDK's expected request shape. If the SDK requires an OpenAI client object, construct that object with the custom fetch/transport and profile endpoint settings already represented by the connection layer. Do not duplicate base URL, auth, timeout, retry, or header logic in the adapter.
### Sandbox and no-op snapshot configuration

The adapter should construct a `SandboxAgent` or run configuration using the injected local sandbox client/factory. The sandbox configuration must use workspace roots from `input.runInput.environment.workspace` and must not expose paths outside the materialized workspace. For `two_roots` workspaces, repo roots should be available for code edits and scratch root should be available for result files and transient artifacts. For scratch-only or no-workspace shapes, expose only what the shape permits.
Production local sandbox construction should use a JS SDK local client, such as `UnixLocalSandboxClient` or `DockerSandboxClient` from `@openai/agents/sandbox/local`, configured with the materialized workspace roots and an explicit no-op snapshot spec. Hosted or remote sandbox clients are not supported by this slice and must fail as unsupported sandbox capability if selected or injected for production, because they cannot be assumed to share the run's materialized git worktree and may introduce remote mounts or snapshot persistence.
`OpenAIWorkspaceSandboxConfig` mirrors the existing `MaterializedWorkspace` union rather than introducing a new `workspace` shape. Mapping invariants:
- `shape: 'none'` has `workspaceRoots: []` and no `repoRoot`, `scratchRoot`, or `resultRoot`.
- `shape: 'scratch_only'` has `scratchRoot` and `resultRoot` set to the materialized scratch root, and `workspaceRoots` contains only that scratch root.
- `shape: 'two_roots'` has `repoRoot` set to the materialized repo root, `scratchRoot` and `resultRoot` set to the materialized scratch root, and `workspaceRoots` contains exactly the repo root and scratch root.
- Every root in `workspaceRoots`, `repoRoot`, `scratchRoot`, and `resultRoot` must come from `input.runInput.environment.workspace`; the adapter must not add ancestor directories, process cwd, home directories, or SDK defaults that escape those roots.
Configure no-op snapshot behavior as a required capability. The JS SDK construct is `NoopSnapshotSpec`, not the Python SDK's `NoopSnapshot`. `NoopSnapshotSpec` has `type: 'noop'`, and the SDK also exposes `isNoopSnapshotSpec(spec)` for validation. The adapter must set this spec explicitly on the local sandbox client or sandbox run configuration:
```typescript
const snapshot = new sdk.NoopSnapshotSpec();
if (!sdk.isNoopSnapshotSpec?.(snapshot) && snapshot.type !== 'noop') {
  throw new UnsupportedProviderCapabilityError('sandbox_snapshot_unsupported', {
    capability: 'openai_agents_noop_snapshot',
  });
}

const sandboxClient = sandboxClientFactory({
  workspace: workspaceSandboxConfig,
  snapshot,
  // The production factory may wrap UnixLocalSandboxClient or DockerSandboxClient.
});
```
This pseudocode is illustrative. The implementation should use the SDK's actual documented entry point for `NoopSnapshotSpec` and `isNoopSnapshotSpec` and should confirm whether they are exported from `@openai/agents/sandbox` or another documented package entry point. If no supported no-op snapshot API exists in the installed SDK version, throw `UnsupportedProviderCapabilityError('sandbox_snapshot_unsupported', ...)` or a provider configuration error with safe details. If a local sandbox client cannot be constructed or a hosted/remote sandbox is selected where production requires local workspace access, use a precise sandbox capability code such as `sandbox_client_unsupported`. The selected error code must be specific to sandbox or snapshot capability and must not use unrelated tool-policy or skill codes. It should not include SDK stack traces or file paths.
Tests should assert both the positive configuration and the negative path. The fake SDK should record whether the snapshot spec has `type: 'noop'`, and tests should use `isNoopSnapshotSpec()` where the facade exposes it. A failure test should omit no-op snapshot support and assert session start fails before event emission. Another test should assert no snapshot file or directory is created during a run, and fake SDK seams should fail if a disk-persisting snapshot spec such as `{ type: 'local', ... }` is passed or if the adapter omits the `snapshot` option.
### Input mapping

`startSession` receives `AgentProviderSessionInput`. The adapter should map:
- `runInput.environment.context` and telemetry context into safe session metadata;
- the task prompt into the SDK instructions or initial user input;
- `profile.model` into the SDK model selector;
- supported OpenAI inference settings into SDK run options;
- `workspace` into sandbox files/tools configuration;
- `environment.variables` into scoped sandbox environment where safe;
- `toolPolicy` into SDK tool permissions where supported;
- `skills` into SDK skill/plugin configuration where supported;
- provider-neutral progress tools into SDK tool definitions.
Provider-owned connection settings are not taken from `environment.variables`. If a materialized environment variable conflicts with OpenAI provider-owned configuration, the connection layer and adapter-owned SDK configuration win.
### Inference settings matrix

The adapter should define an explicit mapping table. At minimum it should classify each known profile setting into one of three outcomes:
- **mapped** — model and settings the SDK documents for agent runs;
- **degraded** — optional settings the profile supplied but the SDK does not support for agent runs;
- **failed** — required settings the profile marks as mandatory but the SDK cannot support.
OpenAI direct support does not imply OpenAI agent support. For example, a setting supported by OpenAI chat completions may still be degraded for `SandboxAgent` until the Agents SDK exposes it for sandbox runs.
### Native-event mapping

Implement native-event mapping as a provider-local function that accepts unknown SDK events and returns zero or one canonical `RunnerEvent` plus metadata updates. The mapper should validate every emitted event against the canonical shape before yielding it.
Mapping rules:
- assistant text chunks may be buffered into one `runner_assistant_turn` per complete assistant turn;
- ordinary tool call start/completion maps to `runner_tool_activity` with safe tool name, action, and status;
- progress-tool calls are parsed with existing progress-tool schemas and mapped to progress/notification events;
- provider errors before a terminal result become sanitized provider connection or protocol errors;
- the final SDK result emits one raw `runner_terminal_result` with `directive: 'advance'`, unless the SDK result asks a question or reports failure in a structured way that maps to `needs_input` or `fail`;
- no native provider event is persisted directly.
Event ids should use the existing adapter event-id strategy: injectable generator in tests, safe deterministic sequencing only when already used by the package convention, and ISO datetime timestamps from an injectable clock where practical.
### Result handling

The adapter should preserve the execution entry point as the owner of result validation. If the SDK final output includes a structured result candidate, the adapter can write it to the scratch-root result file expected by the current step's validation config when the scratch root exists. If no scratch root exists and the step requires a file result, the adapter emits a failure terminal result or throws a sanitized protocol error according to existing execution-entry-point behavior.
The raw `runner_terminal_result` should not embed the structured candidate. It carries only `advance`, `needs_input`, or `fail` plus a safe question or reason. The validated result crosses into core only after the existing result-tolerance pipeline succeeds.
### Metadata and telemetry

The `AgentProviderSession.metadata` promise should resolve with:
- `outcome`;
- `launchMechanism: 'fetch_transport'`;
- `degradedCapabilities`;
- `tokenUsage` with normalized token counts when the SDK exposes them;
- `model` when known.
The adapter should not add synthetic runner events for token usage. The agent orchestrator already consumes metadata and emits uniform session telemetry.
### Composition changes

Update control-plane real-runner composition so the agent adapter registry can contain both Claude and OpenAI adapters when real dispatch is enabled. The composition should preserve test injection seams, so tests can provide fake OpenAI SDK/sandbox factories or a fake adapter registry.
Explicit profile resolution should be enough for this issue. The existing `createExplicitProfileResolver` path must be updated so it derives `ResolvedAgentRunnerProfile.connectionMechanism` from the selected registered adapter's `supportedConnectionMechanism` instead of hardcoding `process_environment`. Its credential reference must likewise derive the auth target from the mechanism: `process_environment` for Claude-style subprocess launch and `header` for OpenAI `fetch_transport`. If the current control-plane option names only one default profile, integration tests may compose a role-aware explicit resolver locally or add a provider-neutral option that maps role to explicit profile id. That change must not implement issue 29's routing table or specificity logic.
### Testing plan

Use targeted unit tests for the adapter and integration tests for dispatch:
- package tests for adapter construction, SDK missing behavior, sandbox client injection, no-op snapshot configuration, per-session transport use, native event mapping, progress-tool mapping, metadata, degradation, and sanitized errors;
- execution or control-plane integration tests that register the adapter through `createAgentRunnerFactory` and drive a mocked SDK session through the agent orchestrator;
- control-plane integration coverage that proves events are consumed and re-streamed and terminal results are checkpointed;
- a role-distinct dispatch proof with Claude implementer and OpenAI reviewer using explicit profiles as two separate role-scoped runner streams;
- redaction assertions with known fake secrets, prompts, response bodies, and sandbox file contents;
- boundary validation that adapter packages import public execution APIs only.
Suggested targeted commands after implementation are:
```bash
pnpm nx test openai-agent-adapter
pnpm nx test execution
pnpm nx test control-plane -- runner-cells.integration.spec.ts
pnpm test:boundaries
pnpm validate
```
No validation command may require live OpenAI credentials. Any optional SDK dependency path must be tested with mocks or skipped only with a documented reason.
### Documentation updates

Implementation must update `context-agent/wiki/code-map.md` to record:
- the `packages/openai-agent-adapter/` package;
- the adapter id and provider kind;
- that it uses OpenAI Agents SDK `SandboxAgent`;
- that it disables snapshots with an explicit JS SDK `NoopSnapshotSpec` whose `type` is `'noop'`;
- that it uses `connection.createFetchTransport()` and no process-global OpenAI client;
- relevant tests and targeted commands.
Human-owned concept docs do not need to change for this issue unless implementation discovers a durable contract gap. If a contract gap appears, propose the concept/ADR update rather than silently changing architecture.
## Task list

### Story 1: Establish the OpenAI agent adapter package

Create the package shell and public export surface for `@autocatalyst/openai-agent-adapter` without implementing provider behavior yet. This gives later tasks a stable home for the agreed API and keeps the OpenAI agent cell separate from the existing OpenAI direct adapter.
#### Task 1.1: Add package configuration and project metadata

- **Description:** Add `packages/openai-agent-adapter/` with `package.json`, `project.json`, Vite config, TypeScript configs, README stub, and `src/index.ts`/`src/openai-agent-adapter.ts` placeholders that match existing adapter package conventions.
- **Acceptance criteria:**
	- The package name is `@autocatalyst/openai-agent-adapter`.
	- Nx tags include `type:lib`, `scope:adapter`, and `plane:execution`.
	- The package depends only on public package entry points, including `@autocatalyst/execution` and any needed `@autocatalyst/api-contract` exports.
	- No file imports from `@autocatalyst/execution/src/*`, `packages/openai-direct-adapter`, or other execution internals.
	- `pnpm nx test openai-agent-adapter` can discover the package test target.
- **Dependencies:** None.
#### Task 1.2: Export the adapter identity and seam types

- **Description:** Implement the public barrel exports: `createOpenAIAgentAdapter`, `openaiProviderKind`, `openaiAgentAdapterId`, `OpenAIAgentAdapterOptions`, logger types, SDK facade types, sandbox-client types, per-session client binding types, native-event type, and run-option types.
- **Acceptance criteria:**
	- `openaiProviderKind` is typed as `'openai'`.
	- `openaiAgentAdapterId` is typed as `'openai-agents-sdk'`.
	- `OpenAIAgentAdapterOptions` accepts SDK, sandbox-client factory, clock, event-id generator, and logger seams.
	- The default export shape does not include inference mapping or snapshot factory options outside the agreed API.
	- A compile-time import from `@autocatalyst/openai-agent-adapter` exposes the agreed symbols.
- **Dependencies:** Task 1.1.
#### Task 1.3: Add initial construction and boundary tests

- **Description:** Add unit tests that assert adapter construction, identity fields, supported connection mechanism, public exports, and package-boundary rules.
- **Acceptance criteria:**
	- Constructing the adapter returns an `AgentProviderAdapter`.
	- The adapter declares `providerKind: 'openai'`, `adapterId: 'openai-agents-sdk'`, and `supportedConnectionMechanism: 'fetch_transport'`.
	- Tests fail if the package imports execution internals or the OpenAI direct adapter.
	- Missing SDK behavior is covered by a pending or failing test that later tasks make pass with a sanitized configuration error.
- **Dependencies:** Tasks 1.1, 1.2.
### Story 2: Start safe OpenAI Agents SDK sandbox sessions

Implement session startup through the OpenAI Agents SDK `SandboxAgent` with per-session transport, injected sandbox client, and required no-op snapshot configuration. This story proves the adapter can start only when the required safety conditions are available.
#### Task 2.1: Build the SDK facade and missing-SDK failure path

- **Description:** Add a narrow internal SDK facade resolver that exposes only `SandboxAgent`, `NoopSnapshotSpec` construction/validation, local sandbox client construction, per-session client/transport construction, and run support needed by the adapter.
- **Acceptance criteria:**
	- Tests can inject a fake SDK facade without installing or importing live OpenAI credentials.
	- The production path resolves the real SDK only inside the adapter package.
	- Missing SDK availability fails at construction or session start with a typed sanitized configuration error.
	- Error messages and log fields omit SDK stack traces, credentials, prompts, transcripts, and workspace paths.
- **Dependencies:** Story 1.
#### Task 2.2: Bind every session to `connection.createFetchTransport()`

- **Description:** In `startSession`, call the supplied `AgentConnection.createFetchTransport()` and adapt it into exactly one OpenAI SDK client or transport binding.
- **Acceptance criteria:**
	- The SDK receives either `{ client }` or `{ transport }`, never both and never neither.
	- Tests prove the binding delegates provider access through the per-session fetch transport.
	- The adapter never calls process-global SDK client setters such as `setDefaultOpenAIClient`.
	- The adapter does not read OpenAI credentials from environment variables or profile settings outside the connection layer.
	- Concurrent fake sessions can receive distinct transport instances.
- **Dependencies:** Task 2.1.
#### Task 2.3: Configure `SandboxAgent`, local sandbox client injection, and workspace roots

- **Description:** Construct or run `SandboxAgent` with the task prompt, model, progress tools, mapped workspace roots, scoped environment, and injected local sandbox client/factory.
- **Acceptance criteria:**
	- Tests assert `SandboxAgent` is constructed or run for OpenAI agent sessions.
	- The fake local sandbox client/factory receives safe workspace, scoped environment, tool policy, profile, transport, and telemetry context.
	- Production sandbox composition uses a local client such as `UnixLocalSandboxClient` or `DockerSandboxClient`, not a hosted or remote sandbox provider.
	- Workspace configuration never includes ambient host paths outside the materialized workspace shape.
	- Scratch-only and no-workspace shapes are handled according to required capabilities rather than silently exposing host paths.
	- Sandbox client teardown is called when the fake SDK exposes close hooks.
- **Dependencies:** Task 2.2.
#### Task 2.4: Require explicit `NoopSnapshotSpec` support

- **Description:** Create and pass the SDK's JS no-op snapshot spec into local sandbox client or session configuration before provider work begins.
- **Acceptance criteria:**
	- Tests assert `new NoopSnapshotSpec()` is used and passed into SDK configuration.
	- Tests assert the passed snapshot spec has `type: 'noop'`, using `isNoopSnapshotSpec()` where the facade exposes it.
	- Tests assert no snapshot writer, snapshot path, workspace snapshot, or snapshot persistence hook is invoked.
	- Tests assert omitting `snapshot` and disk-persisting snapshot specs such as `{ type: 'local', ... }` are not used.
	- If no no-op snapshot API exists, session start fails before event emission with a sanitized required-capability or configuration error.
	- The adapter never falls back to SDK default snapshot behavior.
- **Dependencies:** Task 2.3.
### Story 3: Map Autocatalyst inputs to OpenAI agent sessions

Translate the authoritative `RunnerRunInput.environment` and resolved profile into provider-local SDK options while keeping unsupported behavior explicit.
#### Task 3.1: Map prompt, model, workspace, scoped variables, and telemetry context

- **Description:** Add input-mapping helpers for the task prompt, profile model, `none`/`scratch_only`/`two_roots` workspace shapes, repo/scratch/result roots, scoped environment variables, and safe telemetry metadata.
- **Acceptance criteria:**
	- The prompt is passed to SDK instructions or initial input without being logged.
	- The selected model comes from the resolved profile.
	- Scoped variables are passed only where the SDK sandbox supports them safely.
	- Provider-owned connection settings remain owned by `AgentConnection`.
	- Tests cover `two_roots`, `scratch_only`, and no-workspace mappings.
- **Dependencies:** Story 2.
#### Task 3.2: Materialize provider-neutral progress tools

- **Description:** Define OpenAI SDK tool definitions for `update_plan`, `report_progress`, and `notify` using the existing Autocatalyst progress-tool schemas.
- **Acceptance criteria:**
	- Tool schemas match `updatePlanToolInputSchema`, `reportProgressToolInputSchema`, and `notifyToolInputSchema`.
	- Progress tools are present in every supported session.
	- Tool definitions do not include credentials, raw prompts, or workspace file contents.
	- Tests prove progress-tool definitions are passed to the fake SDK.
- **Dependencies:** Task 3.1.
#### Task 3.3: Implement tool policy, skill intent, and inference setting capability mapping

- **Description:** Add a provider-local capability matrix that maps supported OpenAI agent-mode inference settings and classifies unsupported optional or required tool, skill, sandbox, and inference capabilities.
- **Acceptance criteria:**
	- Supported settings are passed to SDK run options.
	- Unsupported optional settings or skills appear in safe degradation metadata.
	- Unsupported required settings, skills, tool policy, sandbox, or snapshot behavior fail with typed sanitized errors before model work starts when possible.
	- Degradation metadata contains only safe capability names and reasons.
	- OpenAI direct-adapter support is not treated as OpenAI agent support.
- **Dependencies:** Tasks 3.1, 3.2.
### Story 4: Convert OpenAI native signals into canonical runner events

Keep OpenAI event names and provider-native values inside the adapter by converting them into validated `RunnerEvent` values and safe session metadata.
#### Task 4.1: Implement native event parsing and assistant/tool mapping

- **Description:** Add a provider-local mapper that accepts unknown SDK events, buffers assistant turns when needed, maps ordinary tool activity, and rejects malformed or impossible event sequences with sanitized protocol errors.
- **Acceptance criteria:**
	- Assistant messages map to `runner_assistant_turn`.
	- Ordinary tool calls and tool results map to `runner_tool_activity`.
	- Raw SDK events are never yielded or persisted.
	- Malformed SDK events become typed provider protocol errors with sanitized details.
	- Tests cover assistant turns, tool starts, tool completions, malformed events, and safe event ids/timestamps.
- **Dependencies:** Story 3.
#### Task 4.2: Map progress-tool and notification calls

- **Description:** Parse provider-native tool-call arguments for `update_plan`, `report_progress`, and `notify`, validate them with existing schemas, and emit canonical progress or notification events.
- **Acceptance criteria:**
	- `update_plan` maps to `runner_progress` with plan semantics.
	- `report_progress` maps to task-progress or intent progress according to the schema payload.
	- `notify` maps to `runner_notification`.
	- Invalid progress-tool payloads do not create malformed runner events.
	- Tests cover structured arguments, stringified arguments, invalid payloads, and safe fallback behavior.
- **Dependencies:** Task 4.1.
#### Task 4.3: Enforce terminal-result and metadata protocol

- **Description:** Emit exactly one raw `runner_terminal_result`, reject duplicate or missing terminal results, stop emitting after terminal, and surface token/model/outcome/degradation data through `AgentProviderSession.metadata`.
- **Acceptance criteria:**
	- A successful SDK final signal emits one terminal result with a safe directive.
	- Duplicate terminal results, missing terminal result, and events after terminal fail protocol checks.
	- Token usage and model metadata are not emitted as synthetic runner events.
	- The raw terminal result does not embed raw transcripts, structured result candidates, credentials, or workspace file contents.
	- Tests cover success, needs-input, failure, duplicate terminal, missing terminal, and events-after-terminal paths.
- **Dependencies:** Tasks 4.1, 4.2.
### Story 5: Wire the OpenAI agent cell into production dispatch

Register the OpenAI agent adapter in real-runner composition while keeping the agent orchestrator provider-neutral and preserving existing test seams.
#### Task 5.1: Register the OpenAI adapter in control-plane real-runner composition

- **Description:** Update `apps/control-plane/src/server.ts` so production real-runner composition can register `createOpenAIAgentAdapter` alongside the existing Claude agent adapter and direct adapters.
- **Acceptance criteria:**
	- The agent adapter registry can contain both Claude and OpenAI agent adapters.
	- Existing provider-adapter override seams still allow tests to inject fake registries or adapters.
	- Stub-runner and development paths remain available when intentionally selected.
	- OpenAI SDK types do not leak into control-plane code beyond adapter factory import and option wiring.
	- The production explicit profile resolver derives `connectionMechanism` from the selected registered adapter, so an explicit OpenAI agent profile resolves to `fetch_transport` and reaches `createAgentRunnerFactory` without a mechanism-mismatch failure.
	- Fetch-transport agent profiles use `credentialReference.authTarget: 'header'`; process-environment profiles keep `authTarget: 'process_environment'`.
- **Dependencies:** Stories 1, 2.
#### Task 5.2: Prove lookup through `createAgentRunnerFactory`

- **Description:** Add integration coverage that resolves an explicit OpenAI agent profile and dispatches through `createAgentRunnerFactory` and `getAgentProviderAdapterKey` instead of invoking adapter internals directly.
- **Acceptance criteria:**
	- The test selects the OpenAI adapter by provider kind and adapter id.
	- The test uses the production explicit profile resolver/composition seam and asserts the resolved OpenAI agent profile has `connectionMechanism: 'fetch_transport'`.
	- The agent orchestrator remains unchanged and does not branch on `providerKind === 'openai'`.
	- Events from the fake SDK flow through the existing runner protocol checks.
	- The test requires no live OpenAI credentials or network access.
- **Dependencies:** Task 5.1, Story 4.
#### Task 5.3: Prove Claude implementer and OpenAI reviewer dispatch in one step

- **Description:** Add a role-distinct dispatch proof that uses explicit profiles to run an `implementer` session through Claude and a `reviewer` session through OpenAI in the same step setup.
- **Acceptance criteria:**
	- The proof does not implement model-routing table resolution or fallback specificity.
	- Claude and OpenAI sessions use two distinct registered agent-provider cells.
	- The proof uses two separate role-scoped runner factory invocations for the same run id and step name, one with role `implementer` and one with role `reviewer`.
	- Events are consumed as two separate runner streams; the test does not merge them, does not expect a combined terminal result, and does not assert shared multi-role `RunStep` checkpoint semantics.
	- Both sessions yield canonical events and exactly one terminal result in their own stream.
	- The test documents that explicit profile resolution is the only routing behavior in scope.
- **Dependencies:** Task 5.2.
### Story 6: Preserve event consumer, SSE replay, and run-step checkpoint behavior

Verify OpenAI agent events use the existing execution entry point and consumer path with no OpenAI-specific event consumer.
#### Task 6.1: Test event consumer and retained event-store flow

- **Description:** Extend control-plane or execution integration tests so OpenAI adapter events pass through `consumeRunnerEvents`, persisted event storage, and `GET /v1/runs/:id/events` replay.
- **Acceptance criteria:**
	- Persisted and re-streamed events use the existing client-visible runner-event contract.
	- Protocol checks still reject wrong run ids, malformed events, duplicate terminal results, missing terminal results, and events after terminal.
	- No OpenAI-specific consumer, event-store branch, or SSE route branch is added.
	- Raw SDK events and raw provider responses are not stored.
- **Dependencies:** Story 5.
#### Task 6.2: Test terminal result validation and `RunStep` checkpoint persistence

- **Description:** Verify the raw terminal result emitted by the OpenAI adapter flows through the existing result-tolerance path before core records the checkpoint on the current `RunStep`.
- **Acceptance criteria:**
	- The execution entry point validates and normalizes the result before core receives it.
	- The validated terminal result is persisted through the same `RunStep` checkpoint handoff as other agent runs.
	- Failure or correction paths are sanitized and do not expose raw provider output or workspace content.
	- No OpenAI-specific checkpoint persistence path is added.
- **Dependencies:** Task 6.1.
### Story 7: Harden observability, redaction, and unsupported behavior

Make adapter telemetry useful for operators while proving secrets, prompts, provider bodies, transcripts, and sandbox contents do not leak through logs, errors, events, or checkpoints.
#### Task 7.1: Add safe session telemetry and logger events

- **Description:** Emit or return safe session metadata for provider, adapter id, model, inference settings, launch mechanism, duration, outcome, token-usage availability, event counts, degraded capabilities, and no-op snapshot mode.
- **Acceptance criteria:**
	- Telemetry is tagged with run, phase, step, role, provider, model, and connection mechanism where available.
	- Adapter logs include safe setup, sandbox, snapshot, degradation, and protocol-failure facts.
	- Connection request/response details remain owned by the connection layer.
	- Telemetry and logs do not include raw prompts, credentials, provider responses, transcripts, snapshot paths, or workspace file contents.
- **Dependencies:** Stories 3, 4.
#### Task 7.2: Add redaction and sanitized-error regression tests

- **Description:** Capture logs, telemetry, thrown errors, persisted events, terminal results, and checkpoints while using known fake secrets, sensitive prompt text, fake provider bodies, and sandbox file contents.
- **Acceptance criteria:**
	- Known fake secrets never appear in captured output.
	- Raw prompts, raw request bodies, raw response bodies, transcripts, and sandbox file contents never appear in captured output.
	- Missing SDK, missing `SandboxAgent`, missing no-op snapshot support, missing custom client/transport support, unsupported required inference setting, unsupported required skill, and unsupported required tool policy each produce typed sanitized failures.
	- Unsupported optional behavior appears only as safe degradation metadata.
- **Dependencies:** Task 7.1, Story 6.
### Story 8: Document and validate the implementation slice

Finish the implementation with agent-owned navigation docs and targeted validation commands so future agents can find and safely change the OpenAI agent cell.
#### Task 8.1: Update agent-owned code navigation

- **Description:** Update `context-agent/wiki/code-map.md` with the new package, provider kind, adapter id, `SandboxAgent` use, explicit `NoopSnapshotSpec` requirement, local sandbox client behavior, per-session fetch transport behavior, tests, and targeted commands.
- **Acceptance criteria:**
	- The code map points to `packages/openai-agent-adapter/`.
	- It records `providerKind: 'openai'` and `adapterId: 'openai-agents-sdk'`.
	- It states that snapshots are disabled with an explicit `NoopSnapshotSpec` whose `type` is `'noop'`.
	- It states that production sandbox execution uses a local sandbox client bound to the materialized workspace and excludes hosted/remote sandbox providers for this slice.
	- It states that provider access uses `connection.createFetchTransport()` and never a process-global OpenAI client.
	- It lists relevant unit and integration test files.
- **Dependencies:** Stories 1-7.
#### Task 8.2: Run targeted and broad validation

- **Description:** Run the agreed test and validation commands, using mocked SDK/sandbox seams and no live OpenAI credentials.
- **Acceptance criteria:**
	- `pnpm nx test openai-agent-adapter` passes.
	- `pnpm nx test execution` passes or any unrelated existing failure is documented with evidence.
	- `pnpm nx test control-plane -- runner-cells.integration.spec.ts` or the repository's equivalent targeted integration command passes.
	- `pnpm test:boundaries` passes.
	- `pnpm validate` passes or any unrelated existing failure is documented with evidence.
	- Any skipped command includes the exact reason and remaining risk.
- **Dependencies:** Task 8.1.