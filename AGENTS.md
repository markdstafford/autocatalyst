# Autocatalyst — agent instructions

Keep this file short. It holds only the rules you must not miss. Everything else lives in the
docs below and in the context **you** maintain for yourself.

## The one rule that matters most

**You own `context-agent/`. Use, maintain, optimize, and organize it for your future self.**
As you learn anything durable — a technical decision, a module layout, a non-obvious wiring, a
gotcha — write it to `context-agent/` in the *same* change, so the next agent never has to
rediscover it. Organize it however serves agents best; humans rarely look here.

## Doc authority

- `context-human/` — humans decide; you read freely, never edit without approval.
  `spec.md` (the canonical central technical overview, maintained by compaction), `app.md` (product
  overview), `concepts/` (architecture contracts), `specs/` (frozen point-in-time specs),
  `adrs/` (human decisions).
- `context-agent/` — yours: `decisions/` (terse technical decisions), `standards/`
  (coding/testing/logging conventions), `wiki/` (domain notes, gotchas, and the **code map**).

## Rules

1. Before coding, read the relevant `concepts/`, `context-agent/standards/`, and
   `context-agent/wiki/code-map.md` (to find things); check `context-agent/decisions/` for an
   existing decision before making a new one.
   - Start from the canonical central overview `context-human/spec.md`, then find the right concept or
     decision via `context-human/concepts/index.md` and `context-human/adrs/index.md` rather than
     opening every file.
2. **Keep `context-agent/wiki/code-map.md` current** — it is how agents navigate the codebase.
   Update it whenever you add, move, or significantly change a module.
3. Record new technical decisions in `context-agent/decisions/` using the terse format below.
   Architecture contracts and human decisions belong in `context-human/` (with approval).
4. Use `micromanager` for any human-facing document (specs, ADRs, concept docs, PR/issue
   writeups, release notes).
5. Don't invent build/test/run commands before the scaffold defines them; once they exist,
   record them in `context-agent/wiki/`.
6. Keep `context-human/concepts/index.md` and `context-human/adrs/index.md` current — add or update
   the entry whenever you add or rename a concept or ADR. Maintain index(es) for `context-agent/` too
   where the volume warrants.

## Agent decision format (`context-agent/decisions/<topic>.md`)

```markdown
---
date: YYYY-MM-DD
status: accepted
superseded_by: null
---
# <topic>
**Decision:** <one sentence>
**Rationale:** <bullets>
**Constraints:** <what shaped this>
**Rejected:** <option — reason>
```
