---
created: 2026-06-05
last_updated: 2026-06-06
status: active
roadmap: ai
---

# Runtime skills

The skills provisioning subsystem. A run's agent loads reusable skill packages — the `mm` and
`superpowers` skills — to do authoring, triage, planning, and implementation work. This concept owns
the runtime-owned **catalog** and its index, **dependency resolution**, the provider-neutral
**skill-ref model**, the **route-to-skill mapping**, the provisioning-visibility signal, and the
runtime instructions injected into skill-driven prompts.

It does **not** own the principle that declared skill intent is one dimension of the per-run Execution
Context with graceful degradation (see `execution-runtime` and ADR-010), the backend **materialization**
that turns resolved refs into a backend's own skill representation (see `agent-runners`), the
`(step, role)` routing key the mapping is keyed on (see `model-routing`), or Autocatalyst's own product
use of `mm` skills such as roadmapping and triage (see `mm-integration`).

## Skills ship with the runtime

The skill packages are committed and version-controlled with the application, alongside an index that
lists them. They are runtime assets, not settings borrowed from a developer's editor, and they are not
stored in the repository-maintenance context. Every runner resolves against the same catalog, so a
route depends on the same skills regardless of which backend runs the session.

## The provider-neutral skill ref

A skill is named by a string ref of the form `namespace:skill` — for example `mm:planning` or
`superpowers:writing-plans`. The ref is the neutral contract every runner shares. The backend
representation is produced from the ref by the adapter, so the core declares *what* a route needs and
the adapter decides *how* that looks on a given backend.

## The route-to-skill mapping

Which skills a run loads is route-resolved configuration keyed `(step, role)` — the same key
`model-routing` uses for profiles and the run's tool policy uses for tools. A route resolves once into
the Execution Context as a single bundle of declared profile, tools, and skill intent. Because the
mapping is single-sourced configuration resolved once, there is no second copy carried in an adapter
to drift from the core. The adapter materializes the resolved refs; it does not re-derive the mapping.

## The catalog, its index, and dependency resolution

The index declares what skills exist, where each one's files are, and which other skills each depends
on. Loading a skill loads its dependencies in turn, guarded against cycles, and **errors before the
run starts** if a referenced skill is missing or malformed, surfacing a setup failure up front instead
of mid-run. There is no silent disable-and-continue: a missing dependency is a fault that must be fixed.

Startup integrity or version checks, and dependency-missing graceful-disable, are taken when skills are
sourced from outside the application. While skills are committed with the runtime, the committed version
is itself the guarantee (no committed skill changes without a tracked commit), so that machinery is
added alongside external sourcing. This is distinct from the Execution Context's
graceful degradation when a *backend* offers no skill mechanism at all, which is owned by
`execution-runtime` and stays.

## Provisioning visibility

At session start the runner emits a typed setup event over the event stream: which skills were
requested versus which materialized, and the model and inference level in effect. This confirms a
working setup: the declared skills loaded and the right model and thinking level are active. A broken
catalog still errors before the run, so this signal confirms a good setup rather than catching a fault.

## Runtime instructions in skill-driven prompts

Autocatalyst owns a run's git and session lifecycle, so a skill must not run its own. Skill-driven
prompts carry one runtime-ownership instruction block telling a skill to skip its own branch, push,
merge, and PR steps and to return control to the run rather than end the session. A skill that ends a
session early anyway is caught by the result contract (ADR-012): a session that produces no validated
result leaves the step incomplete, so it routes through the normal retry-or-escalate path rather than
dropping the run. A skill-native mode that lets a skill cede git ownership without prose instructions
is adopted if the skills offer one.

## Relationships

- `execution-runtime` — owns the declarative Execution Context that lists declared skill intent as one
  dimension, the graceful-degradation principle (ADR-010), and the result contract that contains a
  skill ending a session early.
- `agent-runners` — materializes resolved refs onto each backend and emits the provisioning-visibility
  event.
- `model-routing` — owns the `(step, role)` routing key this concept's mapping is keyed on.
- `mm-integration` — Autocatalyst's product-level use of `mm` skills, distinct from provisioning
  skills to a run's agent.
- `workspace` — the per-run environment the materialized skills run in.

## Constraints and decisions

- **Skills are runtime-owned, committed with the application** alongside an index; every runner
  resolves against the same catalog.
- **Refs are provider-neutral (`namespace:skill`)**; the backend representation is produced by the
  adapter.
- **The route-to-skill mapping is route-resolved configuration keyed `(step, role)`**, single-sourced
  and resolved once into the Execution Context (ADR-008).
- **Dependency resolution loads transitively with a cycle guard and errors before the run starts** on a
  missing or malformed skill; no silent disable-and-continue.
- **Integrity/version checks and dependency graceful-disable are deferred** to external skill sourcing;
  the committed version is the guarantee.
- **A typed provisioning-visibility event is emitted at session start** for confirmation.
- **One runtime-ownership instruction block governs git and session lifecycle**; a skill ending a
  session early is handled by the result contract (ADR-012).

## Open edges

- **External or dynamic skill sourcing** — when skills come from outside the application, startup
  integrity and version pinning, dependency-missing graceful-disable, and a registry gating role
  (ADR-011) are taken on.
- **A skill-native runtime-ownership mode**, adopted if the skill packages offer a built-in way to cede
  git ownership in place of injected instructions.
