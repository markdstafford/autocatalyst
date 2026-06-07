---
date: 2026-06-06
status: accepted
---
# Doc-maintenance conventions

How the durable doc corpus is kept current as the system changes. These are the conventions compaction and
the agents working a run follow; the corpus model itself is `context-human/concepts/docs-model.md`, and
prose style is `mm:writing-guidelines`. This records the maintenance rules, not the writing style.

## Same-PR updates

Durable docs are updated in the same pull request as the code that changes them. The `docs.update` step
(ADR-029) puts the doc refresh on the same branch as the implementation, so the docs and the code that made
them true ship together rather than drifting apart between changes.

## Code is authoritative once built

A concept doc states the **contract and intent** — what a part of the system does and why. Once the code
exists, the **code is authoritative for the detail**: a doc does not mirror line-level implementation. When
a doc and the code drift on detail, the code is right and compaction refreshes the doc. When they drift on
intent, that is a real divergence a person resolves, not a refresh.

## Split when a doc outgrows its scope

Depth is proportional to the topic, not a target length, but length is a signal to look for a split. At this
level of specificity most concept docs sit under about 200 lines. At each 50-line step past that — 200, 250,
300 — actively look for a place to split the doc, and keep it whole only when it is highly cohesive and
genuinely needs to be read as one piece. The concepts index absorbs the navigation a split adds.

## Each concept doc ends with a relationships block

A concept doc closes with the same three-part tail: **Relationships** (the neighboring concepts and who owns
what), then **Constraints and decisions** (the fixed points, with the ADRs they rest on), then **Open edges**
(what the design leaves room for but does not build). This keeps the boundaries between concepts legible and
states a concept's dependencies in one place.

## Index entries

- **The concepts index** is the primary way an agent discovers which concept docs to read, so each entry is
  a short paragraph — enough for an agent to judge whether to open the doc — not a one-line label.
- **The ADR index** stays terse: one line per ADR stating the decision.

## Authority follows the two trees

Human-owned docs (`context-human/`: `app.md`, `spec.md`, `concepts/`, `adrs/`, `specs/`) change through the
`docs.human_review` gate — an agent proposes the diff, a person approves it. Agent-owned context
(`context-agent/`: decisions, standards, wiki, code map) is maintained directly by the agent doing the work,
with no gate. Both land in the pull request; only the human-owned changes are reviewed at the doc gate.
