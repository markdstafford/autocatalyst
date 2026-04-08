---
created: 2026-04-08
last_updated: 2026-04-08
status: stub
---

# Approval to implementation to done

Approval signal triggers implementation in an isolated workspace, results posted back.

## Scope

- Detect approval signal (emoji reaction on spec message in thread)
- Create isolated workspace (shallow clone of target repo)
- Run `claude` CLI with OMC / autopilot, passing approved spec as context
- Post implementation status and result to the idea's Slack thread
- Report success or failure
- Clean up workspace on terminal state
