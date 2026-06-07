---
created: 2026-06-06
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-030: Observability — the two-store model and durable per-session telemetry

## Status

Accepted

## Context

Observability has to make a running system legible to agents and humans without losing the data that
later experiences and queries depend on, and that data splits into two kinds with different needs. A
run's cost and timeline are source-of-truth records that have to live as long as the conversation that
produced them. Logs and metrics are high-volume diagnostics, watched while work is in flight and fine
to drop after a window. A single store would impose one retention policy and one trust level on both.

The durable side also has a timing constraint. A session's model, token counts, inference settings, and
outcome exist only at the moment it runs; streamed only to a diagnostic backend, they cannot answer a
cost question or reconstruct a run's history afterward. The durable record has to be written when the
data exists, from the first run, before any view or query reads it.

A last, narrower point is the log path itself: serializing a structured log line to a console stream
and then re-parsing it to forward to a backend reads the system's own output twice.

## Decision

**Observability is two stores with two lifetimes: the durable application database (the source of truth)
holds a session-grain record of every run, and an ephemeral telemetry backend (the Victoria stack, fed
over OTLP, not a source of truth) holds logs and metrics. The durable records are written from the first
run, so any experience or query added later reads data that already exists.**

- **Two stores.** The database holds the durable, source-of-truth records — the run timeline and the
  per-session record — for the life of the conversation. The telemetry backend (OTLP-fed; the Victoria
  stack is the reference) holds logs and metrics — retention-bounded, agent-queryable for diagnostics,
  losable, and explicitly *not* a source of truth. This concept owns the policy of what flows to which
  store.
- **Durable telemetry is session-grain.** One `Session` record per session at `(step, role, round)` —
  model, inference settings, duration, token breakdown, outcome — is the durable per-run history.
  Per-turn and per-tool detail is *not* durable in the database: it streams live for the in-flight run
  and to the telemetry backend (retained long enough to debug). The `Session` record is also the cost
  unit (ADR-015); observability records its telemetry, and `cost` prices its embedded `Cost`.
- **Recorded from the first run.** The durable records are written from the first run onward, even
  before any timeline view, cost view, or cross-run query is built, so a surface or analytic added
  later reads existing data with no backfill. The views and queries themselves are not built by this
  decision.
- **One emission path: the OTel SDK over OTLP.** Logs, metrics, and traces (when taken) are emitted
  through a single OTel SDK behind a thin logging facade. There is no separate structured-JSON console
  layer that is then re-parsed to forward. With no OTLP endpoint configured the SDK is a no-op (zero
  network), so the telemetry backend is optional and never blocks local operation; the database records
  regardless. The system is backend-agnostic over OTLP, with the Victoria stack as the reference target.
- **Traces are a deferred addition.** Logs and metrics are emitted through the SDK; that same SDK makes
  traces an additive step, taken when a concrete need arrives (for example, distributed execution workers).
- **Observability owns the operational-visibility model.** The running-agent count, queue depth, token
  totals, and the human inbox (conversations awaiting a person) are a read model over current run state
  and the durable records. `api` transports it through its typed reads and the SSE stream and defers
  the model itself here; `GET /health` stays a minimal liveness check on `api`.
- **The durable query surface is the typed API reads.** Agent-queryable access (ADR-001) to the durable
  data is the same typed endpoints the UX reads, not a separate raw-query path; the telemetry backend
  stays queried through LogQL/PromQL.

## Consequences

**Positive:**
- The data that `cost` and run-history depend on is durable from the first run and recomputable, rather
  than streamed to a watched-then-dropped backend and lost.
- The two stores carry independent retention: a run's cost and timeline are kept for the life of the
  conversation, while the high-volume log and metric stream drops on a short window.
- One emission path serves all signals, with no re-serialize-and-re-parse layer between the application
  and the backend.
- Telemetry never blocks local operation (with no endpoint the SDK no-ops), and the durable database
  records regardless.
- Later experiences (the run timeline, cost views, stuck-run analysis, the inbox) read existing data
  with no backfill, because the session-grain record was there from the start.

**Negative:**
- Two stores to reason about, and a discipline about which data belongs in which — the policy this
  concept owns.
- A session-grain durable record is more to write than an in-memory status buffer would be (more rows),
  though the volume is small at expected throughput.
- Per-turn debugging depends on the telemetry backend's retention window; once a window ages out, only
  the session-grain durable record remains for that run.

## Alternatives considered

### One store — everything in the telemetry backend

Keep run history and cost in the telemetry backend alongside logs and metrics, and query it all there.

**Pros:**
- A single place to query, with nothing to keep in step between two stores.
- Reuses the backend's aggregation and query languages for cost too.

**Cons:**
- A retention-bounded, losable backend that is explicitly not a source of truth cannot hold cost and
  run history that must live as long as the conversation.
- Analytics over a stream that ages out is fragile, and a metered-then-dropped token count cannot
  answer a cost question after the fact.

**Why not chosen:** the durable records must be the database source of truth; the telemetry backend is
for diagnostics, and conflating the two loses the durable signal.

### One store — everything durable in the database

Persist the full per-turn and per-request firehose durably and run without a telemetry backend at all.

**Pros:**
- One store, full fidelity retained indefinitely.
- No backend to deploy.

**Cons:**
- The per-turn firehose has low long-term value (without content, a turn row records only that a turn
  happened) and would dominate the database.
- It forgoes the inexpensive aggregate metric and log queries a metrics/log backend provides, and
  couples local operation to durable writes for diagnostic noise.

**Why not chosen:** splitting fidelity by value and lifetime (session-grain durable, per-turn
ephemeral) keeps the durable store lean and the diagnostics cheap.

### A structured-JSON console layer bridged to OTLP

Emit logs as structured JSON to a console stream and bridge each line into the telemetry backend.

**Pros:**
- A console stream is watchable without a collector configured.
- A mature, ergonomic logging API.

**Cons:**
- It serializes each line and then re-parses it to forward, reading the system's own output twice, and
  maintains two logging surfaces.
- The console stream is watched rarely in practice, and a console exporter on the OTel SDK covers the
  no-collector case without the second layer.

**Why not chosen:** the OTel SDK behind a thin facade gives the same call-site ergonomics over one path;
console visibility is a developer convenience, not a requirement.
