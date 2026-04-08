---
created: 2026-04-08
last_updated: 2026-04-08
status: stub
---

# Foundation

CLI entry point, configuration, and structured logging.

## Scope

- CLI that starts the service with a target repo URL, Slack channel, and credentials
- Configuration loading (env vars, config file, CLI flags)
- pino structured JSON logging on all events
- Graceful startup and shutdown
- This is the skeleton that features 2-4 build on
