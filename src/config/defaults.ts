export function generateDefaultWorkflow(repoName: string): string {
  return `---
polling:
  interval_ms: 30000
workspace:
  root: ~/.autocatalyst/workspaces/${repoName}
# slack:
#   bot_token: $SLACK_BOT_TOKEN
#   app_token: $SLACK_APP_TOKEN
#   channel_name: my-channel
#   reacjis:
#     ack: eyes            # emoji applied to every inbound message (default: eyes)
#     complete: white_check_mark  # emoji applied when work finishes; set to null to disable
---

You are working on an idea for the ${repoName} project.

{{ idea.content }}
`;
}
