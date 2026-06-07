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
| [orchestrator](orchestrator.md) | The single mutation authority and scheduler: ingestion through the service interface, the topic-keyed dedup gate, dispatch across the `Runner` boundary, concurrency, operator actions, and recovery. |
| [api](api.md) | The service interface and network surface: the resource taxonomy, naming and casing, reads and the SSE event stream, versioning, health, and auth. |
| [settings](settings.md) | The configuration data model: service-owned config in the database (ADR-008), the records it homes (provider connectivity, routing and rate tables, `Project` settings, channel bindings, policy knobs), secret references rather than secrets, validation and connection tests, the bootstrap boundary, and the split from the DESK editing surface. |
| [workspace](workspace.md) | The per-run filesystem environment: the two-root (repo/scratch) layout and its durability invariant, the git-worktree isolation primitive, provisioning shapes, canonical paths and containment, the branch, creation and teardown, retention and garbage collection, and re-materialization. |
