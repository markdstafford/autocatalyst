# Stage: Product requirements

You are writing product requirements for a new application or a new feature. This is the **first** stage of the per-feature workflow (or the initial setup, if you are creating an application).

## When to use this stage

- The user wants to create a new application.
- The user wants to add a new, standalone feature.
- The user says "spec out," "plan," "write requirements," "create" + a feature description.

**Do not use this stage for:**

- Improvements to an existing feature — use `enhancements.md`.
- Bug fixes — use `bug-triage.md`.

## Role

You start as the **product manager** (see `references/roles.md`). For the narratives section, switch to **creative writer**. After the draft is complete, switch to **devil's advocate** for a critique pass, then **reviewer** for the final pass.

State the role you are in to the human when you switch.

## Prerequisites

Before starting, verify:

1. **Config available.** `{docs_root}` is resolved.
2. **For an app:** confirm there is no existing `{docs_root}/specs/app.md`. If there is, ask whether to revise it or treat the work as a feature.
3. **For a feature:** confirm `{docs_root}/specs/app.md` exists. If it does not, propose creating the app spec first — features without an app context are usually under-defined.

Apply prerequisite checking from `SKILL.md` for any referenced wiki documents.

## Artifact

- **Application:** `{docs_root}/specs/app.md` — created from `references/templates/app-spec.md`.
- **Feature:** `{docs_root}/specs/backlog/feature-<slug>.md` — created from `references/templates/feature-spec.md`. After the task list is approved at the end of the workflow, the file will move to `{docs_root}/specs/feature-<slug>.md` — but moving is **not** your responsibility during this stage.

Create the file with frontmatter filled in (`name`, `date`, `status: Draft`) **before** drafting the first section.

## Sections, in order

Follow per-section checkpoints by default. If `waitForApprovalBefore` is set, use batch mode — see `enhancement-pause-before.md`.

For each section: draft it, write it to the artifact file, present it to the human, wait for explicit approval before moving to the next.

### 1. What

A one-paragraph description of what is being built, at the level of observable user-visible behavior. No implementation.

**Get this from the human.** If they cannot articulate it, ask: "If a user described this feature to a friend, what would they say?"

### 2. Why

The reason this exists. What user problem, business need, or strategic goal it serves.

**Get this from the human.** Do not invent. If they say "because we need it," push back: "What changes for the user or the business once this exists?"

### 3. Goals

3–5 specific, observable outcomes that define success. Each goal is a sentence with a measurable or testable shape.

Good: "A new user can complete signup in under 60 seconds without contacting support."

Bad: "Signup should be good."

### 4. Personas

For each primary user type:

- Name and role.
- What they care about in this context.
- Their relevant constraints (skill, environment, frequency of use).

For an app, draft 2–5 personas. For a feature, reference personas already in `app.md` and add new ones only if needed.

### 5. Narratives

Switch to **creative writer** role. Write 1–3 short narrative vignettes showing the feature in use. Each narrative:

- Opens with a named persona in a concrete situation.
- Shows what they do and see, in present tense.
- Avoids product jargon.
- Is a paragraph or two — not a list of steps.

### 6. User stories

A list of user stories in the form:

> As a [persona], I want to [action], so that [outcome].

Group by persona or by user flow. Include only stories that are in scope for this iteration. Forward-looking ideas go in a "Future" subsection.

### 7. Non-functional requirements

Performance, scale, security, accessibility, compliance, and operational requirements that constrain the design. Skip individual items that do not apply. Do not invent numbers — get them from the human or mark as "to be defined."

### 8. Out of scope

A short list of things the human or you might assume are in scope but are not. This protects against scope creep in later stages.

### 9. Devil's advocate pass

Switch to **devil's advocate** role. Surface the top 3 risks, hidden assumptions, or weaknesses in the draft. Propose at least one alternative the draft did not consider. Discuss with the human. Revise the relevant sections based on what the human accepts.

### 10. Reviewer pass

Switch to **reviewer** role. Read the artifact start-to-finish. Check:

- Internal consistency (do sections agree?).
- Upstream consistency (does this agree with `app.md` and ADRs?).
- Completeness (is anything required by the scaling guide missing?).

Surface concrete issues, ranked. Discuss with the human and revise.

### 11. Approval and frontmatter update

Once the human approves the full artifact:

- Set frontmatter `status: Approved`.
- Confirm to the human that the requirements artifact is complete.

## App-only: Initialize wiki documents

When this stage creates an **app** (not a feature), after the artifact is approved, create stub files for the four wiki documents. Create each file only if it does not already exist.

| File | What it will capture |
|---|---|
| `{docs_root}/wiki/domain-model.md` | Core domain entities, their attributes, and relationships |
| `{docs_root}/wiki/database-schema.md` | Tables, columns, indexes, and migration history |
| `{docs_root}/wiki/api-contracts.md` | Endpoint definitions, request/response shapes, auth requirements |
| `{docs_root}/wiki/design-system.md` | Component library, tokens, typography, and spacing conventions |

Each stub should contain only a frontmatter block and a one-line placeholder body:

```markdown
---
status: stub
last_updated: <YYYY-MM-DD>
---

_This document has not been written yet._
```

Do not draft content. The stubs signal to future stages that the wiki is initialized and ready to be filled in.

## Next step

Move to design specs (if there is UI) or directly to tech specs.

After the complete per-feature workflow (requirements → design → tech spec → tasks) is finished and the task list is approved, **return control to Autocatalyst.** Do not perform any session-lifecycle steps.
