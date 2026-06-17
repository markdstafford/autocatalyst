---
created: 2026-06-17
last_updated: 2026-06-17
status: implementing
issue: 73
issue_url: [https://github.com/markdstafford/autocatalyst/issues/73](https://github.com/markdstafford/autocatalyst/issues/73)
specced_by: autocatalyst
---
# Feature: Review, open, and merge a pull request to complete a run

## Product requirements

### What

Autocatalyst should complete an approved implementation by running a final pull-request readiness and security review, freezing the shipped spec, opening a pull request, and ending the run when that pull request merges. The pull request is opened through a provider-neutral code-host port. The first adapter is GitHub, implemented behind that port with the shared safe `gh` execution helper.
The successful path is: `implementation.human_review` approval advances directly to `pr.finalize`; `pr.finalize` runs one `ai` reviewer pass over the final branch state; a clean result lets the orchestrator freeze the spec and advance to `pr.open`; `pr.open` pushes the run branch, opens the pull request, and records the run-parented `PR`; bounded merge detection observes the open pull request becoming merged and advances the run to `done`. If `pr.finalize` finds a material or user-visible blocker, the run follows the existing `revise` edge back to `implementation.human_review` for re-approval before it can finalize again.
### Why

A run currently can produce implementation work and reach human approval, but it does not own the last mile that turns approved work into a pull request and a terminal run. That leaves humans or external glue to push branches, open pull requests, choose titles, summarize the full change, notice merges, and close the run. Those steps are part of Autocatalyst's core promise: start from requested work, pass human gates, and finish when the change lands.
This feature also enforces the architectural boundary already described by the tracker concept. Agents must not push or create pull requests directly. The orchestrator owns run transitions, deterministic side effects, and merge detection, while provider adapters hide host-specific behavior behind a git-shaped code-host port.
### Goals

- Add a provider-neutral, git-shaped code-host port for creating, reading, deliberately finding by branch for recovery, updating, and merging pull requests. `findByBranch` intentionally extends the current documented tracker port shape because recovery after provider-side PR creation can lack a local PR number; the later docs pass must update `trackers.md` to include this operation.
- Implement a GitHub code-host adapter behind that port using `gh` through the shared `executeGh` helper.
- Keep repository target, branch, workspace, and credential handling explicit and safe. Tokens must never appear in logs, thrown errors, persisted failure reasons, or client-visible details.
- Implement `pr.finalize` as a single-pass reviewer step for pull-request readiness and security over the final branch state.
- Apply the spec freeze as a deterministic orchestrator side effect after a clean `pr.finalize` result and before `pr.open`.
- Implement `pr.open` as a deterministic system step that pushes the run branch, opens the pull request through the code-host port, and writes the one-per-run `PR` record.
- Derive the pull-request title through one shared conventional-commit title function based on run work kind.
- Produce and persist a run-owned cumulative implementation summary from `implementation.build` convergence rounds by folding each round's fix summaries, changed files, validation, and known follow-ups into one whole-change narrative instead of replacing it with the last round.
- Use that persisted cumulative implementation summary as the source for the pull-request body, and reconcile that summary during `pr.finalize` against the final branch state.
- Detect pull-request merge or close through a bounded read of the open `PR`, so a human merge on GitHub and any explicitly invoked Autocatalyst merge both update the `PR` record, merged PRs reach `done`, and closed-without-merge PRs fail visibly with a sanitized reason.
- Default the code-host `merge` operation to squash-and-delete, while B1 remains detection-primary and does not add an automatic workflow-triggered merge after `pr.human_review`.
- For the B1 path, remove the `docs.*` phase from feature, enhancement, bug, and chore workflows so approved implementation advances directly to `pr.finalize`.
- Prove the lifecycle with realistic end-to-end coverage that drives `pr.finalize`, opens a real or realistic `gh`-backed pull request, detects merge, and reaches `done` without injecting a fake `PR` or merge signal.
- Update `context-agent/wiki/code-map.md` during implementation for the code-host port, GitHub adapter, PR step handlers, merge detection, and shared title derivation.
### Non-goals

- Building the deferred `docs` phase between implementation and pull request. B1 skips `docs.*` in the workflows that produce implementation changes.
- Adding another code host such as GitLab. The port and `PR.provider` field should allow later adapters, but this feature implements GitHub only.
- Adding webhook-driven merge detection. This feature uses bounded polling or bounded reads.
- Adding a configurable non-squash merge strategy. The code-host `merge` operation's B1 default is squash-and-delete.
- Reading or writing issue comments, pull-request comments, or pull-request review comments.
- Treating pull-request comments as `Feedback`.
- Adding a rich interactive `pr.human_review` merge surface or automatic post-review merge trigger. Merge detection ending the run is in scope; a later human merge UI or explicit Autocatalyst merge control is not.
- Changing agents so they can push, open pull requests, or merge directly.
### Personas

- **Phoebe (PM)** wants an approved run to produce a clear pull request and finish when the change lands, without manual branch and PR bookkeeping.
- **Enzo (Engineer)** wants final review, title derivation, PR creation, and merge detection to live behind stable seams rather than scattered GitHub CLI calls.
- **Opal (Operator)** needs code-host credentials to resolve safely, merge behavior to be predictable, and external human merges to close the run automatically.
- **Riley (Reviewer)** wants `pr.finalize` to catch security and readiness blockers after implementation settles, before the branch is exposed as a pull request.
### User stories

- As Phoebe, I can approve an implementation and see Autocatalyst advance it to final PR review without a separate docs gate in B1.
- As Phoebe, I can receive a pull request whose title follows the project's conventional-commit convention and whose body summarizes the full run outcome.
- As Riley, I can rely on `pr.finalize` to review the final branch state for PR readiness and security before a pull request opens.
- As Riley, when final review finds a material blocker, the run returns to the implementation gate instead of opening a pull request.
- As Enzo, I can add another code host later by implementing the code-host port without changing orchestrator workflow semantics.
- As Enzo, I can test the pull-request lifecycle through a realistic `gh` execution path instead of injecting a prebuilt `PR` row.
- As Opal, if a person merges the pull request on GitHub, Autocatalyst detects the merge through bounded reads and marks the run `done`.
- As Opal, if an explicit Autocatalyst merge path is invoked through the code-host port, it uses squash-and-delete by default and the same merge-detection reconciliation updates the `PR` record consistently.
### Acceptance criteria

#### Code-host port

- The service defines a provider-neutral code-host port with operations equivalent to `create(workspace, branch, content) → PR`, `read(target, number) → PR`, `findByBranch(target, branch) → PR | null`, `update(workspace, pr, content)`, and `merge(workspace, pr)`.
- The port contract carries no GitHub-specific names, `gh` names, or provider-specific state beyond a generic provider identifier and target.
- `findByBranch` is a deliberate B1 extension beyond the older documented tracker port list of create/read/update/merge; it exists only because idempotent recovery may need a provider lookup before a local PR number exists, and `trackers.md` must be updated later to reflect the extended port.
- `create` pushes the given branch, opens the pull request, and returns a `PullRequest` value suitable for persistence.
- `read` is workspace-free and returns only provider status needed to update the run-parented `PR` record.
- `findByBranch` is workspace-free, provider-neutral, bounded to one target repository and exact head branch, and returns either the uniquely matching pull request facts including `open | merged | closed` state or `null` when no exact match exists; ambiguous matches fail safely with a sanitized code-host error rather than guessing.
- `update` updates an existing pull request's title/body through the same provider-neutral content shape.
- `merge` performs the configured merge strategy, with B1 defaulting to squash-and-delete.
- Production code that reaches a code host for pull-request create/read/find-by-branch/update/merge does so only through the port. A boundary test or equivalent source scan proves no other production path shells out to code-host commands for these behaviors.
#### GitHub code-host adapter

- A GitHub adapter implements the code-host port behind the generic provider boundary.
- The adapter uses the existing `executeGh` helper for every GitHub CLI invocation.
- The adapter passes the repository explicitly, such as `--repo owner/name`, so ambient working-directory state is not the repository selector.
- The adapter pushes the branch from the run workspace using a safe subprocess path that does not expose credentials.
- The adapter opens pull requests with a title, body, base branch, and head branch derived from the provider-neutral input.
- The adapter reads pull-request state and maps GitHub states to the shared `open | merged | closed` `PullRequest.state` vocabulary.
- The adapter merges with squash-and-delete by default.
- GitHub errors map to typed, sanitized code-host errors. Safe details may include provider, repository owner/name, branch, and pull-request number. They must not include tokens, raw `gh` stdout/stderr, full environment variables, or secret handles unless existing secret-handle policy explicitly allows them.
#### `pr.finalize`

- `pr.finalize` remains a single `waiting_on: ai` reviewer step in the run-step catalog.
- The reviewer sees the final branch state and the cumulative implementation summary.
- The reviewer checks pull-request readiness and security. This includes obvious credential leaks, unsafe generated files, missing final validation, misleading summaries, and changes that should not be exposed as a pull request.
- A clean reviewer result advances toward `pr.open`.
- A material or user-visible blocker produces `revise`, creates or updates first-class `Feedback` items targeted at `implementation`, and the existing workflow transition routes the run back to `implementation.human_review`.
- After a `revise`, the re-opened implementation gate shows those final-review `Feedback` items and follows the existing gate semantics: open implementation-target feedback must be dispositioned before approval can advance. Human re-approval returns the run through `pr.finalize`; it does not skip final review.
- Reviewer sessions obey the existing read-only reviewer tool policy. Providers that cannot enforce read-only access must fail safely or grant no file/git write access.
#### Spec freeze side effect

- After a clean `pr.finalize` result validates, the orchestrator writes shipped frontmatter to the artifact before `pr.open`.
- The freeze is deterministic host-side work, not another agent session and not a second `waiting_on` on `pr.finalize`.
- The freeze commits the final spec version on the run branch.
- If the freeze fails, the run does not open a pull request and is marked failed with a sanitized, stable reason according to existing run failure conventions.
- The frozen artifact remains the canonical shipped spec for the run.
#### `pr.open`

- `pr.open` is a deterministic system step handled by the orchestrator or a dedicated system-step handler.
- The step builds pull-request content from the persisted cumulative implementation summary reconciled at `pr.finalize`.
- The step derives a conventional-commit title from the run's work kind through one shared title derivation.
- If AI-assisted title generation exists and fails, the system falls back to the deterministic derived title rather than blocking PR creation; fallback subject selection and normalization follow the Conventional title acceptance criteria.
- The step pushes the run branch and opens the pull request through the code-host port.
- The step persists the run-parented `PR` record with provider, number, URL, branch, and `open` state.
- After the `PR` record is persisted, the system emits a run event that includes the safe pull-request URL, provider, number, and branch so a human or operator can retrieve the opened pull request through the existing run event stream.
- The existing one-per-run `pull_requests_one_per_run` constraint remains the authority that prevents duplicate pull-request records for a run.
- Re-dispatching `pr.open` after a partial failure is idempotent where practical: it must not create duplicate pull requests when an existing open `PR` record or provider pull request can be found safely.
- `pr.open` recovery follows this decision table:
	- If the local run already has an open `PR` record, read or update that pull request and do not create another.
	- If failure happened before branch push or provider PR creation was attempted, retry may proceed with normal create behavior because no provider PR side effect is known.
	- If branch push succeeded but provider PR creation was not attempted or did not start, `findByBranch` `null` means create is allowed; a unique open match is reused; a unique merged or closed match fails safely with `pull_request_recovery_pr_not_open`; an ambiguous match fails safely without guessing.
	- If provider PR creation returned success but local persistence failed, `findByBranch` `null` fails safely with `pull_request_recovery_missing_provider_match`; a unique open match is persisted or updated locally; a unique merged or closed match fails safely with `pull_request_recovery_pr_not_open`; an ambiguous match fails safely without guessing.
	- If provider PR creation was invoked but its outcome is unknown and local persistence is missing, `findByBranch` `null` fails safely with `pull_request_recovery_unknown_create_outcome`; a unique open match is persisted or updated locally; a unique merged or closed match fails safely with `pull_request_recovery_pr_not_open`; an ambiguous match fails safely without guessing.
#### Conventional title and cumulative summary

- A shared conventional-commit title derivation maps `feature` and `enhancement` to `feat`, `bug` to `fix`, and `chore` to `chore`.
- The shared derivation is the single home for pull-request title code and is suitable for commit and issue-title callers too.
- `file_issue` and `question` produce no pull request title.
- The deterministic fallback subject source order is `pr.finalize.titleSubject`, first non-empty sentence or heading from reconciled summary, first non-empty sentence or heading from cumulative summary, then `complete approved implementation`.
- Fallback subject normalization trims whitespace, strips Markdown heading/list markers and trailing punctuation, lowercases only the first ASCII letter when present, collapses internal whitespace, removes line breaks, and truncates to 72 characters without cutting a word when practical.
- Expected fallback examples include `feat: add project import` for feature/enhancement, `fix: handle expired tracker tokens` for bug, and `chore: refresh workspace cleanup` for chore.
- The PR body describes the complete change across all implementation rounds, not only the last round.
- The cumulative summary is sourced from a persisted fold-not-replace implementation result assembled during `implementation.build`, not from only the final convergence round.
- Each implementation convergence round contributes its fix summary, changed files, validation outcomes, and known follow-ups/non-goals to the folded summary; later rounds amend and append context but must not discard earlier accepted change narrative.
- The folded summary is held in a deterministic implementation checkpoint or equivalent run-owned persisted summary record that `pr.finalize` can load after process restart.
- `pr.finalize` reconciles the summary against the final branch state before `pr.open` consumes it, storing the reconciled summary in the `pr.finalize` checkpoint.
- The PR body includes enough run context for a human reviewer to understand the request, the issue link when present, validation performed, and known follow-ups or non-goals.
#### Merge detection and terminal run state

- The system performs a bounded read of open pull requests that runs are waiting on.
- If the provider reports a pull request merged, Autocatalyst updates the run-parented `PR` record to `merged` and advances the run to `done`.
- If the provider reports a pull request closed without merge, Autocatalyst updates the `PR` record to `closed`, marks the run failed using existing run failure conventions, and records a sanitized stable reason such as `pull_request_closed_without_merge`; it must not mark the run `done` or silently return to an earlier review gate.
- B1 is detection-primary: the normal successful path expects a person to merge on the code host, and no workflow transition automatically calls `codeHost.merge`. If an explicit Autocatalyst merge entry point exists or is added, that call must still end the run only through the same merge-detection path used for human merges.
- Merge detection is bounded by count and time so one tick or recovery pass cannot scan unbounded provider state.
- Merge detection does not depend on webhooks.
#### Workflow changes

- The B1 workflow tables for `feature`, `enhancement`, `bug`, and `chore` remove `docs.update` and, where present, `docs.human_review`.
- An approved implementation advances directly from `implementation.human_review` to `pr.finalize` for those work kinds.
- The `pr.finalize` `revise` edge remains `implementation.human_review`.
- The `docs.*` step catalog entries may remain defined for later work, but they are not in the B1 implementation workflows.
- Existing `file_issue` and `question` workflows do not gain pull-request behavior.
#### End-to-end proof

- A real end-to-end test or realistic integration test drives an approved implementation through `pr.finalize`, `pr.open`, merge detection, and `done`.
- The test uses the real code-host port and GitHub adapter path with a real or realistic `gh` executable.
- The test does not inject a prebuilt `PR` record.
- The test does not inject a merge signal directly into the orchestrator.
- The opened pull request has a conventional-commit title and a body sourced from the cumulative summary.
- A forced-blocker case proves `pr.finalize` routes `revise` back to `implementation.human_review` and does not open a pull request.
- Tests assert secrets are absent from thrown errors, client responses, logs captured by the test harness, and persisted failure reasons.
- `context-agent/wiki/code-map.md` is updated for the new port, adapter, handlers, merge detection, and title derivation.
### Product devil's advocate pass

- The feature could make too many assumptions about GitHub because GitHub is the first adapter. The port must keep provider-specific command details out of core and make GitHub only one implementation.
- `pr.finalize` can become a vague second implementation review if its scope is not constrained. It should review the settled branch for pull-request readiness and security, not re-run every build-review concern.
- Merge detection can become expensive if it scans all pull requests. It must start from the known run-parented `PR` records that are open and bounded.
- Removing the `docs.*` phase for B1 conflicts with some durable-doc refresh goals. This spec intentionally follows issue 73: the docs phase is deferred, not deleted from the catalog or future design.
- Idempotency for `pr.open` is risky because the side effect spans local git push, remote PR create, and local persistence. The implementation needs explicit recovery behavior rather than assuming every step either fully succeeds or fully fails.
### Product reviewer pass

The request is coherent and matches the referenced concepts and ADRs. The spec keeps agents out of code-host writes, preserves `pr.finalize` as the final AI reviewer pass, and treats the spec freeze as deterministic orchestrator work. The main product risk is user confusion when a pull request is closed without merge; this spec resolves that risk by requiring a visible failed-run outcome with a sanitized `pull_request_closed_without_merge` reason.
### References

- [Issue 73](https://github.com/markdstafford/autocatalyst/issues/73) — source request and acceptance criteria.
- [context-human/concepts/](../concepts/workflow.md)[workflow.md](../concepts/workflow.md) — pull-request phase, `pr.finalize`, spec freeze, and `revise` behavior.
- [context-human/concepts/](../concepts/trackers.md)[trackers.md](../concepts/trackers.md) — code-host port, `PR` record, bounded merge detection, cumulative final change, and conventional titles.
- [context-human/adrs/](../adrs/adr-025-workflow-step-catalog.md)[adr-025-workflow-step-catalog.md](../adrs/adr-025-workflow-step-catalog.md) — step catalog and `pr.finalize` / `pr.open` separation.
- [context-agent/standards/](../../context-agent/standards/commit-and-title-conventions.md)[commit-and-title-conventions.md](../../context-agent/standards/commit-and-title-conventions.md) — shared title convention.
- `packages/api-contract/src/pull-request.ts` — `PullRequest` and `CreatePullRequestInput` contracts.
- `packages/persistence/src/schema.ts` — `pull_requests` table and one-per-run unique index.
- `packages/core/src/domain-repositories.ts` — `PullRequestRepository` interface.
- `packages/core/src/run-workflows.ts` and `packages/core/src/run-step-catalog.ts` — current workflow tables and step definitions.
- `packages/github-issue-tracker-adapter/src/gh-exec.ts` — safe shared `gh` subprocess helper.
## Design spec

### Design scope

This feature has no end-user UI surface in B1. The design covers the run lifecycle experience, operator behavior, provider boundary, and failure states exposed through existing run reads, run events, and pull-request URLs. The visible outcome is that an approved run moves through `pr.finalize`, opens a pull request, waits for merge detection, and reaches `done`.
The design assumes the existing human gates remain the main control surface. Humans approve implementation at `implementation.human_review`. Humans can merge on GitHub directly. Autocatalyst observes that merge rather than requiring the merge to happen inside a new Autocatalyst UI.
### Successful run flow

1. A run reaches `implementation.human_review` after implementation build convergence.
2. A human approves the implementation through the existing reply path.
3. The workflow advances directly to `pr.finalize`.
4. A reviewer session inspects the final branch state and cumulative summary for security and pull-request readiness.
5. The reviewer returns a clean result.
6. The orchestrator freezes and commits the shipped spec.
7. The workflow advances to `pr.open`.
8. The system opens a pull request through the code-host port.
9. The workflow advances to `pr.human_review`, which B1 defines as the post-PR waiting step observed by merge detection rather than a rich in-product merge UI.
10. A bounded detection pass reads the provider state for that `PR`.
11. When the provider reports merged, Autocatalyst marks the `PR` merged and advances the run to `done`.
### Blocker flow

When `pr.finalize` finds a blocker, the run does not open a pull request. The reviewer result maps to `revise`, and the workflow table routes the run back to `implementation.human_review`. Each actionable blocker is also recorded as first-class `Feedback` targeted at `implementation`, not only as a string on the final-review checkpoint. The human sees the implementation gate again with those final-review feedback items, dispositions them through the existing feedback model, and cannot advance while implementation-target feedback remains open. After the change is re-approved, the run returns through `pr.finalize`.
This keeps final review authoritative without letting the AI reviewer silently mutate the approved implementation. It also keeps the human in control of material or user-visible changes found after implementation review.
### Pull-request content

The pull-request title follows one conventional-commit rule. The type is derived from work kind: `feature` and `enhancement` become `feat`, `bug` becomes `fix`, and `chore` remains `chore`. The subject should describe the cumulative change. If AI-assisted title generation is available, it can improve the subject, but the deterministic title is always available as fallback. The deterministic fallback subject source is, in order: the `pr.finalize` `titleSubject` checkpoint when present, the first non-empty sentence or heading of the reconciled cumulative summary, then the first non-empty sentence or heading of the cumulative implementation summary. Normalization trims whitespace, strips Markdown heading/list markers and trailing punctuation, lowercases only the first character when it is an ASCII letter, collapses internal whitespace, removes line breaks, and truncates to 72 characters without cutting a word when practical. If all sources are blank, the fallback subject is `complete approved implementation`. Expected examples are `feat: add project import` for feature/enhancement work, `fix: handle expired tracker tokens` for bug work, and `chore: refresh workspace cleanup` for chore work.
The pull-request body should summarize the whole run outcome. It should include:
- The problem or requested work.
- The main implementation changes across all rounds.
- The validation or tests the run completed.
- The linked issue, when the run has a tracked issue.
- Important non-goals or follow-ups.
- A note that Autocatalyst generated or managed the run, if the project convention expects it.
The body should not expose secrets, raw provider errors, hidden prompts, or internal scratch paths.
### Cumulative implementation summary experience

The cumulative implementation summary is a run-owned product artifact assembled before final review. It starts from the implementation build convergence history and folds each accepted round into one narrative of the whole change. The fold operation is append-and-reconcile, not replace: if round one added an import flow and round two fixed validation, the resulting summary describes both the import flow and the validation fix. It also carries changed-file highlights, validation performed, and known follow-ups or non-goals when the implementation result provides them.
Humans should not see a pull request body that only describes the last repair round. `pr.finalize` may correct or tighten the cumulative summary after inspecting the final branch state, but it consumes a persisted folded summary as input and stores a reconciled summary as output for `pr.open`. If no folded summary can be loaded, `pr.finalize` and `pr.open` must fail safely with a stable reason rather than inventing a thin last-round summary.
### State visibility

Existing run reads should show `currentStep` and `waitingOn` as they do today. A run in `pr.finalize` waits on `ai`. A run in `pr.open` waits on `system`, but this should usually be brief because auto-dispatch handles system steps. After a pull request opens, B1 advances to `pr.human_review`, which is the existing catalog step used as the merge-detection waiting step. The important external state is the persisted `PR` record and run not being terminal until the PR merges.
Run events should show transitions into `pr.finalize`, `pr.open`, and `done`. When `pr.open` persists the run-owned `PR` record, the next run event must include the safe pull-request URL, provider, number, and branch so Phoebe, Opal, or external automation can retrieve the opened pull request without direct database access. Closed-without-merge events should show the PR state update and failed run with the safe `pull_request_closed_without_merge` reason. Failure or revise events should use safe reasons. This spec does not require a new UI endpoint; if an existing run read response or pull-request read endpoint already exposes run-owned `PR` records, it must expose the same persisted PR URL consistently.
### Error and recovery experience

If final review fails because of a material blocker, the run returns to `implementation.human_review` with actionable feedback. If final review infrastructure fails, the run follows the existing failure behavior for AI/reviewer infrastructure errors. If spec freeze fails because of infrastructure, the run is marked failed with a stable safe reason rather than pausing or opening a PR from an unknown state.
If PR creation partially succeeds, recovery should prefer finding or using the existing provider pull request over creating a duplicate. The one-per-run repository constraint protects local duplicates, and the code-host port's deliberately added `findByBranch` operation provides provider-neutral recovery when local persistence is missing and no PR number is available for `read`. Recovery must preserve a safe local checkpoint of the furthest confirmed side effect so retries can distinguish "branch pushed, PR not attempted" from "provider PR creation succeeded but local persistence failed" and "provider PR creation outcome unknown." If `findByBranch` returns no exact match after only a confirmed branch push, create is allowed. If it returns no exact match after provider creation succeeded or may have succeeded, the run fails safely rather than creating a possible duplicate. A unique open match is reused or persisted locally. A unique merged or closed match fails safely with `pull_request_recovery_pr_not_open`. Ambiguous matches always fail safely without guessing and ask an operator to inspect provider state.
If the PR is closed without merge, the `PR` record should reflect `closed`. The run should not be marked `done`; B1 must mark the run failed through existing run failure conventions with a stable, sanitized `pull_request_closed_without_merge` reason and cover that route in tests.
### Operator and security experience

Operators configure code-host target and credentials through project settings and secret references. The adapter resolves secrets at use time. Logs and errors include only safe context such as provider, repository, branch, and pull-request number.
Reviewers at `pr.finalize` must be read-only. The final reviewer can inspect the workspace and branch state but cannot write files, commit, push, or call the code host. If a provider adapter cannot enforce read-only behavior for reviewer sessions, the system must fail safely or grant no file/git write access.
## Tech spec

### Current state

The domain already has a `PullRequest` contract in `packages/api-contract/src/pull-request.ts` with `provider`, `number`, `url`, `state`, and `branch`. Persistence already has a `pull_requests` table with a unique `pull_requests_one_per_run` index. Core already declares a `PullRequestRepository` with `create`, `findById`, and `findByRun`.
There is not currently a persisted cumulative implementation summary. The convergence engine's `workResult` carries an opaque result object, per-round disposition summaries live on step checkpoints, and persistence has `checkpointResultJson` per step rather than a run-level folded implementation narrative. This feature must add the producer and persistence path for that fold-not-replace summary; `pr.finalize` and `pr.open` must not silently fall back to the last convergence round.
The run-step catalog already includes `pr.finalize` as an `ai` reviewer step and `pr.open` as a `system` step. Current workflow tables include `docs.update` and `docs.human_review` before the PR phase for feature and enhancement workflows, and `docs.update` before PR for bug and chore workflows. The orchestrator currently handles only the `intake` system step; other system steps, including `pr.open`, throw an unimplemented system-handler error.
The GitHub issue tracker adapter package already contains `executeGh`, a safe helper that runs `gh` with a minimal environment and token via `GH_TOKEN`. That helper is usable by a GitHub code-host adapter, but its package name is issue-tracker-specific today. Implementation can either reuse the helper from that package or move it to a more neutral GitHub adapter package if doing so avoids an awkward dependency.
### Package placement

Core should own the provider-neutral code-host port and orchestration semantics. A likely placement is:
- `packages/core/src/code-host.ts` for port types, content types, target types, and typed safe errors.
- `packages/core/src/code-host-registry.ts` for provider lookup, mirroring the issue-tracker registry pattern.
- `packages/core/src/implementation-summary.ts` or similar for folding `implementation.build` convergence-round outputs into a persisted cumulative implementation summary.
- `packages/core/src/pr-content.ts` or similar for deterministic title/body content assembly if it depends on core run entities.
- `packages/core/src/conventional-title.ts` or similar for the shared work-kind-to-conventional-title derivation.
- `packages/core/src/pr-lifecycle.ts` or similar for merge-detection and PR-record update use cases.
The GitHub implementation should live outside core in an adapter package. Options:
1. Add `packages/github-code-host-adapter/` and keep PR-specific GitHub behavior there.
2. Rename or broaden `packages/github-issue-tracker-adapter/` into a general GitHub tracker/code-host adapter package.
3. Keep the existing package name for now and export the code-host adapter from it.
Option 1 is the cleanest long-term boundary because it avoids making code-host behavior appear issue-tracker-owned. If package churn is too high, option 3 is acceptable for B1 only if the code map clearly documents the temporary placement and core still depends only on the neutral port type.
### Code-host port contract

Define neutral types around git-shaped pull-request operations:
```typescript
interface CodeHostPort {
  create(input: CreateCodeHostPullRequestInput): Promise;
  read(input: ReadCodeHostPullRequestInput): Promise;
  findByBranch(input: FindCodeHostPullRequestByBranchInput): Promise;
  update(input: UpdateCodeHostPullRequestInput): Promise;
  merge(input: MergeCodeHostPullRequestInput): Promise;
}
```
The input shape should include:
- A resolved target with provider and repository owner/name or equivalent neutral repository coordinates.
- A workspace path for operations that need local git state (`create`, `update`, `merge` if required by provider implementation).
- A branch and base branch for `create`.
- An exact head branch and optional base branch for `findByBranch`.
- A title and body content object.
- A credential reference or resolved credential seam, following existing project secret patterns.
- Run ownership fields needed to build a `CreatePullRequestInput` without trusting adapter output for tenant/owner.
The port should return neutral provider facts: provider, number, URL, branch, and state. Core should compose those facts with run ownership before writing the `PullRequestRepository` record. `findByBranch` must not expose provider-specific query language to core; adapters are responsible for making the search repository-scoped and exact-branch, returning `null` for no exact match, returning the unique matching pull request with its mapped state, and raising a sanitized error for ambiguous matches.
### GitHub adapter details

The GitHub adapter should use `executeGh` for `gh pr create`, `gh pr view`, `gh pr list` or equivalent exact-branch lookup, `gh pr edit`, and `gh pr merge`. It should pass `--repo owner/name` on every PR command. It should pass tokens through `executeGh`, not through command arguments.
Opening a PR requires pushing the branch. The implementation should decide whether branch push belongs inside the GitHub adapter or in a core workspace git port called by `pr.open` before `codeHost.create`. The issue acceptance criteria describe `create(workspace, branch, content)` as pushing and opening, so B1 can include push inside the adapter. If so, the push should use a safe subprocess helper with argument arrays, bounded output, and redaction equivalent to `executeGh`.
The adapter should parse actual `gh` JSON output shapes. For `gh pr view`, request fields sufficient to map number, URL, state, merged status, head branch, and base branch. GitHub's closed-but-merged distinction must map to `merged` rather than `closed`.
### Workflow table changes

Update `packages/core/src/run-workflows.ts` so implementation workflows skip the docs phase in B1:
- `featureSteps`: `intake → spec.author → spec.human_review → implementation.plan → implementation.build → implementation.human_review → pr.finalize → pr.open → ... → done`.
- `enhancement` uses the same feature-like steps.
- `bugSteps`: `intake → spec.author → implementation.plan → implementation.build → implementation.human_review → pr.finalize → pr.open → ... → done`.
- `choreSteps`: `intake → implementation.plan → implementation.build → implementation.human_review → pr.finalize → pr.open → ... → done`.
Remove `docs.human_review` revise entries from active workflow transitions when that step is no longer in the active path. Keep `pr.finalize: { revise: 'implementation.human_review' }`.
The run-step catalog can keep `docs.update` and `docs.human_review` for later work. Tests should assert the B1 paths advance from `implementation.human_review` directly to `pr.finalize`.
### Cumulative implementation summary assembly

Add a deterministic summary assembly seam before `pr.finalize`. The implementation build convergence flow should fold the accepted convergence-round outputs into one cumulative summary when `implementation.build` reaches the approved implementation result. Inputs should include each round's implementer/fix summary, reviewer disposition summary, changed-file highlights when available, validation or tests reported, and known follow-ups/non-goals. The fold should preserve earlier accepted changes while allowing later rounds to amend stale details.
Persist the folded summary in a run-owned location that survives process restart and can be loaded by `pr.finalize` and `pr.open`. Acceptable B1 storage is a typed checkpoint result on the completed `implementation.build` step or a small run-owned summary repository/table if checkpoint shape is insufficient. The stored shape should include at least `cumulativeSummary`, `changedFiles`, `validationSummary`, `followUps`, `sourceRoundCount`, and timestamps or checkpoint IDs used for provenance.
The summary producer belongs to workflow/convergence orchestration, not to trackers and not to the code-host adapter. Missing or invalid cumulative summary data is a hard, sanitized lifecycle error for `pr.finalize`/`pr.open`; falling back to the last round's result is explicitly disallowed. Tests must include a multi-round convergence case where the final PR body mentions changes from earlier and later rounds.
### `pr.finalize` execution

The existing reviewed producing-step machinery currently treats `implementation.build` as the reviewed producing step. `pr.finalize` has only the `reviewer` role, so it should use the normal AI dispatch path with a reviewer-specific prompt and result contract, not the implementer/reviewer convergence engine.
Add a `pr.finalize` reviewer prompt builder in core, likely near `implementation-build-context.ts`. It should provide:
- Run metadata and work kind.
- The approved spec path and current artifact state.
- Persisted cumulative implementation summary, including source round count and validation/follow-up fields when available.
- Final branch/workspace context.
- The expected reviewer result schema.
- Explicit read-only and no-mutation instructions.
Register or reuse a reviewer result contract for `pr.finalize`. If the existing `reviewerResultSchema` is specific enough, register it for this step too. If PR finalization needs more structured content, add a small schema that includes status, findings, and an optional reconciled summary/title subject. A clean result should carry the reconciled cumulative summary that `pr.open` consumes, or the reconciled summary should be stored in a deterministic checkpoint on the `pr.finalize` step. A revise result must turn actionable findings into first-class `Feedback` records targeted at `implementation`; checkpoint findings are only audit/context and must not be the sole way humans learn what to fix.
### Spec freeze implementation

After `pr.finalize` returns a validated clean result and before applying `advance` into `pr.open`, the orchestrator should call a host-side finalizer. This finalizer should:
- Locate the run's spec artifact through existing artifact and workspace metadata seams.
- Render shipped frontmatter using the existing spec frontmatter utilities.
- Write the updated spec file.
- Commit the spec freeze on the run branch through the host-controlled workspace git port.
- Return safe checkpoint details such as artifact path, commit SHA if available, and timestamp.
This should be done before `applyDirective({ directive: 'advance' })` moves the run to `pr.open`. If freeze fails, do not advance and mark the run failed using existing run failure conventions. Map failures to stable safe reasons, such as `spec_freeze_failed`, and ensure secrets or raw git output do not leak.
### `pr.open` system handler

Replace the current unimplemented-system-step behavior for `pr.open` with a deterministic handler. The handler should:
1. Load the run, topic, conversation, project, workspace metadata, and any tracked issue.
2. Resolve the code-host target and credential reference from project settings.
3. Find any existing `PullRequest` for the run. If one exists and is open, do not create another; read or update it as needed.
4. Build PR content from the `pr.finalize` reconciled summary and shared conventional-title derivation.
5. Call `codeHost.create` for a missing PR.
6. Persist `PullRequestRepository.create` with run ownership and returned provider facts.
7. Emit a run event with the persisted pull-request URL, provider, number, and branch.
8. Apply `advance` according to the workflow transition.
The handler should record a safe local recovery checkpoint for each confirmed side-effect boundary. Recovery behavior is deterministic:

Failure or retry point
`findByBranch` result
Required outcome

Before branch push or before provider PR creation is attempted
Not required
Retry normal create path; no provider PR side effect is known.

After branch push, before provider PR creation is attempted or started
`null`
Create a new provider PR.

After branch push, before provider PR creation is attempted or started
Unique open match
Reuse or update that PR and persist it locally.

After branch push, before provider PR creation is attempted or started
Unique merged or closed match
Fail safely with `pull_request_recovery_pr_not_open`.

After branch push, before provider PR creation is attempted or started
Ambiguous match
Fail safely without guessing.

After provider PR creation returned success, before local persistence
`null`
Fail safely with `pull_request_recovery_missing_provider_match`; do not create another PR.

After provider PR creation returned success, before local persistence
Unique open match
Persist or update the local run-owned `PR` record.

After provider PR creation returned success, before local persistence
Unique merged or closed match
Fail safely with `pull_request_recovery_pr_not_open`.

After provider PR creation returned success, before local persistence
Ambiguous match
Fail safely without guessing.

After provider PR creation was invoked but outcome is unknown
`null`
Fail safely with `pull_request_recovery_unknown_create_outcome`; do not create another PR.

After provider PR creation was invoked but outcome is unknown
Unique open match
Persist or update the local run-owned `PR` record.

After provider PR creation was invoked but outcome is unknown
Unique merged or closed match
Fail safely with `pull_request_recovery_pr_not_open`.

After provider PR creation was invoked but outcome is unknown
Ambiguous match
Fail safely without guessing.

The workflow currently includes `pr.human_review` before `done`. B1 explicitly accepts repurposing `pr.human_review` as the waiting step after `pr.open` and defines its B1 behavior as "waiting for external pull-request merge detection" rather than an explicit in-product approval gate. This is a known temporary divergence from the usual reply-gate contract: `waitingOn: human` means a human is expected to review and merge on the code host, while bounded merge detection, not an in-product approval reply, advances the run to `done`. Tests and code-map documentation must make that clear; a future `pr.wait_for_merge` step would be cleaner but is out of B1 scope.
### Merge detection

Add a bounded use case that reads open `PR` records and asks the code-host port for current status. Placement can be core because it owns run transitions and `PR` records. The use case should accept a maximum count and timeout or be called per run to stay bounded.
For each open `PR`:
- Resolve project/code-host target from the run's conversation/project chain.
- Call `codeHost.read` with provider, target, and pull-request number.
- If state is `open`, leave the run unchanged.
- If state is `merged`, update the `PR` record to `merged` and advance the run to `done`.
- If state is `closed`, update the `PR` record to `closed`, mark the run failed through existing run failure conventions, and persist/report the stable sanitized reason `pull_request_closed_without_merge`.
`PullRequestRepository` needs update methods, such as `updateState(input)` or more specific `markMerged` / `markClosed`. Persistence tests should prove state updates preserve tenant/run ownership and timestamps.
Merge detection can be invoked from `tick`, auto-dispatch recovery, or a dedicated service method. It must not require webhooks. B1 does not add an automatic workflow-triggered call to `codeHost.merge`; the port operation is implemented for provider completeness, tests, and any separately invoked operator/service path. If such an explicit merge path exists, it should call provider merge with the default squash-and-delete options and then rely on the same status update/transition code rather than marking the run done directly.
### Title derivation

Create one shared function for conventional title type derivation and title formatting. It should be small, deterministic, and covered by unit tests:
- `feature` → `feat`
- `enhancement` → `feat`
- `bug` → `fix`
- `chore` → `chore`
Return no title type for `file_issue` and `question`. The code-host `pr.open` path should call this shared function. Existing issue-title and commit-title surfaces can adopt it now if practical, or the function can be placed where those later callers can use it without imports from adapter packages.
### Repository and persistence changes

Extend `PullRequestRepository` with state update behavior. The domain contract already has `PullRequestState`, so no API-contract state enum change is required unless the implementation needs additional provider metadata.
If idempotent `pr.open` needs to find a provider pull request by branch when local persistence is missing, it must call the provider-neutral `CodeHostPort.findByBranch` operation. Avoid schema changes unless a missing field blocks safe recovery.
### Tests

Recommended targeted coverage:
- Core unit tests for code-host registry/provider-neutral errors.
- GitHub adapter tests with a fake realistic `gh` executable for PR create/view/edit/merge output parsing and redaction.
- Boundary test that production PR code-host operations do not call `gh` outside the adapter/helper allowlist.
- Workflow tests proving `feature`, `enhancement`, `bug`, and `chore` advance from `implementation.human_review` to `pr.finalize` without `docs.*`.
- Orchestrator tests for `pr.finalize` clean result, blocker revise, spec freeze before `pr.open`, and freeze failure preventing PR open.
- Orchestrator or service tests for `pr.open` creating and persisting a `PR` record without duplicates.
- Persistence tests for `PullRequestRepository` state updates.
- Merge-detection tests for open/noop, merged/done, and closed-without-merge failed-run policy with the `pull_request_closed_without_merge` reason.
- End-to-end test with real or realistic `gh` covering final review, PR open, bounded merge detection, and `done`.
- Redaction tests covering token absence in errors, logs, client details, and failure reasons.
### Risks and open decisions

- **Adapter package placement:** A new GitHub code-host adapter package is cleaner, but reusing the existing GitHub issue-tracker adapter package is less churn. The important rule is that core depends on the neutral port, not provider details.
- **PR waiting step semantics:** The current `pr.human_review` step name suggests a human reply gate, while issue 73 wants bounded merge detection to end the run. B1 explicitly accepts `waitingOn: human` meaning "waiting for external code-host review/merge" and documents it as the post-PR merge-detection wait state so clients do not wait for the wrong in-product action.
- **Partial PR-open failure:** Pushing a branch, opening a PR, and writing the local record can fail between side effects. The implementation needs explicit idempotency and recovery tests.
- **Spec freeze source of truth:** The finalizer must use existing artifact/frontmatter utilities so it does not invent a second spec lifecycle.
- **Closed-without-merge policy:** The issue requires merged PRs to end the run and closed PRs to update the record. B1 makes the product decision to use a failed-run route with the stable sanitized reason `pull_request_closed_without_merge`; future work may add a richer reopen/retry UI.
- **Read-only reviewer enforcement:** Some provider adapters may not enforce file/git read-only behavior. Those providers remain unsupported for `pr.finalize` reviewer sessions unless they fail safely or grant no write access.
### Technical devil's advocate pass

- Reusing `executeGh` from an issue-tracker-named package can blur package ownership. If B1 reuses it, document the temporary placement and avoid importing provider-specific code into core.
- Treating `pr.human_review` as "waiting for external merge" could confuse UI and automation because `waitingOn` remains `human`. B1 documentation and tests must name this as the merge-detection waiting step; a clearer lifecycle may require a future `pr.wait_for_merge` step.
- The spec freeze and PR open must not be one large untestable method. Splitting content assembly, freeze, port call, persistence, and transition into small use cases will make partial failure coverage practical.
- The end-to-end test can become flaky if it depends on live GitHub. A deterministic fake-`gh` path should be the CI proof, with live tests opt-in.
### Technical reviewer pass

The design fits the existing architecture: core owns run state, adapters own provider details, and persistence already has the main `PR` entity. The lifecycle seam after `pr.open` is resolved for B1 by keeping `pr.human_review` as the merge-detection waiting step, not a rich in-product merge UI; implementation should update the code map with those semantics.
## Task list

### Stories

#### Story 1: Core code-host contracts and shared PR content

- T-001 — Define the provider-neutral code-host port, registry, and sanitized errors.
- T-002 — Extend pull-request persistence for state updates and open-PR reads.
- T-003 — Add cumulative implementation summary assembly plus shared conventional-title and pull-request content builders.
#### Story 2: GitHub code-host adapter

- T-004 — Add the GitHub code-host adapter package and safe execution seams.
- T-005 — Implement GitHub create, read, update, and merge operations.
- T-006 — Add provider-boundary protection for PR-related host commands.
#### Story 3: PR workflow and finalization

- T-007 — Update B1 workflows to skip the docs phase and wait for merge detection.
- T-008 — Implement the `pr.finalize` reviewer prompt, result parsing, and checkpoint.
- T-009 — Implement deterministic spec freeze before `pr.open`.
#### Story 4: PR opening system step

- T-010 — Implement the `pr.open` system handler with idempotent PR creation.
#### Story 5: Merge detection and terminal run state

- T-011 — Implement bounded PR status reconciliation and merge detection.
- T-012 — Implement closed-without-merge handling and default merge strategy coverage.
#### Story 6: End-to-end proof, security, and agent documentation

- T-013 — Add realistic end-to-end PR lifecycle coverage.
- T-014 — Prove redaction and read-only reviewer safety.
- T-015 — Update package exports, workspace wiring, and `context-agent/wiki/code-map.md`.
### Leaf tasks

#### T-001 — Define the provider-neutral code-host port, registry, and sanitized errors

**Description:** Add `packages/core/src/code-host.ts` and `packages/core/src/code-host-registry.ts` with provider-neutral pull-request operation types, including branch-based provider recovery. Include typed `CodeHostError` handling with explicitly safe details only.
**Acceptance criteria:**
- `CodeHostPort` exposes `create`, `read`, `findByBranch`, `update`, and `merge` with the input and result shapes defined in this spec.
- `CodeHostError` and `isCodeHostError` preserve stable error codes and safe details without exposing raw command output, environment values, tokens, or secret handles beyond approved secret-reference policy.
- `createCodeHostRegistry` registers provider factories, rejects duplicate providers, and returns `unsupported_provider` for unknown providers.
- Unit tests cover registry lookup, duplicate registration, unsupported provider errors, branch-lookup error codes, and safe error details.
**Dependencies:** none.
#### T-002 — Extend pull-request persistence for state updates and open-PR reads

**Description:** Extend the core `PullRequestRepository` contract and persistence implementation so merge detection can update a run-owned PR and enumerate bounded open PRs. Preserve the existing one-PR-per-run uniqueness rule.
**Acceptance criteria:**
- `PullRequestRepository.updateState(input)` is available and enforces tenant/run ownership when updating state.
- The persistence layer can find open PR records needed by bounded merge detection without scanning unbounded provider state.
- State updates preserve existing provider, number, URL, branch, run ownership, and timestamp behavior.
- Persistence tests cover merged, closed, missing-record, ownership-mismatch, and optional expected-state mismatch cases.
**Dependencies:** none.
#### T-003 — Add cumulative implementation summary assembly plus shared conventional-title and pull-request content builders

**Description:** Add `packages/core/src/implementation-summary.ts`, `packages/core/src/conventional-title.ts`, and `packages/core/src/pr-content.ts` so the workflow produces a persisted fold-not-replace implementation summary and PR title/body generation is deterministic and reusable. Use the cumulative or reconciled implementation summary as the body source.
**Acceptance criteria:**
- `buildCumulativeImplementationSummary` or equivalent folds all `implementation.build` convergence rounds into one whole-change summary, preserving earlier accepted changes while incorporating later fixes, changed files, validation, follow-ups, and non-goals.
- The folded summary is persisted in a typed `implementation.build` checkpoint or equivalent run-owned store and can be loaded after restart by `pr.finalize` and `pr.open`.
- Tests cover a multi-round implementation where the final cumulative summary and PR body include both early-round changes and later-round fixes, proving fold-not-replace behavior.
- Missing folded summary data causes a sanitized lifecycle failure and never falls back to only the final round.
- `getConventionalTitleType` maps `feature` and `enhancement` to `feat`, `bug` to `fix`, `chore` to `chore`, and returns `null` for `file_issue` and `question`.
- `formatConventionalTitle` normalizes a conventional title and rejects blank type or subject input.
- `deriveConventionalTitle` returns a deterministic title when the work kind supports PRs and returns `null` for non-PR work kinds. Its fallback subject source order is `titleSubject`, first non-empty sentence or heading from reconciled summary, first non-empty sentence or heading from cumulative summary, then `complete approved implementation`; expected examples are `feat: add project import`, `fix: handle expired tracker tokens`, and `chore: refresh workspace cleanup`.
- `buildPullRequestContent` includes run context, cumulative or reconciled summary, issue URL when present, validation summary, follow-ups, and non-goals without leaking internal scratch paths or hidden prompts.
- Unit tests cover all work-kind mappings, formatting edge cases, fallback source ordering, 72-character word-boundary truncation, unsupported work kinds, and required-summary validation.
**Dependencies:** T-001.
#### T-004 — Add the GitHub code-host adapter package and safe execution seams

**Description:** Add `packages/github-code-host-adapter/` with package metadata, source entry point, test setup, and the adapter factory for the provider-neutral code-host port. Wire it to use the shared `ExecuteGhFunction` and an injected `SafeGitExecutor` rather than shelling out directly from core.
**Acceptance criteria:**
- The package exports `GitHubCodeHostAdapter`, `createGitHubCodeHostAdapter`, `GitHubCodeHostAdapterOptions`, and `SafeGitExecutor`.
- The adapter depends on the neutral `CodeHostPort` contract from core and does not make core import GitHub-specific implementation code.
- The package uses the existing shared `executeGh` type or helper for GitHub CLI calls.
- Branch push uses an injected safe git executor with argument arrays, bounded output, timeout support, and redaction-ready errors.
- Package build and test configuration follows existing monorepo conventions.
**Dependencies:** T-001.
#### T-005 — Implement GitHub create, read, find-by-branch, update, and merge operations

**Description:** Implement the GitHub adapter operations using `gh pr create`, `gh pr view`, `gh pr list` or equivalent exact-branch lookup, `gh pr edit`, and `gh pr merge`, with `--repo owner/name` on every PR command. Map GitHub states into the shared `open | merged | closed` vocabulary and sanitize all failures.
**Acceptance criteria:**
- `create` pushes the run branch from the provided workspace, opens a PR with title, body, base branch, and head branch, and returns provider-neutral PR facts.
- `read` is workspace-free and requests only the provider fields needed to map PR status, URL, number, branch, and merged-vs-closed state.
- `findByBranch` is workspace-free, repository-scoped, exact-head-branch matching, returns `null` for no match, returns the unique matching PR with mapped state when exactly one match exists, and fails safely on ambiguous matches.
- `update` changes title and body through provider-neutral content.
- `merge` defaults to squash with branch deletion and rejects unsupported merge strategies with a sanitized `CodeHostError`.
- Tests use a realistic fake `gh` executable or injected `executeGh` implementation to cover create, read-open, read-merged, read-closed, find-by-branch no match, find-by-branch unique match, find-by-branch ambiguous match, update, merge, malformed JSON, command failure, explicit repo selection, and token redaction.
**Dependencies:** T-004.
#### T-006 — Add provider-boundary protection for PR-related host commands

**Description:** Add a boundary test or source scan that proves production PR create/read/find-by-branch/update/merge behavior reaches GitHub only through the code-host adapter and shared execution seams. Keep agents and core orchestration out of direct code-host write operations.
**Acceptance criteria:**
- The boundary check allows `gh` usage only in the approved GitHub adapter and shared helper locations.
- Production core code does not shell out to `gh` for PR create, read, find-by-branch, update, or merge.
- The check fails if a new production path adds direct `gh pr` calls outside the allowlist.
- The allowlist is documented in the test so future adapters can extend it intentionally.
**Dependencies:** T-005.
#### T-007 — Update B1 workflows to skip the docs phase and wait for merge detection

**Description:** Update `packages/core/src/run-workflows.ts` and confirm `packages/core/src/run-step-catalog.ts` semantics so feature, enhancement, bug, and chore implementation approval advances directly to `pr.finalize`. Keep `docs.*` catalog entries available for later work and use `pr.human_review` as the B1 merge-detection waiting step after `pr.open`.
**Acceptance criteria:**
- Feature, enhancement, bug, and chore workflows no longer include `docs.update` or `docs.human_review` in their active B1 paths.
- `implementation.human_review` approval advances to `pr.finalize` for PR-producing work kinds.
- `pr.finalize` `revise` returns to `implementation.human_review`.
- `pr.open` advances to `pr.human_review`, documented as the B1 merge-detection waiting step rather than a rich in-product merge UI.
- `file_issue` and `question` workflows do not gain pull-request behavior.
- Workflow tests cover feature, enhancement, bug, chore, file issue, and question paths.
**Dependencies:** none.
#### T-008 — Implement the `pr.finalize` reviewer prompt, result parsing, and checkpoint

**Description:** Add `packages/core/src/pr-finalize.ts` with prompt building, result parsing, and completion handling for the `pr.finalize` reviewer pass. The reviewer must see final branch context and cumulative summary, return clean or revise, and provide reconciled summary details for `pr.open`.
**Acceptance criteria:**
- `buildPullRequestFinalizePrompt` includes run metadata, work kind, spec artifact path, workspace path, branch, cumulative summary, result contract, and explicit read-only/no-mutation instructions.
- `parsePullRequestFinalizeResult` validates clean and revise results and extracts findings, reconciled summary, title subject, and validation summary where present.
- Clean results produce an `advance` directive toward `pr.open`; revise results produce a `revise` directive toward `implementation.human_review`.
- After revise, existing workflow behavior requires human re-approval before returning through `pr.finalize`.
- Tests cover clean, revise, blocker-to-implementation-Feedback creation, invalid result shape, missing cumulative summary, and prompt content needed for pull-request readiness and security review.
**Dependencies:** T-003, T-007.
#### T-009 — Implement deterministic spec freeze before `pr.open`

**Description:** Add `packages/core/src/spec-freeze.ts` and integrate it into `handlePullRequestFinalizeCompletion` so a clean `pr.finalize` result freezes the shipped spec before workflow advancement to `pr.open`. The freeze must be deterministic host-side work and must not run another agent session.
**Acceptance criteria:**
- `freezeRunSpecForPullRequest` locates the run spec artifact, updates shipped frontmatter through existing spec-frontmatter utilities, writes the artifact, and commits the freeze on the run branch through the host-controlled workspace git port.
- `handlePullRequestFinalizeCompletion` calls the freeze only for clean results and before applying or returning the advance directive to `pr.open`.
- Freeze failures prevent advancement to `pr.open`, mark the run failed through existing run failure conventions, and surface only sanitized, stable failure reasons.
- The freeze result records safe checkpoint details such as artifact path, shipped timestamp, and commit SHA when available.
- Tests cover successful freeze ordering, freeze failure blocking PR open, no freeze on revise, frontmatter rendering, and sanitized git/file errors.
**Dependencies:** T-008.
#### T-010 — Implement the `pr.open` system handler with idempotent PR creation

**Description:** Add `packages/core/src/pr-open-handler.ts` and wire `pr.open` into the orchestrator's system-step dispatch path. The handler resolves run context, code-host configuration, credentials, workspace metadata, tracked issue context, PR content, provider PR creation, persistence, and workflow advancement.
**Acceptance criteria:**
- Dispatching `pr.open` no longer throws the unimplemented system-handler error.
- The handler resolves the configured code-host provider, target repository, base branch, credentials, run workspace, run branch, issue URL, and `pr.finalize` checkpoint.
- If a run already has an open local `PR` record, re-dispatch does not create a duplicate provider PR.
- If local persistence is missing, recovery calls the deliberately extended `CodeHostPort.findByBranch`; when it returns a unique open PR, recovery uses or updates that PR rather than creating a duplicate, and when it returns `null`, a unique merged or closed PR, or an ambiguous-match error, the handler follows the specified recovery decision table without guessing.
- New PR creation calls `CodeHostPort.create`, persists the run-owned `PR` record, and advances to `pr.human_review`.
- New or recovered PR persistence emits a run event containing the safe PR URL, provider, number, and branch before or with the transition to `pr.human_review`.
- Tests cover new PR creation, existing local PR idempotency, safe provider recovery, partial failure, missing configuration, missing credentials, unsupported provider, and sanitized logging.
**Dependencies:** T-001, T-002, T-003, T-007, T-009.
#### T-011 — Implement bounded PR status reconciliation and merge detection

**Description:** Add `packages/core/src/pr-lifecycle.ts` with bounded merge detection that starts from open run-owned `PR` records while runs wait at `pr.human_review`. It should read provider status through the code-host port, update local PR state, and advance merged runs to `done`.
**Acceptance criteria:**
- `detectPullRequestMerges` accepts maximum count and timeout bounds and stops scanning when either bound is reached.
- Provider reads use `CodeHostPort.read` and never scan provider-global pull requests.
- Open provider status leaves the run and PR unchanged.
- Merged provider status updates the local `PR` record to `merged` and advances the owning run to `done`.
- A merge performed by a person on GitHub and any separately invoked Autocatalyst merge call both flow through the same reconciliation path; B1 does not add an automatic workflow-triggered merge.
- Tests cover open/noop, merged/done, bounded count, timeout, provider read failure continuing where safe, missing configuration, and transition failure handling.
**Dependencies:** T-001, T-002, T-007, T-010.
#### T-012 — Implement closed-without-merge handling and default merge strategy coverage

**Description:** Implement the B1 closed-without-merge policy using the `PullRequestStatusReconciliationInput.closedWithoutMergePolicy: 'fail_run'` seam. Cover the default squash-and-delete merge behavior exposed by the code-host port even if B1 has no rich in-product merge UI.
**Acceptance criteria:**
- Closed provider status updates the local `PR` record to `closed` and does not mark the run `done`.
- The closed-without-merge policy is implemented, tested, and visible as a safe run failure with the stable sanitized reason `pull_request_closed_without_merge`.
- `MergeCodeHostPullRequestInput` defaults to the squash-and-delete strategy when no strategy is supplied, but no B1 workflow transition automatically invokes it.
- Unsupported merge strategies fail with sanitized code-host errors.
- Tests cover the failed-run closed-without-merge route, default merge options sent to the GitHub adapter, and unsupported strategy handling.
**Dependencies:** T-005, T-011.
#### T-013 — Add realistic end-to-end PR lifecycle coverage

**Description:** Add an end-to-end or realistic integration test that drives an approved implementation through `pr.finalize`, spec freeze, `pr.open`, provider-backed PR creation, bounded merge detection, and `done`. Use the real code-host port and GitHub adapter path with a real or realistic fake `gh`; do not inject a prebuilt PR row or direct merge signal.
**Acceptance criteria:**
- The test starts from an implementation-approved run and advances to `pr.finalize`.
- A clean final-review result freezes the spec before `pr.open`.
- `pr.open` creates the PR through the code-host port and GitHub adapter path, then persists the run-owned PR record.
- Merge detection reads provider status through the adapter path and advances the run to `done`.
- The opened PR has a conventional-commit title and a body sourced from the folded cumulative summary or `pr.finalize` reconciled summary, not only the final implementation round.
- A forced-blocker case proves `pr.finalize` routes revise back to `implementation.human_review` and does not open a PR.
**Dependencies:** T-005, T-009, T-010, T-011.
#### T-014 — Prove redaction and read-only reviewer safety

**Description:** Add security-focused tests for secret redaction across code-host failures, run failure reasons, logs, and client-visible details. Also prove `pr.finalize` reviewer sessions obey the read-only reviewer tool policy or fail safely when a provider cannot enforce read-only behavior.
**Acceptance criteria:**
- Tests assert tokens and secret values are absent from thrown errors, safe details, logs captured by the test harness, persisted failure reasons, and client-facing responses.
- Raw `gh` stdout/stderr and full environment dumps are not exposed by adapter or handler failures.
- `pr.finalize` reviewer dispatch receives read-only/no-mutation tool policy instructions.
- Providers or runner configurations that cannot enforce read-only access fail safely or grant no file/git write access.
- The test suite covers obvious credential leak findings and unsafe generated-file findings from final review.
**Dependencies:** T-005, T-008, T-009, T-010.
#### T-015 — Update package exports, workspace wiring, and `context-agent/wiki/code-map.md`

**Description:** Export the new modules from the relevant package entry points, add monorepo workspace/build wiring for the GitHub adapter package, and update the agent code map for the new port, adapter, handlers, merge detection, title derivation, and B1 `pr.human_review` semantics.
**Acceptance criteria:**
- Core exports the new code-host, registry, implementation-summary, conventional-title, PR content, PR finalize, spec freeze, PR open, and PR lifecycle modules where existing package conventions require public exports.
- The GitHub adapter package participates in workspace install, build, lint, and test commands according to existing project conventions.
- `context-agent/wiki/code-map.md` documents the new code-host port, GitHub adapter, implementation-summary assembly, PR system handler, spec-freeze integration, merge-detection use cases, shared title derivation, and pull-request persistence updates.
- The code map notes that B1 uses `pr.human_review` as the merge-detection waiting step, not as a rich in-product merge UI.
**Dependencies:** T-001, T-003, T-004, T-008, T-009, T-010, T-011.
### Dependency graph

- Critical path: T-003 → T-008 → T-009 → T-010 → T-011 → T-013, with T-001 needed before PR content can call the code-host port and before T-010.
- Adapter path: T-001 → T-004 → T-005 → T-006.
- Persistence path: T-002 → T-010 → T-011.
- Workflow path: T-007 → T-008 → T-010 → T-011.
- Security and policy path: T-005 + T-008 + T-009 + T-010 → T-014.
- Documentation and package wiring: T-015 depends on the modules it documents and exports.
- Parallel work: T-002 and T-007 can start immediately. T-003 can proceed alongside adapter work. T-004 starts after T-001.
### Reviewer pass

- Coverage check: The tasks cover the cumulative implementation summary producer, code-host port, GitHub adapter, sanitized errors, safe branch push, `pr.finalize`, deterministic spec freeze, `pr.open`, conventional title/body generation, B1 workflow changes, merge detection, closed-without-merge behavior, end-to-end proof, redaction, and code-map updates from the requirements and tech spec.
- Acceptance check: Each leaf task has observable acceptance criteria tied to tests, exported APIs, workflow behavior, persistence behavior, or documentation updates.
- Dependency check: The graph keeps neutral core contracts ahead of adapter and handler work, keeps workflow/finalize/freeze sequencing explicit, and prevents the end-to-end proof from starting before the lifecycle pieces exist.
- Sizing check: The tasks are larger than trivial file edits but small enough to review by subsystem. The only broad task is T-013 because it intentionally proves the full lifecycle through realistic integration coverage.