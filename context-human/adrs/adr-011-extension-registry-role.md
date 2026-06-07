---
created: 2026-06-03
last_updated: 2026-06-07
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-011: Extension registry role

## Status

Accepted

## Context

Autocatalyst supports pluggable providers across several kinds: channels, publishers, issue
trackers, and model/agent runners. A registry can catalog these. We must decide **what the
registry governs**, and apply that role consistently across all kinds, so its purpose is
unambiguous to anyone reading or extending the system, including an agent. A registry whose role
is enforced for some kinds but not others is a source of confusion: someone sees a working
provider missing from the registry and wrongly concludes it is broken, or adds a registry entry
expecting it to wire something and it does not.

## Decision

**The extension registry is a descriptive catalog, consulted uniformly across all pluggable
kinds. It does not gate resolution or wiring.**

- The registry declares **which provider kinds and implementations exist and what each can do**.
- Its purposes are **discovery** (surfacing the available providers in the UX) and **capability
  declaration**. It informs configuration validation but does not govern it.
- **Configuration validity is code resolution, not registry membership.** A configured provider is
  valid when its adapter id resolves to a real adapter or runner in code. An adapter id absent from the
  registry only **warns** (a likely typo, or a provider not yet listed); it never blocks a configured
  provider. Capability validation applies to registered providers, against their declared metadata.
- **Resolution is explicit and separate:** which runner a run uses is decided by routing; which
  channel/publisher/tracker is active is decided by configuration-driven composition. The
  registry is not on that path.
- **Registration is metadata, not permission.** A provider wired by routing or configuration
  works whether or not it appears in the registry. This is stated explicitly in the architecture
  documentation so that an absent registry entry is never mistaken for a broken or disabled
  provider.
- A **gating** role (registration required to be usable) is introduced only when dynamic,
  third-party plugins arrive, the situation where a gate carries real security, versioning, and
  sandboxing value.

## Consequences

**Positive:**
- One consistent rule across every pluggable kind, with no "enforced here, ignored there" surprises.
- Discovery, capability hints, and configuration warnings without coupling the catalog to runtime
  wiring; a configured provider is valid when its adapter id resolves to code, registry entry or not.
- Resolution stays explicit and easy to follow, which is where an agent looks to understand
  behavior.
- Leaves a clear place to add gating later without retrofitting it onto today's providers.

**Negative:**
- The registry does not, by itself, prevent an unregistered provider from being wired. This is
  correct by design, but it must be clearly documented so the catalog is not mistaken for a gate.
- Keeping the catalog accurate is a small ongoing maintenance task.
- Capability declarations can drift from reality if not kept in step with implementations.

## Alternatives considered

### Authoritative gate (registration required to be usable)

Everything pluggable must be registered to run; composition consults the registry uniformly for
every kind, and registration is the enabling step.

**Pros:**
- A single place that enumerates everything that can run.
- Consistent enforcement across all kinds.
- A natural home for future per-extension policy (versioning, sandboxing).

**Cons:**
- Creates a second source of truth, alongside routing and configuration, for "can this run,"
  the dual mechanism that breeds confusion.
- More ceremony for every provider with no present payoff.
- The gating value materializes only once untrusted third-party plugins exist.

**Why not chosen:** It adds a dual gate with no near-term benefit. The descriptive model is
consistent and lower-ceremony, and a gate can be added at the same seam when dynamic plugins make
it worthwhile.

### No registry at all

Drop the catalog; rely entirely on routing and configuration.

**Pros:**
- Less machinery to build and maintain.
- Nothing to keep in sync.

**Cons:**
- No discovery surface for the UX ("what can I add").
- No warning when a configured provider is absent from the catalog or likely misspelled.
- No place to declare provider capabilities.

**Why not chosen:** Those descriptive benefits are useful and cheap to provide with a lightweight
catalog.

### A registry consulted for some kinds but not others

Enforce or consult the registry inconsistently across kinds. Not a genuine alternative: it is the
inconsistency this decision exists to eliminate. It makes the registry's purpose unknowable and
invites the "looks unregistered, must be broken" mistake.
