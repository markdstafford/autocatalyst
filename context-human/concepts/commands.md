---
created: 2026-06-06
last_updated: 2026-11-27
status: active
roadmap: flow
---

# Commands

A command is an authenticated call on the service interface, identical whether it arrives over the
network API or through an in-process adapter. Commands are the small set of operator actions that
mutate a run: not reads, and not natural-language work. This concept owns **which operator actions
exist**, **how each addresses its target**, and the **request-then-confirm rule** for a separate
destructive purge. It does not own natural-language classification (see `intents`), disk reclamation
(see `workspace` and ADR-021), or the API resource taxonomy the actions live in (see `api`).

## A command is an authenticated service call

A command is an authenticated, channel-agnostic call on the service interface (`api`, `orchestrator`,
ADR-009). The operator names one operation against one run; the service applies it through the single
authority. A chat surface (for example an emoji on a message) is one adapter that translates the
gesture into the same authenticated service call any client makes. There is no command transport
separate from the service interface, and no behavior an emoji can reach that a network client cannot.

This makes the action surface uniform across channels. The adapter's job is to recognize the
operator's gesture, resolve which run it targets, and issue the service call; the action itself is the
same call the desktop app would make.

## The operator actions

The service provides five authenticated operator actions:

- **Cancel (`cancel`).** End an unfinished run without waiting for a running session. The run
  becomes `canceled` and does not count as a failure. The session can finish and appear in history,
  but if cancel commits first, the service discards the dispatch result without applying its effects.
- **Archive (`archive`).** Hide a finished run from the default list while keeping it readable by ID
  with its history intact.
- **Unarchive (`unarchive`).** Return an archived run to the default list without reopening it.
- **Set step (`set-step`).** Send an idle, unfinished run to a step that is earlier in workflow order
  and that the run has already reached. The move starts a new attempt and preserves earlier attempts.
  This is distinct from recovery, which is available only for failed runs (see `hitl`).
- **Rename.** Change the topic title shown on every run that shares the topic, including archived
  runs. The linked issue keeps its own title.

Each action passes the policy point that authorizes the acting principal (see Principal on every
call).

## Reads are reads, not commands

The operator questions that report state are plain reads on the API, not operator actions:

- A run's status is `GET /runs/{id}`.
- The list of runs is `GET /runs`, filtered by status, topic, conversation, or project.
- A run's logs are its event stream, `GET /runs/{id}/events`.
- Service liveness is `GET /health`.

These report state and change nothing, so they are ordinary reads in the resource surface (`api`)
rather than members of this set. Treating them as reads keeps the operator-action set down to the
actions that mutate a run, and lets every client read run state the same way.

## Archive changes visibility

`archive` records an archive timestamp without changing the run's lifecycle state or deleting any
records. Operators can still find the run in an archive-inclusive list and read its history by ID.
`unarchive` clears the timestamp. A failed run must be unarchived before recovery.

Workspace reclamation is independent of archive. The workspace lifecycle handles worktree and
scratch teardown at terminal states, and scheduled garbage collection reconciles on-disk workspaces
against run state (`workspace`, ADR-021).

## Confirmation guards only the destructive purge

Archive needs no confirmation because `unarchive` reverses it. Destructive `purge` is outside the
shipped action set. Because purge would irreversibly destroy a run's record, it would require a
**two-step request-then-confirm flow in the API contract**: a first call requests the purge and
returns a token describing what will be destroyed; a second call confirms with that token to execute.
The contract carries the confirmation; there is no channel-specific confirmation mechanism. A chat
adapter that wants to surface a preview-and-confirm interaction renders the two service calls in its
own idiom, but the safety lives in the contract, not in any one channel's gesture.

## Addressing a run

An operator action addresses its target run by `run.id` over the service interface. The run id is the
canonical, channel-independent handle: every client refers to a run the same way. A chat adapter that
lets an operator act on "this run" resolves its own thread-to-run mapping and supplies the resolved
`run.id` on the service call. The mapping is the adapter's concern; the service sees only the id
(`api`, cross-cutting #9).

## Principal on every call

Every service call carries a `Principal` and passes the policy point, reads included (ADR-009,
cross-cutting #20). Reads need authorization eventually because different operators own different
projects, so even reading a run's state is a decision the policy point will make once enforcement is
switched on. The envelope is in place now and enforced later: the principal threads through the whole
stack today against a single hardcoded identity, so the envelope is exercised rather than dormant. The
privileged operator actions are the calls whose policy gate matters first, but the principal is
present on every call alike.

## Relationships

- `api` — owns the resource surface these actions live in: `cancel`, `archive`, `unarchive`, and
  `set-step` are action sub-resources, rename uses `PATCH /v1/runs/{id}`, and reads are ordinary REST
  endpoints.
- `orchestrator` — the single authority every operator action routes through, so each preserves the
  single-writer guarantee on run state.
- `run` — owns the step machine `set-step` validates against and the `canceled` terminal state
  `cancel` reaches.
- `hitl` — owns recovery (`run-recover`) and the do-not-drop guarantee an archived run rests on.
- `intents` — owns natural-language classification; an operator action names one operation and skips
  classification entirely.
- `workspace` — owns disk reclamation (ADR-021), independently of archive.

## Constraints and decisions

- An operator action is an authenticated, channel-agnostic service call routed through the single
  authority (ADR-009); a chat surface is one adapter onto the same call.
- Every service call carries a `Principal` and passes the policy point, reads included; auth-ready
  now, enforced later (ADR-009, cross-cutting #20).
- `archive` changes visibility and preserves run data; disk reclamation follows terminal-state
  policy (ADR-021).
- A `purge` requires a two-step request-then-confirm in the API contract; archive is unconfirmed.
- An operator action addresses a run by `run.id`; a chat adapter resolves its own thread-to-run
  mapping (cross-cutting #9).
- The built-in action set is cancel, archive, unarchive, set step, and rename.

## Open edges

- **Operator- or extension-defined commands.** The catalog is a fixed built-in set today. Letting an
  operator or an extension declare a new action (with its own arguments, confirmation needs, and
  required policy) is a later capability that the authenticated action path can grow into.
- **Action naming.** The action and endpoint names are settled enough to build on, but a whole-corpus
  naming pass may revisit them alongside the rest of the API surface.
- **Adapter confirmation rendering.** How a given chat adapter renders the request-then-confirm
  preview in its own idiom is an adapter concern; the contract fixes the two-step shape, the
  presentation is open per surface.
