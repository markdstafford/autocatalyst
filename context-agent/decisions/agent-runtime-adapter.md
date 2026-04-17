---
date: 2026-04-08
status: accepted
superseded_by: null
---

# Agent runtime adapter

**Decision:** `@anthropic-ai/claude-agent-sdk` via the `query()` function as the initial implementation. Adapter interface defined for future backends.

**Rationale:**
- Agent SDK `query()` provides direct, streaming access to Claude — no subprocess overhead or CLI dependency
- `query()` is a first-class TypeScript API (same language as the service) — type-safe and easy to test
- The adapter interface is small: `start(spec, workspace)`, `stream(run)`, `stop(run)`

**Adapter interface:**
- `start(spec: string, workspace: string): RunHandle` — launch agent with spec context in workspace directory
- `stream(run: RunHandle): AsyncIterable<AgentEvent>` — stream agent events (progress, tool calls, output)
- `stop(run: RunHandle): void` — terminate agent run
- `status(run: RunHandle): RunStatus` — check if agent is running, completed, or failed

**Constraints:**
- Must work with `@anthropic-ai/claude-agent-sdk` as a library import (not a subprocess)
- Must stream events for observability (not just wait for exit)
- Interface must be backend-agnostic — future adapters implement the same interface

**Rejected:**
- oh-my-claudecode (OMC) subprocess instead of Agent SDK: subprocess spawning adds process management overhead and CLI version dependencies; Agent SDK provides the same capability as a typed library import
- claw CLI instead of claude CLI: we use Claude Code, not the claw reimplementation
- Direct subprocess CLI: subprocess is the simplest integration but requires managing process lifecycle and stdout parsing
