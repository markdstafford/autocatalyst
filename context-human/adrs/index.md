---
created: 2026-06-04
last_updated: 2026-06-07
purpose: Index of the architecture decision records — read this to find the right ADR without opening each.
---

# ADR index

The architecture decision records, in order. See each ADR's frontmatter for its current `status`,
which changes over time.

| ADR | Decision |
| --- | --- |
| [ADR-001 — Language runtime](adr-001-language-runtime.md) | TypeScript on Node.js LTS. |
| [ADR-002 — Monorepo tooling](adr-002-monorepo-tooling.md) | Nx monorepo on pnpm; module boundaries enforced by tooling. |
| [ADR-003 — Hosting and plane boundary](adr-003-hosting-and-plane-boundary.md) | Standalone network-API control plane; host-side execution behind a no-shared-memory `Runner`. |
| [ADR-004 — Persistence and state store](adr-004-persistence-state-store.md) | SQLite via Drizzle behind a repository abstraction; Postgres on a named trigger. |
| [ADR-005 — API style and transport](adr-005-api-style-transport.md) | Typed contract-first REST plus SSE, served by Fastify. |
| [ADR-006 — API versioning](adr-006-api-versioning.md) | Version under a `/v1` URL prefix; additive-only within a version. |
| [ADR-007 — Shared types](adr-007-shared-types.md) | One `api-contract` package of Zod schemas; types, validation, and OpenAPI derived from it. |
| [ADR-008 — Configuration model](adr-008-config-model.md) | Service-owned configuration in the database via the API; minimal bootstrap config. |
| [ADR-009 — Auth/RBAC envelope](adr-009-auth-rbac-envelope.md) | A `Principal` (with a human/model/system `kind`) and policy-point seam now, wired with one hardcoded principal. |
| [ADR-010 — Agent execution context](adr-010-agent-execution-context.md) | A declarative per-run Execution Context; least-privilege hardening sequenced. |
| [ADR-011 — Extension registry role](adr-011-extension-registry-role.md) | The extension registry is a descriptive catalog, not a gate; a configured provider is valid when its adapter id resolves to code, the registry entry advisory. |
| [ADR-012 — LLM output tolerance](adr-012-llm-output-tolerance.md) | Treat model output as a soft contract via a tolerance pipeline. |
