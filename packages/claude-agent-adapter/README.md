# @autocatalyst/claude-agent-adapter

`AgentProviderAdapter` implementation for the Anthropic Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`). This package implements the
`process_environment` connection mechanism: the SDK launches and drives the
`claude` subprocess, and **all HTTPS model traffic occurs OUTSIDE the
Autocatalyst Node process**. The Autocatalyst Node process never carries the
model bytes.

## SDK surface and consequences

- Package: `@anthropic-ai/claude-agent-sdk`.
- The SDK runs the `claude` CLI as an autonomous agent. There is **no
  supported in-process** custom `fetch`, `baseURL`, request timeout, or
  per-request header hook for the model traffic that the spawned `claude`
  process performs.
- All provider tuning therefore flows through the connection-owned environment
  the adapter receives from `AgentConnection.createProcessLaunchConfig()`.
  The following env vars are claimed exclusively by the connection layer and
  passed through to the spawned `claude` process:
  - `ANTHROPIC_BASE_URL`
  - `ANTHROPIC_AUTH_TOKEN`
  - `ANTHROPIC_API_KEY`
  - `ANTHROPIC_CUSTOM_HEADERS`
  - `API_TIMEOUT_MS`
  - `CLAUDE_CODE_MAX_RETRIES`

  See `@autocatalyst/execution` `claudeProviderOwnedEnvironmentVariables`.
- The adapter MUST NOT call `AgentConnection.createFetchTransport()` — that
  is the wrong mechanism for this provider, and the connection layer will
  reject it.

## Inference setting capability

The Claude Agent SDK runs Claude Code autonomously. Inference settings such as
`temperature`, `topP`, `maxOutputTokens`, `reasoningEffort`, and `seed` are
Messages-API concerns and are **not** plumbed into the agent-mode launch.
- If a profile sets one of these and the endpoint does **not** mark it as a
  `requiredAlterations.inferenceSettings` entry, the adapter records a
  `ProviderCapabilityDegradation` on the session metadata.
- If a profile sets one of these and the endpoint **does** mark it required,
  the adapter throws `UnsupportedProviderCapabilityError('inference_setting_unsupported')`
  at `startSession`.

## Native event shapes consumed by the adapter

The injectable `ClaudeSessionLaunch` seam yields `ClaudeNativeEvent` values
that approximate the SDK's wire protocol:

- `{ type: 'assistant', content: string }` — assistant text turn.
- `{ type: 'tool_use', tool: { name: string, input?: unknown } }` — tool call.
  Special-cased tool names: `update_plan`, `report_progress`, `notify` are
  mapped to canonical `runner_progress` / `runner_notification` events. All
  other tools become `runner_tool_activity`.
- `{ type: 'result', result: { output?: string, total_tokens?, input_tokens?, output_tokens? } }`
  — terminal result. The adapter writes `output` to the scratch step result
  file (if a scratch root is materialized) and emits a
  `runner_terminal_result { directive: 'advance' }` event.
- `{ type: 'system' | <unknown> }` — logged and skipped.

## Identity

- `providerKind`: `'anthropic'`
- `adapterId`: `'claude-agent-sdk'`
- `supportedConnectionMechanism`: `'process_environment'`
