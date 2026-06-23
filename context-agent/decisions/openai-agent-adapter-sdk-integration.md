---
date: 2026-06-10
status: accepted
superseded_by: openai-agent-responses-streaming-continuity.md
---
# openai-agent-adapter — real @openai/agents SDK integration

**Decision:** The OpenAI agent adapter integrates the real `@openai/agents` 0.11.6 SDK directly (no facade), binding the model provider per-session via `new Runner({ modelProvider })` and materializing the workspace into a real `UnixLocalSandboxClient`. `@openai/agents` + `openai` are real `dependencies`; the adapter pins `zod@^4` for itself while the rest of the repo stays on `zod@3.25`.

**Rationale:**
- The previous adapter was written against an invented API (`agent.run(...)`, `sdk.createClientBinding`, an `OpenAIAgentsSdkFacade`) and the SDK was never installed, so its tests proved nothing.
- The real per-call `run()` options have no `modelProvider`; only `RunConfig` does. So the per-session, no-global binding must go through `new Runner({ modelProvider })`, then `runner.run(agent, prompt, { sandbox: { session } })`. The `setDefault*` globals are never used (a source-scan test enforces this).
- The OpenAI client's `fetch` is bridged to `connection.createFetchTransport()`; `useResponses: true` selects the Responses API required for tool-using agent sessions (superseded `useResponses: false`/Chat Completions approach — see `openai-agent-responses-streaming-continuity.md`).
- `UnixLocalSandboxClient` materializes `localDir({ src })` entries only if the source is granted via `manifest.extraPathGrants` (default base is cwd). Each declared workspace root gets a `localDir` entry **and** a path grant.
- At least one test imports the real module and drives a full session with only the injected OpenAI client's `fetch` mocked — proving the real path, not a fake.

**Constraints:**
- `exactOptionalPropertyTypes: true`: the SDK's own `Agent`/`RunResult` generics do **not** round-trip under it (optional fields lack `| undefined`). The adapter narrows the run result to a small structural `NonStreamRunResultView` (`newItems`/`finalOutput`/`state._context.usage`) instead of naming `RunResult<_, SandboxAgent>`.
- NodeNext dual CJS/ESM resolution makes `openai`'s `OpenAI` type nominally distinct between our default-mode import and `OpenAIProvider`'s import-mode `.d.ts`; the client is cast `as unknown as` the provider's own expected option type. Same runtime class — a pure type-identity artifact.
- **zod 4 is scoped to this package.** The SDK peers on `zod@^4`; it crashes at module load under zod 3.25 (`discriminatedUnion`). Adding `zod@^4` to the adapter's `dependencies` makes pnpm resolve the SDK's zod peer to v4 within the adapter's subtree while the workspace root keeps zod 3.25. Do NOT add a `pnpm.peerDependencyRules` allowing zod 3 for these packages — it silently installs a broken SDK.
- New `UnsupportedProviderCapabilityErrorCode`s added to execution: `sandbox_client_unsupported`, `sandbox_snapshot_unsupported`, `workspace_containment_violation`.

**Rejected:**
- Keeping the `OpenAIAgentsSdkFacade` seam — it encoded an API that does not exist; replaced by two real-SDK-default seams (`sandboxClientFactory`, `runAgentSession`) for test injection only.
- Forcing the whole repo to zod 4 — too broad/risky for one adapter; scoped install is contained.
- `setDefaultModelProvider`/`setDefaultOpenAIClient` (process-global) — violates the per-session, no-global-client requirement.
- `useResponses: false` (Chat Completions) for OpenAI agent sessions — routes tool-using agent traffic through Chat Completions and fails reasoning-model scenarios; superseded by `openai-agent-responses-streaming-continuity.md`.
