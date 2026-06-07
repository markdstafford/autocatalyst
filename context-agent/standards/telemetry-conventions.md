---
date: 2026-06-06
status: accepted
---
# Runner telemetry and logging conventions

The conventions every runner follows so runs are comparable and cost-attributable across providers.
The home for the runner machinery is `context-human/concepts/agent-runners.md`; this records the
telemetry and logging rules agents reach for when extending it.

- **One uniform shape across runners.** Every runner — agent and direct, across providers — emits the
  same telemetry, because it lives in the shared connection layer and one orchestrator per mode. A new
  provider adapter inherits the shape; it does not define its own.
- **Emit as you go, do not tally after.** A runner emits session start, completion, and failure
  events with assistant-turn and tool counts, duration, token usage, and outcome, rather than
  recomputing them from a consumed stream.
- **Normalize token usage in the adapter into one breakdown** — `input`, `output`, `cache_read`,
  `cache_write` — across providers, plus an explicit `usage_available` flag so a genuine zero is
  distinct from unknown. The provider's session-completion usage object is the authoritative source;
  the request-alteration boundary's token extraction (ADR-023) is a fallback only, used when an adapter
  cannot surface usage — not an independent capture site.
- **Tag every record with `(run, phase, step, role)`** plus the resolved model and inference settings
  (effort/thinking). A bounded direct call carries the same tag, attributed to the run it resolves to,
  with an empty (`none`) role and — for an intake-time call that runs before any workflow phase — a null
  phase, so its tokens still correlate back to its run.
- **Capture redacted diagnostics on failure** on every runner — the last error or captured stderr —
  never raw secrets.
- **Telemetry is the raw material for cost, not a cost record.** The cost unit is the session (ADR-015):
  the per-session cost record (the `Session`) is priced by `cost` from this metadata, and `(step, role)`
  and higher totals are sums over sessions. A runner emits and owns no cost record. The durable
  per-session record is session-grain (model, inference settings, duration, token breakdown, outcome);
  per-turn detail is not durable (see `observability`, ADR-030).
- **Request/response logging lives at the request-alteration boundary** (ADR-023): redacted records
  captured once, at the single point all provider traffic passes through.
- **Progress and intent are typed events, never parsed prose.** A runner emits a plan, task progress,
  and notifications with an importance hint through structured tools; rendering is decided per surface
  (`execution-runtime`, ADR-012).
