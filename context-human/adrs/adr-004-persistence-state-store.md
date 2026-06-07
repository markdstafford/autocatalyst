---
created: 2026-06-03
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-004: Persistence and state store

## Status

Accepted

## Context

The control plane is the source of truth for durable state: runs and their checkpoints,
configuration, and the domain entities (repos, specs/artifacts, issues, PRs, comments, cost
records, and the links between them). We must choose the storage engine and how the code
reaches it.

Constraints and considerations:

- **A single writer of run state.** Scheduling and run-state mutation flow through one
  authority (the orchestrator), so the store does not need multi-writer concurrency for
  correctness.
- **Small scale for the foreseeable future.** A single operator, then a small team; run
  concurrency is modest.
- **Hostable now, multi-tenant later.** The service runs on a developer machine or a single
  host today, with multi-user as a mid-term direction.
- **A relational domain.** Runs, repos, issues, PRs, and their links are relational and benefit
  from integrity constraints and queryable relationships.

## Decision

**Use SQLite as the engine, accessed through Drizzle, with all data access behind a repository
abstraction. Postgres is the documented upgrade path, taken when the control plane goes
multi-instance or requires database-enforced multi-tenancy.**

- SQLite fits the workload: a single-writer model that matches the single-authority
  orchestrator, no separate service to operate, and ample headroom at the expected scale.
- **Drizzle** is the query layer, a TypeScript-native, SQL-first, typed schema and migration
  toolchain whose schema DSL is largely shared across SQLite and Postgres, which keeps the
  upgrade path cheap.
- Every read and write goes through a **repository abstraction**, so the engine is swappable
  without touching call sites.
- The **upgrade trigger** is explicit: move to Postgres when the control plane must run as
  multiple instances (true write concurrency across processes) or when tenant isolation must be
  enforced by the database itself.

## Consequences

**Positive:**
- Zero operational overhead for the common case: no database server to run alongside the
  service.
- The single-writer model aligns with, rather than fights, the single-authority orchestrator.
- The repository abstraction keeps the engine decision reversible at low cost.
- Drizzle gives typed queries and migrations and eases an eventual Postgres move via a shared
  schema DSL.

**Negative:**
- SQLite does not offer multi-process write concurrency, database-enforced row-level security,
  or built-in cross-process pub/sub, so a multi-instance deployment must adopt
  Postgres.
- The repository abstraction is a small amount of indirection to maintain.
- A future engine switch, while cheap, is still real work (dialect differences, data migration).

## Alternatives considered

### Postgres from the start

A client/server relational database with multi-writer concurrency, row-level security, and
`LISTEN/NOTIFY` pub/sub.

**Pros:**
- Multi-process write concurrency and database-enforced tenant isolation out of the box.
- Rich features (JSONB, `LISTEN/NOTIFY`) useful at multi-instance scale.
- A natural fit once the service is horizontally scaled.

**Cons:**
- Requires running and operating a database server even for a single-operator, single-host
  deployment.
- Its headline advantages are all multi-instance features that do not bind at the current scale
  or shape (single writer, small scale).
- More setup and moving parts for no near-term benefit.

**Why not chosen:** The advantages only matter once the control plane is multi-instance or
needs DB-enforced multi-tenancy. Until then they are cost without payoff, and the repository
abstraction makes adopting Postgres at that point inexpensive.

### A query builder/ORM such as Prisma instead of Drizzle

A mature, popular TypeScript ORM with a generated client.

**Pros:**
- Very polished developer experience and broad adoption.
- Strong migration tooling and documentation.

**Cons:**
- Heavier runtime and a code-generation step in the build.
- Less direct control over the SQL emitted.
- A less direct single-schema story across SQLite and Postgres for the upgrade path.

**Why not chosen:** Drizzle is lighter, SQL-first, fully typed, and shares one schema DSL across
both engines, a better fit for the SQLite-now/Postgres-later path.

### A document database (e.g. MongoDB)

A schema-flexible document store.

**Pros:**
- Flexible, schema-light documents.
- Horizontal scaling for large datasets.

**Cons:**
- The domain is relational (runs, repos, issues, PRs, links) and benefits from integrity
  constraints and joins a document model handles awkwardly.
- Adds a non-relational dependency to operate.
- Scale is not the problem this product has.

**Why not chosen:** The data is relational and small, so a relational engine is the better fit;
a document store solves a problem this product does not have.

### A flat file or JSON store on disk

Persisting state as files on disk. Not a genuine alternative: the domain needs transactions,
queryable relationships, and integrity that a file store cannot provide at the required level.
A file on disk remains relevant only as a rejected option for *configuration* (see ADR-008), not
for the state store.
