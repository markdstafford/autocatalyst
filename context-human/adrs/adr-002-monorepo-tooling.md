---
created: 2026-06-03
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-002: Monorepo and tooling

## Status

Accepted

## Context

Autocatalyst is a single repository holding the core service, the execution runtime, the
shared API contract, the persistence layer, the desktop and mobile apps, and provider
adapters, all in TypeScript (ADR-001). We must choose how the repository is organized and
what manages builds and inter-package boundaries. Several things shape that choice:

- The system is **authored largely by AI agents and operated hands-off**, so the tooling
  should encode "the right way" structurally rather than rely on convention.
- Multiple packages share types (notably the API contract), so the tooling must make
  cross-package type-sharing and atomic cross-package changes easy.
- The control-plane / execution-plane split (ADR-003) must be enforceable as a real boundary,
  not just a naming convention.
- Builds and tests should not re-run for unchanged packages, locally or in CI.

## Decision

The repository is an **Nx monorepo using pnpm** as the package manager.

- **pnpm workspaces** manage dependencies through a single content-addressed store with a
  strict `node_modules`, preventing phantom-dependency bugs.
- **Nx** orchestrates tasks (a dependency-aware graph with result caching so only changed
  packages rebuild/retest), **enforces module boundaries** via tags, and ships **code
  generators** so a new package is scaffolded the one correct way.
- Layout principle: `packages/` holds libraries (e.g. `api-contract`, `core`, `execution`,
  `persistence`, `sdk`), `apps/` holds thin deployable targets (one per shippable
  artifact/platform; shared UI/logic lives in a package, platform shells stay thin).
  Provider adapters are placed by role: provider libraries under `packages/`, standalone
  channel clients under `apps/`, with Nx **tags** (e.g. `type:provider`, `scope:adapter`)
  carrying adapter semantics rather than a dedicated directory.
- The **control/execution boundary is enforced by Nx boundary rules**: `core` may depend on
  the execution *interface* but not reach into its internals (ADR-003). The exact final
  package list is settled once the core service is designed in detail.

## Consequences

**Positive:**
- Module-boundary enforcement keeps future agents on the rails structurally — a violation
  fails lint, not just review.
- Generators make new packages consistent without relying on an agent "knowing" conventions.
- Task caching makes "rebuild everything" into "rebuild what changed," speeding local and CI
  loops.
- One repo, one type graph, atomic cross-package changes.
- pnpm's strict resolution prevents a class of dependency bugs.

**Negative:**
- Nx is more opinionated and heavier to configure than lighter task runners.
- Nx's conventions are an additional thing for a contributor (human or agent) to learn.
- Boundary rules require upfront tagging discipline to be worth it.

## Alternatives considered

### Turborepo + pnpm

A lightweight task runner over pnpm workspaces, providing a task graph and caching.

**Pros:**
- Minimal configuration and conceptual overhead.
- Fast, effective task caching and parallelism.
- The de-facto standard for straightforward TypeScript monorepos.

**Cons:**
- No enforced module boundaries — layering relies on convention and review.
- No code generators to standardize new packages.
- Fewer structural guardrails overall.

**Why not chosen:** The hands-off, agent-authored goal values *structural* guardrails
(enforced boundaries, generators) that Turborepo does not provide, and that value outweighs
its lower configuration overhead.

### Plain pnpm workspaces + TypeScript project references

Use pnpm workspaces alone, with `tsc` project references for incremental builds and no
dedicated orchestrator.

**Pros:**
- Simplest possible setup with the fewest dependencies.
- No orchestrator-specific concepts to learn.
- Native TypeScript incremental compilation.

**Cons:**
- No task caching across non-build tasks (test/lint) or remote caching.
- No boundary enforcement or generators.
- Task orchestration becomes hand-rolled scripts as the repo grows.

**Why not chosen:** Gives up exactly the guardrails and orchestration Autocatalyst wants;
the simplicity is not worth the lost structure at this scale.

### Bazel

A polyglot, hermetic build system used at large scale. It is built for large polyglot
monorepos and brings operational complexity beyond what a single-language TypeScript repo
needs.
