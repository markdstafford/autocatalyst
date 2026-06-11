# Stage: Design specification

You are writing a design specification — user flows, screens, components, and interaction details for a feature with UI.

## When to use this stage

- The feature has any user-visible UI (default assumption for new features).
- The enhancement changes UI behavior.

**Skip only** for truly backend-only work (jobs, integrations, internal APIs with no UI).

## Role

You start as the **UX/UI designer** (see `references/roles.md`). For early ideation, switch to **brainstorm partner** for divergent options. After the draft, switch to **reviewer**.

## Prerequisites

1. The feature or enhancement requirements artifact exists and is approved.
2. **Check `{docs_root}/wiki/design-system.md`.** If it does not exist or is a stub, the design system is the foundation for all components; raise this as a critical gap and propose initializing it before proceeding.
3. Read any existing design specs for related features — reuse flows and components where possible.

## Artifact

The design spec lives **inside** the feature or enhancement spec file under a "Design" section, **or** in a sibling file if the design is large enough to warrant separation. Default: inside the spec.

If the design content is more than a few sections and would overwhelm the parent spec, create `{docs_root}/specs/backlog/feature-<slug>-design.md` (or `enhancement-<slug>-design.md`) and link it from the parent.

## Sections, in order

Per-section checkpoints by default. Batch mode if `waitForApprovalBefore` is set.

### 1. Goals of the design

What the design must accomplish, derived from the requirements. Two or three bullets. This is the rubric you will judge later sections against.

### 2. User flows

For each primary use case from the requirements, describe the step-by-step flow:

- Entry point — where the user starts.
- Steps — what the user does and what they see at each step.
- Decision points — branches and what determines them.
- Exit — what state the user ends in.

Use prose or numbered lists. Diagrams are optional. Cover both happy path and meaningful alternates (error, empty, recovery).

### 3. Screens and wireframes

For each screen referenced by the flows:

- Purpose.
- Major regions / layout.
- Key content elements.
- States: empty, loading, populated, error, disabled (only those that apply).

Wireframes are optional but encouraged as ASCII sketches or links to external tools. Specify behavior, not pixel detail.

### 4. Components and interactions

For each new or modified component:

- Name and purpose.
- Behavior (clicks, inputs, hovers, keyboard).
- Visual states.
- Whether it is reused from the design system or new.

Pull as much as possible from `wiki/design-system.md`. **Switch to brainstorm partner** here if the human is unsure about an interaction — produce three options before converging.

### 5. Accessibility and responsive behavior

- Keyboard navigation order and shortcuts.
- Screen reader behavior for non-trivial elements.
- How the layout adapts across screen sizes.
- Color contrast and other a11y constraints.

### 6. Design system updates

List new tokens, components, or patterns this design adds to the design system. These will need to be reflected back into `wiki/design-system.md` after approval.

### 7. Reviewer pass

Switch to **reviewer** role. Read end-to-end. Check consistency with requirements (every user story has a flow), with the design system (no unjustified one-offs), and internally (states are consistent across screens). Surface issues and revise.

### 8. Approval and wiki update

Once approved:

- Write the design spec content into the parent spec file (or the sibling design file).
- Update `{docs_root}/wiki/design-system.md` with any new components or tokens. If the wiki document is a `status: stub`, set `status: active` and `last_updated`.

## Next step

Move to the tech spec. After the per-feature workflow completes (tech spec + tasks), **return control to Autocatalyst.**
