---
created: 2026-11-23
last_updated: 2026-11-23
status: proposed
issue: 194
---

# ADR-034: Price cache-aware session usage when read

## Context

The “Session” decision and cost-rollup consequences in [ADR-015](adr-015-run-lifecycle.md) describe
one model and one rate per session. Native records can show reroutes, cache activity with different
rates, or unattributed work. Freezing a price at completion would also prevent a late rate from
pricing work already recorded.

## Decision

Keep the invocation as the session grain, anchored to the same run, step, role, and round. The
dispatch model remains part of that record. Adapters capture disjoint fresh input, cache reads,
cache writes, and output, with exact billing keys when known. They record usage even when an
attempt fails or a rate is missing. Neither the runner nor the recorder prices sessions.

Use service-owned configuration under [ADR-008](adr-008-config-model.md) to append immutable,
effective-dated rate revisions per tenant and billing key. Read a run's sessions and relevant
rates in one snapshot. Use the active rate at each session's start and return the selected
revision IDs. Compute amounts as integer nano-dollars at API list prices; they are not
subscription charges. Keep representable known charges, list gaps for the rest, and label
estimated long-context bands as incomplete. Sum numeric prices per logical step and run on read.

This refines the one-model assumption, session price computation, and cost-rollup passages in
ADR-015. The rest of ADR-015 remains in force, including the run lifecycle and session attribution.
Rollups above the run and separate role or phase totals remain future work.

## Consequences

Operators can publish a backdated rate without rewriting usage. A correction can change later
reads of old runs; keep the session set and selected revisions to repeat a comparison offline.
Legacy token projections remain numeric for compatibility and can contain zero placeholders.
Consumers who need measured counts or disjoint classes use the normalized usage instead.
