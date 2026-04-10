---
polling:
  interval_ms: 30000
workspace:
  root: ~/.autocatalyst/workspaces/autocatalyst
slack:
  bot_token: ${AC_SLACK_BOT_TOKEN}
  app_token: ${AC_SLACK_APP_TOKEN}
  channel_name: ac-recursive
# notion:
#   integration_token: ${AC_NOTION_INTEGRATION_TOKEN}
#   parent_page_id: YOUR_NOTION_PARENT_PAGE_ID  # The page ID under which specs will be created
---

You are working on an idea for the autocatalyst project.

{{ idea.content }}
