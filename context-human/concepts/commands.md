---
created: 2026-06-06
last_updated: 2026-06-06
status: active
roadmap: flow
---

# Commands

A command is an authenticated call on the service interface, identical whether it arrives over the
network API or through an in-process adapter. Commands are the small set of operator actions that
mutate a run: not reads, and not natural-language work. This concept owns **which operator actions
exist**, **how each addresses its target**, and the **request-then-confirm flow** for the one
destructive action. It does not own natural-language classification (see `intents`), disk reclamation
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

Three authenticated operator actions exist:

- **`cancel`** — stop an active run. The run reaches its `canceled` terminal state, which is distinct
  from `failed` so an operator stop is never metered as a failure (`run`).
- **`set-step`** — force a run to an operator-chosen step. An operator uses this override when a run
  needs to resume from a different point than its recorded step. It is distinct from recovery, which
  resumes a stopped run from where it stopped (`hitl`, `orchestrator`). The target step is validated
  against the step machine before it is applied.
- **`cleanup`** — archive a run so it drops out of active views while staying recoverable and
  auditable (see Cleanup is archive). A rare, destructive `purge` is a separate confirmed action (see
  Confirmation).

All three are privileged: they change run state, so each passes the policy point that authorizes the
acting principal (see Principal on every call).

## Reads are reads, not commands

The operator questions that report state are plain reads on the API, not operator actions:

- A run's status is `GET /runs/{id}`.
- The list of runs is `GET /runs`, filtered by status, topic, conversation, or project.
- A run's logs are its event stream, `GET /runs/{id}/events`.
- Service liveness is `GET /health`.

These report state and change nothing, so they are ordinary reads in the resource surface (`api`)
rather than members of this set. Treating them as reads keeps the operator-action set down to the
actions that mutate a run, and lets every client read run state the same way.

## Cleanup is archive, not delete

`cleanup` archives a run with a tombstone: the run drops out of active listings, but no data is
destroyed and the run stays recoverable and auditable. The record persists; only its visibility in
active views changes. This clears clutter (an operator clearing finished or abandoned runs out of the
working view) and composes with the do-not-drop-on-load guarantee (`hitl`), because an archived run is
still a preserved run.

`cleanup` does not reclaim disk. Disk is reclaimed automatically: a run's worktree and scratch are
torn down at terminal states by workspace reclamation, and a scheduled garbage collection reconciles
on-disk workspaces against run state (`workspace`, ADR-021). That handles the large majority of disk.
Cleanup cross-references reclamation rather than owning it: it tidies the operator's view of runs, and
the workspace lifecycle frees the bytes.

## Confirmation guards only the destructive purge

Archiving is recoverable, so `cleanup` needs no confirmation: an operator can undo it by recovering
the run. A `purge` that destroys a run's record is rare and irreversible, so it requires a **two-step
request-then-confirm flow in the API contract**: a first call requests the purge and returns a token
describing what will be destroyed; a second call confirms with that token to execute. The contract
carries the confirmation; there is no channel-specific confirmation mechanism. A chat adapter that
wants to surface a preview-and-confirm interaction renders the two service calls in its own idiom, but
the safety lives in the contract, not in any one channel's gesture.

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
privileged operator actions (`cancel`, `set-step`, and `cleanup`/`purge`) are the calls whose policy
gate matters first, but the principal is present on every call alike.

## Relationships

- `api` — owns the resource surface these actions live in: `cancel` and `set-step` are action
  sub-resources, the reads are ordinary REST endpoints, and the confirmation flow is part of the
  contract.
- `orchestrator` — the single authority every operator action routes through, so each preserves the
  single-writer guarantee on run state.
- `run` — owns the step machine `set-step` validates against and the `canceled` terminal state
  `cancel` reaches.
- `hitl` — owns recovery (`run-recover`) and the do-not-drop guarantee an archived run rests on.
- `intents` — owns natural-language classification; an operator action names one operation and skips
  classification entirely.
- `workspace` — owns disk reclamation (ADR-021); `cleanup` cross-references it rather than freeing
  disk itself.

## Constraints and decisions

- An operator action is an authenticated, channel-agnostic service call routed through the single
  authority (ADR-009); a chat surface is one adapter onto the same call.
- Every service call carries a `Principal` and passes the policy point, reads included; auth-ready
  now, enforced later (ADR-009, cross-cutting #20).
- `cleanup` archives with a tombstone and destroys no data; disk is reclaimed automatically at
  terminal states (ADR-021).
- A `purge` requires a two-step request-then-confirm in the API contract; archive is unconfirmed.
- An operator action addresses a run by `run.id`; a chat adapter resolves its own thread-to-run
  mapping (cross-cutting #9).
- The action set is a fixed built-in set: `cancel`, `set-step`, `cleanup`/`purge`.

## Open edges

- **Operator- or extension-defined commands.** The catalog is a fixed built-in set today. Letting an
  operator or an extension declare a new action (with its own arguments, confirmation needs, and
  required policy) is a later capability that the authenticated action path can grow into.
- **Action naming.** The action and endpoint names are settled enough to build on, but a whole-corpus
  naming pass may revisit them alongside the rest of the API surface.
- **Adapter confirmation rendering.** How a given chat adapter renders the request-then-confirm
  preview in its own idiom is an adapter concern; the contract fixes the two-step shape, the
  presentation is open per surface.
