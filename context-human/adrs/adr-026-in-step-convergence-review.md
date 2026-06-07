---
created: 2026-06-06
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-026: In-step convergence review

## Status

Accepted

## Context

A run should produce a more thoughtfully designed result than reviewing a large finished diff after the
fact. The direction is to have two distinct models converge incrementally: agree on the plan, then the
shapes, then the code, with a critic challenging the work as it forms (cross-cutting #17).

Routing already keys on `(step, role)` (ADR-024), and the cost model attributes per `(step, role)`
(ADR-015); both assume a single step can hold more than one role. A reviewer must not decide what ships,
because the model that critiques cannot also be the one that edits or the one that judges the result
good without the pass becoming self-review. And a bounded loop that cannot converge needs a third
outcome when it stalls, so it neither silently ships nor throws away the run.

This decision settles where the model reviewer lives in the lifecycle, how a step converges across
rounds, who decides it has converged, what happens when it cannot, how deep convergence goes, and how a
reviewer's critique is recorded.

## Decision

**A producing step carries an `implementer` and a `reviewer` role that loop in bounded rounds within the
step; the implementer decides convergence; on exhaustion the step escalates to a person; review depth is
configurable; and a reviewer's finding is a first-class `Feedback` item.**

- **The reviewer is a role inside the producing step.** A step such as
  `spec.author` or `implementation.build` carries both roles, and the exchange between implementer and
  reviewer loops within that one step. The model-review steps of the working catalog fold into this
  reviewer role.
- **One round is an implementer go then a reviewer go.** The implementer writes the work (the host commits
  it to the run branch); the reviewer reads the committed state and either signals satisfied or raises
  findings carrying a severity (`blocker`, `warning`, `info`). The reviewer never edits files and reads the
  workspace through read-only tooling.
- **The implementer decides convergence.** It disposes of each finding by fixing it or declining it with
  a recorded reason, and the step is converged when the implementer judges nothing remains worth fixing. A
  reviewer cannot veto a false positive; the human gate is the final check, where declined findings are
  visible.
- **A step with a reviewer role advances only when the implementer judges it converged, or a person signs
  off.** When the loop passes **max rounds** without settling, the run pauses at a `human` step with the
  open findings and both last positions and resumes on the reply: the person's sign-off advances the step,
  their direction sends it back to revise. Escalation reuses the human-pause primitive.
- **`max rounds` is per-step workflow data, configurable** (default three). The workflow owns the bound;
  this concept owns the per-round mechanics.
- **Any step that carries a reviewer role can run the convergence loop.** It is a general capability of
  `(step, role)` steps, not specific to a phase. `spec.author` and `implementation.build` are instances;
  how many such steps a workflow has (the depth) is configurable (ADR-025).
- **A step can use `revise` to revisit a previous step, not only loop in place.** A review's finding can
  move the run backward through the workflow: `next(workflow, step, 'revise')` sends it to wherever the
  table designates, a producing step or an earlier human gate. This is how reviews steer the workflow
  toward the best result rather than only converging within one step. For instance, `pr.finalize` runs
  after the last human gate, so a material finding there sends the run back to `implementation.human_review`
  for re-approval; otherwise it advances.
- **A reviewer's finding is a first-class `Feedback` item** (ADR-018), authored by the reviewer's model
  principal. It shapes the convergence loop rather than hard-gating like human feedback at a gate, and
  because the model principal does not return to confirm it, a finding the implementer marked `addressed`
  is resolved by the system when the step advances.
- **A reviewer distinct from its implementer is required but degraded loudly, never skipped.** When
  routing cannot resolve a distinct model (ADR-024), the review still runs on the same model with a
  warning that it is not adversarial. A step with no reviewer role has no loop.

## Consequences

**Positive:**
- The critic shapes the work while it forms, catching design problems before there is a large result to
  untangle.
- One step holding two roles aligns with the `(step, role)` cost and routing model already in place.
- The implementer-decides rule keeps a false-positive critique from stalling the loop, while the human
  gate still catches a bad decline.
- A stalled loop escalates rather than shipping unconverged work or discarding the run, and it reuses an
  existing pause.

**Negative:**
- A step with a reviewer role runs several model sessions, so it costs more and takes longer than a single
  pass, which is why depth is configurable.
- Two roles per step is a new axis every routing and cost record carries.
- Running review on a single configured model adds cost for a pass that lacks the adversarial property.

## Alternatives considered

### One adversarial review over the finished result

Run a single critic pass after the implementation is complete, as a standalone review.

**Pros:**
- The fewest model sessions, and the simplest placement.

**Cons:**
- The critic reacts to a large finished diff, so design problems are found only once they are expensive to
  change.
- It is the arrangement whose blind spot — reviewing after the fact — this decision sets out to remove.

**Why not chosen:** Incremental convergence is the goal, and that needs the reviewer to see the work as it
forms, not only at the end.

### A reviewer that edits or decides what ships

Let the critic fix what it finds, or let it gate the step directly.

**Pros:**
- A finding is resolved by the model that raised it, with no second disposition step.

**Cons:**
- The model that critiques becomes the model that edits, which is self-review and removes the independent
  check.
- A reviewer that gates can stall a step on a false positive with no recourse short of a human.

**Why not chosen:** The independent check is the value of the pass, so the reviewer advises and the
implementer disposes, with the human gate as the final check.

### A standalone review step

Keep the model review as its own step the run advances into, with `revise` looping back to the producer.

**Pros:**
- "In review" is a distinct, visible run position.

**Cons:**
- A review step has a reviewer role and no implementer role, splitting the converge loop across two steps.
- It works against the `(step, role)` cost and role model, which assume the roles share a step.

**Why not chosen:** The same visibility comes from the per-round record and the reviewer-role cost within
the step, without fragmenting the loop.

### Skip the review when only one model is configured

Treat a missing distinct reviewer as a reason to skip the review.

**Pros:**
- It avoids paying for a pass that lacks the adversarial property.

**Cons:**
- A fresh reviewer session, even on the same model, still reads the output cold without the implementer's
  reasoning, so it catches real issues.

**Why not chosen:** Same-model review retains value, so the pass runs with a warning rather than being
skipped; only a step with no reviewer role has no loop.
