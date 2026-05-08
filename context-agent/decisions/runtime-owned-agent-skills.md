---
date: 2026-05-08
status: accepted
superseded_by: null
---

# Runtime-owned agent skills

**Decision:** Agent route skills are committed under `runtime-skills/` and resolved through provider-neutral skill refs before any provider adapter materializes them.

**Rationale:**
- Runtime routes depend on `mm` and `superpowers` as first-class execution inputs, not contributor-local editor settings.
- Route-scoped skill refs let Autocatalyst load only the skills each route needs.
- A provider-neutral catalog gives Claude and future OpenAI runners the same source of truth.

**Constraints:**
- Core may declare skill refs, but provider-specific plugin directory shaping stays in adapters.
- `mm` remains the canonical namespace for micromanager skills.
- OpenAI runner wiring is deferred to issue 112.

**Rejected:**
- `context-agent/` skill storage: those files are runtime assets, not repo-maintenance context.
- Full plugin loading: simpler, but it loads unrelated skills for each route.
- Prompt-only skill references: easy to add, but not enforceable or portable across runners.
