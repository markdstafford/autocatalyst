---
date: 2026-04-25
status: accepted
superseded_by: null
---

# Provider boundary and clean config

**Decision:** Provider-specific concepts stay in provider adapters; core, types, and config use provider-neutral refs, artifacts, ports, and registries.

**Rationale:**
- The core should not know Slack thread IDs, Notion page shapes, GitHub implementation classes, or provider-specific config blocks.
- Clean provider boundaries make new channels and publishers additive: add an adapter and register it, rather than teaching the orchestrator a new provider.
- This repo has minimal production usage, so removing compatibility shims is lower risk than carrying stale dual paths.
- A provider-boundary characterization test prevents accidental leaks back into `src/core`, `src/types`, and `src/config`.

**Constraints:**
- Built-in adapter composition may import provider implementations; core runtime composition may not.
- Config is breaking: provider settings live under `channels[].config` and `publishers[].config`.
- AI interaction providers follow the same rule: core depends on `DirectModelRunner`, `AgentRunner`, and domain AI ports; Anthropic and Claude Agent SDK code stays in provider adapters.

**Rejected:**
- Preserving legacy top-level provider config: easier short term, but it keeps two canonical shapes and obscures extension boundaries.
- Keeping top-level artifact compatibility fields on `Run`: simple migration path, but it keeps the old spec-specific model alive beside `artifact`.
