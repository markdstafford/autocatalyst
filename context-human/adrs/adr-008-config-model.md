---
created: 2026-06-03
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-008: Configuration model

## Status

Accepted

## Context

Autocatalyst holds substantial structured settings: AI providers, endpoints, credentials,
per-intent model routing, the repositories it works on, channel/publisher bindings, and policies.
The service is the source of truth and exposes a dedicated UX. Where configuration lives, and how
it is read and written, has to account for several properties of that configuration:

- It is rich and nested, and users edit parts of it through the UX (managing repos, adjusting
  model settings).
- The service is the source of truth, consumed by multiple clients.
- Multi-tenant operation is a supported direction, so configuration must be scoped per tenant.
- The service needs a small amount of configuration to start at all, before any store is
  available.

## Decision

**Configuration is service-owned and stored in the database (ADR-004), read and written through
the API, validated by the shared schemas (ADR-007), and evolved under the API versioning rule
(ADR-006). Only minimal bootstrap configuration lives outside the database.**

- All operational configuration (providers, routing, the model rate table, repos, channel bindings,
  policies) is data in the store, scoped by owner/tenant (ADR-009), and managed through the API. This
  is what lets the UX edit it and what makes it multi-tenant-ready. The rate table is effective-dated so
  historical pricing stays reproducible (`cost`).
- Bootstrap configuration is supplied by environment variables or launch flags, because it is
  needed before the store can be read: the database location, the network listen port, and the
  master secret that unlocks the secret store. It is kept to that minimal set.
- Configuration is schema-validated on write, so invalid configuration is rejected at the
  boundary rather than failing deep in a run.

## Consequences

**Positive:**
- The UX can read and edit configuration directly through the API.
- Configuration is naturally tenant-scoped, ready for multi-user operation.
- One source of truth for settings, validated and versioned like the rest of the API.
- Changes are queryable and auditable as data rather than scattered across files.

**Negative:**
- Editing configuration requires the service and its API to be running (no offline file edit).
- A schema migration is needed when the configuration shape changes (handled by the store's
  migration tooling).
- Bootstrap configuration is a separate, smaller mechanism that must be documented so operators
  know the minimal set.

## Alternatives considered

### Configuration in files on disk (e.g. a YAML file per repository)

Keep operational configuration in version-controlled files that the service reads at startup.

**Pros:**
- Simple to author and review; no database involved.
- Naturally version-controlled alongside code.
- Easy to inspect and diff as plain text.

**Cons:**
- Cannot be edited through the UX without round-tripping files, which the dedicated-UX direction
  needs.
- Per-repo files scattered across the filesystem do not fit a hosted, multi-tenant service.
- No built-in validation, scoping, or change events.

**Why not chosen:** The service is the source of truth, and configuration must be API-editable and
tenant-scoped, properties a file-on-disk model does not provide.

### Environment-variable-only configuration

Express all configuration through environment variables.

**Pros:**
- Twelve-factor simplicity and easy container injection.
- No configuration store to manage.

**Cons:**
- Does not scale to rich, nested, per-repository configuration.
- Cannot be edited at runtime through the UX.
- Awkward to scope per tenant.

**Why not chosen:** The configuration is too rich and too interactive for environment variables;
they remain appropriate only for the minimal bootstrap set.

### Hybrid file-plus-database configuration

Keep some configuration in files and some in the database. Splitting the source of truth invites
drift and ambiguity about which value wins, so this is not a genuine alternative. The only split
adopted is the minimal bootstrap set, which is not configuration in the operational sense.
