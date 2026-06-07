---
date: 2026-06-06
status: accepted
---
# Logging conventions

How every component emits structured logs so they are queryable by agents and humans and never leak
secrets. The transport and store model is `context-human/concepts/observability.md` (ADR-030); this
records the rules a component follows when it logs. Runner-specific telemetry conventions are in
`telemetry-conventions.md`.

- **Emit through the OpenTelemetry Logs SDK behind a `createLogger(component)` facade.** There is no
  pino layer and no separate structured-JSON console stream that is then re-parsed to forward — a log
  record goes straight to the SDK. Call sites use the facade (`info` / `warn` / `error` / `debug` with
  structured fields); they do not choose a backend.
- **One sink path, optional backend.** Records export to the OTLP exporter when an endpoint is
  configured (the Victoria stack is the reference target). With no endpoint the SDK is a no-op and
  opens no network connections, so logging never blocks local operation. A dev console exporter is a
  non-contractual convenience, not a requirement — console visibility is not a product surface.
- **Redact at the facade; never log content.** A secret's *presence* may be recorded
  (`auth=configured`), never its value. Prompts, model responses, message bodies, feedback text, and
  issue bodies are never logged at any level — only metadata and stable event codes.
- **Stable structured fields.** Every record carries `component`, `level`, `timestamp`, and a stable
  `event` code, plus the correlation tags `(run, phase, step, role)` where available (role is absent
  for bounded direct calls). Once a key is introduced it is not renamed — agents and queries depend on
  key stability.
- **Fixed level semantics.** `debug` (internal state), `info` (transitions, lifecycle, adapter events),
  `warn` (recoverable), `error` (unrecoverable). Structured over prose; one record per event.
- **Export failures stay out of the run loop.** An exporter error is caught and surfaced as a `warn`,
  never propagated into the work a run is doing.
