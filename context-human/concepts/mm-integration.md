---
created: 2026-06-06
last_updated: 2026-06-06
status: active
roadmap: spec
---

# micromanager integration

This concept owns Autocatalyst's product-level use of micromanager skills: which micromanager skills
Autocatalyst invokes, the uniform contract it invokes them under, what it delegates versus builds, and what
it reads from micromanager configuration. It does not hold the skills themselves; their method lives in
micromanager. It does not duplicate skill provisioning (the catalog, the skill-ref model, and the
route-to-skill mapping are `runtime-skills`) or per-backend materialization (`agent-runners`).
`runtime-skills` provisions a skill; this concept decides which skills Autocatalyst depends on and when it
invokes them.

## The delegation boundary

micromanager owns portable knowledge-work methods — how to plan a feature, triage an issue, roadmap a set
of work, prototype a design choice, log friction, compact a doc corpus. These are methods any agent could
invoke in any repository; they are not specific to Autocatalyst. Autocatalyst owns the product around them:
the run lifecycle and state, ownership of git and the pull request, the API and the UX, and the intents that
decide *when* a method is invoked.

The test that draws the line: a portable "how to do this kind of work" method is a micromanager skill
Autocatalyst invokes; Autocatalyst's own orchestration and product machinery, Autocatalyst builds. The
project's premise settles the line: micromanager provides workflow and planning methods to be invoked, not
reimplemented. This keeps one authoritative copy of each method rather than a second copy drifting inside
the product.

## The skills Autocatalyst invokes

Three methods are invoked as part of a run:

- **`mm:planning`** authors file-canonical specs — feature specs and enhancement specs (`spec-lifecycle`).
  It is invoked in the spec phase to produce the spec a run builds from.
- **`mm:issue-triage`** handles issue-canonical work — bug and chore triage — and runs in a second mode for
  batch feedback intake, teasing apart a set of items into filed issues with titles, bodies, labels, and
  deduplication.
- **Compaction** refreshes the durable doc corpus, invoked by the `docs.update` step (ADR-029). It is a
  composite of narrower micromanager skills today — refreshing concepts and ADRs from specs and the
  implementation, then the central overview from the concepts — rather than one method; the single skill is
  a dependency micromanager carries.

The mapping from a run's work onto these skills follows the per-kind canonical record: planning for the
file-canonical kinds, issue-triage for the issue-canonical kinds, compaction for the docs phase.

## The uniform invocation envelope

Every skill is invoked inside one operating envelope, rather than a set of per-skill overrides. The envelope
keeps Autocatalyst in control of version control and the run no matter what a skill is written to do:

1. **Autocatalyst owns version control and the run.** A skill does not create branches or worktrees, push,
   merge, or open pull requests. Where a skill's method includes such steps, they are treated as already
   handled.
2. **Autocatalyst owns file locations.** A skill writes to the workspace scratch location Autocatalyst
   designates. Autocatalyst's location conventions take precedence over the skill's own, so a skill's idea
   of where a spec belongs does not decide where the spec lands.
3. **A skill's output is contract-verified** (ADR-027). A skill that exits early or emits a malformed result
   is caught at the step boundary and asked to correct it before downstream logic runs. This handles a skill
   that ends its subprocess early or returns the wrong shape, without special-casing each skill.
4. **Autocatalyst retains run control while a skill drives a subprocess.** A skill runs headless inside a
   step; Autocatalyst's step machine owns advancement, the gates, and the per-step and per-session limits.

A new skill is integrated by invoking it inside this envelope, not by writing fresh git and pull-request
handling for it. This also relates to ADR-011: the extension registry is a descriptive catalog, not a gate,
so the envelope governs how a skill behaves once invoked, not registration.

## Configuration

Autocatalyst's configuration is its own and is service-owned (ADR-008). A micromanager skill that expects
micromanager configuration — `docs_root`, for one — reads it from an `mm.toml` in the workspace. To bridge
the two, Autocatalyst does a one-time read of the relevant `mm.toml` values when a project is created,
seeding its own configuration store; its store is authoritative from then on. micromanager skills continue
to read the workspace `mm.toml` as they run. A later refinement toward the service-owned
configuration model has Autocatalyst's store fully own these settings and provide each skill the
configuration it needs at invocation, rather than the skill reading a file.

## Which skill versions Autocatalyst depends on

`runtime-skills` owns the catalog, the manifest, and dependency resolution. The product-level decision of
which skills and which versions Autocatalyst requires is this concept's: Autocatalyst depends on `mm:planning`,
`mm:issue-triage`, and the compaction skills at compatible versions, expressed through the `runtime-skills`
manifest rather than a parallel mechanism. This concept states what is required; `runtime-skills` resolves
and materializes it.

## Relationships

- `runtime-skills` — owns the skill catalog, the provider-neutral skill-ref model, and the route-to-skill
  mapping; this concept decides which skills Autocatalyst depends on and when it invokes them.
- `agent-runners` — owns per-backend materialization of a skill; this concept owns the product-level
  invocation, not the materialization.
- `docs-model` — owns the doc corpus and what compaction does for it; this concept owns the invocation of
  the compaction skill.
- `spec-lifecycle` — owns the spec `mm:planning` authors and the per-kind canonical record that maps work
  onto skills.
- `workflow` — owns the steps the skills are invoked within; this concept owns the contract of the
  invocation.
- `intents` — classifies an inbound message into the work whose kind decides which skill is invoked.

## Constraints and decisions

- micromanager owns portable knowledge-work methods; Autocatalyst owns the run lifecycle, state, git and
  pull-request ownership, the API and UX, and the intents that decide when to invoke a skill.
- `mm:planning`, `mm:issue-triage`, and the compaction composite are invoked as part of a run; planning maps
  to file-canonical kinds, issue-triage to issue-canonical kinds, compaction to the docs phase.
- Every skill is invoked inside one envelope: Autocatalyst owns version control and the run, owns file
  locations, contract-verifies output (ADR-027), and retains run control while a skill drives a subprocess.
- The extension registry is descriptive, not a gate (ADR-011); the envelope governs invoked behavior.
- Autocatalyst's configuration is service-owned (ADR-008); a project's creation seeds it with a one-time
  read of `mm.toml` values, and Autocatalyst's store is authoritative thereafter.
- Required skill versions are a product dependency expressed through the `runtime-skills` manifest.

## Open edges

- **Service-owned configuration that materializes what a skill needs** at invocation — rather than a skill
  reading a workspace file — is the end state the one-time-read bridge points toward (ADR-008).
- **A single compaction skill** that replaces the current composite is a dependency on micromanager; when it
  lands, the docs here update to the real skill shape (`docs-model`).
