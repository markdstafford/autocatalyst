---
polling:
  interval_ms: 30000
workspace:
  root: ~/.autocatalyst/workspaces/autocatalyst
slack:
  bot_token: ${AC_SLACK_BOT_TOKEN}
  app_token: ${AC_SLACK_APP_TOKEN}
  channel_name: ac-recursive
notion:
  parent_page_id: 33e4409428b780a2a9cfd3e38f06b8e4
# Note: Set AC_NOTION_INTEGRATION_TOKEN as an environment variable (not in this file)
---

You are working on an idea for the autocatalyst project.

{{ idea.content }}
