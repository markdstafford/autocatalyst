---
created: 2026-04-08
last_updated: 2026-04-08
status: stub
---

# Idea to spec to review

Spec generation from an idea, posted to Slack for iterative human review.

## Scope

- Receive classified idea from message router
- Run `claude` CLI with mm:planning to generate spec headlessly
- Post spec sections to the idea's Slack thread
- Collect human feedback from thread replies
- Iterate: feed feedback back to spec generation, repost updated sections
- Continue until human is satisfied (but approval is a separate feature)
