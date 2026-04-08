# Autocatalyst

AI-led development loop: idea → spec → approval → implementation → evaluation.

## Repo structure

```
AGENTS.md                 ← you are here
context-human/            ← humans have authority; agents read freely
  specs/                  ← feature specs, enhancement specs, app.md
  adrs/                   ← architectural decision records (human-decided)
context-agent/            ← agents have authority; humans rarely need to look here
  decisions/              ← agent-made technical decisions
  standards/              ← coding, testing, logging conventions
  wiki/                   ← domain model, reference docs (grows with codebase)
src/                      ← source code (not yet created)
```

## Key principles

1. **Agent-first** (ADR-001): every decision is evaluated through agent efficacy. Code, docs, tests, and observability are optimized for agents.
2. **Authority split** (ADR-002): `context-human/` = humans decide. `context-agent/` = agents decide. The split is for human legibility — agents read both.
3. **Spec is canonical** (ADR-003): specs are structured Markdown with YAML frontmatter, committed to `context-human/specs/`. The spec is a living document updated alongside implementation.

## Working in this repo

- Read `context-agent/standards/` before writing code
- Read `context-agent/decisions/` before making architectural choices — check if a decision already exists
- Read `context-human/specs/app.md` for the full product description
- Read `context-human/adrs/` for human-decided architectural context
- Place new agent decisions in `context-agent/decisions/`
- Place new standards in `context-agent/standards/`
- Never modify `context-human/` without human approval

## Decision format

Human ADRs in `context-human/adrs/` use narrative format with alternatives and consequences.

Agent decisions in `context-agent/decisions/` use a terse format:

```markdown
---
date: YYYY-MM-DD
status: accepted
superseded_by: null
---
# [topic]
**Decision:** [one sentence]
**Rationale:** [bullets]
**Constraints:** [what shaped this]
**Rejected:**
- [option]: [reason]
```

## Quick reference

| I need to...                    | Look at                              |
|---------------------------------|--------------------------------------|
| Understand the product          | `context-human/specs/app.md`         |
| Know the coding conventions     | `context-agent/standards/`           |
| Check if a decision was made    | `context-agent/decisions/`           |
| Understand a human decision     | `context-human/adrs/`                |
| Know the domain concepts        | `context-agent/wiki/domain-model.md` |
