---
date: 2026-10-23
status: accepted
superseded_by: null
---
# Codex account authentication and wire boundary
**Decision:** Let an adapter explicitly declare external authentication, and test Codex through its versioned JSON-RPC subprocess boundary.
**Rationale:**
- API-secret requirements remain the default; Codex validates the operator's enterprise sign-in without resolving an API secret.
- Native-event mocks alone missed an invented launch message and unsupported login flag. Executable fixtures now exercise initialize/account/thread/turn and failure notifications.
- Runtime skills use actual catalog SKILL.md input items, not unmounted virtual paths; unrelated plugins/skills and host MCP tools are excluded from the model session.
**Constraints:** Pin CLI 0.160.1; enforce explicit sandbox policies and schema validation before result writes; bound subprocess lifetime and never retry a model session. Actual OS permission verification starts no model turn. Human-owned transport addendum remains proposed for review.
**Rejected:** Copying cached credentials or API-key fallback — wrong identity/billing boundary; accepting a final message as successful completion without turn/completed — hides failed turns; fake-session tests as sole proof — do not exercise the production protocol.
