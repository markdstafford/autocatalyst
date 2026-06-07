---
created: 2026-06-06
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-027: Contract verification at step boundaries

## Status

Accepted

## Context

An agent sometimes reports success while emitting output that does not match what the next step needs: a
wrong filename, a URL where an issue number is expected, a resolution keyed to an item that does not
exist. ADR-012 already treats model output as a soft contract repaired through a tolerance pipeline, and
point fixes exist in practice (validating a plan's path, guarding the run's branch). Turning those point
fixes into one rule rests on two facts about how steps hand off.

A step hands off to the next through a validated result, not a raw value. The runner passes a validated
value across the boundary (ADR-010, ADR-012), so the place to catch nonconforming output is that
boundary.

Some violations a model can fix if asked. Deterministic repair handles the mechanical cases, but a wrong
identifier or a missing reference is often correctable by the agent itself, provided it is asked before
downstream logic runs on the bad output.

This decision settles whether step output is verified uniformly against a contract, and what happens when
it does not conform.

## Decision

**Each step declares the shape of the result it must produce; the runner verifies an agent's output
against it through the tolerance pipeline, and a violation the agent can fix is sent back to the agent to
correct before any downstream logic runs.**

- **Each step declares its expected result as a schema** (already the result contract of
  `execution-runtime`). The schema is the contract the boundary checks against.
- **Deterministic repair runs first, then validation** (ADR-012): coercible output is normalized without a
  model call, and only then is the result validated against the step's schema.
- **A fixable violation is returned to the agent for correction before downstream logic runs.** Where a
  violation is the kind a model can repair (a misformed reference, an identifier that resolves to
  nothing), the agent is asked to satisfy the contract rather than the run proceeding on the bad value.
- **The step (workflow) declares the contract; the runner (`execution-runtime`) runs the pipeline and the
  correction request.** The feedback resolution path carries the same check: a resolution must key to a
  real `Feedback` item before it is recorded.
- **Contract verification is shape conformance, distinct from the convergence loop** (ADR-026), which is
  about quality. A step can fail its contract while its content would have passed review, and the reverse.

## Consequences

**Positive:**
- A "successful" session that produced the wrong shape is caught at the boundary with a clear cause,
  rather than flowing malformed into the next step.
- The point fixes become one uniform rule a step declares, rather than scattered guards.
- Many violations are corrected by the agent in place, so a recoverable mistake degrades the run rather
  than wasting it.

**Negative:**
- A correction request is an extra model round when a violation needs the agent, adding latency on the
  unhappy path.
- Every step must declare a result schema precise enough to verify against.

## Alternatives considered

### Advisory validation only

Log a nonconforming result and continue, as the prior review-response validation did.

**Pros:**
- No correction round, so the path is never slower.

**Cons:**
- Downstream logic runs on output known to be wrong, which is the failure this decision removes.
- A logged-but-ignored violation surfaces as a confusing downstream error rather than a clear cause.

**Why not chosen:** The point of the check is to stop bad output before it propagates, so a violation the
agent can fix is fixed before the run proceeds.

### Hard-fail the run on any nonconformance

Treat any contract violation as a terminal failure.

**Pros:**
- Simple, with no correction loop to maintain.

**Cons:**
- It throws away a run over a mistake the agent could have corrected on request.
- It is at odds with the soft-contract posture of ADR-012.

**Why not chosen:** Most violations are recoverable by asking the agent, so the run degrades and recovers
rather than failing on a fixable mistake.
