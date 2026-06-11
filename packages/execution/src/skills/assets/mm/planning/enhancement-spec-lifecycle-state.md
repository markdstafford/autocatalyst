# Artifact frontmatter schema and lifecycle states

This document is the canonical reference for frontmatter fields on each artifact type and the rules governing status transitions.

## Feature spec (`specs/feature-*.md`)

| Field | Type | Notes |
|---|---|---|
| `name` | string | Human-readable feature name |
| `slug` | string | URL-safe identifier used in filenames |
| `type` | `feature` | Fixed value |
| `status` | `Draft` \| `Ready` \| `Implementing` \| `Done` | See lifecycle below |
| `owner` | string | Person accountable for this feature |
| `related_adrs` | list of ADR IDs | e.g. `[adr-001, adr-003]` |

## Enhancement spec (`specs/enhancement-*.md`)

| Field | Type | Notes |
|---|---|---|
| `name` | string | Human-readable enhancement name |
| `slug` | string | URL-safe identifier used in filenames |
| `type` | `enhancement` | Fixed value |
| `status` | `Draft` \| `Ready` \| `Implementing` \| `Done` | See lifecycle below |
| `feature_slug` | string | Slug of the parent feature this enhances |
| `owner` | string | Person accountable for this enhancement |

## ADR (`adrs/adr-NNN-*.md`)

| Field | Type | Notes |
|---|---|---|
| `id` | string | e.g. `adr-001` |
| `title` | string | Short decision title |
| `status` | `Draft` \| `Accepted` \| `Superseded` \| `Deprecated` | See lifecycle below |
| `date` | `YYYY-MM-DD` | Date the decision was recorded |
| `superseded_by` | string or `null` | ID of the superseding ADR, if any |

## App spec (`specs/app.md`)

| Field | Type | Notes |
|---|---|---|
| `name` | string | Application name |
| `type` | `app` | Fixed value |
| `status` | `Draft` \| `Active` | See lifecycle below |

---

## Status lifecycle

### Feature spec and enhancement spec

```
Draft → Ready → Implementing → Done
```

- **Draft → Ready**: human explicitly approves the artifact after the reviewer pass.
- **Ready → Implementing**: set at implementation handoff — when the task list is accepted and the first implementation task is started.
- **Implementing → Done**: set when all tasks are shipped and the feature or enhancement is live.

### ADR

```
Draft → Accepted
Accepted → Superseded  (when a newer ADR replaces it)
Accepted → Deprecated  (when the decision is retired without a replacement)
```

- **Draft → Accepted**: requires explicit human approval. Never auto-accept.
- When superseding an ADR: set `status: Superseded` and `superseded_by: adr-<NNN>` on the old ADR at the same time the new one is accepted.

### App spec

```
Draft → Active
```

- **Draft → Active**: set when the application is in production use. Until then, keep `Draft`.
