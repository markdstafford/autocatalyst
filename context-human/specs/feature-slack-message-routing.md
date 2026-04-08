---
created: 2026-04-08
last_updated: 2026-04-08
status: stub
---

# Slack + message routing

Slack connection and intelligent message classification.

## Scope

- Bolt SDK connection to configured channel
- Receive all messages in channel
- Classify intent: new idea, spec feedback (thread reply), or general conversation
- General messages get a conversational response from the AI
- Ideas and spec feedback are routed to the appropriate handler (features 3 and 4)
- One channel per repo, one thread per idea
