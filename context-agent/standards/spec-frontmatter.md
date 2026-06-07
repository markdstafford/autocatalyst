---
date: 2026-06-07
status: accepted
---
# Spec frontmatter schema and contract

A file-canonical spec carries a YAML frontmatter block whose format is micromanager's
(`mm-integration`). This records the schema Autocatalyst enforces and how it enforces it. The lifecycle the `status` field moves
through belongs to `context-human/concepts/spec-lifecycle.md`; this records the schema, not the machine.

## The fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `created` | date (`YYYY-MM-DD`) | yes | Set when the spec is first authored. |
| `last_updated` | date (`YYYY-MM-DD`) | yes | Bumped on every write to the spec. |
| `status` | enum | yes | `draft`, `approved`, `implementing`, `complete`, `superseded`. |
| `issue` | integer | no | The tracker issue number, an integer — not a URL or a string. |
| `specced_by` | GitHub username | yes | Who authored the spec. |
| `implemented_by` | GitHub username | no | Who implemented it; set when the run enters implementation. |
| `supersedes` | spec slug | no | The spec this one replaces, by filename slug. |
| `superseded_by` | spec slug | no | The spec that replaces this one, by filename slug. |

## The schema is a contract, verified at the step boundary

The frontmatter is a contract, not free text an agent fills in however it likes. When a spec is written or
amended, its frontmatter is checked: required fields present, `issue` an integer, `status` one of the valid
values, the slug references well-formed. A malformed value — a tracker URL in `issue`, a missing required
field, an invalid status — goes through the tolerance pipeline (ADR-012): deterministic repair is attempted
first, and if the value still does not satisfy the schema the agent is asked to correct it before the spec
is recorded (ADR-027). The spec is not committed with a frontmatter that violates the contract.

## Only file-canonical kinds carry this frontmatter

The four work kinds split by where the durable record lives (`spec-lifecycle`). The file-canonical kinds —
`feature_spec` and `enhancement_spec` — carry this committed frontmatter and move through the full `status`
lifecycle. The issue-canonical kinds — `bug_triage` and `chore_plan` — keep their record in the tracker
issue; their working triage document is a transient scratch note and is not held to this committed schema.

## What this composes with

- `context-human/concepts/spec-lifecycle.md` — owns the `status` machine, supersession, and the per-kind
  canonical-record policy this schema serves.
- `context-human/concepts/mm-integration.md` — the micromanager convention this Markdown-plus-YAML-
  frontmatter format follows.
- ADR-027 / ADR-012 — the contract verification and tolerance pipeline this schema is checked through.
