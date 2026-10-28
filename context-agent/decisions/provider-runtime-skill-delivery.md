---
date: 2026-10-21
status: accepted
superseded_by: null
---
# Provider runtime skill delivery
**Decision:** Deliver runtime skills with OpenAI SDK native skills plus filesystem/shell capabilities, and Claude SDK local plugins with `skills: 'all'`.
**Rationale:**
- OpenAI needs native descriptors with SKILL.md content and recursively materialized references/scripts/assets, rather than discovery hints alone.
- Claude `options.skills` selects skill names; plugin descriptors belong in `options.plugins`. One local plugin per namespace contains `.claude-plugin/plugin.json` and `skills/<name>/`.
- Both providers use runtime-owned catalog assets, independent of developer editor configuration.
**Constraints:** Claude plugin sources and ref segments are validated before copying, symlinks are rejected, and session close/failure removes temporary plugins. OpenAI keeps `NoopSnapshotSpec` and reviewer read-only grants, filters dependency directories/symlinks from workspace staging, and separately captures structured output. Native skill sessions use SDK capability tools; progress functions remain on the no-skill path. Spec-author and build-reviewer output bypass OpenAI outputType so the agent can use tools before returning a file or final JSON. These are validated integration paths, not a diagnosis of every historical capture failure.
**Rejected:** Claude `type: claudecode` skill descriptors — unsupported runtime options shape; mounting OpenAI files without native descriptors — does not expose skills through the SDK capability; logging raw SDK diagnostic strings — may contain credentials or model content.
