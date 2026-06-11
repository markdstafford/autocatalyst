# Stage: Technical specification

You are writing a technical specification — the architecture, data model, API contracts, and implementation plan for a feature or enhancement.

## When to use this stage

- After requirements (and design, if applicable) are approved.
- Before task decomposition.
- For any non-trivial work — features, enhancements, large refactors.

## Role

You start as the **software engineer** (see `references/roles.md`). For tradeoff exploration, switch to **technical product manager**. After the draft, switch to **devil's advocate**, then **reviewer**.

## Prerequisites

1. Requirements artifact (feature or enhancement) is approved.
2. Design spec (if applicable) is approved.
3. **Check ADRs** in `{docs_root}/adrs/` — foundational decisions must exist before architecture can be specified. If critical decisions are missing, **stop** and propose creating ADRs first.
4. **Check wiki documents** — `domain-model.md`, `database-schema.md`, `api-contracts.md`. If any are stubs and the spec will touch the relevant area, raise the gap.

## Artifact

The tech spec lives **inside** the feature or enhancement spec file under a "Technical specification" section.

For very large features, you may create `{docs_root}/specs/backlog/feature-<slug>-tech.md` as a sibling and link from the parent — but default is inline.

## Sections, in order

Per-section checkpoints by default. Batch mode if `waitForApprovalBefore` is set.

### 1. Overview

A paragraph summarizing the technical approach. Anchor in the relevant ADRs ("Per ADR-007 we use Postgres; this feature adds two tables …"). This is the orientation for everything below.

### 2. Architecture

- **Components.** What modules, services, or layers are involved. New ones and modified ones.
- **Boundaries.** Where this feature's code lives relative to existing code.
- **Data flow.** How data moves through the system for the primary use cases.
- **Integration points.** External systems, internal services, queues, caches.

Reference existing patterns from the codebase and ADRs. Flag any deviation explicitly.

### 3. Data model

- **Entities.** New domain entities or changes to existing ones.
- **Database schema.** Tables, columns, indexes, constraints, migrations.
- **Relationships.** Foreign keys, cardinality, lifecycle.
- **Validation rules** that belong at the data layer.

After approval, these update `wiki/domain-model.md` and `wiki/database-schema.md`.

### 4. API contracts

For each new or changed endpoint / interface:

- Method and path (or signature).
- Request shape.
- Response shape (including error responses).
- Authentication / authorization requirements.
- Idempotency, retry, and consistency expectations.

After approval, these update `wiki/api-contracts.md`.

### 5. Implementation plan

A narrative description of how the work breaks down, ordered. Not yet a task list — that is the next stage. This section identifies:

- The major implementation steps.
- The order they must happen in (and where parallelism is possible).
- Risky steps that warrant a spike or prototype first.
- Where existing patterns are reused vs. new patterns introduced.

### 6. Testing strategy

- **Unit tests** — what coverage you expect.
- **Integration tests** — which boundaries.
- **End-to-end tests** — which user flows.
- **Manual checks** — anything that cannot be automated.
- Edge cases worth explicit tests.

### 7. Operational concerns

- Observability — logs, metrics, traces relevant to this feature.
- Performance budget — latency, throughput targets.
- Failure modes — what happens when dependencies fail.
- Rollout — feature flags, phased exposure, fallback.
- Security and privacy considerations.

Skip subsections that do not apply, but consider each.

### 8. Open questions

A list of unknowns that need resolution before or during implementation. Mark each as needing a spike, a decision, or research. Do not leave silent assumptions.

### 9. Devil's advocate pass

Switch role. Attack the design: what assumptions might be wrong, what would break at scale, what edge cases are unhandled, what simpler alternative was dismissed. Discuss with the human and revise.

### 10. Reviewer pass

Switch role. Read end-to-end. Check consistency with requirements, design, ADRs, and wiki documents. Surface issues and revise.

### 11. Approval and wiki update

Once approved:

- Update `wiki/domain-model.md`, `wiki/database-schema.md`, and `wiki/api-contracts.md` with any new content. Update `status` and `last_updated` for any stubs that become active.
- Confirm to the human that the tech spec is complete.

## Next step

Move to task decomposition. After task decomposition is complete and approved, **return control to Autocatalyst.**
