---
date: 2026-05-17
status: accepted
superseded_by: null
---
# Claude Code Grove beta header filter
**Decision:** The Claude Agent SDK loopback beta-header filter is enabled by endpoint config: Anthropic endpoints with `anthropic_beta_header_filter.strip` route SDK traffic through loopback and remove only those configured values.
**Rationale:**
- Claude Code sends `advisor-tool-2026-03-01` in model API requests even when Autocatalyst did not request that beta.
- Grove Azure APIM rejects unknown `anthropic-beta` values before the request reaches the Anthropic-compatible backend.
- The SDK bump to `@anthropic-ai/claude-agent-sdk` 0.3.143 still requires removing the advisor beta for Grove-routed Claude Agent SDK calls.
- The denylist belongs on the endpoint because the compatibility issue is with a gateway route, not with a task profile.
**Constraints:** The proxy must not affect Anthropic direct model calls. When configured, the proxy binds only to `127.0.0.1`, forwards to the configured `base_url`, preserves non-hop-by-hop headers and streaming responses, and filters no beta value except values listed in endpoint config.
**Rejected:**
- Patching `node_modules` or the Claude Code binary: not durable across installs or upgrades.
- Removing all beta headers: would break supported betas such as context, effort, or task budgets.
- Moving affected tasks to OpenAI routes: avoids this incident but leaves the Claude adapter broken for configured Claude Agent SDK profiles.
