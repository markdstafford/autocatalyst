---
created: 2026-06-06
last_updated: 2026-06-06
status: active
roadmap: spec
---

# Docs model

The durable documentation-and-intent model for a project: the corpus of docs, how they are layered for an
agent to read top-down, and the compaction step that refreshes the corpus from the work a run produces. This
concept owns the whole-corpus model and the compaction that maintains it. The lifecycle of a single spec is
`spec-lifecycle`; compaction as an invoked micromanager skill is `mm-integration`; the workflow step and gate
that run compaction are `workflow`, `hitl`, and ADR-029. The model applies to itself: the concept docs, ADRs,
and central overview in this repository are maintained under it.

## The corpus and its two trees

The corpus has a single entry point and two ownership trees.

`AGENTS.md` is the entry point and the top-level map. It disambiguates the three things an agent
needs to find (the central `spec.md`, the human-owned tree, and the agent-owned tree) and states the
ownership of the two trees plainly. It links directly to the central overview, the concepts index, the ADR
index, and the indexes of the agent-owned tree, so an agent can reach any of them in one step.

- **`context-human/`** is human-owned: `app.md`, the central `spec.md`, the living concept docs under
  `concepts/`, the ADRs under `adrs/`, and the frozen specs under `specs/`. Humans decide here. Agents help
  heavily and in practice write most of it, but every change to a human-owned doc is approved by a
  person.
- **`context-agent/`** is agent-owned: terse technical decisions, coding and process standards, and a wiki
  that holds domain notes, gotchas, and the code map. This tree is the agent's area; the agent decides its
  layout. The model recommends shapes for it but does not mandate them.

The central `spec.md` and the concept docs are refreshed by compaction, but that is a maintenance property
rather than a separate ownership: they stay human-owned and a person approves their diffs.

## Progressive disclosure: a map, hubs, and leaves

An agent reads the corpus top-down and goes only as deep as the task needs. `AGENTS.md` is the map; from it
an agent reaches a small set of hubs (the central `spec.md`, the concepts index, the ADR index, and the
agent-owned indexes), and from a hub it reaches the leaves: a concept doc, an ADR, a frozen spec, a code-map
entry. The path is short by design: map to hub to leaf. The central `spec.md` is one place an agent may
start, but it can also go straight to an index; the agent-owned wiki is a peer hub, not the tail of a chain.
A typical read picks up a concept, a couple of ADRs, and a code-map pointer in a single pass.

The layers hold progressively more detail, which is what makes the short path work. The overview is brief
because the detail it omits lives one link down.

## The central overview is bounded and lossy

`spec.md` is a single document that describes the whole application. When the application is a monorepo that
composes several pieces, the overview names and describes each one: the service, the desktop app, a mobile
app. It is held to a finite length, a working bound of roughly five to ten pages, so an agent can read it
first and in full. Holding the length makes the overview lossy, which is intended. The detail it drops lives
in the concept docs, the ADRs, and the specs the overview links down into. `spec.md` points mostly at the
concept docs, also at the ADRs, and sometimes at a feature spec.

## The two indexes

The concepts index is the primary way an agent discovers which concept docs are worth opening. Because each
concept doc is a substantial document, the index entry is a short paragraph per concept — enough detail for
an agent to judge whether to open the doc — rather than a one-line label. The ADR index stays terse: one
line per ADR stating the decision, because the ADRs themselves are the place to read the reasoning. Both
indexes are hubs `AGENTS.md` links to directly.

## Compaction refreshes the corpus bottom-up

Compaction is how the corpus stays true to the system as the system changes. It runs inside a run, as the
`docs.update` step in the `docs` phase, after the implementation is agreed and before the pull request opens
(ADR-029). It works **bottom-up** through the layers — the inverse of the read path:

1. It reads the frozen specs and the implementation the run produced, and refreshes the living concept docs
   and the ADRs from them.
2. It rolls the refreshed concepts up into the bounded central `spec.md`.

Frozen specs are read, never rewritten; they are point-in-time records (`spec-lifecycle`), so compaction
moves detail upward into the living docs rather than editing the specs themselves. The human-owned changes
it proposes (concept docs, ADRs, `spec.md`) become diffs a person approves at the `docs.human_review` gate.
The agent-owned context updates happen in the same step, applied directly without a gate.

Compaction's depth is proportional to the change: a small change that moves no concept produces no
human-owned diff, the gate has nothing to hold, and the step is a near no-op. The method of compaction is a
micromanager skill the step invokes (`mm-integration`); this concept owns what the corpus is and what
compaction is for, not how the skill performs it.

## Agents maintain their own context

The agent-owned tree is maintained by the agent doing the work, as part of doing it. During `docs.update`
the agent is prompted to update `context-agent` where the change calls for it (a new decision, a revised
standard, a wiki note, a code-map entry), and those updates are applied directly, with no human gate. They
land in the same pull request as everything else, and a person sees them there, but they are not reviewed at
the doc gate, because the agent-owned tree is the agent's to keep current. This pattern lets the
next agent work the codebase without a person reconstructing context by hand.

## Relationships

- `spec-lifecycle` — owns the per-spec frozen document compaction reads from; this concept owns the wider
  corpus those specs feed.
- `mm-integration` — owns the invocation of the compaction skill and the boundary between Autocatalyst and
  micromanager; this concept owns what compaction does for the corpus.
- `workflow` — owns the `docs` phase and the `docs.update` step in the catalog; this concept owns the doc
  model that step maintains.
- `hitl` — owns the `docs.human_review` gate as a pause-and-resume mechanism; this concept owns the doc
  diffs that gate approves.
- `architecture` — owns the `context-human`/`context-agent` authority split and `AGENTS.md` as the map
  (ADR-002); this concept builds the corpus on that split.

## Constraints and decisions

- Two ownership trees: `context-human` (human-owned, human-approved) and `context-agent` (agent-owned,
  agent-maintained); `AGENTS.md` is the entry point and map (ADR-002).
- The corpus is read map-to-hub-to-leaf; `AGENTS.md` links directly to `spec.md`, the concepts index, the
  ADR index, and the agent-owned indexes.
- The central `spec.md` is held to a finite length (about five to ten pages) and is lossy by design; the
  detail lives in the layers below.
- The concepts index carries a short paragraph per concept; the ADR index stays one line per ADR.
- Compaction runs bottom-up — specs and implementation into concepts and ADRs, concepts into `spec.md` —
  inside the `docs.update` step, refreshing the corpus proportional to the change (ADR-029).
- Human-owned doc changes are approved at the `docs.human_review` gate; agent-owned context updates are
  applied directly in the same step (ADR-029).
- Per-doc maintenance follows `context-agent/standards/doc-maintenance.md`.

## Open edges

- **A standalone whole-corpus compaction pass**, run outside a single run, belongs to a future
  repository-health workflow; in-run compaction is what exists here.
- **Enriching the concepts index** so every entry is a paragraph is a maintenance task across the existing
  index, not only a rule for new entries.
- **The compaction skill is a composite today** (narrower micromanager skills rather than one method), so
  the model describes what compaction is for, and the single skill it names is a dependency micromanager
  carries (`mm-integration`).
