# Stack

## Service

TypeScript on Node.js. Event-driven orchestrator, single-authority scheduler. CLI start locally, containerized for hosted deployment.

## Human interface

Slack via Bolt SDK. Ideas as messages, specs pushed to Canvases, feedback in threads, approval via emoji/reply/command. Adapter interface: `receive()`, `post()`, `awaitApproval()`, `postUpdate()`.

## Agent runtime

`@anthropic-ai/claude-agent-sdk` via the `query()` function. Adapter interface: `start()`, `stream()`, `stop()`, `status()`.

## Spec format

Structured Markdown with YAML frontmatter in `context-human/specs/`. Micromanager convention. What/why → design → task list. Tasks checked off during implementation.

## State

Layered:
- Orchestrator state: in-memory, single authority
- Workspace state: filesystem, one directory per run (shallow git clone)
- Loop state: filesystem checkpoints, Postgres for hosted

## Observability

OpenTelemetry SDK. Structured JSON logs via pino to stdout. Victoria stack (VictoriaLogs, VictoriaMetrics, VictoriaTraces + Vector) as target backend.

## Loop configuration

WORKFLOW.md in target repo. Prompt templates, stage policies, runtime settings. Hot-reloadable.

## Key dependencies

| Dependency | Purpose |
|---|---|
| Node.js 22+ | Runtime |
| TypeScript | Language |
| Slack Bolt SDK | Human interface adapter |
| `@anthropic-ai/claude-agent-sdk` | Agent runtime adapter |
| pino | Structured logging |
| OpenTelemetry SDK | Traces and metrics |
| Vitest | Testing |
