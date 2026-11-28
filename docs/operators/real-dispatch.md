# Real dispatch

## Add a testing guide route before upgrading

The feature, enhancement, bug, and chore workflows now run
`implementation.testing_guide` after each completed build and before implementation review.

If you use an active model routing table, add an agent route for this step **before upgrading**.
Use `PATCH /v1/configuration-records/:id` on the active `model_routing_table` record. Send
`{"kind":"model_routing_table","settings":{"entries":[...]}}` with your existing entries plus
one entry below. The patch replaces the entire entries array. Keep every existing route, choose a
unique entry ID, and substitute an existing agent profile ID.

For an explicit implementer route:

```json
{"id":"guide-author","profileId":"<agent-profile-id>","route":{"mode":"agent","step":"implementation.testing_guide","role":"implementer"}}
```

For a default route for this step:

```json
{"id":"guide-default","profileId":"<agent-profile-id>","route":{"mode":"agent","step":"implementation.testing_guide","defaultForStep":true}}
```

Use a profile that supports the guide's `Read`, `Glob`, and `Grep` policy, such as Claude Agent SDK
or OpenAI Agents SDK. Codex App Server requires its shell for repository inspection and rejects this
policy with `tool_policy_unsupported`.

If neither route matches, the run stops at the testing guide step with `route_not_found`.
The explicit default provider profile applies only when there is no active routing table.
If the run already stored a guide, you can still retrieve it with
`GET /v1/runs/:id/testing-guide` while you update the configuration and recover the run.
