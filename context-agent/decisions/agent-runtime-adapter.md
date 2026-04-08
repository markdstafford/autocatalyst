---
date: 2026-04-08
status: accepted
superseded_by: null
---

# Agent runtime adapter

**Decision:** oh-my-claudecode (OMC) via `claude` CLI subprocess as the initial implementation. Adapter interface defined for future backends.

**Rationale:**
- OMC provides multi-agent orchestration (`/autopilot`, `/team`) on top of Claude Code — no need to build this ourselves
- `claude` CLI subprocess is the simplest integration: spawn process, pass spec as context, stream output, detect exit
- OMC is TypeScript (same as the service) — debugging and interop are straightforward
- The adapter interface is small: `start(spec, workspace)`, `stream(run)`, `stop(run)`

**Adapter interface:**
- `start(spec: string, workspace: string): RunHandle` — launch agent with spec context in workspace directory
- `stream(run: RunHandle): AsyncIterable<AgentEvent>` — stream agent events (progress, tool calls, output)
- `stop(run: RunHandle): void` — terminate agent run
- `status(run: RunHandle): RunStatus` — check if agent is running, completed, or failed

**Constraints:**
- Must work with `claude` CLI as a subprocess (not a library import)
- Must stream events for observability (not just wait for exit)
- Interface must be backend-agnostic — future adapters for oh-my-codex, claw, or others implement the same interface

**Rejected:**
- Direct Anthropic API integration (skip OMC): loses multi-agent orchestration; would need to rebuild what OMC provides
- claw CLI instead of claude CLI: we use Claude Code, not the claw reimplementation
- Library import instead of subprocess: OMC is designed to run via CLI, not as an embedded library
