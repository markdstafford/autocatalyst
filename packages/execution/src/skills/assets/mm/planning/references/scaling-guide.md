# Scaling guide

The planning process scales with the size of the work. The shape of the artifacts is the same; the depth and which sections you include change. This guide tells you how to size the process to the task.

## Decision tree

Walk these questions in order. Stop at the first match.

1. **Is this a bug?** → Use the bug-triage stage. Produce an issue with root cause and a task list. Stop.
2. **Is this a chore** (dependency bump, cleanup, small refactor with no behavioral change)? → Description + tasks. No spec needed.
3. **Is this a refactor with behavior implications** (large, cross-cutting, changes interfaces)? → What/why (brief), tech spec, tasks.
4. **Is this an enhancement to an existing feature?** → Use the enhancement stage. Scope the sections to the size of the change.
5. **Is this a small new feature** (single user-visible capability, well-understood, fits inside one existing module or one new module)? → Goals, personas (referenced from existing), narratives, user stories, tech spec, tasks. Skip standalone "what" and "why" if they are obvious from the goals.
6. **Is this a large new feature** (cross-cutting, multiple modules, new interactions, ambiguous scope)? → All sections of feature requirements + design spec + tech spec + tasks.
7. **Is this a new application?** → All sections of the app spec + foundational ADRs + wiki initialization + then per-feature workflow.

## Scaling table

| Size | What / Why | Goals | Personas | Narratives | User stories | Design spec | Tech spec | Task decomposition |
|---|---|---|---|---|---|---|---|---|
| App | Required, detailed | Required, multi-tier | Required, multiple | Required | Required (epics) | Required (design system foundation) | Required (foundational architecture) | Required |
| Large feature | Required | Required | Reference existing | Required | Required | Required (if UI) | Required | Required |
| Small feature | Skip if obvious | Required | Reference existing | Required (1–2) | Required | Required (if UI) | Required (focused) | Required |
| Refactor | Required if large | Required | — | — | — | — | Required | Required |
| Bug / chore | Brief description | — | — | — | — | — | — | Required |

## The task-decomposition rule

**Task decomposition format is always required.** Smaller work produces fewer tasks — not a flat checklist. Every task decomposition, regardless of feature size, must use the full hierarchical format: stories grouping leaf tasks, each with a description, acceptance criteria, and dependencies. A flat checklist without these fields is never an acceptable substitute.

A one-task spec is fine. A no-acceptance-criteria spec is not.

## How to decide between "small feature" and "large feature"

Treat it as **large** if any of these are true:

- It touches more than two existing modules.
- It introduces a new domain entity, a new database table, or a new external dependency.
- It has more than one persona using it differently.
- The team is uncertain about the design or implementation approach.
- Stakeholders disagree about scope.

Otherwise it can be **small**.

## What "skip a section" looks like

When the table says you can skip a section:

- Omit it from the artifact entirely, or
- Replace it with a one-line note: "Not applicable — see goals."

Do not leave empty headers with no content. Do not pad with filler.

## When in doubt, scale up

If you cannot tell whether the work is small or large, plan it as large. The cost of an extra design spec is small. The cost of discovering mid-implementation that the work is bigger than the plan is large.
