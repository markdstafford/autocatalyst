# Stage: Enhancement requirements

You are writing requirements for an **enhancement** — an improvement or addition to a feature that already exists.

## When to use this stage

- The user wants to change behavior of an existing feature.
- The user wants to add a capability inside an existing feature's scope.
- The user says "improve," "add to," "extend," "tweak" + a known feature.

**Do not use this stage for:**

- New standalone features — use `product-requirements.md`.
- Bug fixes — use `bug-triage.md`.

## Role

Start as the **product manager** (see `references/roles.md`). After the draft, switch to **devil's advocate**, then **reviewer**.

## Prerequisites

1. **Identify the parent feature.** Confirm `{docs_root}/specs/feature-<slug>.md` exists. If you cannot find it, ask the human which feature this enhances.
2. **Read the parent feature spec.** Understand its goals and existing scope — the enhancement must fit within them or extend them deliberately.
3. Apply prerequisite checking from `SKILL.md` for ADRs and wiki documents.

## Artifact

`{docs_root}/specs/backlog/enhancement-<slug>.md`, created from `references/templates/enhancement-spec.md`.

Fill frontmatter (`name`, `parent_feature`, `date`, `status: Draft`) before drafting the first section.

## Sections, in order

Per-section checkpoints by default. Batch mode if `waitForApprovalBefore` is set.

### 1. Summary

One paragraph: what changes, in what feature, for what reason. This is the elevator pitch — keep it tight.

### 2. Current behavior

Describe how the feature behaves today, focused on the area being changed. This anchors the conversation in fact. Pull from the parent feature spec and from current implementation if needed.

### 3. Proposed behavior

Describe how the feature should behave after the enhancement. Be specific. Where current and proposed behavior differ, make the difference explicit.

### 4. Why

The reason for the change. What user pain, business signal, or strategic goal motivates it. **Get this from the human.**

### 5. Goals

2–4 observable outcomes that define success for this enhancement. Same shape as product requirements: measurable, testable.

### 6. User stories

Stories specific to the enhancement. May reference personas from the parent feature; do not redefine them.

### 7. Non-functional requirements (if any)

Only include if the enhancement changes performance, security, accessibility, or operational characteristics. Otherwise skip.

### 8. Impact on existing behavior

Explicit list of:

- What existing behavior changes (and how).
- What existing user stories are affected.
- What migration or compatibility concerns arise.

This section catches breakage that a feature-style spec would miss.

### 9. Out of scope

Bound the enhancement. List things that might be assumed in scope but are not.

### 10. Devil's advocate pass

Switch role. Surface risks: regressions, scope creep into related areas, unintended interactions with other features. Discuss and revise.

### 11. Reviewer pass

Switch role. Read end-to-end. Check consistency with the parent feature spec, ADRs, and wiki. Discuss and revise.

### 12. Approval and frontmatter update

Set `status: Approved` and confirm completion to the human.

## Next step

Move to design spec (if UI changes) or tech spec. At the end of the per-feature workflow, **return control to Autocatalyst.**
