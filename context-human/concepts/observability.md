---
created: 2026-06-06
last_updated: 2026-06-06
status: active
roadmap: obs
---

# Observability

Observability makes a running system legible to the agents that query it and the people who watch
it, across two stores with two lifetimes. The durable application database is the
source of truth: it holds a session-grain record of every run, recorded as the work happens, so cost
and run history survive for the life of the conversation. An ephemeral telemetry backend (logs and
metrics over OTLP) carries the high-volume diagnostic stream that is watched while work is in flight
and dropped after a window. This concept owns the **policy of what flows to which store**, the shape of
the **durable run record**, the **query model** that sits behind status and progress, and the
operational-visibility model the API surface defers here. It does not own the entities themselves (see
`domain-model`), the per-session telemetry it consumes (emitted by `agent-runners`), the cost
computation over that record (see `cost`), the event transport (see `api`), or the screens that render
it (DESK `progress`).

## Two stores

The dividing line is durability.

- **The database** holds the source-of-truth records — the run timeline and the per-session record —
  for as long as the conversation exists. These are written as the run executes, not derived after the
  fact, and a reader reconstructs what a run did, and what it cost, entirely from them. They are never
  dropped on a retention schedule.
- **The telemetry backend** holds logs and metrics, fed over OTLP, with the Victoria stack as the
  reference target. It is retention-bounded, agent-queryable for diagnostics, and explicitly not a
  source of truth: losing it costs visibility into recent behavior, never a durable fact. It is where a
  developer or agent goes to understand *why* something behaved as it did, not *what* a run is or cost.

Keeping the two apart lets each carry the retention it wants: a run's cost and timeline kept
indefinitely, the diagnostic firehose dropped on a short window, instead of one policy compromising
both. A single fact about a finished session lands in both: priced into the durable record, and emitted
as a metric for aggregate dashboards. That is two readers with two lifetimes, not duplication.

## The durable record

A run's durable history is two layers in the database.

- A **`RunStep`** records each occurrence of a step the run enters, with its bounds and duration. Because a
  looping step produces a fresh occurrence, the timeline shows the path a run actually took, including
  the rounds a converging step ran through.
- A **`Session`** record captures one model's single go within a step, at `(step, role, round)` grain:
  the resolved model, the inference settings (thinking or effort level), the duration, the normalized
  token breakdown, the assistant-turn and tool counts, and the outcome. A step that ran three
  implementer/reviewer rounds leaves around six session rows (implementer and reviewer for each round),
  each a queryable row rather than a buried detail. The rows are **explicitly ordered** by a
  per-run session sequence (alongside the step occurrence, round, and role), so the timeline
  reconstructs deterministically rather than by inferring order from wall-clock times. The order roles
  act in *within* a step (implementer before reviewer) is a property of the convergence loop, owned
  by `review`/`workflow` (ADR-026); this concept records the resulting order, it does not define it.

The `Session` record is also the unit cost prices (ADR-015): observability records its execution
metadata, and `cost` prices the tokens into its embedded `Cost`. Its shape belongs to `domain-model`;
this concept describes what observability writes into it and reads back out.

**Per-turn and per-tool detail is not durable here.** It streams live for an in-flight run and to the
telemetry backend, retained there long enough to debug. A turn carries little durable value on its
own (content is never recorded, so a turn row would say only that a turn happened), and the
session-grain record already answers the questions worth keeping. Nothing accumulates at turn grain in
the database, so there is no grooming step to run.

Because the records are written from the first run onward, an experience or query built later reads
data that already exists, with no backfill and no gap for the period before the feature shipped.

## The telemetry stream

Logs, metrics, and (later) traces emit through a single OpenTelemetry SDK, behind a thin
`createLogger(component)` facade so call sites stay ergonomic without choosing a backend.

- **Logs** are the diagnostic narrative: decision points, external calls and their outcomes, error
  paths, and the redacted diagnostic captured when a session fails. Redaction happens at the facade
  (a secret's presence may be recorded, never its value), and content (prompts, responses, message
  bodies) is never logged. Records emit straight to the OTLP exporter; there is no separate
  structured-JSON console layer that the system would then re-parse to forward.
- **Metrics** are the aggregate signals (session counts, durations, token throughput, outcomes),
  cheap to query in bulk across all runs without touching the database.
- **Traces** are deferred. The unified SDK makes adding them an additive step, taken when a concrete
  need arrives, such as execution distributed across separate workers.

With no OTLP endpoint configured the SDK is a no-op and opens no network connections, so the telemetry
backend is optional and never blocks local operation. The database records regardless: the durable
side does not depend on a collector being present. The system is backend-agnostic over OTLP; swapping
the backend is configuration, not code.

Every record the runners emit is tagged `(run, phase, step, role)` plus the resolved model and
inference settings, so a log line, a metric point, and a durable session row all correlate to the same
work (see `agent-runners` and the telemetry-conventions standard). A bounded direct call carries the
same tag, attributed to the run it resolves to, with an empty (`none`) role and, for an intake-time
call that runs before any workflow phase such as classification, a null phase.

## The query model and operational visibility

The durable records answer two kinds of question, and both are served through the typed API reads, the
same contract the UX uses, so "agent-queryable without a human intermediary" means the typed endpoints,
not a separate raw-query path. (The telemetry backend stays queried through its own LogQL/PromQL.)

- **A run's own history** (its step timeline, the sessions inside each step, the feedback it raised,
  and what it cost) reads from the `RunStep` and `Session` records and the run-parented `Feedback`.
- **Cross-run questions** (which runs ran the most rounds, which carried above-average feedback and
  what they cost, how cost compares across thinking levels) are aggregations over the same rows,
  first-class because every dimension is a column.

**Operational visibility** (the running-agent count, queue depth, token totals, and the human
**inbox** of conversations awaiting a person) is a read model over current run state (runs grouped by
their `waiting_on` and step) together with the durable records. The API transports this model and
defers its definition here; the minimal `GET /health` liveness check stays with `api`. None of it needs
a new durable structure: it is a view over state the system already keeps.

## Retention

The two stores retain on their own terms. The durable records (timeline, sessions, cost, feedback)
persist for the life of the conversation. The telemetry backend keeps logs and metrics long enough to
debug recent behavior, then drops them. Once a backend window ages out, a run's diagnostic detail is
gone but its durable record remains, so the questions that matter (what it did, what it cost) are
still answerable. Archiving or compacting the durable history is a deferred option, taken only if
volume ever makes it worthwhile; at expected throughput it is not needed.

## Relationships

- `domain-model` — owns the shape of the `RunStep` and `Session` records this concept writes; the
  `Session` is the per-session cost+telemetry record (ADR-015).
- `agent-runners` — emits the per-session telemetry, tagged `(run, phase, step, role)`, that this
  concept records and the backend ingests; the request-alteration boundary's redacted logging feeds it.
- `cost` — prices the `Session` record's tokens and computes the rollups over these rows.
- `api` — transports the durable reads and the SSE event stream, and keeps the minimal `GET /health`;
  the operational-visibility model it exposes is defined here.
- `execution-runtime` — owns the typed event protocol whose live stream carries per-turn activity and
  whose persisted events serve reconnect and resume.
- `acceptance-testing` — owns the run-parented test-result record this concept surfaces but does not own.
- DESK `progress` and `settings` — render the timeline, the session drill-in, and the operational view
  over the model defined here.

## Constraints and decisions

- **Two stores: durable database (source of truth) and ephemeral OTLP/Victoria (diagnostics)**, with
  this concept owning what flows to which (ADR-030).
- **Durable telemetry is session-grain** — `RunStep` plus a `Session` record at `(step, role, round)`;
  per-turn detail is live and backend-only, not durable (ADR-030).
- **Recorded from the first run**, so later experiences and queries read existing data (ADR-030).
- **Logs, metrics, and traces emit through one OTel SDK over OTLP**, behind a logging facade, with
  redaction at the facade and no content; no console-JSON-then-reparse layer; no endpoint is a no-op
  (ADR-030).
- **The durable query surface is the typed API reads**; the telemetry backend is LogQL/PromQL.
- **Observability owns the operational-visibility model** the API defers to it; `GET /health` is `api`'s.
- **Traces deferred**, taken when a concrete need arrives (ADR-030).

## Open edges

- **Traces** join the existing signals when distributed execution or another concrete need calls for
  them — additive over the same SDK.
- **A cached aggregate cost** (a present-when-complete rollup column with invalidation) is a deferred
  optimization owned by `cost`; until then rollups are computed live from the session rows.
- **Archiving or compacting** old durable history is available if volume ever warrants it; the
  session-grain record is the floor that is always kept.
- **Per-turn durable history** would be a backend-window-independent record of fine-grained activity,
  taken only if a need to replay terminal-run detail beyond the diagnostic window appears.
