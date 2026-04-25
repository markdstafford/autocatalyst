---
date: 2026-04-25
status: accepted
superseded_by: null
---

# AI runner ports

**Decision:** Core AI behavior depends on `DirectModelRunner` for direct model calls and `AgentRunner` for tool-using agent sessions.

**Rationale:**
- Intent classification is a bounded direct model task and should not inherit user filesystem settings.
- Artifact authoring, implementation, issue triage, and repo-aware question answering need tools, so they use `AgentRunner`.
- `AgentRunner` accepts an explicit working directory but does not imply a cloned run workspace; question answering runs in the base repo.
- Route/profile metadata allows future model and settings choices by task, stage, intent, and artifact kind without changing handlers.
- Plugin-dependent routes load Claude Code plugins explicitly through the Claude adapter: `mm` for artifact authoring and issue triage, `superpowers` for implementation.

**Constraints:**
- Anthropic direct model calls and Claude Agent SDK are the only built-in providers in this stage.
- Claude Agent SDK options must set adaptive thinking and effort explicitly to avoid inherited fixed-thinking failures.
- Claude user settings are not loaded by runtime routes. Plugin-dependent routes use explicit plugin configs plus project settings only.

**Rejected:**
- Keeping prompt/result parsing in provider adapters: makes providers own domain behavior and blocks swapping runners.
- Naming the port `WorkspaceAgentRunner`: inaccurate because some agent tasks run in the base repo.
