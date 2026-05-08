# Logging standards

## Library

pino. Structured JSON to **stderr** (fd 2). No custom formatters.

## Stdout/stderr split

| Stream | Content |
|--------|---------|
| stdout | Operator-facing output only: `--help` text, interactive prompts (readline) |
| stderr | All pino structured JSON log lines |

Set `LOG_PRETTY=true` to pipe pino output through `pino-pretty` for local development.

The SDK agent runner (`ClaudeAgentSdkAgentRunner`) yields structured objects via async iterator;
it does not write to the process stream.

## Format

Every log entry is a JSON object with these fields:

| Field       | Type   | Required | Description                                    |
|-------------|--------|----------|------------------------------------------------|
| `timestamp` | string | yes      | ISO 8601                                       |
| `level`     | string | yes      | `debug`, `info`, `warn`, `error`               |
| `component` | string | yes      | Module that emitted the log (`orchestrator`, `slack-adapter`, `agent-adapter`) |
| `event`     | string | yes      | Stable event name (`run.started`, `spec.generated`, `approval.received`) |
| `run_id`    | string | when applicable | ID of the current run                 |
| `idea_id`   | string | when applicable | ID of the originating idea            |
| `stage`     | string | when applicable | Current loop stage                    |
| `message`   | string | no       | Human-readable description (for debugging only) |

## Rules

- **Stable keys.** Once a key is introduced, never rename it. Agents and queries depend on key stability.
- **No secrets.** Never log API keys, tokens, or credentials. Log the presence of a credential (`auth=configured`) not its value.
- **Structured over prose.** `{ event: "run.failed", run_id: "abc", reason: "timeout" }` not `"Run abc failed because of a timeout"`.
- **One log per event.** Do not log the same event at multiple levels or in multiple locations.

## Log levels

- `debug`: internal state changes useful for development
- `info`: stage transitions, adapter events, run lifecycle events
- `warn`: recoverable issues (retry scheduled, config reload failed with fallback)
- `error`: unrecoverable issues (run failed, adapter crashed)

## OpenTelemetry export

Two environment variables control OTLP export. Both default to unset.

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | unset | OTLP/HTTP endpoint for metrics (e.g. `http://localhost:4318`). When unset, no metrics are exported and no network connections are made. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | unset | OTLP/HTTP endpoint for logs (e.g. `http://localhost:9428`). When unset, pino writes to stderr only — identical to pre-feature behavior. |

When both variables are unset the service is **behaviorally identical** to its pre-feature state: pino writes to stderr, no network connections are attempted.

Export errors (network unreachable, bad endpoint) are caught internally and logged at `warn` level with `event: "telemetry.export_failed"`. They do not propagate to the run loop.

See `context-human/wiki/observability.md` for setup instructions and `src/core/telemetry.ts` for implementation details.
