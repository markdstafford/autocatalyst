---
date: 2026-10-27
status: accepted
superseded_by: null
---
# Canonical Micromanager runtime subset
**Decision:** Vendor complete selected skill trees and supplemental resources from an immutable Micromanager Git commit, preserving upstream bytes and repository-relative paths.
**Rationale:**
- The plugin owns planning methods, templates, examples, and task formatting.
- SHA-256 provenance supports offline builds; CI independently fetches pinned Git blobs and verifies both source and dist.
- Autocatalyst's invocation envelope owns lifecycle, permissions, approval gates, file locations, and result transport outside canonical files.
**Constraints:** Spec authoring selects planning and its writing-guidelines dependency; conditional roadmapping, friction logging, and implementation handoff are outside the invocation scope. Four optional example links are absent upstream and explicitly reported, never replaced with authored substitutes.
**Rejected:** Editing plugin instructions to remove lifecycle steps or inventing replacement templates — breaks fidelity and duplicates the method.
