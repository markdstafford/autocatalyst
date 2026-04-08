---
created: 2026-04-08
last_updated: 2026-04-08
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR 001: Agent-first development

## Status

Accepted

## Context

Autocatalyst is a system designed to be built by AI agents, operated by AI agents, and improved by AI agents. The humans involved in its development will primarily seed ideas and approve specs — not write code. This inverts the usual assumption that a codebase is primarily a human artifact that agents assist with.

All architectural decisions — language, framework, documentation standards, testing approach, observability, code structure — must be evaluated first through the lens of agent efficacy: are these choices optimized for agents to navigate, understand, extend, and debug this codebase?

The one exception is spec work. Specs are a collaboration between humans and agents — humans seed ideas, review sections, and make approval decisions. The artifacts and interfaces involved in spec work must work for both.

Agent capabilities, foundation models, and tooling are evolving rapidly. What is optimal for agent efficacy today may not be optimal in three months. This principle requires ongoing evaluation, not a one-time decision.

## Decision

Agent-first development is the primary architectural principle for this repository. When evaluating any decision — language, framework, testing approach, documentation standard, observability tooling, code structure — the first question is: are these choices optimized for agent efficacy?

In practice this means:

- Code uses explicit module boundaries and clear interfaces; no implicit conventions that require tribal knowledge
- Documentation is written for agent consumption — precise, complete, no assumed context
- The test suite is executable and interpretable by agents without human intermediaries
- Observability is designed for agents to query directly
- Specs are the one artifact that must also work for human review and approval

## Consequences

**Positive:**

- The repo compounds: as Autocatalyst improves, it improves the conditions under which it builds itself
- Every subsequent architectural decision has a clear evaluation criterion — agent efficacy — reducing ambiguity
- Agents working in this codebase operate with greater autonomy and produce higher-quality output
- Onboarding a new agent to the codebase requires no human-provided context
- Observability, testing, and documentation designed for agents are also unusually complete by human standards

**Negative:**

- The optimal choices for agent efficacy are a moving target — models and tooling evolve fast enough that decisions made today may need revisiting
- A living standards document must be maintained and periodically audited; without it, the principle exists on paper but not in practice
- The principle requires ongoing discipline — small shortcuts accumulate into a codebase that is less agent-friendly over time
- Applying the principle to all decisions can slow choices that might otherwise be made quickly on intuition
- Some choices optimized for agent efficacy may feel unfamiliar to human contributors

## Alternatives considered

### Human-first development

Optimize primarily for human readability and ergonomics. Agents assist but humans own the codebase.

**Pros:**
- Familiar — the default model for most engineering teams
- Human contributors onboard quickly without reading agent-specific conventions
- No risk of agent-optimized choices feeling alien to human reviewers

**Cons:**
- Misaligned with how Autocatalyst is actually built: humans won't be writing the code
- Agents work around human conventions rather than purpose-built structure
- Fails to take advantage of the compounding effect of an agent-friendly system building itself

**Why not chosen:** Autocatalyst's defining property is that agents do the work. Optimizing for humans who aren't the primary contributors is the wrong trade-off.

### Hybrid — equal weight to human and agent ergonomics

Make decisions that work well for both humans and agents, accepting trade-offs in both directions.

**Pros:**
- More familiar to human contributors
- Preserves optionality if the team brings in human engineers later
- Avoids agent-specific conventions that may feel awkward

**Cons:**
- "Optimize for both" often means optimizing for neither
- Creates constant tension in every decision without a clear tiebreaker
- Underserves the actual primary user of this codebase — the agent

**Why not chosen:** The hybrid stance sounds balanced but produces muddier decisions. Agent-first with a narrow carve-out for spec work is cleaner and more honest about who is building this system.
