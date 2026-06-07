---
created: 2026-06-04
last_updated: 2026-06-07
status: active
roadmap: core
---

# Domain model

The catalog of entities the core stores and the relationships among them, the noun layer beneath
every behavioral concept. It owns the **shapes** and the **persisted records**: the conversation a
person holds with Autocatalyst, the topics and runs that carry work through it, the artifacts and
feedback a run produces, the external objects it touches, and the people and tenants it all belongs
to. It does **not** own the run lifecycle and its step machine (see `run`), who may mutate scheduling
and run state (see `orchestrator`), the network surface that exposes these entities (see `api`), or
the static topology they live in (see `architecture`).

## The work hierarchy

A person's interaction is a three-level structure, **`Conversation -> Topic -> Run`**, with
**`Message`** as the communication that flows through it (ADR-013, ADR-014).

- A **`Conversation`** is the durable aggregation of an ongoing interaction. Like a chat thread, it is
  a passive container: it groups what happens inside it but does not steer it. It owns the binding to
  wherever it is surfaced (a channel, an app session) and a **channel-independent identity**, so a
  conversation is the same entity whether it began in a chat thread or through a direct API client.
- A **`Topic`** is a focused objective within a conversation — "ship feature X", "fix bug Y". A
  conversation has **one main topic** (its principal objective) and zero or more **side topics**
  (diversions); exactly one is the **active topic** at any moment, the one inbound messages route to.
  The topic is the durable home of an objective's messages and its run sequence.
- A **`Run`** is one execution of a workflow serving a topic. It carries the step the work has
  reached, the work product so far, and the cost of one attempt. A topic's runs are **sequential**,
  with **at most one active (non-terminal) run per topic**: the guarantee that an objective is worked
  once, attached to the objective itself (ADR-014). Across a conversation with several topics, several
  runs may be active at once, one per topic.
- A **`Message`** is a single communication within a topic, in either direction — from a person or
  from Autocatalyst. It belongs to the topic that was active when it arrived; a conversation's
  transcript is the time-ordered union of its topics' messages. An inbound message carries a
  **`MessageIntent`**, classified per message (ADR-016); `intents` refines this classification into the
  four impacts a message has on its run — `create`, `advance`, `revise`, `answer` — which the
  orchestrator acts on.

These four are the spine; the entities below hang off a `Run`.

## Artifacts

An **`Artifact`** is a work product that becomes visible **outside Autocatalyst** when it is approved
(ADR-017). A feature spec is committed to the repository; an enhancement spec the same; a bug or chore
takes its authoritative form as issue-tracker content. All of them leave the system, so all of them
are artifacts. A review surface that stays *inside* Autocatalyst — a testing guide — is a `Publication`
instead (below), not an artifact.

There is one `Artifact` model with a `kind`: **`feature_spec`**, **`enhancement_spec`**, **`bug_triage`**,
or **`chore_plan`**. The fields that matter (location, status, publication, and linked issue) are
shared across the kinds; the behavior that differs between them is carried by the run's workflow (see
`run`), so a single model suffices. The kind is a projection of the workflow: the four artifact-producing
workflows (`feature`, `enhancement`, `bug`, `chore`) each map to one kind. The `file_issue` and
`question` workflows author no `Artifact` — `file_issue` records its filed issues as run-to-issue
references (below) and `question` produces only a response. Each kind also fixes a **canonical record**, a single axis
valued `file`, `issue`, `other`, or `none` saying where the durable record of the work lives:
`feature_spec` and `enhancement_spec` are `file` (a committed spec), `bug_triage` and `chore_plan` are
`issue` (the tracker issue); `other` and `none` are reserved for future kinds. `spec-lifecycle` owns
this axis and its per-kind values; the entity carries it. An artifact attaches to the `Run` that authors
it; a topic's successive runs can author different artifacts, and the topic's current artifact is its
active run's.

An artifact's **document-intrinsic lifecycle** — its own `status`, `supersedes`/`superseded_by`,
provenance, and timestamps — is the spec's life *as a document*: it is committed, editable by a person
directly, and outlives any run. That lifecycle's source of truth is the committed frontmatter, not the
database. The typed `Artifact` entity holds the **operational handle** the core works through (the
location, the kind, the parent run, the publications, the linked issue) plus a **read-only cached
`status`** for querying without reading every file, refreshed when the core touches the artifact. The
cached `status` is Autocatalyst's own, richer operational set; it maps one-way down onto the
committed-frontmatter status values (`draft`, `approved`, `implementing`, `complete`, `superseded`) at
the moments the core writes the file. The two sets stay distinct: the committed frontmatter is the
source of truth, the cached status a convenience the database keeps for fast reads (`spec-lifecycle`).

## Feedback

A **`Feedback`** item is a structured, tracked unit of review, a mini-issue, that
records a request to change something (ADR-018). It is distinct from a `Message`: a message conveys,
while feedback carries an expectation that it be addressed. Each item records what needs fixing, an
optional **anchor** (which region of a spec, which part of an implementation, or which proposed doc
change), a **`target`** (`artifact`, `implementation`, `docs`, or `pr`) naming which gate review it
concerns — one target per gate that accepts feedback — and attribution. Each item also
carries a **thread** — the discussion about resolving it, recording the originating comment, the
model's response, and any further replies as an ordered list, each attributed to a `Principal`, since
several people may take part. The thread is an embedded value object; its one firm requirement is
per-comment `Principal` attribution.

Feedback has a reopenable lifecycle — `open -> addressed -> resolved | wont_fix` — where `wont_fix`
is a deliberate, recorded non-fix. It is **parented to the `Run`** it concerns (a topic that fixes
several things in succession produces distinct feedback per run). The model enforces one rule that
gives sign-off its meaning: **a run cannot leave a human-review gate, or reach `done`, while it has
open feedback for that review**. The `target` makes the gate per-review, and completion requires every
item dispositioned. Feedback arriving on any surface (comments on a published spec, items on a testing
guide, a message in a channel) is extracted into this
one model, so review feedback is tracked uniformly rather than stranded on a side surface (the
extraction behavior belongs to `feedback`/`workflow`; the record shape belongs here).

## Publications

A **`Publication`** is the ephemeral view-and-feedback surface for whatever a run puts under review:
the spec at its review gate, the implementation at its review gate, and the proposed doc changes at the
docs gate. The docs gate fronts a **`DocDiffProposal`** — the validated result of `docs.update`,
carrying the human-owned doc changes compaction proposes (`docs-model`, ADR-029); `docs`-target
feedback anchors to it, and a review with no proposed human-owned change has nothing to front. It records that run content is
rendered onto an external surface: a `provider`, a `url`, a `label`, and what it fronts. It is
**parented to the `Run`** (`Run` to `Publication` is one-to-many: a spec page, a testing-guide page,
status updates). A publication is a surface, not a stored work product: the **testing guide** is a
publication of the implementation review, and because it stays inside Autocatalyst it is a publication
rather than an artifact. The testing guide renders two records the run already holds — its **result**
(an embedded value object carrying the implementation summary and testing instructions) and its
`Feedback`. Because the result is read and written only with its run, it is an embedded value object
(ADR-019), not its own table.

## Pull requests

A **`PR`** is a run-parented record of the pull request a run opens: `provider`, `number`, `url`,
`state` (`open -> merged | closed`), and `branch`. It carries state rather than being a bare link, so
the merge signal that ends a run, and the detection of a PR that stalls before merge, both read from
it. A run opens one PR; the record is effectively one-to-one with its run. Its apparent cross-references
(this PR implements that spec, this PR closes that issue) are the run's relationships, recorded as
links (below).

## Test results

A **`TestResult`** records one human test pass over a run's implementation: the `Principal` who ran it,
the outcome, the evidence captured (a reference into the run's scratch — screenshots, a video, notes),
and the `Feedback` the pass raised. It is **parented to the `Run`** (`Run` to `TestResult` is
one-to-many; a run re-tested after a fix produces another). It **references** rather than embeds the
`Feedback`, which is its own run-parented, reopenable record (above). The acceptance-testing gate owns
when a result is captured and how it gates run completion (see `acceptance-testing`); this concept owns
the record shape.

## Cost and step occurrences

A **`RunStep`** is one occurrence of a step within a run, the timeline record. Each step the run
enters produces a `RunStep`, recording when it started and ended (its duration). Recording a `RunStep`
for every step, including gates and system steps, keeps the run's timeline in one place. `RunStep` is
parented to the `Run` (`Run` to `RunStep` is one-to-many; a step can recur as a run loops).

A **`Session`** is the atomic cost and telemetry record: one model's single go within a step, at
`(run, phase, step, role, round)` grain. It carries the resolved model, the inference settings (thinking
or effort level), the start, end, and duration, the normalized token breakdown, a `usage_available`
flag, the assistant-turn and tool counts, the outcome, and an embedded **`Cost`**. The cost unit is the
session (ADR-015): one session is one model at one rate, so it carries exactly one `Cost`. `Session` is
parented to the `Run` (`Run` to `Session` is one-to-many; a step that runs several
rounds between the implementer and reviewer leaves several session rows). A gate, and any human- or
system-driven step,
runs no session, so it bears no cost. A bounded direct call (classification at intake, PR-title
generation) also runs a session, attributed to the run it resolves to with a null phase and an empty
(`none`) role, so its spend is counted rather than lost. `(step, role)`, step, and phase are not stored
cost records of their own; they are `GROUP BY` aggregations over the session rows.

**`Cost`** is a value object, not a scalar: a `model` (provider and name), a monetary `usd` (an integer
count of nano-dollars, never a float), and a `tokens` breakdown (`input`, `output`, `cache_read`,
`cache_write`). A `Session` carries one `Cost`.

Cost rolls up the hierarchy by summation: sessions sum to `(step, role)`, step, and phase totals, and
on up to `Run`, `Topic`, `Conversation`, and `Project`. These rollups are **computed live**: a
query sums the session rows that exist when it runs, so a backfilled rate or a late-arriving session is
reflected on the next read with no stored rollup to keep in step. A cached, present-when-complete
**`aggregateCost`** column at `Run` and above (carrying the null-and-propagate-on-new-run invalidation a
stored rollup needs) is a **deferred** optimization, taken only if read volume ever makes live summing
slow. A per-step, per-phase, per-model, or per-token breakdown at any level is a dedicated query over
the `Session` rows rather than a pre-stored rollup.

## Project

A **`Project`** is the software thing Autocatalyst builds, the top of the ownership and cost rollups,
spanning many conversations. It is a first-class entity: a conversation binds to a `Project` when it
opens, and the repository worked on, the issue tracker and code host, the workspace root, and the
credentials for them all resolve from the project's settings (`settings`, `trackers`, `workspace`,
ADR-008). It carries `id`, `owner`, `tenant`, a display name, a `repo_url` and host-repository
location, a workspace-root override, an issue-tracker setting, a code-host setting, and references to
the credentials those use. At the current scale a project corresponds one-to-one with a repository; the
entity is what scopes work and configuration at that scale, and it is the grouping a later
multi-repository project builds on.

## Identity and attribution

A **`Principal`** is the actor identity — an identity plus a tenant — threaded through every request
(ADR-009). It is the owner reference and the author of a message, in place of a bare name string. A
`Principal` carries a **`kind`**: `human`, `model`, or `system`. A `model` principal's identity is its
resolved provider and model, and it is an **author only**: it is never an owner, never the subject the
policy point authorizes, and not tenant-scoped, since the same model serves every tenant. This is what
lets a model reviewer's finding be attributed like a person's — one `Feedback`, attributed by its
authoring principal's `kind` — without a separate origin flag. The system runs under a single hardcoded
`human` `Principal`, and the envelope is exercised end-to-end so it is real rather than scaffolding.

Every major entity — `Project`, `Conversation`, `Topic`, `Message`, `Run`, `Artifact`, `Feedback`,
`Publication`, `PR` — carries an **`owner`** (a `Principal`) and a **`tenant`**, so ownership and
tenancy are representable on the row itself. Records that hang off a parent (`RunStep`, `Session`,
`TestResult`) and pure value objects (`Cost`) inherit ownership from their parent. Recording tenancy
on the row is what lets tenant-scoped queries and database-enforced isolation grow against it (ADR-004). The policy point that reads owner and tenant
lives in the API layer (see `api` and ADR-009), not here; the model's part is to carry the attribution.

## Persistence layout

The model maps onto SQLite through Drizzle, behind a repository abstraction (ADR-004), as **normalized
tables for entities and embedded JSON for value objects** (ADR-019). Entities with identity, a
lifecycle, or independent query needs are tables: `Project`, `Conversation`, `Topic`, `Message`, `Run`,
`Artifact`, `Feedback`, `Publication`, `PR`, `RunStep`, `Session`, `TestResult`. Value objects that are
only ever read and written with their owning row are embedded JSON columns: a `Cost`, a token breakdown,
a feedback anchor, a channel reference. The dividing question is whether a thing needs to be found,
filtered, or carry its own lifecycle (a table) or is an attribute of exactly one row (embedded). This
keeps the queries the core relies on — open-feedback checks, cost aggregation over the `Session` rows,
the one-active-run-per-topic uniqueness constraint — as first-class SQL.

## Links between entities

Most relationships in the model are **composition**: an artifact, feedback, a publication, a PR, and a
run's steps all belong to their run, and a run belongs to its topic. The cross-entity relationship the
core records as a genuine **link** is **run-to-issue**: the issue a run works on, or the issues it
files. A run holds a typed reference to its `TrackedIssue` — an external issue with its `number`,
`title`, `state`, and `url` — resolved by foreign key when the issue is stored and by its external key
(the issue number) before it is.

A general, anything-to-anything linking model — arbitrary typed relationships among any entities — is
**an open question, not settled here.** It is powerful and carries real cost, and the cases that would
shape it (whether arbitrary links are allowed, whether a relationship type constrains which entities it
may join) are not yet concrete enough to design against. This concept records the run-to-issue reference
it needs now and leaves the general cross-entity model to revisit when typed, queryable relationships
across arbitrary entities have a concrete use, rather than building it speculatively.

## Relationships

- `run` — owns the `Run` lifecycle, its steps, and the workflows that select an artifact kind; this
  concept owns the `Run`, `Topic`, and `Conversation` shapes those move through.
- `orchestrator` — the single authority that creates and mutates these records and enforces the
  one-active-run-per-topic constraint.
- `api` — exposes these entities as resources and carries the `Principal` that fills their attribution.
- `architecture` — the persistence substrate (SQLite, Drizzle, the repository abstraction) and the
  identity/tenancy seam these shapes inhabit.
- `execution-runtime` — produces the events and the validated results a run records, and the
  re-creatable workspace a `Run` references.
- `feedback`/`workflow` — own the loops that raise and resolve `Feedback` and drive artifacts
  through review.
- `acceptance-testing` — owns when a `TestResult` is captured and how it gates run completion; this
  concept owns its shape.
- `observability`/`cost` — write and read the `Session` record this concept owns: `observability`
  records its execution metadata, `cost` prices its tokens into the embedded `Cost`.

## Constraints and decisions

- The work hierarchy is `Conversation -> Topic -> Run` with `Message`, named per ADR-013 and structured
  per ADR-014; the one-active-run-per-topic guarantee is a database uniqueness constraint.
- One `Artifact` model, defined by external visibility on approval, with the kind projected from the
  workflow (ADR-017); document-intrinsic lifecycle stays in committed frontmatter.
- `Feedback` is first-class, run-parented, and gates run completion (ADR-018).
- A `TestResult` is run-parented, records a human test pass, and references the `Feedback` it raised.
- The atomic cost unit is the `Session`; `Cost` is a structured value object embedded on it, and
  `(step, role)`, step, phase, and above are live `GROUP BY` rollups, with a cached `aggregateCost`
  deferred (ADR-015).
- Every major entity carries `owner` and `tenant`, including a `kind` (`human`/`model`/`system`) on the
  `Principal` (ADR-009).
- Normalized tables for entities, embedded JSON for value objects (ADR-019, ADR-004).

## Open edges

- The general cross-entity **linking** model — arbitrary typed relationships among entities — is
  deferred; revisit when typed, queryable relationships across arbitrary entities have a concrete use.
  Only the run-to-issue reference is settled here.
- The surface for **switching among several topics** in one conversation is a direction the structure
  admits (one main topic, the rest side); the model carries the main/side distinction the surface
  builds on.
- **Resume** records where a run stopped; re-materializing the workspace and re-dispatching is owned by
  `run` and `execution-runtime`.
