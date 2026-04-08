---
created: 2026-04-08
last_updated: 2026-04-08
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR 002: Repository context architecture

## Status

Accepted

## Context

Specs are the primary artifact humans need to read or act on. A repo that mixes specs with agent-maintained artifacts — standards, wiki documents, decision logs — creates noise that makes it harder to find the things that need human attention.

Context is organized for human legibility. By separating collaborative artifacts (specs, ADRs) from agent-maintained artifacts (standards, wiki, decisions), humans can open the repo, go to one folder, and see exactly what requires their input — nothing more.

A root-level `AGENTS.md` is also needed as an entry point and map. This is an established convention across agent-optimized repositories and serves as the first file agents load when orienting to a new codebase.

## Decision

The repo uses three top-level context artifacts:

- **`AGENTS.md`** (root level, ~100 lines): a map of the repo. Points agents to key locations and artifacts. Kept intentionally short so it fits easily in context.
- **`context-human/`**: artifacts that humans have authority over. Humans decide what goes here, review it, and approve changes.
- **`context-agent/`**: artifacts that agents have authority over. Agents create and maintain these autonomously.

The distinction is about authority, not access. Agents read both folders freely. The folder name signals who has the final say over what it contains.

## Consequences

**Positive:**

- Humans can open the repo and immediately find what requires their attention — no noise from agent-maintained content
- The symmetric naming is self-documenting — the convention is clear without reading documentation
- Agents know exactly where to place new artifacts, reducing misclassification

**Negative:**

- `context-human` can be misread as "only for humans" — requires a clarifying note in `AGENTS.md`
- Broad context sweeps require checking two roots
- `context-agent` sorts before `context-human` alphabetically

## Alternatives considered

- **Single `context/` root with agent subfolder** (`context/auto/`, `context/z/`, `context/faba/`): the authority distinction is less visible at a glance; subfolder naming requires an internalized convention rather than being self-documenting at the root level
- **Underscore prefix within `context/`** (`_wiki/`, `_standards/`): underscore-prefixed items sort to the top, not the bottom; the meaning of `_` is ambiguous across ecosystems
- **Single `context/` root, no distinction**: humans cannot visually separate what requires their attention from what does not
