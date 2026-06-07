---
created: 2026-06-06
last_updated: 2026-06-06
status: active
roadmap: flow
---

# Review

How a step converges on a result worth advancing: the exchange between the implementer and reviewer inside one step,
the bounded round loop it runs, who decides the step has converged, and the durable record each round
leaves behind. A producing step such as `spec.author` or `implementation.build` carries both an
`implementer` and a `reviewer` role and loops within itself until the implementer judges nothing more
is worth fixing, or a person settles it. This concept owns the per-round mechanics and the per-round
record. It does not own the step substrate or the **max rounds** bound (`workflow`), the routing that
resolves a distinct model per role (`model-routing`, `agent-runners`), the human gates and the
pause/escalation semantics (`hitl`), or the `Feedback` record shape (`domain-model`, ADR-018).

## The reviewer is a role, not a step

A model reviewer is a role a producing step carries, alongside the step's implementer role. The two
roles share the step: `spec.author` and `implementation.build` each hold an implementer and a reviewer,
and the exchange between them happens inside the one step rather than across a step boundary. This is a
general capability of a `(step, role)` step. Any step a workflow gives a reviewer role runs the loop,
and a step with no reviewer role has no loop and advances when its implementer is done. How many
steps in a workflow carry a reviewer role (the depth of convergence) is configurable workflow data
(ADR-025); this concept describes what happens inside any one of them.

## A round

One round is an implementer go followed by a reviewer go:

- The **implementer** writes the work. The host commits the result to the run branch after the
  session; agents do not run state-changing git. The implementer is the only role that edits.
- The **reviewer** then reads the committed and working-tree state through its own read-only git and
  file tools and either signals satisfied or raises findings. The reviewer is an ordinary
  runner-driven session inside the workspace; it inspects the branch and diff itself, so this concept
  needs no special code to read the diff. The reviewer never edits.

Each finding carries a severity — `blocker`, `warning`, or `info`. A reviewer that returns no findings
signals the step is converged from its side. The two roles are separate sessions with no shared memory:
the reviewer reads the work cold, and the implementer learns of a finding only when the next round
hands it back. The cold read is what the pass is for.

## The implementer decides convergence

The reviewer advises; it does not decide what advances. After a reviewer go, the implementer disposes
of each finding: it fixes the finding, or it declines the finding with a recorded reason, since a
reviewer may raise a false positive. The step is **converged** when the implementer judges nothing
remains worth fixing. A reviewer cannot veto, and a reviewer cannot mark the step done over the
implementer; it can only raise findings the implementer must answer.

The human gate is the final check on this authority. Declined findings stay visible there, so a person
reviewing the work sees what the reviewer raised and what the implementer chose not to fix, and can push
back. The reviewer advises and the implementer disposes, with a person able to see both: this keeps
the pass an independent check while still letting a false positive be set aside without stalling the
loop.

## When a step advances

A step that carries a reviewer role advances only when the implementer converges, or when a person signs
off after a **max rounds** escalation. `max rounds` is per-step workflow data, default three; the
workflow owns the bound, and this concept owns what each round does within it.

When the loop reaches the bound without the implementer converging, the run pauses at a `human` step
carrying the open findings and both roles' last positions, and resumes on the reply: a sign-off advances
the step, and direction to keep going sends it back to revise. The pause and resume are the human-pause
primitive `hitl` owns; this concept produces the escalation and hands it across.

`needs_input` is orthogonal to all of this. It is a general pause that can occur at any time, even
before the first reviewer go, and is owned by `hitl`. It is not a convergence outcome and does not bear
on whether the step advances; a step that pauses for input resumes the same loop where it left off.

## Reviews steer the workflow

A review can move the run backward through the workflow, not only loop in place. The implementer's
disposition can resolve into a `revise` directive, and `next(workflow, step, revise)` sends the run to
wherever the table designates: a producing step, or an earlier human gate. This lets review steer a run
across steps toward the best result, not only converge within a single step.

`pr.finalize` runs after the last human gate, so its review has a view no earlier reviewer has:
the final frozen state. A material finding there is not absorbed in place — it sends the run back to
`implementation.human_review` for re-approval, and a review that raises nothing material advances toward
the open PR. The backward move is ordinary table data on the `revise` directive; this concept adds no
mechanism for it.

## A finding is a `Feedback` item

A reviewer's finding is a first-class `Feedback` item (ADR-018), authored by the reviewer's model
principal (a model is a principal whose identity is its resolved provider and model). A reviewer finding
is the same `Feedback` entity a person raises at a gate; what differs is where it sits. Inside a
convergence step the implementer disposes of the finding and it shapes the loop. At a human-review gate a
person's feedback hard-gates the run. The entity is the same; the gating follows from the location. The
shape of the entity, its thread, and its lifecycle belong to `domain-model` and ADR-018; this concept
consumes the entity and records the disposition.

## The per-round record

A step with a reviewer role keeps a durable record of its rounds: each round's findings, the
implementer's disposition of each finding, and the round's outcome. The record is the source the review
surface renders from, and it is what lets a person at the human gate see the full exchange — including
declined findings — rather than only the final state. Because findings are `Feedback` items, the record
threads through the same entity a person's feedback uses, so model review and human review render
together rather than as two separate logs.

## A single configured model still reviews

A step's reviewer role is required, even when routing cannot resolve a model distinct from
the implementer's. In that case the review runs anyway, on the same model, with a warning that it is not
adversarial; it is never skipped. A fresh reviewer session reading the work cold, with no memory of the
implementer's reasoning, still catches real problems; it only loses the distinct-model perspective. The
can't-resolve-a-distinct-model condition (ADR-024) is a warning, not a reason to skip. Only a step that
carries no reviewer role at all runs without a loop, and that is an ordinary coarse step, not a
degraded one.

## Relationships

- `workflow` (`run`) — owns the step-primitives catalog, which steps carry a reviewer role, the **max
  rounds** bound, and the `next(workflow, step, directive)` table the `revise` edge reads.
- `model-routing` and `agent-runners` — resolve a distinct profile per role, surface the can't-satisfy
  signal, construct and dispatch the reviewer session, and emit the per-session telemetry tagged
  `(run, phase, step, role)`.
- `hitl` — owns the human-pause primitive the max-rounds escalation reuses, and the `needs_input` pause
  that is orthogonal to convergence.
- `domain-model` and `feedback` — own the `Feedback` entity, its thread, and its lifecycle that a
  finding becomes; this concept authors findings as that entity and records dispositions.
- `cost` — meters the reviewer role's sessions under the step's `(step, role)` cost record.

## Constraints and decisions

- The reviewer is a role inside the producing step, not a step of its own; the loop runs within one
  step (ADR-026).
- One round is an implementer go then a reviewer go; the implementer is the only role that edits, and
  the reviewer reads through read-only tooling (ADR-026).
- The implementer decides convergence; the reviewer cannot veto, and the human gate is the final check
  on a declined finding (ADR-026).
- A step with a reviewer role advances on convergence or on a person's sign-off after a max-rounds
  escalation; `needs_input` is orthogonal (ADR-026, ADR-015).
- A reviewer's finding is a first-class `Feedback` item authored by a model principal (ADR-018,
  ADR-026).
- A review can `revise` to an earlier step the workflow table designates; `pr.finalize` sends a
  material finding back to `implementation.human_review` (ADR-025, ADR-026).
- A reviewer distinct from its implementer is required but degraded loudly, never skipped (ADR-024,
  ADR-026).
- Routing keys on `(step, role)` and cost attributes per `(step, role)`, which is why one step can hold
  two roles (ADR-024, ADR-015).

## Open edges

- **Parallel reviewers in one step** — running more than one reviewer session and converging across
  their findings — is expressible through independent sessions but not built; one reviewer per step to
  start.
- **Convergence depth** — how many steps in a workflow carry a reviewer role — is configurable workflow
  data; the depth that best balances quality against cost per work kind is a value to tune, not a fixed
  rule.
- **An early-exit rule** within the bound — converging as soon as a round yields only `info` findings,
  rather than running every round — is a refinement the round loop can take on later.
