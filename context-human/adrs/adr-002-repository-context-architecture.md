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

Agents need to find context quickly and place new artifacts in the right location without explicit instruction for every operation. Without a deliberate structure, two failure modes emerge: agents misplace artifacts (putting agent-maintained content where humans expect to collaborate), and humans struggle to find the artifacts that require their attention.

Two distinct types of context exist in this repo. The first is collaborative — specs and ADRs that humans and agents create and refine together, and that humans must review and approve. The second is agent-maintained — standards, wiki documents, and decision records that agents create and update autonomously, and that humans rarely need to interact with directly.

The naming and structure of these two layers should be self-documenting. Agents encountering the repo for the first time should be able to infer where to look and where to write without reading documentation first. Humans should immediately know which folders require their attention.

A root-level `AGENTS.md` is also needed as an entry point and map. This is an established convention across agent-optimized repositories and serves as the first file agents load when orienting to a new codebase.

## Decision

The repo uses three top-level context artifacts:

- **`AGENTS.md`** (root level, ~100 lines): entry point and map for agents. Points to key locations, summarizes conventions, and provides orientation. Maintained collaboratively; kept short so it fits in context without crowding out the task.
- **`context-human/`**: human-agent collaborative content. Humans actively review and approve artifacts here. Contains `specs/` and `adrs/`.
- **`context-agent/`**: agent-maintained content. Agents create and update these artifacts autonomously. Contains `wiki/`, `standards/`, and `decisions/`.

Audience is encoded in the folder name, not in file frontmatter. The naming convention — `context-human` and `context-agent` — is symmetric and self-documenting.

Note: `context-human` means "humans and agents collaborate here," not "only for humans." Agents read and reference these artifacts freely; the distinction is about who initiates and approves changes.

## Consequences

**Positive:**

- Agents know exactly where to place new artifacts without explicit instruction — misclassification is unlikely
- Humans know exactly which folder requires their attention for reviews and approvals
- The symmetric naming is self-documenting — no documentation required to understand the split
- Doc-gardening agents have a clear, bounded target for maintenance tasks in `context-agent/`
- Scales cleanly as artifact counts grow in either layer

**Negative:**

- `context-human` can be misread as "only for humans" — requires a clarifying note in `AGENTS.md`
- Broad context sweeps require checking two roots; agents must be instructed to look in both
- `context-agent` sorts before `context-human` alphabetically — agent-maintained content appears first in directory listings

## Alternatives considered

### Single `context/` root with agent subfolder

All content under one root, with agent-maintained artifacts in a named subfolder (`context/auto/`, `context/z/`, `context/faba/`).

**Pros:**
- Single root simplifies broad context loading (`context/**` gets everything)
- Keeps all context visually grouped

**Cons:**
- Placement reliability depends on how self-descriptive the subfolder name is; opaque names like `faba/` produce misplacements
- The distinction between collaborative and agent-maintained content is less visible at a glance

**Why not chosen:** Two named roots make the audience distinction explicit at the top level, reducing misplacement without requiring agents to internalize a subfolder convention.

### Underscore prefix within `context/`

Agent-maintained directories prefixed with `_` inside a single `context/` root (`_wiki/`, `_standards/`, `_decisions/`).

**Pros:**
- Underscore-as-internal is a widely understood convention
- Single root for all context

**Cons:**
- Underscore-prefixed items sort to the top of directory listings, not the bottom
- The semantic meaning of `_` is ambiguous across ecosystems

**Why not chosen:** Sort order works against discoverability (agent-maintained content surfaces first), and the meaning of `_` requires documentation to interpret correctly.

### Single `context/` root, no audience distinction

All artifacts in one root with audience encoded only in frontmatter metadata.

**Pros:**
- Simplest possible structure
- No convention to learn

**Cons:**
- Agents must read frontmatter to determine placement rules rather than inferring from location
- Humans cannot visually distinguish what requires their attention from what does not

**Why not chosen:** Encodes audience in metadata rather than structure, which reduces the self-documenting property that makes agent-first repos reliable.
