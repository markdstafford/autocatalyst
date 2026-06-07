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
