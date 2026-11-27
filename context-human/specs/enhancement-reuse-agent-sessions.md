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

Autocatalyst lets the spec author, spec reviewer, implementer, and implementation reviewer each continue their own conversation when revising work in the same run and step. This works in Codex and Claude across automatic rounds, human-requested revisions, and control-plane restarts. Automatic CI repair can continue the implementation conversations on the same PR. The current workspace, revision, and feedback take precedence over remembered context. If Autocatalyst cannot safely continue a conversation, the agent starts fresh with a short handoff. Publication review always starts fresh and is bound to the exact candidate under the existing freeze and attestation rules.

## Why

Prompt caching can make repeated input cheaper, but it does not stop agents from opening the same files, reconstructing decisions, or repeating checks. The #201 implementation retry recorded about 97% cached input and still took about 11 minutes. Continuing a conversation should reduce repeated work, fresh input, and time to the same review gate without weakening validation or review. Measure the effect separately from the new handoff and prompt structure rather than assuming that a resumed turn gets a cache hit.

## User stories

- Phoebe can request another spec or implementation revision and have each agent act on the latest feedback without rediscovering the work from scratch.
- Opal can restart the control plane or let automatic CI repair run and have each eligible role pick up compatible history without depending on that history for run recovery.
- Phoebe can trust that later reviewers check earlier findings against current work and that an independent publication reviewer checks the integrated candidate.
- Enzo can compare revision time, agent work, usage, and review quality against fresh dispatches, with separate records for failed attempts and fallbacks.

## Design changes

*(Added by design specs stage — frame as delta on the parent feature's design spec)*

No screens, controls, or approval gates change. Each actual dispatch still appears separately in Activity, even when it continues a conversation. Findings and dispositions remain the record of what was raised and resolved. Losing history does not add a human prompt: the role starts fresh with the same current-turn requirements. Authentication, policy, and execution failures still follow their existing handling. The publication reviewer never relies on the implementation reviewer's conversation.

## Technical changes

### Affected files

*(Populated during tech specs stage — list files that will change and why)*

- `packages/core/src/{spec-convergence,layered-convergence-engine,reviewed-role-dispatcher,spec-authoring-context,implementation-build-context}.ts` — pass trusted revision, findings, and scope through reviewed convergence.
- `apps/control-plane/src/{reviewed-execution-dispatcher,server}.ts`, `packages/core/src/{execution-run-unit-of-work,execution-session-recorder,domain-repositories}.ts`, and `packages/execution/src/{agent-provider-adapter,agent-orchestrator-runner}.ts` — coordinate conversation claims, native dispatch, and attempt recording.
- `packages/persistence/src/{schema,domain-repositories}.ts`, `packages/persistence/drizzle/`, and workspace provisioning, recovery, and reclamation wiring — add slots, workspace identity, and durable transcript cleanup.
- `packages/codex-agent-adapter/src/{codex-app-server,codex-agent-adapter,codex-usage}.ts` and `packages/claude-agent-adapter/src/{claude-agent-adapter,claude-usage}.ts` — add native start and resume, isolate transcript storage, and record only current-attempt events and usage.
- `packages/core/src/{orchestrator,pr-repair-worker,pr-finalize}.ts` and publication integration tests around `apps/control-plane/src/publication-git.ts` — bind repair to the existing PR, pass the pinned candidate to a fresh final reviewer, and verify the existing publication guards. Neither `spec-freeze.ts` nor `spec-approval-finalizer.ts` changes for this enhancement.
- `context-agent/wiki/code-map.md` and agent-owned runtime and telemetry notes — document the new wiring, schema, cleanup, troubleshooting, and comparison evidence.

### Changes

*(Added by tech specs stage — frame as delta on the parent feature's tech spec)*

#### Scope and boundaries

A **conversation** is provider-native history, not Autocatalyst's user-facing `Conversation` entity. A **dispatch attempt** is one runner invocation with its own Activity and durable Autocatalyst `Session`. Reuse is limited to the reviewed convergence paths for `spec.author` (author, catalog role `implementer`; reviewer) and `implementation.build` (implementer; reviewer). A run has at most one current conversation per eligible step and role, even when the roles resolve to the same model. Direct calls, one-shot steps, and other providers keep their existing behavior. `pr.finalize` is explicitly fresh-only.

There is no new public API, retry limit, approval gate, cross-provider history import, or cache-hit guarantee. Keep the existing authentication, routing, tool, and result-validation policies. The run branch and durable checkpoints remain authoritative for recovery. This design follows the [persistence](../adrs/adr-019-persistence-layout.md), [workspace isolation](../adrs/adr-020-workspace-isolation-primitive.md), [reclamation](../adrs/adr-021-workspace-lifecycle-reclamation.md), [request policy](../adrs/adr-023-request-alteration-boundary.md), [role routing](../adrs/adr-024-role-aware-routing-key.md), and [convergence review](../adrs/adr-026-in-step-convergence-review.md) decisions.

#### Dispatch and persistence

```mermaid
sequenceDiagram
    participant W as Reviewed convergence
    participant E as Execution coordinator
    participant D as Durable store
    participant A as Native adapter
    W->>E: Current revision, feedback, and role scope
    E->>D: Check workspace and claim compatible slot or reserve new scope
    E->>A: Current policy and turn, with handle only for resume
    opt Resume refused with proof no work ran
        A-->>E: Classified resume refusal
        E->>D: Record attempt and retire old scope
        E->>A: Start once with current turn and compact handoff
    end
    A-->>E: Result, attempt evidence, and internal continuity metadata
    E->>D: Record attempt; save ready slot only if still owned
    E-->>W: Existing result and attempt reference
```

Add an internal `agent_conversation_slots` table keyed by non-null `(tenant, run_id, step, role)`, with a run foreign key, repository enforcement of tenant ownership, and a check allowing only the four eligible combinations. Store workspace generation, compatibility and scope digests, optional canonical PR identity, native storage scope ID, opaque native handle, versioned adapter metadata, last completed attempt ID, and an integer compare-and-swap version. A `ready` slot requires a native handle and completed attempt reference. An `in_flight` slot requires a claiming attempt ID. Keep any validated provider counter baseline with the history it describes. Removing a slot does not delete attempt records or cleanup inventory.

Add a non-null opaque generation and enrollment flag to `run_workspace_metadata`. Backfill each legacy row with a new generation marked unenrolled; do not infer sessions from existing Session rows, checkpoints, or scratch memory. At the first verified open, under workspace ownership, verify the run binding, worktree and branch, and containment and ownership of both roots. Record host-owned proof of the repo and scratch root instances outside agent write grants. Mark the generation enrolled only after that proof is established. The first dispatch starts fresh, with a handoff if prior work exists; a later dispatch can reuse the history created under that enrollment, including after restart.

Keep the generation across ordinary commits, gate transitions, and round-number resets. A reset, replacement, removal, rematerialization, or missing or mismatched proof after enrollment invalidates the generation. Retire its slots and fence its claims before admitting a replacement; install new proof only for the verified replacement. Reusing the same paths and branch is not proof of continuity. Incomplete enrollment cannot authorize retained execution. If enrollment fails, allow ordinary fresh execution only if existing workspace checks permit it.

Resolve the route and effective policy before considering a slot. Require the same provider and compatible native adapter and storage namespace, authenticated account or credential binding and revision, endpoint, resolved model and inference settings, workspace instance and generation, and effective filesystem, network, approval, skill, and tool policy. Use trusted identities, not display names or model output. If the binding cannot be established without exposing credentials, start fresh. A mismatch retires the old handle; changing settings back does not resurrect it.

The scope digest covers the pinned workflow, work item and deliverable identity, and revision of the stable role instructions and result contract. It does not hash the changing artifact or commit. Corrections to the same deliverable, ordinary progression between review altitudes, and repairs on the same bound PR do not reset scope. Replacing the objective or deliverable, `start_over`, or uncertainty about whether the work is the same retires history. Only the host selects a handle.

Claim under existing dispatch ownership with a version check. Never allow concurrent turns on one handle. Publish a ready slot only after the native turn ends cleanly, the result passes the existing boundary policy, and the attempt still owns the dispatch and workspace generation. Cancellation, re-entry, or replacement fences late completion. An abandoned in-flight claim after a crash is uncertain and cannot resume; existing recovery decides what can run next. If lookup, reservation, or claim storage is unavailable, do not retain or resume; use ordinary fresh execution if existing ownership and policy allow it. If a completed result cannot save its slot, do not invalidate the result or make its history reusable.

#### Current turn and handoff

Keep base role instructions and skill inputs stable while compatible. Append an authoritative block to each eligible turn, fresh or resumed: current workspace, step and role; current spec draft identity and path or content for spec work, or current commit and spec revision for implementation; current feedback and required disposition IDs; and the task and output contract for this turn. Include the current altitude and allowed work. Capture results only through the current attempt's structured capture or a dispatch-unique scratch destination. Earlier prompts, permissions, files, dispositions, and validation runs cannot fulfill current requirements. Host commits and feedback validation remain authoritative.

On later review rounds, include durable prior findings and dispositions and the last reviewed revision when available. Reviewers verify whether the earlier findings still apply, check affected changes for regressions, and apply the existing review scope to the current revision. If the last reviewed revision is missing or cannot be compared, review the full scope required for the current round. An author's disposition is evidence to check, not proof of a fix.

On any eligible fresh path with prior work, build a role-specific handoff from durable artifacts, checkpoints, and current Git state, not a transcript. Use the same builder for missing, stale, incompatible, and refused sessions. Label stale and unavailable evidence. Redact inputs before budgeting. Use these fixed limits, counted as UTF-8 bytes of rendered text, including headings, separators, and omission markers:

| Block | Maximum | Keep first, in order |
| --- | ---: | --- |
| Optional handoff | 8,192 bytes per turn | Open prior findings and linked disposition summaries; relevant files and revisions; decisions still in force; validation results and their revisions. Within each group, put current-scope and newest evidence first, then sort by stable ID or path. |
| Optional CI diagnostic excerpts | 4,096 bytes total per repair turn | Group by failed required check, sorted by check name then stable ID. In a first pass include each check's available failure summary before adding log excerpts; in a second pass add the newest failure excerpts first for each check in the same order. |

Use `[truncated]` when content is omitted for size, reserving its bytes within the limit. Render in priority order and stop after the first entry that does not fit: include only the prefix that fits without splitting a UTF-8 code point, then mark truncation. Diagnostic and handoff budgets are independent. Do not duplicate diagnostic excerpts in the handoff. The current task, current feedback and required IDs, reviewer finding inputs, revision identities, and failed check identities are outside these optional budgets and retain the parent contracts. Treat feedback, file contents, and diagnostic text as data, not instructions that can override runtime policy.

#### Native dispatch and fallback

- **Codex:** Keep the pinned app-server transport and existing account checks. On eligible retained starts, use `thread/start` with persistence enabled and capture the trusted `thread.id`. Resume explicitly with `thread/resume`. Verify the returned thread identity, resolved model and provider, workspace, and sandbox before `turn/start`. Apply current sandbox and skill inputs on the new turn. Preserve approved sign-in, network constraints, and MCP isolation. An ephemeral thread ID is not a resume handle.
- **Claude:** Keep the pinned Agent SDK. Enable native session persistence on eligible starts and capture the root `session_id` from trusted initialization. Resume by an explicit SDK `resume` ID in the verified storage scope with the current model, tools, skills, and permissions. Do not implicitly `continue`, fork history, or use a subagent ID. Verify the root identity before accepting events or output. Once execution is possible, a mismatch is not evidence of safe fallback.
- **Fallback:** A missing or incompatible slot starts fresh directly. After a native resume dispatch, allow at most one fresh fallback, and only for a positively classified unsupported, missing, expired, or stale session with proof that the prompt did not execute and no tools ran. Retire the old handle first and send the same current-turn requirements plus the handoff. Do not replay on auth or policy failures, cancellation, result-validation failure, or ambiguous disconnects. Retire uncertain history and follow existing failure and recovery handling. Do not retry the fallback as another resume.

#### Transcript protection and cleanup

Keep provider-native, host-local transcripts in a restart-surviving, host-managed scope for one conversation lineage, owned by the tenant, run, step, role, and account binding. Keep them outside repo and scratch grants and away from shared provider history. Before a retained launch, the adapter must establish that the pinned runtime confines all local transcript copies to the owned, erasable scope while preserving the existing auth and tool boundaries. For both Codex and Claude, verify which files the runtime reads and writes under its home or config directory. A different `CODEX_HOME` or Claude config directory is not evidence of isolation on its own. Keep credential custody with the existing auth mechanism: no copying credentials into a transcript scope, falling back to a different account or auth mode, or granting tools access to auth or transcript storage. This governs host-managed copies, not API retention outside the host's control.

If confinement or current permission enforcement cannot be established, do not launch retained execution in that configuration. Use ordinary fresh execution only as a runtime safety fallback. Before enabling this enhancement, **both Codex and Claude must independently pass** native verification on the pinned runtimes with their existing supported auth paths. Show actual role-isolated history carryover after restart, no writes to shared history, no tool access to transcripts, unchanged auth and permissions, and actual removal of retained files. A missing credential or blocked test is **not verified**, not a pass. A failed or unverified provider blocks acceptance of #195: record the failing runtime and configuration, surface the evidence to the run owner and maintainers for decision, and do not declare a fresh-only provider supported. Changing the auth or isolation contract, or reducing provider scope, requires an explicit human decision.

Reserve a storage scope durably before launching a transcript writer, even if the native handle arrives later. Track its opaque host-derived ID, storage domain, owner, workspace generation, adapter, creation and expiry times, retirement state and time, writer claim, confirmed delete eligibility time, and deletion outcome. The inventory survives run-row cascades so run deletion can retire scopes and remove slots together while leaving physical cleanup queued. Never store transcript contents in the database. Keep handles, paths, credential bindings, raw diagnostics, and private spec material out of exposed telemetry and Activity; use tenant-scoped repository access. Delete only derived scopes verified to be contained in their configured store, using the host's guarded removal path.

Retire a scope on the earliest of run deletion, workspace reclamation or removal, generation rotation, handle retirement, abandoned claim, or **30 days after scope creation**. Resume does not extend expiry. Retirement fences new claims immediately. An owned turn already running at expiry may finish within its existing process deadline but cannot republish the retired handle. For crashed, canceled, or timed-out writers, use host supervision to stop or confirm exit of processes that can still write. Never remove storage while a writer can still access it or allow a late writer to reopen the scope.

A **storage domain** is one execution host's managed transcript store, keyed by a stable host identity and store ID bound to its verified physical root. All admissions to that store share the domain regardless of tenant, provider, account, or run; a separate store has a separate domain. Use the same domain after process restart or a path alias; a new label cannot bypass pending cleanup.

Attempt removal once a retired scope has no live writer; reconcile on startup and at least hourly. Persist delete eligibility as the later of retirement and confirmed writer exit, or retirement if no writer launched or a writer had already exited. If physical absence is not verified **60 minutes after delete eligibility**, cleanup is overdue. An abandoned, canceled, or timed-out writer whose exit cannot be confirmed also makes the domain overdue **60 minutes after fencing is required**, even if deletion is not yet safe. Alert immediately on a failed fence and alert on overdue cleanup. Block new retained launches in that domain while any overdue record remains unresolved, including after restart; allow safe fresh non-retained dispatches. Clear the block only when all overdue records have verified absence. Retry failures idempotently; remove actual transcript artifacts, not just database rows. Downtime or storage failure may delay erasure, but neither resets deadlines nor marks cleanup complete.

#### Automatic CI repair and final review

When the existing repair worker re-enters `implementation.build`, use the two implementation role slots. Derive canonical PR identity from the repair decision and durable run binding. First repair can adopt compatible pre-PR history only if the binding proves it is the same run branch and deliverable; bind the slot to that PR on use. Different or unverified PR bindings preclude reuse. A new failed head on the same PR does not by itself reset scope. Give both roles the current local commit, the approved or frozen spec revision, the failed PR head, the failed required checks, and available diagnostic excerpts. Keep current local commit and failed head separate. Preserve repair scope, ownership, budgets, and publication guards on fresh and resumed turns.

For initial publication, target refresh, and repair, start a distinct non-retained, read-only `pr.finalize` conversation. Do not read or write any continuity slot or supply a continuity handoff. Pin the integrated candidate commit/tree and target SHA in the dispatch. Scope source and diff reads to that candidate; mutable branch tips and scratch leftovers are not evidence. Bind the verdict to this attempt and occurrence, and invalidate it on candidate or target drift under the existing bounded refresh path. Refresh starts a fresh final reviewer again.

**Keep the parent feature's post-review freeze and attestation order.** For initial spec-bearing publication, the reviewer checks the pinned integrated tree. Only a valid advance permits the host to apply the deterministic spec frontmatter freeze. Verify the freeze as a no-op or the single expected child of the reviewed commit, with only the spec path changed, unchanged file mode, and exact host-computed contents. The existing attestation binds repository, refs and target SHA, reviewed SHA, and exact publishable SHA. This covers the exact published tree by combining independent review of all substantive content with deterministic verification of the one allowed host-owned delta. Any other difference invalidates the candidate; missing or stale attestation cannot authorize a new push or create. Repair does not freeze again: the reviewed candidate is the publishable candidate. No change to the parent attestation contract or [ADR-028](../adrs/adr-028-spec-amendable-through-implementation.md) is needed.

#### Activity, usage, and pricing

Give each native dispatch its own local attempt ID, Activity, and durable `Session`, including a launched resume refusal and its subsequent fallback. A lookup that does not launch a provider is a decision recorded on the next attempt, not a synthetic model call. Preserve occurrence, role, round, timing, outcome, tools, and available usage for failed or interrupted attempts. Make recording idempotent by local attempt ID, never by provider conversation ID. Emit sanitized fresh, resumed, fallback, isolation, and cleanup outcomes with provider, step, and role dimensions where applicable. Do not put native identifiers in logs or metric labels.

Use #194's normalized evidence and read-time list pricing. For Codex, bind events to the acknowledged current turn and use proven deltas above a validated pre-turn counter baseline or independent current-turn evidence. A cumulative snapshot on resume is not a fresh-thread total. For Claude, deduplicate current-query request and message usage by native identity and include only provably linked child work. Replayed tools, historical output, and replayed structured results never enter current Activity, usage, or result capture. Keep fresh input, cache reads, available cache writes, and output disjoint. If evidence is incomplete, report partial or unavailable coverage instead of fabricated zeros, inferred lifetime usage, or guessed cost.

#### Verification and comparison

- Unit-test eligibility, compatibility, scope and generation changes, claim fencing, and accounting. Test both byte caps with exact-limit, over-limit, and multibyte fixtures. Check priority, marker cost, required-field preservation, and identical output for identical optional inputs on ordinary fresh and fallback paths.
- Drive production dispatch with durable SQLite, real Git fixtures, and scripted native transports for both providers. Cover repeated rounds at both steps, human revisions, restart with an intact workspace, legacy enrollment, missing proof after enrollment, same-path workspace replacement, stale and missing native history, and absent comparison revisions. Verify isolation by run, step, role, and account, at most one launch after a proven refusal, and no duplicate launch after ambiguous or post-tool failure. Check duplicate events, native replays, cumulative counters, missing baselines, and idempotent attempts.
- Use a controllable clock and on-disk transcript fixtures for deletion, reclamation, generation rotation, handle retirement, and expiry. Crash after reservation, after transcript creation but before handle capture, and during resume. Test physical removal, durable retry, no deletion of live or unrelated scopes, and alert and admission behavior immediately before and at the 60-minute thresholds, including a restart and an unaffected store.
- Exercise same-PR repair reuse and fallback with distinct local and failed commits; reject different or unverified PR bindings. Verify fresh, pinned, read-only review on initial publication, target refresh, and repair. Test review rejection before freeze, the valid post-review freeze, unexpected post-review edits, candidate and target drift, and missing attestation. Only the attested head can publish.
- Run opt-in native smoke tests for each provider with credentials excluded from the default suite. Record a separate **pass, fail, or not verified** result for Codex and for Claude. Demonstrate real history carryover with a harmless earlier turn after process and control-plane restart, unchanged auth and tool permissions, no replayed evidence, observed usage coverage, and physical removal in the actual storage location. A mocked transport or an accepted resume ID alone does not pass.

Compare three arms for each provider using representative multi-round spec and implementation cases:

| Arm | Conversation behavior | Prompt behavior |
| --- | --- | --- |
| A — continuity | Resume when eligible; normal fallback | New current-turn block; compact handoff on fresh starts with prior work |
| B — fresh with handoff | Internal benchmark override skips slot lookup and save; starts a new non-retained conversation per attempt | Same new current-turn block and handoff builder, limits, and priorities as A. The override does not suppress handoffs when prior work exists. |
| C — shipped fresh baseline | Run the pinned pre-change revision with its shipped fresh invocations, including ephemeral Codex threads | Shipped prompts and ordinary revision context only; no new handoff or current-turn block. Do not simulate C by toggling B. |

Use A vs. B to estimate the benefit of continuation over rebuilding context from a handoff. Use A vs. C for the total change against shipped behavior, and B vs. C for the combined effect of current-turn prompt and handoff changes. Treat #201/PR #202 as historical motivation, not a matched baseline. Pin the case's starting revisions, tasks, feedback, validation, route, account, model, settings, and rate revision. Repeat matched cases, rotate arm order, record cache and warm/cold ordering, and record rendered optional-block byte counts for A and B without logging contents. For identical inputs, assert identical optional-block output and limits. Keep instrumentation comparable without modifying C's prompts or tool policy.

Report each provider's native verification result and the number of eligible turns actually resumed, started fresh, or fell back. If native support fails or is unverified, label that provider's continuity comparison blocked or incomplete, escalate it, and do not report fresh-only A as evidence of resume. Report per-round time, elapsed time from first dispatch to the same review gate, tool calls and repeated work, fresh input, cache reads and writes, output, and estimated API list cost with coverage. Include sample counts and report non-arrivals separately. Compare validation, detected and missed findings, regressions, and disposition quality against the same case expectations. Explain observed gains or losses, note missing evidence and confounders, and surface any quality regression or unproven benefit without relaxing validation or review criteria.

#### Alternatives and risks

Fresh execution with a handoff is simpler and independent of provider history, but may repeat exploration. Keep it as both fallback and a comparison arm. Do not store full transcripts in SQLite or share a thread across roles: this expands access to private material and undermines review independence. Native compaction, stale memory, and variable cache availability can reduce the benefit of reuse. Keep current-turn evidence authoritative, retire incompatible history, and measure the outcome rather than assuming indefinite recall or savings.

## Task list

*(Added by task decomposition stage)*

- [ ] **Story: Keep compatible role history through revisions and restarts**
  - [ ] **Task: Persist slots and enroll workspace generations**
    - **Description**: Add the migration, slot repository, and host-owned workspace proof across open, reset, and rematerialization.
    - **Acceptance criteria**:
      - [ ] Migration preserves existing runs and Sessions, creates no inferred handles, and assigns unenrolled generations. First verified open enrolls an intact legacy workspace and starts fresh. A later dispatch can resume newly established history after restart.
      - [ ] Failed or interrupted enrollment cannot authorize retention. Missing proof after enrollment and replacement at the same path retire old history and require a verified new generation.
    - **Dependencies**: None
  - [ ] **Task: Select continuity and fence dispatch claims**
    - **Description**: Apply trusted route, policy, scope, and ownership checks, and classify native refusals.
    - **Acceptance criteria**:
      - [ ] The four eligible slots stay isolated. Incompatible slots retire, and abandoned or superseded claims cannot use a handle or publish a ready slot.
      - [ ] Only a proven pre-work native refusal allows one fresh fallback. Auth, policy, cancellation, and possibly executed attempts follow normal failure handling without replay.
    - **Dependencies**: Task: Persist slots and enroll workspace generations
  - [ ] **Task: Build current turns and role handoffs**
    - **Description**: Separate stable instructions from current revision inputs; render the optional handoff and diagnostics from trusted sources.
    - **Acceptance criteria**:
      - [ ] Fresh and resumed turns carry current revision, workspace, scope, feedback IDs, and attempt-owned output capture. Earlier output cannot satisfy the current contract.
      - [ ] Later reviewers recheck prior findings and affected changes. A missing comparison revision requires current full-scope review.
      - [ ] Tests verify the 8,192-byte and 4,096-byte limits, ordering, UTF-8 truncation and marker, and preservation of required fields. Skipped resume and safe native refusal use the same handoff builder.
    - **Dependencies**: Task: Select continuity and fence dispatch claims
- [ ] **Story: Resume native sessions within an erasable storage scope**
  - [ ] **Task: Reconcile retired transcript storage**
    - **Description**: Add durable pre-launch reservations, writer fencing, retirement, and guarded startup and hourly removal of actual storage.
    - **Acceptance criteria**:
      - [ ] All retirement triggers prevent reuse. The inventory survives slot and run deletion. Tests cover crashes before handle capture and during resume, failed removal across restart, and protection of live writers and unrelated scopes.
      - [ ] Fake-clock tests assert both overdue deadlines, persistent alerts and admission blocking for the affected host store only, and clearing after verified absence. The 30-day expiry does not extend on resume.
    - **Dependencies**: Task: Select continuity and fence dispatch claims
  - [ ] **Task: Resume Codex threads**
    - **Description**: Extend the pinned app-server lifecycle with retained starts in reserved storage and explicit resume.
    - **Acceptance criteria**:
      - [ ] Wire tests cover persistent `thread/start`, explicit `thread/resume`, current `turn/start`, refusal and fallback, and unchanged account, model, and sandbox guards.
      - [ ] Only current-turn events enter Activity or result capture. Native verification demonstrates isolated, erasable history without copying credentials or exposing transcripts to tools.
    - **Dependencies**: Task: Reconcile retired transcript storage
  - [ ] **Task: Resume Claude SDK sessions**
    - **Description**: Reserve isolated SDK history storage, capture the trusted root ID, and explicitly resume with current launch policy.
    - **Acceptance criteria**:
      - [ ] SDK tests verify reuse of the validated root ID, current policy, no implicit continuation or replayed output, and bounded fallback for confirmed refusal.
      - [ ] Native verification demonstrates isolated, erasable files with unchanged auth and permissions and no copying of credentials. Unverified storage or policy cannot authorize retention.
    - **Dependencies**: Task: Reconcile retired transcript storage
- [ ] **Story: Continue CI repair without reusing publication review**
  - [ ] **Task: Bind repair to the implementation slots**
    - **Description**: Pass trusted PR identity and separate current and failed commit evidence through both repair roles.
    - **Acceptance criteria**:
      - [ ] Compatible pre-PR history continues only on the run's proven PR. Later repair rounds keep roles isolated and receive both SHAs, the spec revision, failed checks, and available capped diagnostics.
      - [ ] Different or unverifiable PR bindings never resume. Fresh fallback preserves repair scope and ownership.
    - **Dependencies**: Task: Build current turns and role handoffs
  - [ ] **Task: Require fresh candidate-bound final review**
    - **Description**: Pin each read-only reviewer to the integrated candidate and preserve the parent's post-review freeze and attestation guards.
    - **Acceptance criteria**:
      - [ ] Initial, refreshed, and repair attempts start distinct fresh conversations without slots. Reads are scoped to the pinned candidate; drift invalidates the verdict and existing refresh limits still apply.
      - [ ] Rejection does not freeze the spec. The valid post-review freeze attests the exact final SHA, unexpected changes cannot publish, and repair does not freeze again.
    - **Dependencies**: None
- [ ] **Story: Prove attempt accounting and revision outcomes**
  - [ ] **Task: Record usage and Activity once per attempt**
    - **Description**: Bind live provider evidence and recorder writes to the local attempt, including a launched refusal and its fallback.
    - **Acceptance criteria**:
      - [ ] Current-turn Codex evidence and Claude current-query evidence preserve disjoint cache-aware classes where proven. Replay and cumulative history do not add historical charges or tool counts.
      - [ ] Duplicate callbacks, missing evidence, interruption, and fallback produce idempotent per-attempt Activity and Session records with accurate coverage.
    - **Dependencies**: Task: Resume Codex threads; Task: Resume Claude SDK sessions
  - [ ] **Task: Verify production-path continuity and isolation**
    - **Description**: Run the production revision, restart, cleanup, repair, and publication matrix and the opt-in native smoke tests.
    - **Acceptance criteria**:
      - [ ] Tests cover both providers, repeated rounds at both steps, human revision, legacy enrollment, restart, replaced workspaces, stale claims, safe and unsafe fallback, same-PR repair, and fresh review of each publication candidate.
      - [ ] Record pass, fail, or not verified separately for Codex and Claude using live carryover, confinement under existing auth and permissions, replay exclusion, and actual erasure. Escalate any fail or not-verified outcome; both providers must pass for acceptance.
    - **Dependencies**: Task: Record usage and Activity once per attempt; Task: Build current turns and role handoffs; Task: Bind repair to the implementation slots; Task: Require fresh candidate-bound final review
  - [ ] **Task: Compare continuity with both fresh baselines**
    - **Description**: Run the matched A/B/C comparisons, report the evidence and limits, and update the agent-owned code map and operational notes.
    - **Acceptance criteria**:
      - [ ] B keeps the handoff and shares A's builder and limits. C runs the pinned shipped prompts without the new block or handoff. Report A vs. B, A vs. C, and B vs. C separately.
      - [ ] Report the Codex and Claude native verification results and actual resume counts. Flag a failed or unverified provider as blocking acceptance and its continuity comparison as blocked or incomplete; do not substitute fresh-only results.
      - [ ] Report round and gate times, non-arrivals, tools, usage classes, estimated API cost and coverage, validation and review outcomes, and sample counts. Explain gains or losses and expose quality regressions or gaps without changing the gate.
      - [ ] Document retention deadlines, cleanup signals, verified native storage behavior, and steps to reproduce the comparison.
    - **Dependencies**: Task: Verify production-path continuity and isolation
