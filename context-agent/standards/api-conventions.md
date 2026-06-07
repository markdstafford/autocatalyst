---
date: 2026-06-04
status: accepted
---
# API naming and casing conventions

Three layers, each with its own convention. The home for the API surface is
`context-human/concepts/api.md`; this records the casing rules agents reach for when extending it.

- **URL paths** — lowercase, plural-noun collections (`/runs`, `/conversations`); kebab-case for
  multi-word action sub-resources (`/runs/{id}/set-step`).
- **JSON field names** — camelCase (`aggregateCost`, `mainTopic`), so the TypeScript types derived from
  the `api-contract` Zod schemas match the wire shape with no transform layer.
- **Enum and literal values** — snake_case, with `.` for hierarchical steps: `wont_fix`, `file_issue`,
  `start_topic`, `spec.author`, `implementation.human_review`.

The three layers differ on purpose: a path action (`set-step`) and an enum value (`wont_fix`) follow
different conventions because they sit at different layers, not inconsistently.
