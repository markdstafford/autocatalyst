# Stage: Task decomposition

You are breaking the approved tech spec into implementable tasks. This is the final stage of the per-feature workflow.

## When to use this stage

- After the tech spec is approved.
- For every feature, enhancement, refactor, bug, or chore — **task decomposition is always required.**

## Role

You are the **engineering manager** and **software engineer** together (see `references/roles.md`). After the draft, switch to **reviewer**.

## Prerequisites

1. Tech spec is approved (or, for bugs/chores, an equivalent artifact such as a bug-triage issue exists).
2. Open questions from the tech spec are either resolved or explicitly marked as "decide during implementation."

## Artifact

The task decomposition lives **inside** the feature or enhancement spec file under a "Tasks" section. For a bug, it lives in the triage issue.

## Required structure

**Task decomposition format is always required, at every size.** Smaller work produces fewer tasks — not a flat checklist.

Every task decomposition uses the hierarchical format:

- **Stories** group related leaf tasks into a deliverable slice.
- **Leaf tasks** are individually implementable units. Each leaf task **must** have:
  - **Description.** One or two sentences stating what the task does.
  - **Acceptance criteria.** Concrete, observable, testable conditions for "done."
  - **Dependencies.** Other leaf tasks (by ID) that must complete first, or "none."

A flat checklist without these fields is **never** an acceptable substitute, even for a one-task spec.

## Sections, in order

### 1. Stories

Group the work into stories. Each story:

- Has a short title.
- Delivers a coherent slice — typically something that could be released, demoed, or reviewed as a unit.
- Lists its leaf tasks (titles only at this stage).

Present the story breakdown to the human and get approval before drafting leaf task details. This avoids reworking detailed leaf tasks if the structure is wrong.

### 2. Leaf tasks

For each leaf task, fill out:

- **ID** — short, stable, e.g. `T-001`, `T-002`. Number sequentially across the whole decomposition.
- **Title.**
- **Description.** What the task accomplishes. Reference the spec sections that motivate it.
- **Acceptance criteria.** A short list of concrete conditions. Each should be checkable. Examples:
  - "The `/users/:id` endpoint returns 404 for unknown IDs."
  - "A test asserts that empty input produces a `ValidationError`."
  - "The migration runs forward and backward without errors against a fresh database."
- **Dependencies.** List of other task IDs that must complete first, or "none."
- **Notes** (optional). Any non-obvious constraints, references to existing code, or links to design specs.

Size tasks so each is a focused, reviewable unit. Avoid:

- **Mega-tasks.** "Implement the backend." Break it down.
- **Trivial tasks.** "Rename variable X." Group with adjacent work.
- **Untestable tasks.** If acceptance criteria are hand-wavy, the task is not yet defined.

### 3. Dependency graph

A short summary of the critical path and identifiable parallel tracks. This is for the implementer's orientation:

- Critical path: T-001 → T-003 → T-007.
- Parallel: T-002, T-004, T-005 can run alongside the critical path.

For very small decompositions (one or two tasks), a one-line note is fine.

### 4. Reviewer pass

Switch to **reviewer**. Read all stories and tasks. Check:

- Does every requirement and tech spec section have at least one task covering it?
- Are acceptance criteria observable and specific?
- Are dependencies correct? Is there a missing dependency or a phantom one?
- Are any tasks too big or too small?

Discuss with the human and revise.

### 5. Approval

Once the task list is approved:

- Confirm to the human that the task decomposition is complete.
- Set the parent spec frontmatter `status: Approved` if it is not already.

## Spec completion

After the task list is approved and written to disk, the per-feature workflow is complete. **Stop and return control to Autocatalyst.** Autocatalyst owns everything that happens after spec authoring — do not perform any session-lifecycle steps.
