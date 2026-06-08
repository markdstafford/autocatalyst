---
date: 2026-06-08
status: accepted
superseded_by: null
---
# Principal request context
**Decision:** Use a module-private Symbol key to store the authenticated principal on Fastify request objects, accessed only via `requirePrincipalFromRequest` / `setPrincipalOnRequest` in `packages/core/src/principal.ts`.
**Rationale:**
- Avoids type-casting request objects across the codebase
- Symbol keys cannot collide with Fastify internals or user-defined properties
- A single access point throws a typed error if a protected route is reached without a principal (programming error, not a user error)
**Constraints:** Requires all principal access to go through the core package functions
**Rejected:** Decorating FastifyRequest via TypeScript interface merging — couples all consumers to a shared type augmentation file and still requires casting at the decorator call site
