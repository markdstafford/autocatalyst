---
created: 2026-06-04
last_updated: 2026-06-07
purpose: Index of the concept docs — read this to find the right concept without opening each.
---

# Concept index

Each concept below is an architectural contract. See its frontmatter for the current `status`.

| Concept | Scope |
| --- | --- |
| [architecture](architecture.md) | The static topology: one service, two planes, hosting, persistence, the API envelope, configuration, the identity/tenancy seam, extensibility, and the repository layout. |
| [execution-runtime](execution-runtime.md) | The layer beneath a run: the Execution Context, driving an agent session, the event protocol, the result contract, concurrency, and recovery. |
| [domain-model](domain-model.md) | The entity catalog and relationships: `Conversation`/`Topic`/`Message`/`Run`, `Artifact`, `Feedback`, `Publication`, `PR`, `RunStep`/`Session`/`Cost`, `TestResult`, `Project`, identity, the persistence layout, and links. |
| [run](run.md) | The run lifecycle: phase/step/session/role/gate, the step-primitives catalog, `waiting_on`, workflows-as-data, the transition rule, the review loop, intent-upgrade, and resume. |
| [workflow](workflow.md) | What fills the run machine: the step catalog and per-step behavior, roles, the implementer–reviewer convergence and its max-rounds bound, gate mechanics, workflows composing the catalog as data, the generalized `revise`, and the deterministic command path. |
| [review](review.md) | In-step convergence review: the implementer and reviewer roles within a step, the per-round loop, the implementer-decides-convergence rule, reviews steering the workflow through `revise`, single-model degradation, and a finding as a `Feedback` item. |
| [orchestrator](orchestrator.md) | The single mutation authority and scheduler: ingestion through the service interface, the topic-keyed dedup gate, dispatch across the `Runner` boundary, concurrency, operator actions, and recovery. |
| [api](api.md) | The service interface and network surface: the resource taxonomy, naming and casing, reads and the SSE event stream, versioning, health, and auth. |
| [settings](settings.md) | The configuration data model: service-owned config in the database (ADR-008), the records it homes (provider connectivity, routing and rate tables, `Project` settings, channel bindings, policy knobs), secret references rather than secrets, validation and connection tests, the bootstrap boundary, and the split from the DESK editing surface. |
| [workspace](workspace.md) | The per-run filesystem environment: the two-root (repo/scratch) layout and its durability invariant, the git-worktree isolation primitive, provisioning shapes, canonical paths and containment, the branch, creation and teardown, retention and garbage collection, and re-materialization. |
| [agent-runners](agent-runners.md) | Runner plurality and its machinery: the connection layer + agent/direct orchestrators + per-cell provider adapters, connectivity configuration, the request-alteration boundary, typed-event emission, uniform telemetry, and per-backend tool/skill materialization. |
| [model-routing](model-routing.md) | The selection policy: the `(step, role)` routing key, the declarative routing table and resolution, profiles and inference settings, role-distinct routing for convergence, and the model-management configuration model. |
| [runtime-skills](runtime-skills.md) | The skills provisioning subsystem: the runtime-owned catalog and index, dependency resolution, the provider-neutral skill-ref model, the route-to-skill mapping, provisioning visibility, and injected runtime instructions. |
| [feedback](feedback.md) | The feedback-loop behavior: one item type attributed to principals, native creation, disposition authority, gating at a human-review gate, batch addressing, the resolution contract check, spec amendment from implementation feedback, and post-PR feedback. |
| [hitl](hitl.md) | The human pause-and-resume semantics: one pause mechanism with gate / model-question / convergence-escalation flavors, the valid reply directives per pause, explicit recovery versus the `set-step` operator force, and the reply-to-a-stopped-run behavior. |
| [intents](intents.md) | Per-message classification as the message's impact on the run (`create`/`advance`/`revise`/`answer`), the create attachments (new topic / upgrade / divert), context as the run's current step, and the two-stage issue-reference create. |
| [acceptance-testing](acceptance-testing.md) | The human-test gate: the testing guide as a `Publication`, the run-parented test-result record built around `Feedback`, manual-first testing with evidence in scratch, and click-into results. |
| [commands](commands.md) | The operator command surface: authenticated channel-agnostic actions (`cancel`, `set-step`, archive-with-tombstone cleanup), informational reads collapsing into the API, a `Principal` on every call, and the destructive-purge confirmation. |
| [intake](intake.md) | How work enters and binds to `Conversation`/`Topic`/`Run`: entry as resource creation, the four entry kinds, the `Project` binding and server-assigned identity with the repository guard, the two-stage issue-reference create, list filing, the swappable duplicate capability, and acknowledgement. |
| [trackers](trackers.md) | The issue/PR tracker integration: the provider-neutral issue-tracker port and the git-shaped code-host port, agents reading only through defined tools, the run-parented `PR` record with detected merge status, source config and credentials, triage and AI titles, conventional-commit titles, and the cumulative PR summary. |
| [spec-lifecycle](spec-lifecycle.md) | The spec as a durable versioned document: the committed file versus the database entity, the five-value frontmatter status machine and the one-way mapping from operational status, the frontmatter contract, the per-kind canonical record (file/issue/other/none), authoring and commit location, supersession, and the freeze at `pr.finalize`. |
| [docs-model](docs-model.md) | The whole-corpus doc model: the two ownership trees and the `AGENTS.md` map, hub-and-spoke progressive disclosure, the bounded lossy-by-design `spec.md`, the two indexes, bottom-up compaction in the `docs.update` step, agents maintaining their own context, and reflexive versus repository-health compaction. |
| [mm-integration](mm-integration.md) | The boundary with micromanager: the delegation test and what is built versus invoked, the three invoked skills (planning, issue-triage, compaction), the uniform invocation envelope, the one-time config read, version dependence through the manifest, and the methods taken up later. |
| [observability](observability.md) | The two stores and what flows to each: the durable session-grain run record (`RunStep` + `Session`) versus the ephemeral OTLP/Victoria logs and metrics, OTel-SDK emission, the durable query model behind status and progress, the operational-visibility model the API defers here, and retention. |
| [cost](cost.md) | Turning execution metadata into money: the session as the cost unit, pricing tokens × per-model rate in integer nano-dollars at session completion, the service-owned rate table, live-computed rollups (a cached aggregate deferred), and the per-session analytics for tuning workflow depth and comparing thinking levels. |
