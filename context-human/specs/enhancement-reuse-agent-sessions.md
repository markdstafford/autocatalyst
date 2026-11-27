---
created: 2026-11-27
last_updated: 2026-11-27
status: draft
issue: 195
specced_by: autocatalyst
---
# Enhancement: Reuse agent sessions across revisions

## Parent feature

The [producing-step convergence loop](feature-producing-step-convergence-loop.md) dispatches separate production and review roles before a human gate. This enhancement extends [spec author convergence](enhancement-spec-author-convergence.md) and [PR integration and CI repair](feature-pr-integration-and-ci-repair.md). It uses the attempt-level usage and pricing from [#194](feature-cache-aware-session-cost.md).

## What

The spec author, spec reviewer, implementer, and implementation reviewer can each continue their own conversation when revising work in the same run and step. Codex and Claude support this across automatic rounds, human-requested revisions, and control-plane restarts. Automatic CI repair can continue the implementation conversations on the same PR. Each turn uses the current workspace, revision, and feedback. When history is unavailable or incompatible and it is safe to dispatch, the role starts fresh with a compact handoff. Publication review always starts fresh and checks the integrated candidate.

## Why

Prompt caching can lower input cost, but it does not stop agents from reopening files, reconstructing decisions, or rerunning checks. The #201 implementation retry recorded about 97% cached input and still took about 11 minutes. Measure whether continuing a conversation reduces repeated work, fresh input, and time to the same review gate without weakening validation or review. Separate that effect from the benefit of giving a fresh agent a better handoff.

## User stories

- Phoebe can request another spec or implementation revision and have each role act on the latest feedback without rediscovering the work from scratch.
- Opal can restart the control plane or let automatic CI repair run without losing compatible role history or making recovery depend on that history.
- Phoebe can trust that later reviewers recheck earlier findings against current work and that an independent publication reviewer checks the integrated candidate.
- Enzo can compare revision time, agent work, cost, and review quality against fresh dispatches, with separate records for failed attempts and fallbacks.

## Design changes

*(Added by design specs stage — frame as delta on the parent feature's design spec)*

No screens, controls, or approval gates change. Activity still shows a separate entry for each launched dispatch, whether fresh or resumed. Findings and dispositions remain the record of what reviewers raised and how authors responded. Missing history does not require a new human decision: a safe fresh start uses current inputs and a handoff. Authentication, policy, and execution failures follow existing handling. The publication reviewer never inherits implementation review history.

## Technical changes

### Affected files

*(Populated during tech specs stage — list files that will change and why)*

- `packages/core/src/{spec-convergence,layered-convergence-engine,reviewed-role-dispatcher,spec-authoring-context,implementation-build-context}.ts` — pass current revision, feedback, and trusted scope through reviewed convergence.
- `apps/control-plane/src/{reviewed-execution-dispatcher,server}.ts`, `packages/core/src/{execution-run-unit-of-work,execution-session-recorder,domain-repositories}.ts`, and `packages/execution/src/{agent-provider-adapter,agent-orchestrator-runner}.ts` — coordinate continuity claims, native dispatch, and attempt recording.
- `packages/persistence/src/{schema,domain-repositories}.ts`, `packages/persistence/drizzle/`, and `packages/execution/src/internal/workspace-{provisioner,teardown,pruner}.ts` — persist slots and workspace generations and attach private history to workspace reclamation.
- `packages/codex-agent-adapter/src/{codex-app-server,codex-agent-adapter,codex-usage}.ts` and `packages/claude-agent-adapter/src/{claude-agent-adapter,claude-usage}.ts` — start and resume native conversations, select the fresh launch path, and isolate current-turn evidence.
- `packages/core/src/{orchestrator,pr-repair-worker,pr-finalize}.ts` and `apps/control-plane/src/publication-git.ts` — bind repair inputs to the existing PR, pin fresh final review, and verify existing publication guards.
- `context-agent/wiki/code-map.md` and agent-owned runtime and telemetry notes — document internal entry points, supported configurations, cleanup, and verification evidence.

### Changes

*(Added by tech specs stage — frame as delta on the parent feature's tech spec)*

#### Scope and architecture

A **conversation** is provider-native history, not Autocatalyst's user-facing `Conversation` entity. A **dispatch attempt** is one runner invocation with its own Activity and Autocatalyst `Session`. A **slot** points to one reusable conversation for a tenant, run, step, and catalog role. Only reviewed convergence at `spec.author` (author, catalog role `implementer`; reviewer) and `implementation.build` (implementer; reviewer) can use a slot. Direct calls, ordinary one-shot steps, and other providers keep existing behavior. `pr.finalize` is explicitly fresh-only and never participates in continuity.

Convergence provides trusted work inputs. The reviewed execution dispatcher resolves route, policy, and workspace before selecting and claiming a slot. The adapter launches the native turn and returns current-attempt evidence through the runner. The dispatcher records the attempt and publishes a reusable slot only after the turn and result pass existing boundary checks. A preflight miss goes straight to fresh; a proven refusal before work starts retires the old slot before one fresh fallback.

No public API, approval gate, cross-provider import, cache guarantee, or general retry policy is in scope. The run branch, validated artifacts, and durable checkpoints remain authoritative for recovery. Follow [persistence](../adrs/adr-019-persistence-layout.md), [workspace isolation](../adrs/adr-020-workspace-isolation-primitive.md), [workspace reclamation](../adrs/adr-021-workspace-lifecycle-reclamation.md), [request policy](../adrs/adr-023-request-alteration-boundary.md), [role routing](../adrs/adr-024-role-aware-routing-key.md), and [convergence review](../adrs/adr-026-in-step-convergence-review.md).

#### Slots, compatibility, and ownership

Add an internal `agent_conversation_slots` table with a non-null primary key `(tenant, run_id, step, role)`, a run foreign key with deletion cleanup, repository tenant ownership checks, and a constraint limiting step and role to the four eligible combinations. Store the workspace generation, native storage-scope ID, compatibility digest, scope digest, optional canonical PR identity, optional opaque native handle, versioned adapter metadata, last completed attempt ID, claiming attempt ID, state, and integer compare-and-swap version. Use text for identity and digest fields and JSON for adapter metadata. A `ready` row requires a handle and completed attempt reference; an `in_flight` row requires a claim; a retired slot is not selectable. Any validated usage baseline belongs to the conversation it describes. Do not import old Session metadata, checkpoints, or scratch memory as handles, or put transcript contents in SQLite.

Add an opaque workspace generation and enrollment marker to `run_workspace_metadata`. Backfill existing rows as unenrolled with a new generation. On first verified open, under existing workspace ownership, check the run binding, branch and worktree, and ownership and containment of both repo and scratch roots. Record proof of both root instances in host-owned metadata outside agent grants. A newly enrolled workspace starts fresh and can reuse only history created after enrollment. Ordinary commits and gate transitions keep the generation. Reset, reclamation, rematerialization, or missing or mismatched proof after enrollment invalidates it, even at identical paths and branch. Fence old claims before admitting a replacement. Incomplete enrollment permits no retained dispatch.

Before resume, match the resolved provider, adapter and native runtime build, storage namespace, authenticated account or credential binding and revision, endpoint, model and inference settings, workspace instance and generation, and effective filesystem, network, approval, skill, and tool policy. Use host-verified values rather than display names, model output, or exposed credentials. Missing proof or a mismatch retires the handle so restoring old settings cannot revive it.

Compute the scope digest from the pinned workflow identity and revision, work item ID, deliverable identity, and revision of the stable role instructions and result contract. The deliverable is the bound canonical spec path or the implementation repository and run source ref. Retire history on a changed digest, missing or invalid required scope inputs, or a host-recorded `start_over`. Do not use text similarity or hash the changing artifact or commit. Ordinary revisions, round-number resets, and review altitude changes under the same role contract do not reset scope. **PR identity is a separate compatibility field, not a scope digest input.** The first verified PR binding changes this field from null to the canonical PR identity without changing the digest or retiring the slot.

Use existing dispatch ownership and compare-and-swap to claim the slot before a retained launch. Never run concurrent turns on one handle. Publish `ready` only after clean native completion, acceptance at the existing result boundary, durable attempt recording, and confirmation that the attempt still owns the claim and workspace generation. Superseded, canceled, and abandoned claims cannot publish or resume.

At selection, compare the slot's completed attempt with the latest durable dispatch for the **exact `(tenant, run_id, step, role)` slot key**, across occurrences. Record dispatch order under existing ownership so round counters and timestamps are not used as ordering proof. An intervening or unaccounted dispatch for that key, including a fresh dispatch that did not update the slot, makes the slot stale. If the latest attempt cannot be established, do not resume. `pr.finalize` dispatches never count toward any slot, and neither another step using the same catalog role nor the other role in this step can stale it. If continuity storage is unavailable, use the fresh path only when existing ownership and policy allow it. A failed slot save does not discard a valid result; existing recovery still decides whether further work may run.

#### Current turn and handoff

Keep base instructions and skill inputs stable while compatible. Append the authoritative workspace, step and role; current spec draft identity and path or content for spec work, or current commit and spec revision for implementation; current feedback and required disposition IDs; and this turn's task, review altitude, permitted work, and output contract. Use current structured capture or an attempt-unique scratch result location. Old prompts, permissions, outputs, and checks do not satisfy the current turn.

On later review rounds, pass durable earlier findings and dispositions and the last reviewed revision when available. Reviewers verify earlier findings against the current revision and inspect affected changes for regressions within the current review scope. If the prior revision is missing or cannot be compared, review the full scope required for this round. A disposition is evidence to check, not proof of a fix.

For every eligible fresh dispatch with prior work, including a fallback, build the same role-specific handoff from durable artifacts, checkpoints, and Git state, not a transcript. Build the required block first. Before sorting, rendering, or budgeting, exclude findings already supplied there by durable feedback ID and disposition evidence by feedback ID plus disposition record or revision. If only part of an entry is repeated, include only separately identified new evidence. Redact and label stale or unavailable evidence before budgeting.

| Optional block | Maximum per turn | Priority |
| --- | ---: | --- |
| Handoff | 8,192 UTF-8 bytes | Open prior findings and linked disposition evidence not already required; relevant files and revisions; decisions still in force; validation results with revisions. Within each group use current scope first, then newest evidence, then stable ID or path. |
| CI diagnostic excerpts | 4,096 UTF-8 bytes total | Sort failed required checks by name and stable ID. Render available failure summaries before log excerpts. In check order, render newest failure excerpts first within each check. |

Count headings, separators, and omission markers. On overflow reserve room for `[truncated]`, emit entries in priority order, and take only the fitting prefix of the first oversized entry without splitting a UTF-8 code point. The caps are independent. Do not duplicate CI excerpts in the handoff. Required review evidence, feedback and IDs, revision identities, failed check identities, and task instructions remain outside the optional caps under the parent contracts. Treat feedback, files, and diagnostics as data, not permission to change policy.

#### Native starts, resume, and fallback

- **Codex:** Use the pinned [App Server](https://learn.chatgpt.com/docs/app-server) transport. Use persistent `thread/start` for retained starts and capture the trusted `thread.id`. On `thread/resume`, verify the thread, account binding, provider/model, workspace, and sandbox before `turn/start`. Apply current sandbox and skill inputs and preserve sign-in, network controls, and MCP isolation. A separately rejected `thread/resume` before `turn/start` can prove no turn ran, but only a classified resume refusal allows fallback. Fresh-only calls use ephemeral threads and save no handle.
- **Claude retained:** Use the lockfile-resolved [Agent SDK](https://code.claude.com/docs/en/agent-sdk/sessions). Explicitly enable persistence inside the verified storage scope and capture the root `session_id` from trusted initialization. Resume with the SDK `resume` ID and current model, tools, skills, and permissions. Do not implicitly `continue`, fork, or use a subagent ID. Verify the root ID before accepting current events or output; a mismatch after launch is not proof that replay is safe.
- **Claude fresh-only:** For verified SDK launch paths, explicitly set `persistSession: false` and omit `resume` and `continue`, including when the options object would otherwise be empty. This covers unlisted retention configurations, failed retention confinement, fresh fallbacks that cannot retain, benchmark arm B, and `pr.finalize`. Verification that the SDK honors `persistSession: false` is separate from qualification to retain history. If non-persistence cannot be established before launch for an ordinary workflow dispatch, use the shipped fresh SDK path with unchanged auth, options, and tool policy, no resume inputs, no private continuity scope, and no captured or reusable handle. That compatibility path may write the incidental local history it writes today; it must not introduce new transcript writes or fail an otherwise valid dispatch solely for lack of the override. Do not retry a launched turn on this basis. Benchmark arm B does not use the shipped compatibility path: mark the arm blocked if non-persistence is unverified. Direct and other one-shot defaults do not change.

**Claude refusal evidence:** Before sending a prompt to a resumed `query`, use a read-only lookup validated against the pinned runtime to check the exact root session in the verified storage scope and project namespace under the slot claim. Missing or unverifiable history retires the handle and goes straight to fresh with the handoff. After launch, only a typed, version-verified rejection guaranteeing that the prompt was not accepted and no assistant or tool work ran permits fallback. Do not assume the pinned SDK provides such a signal. Error text, a missing init event, or silence does not prove it. If history disappears after lookup and no trusted proof exists, retire the slot, record the failure, and do not replay.

For either provider, allow at most one fresh fallback after launch, only for a positively classified unsupported, missing, expired, or stale session with proof that the prompt did not execute and no tools ran. Retire the old slot first. Use the same authoritative inputs and the normal handoff. A fresh start can establish new history only if it passes retention checks independently. Auth or policy failure, cancellation, result-validation failure, or possibly executed work does not trigger continuity fallback. Existing failure and recovery handling remains authoritative.

#### Transcript protection and release boundary

Use a default-empty, release-owned allowlist for retained starts and resumes. Match the exact adapter and native runtime build, host confinement configuration, and auth mode verified together. The production launcher checks the allowlist before enabling retention, then checks current binding and confinement on every launch. A missing or removed entry forces fresh; encountered old history is retired and remains subject to reclamation. Production does not accept test overrides. The allowlist prevents an upgrade or a different auth setup from silently inheriting permission to retain history.

Use a host-owned private directory in the managed run directory, alongside but outside `repo` and `scratch`, with a separate opaque subdirectory per retained conversation. This is execution metadata, not an agent workspace root. Verify that the native runtime writes all local transcript copies only inside the assigned scope, that history survives control-plane restart, and that tools and other roles, runs, tenants, and account bindings cannot access it. An environment change alone does not prove confinement. Do not copy credentials into the scope or change auth or tool policy to make resume work. This covers local transcripts, not provider-side API retention.

Before native persistence can write, record the scope owner, generation, and existing process-supervision identity in private on-disk metadata. Use the existing guarded run-directory pruner for deletion and restart recovery. The marker lets the lifecycle discover a scope even if the process died before returning a handle or the run row no longer exists. Retiring a slot prevents reuse immediately. Remove a private scope only after existing supervision confirms the recorded writer and descendants have exited and removal is confined to that owned scope. Enforce the same check before reset or recursive run-root deletion.

Unknown writers or pending removal block retained admission only for the affected run and generation. The execution-host operator uses existing supervision and reconciliation to recover: accept positive termination evidence tied to the recorded writer identity and descendant group, then verify absence of every scope pending removal before clearing the block. A missing PID, database row, path alias, or empty directory alone is not exit evidence. If exit or removal cannot be verified, keep the block; fresh dispatch still requires existing workspace ownership and policy. History lives no longer than workspace retention permits. If a deployment needs new custody infrastructure to meet these checks, leave it fresh-only and propose that work separately. No host-wide inventory, independent transcript retention clock, or new supervisor is in scope.

Test the core and scripted boundaries without credentials or a production allowlist entry. Verify at the SDK options boundary and with an isolated native fixture that the pinned Claude fresh path executes and writes no transcript, covering existing production launch paths before merging #195. Also verify that uncertain fresh-path capability preserves shipped dispatch behavior without enrolling history. Qualify retained configurations independently, but **do not merge #195 as complete or close it** until live native resume passes on at least one supported exact configuration for **each** of Codex and Claude, both passing entries are in the release allowlist, and the matched comparison below is complete. A qualified entry need not wait to be recorded until the other is ready. A failed or credential-blocked check keeps that configuration fresh-only and blocks completion if no configuration for that provider has passed. Record the blocker for the run owner and maintainers. Scripted transport tests or successful fresh dispatches do not substitute for live resume.

#### Automatic CI repair and final review

When automatic CI repair re-enters `implementation.build`, select the existing implementer and reviewer slots. Derive canonical PR identity from durable run binding and the authorized repair decision, including repository, PR identity, and verified source branch. On the first repair, if these records prove the same run, source branch, and deliverable as an otherwise compatible unbound slot, atomically set its PR identity from null to the verified identity when claiming it, before native resume. The slot retains its digest and handle. Later repair can resume only if its verified identity equals the stored identity; a new failed head of the same PR does not invalidate it. Reject resume and retire the old handle on a different or unverifiable binding. A fresh repair can establish a PR-bound slot only with a verified binding and existing repair authorization; fallback does not authorize a repair the parent workflow would stop.

Give both roles the current local commit, approved or frozen spec revision, failed PR head, failed required check identities, and available diagnostics. Keep local commit and failed head separate even when equal. Existing repair scope, ownership, budgets, and publication guards apply to both fresh and resumed turns.

Every initial publication, target refresh, and repair publication starts a different fresh, read-only `pr.finalize` conversation. It takes no slot or continuity handoff. Pin the integrated candidate commit and tree and target SHA; scope source and diff reads to that snapshot and bind the verdict to that candidate and attempt occurrence. Mutable refs and leftover scratch results are not evidence. Candidate or target drift invalidates the verdict under existing bounded refresh rules; a refresh starts another fresh review.

Keep the parent's freeze and attestation order. For initial spec-bearing publication, review the pinned integrated candidate. Only after a valid advance may the host apply the existing deterministic frontmatter freeze. Verify a no-op or the expected single child commit with only the spec path changed, unchanged file mode, and exact host-computed contents. Bind repository, refs and target SHA, reviewed SHA, and exact publishable SHA in the attestation. Other deltas or missing or stale attestation prevent publication. Repair does not freeze again: its reviewed candidate is its publishable candidate. [ADR-028](../adrs/adr-028-spec-amendable-through-implementation.md) does not change.

#### Attempt accounting and observability

Give each launched dispatch its own attempt ID, Activity, and durable `Session`, including a launched resume refusal and subsequent fresh dispatch. Record a preflight decision that did not launch on the fresh attempt, not as a synthetic model call. Record occurrence, role, round, elapsed time, tool calls, result, and available usage for successful, failed, and interrupted attempts. Deduplicate recorder writes by local attempt ID, not conversation ID. Record sanitized fresh, resume, fallback, retention-disallowed, and cleanup decision codes. Keep native IDs, private paths, account bindings, transcript contents, and raw diagnostics out of exposed Activity, logs, and metric labels.

Use #194's normalized evidence and read-time list pricing. For Codex, bind evidence to the acknowledged turn and use a proven delta from a validated pre-turn counter baseline or independent current-turn evidence; do not treat lifetime counters as a fresh-thread total. For Claude, use current-query request and message evidence, deduplicated by native identity, and include only provably linked child work. Accept aggregates only when scoped and non-overlapping under #194. Replayed tools, output, and structured results never enter current Activity, usage, or result capture. Keep fresh input, cache reads, cache writes where reported, and output disjoint. Report partial or unavailable coverage instead of substituting zeros, inferring current usage from lifetime totals, or guessing price.

#### Verification and comparison

- Unit-test the four slot keys, each compatibility dimension, claim fencing, and exact scope-reset rules. Cover compatible changes in commit and review altitude, missing scope inputs, `start_over`, and a newer dispatch for the exact key across occurrences, including a fresh dispatch with no slot save. Prove that a dispatch for another step with the same catalog role does not stale the slot.
- Exercise production wiring with durable SQLite, Git fixtures, and scripted native transports for both providers. Cover repeated spec and implementation rounds, a human revision at each gate, restart with an intact workspace, legacy enrollment, missing proof, replacement at the same paths, role and tenant/run/step/account isolation, and missing prior reviewed revision. Cover Codex pre-work refusal, Claude missing history with no resume query, a typed guaranteed refusal if the pinned SDK provides one, and ambiguous early or post-tool failure with no replay. Exercise duplicate callbacks, historical replay, and incomplete or cumulative usage.
- In fresh later-review and refused-resume fixtures, prove duplicate findings and dispositions are excluded before budgeting and do not crowd out lower-priority evidence. Test deterministic ordering, exact and over-limit byte counts, independent caps, and multibyte truncation.
- Check Claude fresh launch options for unlisted retention, failed confinement, fallback, benchmark arm B, and `pr.finalize`. The isolated native fixture sends a harmless prompt, proves it ran, and checks that neither scoped nor default history contains a new transcript on the verified non-persistent path. In an unverified-capability fixture, verify ordinary dispatch still runs once via the shipped fresh path without resume, slot, or new persistence behavior, and arm B is blocked. Verify unchanged direct and unrelated one-shot options. A matching retention entry cannot bypass failed confinement or apply to a different build, auth mode, or provider.
- Exercise guarded cleanup after retirement, abandonment before handle capture, workspace replacement, and run deletion or reclamation. On restart, retain the block while writer exit is unknown or any overdue scope remains. Clear it only after verified writer exit and removal of all overdue scopes. Assert no deletion outside the owned scope and no block on unrelated runs. Live qualification per provider proves harmless role-isolated recall across native process and control-plane restart, unchanged auth and tool policies, confined writes and no tool access to history, current-attempt accounting, and guarded removal. Record pass, fail, or not verified for the exact configuration.
- Seed both implementation slots before a PR exists, dispatch fresh `pr.finalize` review, then admit the first repair. Assert both original handles resume, both null PR bindings become the verified identity, and both scope digests remain unchanged. Repeat after a fresh final review with a different failed head on the same PR. Assert a true intervening dispatch for one implementation slot makes only that slot stale. Exercise different or unprovable PR bindings, fallback, and distinct local and failed commits. Verify fresh, candidate-bound final review on initial publication, refresh, and repair, plus rejection before freeze, expected freeze, unexpected post-review edits, drift, and missing attestation.

Compare three arms for each provider in representative multi-round spec and implementation cases:

| Arm | Conversation behavior | Prompt behavior |
| --- | --- | --- |
| A — continuity | Resume when eligible; normal safe fallback | Current-turn block and compact handoff on fresh starts with prior work |
| B — fresh with handoff | Skip slot lookup and save; always launch fresh with native non-persistence | Same current-turn block and handoff builder, priorities, and caps as A |
| C — shipped fresh baseline | Pin the pre-change revision and its shipped fresh behavior, including ephemeral Codex threads | Shipped prompts and revision context, not the new handoff |

A vs. B estimates the effect of continuity over a fresh handoff. A vs. C measures the total change. B vs. C estimates the combined prompt and handoff change. Do not simulate C by toggling B; #201 and PR #202 are historical context, not a matched baseline. Pin starting revisions, tasks, feedback, validation, route, account, model, inference settings, and rate revision. Repeat matched cases, rotate arm order, record warm/cold and cache conditions, and record optional-block byte counts without their contents. Keep observation comparable without changing C's prompts or policies.

Report actual fresh, resume, and fallback counts. For completion, arm A must demonstrate successful resume from the intended prior conversation in the matched spec and implementation cases for each provider. Retain fallback and non-arrival samples in the results; a provider or case with no verified reuse is blocked or incomplete, not a completed continuity comparison. A B-vs.-C result alone cannot complete the comparison. Report elapsed time per round and from first dispatch to the same gate, sample counts and non-arrivals, tool calls and repeated work, fresh input, cache reads and writes, output, and estimated API list cost with coverage. Compare validation, detected and missed findings, regressions, and disposition quality against the same case expectations. Explain sources of gains or losses and report quality regressions or unproven benefits without changing gates or treating cache hits as guaranteed.

#### Alternatives and risks

Fresh dispatch with a compact handoff is simpler and independent of native history, but can still repeat exploration. Keep it as the fallback and a comparison arm. Sharing a thread across roles would undermine review independence. Storing raw transcripts in SQLite would widen access without being needed for recovery. Native compaction, stale history, and variable cache availability can reduce savings; rely on current-turn inputs and measured outcomes, not presumed recall or cache hits.

## Task list

*(Added by task decomposition stage)*

- [ ] **Story: Continue compatible role conversations through revisions**
  - [ ] **Task: Persist slots and enroll workspace generations**
    - **Description**: Add the slot repository and migration; bind enrollment to verified repo and scratch instances.
    - **Acceptance criteria**:
      - [ ] Existing runs and Sessions survive migration without inferred handles. A verified legacy workspace starts fresh and can reuse a newly established slot after restart.
      - [ ] Missing proof, interrupted enrollment, and replacement at the same paths cannot resume old history.
    - **Dependencies**: None
  - [ ] **Task: Select history and fence claims**
    - **Description**: Resolve compatibility and scope before claiming history under existing dispatch ownership; compare durable attempts by exact slot key and fence completion and fallback.
    - **Acceptance criteria**:
      - [ ] Only the four eligible slots are used. Scope changes, invalid inputs, and explicit reset retire handles; ordinary revisions do not.
      - [ ] Concurrent, abandoned, superseded, or unaccounted dispatches cannot reuse or republish an old handle. A newer attempt across occurrences affects only its own slot; `pr.finalize` never counts.
      - [ ] Proven launched refusal triggers at most one fresh fallback; ambiguous execution does not.
    - **Dependencies**: Task: Persist slots and enroll workspace generations
  - [ ] **Task: Build authoritative turns and handoffs**
    - **Description**: Append current inputs to stable instructions and render bounded evidence from durable sources on fresh turns with prior work.
    - **Acceptance criteria**:
      - [ ] Fresh and resumed turns use the current revision, required feedback IDs, scope, and attempt-owned result capture. Later reviewers recheck prior findings and affected changes, or review the full current scope if comparison is unavailable.
      - [ ] Fresh and refusal-fallback fixtures prove deduplication before budgeting, deterministic ordering, independent caps, and safe UTF-8 truncation.
    - **Dependencies**: None
- [ ] **Story: Use native resume without adding shared transcript writes**
  - [ ] **Task: Guard retention with the workspace lifecycle**
    - **Description**: Check the release allowlist and runtime confinement before retained launches. Record private scope ownership and reuse existing writer supervision and guarded reclamation.
    - **Acceptance criteria**:
      - [ ] Unlisted configurations stay fresh-only, and a matching entry cannot bypass confinement or authorize another build, auth mode, or provider. Production does not accept test overrides.
      - [ ] Existing reconciliation discovers scopes created before handle capture. On restart or reclamation, it removes only owned scopes with confirmed writer and descendant exit. Unresolved custody blocks only retained admission for the affected run and generation.
    - **Dependencies**: Task: Persist slots and enroll workspace generations
  - [ ] **Task: Resume Codex threads**
    - **Description**: Add persistent start and explicit resume to the pinned App Server adapter, keeping fresh-only threads ephemeral.
    - **Acceptance criteria**:
      - [ ] Wire tests verify persistent start, validated resume before `turn/start`, classified pre-work refusal, and unchanged account and sandbox checks. Historical events never satisfy current result capture.
    - **Dependencies**: Task: Select history and fence claims; Task: Guard retention with the workspace lifecycle
  - [ ] **Task: Resume Claude root sessions**
    - **Description**: Add confined persistence and explicit root-session resume with a read-only scoped preflight.
    - **Acceptance criteria**:
      - [ ] Missing or unverifiable history dispatches fresh with the same handoff and no resume query. Only a verified pre-execution refusal can fall back after launch; ambiguous init failure, session mismatch, and post-tool failure do not replay.
    - **Dependencies**: Task: Select history and fence claims; Task: Guard retention with the workspace lifecycle
  - [ ] **Task: Preserve Claude fresh dispatch behavior**
    - **Description**: Apply the verified SDK non-persistence override on scoped fresh launches, with the shipped fresh compatibility path when it cannot be verified before dispatch.
    - **Acceptance criteria**:
      - [ ] SDK options tests cover all scoped fresh paths and unchanged direct and unrelated one-shot defaults. Before merge, an isolated native test proves the pinned non-persistent launch executes with no scoped or default transcript and no saved handle.
      - [ ] Without verified non-persistence, an otherwise valid workflow dispatch executes once with shipped fresh options, no resume inputs, and no slot or new persistence behavior. Arm B is blocked rather than using this compatibility path.
    - **Dependencies**: None
- [ ] **Story: Continue CI repair while keeping publication review independent**
  - [ ] **Task: Bind repair history to the existing PR**
    - **Description**: Validate the PR binding separately from the scope digest and pass separate local and failed commit evidence to both implementation roles.
    - **Acceptance criteria**:
      - [ ] After a fresh final review, first repair changes both compatible slots from unbound to PR-bound without changing their digests or handles. A later repair after fresh final review resumes the same PR's compatible slots at a new failed head.
      - [ ] A different or unverifiable PR prevents resume. Safe fresh and resumed repair carry both SHAs, spec revision, failed checks, and capped diagnostics and obey existing repair authorization.
    - **Dependencies**: Task: Select history and fence claims; Task: Build authoritative turns and handoffs
  - [ ] **Task: Pin each fresh final review**
    - **Description**: Review the pinned integrated candidate read-only in a fresh conversation and preserve freeze and attestation guards.
    - **Acceptance criteria**:
      - [ ] Initial, refresh, and repair attempts use distinct fresh conversations with no slot or handoff. Candidate or target drift invalidates the verdict.
      - [ ] Rejection does not freeze; the expected freeze attests the exact publishable SHA; unexpected deltas and missing attestation cannot publish; repair does not freeze again.
    - **Dependencies**: Task: Preserve Claude fresh dispatch behavior
- [ ] **Story: Verify attempt accounting and measure revision outcomes**
  - [ ] **Task: Record Activity and usage once per dispatch**
    - **Description**: Bind provider evidence and idempotent recorder writes to the current attempt, including launched refusals and fallbacks.
    - **Acceptance criteria**:
      - [ ] Historical output, tool events, and lifetime counters do not inflate use. Duplicate callbacks and interruption result in one record per attempt with honest coverage; preflight alone produces no model-call record.
    - **Dependencies**: Task: Resume Codex threads; Task: Resume Claude root sessions
  - [ ] **Task: Verify revised rounds through production wiring**
    - **Description**: Run the reviewed steps against durable SQLite, Git fixtures, and both scripted provider boundaries.
    - **Acceptance criteria**:
      - [ ] Repeated spec and implementation rounds, human revisions at both gates, restart, reset, isolation, stale history, safe and unsafe fallback, same-PR repair, and fresh final reviews pass the verification cases above.
    - **Dependencies**: Task: Record Activity and usage once per dispatch; Task: Build authoritative turns and handoffs; Task: Guard retention with the workspace lifecycle; Task: Bind repair history to the existing PR; Task: Pin each fresh final review
  - [ ] **Task: Qualify both native providers**
    - **Description**: Run opt-in live checks for each pinned runtime and record enablement evidence without requiring credentials in the default suite.
    - **Acceptance criteria**:
      - [ ] Live tests prove role-isolated recall across restart, unchanged auth and tool policy, confined writes and guarded removal, and current-attempt accounting. Only passing exact configurations enter the release allowlist.
      - [ ] At least one exact configuration per provider is qualified and allowlisted before the enhancement can merge as complete. A failed or credential-blocked check with no passing configuration for that provider blocks completion.
    - **Dependencies**: Task: Verify revised rounds through production wiring
  - [ ] **Task: Compare continuity against both fresh baselines**
    - **Description**: Run the matched A/B/C cases on both providers and record reproducible inputs and results in agent-owned notes. Update the code map and document safe configuration and reclamation checks.
    - **Acceptance criteria**:
      - [ ] Report A vs. B, A vs. C, and B vs. C separately, with actual resume counts, elapsed times, tool calls, usage and cost coverage, validation and review quality, sample counts, and non-arrivals.
      - [ ] The comparison cannot pass without verified arm A reuse in the matched spec and implementation cases on both providers. Report incomplete arms, confounders, and regressions without hiding fallback samples.
      - [ ] Agent notes locate the slot and adapter wiring and link to reproducible scripted, native, and comparison evidence.
    - **Dependencies**: Task: Qualify both native providers
