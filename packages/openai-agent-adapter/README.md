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
