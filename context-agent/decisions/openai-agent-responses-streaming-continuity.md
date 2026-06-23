---
date: 2026-06-23
status: accepted
superseded_by: null
---
# openai-agent-responses-streaming-continuity
**Decision:** OpenAI agent sessions use the Agents SDK Responses path, live SDK streaming, and explicit model-memory continuity across turns.
**Rationale:**
- Reasoning models and tool-using OpenAI agent sessions require the Responses model path; Chat Completions belongs to the direct adapter or legacy non-agent paths.
- `useResponses: true` selects the transport but does not by itself preserve follow-up-turn context.
- Live user-visible progress requires consuming the SDK streaming result as it yields events, not awaiting a non-streaming `RunResult` and replaying `newItems`.
**Constraints:**
- Provider traffic still goes through `connection.createFetchTransport()` and must not use process-global OpenAI SDK setters.
- The sandbox session is workspace/tool execution state only; model-memory state must come from an SDK `Session` or Responses `conversationId` / `previousResponseId`.
- Tests must prove pre-completion event delivery and turn-continuity state reuse.
**Rejected:**
- `useResponses: false` for OpenAI agent sessions — routes tool-using agent traffic through Chat Completions and fails reasoning-model scenarios.
- Treating `SandboxAgent` sandbox session reuse as conversation memory — it does not satisfy the model-turn continuity contract.
