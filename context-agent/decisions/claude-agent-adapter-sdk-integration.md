---
date: 2026-10-21
status: accepted
superseded_by: null
doc_id: 501708c4-d473-4f4a-9bb2-f11a5e4f7540
---
# claude-agent-adapter — real Claude Agent SDK dependency ownership
**Decision:** `@autocatalyst/claude-agent-adapter` owns `@anthropic-ai/claude-agent-sdk` and the SDK peers needed to resolve it under pnpm, instead of relying on `apps/control-plane` to host those dependencies.
**Rationale:**
- The adapter dynamically imports the SDK from inside the adapter package at runtime.
- pnpm workspace symlinks resolve that import from the package's real path, so app-level dependencies do not satisfy the adapter's runtime import.
- This matches the OpenAI agent adapter pattern: real provider SDK dependencies live with the provider adapter that imports them.
**Constraints:**
- `@nx/dependency-checks` cannot see dynamic imports or peer-satisfaction dependencies, so the package-json lint override must list the Claude SDK and its peer dependencies.
- `zod@^4` is scoped to the adapter package so the rest of the workspace can remain on Zod 3.
**Rejected:** Keeping `@anthropic-ai/claude-agent-sdk` as an optional peer hosted by `apps/control-plane` — it can pass app-level checks while still failing when the adapter starts a real Claude Agent SDK session.
