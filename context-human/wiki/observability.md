# Observability Setup Guide

Autocatalyst ships a Docker Compose stack that provides live metrics and logs with a single command.

## Prerequisites

- Docker Desktop (Mac/Windows) or Docker Engine with Compose plugin (Linux)
- Autocatalyst repo cloned locally

## Start the observability stack

From the repo root:

```bash
docker compose up -d
```

This starts three services:
- **VictoriaMetrics** — metrics storage and query UI (vmui)
- **VictoriaLogs** — log storage and query API
- **Vector** — collects Docker container logs and forwards them to VictoriaLogs

Verify all services are running:

```bash
docker compose ps
```

All three services should show `running`. They are typically healthy within 30 seconds.

## Configure the Autocatalyst service

Set these environment variables before starting Autocatalyst:

| Variable | Local stack value | Description |
|----------|-------------------|-------------|
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP endpoint for metrics |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `http://localhost:9428` | OTLP/HTTP endpoint for logs |

When **both variables are unset**, the service behaves exactly as before this feature was added — pino writes structured JSON to stderr only, and no network connections are attempted.

Example (local stack):

```bash
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://localhost:9428
autocatalyst run --repo .
```

## Open the dashboard

1. Open **http://localhost:8428/vmui** in your browser.
2. Click the menu icon (top right) → **Import dashboard**.
3. Upload `ops/victoriametrics-dashboard.json` from the repo root.
4. The five operational panels load immediately.

After your first run completes, all panels populate with data. No account, no provisioning step, and no PromQL knowledge required.

## Query logs for a specific run

VictoriaLogs is queryable at **http://localhost:9428/select/logsql/query**.

To see all logs for a specific run, use its `run_id` (visible in any structured log line):

```
{run_id="<your-run-id>"}
```

To see the last 100 log lines across all runs:

```
* | limit 100
```

## Hosted / production deployment

Point the env vars at your hosted OTLP endpoint instead of localhost:

```bash
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://metrics.example.com/opentelemetry/api/v1/push
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://logs.example.com/insert/opentelemetry/v1/logs
```

Authentication (bearer token, basic auth) is configured at the hosted backend. To add headers to OTLP requests, use the standard OTel SDK env var:

```bash
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <token>"
```

The service sends plain OTLP/HTTP; TLS termination and auth can also be handled by a reverse proxy in front of the storage backend.

## Troubleshooting

### Port conflict on 8428, 4318, or 9428

Another process is using one of the ports. Stop it, or edit `docker-compose.yml` to use different host ports (e.g., change `"127.0.0.1:8428:8428"` to `"127.0.0.1:18428:8428"`). Update your `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` to match.

### Vector can't reach the Docker socket

On Linux, the user running `docker compose up` must be in the `docker` group. Run `sudo usermod -aG docker $USER` and log out/in, or prefix with `sudo`. On Mac/Windows, Docker Desktop manages socket access automatically.

### Metrics not appearing in vmui after a run

1. Confirm the env var is set: `echo $OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
2. Check for `telemetry.export_failed` warn logs in the service output.
3. Test the OTLP endpoint directly: `curl -s http://localhost:4318/opentelemetry/api/v1/push` (should return a response, not a connection error).
4. Verify VictoriaMetrics is running: `docker compose ps victoriametrics`.
