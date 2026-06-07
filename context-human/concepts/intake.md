---
created: 2026-06-06
last_updated: 2026-06-06
status: active
roadmap: track
---

# Intake

How work enters Autocatalyst and binds to a place in the work hierarchy. This concept owns the **entry
boundary**: the moment a submission arrives and the binding that decides which `Conversation`, `Topic`,
and `Run` it belongs to. It also owns the **second stage of the two-stage create**: when a submission
points at an existing tracker issue, intake pulls that issue and enriches it so the work kind can be
settled. It does not classify a message into a workflow (that is `intents`), it does not run the tracker
mechanics for pulling or filing (that is `trackers`), it does not define the network endpoints a
submission arrives on (that is `api`), and it does not create or deduplicate the run (that is
`orchestrator`).
Related: `intents`, `orchestrator`, `api`, `trackers`, `domain-model`.

## Entry is resource creation

A submission enters by creating or extending resources, and the resource it touches is what tells intake
whether to open new work or extend existing work. Intake never reads that intent out of the message
content (`api`):

- `POST /conversations` opens a `Conversation`, its main `Topic`, and the first `Run`.
- `POST /conversations/{id}/messages` adds a `Message` that routes to the conversation's active topic.

So opening versus attaching is the caller's choice of endpoint, not a guess intake makes. On the messages
endpoint intake binds the message and routes it to the active topic. What the message *means* (an
approval, feedback, a question, or a new objective that needs its own run) is the classifier's verdict
(`intents`) and the single authority's to act on (`orchestrator`). The three places a created run can
attach (a new main topic, an upgrade under the current topic, a divert into a side topic) split across
the two endpoints: a new main topic is the open-a-conversation case; an upgrade or a divert is the
create-by-message case.

## The four entry kinds

A submission that opens a conversation carries one of four shapes. They are a small set distinct from,
but resolving to, the workflow catalog (`run`/`workflow`):

- **An issue reference** — a structured pointer to an existing tracker issue. Because the reference is
  explicit, nothing has to be classified to recognize that a lookup is needed; intake goes straight to
  the pull-and-enrich and the work kind is settled from the enriched issue.
- **A free-form trigger** — text describing work. The classifier reads it into a workflow. Text that
  happens to name an issue ("work on issue #N") is also free-form; the difference between a one-stage and
  a two-stage create surfaces from classification, not from the submission shape.
- **A question** — its own unambiguous entry, so a question is never inferred ambiguously from a general
  trigger. It names the `question` workflow directly.
- **A list to file** — one or more items to record as tracker issues. It names the `file_issue` workflow
  directly.

The concrete request and response shapes are declared as schemas in the API contract (`api`, ADR-007),
not fixed here; this concept owns which entry kinds exist and how each binds and selects a workflow.

## Binding, identity, and the repository guard

A conversation is bound to a `Project` when it opens, and it carries that reference rather than storing a
repository of its own. The repository a submission works against, the tracker it reads and writes, and
the credentials those use all resolve from the `Project`'s settings in the database (`trackers`,
ADR-008). This is what scopes multi-repository work: each conversation points at its own `Project`, every
tracker operation runs against that project's repository, and no single shared inbound token gathers work
across repositories.

Identity is the set of server-assigned record ids — `Conversation`, `Topic`, `Run`, `Message` — not a
channel-derived key. A caller supplies at most one id: the conversation in the path when extending one,
or nothing when opening one. The active topic, the project, and the new message's id are all resolved by
the service. A channel adapter, when one exists, keeps its own mapping from a channel thread to a
conversation and addresses the service by conversation id, so identity holds whether a submission arrives
through a chat thread or a direct API client.

The entry guard is the conversation's `Project` binding, checked at the entry boundary against the
submission's `Principal` (ADR-009; the authorization check is shaped now and enforced later). A submission
that resolves to no project, or to one its principal may not use, is **refused at the boundary with a
clear error** rather than accepted and abandoned. There is no run to do work that has no repository, so
the entry boundary is where that is reported. Configuring a project and its repository is a settings
concern; intake binds to an existing project, it does not create one.

## The two-stage create for an issue reference

Most work that targets an existing issue arrives through the issue-reference entry, where the pointer is
explicit and no recognition step is needed. The two-stage create is the free-form case — text that says
"work on issue #N". There the classifier recognizes that a lookup must happen before the work kind can be
known; intake then performs the second stage:

- **Resolve the reference** to an issue on the conversation's project.
- **Pull and enrich** — load the issue through `trackers` and fold its title, body, labels, and state
  into the classification context as data, clearly separated from the person's instruction.
- **Settle the workflow** — the classifier reads the enriched issue and selects `feature`, `bug`, or
  `chore`.

Recognizing that a lookup is needed is the classifier's part; pulling and enriching the issue is intake's.
A general free-form trigger that does not target an issue stays a single-stage create, and the
issue-reference entry skips the recognition step but still settles the work kind once the issue is
enriched.

## Filing a list

A submission of items to file selects the `file_issue` workflow. A triage step teases the list into
distinct items, researches each against the codebase, proposes a rich title, body, and labels, and
detects duplicates against existing issues; a filing step then records each new item through `trackers`
and marks each duplicate against the issue it repeats. The person's explicit instruction to file is the
approval — this path records directly rather than passing through a review gate, by design. A configurable
cap bounds how many items one batch files; a batch beyond the cap files its first items and reports that
the remainder were not filed, so a large paste cannot run away. The enrichment is the `mm:issue-triage`
skill rather than intake's own code; intake invokes it and records the validated result (`trackers` owns
the triage task).

## Duplicate detection

Duplicate detection is a defined capability with a stable boundary, so its implementation can advance
(from matching against existing issues today to embedding-based similarity later) without changing the
work that calls it. The filing path uses it: triage compares each item against existing issues and records
a duplicate rather than filing a repeat. The recommended path for new work is to file first, so the work
that begins from an issue has already passed duplicate detection. A free-form trigger that opens work
directly does not run duplicate detection in its baseline form; a duplicate-aware free-form entry (search
for a matching issue, then classify with the match in context) is a capability taken on when a backlog is
large enough that a search on every free-form entry pays for itself, and it reuses the same defined
capability when it lands.

Inside the filing path the triage agent reaches the tracker only through defined, provider-neutral tools
(`trackers`); the search that finds duplicate candidates is one such tool, so the behavior is the same
across tracker providers and the candidate source can change beneath it.

## Acknowledgement

A submission is acknowledged on two timescales, both independent of any channel:

- **Immediately** — the resource-creation response carries the new run's id, so the caller holds a handle
  before classification or enrichment finishes.
- **As it progresses** — a small number of milestone events on the run's persisted, resumable event
  stream (`api`, `execution-runtime`), paced to keep a person informed without flooding them. The intake
  milestones are that the message was received, that it was classified, and that an issue was enriched and
  the workflow settled, the last two only when a multi-stage path runs.

The event protocol is `execution-runtime`'s and the stream is `api`'s; intake emits its milestones into
it. A channel adapter, when present, renders those events onto its surface.

## Relationships

- `intents` — classifies a message's impact and selects the workflow; recognizes that an issue lookup is
  needed. Intake performs the lookup and binds the submission; it does not classify.
- `orchestrator` — the single authority that creates the run, enforces one active run per topic, and acts
  on the upgrade or divert attachment. Intake binds; the gate is the orchestrator's.
- `api` — defines the endpoints a submission arrives on, the request and response schemas, and the event
  stream that carries the acknowledgement milestones.
- `trackers` — pulls a referenced issue, files items, and exposes the search the duplicate capability uses.
- `domain-model` — owns the `Conversation`, `Topic`, `Run`, `Message`, `Project`, and `Principal` shapes
  that binding and identity rest on.

## Constraints and decisions

- A submission enters by creating or extending resources; the endpoint, not the message content, decides
  open versus attach (`api`).
- Four entry kinds — an issue reference, a free-form trigger, a question, a list to file — resolve to the
  workflow catalog; the issue-reference and free-form-work-on-issue cases settle the workflow during
  intake, the question and list cases name it directly.
- A conversation binds to a `Project`; the repository, tracker, and credentials resolve from the project's
  settings, which scopes multi-repository work and removes any single shared inbound token (ADR-008).
- Identity is server-assigned record ids, not a channel-derived key; a caller supplies at most the
  conversation id.
- A submission that resolves to no usable project is refused at the entry boundary with a clear error.
- The two-stage create is the free-form issue-reference case alone; the general create stays single-stage.
- Filing records directly on the person's instruction, bounded by a configurable batch cap; enrichment is
  the `mm:issue-triage` skill.
- Duplicate detection is a defined, swappable capability; the recommended path for new work files first.
- Acknowledgement is the resource response plus channel-independent milestone events on the run's stream.

## Open edges

- **A duplicate-aware free-form entry** (searching for a matching issue before classifying a free-form
  trigger) is taken on when backlog scale makes a per-entry search worthwhile; it reuses the defined
  duplicate capability.
- **A batch that references several issues at once** is additive over the single-issue entry; one
  submission binds one issue today.
- **Ingesting a structured source** (a friction log, a retrospective, a product review read into a
  fileable list) reuses the filing path as another producer when it is built; the list entry handles a
  free-form braindump today.
