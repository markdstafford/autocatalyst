# Stage: Architecture Decision Records (ADRs)

You are creating Architecture Decision Records — durable records of foundational technical and architectural decisions. Each ADR captures **one** decision.

## When to use this stage

- During initial app setup, to extract foundational decisions surfaced by the app spec (language, framework, database, deployment model, etc.).
- When a tech spec or design spec surfaces a decision that has reach beyond the current feature.
- When the human explicitly wants to record a decision ("let's ADR this").

**One decision per ADR.** If the human says "ADR for the backend," ask: "Which specific decision? Language, framework, database, hosting, async model, …?" and create separate ADRs for each.

## Role

You are the **software engineer** and **technical product manager** together (see `references/roles.md`). Surface tradeoffs; defer the final call to the human.

## Prerequisites

1. `{docs_root}/adrs/` exists or will be created.
2. Read existing ADRs in `{docs_root}/adrs/` — a new ADR may supersede one of them, in which case the existing one needs a `superseded_by` update.

## Artifact

`{docs_root}/adrs/adr-<NNN>-<slug>.md`, created from `references/templates/adr.md`.

Number sequentially. Look at the highest existing number and add one. Pad to 3 digits (`adr-001-…`, `adr-042-…`).

Fill frontmatter (`number`, `title`, `date`, `status: Proposed`) before drafting.

## Sections, in order

### 1. Context

What forces are in play that require this decision now. Constraints, prior decisions, current state. Keep it factual.

### 2. Decision

A single sentence in the form "We will …" or "We have chosen …" stating the decision.

Then a paragraph explaining what the decision means concretely.

### 3. Alternatives considered

For each viable alternative:

- **Name.** Short label.
- **Tradeoffs.** What you would gain and what you would give up.
- **Why rejected.** The specific reason this alternative is not the choice.

At least 2 alternatives. If there is genuinely only one option, say so explicitly and explain why — that itself is information.

### 4. Consequences

What changes as a result of this decision:

- What becomes easier.
- What becomes harder.
- What follow-on work this implies.
- What this decision constrains in future decisions.

### 5. Status and review

Set `status: Accepted` only after explicit human approval. If the ADR supersedes a prior one, update that prior ADR's frontmatter to set `superseded_by: adr-<NNN>` and `status: Superseded`.

## Checkpoints

Per-section checkpoints by default. Batch mode if `waitForApprovalBefore` includes `adrs`.

After the full ADR is drafted, switch to **reviewer** role for a final pass. Check consistency with other ADRs (is there a contradiction?), with the app spec, and with wiki documents.

## Multiple ADRs in one session

When extracting ADRs from an app spec, you may produce several. Treat each as its own artifact with its own checkpoints. Do not batch unrelated decisions into one ADR.

## After approval

Confirm to the human that the ADR is recorded. If wiki documents now need updating (for example, a database ADR implies a database-schema stub), call that out.

After the relevant planning workflow is complete, **return control to Autocatalyst.**
