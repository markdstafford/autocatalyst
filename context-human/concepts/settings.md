---
created: 2026-06-07
last_updated: 2026-06-07
status: active
roadmap: core
---

# Settings

The configuration data model: the service-owned settings the system reads to run, and the schemas,
validation, and secret handling that govern them. ADR-008 makes configuration a core data model and an
API contract, so its schemas need an owner. This concept is that owner. It homes the configuration
records scattered across the other concepts, and owns how they are stored, validated, scoped, and
secured. It does **not** own the in-application editing surface (DESK `settings`), and it does not
re-state the per-domain schemas the other concepts define; it homes them and owns the storage, the
validation lifecycle, the secret-reference model, and the bootstrap boundary.

## Service-owned configuration

All operational configuration is data in the database, read and written through the API,
schema-validated on write (ADR-007), evolved under the API versioning rule (ADR-006), and scoped by
owner and tenant (ADR-009). There is no file-plus-database split: the source of truth is the store, and
the only thing that lives outside it is the minimal bootstrap set (below). This is what lets the UX edit
configuration and what makes it multi-tenant-ready (ADR-008).

## The configuration records

Each record's schema is defined by the concept that uses it; this concept holds the set and the common
rules. The records are:

- **Provider connectivity** — a `credential`, an `endpoint`, and a `profile`, the small graph a runner
  reaches a provider through (`agent-runners`).
- **Model routing** — the routing table that maps `(step, role)` to a profile, with per-route tiering
  and override, and the effective-dated model rate table that prices tokens (`model-routing`, `cost`).
- **Project settings** — the repository binding (`repo_url`, host-repository location), the
  workspace-root override, the issue-tracker setting, the code-host setting, and the merge strategy,
  carried on a `Project` (`domain-model`, `workspace`, `trackers`).
- **Secret references** — the reference a setting carries to a credential in the secret store
  (`architecture`, `trackers`).
- **Channel and publisher bindings** — the configured adapter surfaces an operator command or a
  publication runs through (`commands`).
- **Policy knobs** — the batch cap on issue filing (`intake`), the workspace retention windows
  (ADR-021), and the request timeout and retry posture (`agent-runners`, ADR-023).

## Secret references, not secrets

A setting that needs a secret carries a **reference** to a credential; the secret itself lives in the
service's secret store, never as plaintext on the record. A connection test validates a setting when it
is written, reporting failures in categories that never reveal the token, and removing a setting deletes
the credential it owns (`trackers`). The secret store and the master secret that unlocks it belong to
`architecture`; this concept owns the reference model that points into it.

## Validation and connection tests

Configuration is schema-validated on write, so invalid configuration is rejected at the boundary rather
than failing deep in a run. Cross-references must resolve: every endpoint references a known credential
and every profile a known endpoint, checked before any session starts (`agent-runners`). A connection
test confirms a setting can reach its provider. A configured provider is valid when its adapter id
resolves to a real adapter or runner in code; the extension registry is advisory metadata, so an id
absent from the registry only warns and never blocks (ADR-011).

## The bootstrap boundary

A minimal bootstrap set lives outside the database because it is needed before the store can be read:
the database location, the network listen port, and the master secret that unlocks the secret store. It
is supplied by environment variables or launch flags and kept to that minimal set; everything else is
operational configuration in the store (ADR-008).

## The schema model and the editing surface

This concept owns the configuration data model — the records, their schemas, validation, scoping, and
secrets. The in-application editing surface that reads and writes them is DESK `settings` (repository
management, the model-management surface, theming), a separate DESK concept. The split keeps the schema
contract, which the running system needs from the start, independent of the UI, which the desktop app
delivers later.

## Relationships

- `architecture` — the configuration model (ADR-008), the secret store, and the bootstrap boundary this
  concept builds on.
- `agent-runners` — the provider connectivity schemas (`credential`, `endpoint`, `profile`).
- `model-routing` — the routing table and the per-route tiering this concept stores.
- `cost` — the effective-dated rate table, read for pricing.
- `domain-model` / `workspace` / `trackers` — the `Project` settings (repository, tracker, code host,
  workspace root, merge strategy).
- `commands` — the channel and publisher bindings.
- DESK `settings` — the in-application editing surface onto these records.

## Constraints and decisions

- Configuration is service-owned, database-stored, API-edited, schema-validated on write, and
  owner/tenant-scoped; there is no file-plus-database hybrid (ADR-008).
- A setting holds a credential reference; the secret lives in the secret store, never plaintext on the
  record.
- A configured provider is valid when its adapter id resolves to code; the registry is advisory
  (ADR-011).
- The configuration schema model is needed from the start; the DESK editing surface is a later concept.

## Open edges

- **Materializing skill configuration from the store** — so an invoked skill that expects its own
  config file (micromanager's `mm.toml`) reads service-owned values rather than the workspace copy — is
  an open boundary, deferred (`mm-integration`).
- **Per-tenant configuration overrides** and **configuration change events** build on the owner/tenant
  scoping, taken up when multi-user operation lands.
