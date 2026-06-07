---
created: 2026-06-06
last_updated: 2026-06-06
status: active
roadmap: flow
---

# Acceptance testing

The human-test gate of a run: after the build is ready, a person exercises the change and dispositions
it before the run moves toward a PR. This concept owns the `implementation.human_review` gate from a
testing standpoint: handing a person a testing guide, capturing the test result, and keeping the
test-result record that says the testing happened. It does not own delivering the runnable build to the
person (that is `execution-runtime`), the shape of the `Feedback` entity (that is `domain-model`), or
where the pause-and-resume mechanism lives (that is `hitl`, whose primitive this gate uses). The
developer test suite is separate: the agent's own behavior-tests that run while building are a coding
standard, not this gate, and this concept does not own them.

## The gate

When the build is ready, the run reaches `implementation.human_review` and pauses for a person. The
person exercises the change by hand and dispositions the result: the change passes and the run advances
toward a PR, or it needs work and the run goes back to revise. The run cannot advance out of this gate,
or reach `done`, while testing has open `Feedback` against the implementation. Manual human testing is
the default: a deliberate posture for the work this product does now, where a person running the change
and judging it is the trustworthy signal rather than a gap waiting to be filled with automation.

## The test-result record

The gate rests on a structured **test-result** record, parented to the run. It
records *that* testing happened: who exercised the change, the outcome (pass or fail), and the evidence,
and it references the `Feedback` raised during that pass. The test-result is the testing record; the
`Feedback` is the actionable part. (The `TestResult` entity is owned by the `domain-model` catalog; this
concept describes what it holds and how the gate uses it — see Relationships.)

A run's gate can be exercised more than once. When testing surfaces problems, the run goes back to
revise and returns to the gate for another pass; each pass that a person performs produces its own
test-result record, so the run keeps a timeline of how testing went rather than a single overwritten
verdict.

## Feedback holds the gate

The items a person raises while testing are `Feedback`, parented to the run and targeted at the
implementation. They are what hold the gate: open feedback against the implementation blocks the
advance, and a `revise` directive sends the run back to its producing step to address them. Gating is
exactly as the feedback concept sets it: every item for the implementation target dispositioned
(resolved or `wont_fix`), the originator confirming the fixes they raised. The acceptance-testing
concept does not invent its own gating rule; it relies on the one feedback already owns.

The test-result record and the `Feedback` play distinct parts. The test-result says testing was done
and how it went; the feedback says what to change. A pass with no feedback is a test-result with nothing
to fix and an open advance; a pass with feedback is a test-result that references items the run must
work through before it returns.

## The testing guide

The person tests against a **testing guide** — a `Publication` that renders the run's test-result and
its `Feedback` onto a surface a person reads and works in. The guide is a view, not a stored work
product: it fronts records the run already holds, and it is never committed or filed. It stays a
`Publication` rather than being promoted to a first-class entity; the test-result record is the durable
thing, and the guide is how a person sees it.

The feedback the guide shows is a rendering of the `Feedback` rows, which are the source of truth. The
guide does not keep its own checkbox tracking that a person ticks independently of the records — when a
person raises an item or it is dispositioned, that lives in the `Feedback` row and the guide reflects
it. There is one place an item's state lives, so the guide and the records cannot drift apart.

The guide carries no status of its own. Its state is read from the run's step and `waiting_on` (see
`run`): the run sitting at `implementation.human_review` with `waiting_on: human` *is* the guide waiting
for a person, and the run moving on *is* the guide done. A separate guide-status field could drift from
the run; deriving it from the run removes that possibility.

## Evidence

Evidence has two homes split by weight. The durable record — the outcome, who tested, and the references
to the feedback raised — lives in the test-result record in the database, so the fact of testing
survives as long as the run does. Heavy evidence, such as a video of the test run, sits in the
workspace scratch root and is torn down with the workspace (`execution-runtime` owns the two-root
workspace and its teardown). Such evidence is available during the review window, while the workspace is
live, and is not archived past it. The test-result record carries an evidence slot a video can fill, so
the record points at evidence that exists while the workspace does without taking on the burden of
storing it durably.

## Clicking into a result

A person opens a test-result record from the run view or the acceptance-testing surface. The record
shows how a given pass went: its outcome, who ran it, and the feedback it referenced.
Because a run keeps a record per pass, the click-into surface can show the testing history of a run, not
only its latest verdict.

## The gate uses one human-pause mechanism

The gate does not own pausing and resuming. It is one flavor of the single human pause-and-resume
mechanism owned by `hitl`: the run pauses at the `human` step, hands the person the guide as its
payload, and resumes when the person replies. An approval reduces to `advance`, feedback to `revise`,
a question to a no-op. This concept supplies what the gate's payload is (the guide rendering the
test-result and feedback) and what dispositioning the test means; `hitl` supplies the pause, and `run`
supplies where the gate sits and how it advances.

## Relationships

- `domain-model` — owns the entity shapes, including the run-parented **`TestResult`** record this gate
  captures, and the `Feedback` and `Publication` shapes this gate renders.
- `feedback` — owns the `Feedback` lifecycle and the per-target gating rule; this concept's gate holds
  on open implementation feedback exactly as feedback defines.
- `hitl` — owns the one pause-and-resume mechanism; this gate is one flavor of it, supplying its payload
  and valid replies.
- `run` — owns the `implementation.human_review` step, its `waiting_on`, and the transition rule the
  gate's replies reduce into; the guide's state derives from the run's step.
- `execution-runtime` — delivers the runnable build to the person and owns the two-root workspace,
  including the scratch root where heavy evidence lives and is torn down.

## Constraints and decisions

- The test-result is a structured, run-parented record built around `Feedback`: it records that testing
  happened (who, outcome, evidence) and references the feedback raised (ADR-018 for the feedback it
  references; the `TestResult` shape is owned by `domain-model`).
- `Feedback` carries the actionable part and holds the gate; gating is per-target with every item
  dispositioned, owned by the feedback concept (ADR-018).
- The testing guide is a `Publication`, not an `Artifact` — it stays inside the system and becomes
  nothing externally durable on disposition (ADR-017).
- The guide renders `Feedback` rows as the source of truth, not its own checkbox tracking (ADR-018).
- The guide's state derives from the run's step and `waiting_on` rather than a separate status that can
  drift (ADR-015).
- The gate is one flavor of the single human pause-and-resume mechanism owned by `hitl`.
- The durable record lives in the database; heavy video evidence lives in the workspace scratch root and
  is torn down with the workspace, available during the review window only.

## Open edges

- **A video-capture harness** (for example, Playwright recording a test run) and **automatic test
  execution**. The design accommodates them — the evidence slot the record carries, video held in
  scratch — and the harness is taken when the build's automated UI testing warrants it. Until then, manual
  testing is the default path, not a placeholder for it.
- **Durable video archival** beyond the workspace scratch root. Today evidence lives only as long as the
  workspace; archiving it past the review window is a capability added when keeping it is worth the
  storage it costs.
