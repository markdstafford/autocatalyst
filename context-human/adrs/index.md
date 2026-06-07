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
| [ADR-013 — Core domain vocabulary](adr-013-core-domain-vocabulary.md) | `Conversation`, `Topic`, `Message`, `Run`, `Project`. |
| [ADR-014 — Work hierarchy](adr-014-work-hierarchy.md) | The `Conversation -> Topic -> Run` hierarchy; one active run per topic as a durable database invariant. |
| [ADR-015 — Run lifecycle](adr-015-run-lifecycle.md) | A workflow-driven step machine; phases `spec`/`implementation`/`docs`/`pr`; intrinsic `waiting_on`; cost per session (rolled up through `(step, role)`); a per-state recovery policy owned by `run`. |
| [ADR-016 — Intent model](adr-016-intent-model.md) | Window-intent is the workflow; `MessageIntent` is transient; no durable `WorkKind`. |
| [ADR-017 — Single Artifact model](adr-017-single-artifact-model.md) | One `Artifact` model, defined by visibility outside Autocatalyst on approval. |
| [ADR-018 — Feedback first-class](adr-018-feedback-first-class.md) | `Feedback` is a first-class, run-parented, run-gating entity with a per-item thread. |
| [ADR-019 — Persistence layout](adr-019-persistence-layout.md) | Normalized tables for entities, embedded JSON for value objects. |
| [ADR-020 — Workspace isolation primitive](adr-020-workspace-isolation-primitive.md) | A per-run workspace is a git worktree of the host repository on a run-owned branch; a clone from `repo_url` is reserved for non-co-located execution workers. |
| [ADR-021 — Workspace lifecycle and reclamation](adr-021-workspace-lifecycle-reclamation.md) | Workspace created and torn down as a unit keyed to the `Run`; retention per terminal state across worktree/branch axes; a missing workspace re-materialized, never dropped; a scheduled workspace garbage collection. |
| [ADR-022 — Runner structure](adr-022-runner-structure.md) | One connection layer + two mode orchestrators (agent/direct) + one provider adapter per cell; symmetric dispatch; provider identity confined to the adapter. |
| [ADR-023 — Request-alteration boundary](adr-023-request-alteration-boundary.md) | Per-endpoint request alteration owned by the connection layer, used by every runner: header rewrite, `base_url`/auth, timeout/retry, redacted request/response logging. |
| [ADR-024 — Role-aware routing key](adr-024-role-aware-routing-key.md) | Agent work routes on `(step, role)`, direct calls on `(step)`; specificity-ordered resolution with a typed miss; role-distinct models expressible; overrides additive. |
| [ADR-025 — Workflow step catalog and composition](adr-025-workflow-step-catalog.md) | Steps are code primitives, a workflow is data composing a subset; `spec.*` catalog with explicit `phase`; `build` completes from agreed branch state; configurable implementation depth; `pr.finalize` is the final `ai` review with the spec freeze a side effect, separate from `pr.open`; `file_issue` writes through a deterministic `issues.file` step; `revise` generalized to the table's target. |
| [ADR-026 — In-step convergence review](adr-026-in-step-convergence-review.md) | A reviewer is a role inside the producing step; the implementer decides convergence and the reviewer cannot veto; advance on convergence or human sign-off, escalate at max rounds; depth configurable; a finding is a `Feedback` item; single-model warns, never skips. |
| [ADR-027 — Contract verification at step boundaries](adr-027-step-contract-verification.md) | Each step declares its result shape; deterministic repair then validation; a fixable violation returns to the agent before downstream logic runs; distinct from the quality convergence loop. |
| [ADR-028 — Spec amendable through implementation](adr-028-spec-amendable-through-implementation.md) | The spec gate is approve-to-build-from; the implementer amends the spec then makes the change, confirmed at the implementation gate; freeze at `pr.finalize`, durable at merge. |
| [ADR-029 — Compaction and doc-update step](adr-029-compaction-doc-update-step.md) | A `docs` phase between implementation and pr; `docs.update` runs bottom-up compaction; `docs.human_review` gates the human-owned doc diffs and skips when there are none; doc changes land on the code's branch. |
