---
created: 2026-06-06
last_updated: 2026-06-06
status: active
roadmap: obs
---

# Cost

Cost turns a run's execution metadata into money. It owns the **computation** that prices a session's
tokens into a `Cost`, the **lifecycle** of how those costs roll up to a run and beyond, and the
**analytics** that read cost at the grain a workflow can be tuned against. The records it works on —
the `Session` and its embedded `Cost` value — belong to `domain-model`; the per-session metadata it
prices is emitted by `agent-runners` and recorded by `observability`. This concept owns the part in the
middle that no other concept does: pricing, rollup, and the cost-driven queries. It cross-references the
record shapes rather than restating them.

## What cost attaches to

The cost unit is the **session** (ADR-015): one model's single go within a `(step, role, round)`, so it
has exactly one model, one set of token counts, and one price. Each `Session` carries one `Cost` — the
model, a `usd` figure, and a token breakdown. A gate or a human- or system-driven step runs no session,
so it bears no cost; a session whose model has no configured rate bears a cost that is *unknown* rather
than zero (below). `(step, role)`, step, phase, and the levels above are sums over sessions, not stored
cost records of their own.

## Computation

A session is priced when it completes, from the metadata that travels back with it — the resolved
model and the normalized token counts (see `agent-runners`). Pricing is `tokens × per-model rate`,
summed across the token classes:

- The token breakdown is normalized in the runner adapter to one shape across providers — `input`,
  `output`, `cache_read`, `cache_write` — so a provider's cache-creation and cache-read counts and
  another's prompt/completion counts price through the same path. The cache classes are priced at their
  own rates, not folded into input or output.
- A `usd` figure is an **integer count of nano-dollars** (1e-9 USD), never a floating-point number.
  Provider rates, quoted per million tokens, convert to integer nano-dollars per token exactly, and a
  session's price is an exact integer sum. Summing integers up a deep rollup is exact and order-
  independent, so a total never drifts from a re-computation of the same rows. A `usd` is rendered to
  dollars only for display.
- A session's price is **frozen at the rate in effect when it was priced.** A run from last month keeps
  what it actually cost; a later change to a model's rate does not re-price history. Cost is an
  accounting record of what was spent, not a live quote.

Pricing covers both runner families and both call shapes, agentic sessions and bounded direct calls,
because the token breakdown they hand back is the same shape.

## The rate table

Pricing reads a rate table that maps `(provider, model, token-type)` to a rate, carrying an
**effective-date** so the "rate in effect when priced" is well-defined and historical pricing stays
reproducible. The table is service-owned data in the database, read and written through the API and
validated by the shared schemas, like the routing table (ADR-008, ADR-007), and it is tenant-scopeable.

There is **no bundled default rate table**: a rate baked into the build would go stale and still be
trusted. A model's rate is entered alongside its profile, and a model with **no configured rate
prices to an unknown cost** — the session still records its tokens, its `usd` is left unset behind a
"rate missing" marker, and the run is not blocked. The cost becomes known the moment a rate is added
(below), so a missing rate is a backfill, not a lost figure. Treating it as unknown rather than zero
keeps a missing rate from understating a total.

## Rollups and lifecycle

A level's cost is the sum of the sessions beneath it — `(step, role)`, step, phase, run, topic,
conversation, and project, each a dedicated `GROUP BY` over the `Session` rows. These rollups are
**computed live**: a query sums the rows that exist when it runs, so a backfilled rate, a late-arriving
session, or any other change to a descendant is reflected the next time the rollup is read, with no
record to keep in step. A cached, present-when-complete `aggregateCost` (with the invalidate-and-
propagate behavior a stored rollup would need) is a deferred option (`domain-model`), taken only if read
volume ever makes live summing slow — at expected throughput, summing the rows is correct and quick.

Two cases shape what a rollup means:

- **A failed or canceled session is still priced** if it consumed tokens and its usage is available —
  the spend was real. What makes a cost complete is a **known** `usd`, not a successful outcome. A
  session whose usage is unavailable, or whose model has no rate, contributes an **unknown**, not a zero.
- **A rollup that contains an unknown is reported as a known subtotal plus an "unknowns present"
  signal** — a lower bound — rather than dropping the unknown to zero or refusing to
  answer. Backfilling the rate turns the unknown into a figure, and the next read of the rollup includes
  it.

## Analytics

Because the priced record is the session and every dimension is a column, every cost question is a
first-class aggregation over the `Session` rows — no pre-stored rollup to maintain, no blob to scan.

- **Convergence depth** (cross-cutting #17): grouping sessions by `round` and `role` within a step shows
  what each review round cost, so a workflow's depth can be set against diminishing returns — whether a
  second or third round is buying enough to justify its spend.
- **Cost across thinking and effort levels** (cross-cutting #18): grouping by the session's recorded
  inference settings compares what a reasoning posture costs against what it returns. This is why the
  inference settings are recorded per session and not inferred from the model alone.
- **Per-model, per-phase, per-step, and per-token-class** breakdowns at any level of the hierarchy are
  the same kind of query, including how much of a total is cache reads versus fresh input.

These queries are the substrate; the screens and the routing changes that act on them are owned
elsewhere (DESK `settings`, `model-routing`). The records are written from the first run, so a cost view
or a tuning query built later reads data that already exists.

## Relationships

- `domain-model` — owns the `Session`, its embedded `Cost` (model, `usd`, token breakdown), and the
  deferred `aggregateCost` rollup field this concept computes into.
- `observability` — records the per-session metadata this concept prices and owns the two-store model
  the metadata travels through; cost lives entirely on the durable side.
- `agent-runners` — emits the normalized per-session token breakdown and model that pricing consumes.
- `model-routing` — tiers `(step, role)` to cheaper or stronger models; the analytics here measure
  whether that tiering pays off.
- `run` — owns the session-bearing lifecycle (`phase -> step -> session`, ADR-015) cost attributes to.
- `review` / `workflow` — own the convergence depth whose cost #17 measures.
- `api` — exposes a level's cost on the resource it belongs to, as integer minor units rather than a
  float.

## Constraints and decisions

- **The cost unit is the session** (ADR-015); `(step, role)` and above are sums over sessions.
- **A session is priced at completion**, `tokens × per-model rate`, with the rate **frozen** at that
  moment; cache classes priced at their own rates.
- **`usd` is integer nano-dollars, never a float**, so rollups are exact and drift-free.
- **The rate table is service-owned config** keyed `(provider, model, token-type)` with an
  effective-date; **no bundled default** (ADR-008).
- **A missing rate prices to unknown, not zero** — tokens recorded, backfillable; a rollup with an
  unknown reports a flagged subtotal.
- **Rollups are computed live**; a cached `aggregateCost` is deferred to a concrete read-volume need.
- **Analytics are queries over the `Session` rows**, not pre-stored rollups.

## Open edges

- **A cached `aggregateCost`** with invalidate-and-propagate becomes worthwhile if read volume grows;
  the live rollups are the same numbers, so adding the cache is additive.
- **A bundled starter rate table** could ease first-run setup later; it is left out now to avoid a
  trusted-but-stale default.
- **Budgets and cost caps** — alerting or bounding a run's spend against these analytics — build on the
  query substrate when a concrete need arrives.
- **A bounded direct call** (classification at intake, PR-title generation) is priced as a session like
  any other, attributed to the run the call resolves to, with a null phase and an empty (`none`) role.
  The run it resolves to is the active run it was classified against, or the run a `create` verdict
  produces; the orchestrator stamps that run id onto the session. So intake and title spend is counted
  in a project's total rather than escaping it. (Whether the `none` role is later backfilled to a named
  role is left open; the step already identifies the call.)
