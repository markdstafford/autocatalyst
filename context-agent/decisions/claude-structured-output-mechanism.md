---
date: 2026-06-23
status: accepted
superseded_by: null
---
# claude-structured-output-mechanism
**Decision:** Use MCP-based `submit_result` tool via `createSdkMcpServer` for Claude structured output.
**Rationale:**
- `@anthropic-ai/claude-agent-sdk` wraps the Claude Code CLI subprocess; it does not expose `outputFormat` or `outputType` options on `query`
- OpenAI's `SandboxAgent` natively supports `outputType` (JSON schema) — Claude's SDK has no equivalent
- `createSdkMcpServer` + `submit_result` tool is the only SDK-sanctioned structured-result mechanism for Claude agent sessions
- Changing this requires explicit human approval
**Constraints:** SDK API boundary — must not rely on internal CLI flags or undocumented behavior
**Rejected:** Native `outputFormat` — not exposed by `@anthropic-ai/claude-agent-sdk`; requires human approval to re-evaluate when SDK is upgraded
