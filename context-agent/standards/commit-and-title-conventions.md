---
date: 2026-06-06
status: accepted
---
# Commit, pull-request, and issue title conventions

One conventional-commit convention runs across all three title surfaces — commit messages, pull-request
titles, and issue titles — rather than a prefix applied at one surface only. The home for the integration
that applies it is `context-human/concepts/trackers.md` (pull-request and issue titles) and the workspace's
commit step (commit messages); this records the shared rule both reach for.

## The type, derived once

The conventional-commit type comes from a single mapping off the work kind:

- `feature` → `feat`
- `enhancement` → `feat`
- `bug` → `fix`
- `chore` → `chore`

(`file_issue` and `question` produce no commit or pull request.) The derivation lives in one shared place
that the code-host port, the issue tracker port, and the commit step all call, so the convention is
enforced once rather than re-implemented per surface.

## The type's source differs by surface; the format does not

- A **pull-request title** and a **commit message** take their type from the run's work kind — one run, one
  kind.
- A **filed issue title** takes its type from that item's triaged type, since a batch may file several kinds
  at once.

The format — a `type: subject` line, the subject in lower case with no trailing period — is the same on
every surface.

## What this composes with

The convention governs the **prefix and format** of a title, not its content. What a pull-request title and
body *say* — the cumulative final change a run produced — is `trackers`' cumulative-summary rule, sourced
from the run's implementation summary. The two compose: the cumulative summary produces the subject, this
convention prefixes and formats it.
