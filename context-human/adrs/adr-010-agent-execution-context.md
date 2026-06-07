---
created: 2026-06-03
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-010: Agent execution context and sandboxing

## Status

Accepted

## Context

An agent session runs against a workspace and needs a controlled environment: the secrets for
its task, the tools it may use, the skills/plugins it should load, a workspace it can reason
about, and supporting capabilities. Logic outside the agent must determine these, passing in only
the right things, both for security (least privilege) and so the agent is not left to discover or
guess its environment. We must decide the model for assembling that environment and the security
posture it runs under.

Secrets, tools, skills, and workspace access should each be resolved deterministically before the
agent starts, rather than left ambient or implicit. Agents reason poorly about an environment they
must discover, so an explicit, stable contract helps them. Agent backends expose different
capabilities (not all support a skill/plugin mechanism, for example), so the model must degrade
gracefully. The deployment is a trusted single host today, with hosted/multi-tenant operation to
come, so the security posture must have a clear path from one to the other.

## Decision

**Each run executes under a single declarative Execution Context, resolved by the control plane
and materialized and enforced by the execution plane.** It contains:

- **The resolved task** (prompt and task-specific inputs). Operational configuration is *input to
  resolution*, owned by the control plane, and is not handed to the agent.
- **A two-root workspace:** a writable **repo** clone (what becomes the diff/PR) and a separate
  **scratch/ephemeral root** (working files, structured results, never committed). They are
  distinct, named roots.
- **Per-run secrets:** only the secrets the run's route requires, injected into the agent's
  scoped environment from the secret store, not drawn from the ambient host environment.
- **A per-run tool policy:** the tools the run may use, resolved from its route.
- **Declared skill/plugin intent:** the skills the run should load; each runner adapter maps this
  onto its backend's capability and degrades gracefully where unsupported.
- **Provisioned capabilities:** environment affordances the runner sets up: a predictable shell
  (bash), canonical and stable paths (no host/sandbox path translation for the agent to puzzle
  over), and a language server (LSP) for the repository's language to give real code intelligence.

**Least privilege is the model.** On a trusted single host, the posture grants the agent broad,
non-interactive tool permissions scoped to the workspace. Tightening to per-run least privilege
and adding network-egress controls is a deferred enforcement step, taken when the deployment moves
to hosted/multi-tenant operation. The model is fixed; only its enforcement strengthens as the
deployment demands it.

## Consequences

**Positive:**
- One declarative place defines everything an agent's environment contains, replacing scattered,
  implicit mechanisms.
- Secrets, tools, and skills are scoped per run, which is the foundation for least privilege.
- An explicit, stable workspace contract (two roots, predictable shell, canonical paths, an LSP)
  measurably eases the agent's reasoning and reduces wasted turns.
- Ephemeral run artifacts never pollute the repository or risk being committed.
- Backend differences are absorbed by graceful degradation rather than special-casing.

**Negative:**
- The broad-permission posture is not yet least-privilege; the gap is closed by the deferred
  hardening, not at the outset.
- Resolving and materializing the context is machinery the control and execution planes must
  implement and keep correct.
- Provisioning capabilities like an LSP per language adds setup the runner must manage.

## Alternatives considered

### Ambient host environment as the secret/permission boundary

Expose secrets through the host's environment (e.g. an environment-variable allowlist) and let
the agent inherit a broad, fixed toolset.

**Pros:**
- Trivial to implement.
- No per-run resolution machinery.

**Cons:**
- Couples every run to whatever happens to be in the host's environment, with no per-run scoping.
- Makes least privilege effectively impossible to reason about.
- Offers the agent no explicit workspace contract, so it must discover its environment.

**Why not chosen:** Per-run scoped injection from a secret store, plus an explicit workspace
contract, is both more secure and more legible, and it is the only model that can grow into
least privilege.

### A fully hardened sandbox from day one

Run every agent in a strongly isolated sandbox (containers, network-egress filtering, strict
per-run least privilege) immediately.

**Pros:**
- Strong isolation and least privilege from the start.
- Safe for untrusted or multi-tenant execution right away.

**Cons:**
- Significant complexity and operational overhead for a trusted single-host deployment.
- Slows delivery of the feature set for protection not yet needed.
- Several of its mechanisms (egress filtering, per-run restriction) presuppose hosted operation.

**Why not chosen:** The Execution Context model is adopted, while full hardening is deferred to
hosted/multi-tenant operation, where that cost is warranted, rather than paid on a trusted host.

### A scattered set of per-concern mechanisms

Handle secrets, tools, skills, and workspace each with its own ad-hoc mechanism. Not a genuine
alternative: the absence of one resolved, declarative context is the source of confusion and
inconsistency this decision exists to remove.
