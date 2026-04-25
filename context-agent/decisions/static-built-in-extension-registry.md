---
date: 2026-04-25
status: accepted
superseded_by: null
---

# Static built-in extension registry

**Decision:** Built-in providers are declared in a static extension registry; runtime composition consumes the registry while wiring Slack, Notion, Slack Canvas, GitHub, Agent SDK, Anthropic intent classification, default intents, and default commands.

**Rationale:**
- The codebase needs explicit provider boundaries before it needs dynamic plugin loading.
- Static registration makes the current supported surface visible to agents and tests without introducing package loading, versioning, or sandbox concerns.
- Runtime composition consumes provider-shaped config and selects from declared built-ins.
- Future provider work has a clear path: add a provider declaration, add its adapter/factory, then wire it into composition or a later plugin loader.

**Constraints:**
- Legacy provider-specific top-level config is intentionally not supported in this refactor; config now uses `channels[]` and `publishers[]` with provider-local settings under `config`.
- Only built-in static extensions are supported in this refactor.
- AI interaction points remain Anthropic/Agent SDK for now and will get the same provider treatment in a later stage.

**Rejected:**
- Dynamic plugins now: more moving parts than the current architecture needs.
- Unregistered provider strings in runtime composition: easy to add accidentally and hard for future agents to discover.
