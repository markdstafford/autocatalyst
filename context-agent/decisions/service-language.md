---
date: 2026-04-08
status: accepted
superseded_by: null
---

# Service language and runtime

**Decision:** TypeScript on Node.js.

**Rationale:**
- oh-my-claudecode (OMC) is TypeScript — shared language reduces friction at the adapter boundary
- Slack Bolt SDK is Node-native and best-in-class
- TypeScript's type system catches errors at compile time — faster feedback loops for agents
- Well-represented in LLM training data — agents write fluent TypeScript
- Mature containerization story (Node Docker images, small Alpine variants)
- Strong async I/O primitives (`async/await`, streams) for the event-driven orchestrator

**Constraints:**
- Must support async I/O (orchestrator is event-driven with concurrent agent runs)
- Must containerize cleanly (hosted deployment is a target)
- Must have strong Slack SDK support (initial human interface adapter)
- Agents will write all code — language must be one agents handle well

**Rejected:**
- Python: weaker type system (optional typing, no compile-time checks); Slack SDK is adequate but not Node-quality
- Go: verbose for the amount of adapter/glue code this service needs; less fluent agent output
- Elixir: excellent concurrency model (Symphony uses it) but niche — agents produce less reliable Elixir
