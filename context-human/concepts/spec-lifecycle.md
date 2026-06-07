---
created: 2026-06-06
last_updated: 2026-06-07
status: active
roadmap: spec
---

# Spec lifecycle

This concept owns the spec *as a file in the repository*: a durable versioned document, independent of any
one run. It covers the committed-frontmatter status the spec carries, the metadata contract that frontmatter
holds to, how a spec is superseded, and the per-kind rule for whether a work product becomes a committed file
at all. The `Artifact` *entity* (its database record, operational handle, cached status, and publications)
belongs to `domain-model` and ADR-017. The run-time touch points that author the spec, amend it, and freeze
it belong to `workflow`, `feedback`, and ADR-028; the in-app review surface is a DESK concern (`artifact-review`).
This concept is what the spec is as a document, across and beyond the run that produced it.

## The committed file and the database record

A file-canonical spec takes two forms. The `Artifact` entity in the database is the operational handle: where
the spec lives, which run produced it, its publications, its linked issue, and a cached status the core
refreshes as it works (`domain-model`). The committed Markdown file in the repository is the durable record:
its YAML frontmatter is the source of truth for the document's own state, and it outlives the run, the
database row, and the workspace the run used. When the two disagree, the committed frontmatter is the truth
about the document and the cached status is a convenience the database keeps for fast reads.

This concept is about the file. The frontmatter it carries, the status that frontmatter moves through, and
the supersession it records are the document's own facts, written into the repository's history.

## The committed-frontmatter status

The frontmatter `status` moves through five values, in micromanager's vocabulary (`mm-integration`):
`draft`, `approved`, `implementing`, `complete`, `superseded`. Autocatalyst adds no status values of its own; these
five are the document's durable states. The run drives the transitions:

- **`draft`** while the spec is being authored and through human review of it.
- **`approved`** when `spec.human_review` approves the spec to build from.
- **`implementing`** when the run enters the implementation phase.
- **`complete`** at `pr.finalize`, when the spec freezes and the change ships.
- **`superseded`** when a later spec replaces this one (see below).

The status records milestones in the document's life, not the run's moment-to-moment state. A spec being
revised after feedback is still `draft`; a spec whose run is paused at a gate still reads from whichever
milestone it last reached.

## Operational status maps down onto the frontmatter

The `Artifact` entity's cached status (`domain-model`) is Autocatalyst's own, richer set. It tracks
operational states the committed document does not need to record, such as awaiting feedback or canceled.
The relationship between the two is a one-way mapping, not a shared enum: the operational status maps *down*
onto a frontmatter value at the moments Autocatalyst writes the file. An operational "awaiting feedback"
maps to frontmatter `draft`; a canceled, never-approved spec may never be committed at all and so never
acquires a committed status. The two sets stay distinct on purpose: the operational status serves the
running system, the frontmatter status serves the durable document, and the mapping is the bridge between
them.

## The frontmatter is a contract

The frontmatter is a schema Autocatalyst enforces, not free text. `issue` is an integer, the required fields
are present, `status` is one of the five values, and the supersession references are well-formed slugs. A
malformed value (a tracker URL where an integer belongs, or a missing required field) goes through the
tolerance pipeline (ADR-012) and the contract check (ADR-027): deterministic repair first, then the agent is
asked to correct it before the spec is recorded. A spec is not committed with a frontmatter that breaks the
contract. The field-by-field schema is `context-agent/standards/spec-frontmatter.md`.

## Where the durable record lives, per kind

The four work kinds differ in *where the durable record of the work lives*. A single per-kind axis, the
canonical record, holds this: valued `file`, `issue`, `other`, or `none`. Two values are used today:

- **File-canonical** — `feature_spec` and `enhancement_spec`. The committed Markdown spec under
  `context-human/specs/` is the source of truth. It carries the full frontmatter and moves through the whole
  `status` lifecycle. An `enhancement_spec` is a file-canonical document exactly as a `feature_spec` is; it
  adds to an existing feature rather than replacing it.
- **Issue-canonical** — `bug_triage` and `chore_plan`. The tracker issue is the source of truth. The triage
  document is a transient working note in the workspace scratch location and is not committed to
  `context-human/specs/`, because the issue already holds the durable record.

`other` and `none` are room in the axis for future kinds whose record lives somewhere else or nowhere
durable; no current kind uses them. The kind itself does not decide whether the work is implemented (every
kind's run goes on to implementation), so the canonical record is the only thing the kind fixes here.

## Where specs are authored and committed

Every spec is authored in the workspace scratch location, wherever the kind's record ultimately lives
(`workspace` owns the path). For a file-canonical kind, the approved spec is committed into
`context-human/specs/` as a versioned file, and its frontmatter status is written through the mapping above
as the run advances. For an issue-canonical kind, the triage note stays in scratch and its content is
carried into the tracker issue; nothing lands in `context-human/specs/`.

## Supersession

A spec is superseded when a later spec wholly replaces it. The replacing spec carries
`supersedes: <old-slug>`; the replaced spec gains `superseded_by: <new-slug>` and its status moves to
`superseded`. References are by filename slug. The agent authoring the replacing spec proposes the
supersession, and because it edits a committed, human-owned spec, the change is confirmed at the spec human
gate, the same approval path any human-owned doc edit takes. The replaced `Artifact`'s cached operational
status flips to superseded when the file commits with that status.

Supersession is for wholesale replacement, which is uncommon: change usually arrives as a new
`enhancement_spec` against an existing feature, not as a replacement, and a shipped spec is not reopened as a
matter of course.

## The freeze

A spec is approved to build from at `spec.human_review`, not frozen there; it stays a mutable working
document through implementation, and implementation feedback amends it in place (`feedback`, ADR-028). This
concept owns the other end of that rule: the spec freezes at `pr.finalize`, and the freeze is what writes the
committed frontmatter (`status: complete` and the final field values) into the repository. The freeze is
re-applied on each pass that reaches `pr.finalize` and is durable once the pull request merges and the run
reaches `done`. After that the document is a point-in-time record; editing a shipped spec is possible but is
not the standard path, and the durable source of truth for how the system works shifts to the living concept
docs and `spec.md`, refreshed by compaction (`docs-model`).

## Relationships

- `domain-model` — owns the `Artifact` entity, its kinds, its operational handle, and the cached status this
  concept maps down from; this concept owns the committed file and its frontmatter.
- `workflow` — owns the spec phase, the steps that author and approve the spec, and `pr.finalize` where the
  freeze happens; this concept owns what the freeze writes.
- `feedback` — owns the amend-then-change behavior during implementation; this concept owns the frozen-at-
  ship rule and the frontmatter the amendments and the freeze write.
- `docs-model` — owns the wider corpus the durable source of truth shifts into; this concept owns the per-
  spec document the corpus is built from.
- `artifact-review` (DESK) — owns the in-app surface for reading and editing a spec; this concept owns the
  document that surface renders.
- `mm-integration` — owns the invocation of `mm:planning`, which authors file-canonical specs to this schema.

## Constraints and decisions

- The committed frontmatter is the source of truth for the document's state; the database cached status is a
  convenience, and the frontmatter outlives the run (ADR-017).
- The frontmatter status set is micromanager's `draft`, `approved`, `implementing`, `complete`, `superseded`,
  in that order; Autocatalyst adds no status values and maps its operational status down onto these
  (`mm-integration`).
- The frontmatter is a contract (integer `issue`, required fields, valid status, well-formed slugs),
  verified through the tolerance pipeline before a spec is recorded (ADR-012, ADR-027).
- Each kind fixes a canonical record: `feature_spec` and `enhancement_spec` are file-canonical;
  `bug_triage` and `chore_plan` are issue-canonical (ADR-017).
- Specs are authored in the workspace scratch location; file-canonical specs commit to
  `context-human/specs/`.
- Supersession is recorded by `supersedes`/`superseded_by` slugs and the `superseded` status, proposed by
  the authoring agent and confirmed at the spec human gate.
- The spec freezes at `pr.finalize`, durable at merge (ADR-028).

## Open edges

- **`superseded` as a committed status** is the document's terminal state for replacement, alongside the
  `superseded_by` field. Recording it depends on micromanager carrying `superseded` as a valid frontmatter
  status value; the schema reserves it now.
- **Per-revision spec versioning** (addressing each committed version of a spec across revise rounds) is
  groundwork the committed-history model leaves room for, not a built capability (it composes with
  `feedback`'s same open edge).
- **The `other` and `none` canonical-record values** are reserved for kinds whose durable record lives
  elsewhere or nowhere; no current kind uses them, and a kind that produces a spec without implementation
  would arrive as a configuration or capability, not a default.
