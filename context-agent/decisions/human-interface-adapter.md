---
date: 2026-04-08
status: accepted
superseded_by: null
---

# Human interface adapter

**Decision:** Slack via Bolt SDK as the initial implementation. Adapter interface defined for future platforms.

**Rationale:**
- Slack is the team's communication platform — meets users where they are
- Bolt SDK is Node-native, well-maintained, handles event subscriptions and message posting cleanly
- Slack's threading model maps naturally to spec review (idea → thread → feedback → approval)
- Emoji reactions and thread replies provide lightweight approval signals without custom UI

**Adapter interface:**
- `receive(): AsyncIterable<Idea>` — stream of inbound ideas from the platform
- `post(runId: string, content: string): MessageRef` — post content (spec section, status update) to the platform
- `awaitApproval(messageRef: MessageRef): Promise<ApprovalSignal>` — wait for human approval on a posted message
- `postUpdate(runId: string, content: string): void` — post a status update (implementation progress, completion)

**Approval signals (Slack-specific):**
- Emoji reaction (configurable, default: thumbsup) on a spec message
- Thread reply containing an approval keyword (configurable, default: "approved", "lgtm")
- Slash command `/approve` in the spec thread

**Constraints:**
- Human interface is intentionally abstract (app.md) — Slack is the first adapter, not the only one
- Approval signals must be unambiguous — no risk of casual messages being interpreted as approval
- Must support bidirectional communication (inbound ideas, outbound specs/status)

**Rejected:**
- Discord: viable but Slack is the team's platform; Discord adapter is a future addition
- Linear/GitHub Issues: natural for tracking but less immediate for real-time feedback loops
- Custom web UI: adds a client to build and maintain; violates "no dedicated UI" principle from app.md
