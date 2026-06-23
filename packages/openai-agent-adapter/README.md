# @autocatalyst/openai-agent-adapter

`AgentProviderAdapter` implementation for OpenAI agent-mode runs backed by the
OpenAI Agents SDK `SandboxAgent`.

## Identity

- `providerKind`: `openai`
- `adapterId`: `openai-agents-sdk`
- `supportedConnectionMechanism`: `fetch_transport`

## Runtime contract

- Model/provider access uses the per-session `connection.createFetchTransport()` handle.
- The adapter never calls process-global OpenAI SDK client setters.
- Tool execution runs through a local sandbox client bound to the run's materialized workspace roots.
- Snapshot persistence is disabled by explicitly passing the JS SDK `NoopSnapshotSpec` with `type: 'noop'`.
- Hosted or remote sandbox providers are outside this package's production behavior for this slice.
- Native SDK events are mapped to canonical `RunnerEvent` values before they leave the package.
- `useResponses: true` selects the Responses API for OpenAI agent-mode traffic. Chat Completions is not a fallback for tool-using agent sessions.
- Each Autocatalyst run turn maps to one `Runner.run(..., { stream: true })` call.
- The adapter consumes SDK stream events incrementally and maps surfaced assistant/tool/progress signals to canonical `RunnerEvent` values before the SDK run completes.
- OpenAI model-memory continuity is separate from the sandbox session. The adapter loads/saves Responses continuity (`conversationId` and/or `previousResponseId`) through the execution model-memory store. The sandbox session remains only tool/workspace execution state.

## Real SDK wiring (`@openai/agents` 0.11.x)

- Imports `run`/`Runner`/`OpenAIProvider`/`tool` from `@openai/agents`, and
  `SandboxAgent`/`Manifest`/`NoopSnapshotSpec`/`isNoopSnapshotSpec`/`localDir`
  from `@openai/agents/sandbox`, and `UnixLocalSandboxClient` from
  `@openai/agents/sandbox/local`. `openai` and `zod` (v4) are direct deps.
- Per-session binding, never a global: a per-session `OpenAI` client is built
  with its `fetch` bridged to `connection.createFetchTransport()`, wrapped in an
  `OpenAIProvider`, and passed to a per-session `new Runner({ modelProvider })`.
  The SDK's `setDefault*` global setters are never called.
- `useResponses: true` selects the Responses API wire format required for tool-using OpenAI agent sessions.
- Workspace materialization: each declared workspace root becomes a `localDir`
  manifest entry plus an `extraPathGrants` entry (the local sandbox otherwise
  restricts `local_dir` sources to its own base dir). `UnixLocalSandboxClient`
  is constructed with `{ workspaceBaseDir, snapshot }` and `client.create(manifest)`
  opens the session; `runner.run(agent, prompt, { sandbox: { session } })` drives it.
- Mapping seam: the run driver yields the SDK's `RunItem`s (`message_output_item`,
  `tool_call_item`, `tool_call_output_item`); the adapter maps those plus
  `result.finalOutput` (step-result file) and `state._context.usage` (tokens).
- Two injectable seams (`sandboxClientFactory`, `runAgentSession`) default to the
  real SDK; tests inject fakes for dispatch wiring, while the package's own spec
  drives the **real** module with only the OpenAI client's `fetch` mocked.
