---
polling:
  interval_ms: 30000
aws_profile: ai-prod-llm
workspace:
  root: ~/.autocatalyst/workspaces/autocatalyst
slack:
  bot_token: ${AC_SLACK_BOT_TOKEN}
  app_token: ${AC_SLACK_APP_TOKEN}
  channel_name: ac-autocatalyst
  reacjis:
    ack: eyes
notion:
  integration_token: ${AC_NOTION_INTEGRATION_TOKEN}
  specs_database_id: 09be47fc-74c3-42f0-b85a-fb5bdf7ed6c4
  testing_guides_database_id: 59def47e-1412-4c6c-b747-8302f2ae07a5
---

You are working on an idea for the autocatalyst project.

{{ idea.content }}
