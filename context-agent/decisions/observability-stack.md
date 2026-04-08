---
date: 2026-04-08
status: accepted
superseded_by: null
---

# Observability stack

**Decision:** OpenTelemetry SDK for instrumentation. Structured JSON logging to stdout initially. Victoria stack (VictoriaLogs, VictoriaMetrics, VictoriaTraces) + Vector as the target backend.

**Rationale:**
- OpenTelemetry decouples instrumentation from backend — if Victoria doesn't work out, switching is a config change
- Structured JSON to stdout gives immediate observability with zero infrastructure (pipe to `jq`, grep, or any log aggregator)
- Victoria stack is lightweight, agent-queryable via LogQL/PromQL/TraceQL, and recommended by OpenAI's harness engineering work
- Vector handles collection and routing without heavyweight infrastructure
- All log entries include stable `key=value` pairs: `run_id`, `stage`, `event`, `component`, `timestamp`

**Constraints:**
- Observability from day one (ADR-001, app.md)
- Must be queryable by agents without human intermediaries
- Must not require heavy infrastructure for local development
- Must scale to hosted deployment

**Rejected:**
- Prometheus + Grafana + Loki: heavier operational burden; more infrastructure to run locally
- Console-only logging (no structured format): not queryable by agents; loses the "from day one" requirement
- Datadog/cloud-only: vendor lock-in; doesn't work for local development
