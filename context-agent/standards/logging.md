# Logging standards

## Library

pino. Structured JSON to stdout. No custom formatters.

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

## OpenTelemetry

Traces and metrics use OpenTelemetry SDK. Spans wrap:
- Each orchestrator tick
- Each adapter call (Slack API, Agent SDK)
- Each stage transition within a run

Trace context propagates from orchestrator → adapter → agent subprocess where possible.
