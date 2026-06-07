---
created: 2026-06-04
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-019: Persistence layout — normalized tables with embedded value objects

## Status

Accepted

## Context

The engine is SQLite via Drizzle, behind a repository abstraction (ADR-004). That decides *where* state
lives, not *how the domain maps onto it*. The domain has entities with their own identity and lifecycle
(conversations, topics, runs, artifacts, feedback, publications, PRs, step occurrences) and it has small
value objects that only ever travel with their owner (a cost structure, a token breakdown, a feedback
anchor, a channel reference). The mapping must support the queries the system actually runs, such as "is there
open feedback on this run" and "what did each step cost", without forcing every value into its own table.

## Decision

**Use normalized relational tables for entities, and embedded JSON columns for value objects that are
read and written only as part of their owning row.**

- **Normalized tables** for anything with **identity, a lifecycle, or independent query needs**:
  `Conversation`, `Topic`, `Message`, `Run`, `Artifact`, `Feedback`, `Publication`, `PR`, `RunStep`,
  `Session`, `TestResult`, `Project`. These are looked up, filtered, related, and individually mutated.
  `Feedback` must be queried and reopened on its own; `Session` rows must be summed and filtered for cost.
- **Embedded JSON columns** for **value objects** that have no identity of their own and are only ever
  read or written with their parent row: the `Cost` structure on a `Session`, its token breakdown, a
  feedback anchor, channel/conversation references.
- **The dividing line:** anything that needs to be found, filtered, or carries its own lifecycle gets a
  table; an opaque attribute of exactly one row is embedded.

This fits Drizzle (a relational core with JSON columns where appropriate) and keeps the
repository abstraction simple for an eventual Postgres move (ADR-004).

## Consequences

**Positive:**
- The queries the system relies on, such as open-feedback checks and cost aggregation over `Session`
  rows, run as SQL over proper tables and indexes rather than scans through a serialized blob.
- Integrity constraints and relationships (including the dedup uniqueness invariant of ADR-014) are
  expressible because the entities are real rows.
- Value objects stay simple, living inline with their owner instead of paying for a table they never get
  queried through.

**Negative:**
- More tables and foreign keys to define and maintain than a single document would need.
- The table-vs-embedded judgment must be made per field, and a value object that later grows query needs
  has to be promoted to a table (a migration).

## Alternatives considered

### A single embedded document per run

Persist a run and everything under it as one serialized document (the run with its artifact, feedback,
and review history embedded).

**Pros:**
- Simple to read and write as a whole; no joins to load a run.
- One write persists an entire run's state.

**Cons:**
- The operations the system actually performs, such as "does this run have open feedback", "sum the cost
  of each step", and "find runs at a given step", become scans and rewrites of a whole blob instead of
  indexed queries and targeted updates.
- A uniqueness invariant like one-active-run-per-topic cannot be a database constraint over embedded data.

**Why not chosen:** the domain is relational and the hot queries are over sub-collections (feedback, step
occurrences); a single document makes exactly those operations awkward and unindexed.

### Fully normalized, including value objects

Give every value object its own table (a row for each cost structure, each anchor).

**Pros:**
- Maximally uniform; everything is a row.

**Cons:**
- Tables and joins for things that are never queried independently and only exist as attributes of one
  row, adding overhead and indirection with no query benefit.

**Why not chosen:** value objects that always travel with their owner gain nothing from their own table;
embedding them is simpler and the repository abstraction hides the choice regardless.
