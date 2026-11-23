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
- **Interpret native usage in the adapter.** Normalize disjoint fresh input, reads, writes, and
  output; keep unsupported or unknown counters distinct from measured zero. Deduplicate owned
  work inside each attempt. Native secondary totals may replace overlap or fill verified
  residuals, not add a second copy. Keep evidence through terminal errors and result parsing.
- **Tag every record with `(run, phase, step, role)`** plus the resolved model and inference settings
  (effort/thinking). A bounded direct call carries the same tag, attributed to the run it resolves to,
  with an empty (`none`) role and — for an intake-time call that runs before any workflow phase — a null
  phase, so its tokens still correlate back to its run.
- **Capture redacted diagnostics on failure** on every runner — the last error or captured stderr —
  never raw secrets.
- **Persist evidence, not price.** Sessions keep invocation-grain normalized groups and
  numeric compatibility projections; the runner does not price. Core prices session reads against
  effective-dated rates at API list price and computes logical step/run subtotals. Do not retain
  raw native identifiers as accounting evidence. See the session pricing wiki for wiring.
- **Request/response logging lives at the request-alteration boundary** (ADR-023): redacted records
  captured once, at the single point all provider traffic passes through.
- **Progress and intent are typed events, never parsed prose.** A runner emits a plan, task progress,
  and notifications with an importance hint through structured tools; rendering is decided per surface
  (`execution-runtime`, ADR-012).
