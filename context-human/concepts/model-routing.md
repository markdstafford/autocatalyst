---
created: 2026-06-05
last_updated: 2026-06-05
status: active
roadmap: ai
---

# Model routing

The selection policy that turns a unit of agent work into a resolved model profile. It takes a route
and resolves the model, the inference settings, the endpoint, and the credential a session will use.
This concept owns the **routing key**, the declarative **routing table** and how it resolves,
role-distinct selection for convergence, and the model-management configuration model.

It does **not** own the concrete runners or how a profile's runner is constructed and dispatched (see
`agent-runners`), the `Runner` contract itself (see `execution-runtime`), the skills catalog and the
route-to-skill mapping (see `runtime-skills`), the database the table lives in (see `architecture` and
ADR-008), cost accounting (see `cost`), or the convergence pipeline that draws on role-distinct
routing (see `review` and `workflow`). The `(step, role)` routing key is shared with `runtime-skills`,
which maps the same key to skill refs, and with the run's tool policy.

## The routing key

Agent work routes on `(step, role)` — the step the run advances through plus the role the session
plays (`implementer`, `reviewer`, and others such as `mediator`); roles are extensible, data-defined,
and snake_case. Bounded direct-model calls route on `(step)` alone, with no role. A run's intent and
work kind are upstream selectors: they choose the workflow (ADR-016), which determines the steps, so
they shape routing by selecting steps rather than by being routing facets themselves (ADR-024).

## The routing table and resolution

The routing table maps a route to a profile. Resolution is specificity-ordered: a `(step, role)`
resolves to its profile, falling back to a step-level default, and a genuine miss is a typed error
surfaced at the configuration boundary. The table is per-tenant data in the database, read and written
through the API and validated by the shared schemas (ADR-008, ADR-007). Resolution reads it directly
and explicitly; the extension registry is not on that path (ADR-011), so a provider the table names
works whether or not it appears in the registry.

## Profiles and inference settings

A profile names an endpoint, a model, a runner kind, and the provider's inference settings — adaptive
thinking and an effort level for one provider family, a reasoning-effort level for another. Resolving
a route assembles a self-contained profile that carries everything a runner needs: the model, the
resolved inference settings, the endpoint, and the credential. Thinking and effort are set explicitly
rather than inherited, so a session's reasoning posture is deterministic.

## Providers and runner kinds

A profile's runner kind selects the adapter the resolved profile dispatches to, and the provider is
derived from it. A provider reached through a different account shape — for example a cloud-hosted
inference account — is expressed through the credential and endpoint rather than a distinct runner
kind. Routing produces the profile and its runner kind; constructing the concrete runner and
dispatching to it belongs to `agent-runners`.

## Tiering by step and role

Routing is how cheap, bounded work reaches cheap models and heavy authoring or implementation reaches
strong ones. A bounded direct call such as intent classification routes to a small, capped model; an
authoring or implementation step routes to a strong one. The tiering is data in the table, not a
branch in code, so changing which model serves a step is a configuration edit.

## Role-aware routing for convergence

A step can be worked by more than one model in distinct roles, which a run uses to converge
incrementally. Routing resolves a distinct profile per role, and a workflow can require that a step's
roles use distinct models — a reviewer distinct from its implementer. Routing surfaces a signal when
it cannot satisfy that requirement, for example when only one model is configured, so the workflow can
degrade or escalate. Assigning roles and running the convergence loop belong to the workflow
(`review`, `workflow`); routing provides the role-distinct resolution they draw on. The resolved model
is recorded per session through telemetry tagged `(run, phase, step, role)` — emitted by
`agent-runners`, persisted by `cost` and `run`.

## Override layers

The base routing table is the whole of the initial selection policy. A per-run or per-user override is
an additive layer over the base table, taken when a concrete need arrives — a per-run pin for a single
run, or per-user precedence once multi-user operation is built out (ADR-009). The base-table
resolution rule is unchanged by a later override layer; an override patches a resolved entry rather
than replacing the mechanism.

## The model-management configuration

The set of usable models is the set of configured profiles, and which step and role each serves is the
routing table. All of it is service-owned data in the database, edited through the API and validated on
write (ADR-008, ADR-007), with a typed error when a route resolves to nothing. The in-application
editing surface is owned by `settings` (DESK); the registry supplies discovery of which providers and
models are available (ADR-011). This concept owns the configuration model and the typed-error
contract, not the screen that edits it.

## Relationships

- `agent-runners` — constructs and dispatches the concrete runner behind a resolved profile, and
  emits the per-session telemetry that records the resolved model.
- `execution-runtime` — owns the `Runner` contract and the direct-model port a resolved profile drives.
- `runtime-skills` — maps the same `(step, role)` key to skill refs.
- `review` and `workflow` — own the convergence pipeline that draws on role-distinct routing.
- `run` and `cost` — persist the per-session model and cost the routing decision produces, rolled up to
  `(step, role)`.
- `settings` — the in-application model-management surface (DESK).

## Constraints and decisions

- **Agent work routes on `(step, role)`, direct calls on `(step)`; intent and work kind are upstream
  selectors** (ADR-024).
- **Resolution is specificity-ordered with a typed error on a genuine miss**; the table is per-tenant
  data in the database (ADR-008, ADR-007).
- **Resolution is explicit and does not consult the registry** (ADR-011).
- **Role-distinct models are expressible, with a can't-satisfy signal**; the convergence pipeline that
  uses it is owned by `review`/`workflow`.
- **The base table is the initial policy; override layers are additive**, taken when a concrete need
  arrives (ADR-009).
- **The model recorded per session is tagged `(run, phase, step, role)`**; persistence belongs to
  `cost`/`run` (ADR-015).

## Open edges

- **Per-request composite dispatch** — one run using several runner kinds within a single step — is a
  deferred option, taken if a concrete need arrives that role-keyed resolution and the run's own
  sequencing do not cover.
- **Override layers** (per-run, per-user) over the base table, taken when the need is real.
- **The in-application routing-management surface** is owned by `settings` (DESK).
