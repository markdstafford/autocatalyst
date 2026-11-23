---
created: 2026-06-06
last_updated: 2026-11-23
status: active
---

# Cost

Cost prices recorded model work at configured API list rates. It does not compute a subscription
charge, allowance, or forecast. The session is the unit of price ([ADR-015](../adrs/adr-015-run-lifecycle.md),
refined by [ADR-034](../adrs/adr-034-cache-aware-session-pricing.md)). A session still represents one
recorded invocation within its step, role, and round, even when it contains work from several models.
Human and system steps without a model invocation do not produce a charge.

## Evidence and rates

A session stores disjoint groups of fresh input, cache reads, cache writes, and output. Output may
include a reasoning subset; a cache write may include known retention buckets. Subsets do not add
to their parent class. Each group carries its exact served provider and model when known, and may
have exact request size, range, ceiling, or sample evidence. The dispatch model is not a billing
fallback. Failed or interrupted sessions can contribute measured usage independently of outcome.

Operators publish rates through the configuration API or SDK, independently of runner profiles.
There are no bundled rates. Each tenant's (provider, model, effectiveAt) slot has immutable,
sequential revisions. A correction names its current head; a retraction hides that slot and may
expose an earlier effective date. A set can restore a retracted slot. History remains readable.

A schedule starts with a band at zero and can add bands at larger request sizes. A band gives
integer nano-dollars per token for each class. Cache writes can have a flat rate, separate
five-minute and one-hour rates, or be not applicable. An optional model-wide context limit applies
across transports, unless exact evidence for that key contradicts it.

## Pricing and totals

One run-session read takes a snapshot of the sessions and applicable rate history. Each group uses
the latest active schedule effective at or before its session start. A known request size selects a
band directly. Otherwise a valid group ceiling, native context ceiling, or operator context limit
can rule bands out; a range also bounds the minimum. A hint never rules a band out.

When feasible bands agree about a charge, price it once. If they disagree and a numeric rate exists,
clamp the sample hint to the feasible range and use its band or, without a hint, use the lowest
feasible band. Label charged estimates with their method, affected tokens, and band minimum.
A sample can be wrong in either direction, and a lowest-band estimate can understate the amount.
Neither means the price is complete. Typed gaps explain unknown model or rate, usage or retention,
unusable treatment, and overflow. A gap is not a zero charge.

Return the known, representable amount in integer nano-dollars, including measured zero, or null
if nothing can be charged or the amount cannot be represented. Logical (phase, step) and run totals
sum numeric session prices, count priced and unpriced sessions, and summarize affected sessions and
tokens by gap. An empty run returns a null subtotal and no step totals. A run in progress can show
cost so far; completeness refers only to recorded pricing coverage.

A backdated rate can price old sessions on the next read. To reproduce a comparison offline, retain
the session set and the selected rate revisions, not just publication times. Reads do not write
price or rate metadata back to the durable sessions.

## Relationships

- [Domain model](domain-model.md) owns the session and its stored projections.
- [Observability](observability.md) records the evidence; [agent runners](agent-runners.md) do not price it.
- [Settings](settings.md) owns rate publication; [API](api.md) returns integer nano-dollars on run-session reads.
- [Run detail](run-detail.md) shows the basis, subtotal, and actual gaps.

## Constraints and decisions

- Keep one price per session, with disjoint counted portions and explicit gaps.
- Price against a tenant-scoped snapshot at read time. Keep historical revisions and do not price legacy cache placeholders.
- Ship logical step and run totals only. Preserve role and round attribution for later analysis.

## Open edges

Higher rollups, tuning by convergence depth or inference settings, and a cached aggregate are
future work. There is no rate editor, automatic rate retrieval, budget, cap, or alert.
