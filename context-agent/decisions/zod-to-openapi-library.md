---
date: 2026-06-07
status: accepted
superseded_by: null
---
# zod-to-openapi library

**Decision:** Use `@asteasolutions/zod-to-openapi` as the Zod registry-based OpenAPI generator for the control-plane API contract.
**Rationale:**
- Keeps Zod schemas as the single source of truth for request/response shapes
- Derives OpenAPI documents from the same schemas used for runtime validation and TypeScript inference
- Route metadata (method/path/status) is registered once from contract constants
**Constraints:** Must not hand-author OpenAPI path objects independently from schemas and route constants
**Rejected:** Hand-authored OpenAPI YAML — duplicates shape definitions; zod-openapi (alternative library) — @asteasolutions has cleaner registry API
