---
created: 2026-04-08
last_updated: 2026-04-08
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR 003: Spec format

## Status

Accepted

## Context

The spec is the central artifact of the Autocatalyst loop — produced by the spec generation agent, iterated on through human feedback, approved by a human, and consumed by the implementation agent. The format must work for all three roles: agent-readable and writable, surfaceable through any human interface for review, and persistent enough to serve as a durable record of what was approved and why.

The micromanager convention — structured Markdown with YAML frontmatter, committed to the repo — is the starting point. It satisfies the agent-readability, persistence, and versioning requirements, and already integrates with GitHub Issues for human review. The question this ADR addresses is what that convention looks like for Autocatalyst specifically, and what improvements to adopt from other systems.

## Decision

Specs are structured Markdown files with YAML frontmatter, committed to `context-human/specs/` in the target repo. This follows the micromanager convention: a defined template, a per-spec lifecycle tracked in frontmatter, and GitHub Issues integration for human review where applicable.

The current convention includes:

- **Spec types**: feature specs and enhancement specs for new and iterative work; human ADRs for architectural decisions — all committed artifacts
- **Bugs**: tracked in GitHub Issues rather than committed specs, but follow a similar structured process
- **Structure**: every spec starts with what and why, and ends with a task list that gets checked off during implementation
- **Source of truth**: the spec is always canonical — implementation follows the spec, not the other way around
- **Accumulated context**: specs are committed alongside the code they describe; future specs benefit from the full history of prior decisions and designs

This is a baseline, not a fixed standard. The spec format is expected to evolve as the loop runs and patterns emerge. Examples of changes that might be warranted:

- New spec types or lifecycle states as new patterns emerge
- A single synthesized spec per run (combining what/why, design, tech, and task list) rather than separate artifacts per stage — as Symphony demonstrates
- Tighter integration between the spec and the implementation workpad

Changes to the spec format are made by updating the template and this ADR, not by ad-hoc divergence across individual specs.

## Consequences

**Positive:**

- Specs are versioned alongside the code they produce — the full history of what was built and why is always available
- The source-of-truth principle keeps implementation grounded; agents implement what the spec says, not what seems convenient
- Accumulated specs give future agents rich context for generating better specs
- A shared template ensures consistency across all spec types

**Negative:**

- The format will need to evolve; committing to a template now means migrating existing specs when the template changes
- Markdown in the repo is not natively surfaced through all human interfaces — the human interface adapter must handle rendering and notification

## Alternatives considered

- **Issue tracker as canonical source of truth** (Symphony approach): natural human review surface, but couples the spec lifecycle to a specific platform; conflicts with Autocatalyst's abstract human interface model
- **Structured data format** (JSON/YAML): machine-readable but poor for iterative human review and agent authorship; no advantage over Markdown with frontmatter
