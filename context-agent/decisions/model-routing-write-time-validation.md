---
date: 2026-06-10
status: accepted
superseded_by: null
---
# model-routing-write-time-validation
**Decision:** Missing-profile-ref, mode/adapter-incompatibility, and cross-tenant profile-ref validation are enforced at resolve time (resolver load), not at routing-table write time.
**Rationale:**
- A profile may legitimately be created after the routing table that references it — write-time rejection would block valid multi-step configuration flows.
- Resolve-time validation fires before any provider session or direct call starts, so operators still see typed errors before work begins (routing_table_missing, profile_not_found, route_mode_mismatch, adapter_unavailable, credential_reference_invalid).
- The repository does enforce duplicate-route keys and snake_case role format at write time; these are structural invariants on the route key itself, not cross-record references.
- Single-active-table enforcement is app-level (list + filter check in create/update), not a DB partial-unique-index. Safe under single-process better-sqlite3; a structural gap if a second writer or async DB appears.
**Constraints:**
- The spec AC that says writes should reject missing profile refs diverges from this implementation. Future work can add write-time cross-record checks once the API has access to profile records at write time in a transaction.
- Cross-tenant profile isolation is enforced at resolve time via tenant-scoped findConfigurationRecordById; an integration test in model-routing.integration.spec.ts proves a profile from tenant_a is invisible to a routing resolver scoped to tenant_b.
**Rejected:** Synchronous write-time cross-record validation — rejected because the repository create/update paths operate on a single record and would need the full profile set as a dependency, coupling the write path to the profile registry in a way that breaks simple record updates.
