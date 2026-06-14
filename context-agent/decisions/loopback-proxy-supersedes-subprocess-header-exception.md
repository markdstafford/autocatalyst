---
date: 2026-06-14
status: accepted
superseded_by: null
---
# Loopback proxy supersedes subprocess header-control exception
**Decision:** Claude process-environment sessions satisfy endpoint auth-header injection, header stripping/filtering, and request dumps through the execution loopback proxy when the SDK can be pointed at a loopback base URL.
**Rationale:**
- ADR-023's subprocess exception blocked Grove `api-key` authentication and request observability.
- The proxy keeps endpoint-owned policy in the connection layer instead of adding provider-specific orchestration code.
- The Phase 1 `ANTHROPIC_CUSTOM_HEADERS` mapping remains an additive stopgap; it cannot strip SDK default headers.
**Constraints:**
- Request logging is default-off; dump files stay under an app-owned diagnostic root.
- Direct cells continue using fetch alteration unless a future decision requires a universal proxy path.
**Rejected:** Provider-specific Grove workaround in the Claude adapter — duplicates connection-layer policy and does not solve observability.
