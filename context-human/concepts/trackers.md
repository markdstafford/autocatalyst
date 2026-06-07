---
created: 2026-06-06
last_updated: 2026-06-06
status: active
roadmap: track
---

# Trackers

The integration where Autocatalyst reads and writes issues and opens and merges pull requests against
external services. This concept owns two provider-neutral ports — an **issue tracker** port and a
**code-host** port — and the adapters behind them (GitHub now, with the issue port shaped so a Jira
adapter slots in later). It also owns batch issue filing with duplicate detection, the AI-assisted
tracker work (issue triage and pull-request title generation), and the tracker side of source
configuration and credentials. It does not own the `PR` entity or the run-to-issue `TrackedIssue`
reference (those are `domain-model`'s; trackers operates on them), the run lifecycle that decides a merged
pull request ends a run (`run`/`orchestrator`), the classification that selects a workflow (`intents`), or
the maintenance of the run's implementation result (`run`/`workflow`; trackers consumes it). Related:
`domain-model`, `orchestrator`, `api`, `intake`, `run`, `workflow`, `acceptance-testing`, `feedback`.

## Two ports on two provider axes

Issue tracking and code hosting are different boundaries that one provider may happen to span. Reading and
writing an issue (its title, body, labels, and state) is the issue tracker's concern, and a service like
Jira does it over an HTTP API with no working copy involved. Opening a pull request pushes a branch with
git from a workspace and is the code host's concern, which a pure issue tracker never implements. GitHub
is both an issue tracker and a code host; the two ports stay separate so that each provider implements only
what it is.

That separation makes the issue tracker and the code host **independent settings on a `Project`**: a
project can track issues in one service and host code in another, which is a real configuration rather than
a special case, and it confirms the boundary sits in the right place.

## The issue tracker port

The issue tracker port is provider-neutral and needs no workspace. Each operation takes a `target` (the
tracker reference resolved from the `Project`'s settings, a repository for GitHub or a base URL and project
key for Jira) plus issue data:

```ts
create(target, draft): { number };
read(target, number): TrackedIssue;
search(target, query): TrackedIssue[];
update(target, number, fields): void;
```

`TrackedIssue` is `domain-model`'s shape (`number`, `title`, `body`, `labels`, `state`, `url`); the port
produces and consumes it. Closing an issue is an `update` that sets its state, though the usual close is the
pull request's closing reference at merge rather than a direct call; a provider whose state changes are
workflow transitions maps that inside its adapter, not in the contract. The GitHub adapter runs `gh` with
the repository passed explicitly, so the command's working directory is an adapter detail and never part of
the contract; a working copy is a convenience for `gh`, not a requirement of the operation.

**Agents read the tracker only through defined tools, and never write it.** Where an agent session needs
tracker data, such as the triage agent searching for duplicates, it calls a defined, provider-neutral tool
rather than reaching for a provider command of its own, so the behavior is identical across providers and
observable as a tool call. Every tracker write is a deterministic step that runs after a gate (below); no
agent creates, edits, or files an issue.

## The code-host port and the pull-request record

The code-host port opens, updates, and merges pull requests. It is shaped around git and the workspace
because opening a pull request pushes the run's branch, though the concept it works in is shared across hosts:
a proposed merge of a branch into a base, with a title and body, a number, a url, and a state (a GitHub
pull request, a GitLab merge request). The neutral `PR` entity already carries a `provider`, so another host
is another adapter behind the same port rather than a change to the contract:

```ts
create(workspace, branch, content): PR;   // pushes the branch, opens the request, returns the record
read(target, number): PR;                  // status only — workspace-free
update(workspace, pr, content): void;       // revise an open request in place
merge(workspace, pr): void;
```

The `PR` record (`domain-model`) carries state so the signal that ends a run reads from it. Trackers writes
the record at `create` (its provider, number, url, branch, and an open state), sets it merged on a
successful merge, and sets it closed on a close. Because a person may merge a request directly on the host,
the merge signal is both **caused** by an Autocatalyst merge and **detected** independently: a bounded check
reads the state of the open requests that runs are waiting on, so a merge done outside Autocatalyst ends its
run as well. This bounded read of known
open requests is distinct from watching a tracker for new or changed issues, which Autocatalyst does not do.
The transition that ends the run is `run`/`orchestrator`'s; trackers supplies the reads and writes.

The merge strategy is a `Project` and code-host setting, defaulting to a squashed merge that deletes the
branch; it is a setting rather than a fixed constant so a repository that needs another strategy is a
configuration change.

## Configuration and credentials

The tracker and code host a project uses, and the credentials for them, are `Project` settings in the
database (ADR-008), not values derived from a chat channel or read from the host's ambient git and GitHub
login. A setting names the provider and its `target`, and carries a **reference** to a credential; the
secret itself lives in the service's secret store, never as plaintext on the record. A connection test
validates a setting when it is written, reporting failures in categories that never reveal the token, and
removing a tracker setting deletes the credential it owns. The GitHub adapter receives its token from this
configuration and passes it to `gh` and `git`. The secret store itself is `architecture`'s and configuration
management is `settings`'; trackers uses them through the credential reference.

## Triage, titles, and duplicate detection

Two pieces of tracker work are AI-assisted.

**Issue triage** enriches a list of items to file: it identifies each distinct item, researches it against
the codebase, proposes a title, body, and labels, and records a duplicate reference where an item repeats an
existing issue. It is the `mm:issue-triage` skill, run as an agent session in the workspace because it
researches the code; its result is validated strictly before any item is filed, and the agent records
enrichment data only — filing is a separate deterministic step. Triage is a filing-time enrichment step and
stays distinct from a run's review feedback: `Feedback` (`feedback`, ADR-018) reviews a run's work product
and gates its completion, while triage prepares items to file. (It is also distinct from the `bug_triage`
artifact kind, which is a run's work product reviewed through the normal gate.)

Duplicate detection is the defined, swappable capability `intake` relies on. Its candidates come from the
issue tracker's `search`, exposed to the triage agent as a tool, so the behavior is provider-portable and
its implementation can advance to embedding-based similarity beneath the same boundary.

**Pull-request titles** are generated from the run's implementation summary and prefixed per the
conventional-commit convention (below). A failed generation falls back to a deterministic title, so the
generated title improves the default rather than gating the merge.

## Conventional-commit titles

One conventional-commit convention runs across commit messages, pull-request titles, and issue titles. The
type is derived from a single mapping (a feature or enhancement to `feat`, a bug to `fix`, a chore to
`chore`), and the derivation lives in one shared place that the code-host port (pull-request titles), the
issue tracker port (issue titles), and the host's commit step all use, so the convention is enforced once.
The type's source differs by surface (a run's work kind for a pull request or commit, an item's triaged
type for a filed issue) while the format is shared. The
convention and the mapping are recorded as a coding standard (`context-agent/standards/`), referenced here
and by `workspace`.

## The cumulative final change

A pull request's title and body describe the complete change a run produced, not only its last round of
feedback. The run keeps a cumulative implementation summary that each round folds into rather than replaces,
and the pull-request content is sourced from that summary at finalization. The finalization step, which
already reviews the final state for readiness, reconciles the summary against the actual final change and
adjusts it, so the description holds however many rounds the run took. Maintaining the cumulative summary is
`run`/`workflow`'s; trackers consumes it for the pull request. The issue key written into a closing
reference is validated to an integer where it is written, not only where it is later read, so a non-integer
value cannot reach the tracker or a publish surface.

## Relationships

- `domain-model` — owns the `PR` entity, the `TrackedIssue` reference, the `Project` whose settings resolve
  a target and credentials, and the run's implementation `result`.
- `run`/`workflow` — own the lifecycle that opens, finalizes, and merges a pull request, the gates each
  write runs after, and the cumulative implementation summary trackers consumes.
- `orchestrator` — the single authority whose run-state transitions the merge signal feeds.
- `intake` — pulls a referenced issue and files lists through these ports, and relies on the duplicate
  capability the `search` tool backs.
- `api` — the surface that exposes the entities these operations write.
- `feedback` / `acceptance-testing` — own the review and testing records; trackers' triage enrichment is
  distinct from review feedback.

## Constraints and decisions

- Two provider-neutral ports on two axes: a workspace-free issue tracker port and a git-shaped code-host
  port; a provider implements only the axis it is. GitHub is both; a Jira adapter is the issue port only.
- The issue tracker port takes a `target` resolved from the `Project`; the working directory is an adapter
  detail. Agents read the tracker only through defined tools and never write it.
- The code-host port returns and updates the `PR` record; the merge signal is detected through a bounded
  read of open requests as well as caused by an Autocatalyst merge. Merge strategy is a setting defaulting
  to squash-and-delete.
- Tracker and code-host targets and credentials are `Project` settings (ADR-008); credentials are
  references into the service secret store, validated by a connection test on write.
- Triage is a filing-time enrichment step, distinct from `Feedback` and from the `bug_triage` artifact
  kind; duplicate detection is a defined, swappable capability backed by the `search` tool.
- One conventional-commit convention spans commit, pull-request, and issue titles, derived once from the
  work kind and recorded as a coding standard.
- A pull request's title and body describe the cumulative final change, sourced from the run's
  fold-not-replace implementation summary and reconciled at finalization.
- The issue key is validated to an integer where it is written.

## Open edges

- **A Jira adapter** behind the issue tracker port — an HTTP client with a base URL and a token — is
  designed-for and built later; the port shape and the credential model already admit it.
- **Another code host** (a GitLab merge request, for example) is another adapter behind the code-host port,
  reached when wanted; the `provider`-carrying `PR` record already accommodates it.
- **Reading and writing issue comments** is left open — there is no comment entity now, and the design
  neither models nor forecloses it (`domain-model`).
- **Webhook-driven merge detection** is a later real-time refinement over the bounded poll.
