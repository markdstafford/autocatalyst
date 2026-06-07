---
created: 2026-06-06
last_updated: 2026-06-07
status: active
roadmap: flow
---

# Human-in-the-loop

The points where a run stops and hands control to a person, and what happens when the person
replies. This concept owns the **pause-and-resume semantics**: what each pause hands the person,
which reply directives are valid in that pause, and the rule that a reply is classified into a
directive and re-dispatches the run. It also owns the **recovery trigger** — the explicit operator
action that brings a stopped run back into motion — and the **reply-to-a-stopped-run behavior**. It
does not own where the human steps sit in a workflow or how a gate advances (see `workflow`), the
converge-or-escalate loop that produces an escalation (see `review`), the step machine and the
`next(...)` transition rule (see `run`), re-materializing the workspace (see `execution-runtime`),
or admitting a stopped run for dispatch (see `orchestrator`).

## One pause-and-resume mechanism

A run pauses whenever it reaches a `human` step. The pause hands the person a **payload** — the
material they need to act on — and the run waits. When the person replies, the reply is classified
into a directive (see `intents`) and `next(workflow, step, directive)` re-dispatches the run from
that step (see `run`). One mechanism serves every human pause: a payload going out, a reply coming
back, a directive moving the run. There is no second pause machinery for any flavor of human
involvement.

Because the within-phase pause genuinely stops the run and a reply genuinely resumes it, a model
that needs a decision does not guess. It ends its session with a structured question, the run pauses,
and a reply re-invokes the producing step with the answer in hand.

## The pause flavors

The flavors differ only in three things: what triggers them, what payload they carry, and which reply
directives are valid. The mechanism underneath is identical.

A **gate** (`*.human_review`) is the review pause between phases. Its payload is the work under
review plus the open feedback on it. The valid replies are: approve, which yields `advance` and moves
the run to the next phase; feedback, which yields `revise` and sends the run back to its producing
step; and a question, which is answered without moving the run.

`docs.human_review` is the one gate that can advance without pausing: when compaction proposes no
human-owned doc change, its `DocDiffProposal` is empty and there is nothing to review, so the run
advances through it. This is specific to the docs gate and its diff object, not a general rule that any
gate auto-passes when no feedback is open. `spec.human_review`, `implementation.human_review`, and
`pr.human_review` always pause for an explicit human approval, even with zero open feedback (`workflow`,
`feedback`, ADR-029).

An **`awaiting_input` pause from a model question** carries the model's question as its payload. The
reply re-invokes the producing step with the answer supplied as input, so the step continues from
where the model stopped rather than starting fresh.

An **`awaiting_input` pause from a convergence escalation** carries the disagreement: both models'
last positions and the open findings the round loop could not settle (see `review`). The valid
replies are to pick a side, to add a constraint that breaks the deadlock, or to cancel the run.

A model question and a convergence escalation are the **same pause**: the same `awaiting_input`
step, the same resume. They differ only in payload. One is "the model needs an answer to proceed";
the other is "two models could not agree and need a person to settle it." Both stop the run, both
resume on a reply, and both re-dispatch from the recorded step.

## Gates and `awaiting_input` carry the same waiting class

Every human pause — a gate or an `awaiting_input` step — declares `waiting_on: human` (see `run`).
A run cares about the same property whether the pause is a between-phase review or a within-phase
question: it is paused for a person, and a reply is the thing that moves it. The two kinds differ
only in their payload and their valid replies, never in how the run classifies them as waiting. A
person can ask a question at a gate without advancing the run, just as a model question pauses the
run for an answer; the difference is the directive the reply reduces to, not the waiting class.

## Recovery is explicit

A run that has stopped — paused at a `human` step, or interrupted before reaching a terminal step —
is preserved. A non-terminal run is kept on load, its conversation is re-registered, and the step at
which it stopped is recorded (ADR-021). Nothing about it is dropped.

Nothing re-dispatches on its own. A stopped run waits until a person acts on it. Recovery is an
**explicit operator action** (`ac-run-recover`): it re-materializes the run's workspace and
re-dispatches the run from the recorded step (see `execution-runtime` for the re-materialization,
`orchestrator` for admitting the run back for dispatch). The run resumes from where it was, not from
the beginning, because the recorded step is where it stopped.

## A reply to a stopped run

A reply that arrives for a run that has already stopped — a `failed` or `canceled` run — is neither
silently revived nor silently discarded. The person gets a clear response: this run is stopped, and
here is how to recover it. The reply does not quietly turn a stopped run back on, and it does not
vanish. Recovery stays the deliberate action that brings such a run back, so a stray reply cannot
restart work that was stopped on purpose.

## Recovery versus the operator force

Two operator actions move a stopped run, and they are distinct. **Recovery** (`ac-run-recover`)
resumes a run from the step it stopped at — it is the "this run was interrupted, bring it back where
it was" action. **`set-step`** is an override: it forces a run to a step the operator chooses,
regardless of where it stopped (see `orchestrator`). Recovery trusts the recorded step; `set-step`
replaces it. Both re-materialize the workspace on dispatch, so the run resumes against a real
workspace either way.

Which states resume from their recorded step and which start over — for instance, a run that failed
while authoring a spec versus one that failed mid-implementation — is the run's per-state recovery
policy, the recovery-policy table in `run`. This concept relies on that table; it does not define it.

## Relationships

- `run` — owns the step machine, the `*.awaiting_input` and `*.human_review` steps, the
  `next(workflow, step, directive)` transition rule this concept's replies feed into, and the
  per-state recovery policy.
- `workflow` — owns where the human steps sit in each workflow and how a gate advances.
- `review` — owns the converge-or-escalate round loop; its exhaustion produces the escalation this
  concept presents as a pause.
- `intents` — classifies a human reply into the directive the transition rule acts on.
- `orchestrator` — admits a stopped run back for dispatch and routes the operator actions
  (`ac-run-recover`, `set-step`).
- `execution-runtime` — re-materializes the workspace when a recovered or force-set run dispatches.
- `feedback` — owns the items a person dispositions at a gate and the findings a reviewer raises in
  an escalation payload.

## Constraints and decisions

- One pause-and-resume mechanism serves every human pause: a payload out, a reply classified into a
  directive, `next(...)` re-dispatching (ADR-015 for the directive vocabulary and the step machine).
- A convergence escalation reuses the human-pause primitive rather than a separate mechanism, landing
  the run at a `human` step with the open findings and both last positions (ADR-026).
- Gates and `awaiting_input` steps both declare `waiting_on: human`; the behavioral class derives
  from that one property (ADR-015).
- A non-terminal run is preserved on load and never dropped — its conversation re-registered, its
  stopped step recorded (ADR-021).
- Recovery is an explicit operator action that re-materializes the workspace and re-dispatches from
  the recorded step; it is distinct from the `set-step` operator force, which dispatches from an
  operator-chosen step (ADR-021 for re-materialization).
- A reply to a stopped run gets a clear recover-it response — never silent revival, never a dropped
  reply.

## Open edges

- **Automatic recovery on load.** Today a stopped run waits for the explicit recovery action. A
  later capability could re-dispatch a recoverable run on load without an operator triggering it;
  the recorded stopped step is what such automation would build on.
- **An interactive credential prompt** (for example an SSO sign-in) is not expected. If one ever
  appears, it borrows the pause primitive but belongs to settings and secrets, not to a `hitl` pause
  flavor — it is a one-time prompt for a credential, not a decision handed to a person.
