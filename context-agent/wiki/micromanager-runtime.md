# Runtime Micromanager maintenance

## Source and layout

Canonical repository: https://github.com/markdstafford/micromanager.git. Pin: `2697b97864e1cea9035aa272685911d43cc460da`, plugin version `2.3.0`.

- `packages/execution/scripts/micromanager-selection.json`: immutable pin, selected skills, dependencies, supplemental documents, excluded conditional skill references, and known missing upstream examples.
- `packages/execution/src/skills/assets/mm/`: upstream repository-relative paths. Complete `plugins/mm/skills/planning/` and `writing-guidelines/` trees, plugin metadata, and two supplemental lifecycle/approval documents. No authored invocation rules here. `SOURCE.json` records selection and per-file SHA-256 hashes.
- `packages/execution/src/skills/catalog.ts`: runtime refs point into those canonical trees. Regression tests compare paths/dependencies with provenance.
- `packages/execution/scripts/sync-micromanager.mjs`: reads immutable Git blobs, validates selected references/dependencies, synchronizes or verifies every file. Missing/unexpected files, changed hashes, symlinks, and changed missing-reference sets fail verification.
- `packages/core/src/spec-authoring-context.ts`: separate Autocatalyst invocation envelope. It delegates enhancement structure and nested checkbox stories/tasks/acceptance criteria to canonical planning stages; keeps lifecycle, approval, permissions, location and result-contract rules outside plugin content.

## Commands (from repository root)

```sh
# Reproduce selected assets from GitHub without any local plugin installation:
node packages/execution/scripts/sync-micromanager.mjs --sync
# Offline integrity check against committed upstream hashes (also a build prerequisite):
node packages/execution/scripts/sync-micromanager.mjs
# Independent upstream verification, including all built assets (CI runs this after build):
node packages/execution/scripts/sync-micromanager.mjs --upstream --dist
# Use an existing Git object database, ignoring its working-tree modifications:
node packages/execution/scripts/sync-micromanager.mjs --upstream --dist --upstream-repo /absolute/path/to/micromanager
# Build and verify dist against pinned hashes:
pnpm nx verify-dist-assets execution
# Includes seven negative integrity checks plus runtime resolver/format tests:
pnpm nx test execution
pnpm nx run-many -t build lint test -p core openai-agent-adapter claude-agent-adapter codex-agent-adapter
pnpm test:boundaries
```

To update: review a new upstream commit, change the full commit/version in the selection file, review dependency and reference closure, run `--sync`, review every canonical diff and `SOURCE.json`, rebuild, then verify with `--upstream --dist`. New missing references fail until explicitly reviewed and recorded. Do not edit canonical files directly or update hashes to bless local rewrites. Synchronization replaces the selected asset directory. Host `.git/info/exclude` rules can hide upstream `.eng-docs` resources; verify every manifest file is tracked (use `git add -f` for a newly selected ignored resource) without changing host exclusions.

## Delivery and upstream gaps

OpenAI mounts the entire selected `assets/mm` tree read-only at `/workspace/skills/mm`, preserving repository-relative paths and supplemental docs; its manifest points at canonical `plugins/mm/skills/.../SKILL.md` files. Claude descriptors and Codex native inputs point directly at the canonical host directories. Provider regression tests hash every delivered skill resource; the OpenAI test stages and verifies the complete mounted subset, including hidden files. Codex's subprocess wire test exercises a real catalog SKILL.md path. These deterministic tests verify packaging and delivery inputs, without running live inference.

The planning skill names `enhancement-pause-before.md` and `enhancement-spec-lifecycle-state.md` without including them under its own directory. We include the original repository documents at their upstream paths and resolve those names in the external invocation envelope. The runtime does not invoke the plugin's session-start hook: configuration, permissions and lifecycle remain runtime responsibilities.

Four optional examples are missing from upstream: `references/examples/{adr-schema,design-spec,tech-spec,task-list}.md`. The sync/verify command prints each gap and enforces the exact known set. Canonical inline task examples, enhancement/feature examples and templates are included. Never fabricate files under those missing paths. Conditional roadmapping/friction-log/implementation skill references are recorded as excluded with scope reasons; writing-guidelines is the selected authoring dependency.

## E2E runner handoff after merge

This fix is developed outside the run workflow in its own checkout. No live backend, database, configuration or run workspace is updated as part of this PR. JSON output behavior and the unrelated reviewer-completion failure are outside scope.

A later session should:

1. Confirm this PR is merged and identify the isolated E2E runner checkout and its process owner. Inspect and preserve runner-only changes, especially any provider SDK/sandbox fixes; do not reset or overwrite them.
2. Coordinate a safe pause with the E2E owner before updating or restarting its backend. Fetch the merged revision and integrate this fix into that runner checkout, resolving only relevant overlaps. Preserve the backend's existing database, configuration, credentials, repositories and run workspaces.
3. In the updated runner checkout, run `pnpm install --frozen-lockfile`, `pnpm build`, and `node packages/execution/scripts/sync-micromanager.mjs --upstream --dist`. Rebuilding is required: editing source assets alone leaves an already running backend on its old catalog/dist.
4. Restart the isolated backend with its existing launch command and environment after the owner approves the restart. No reset, reseed, config mutation, or workspace recreation is needed for this change.
5. Exercise a fresh enhancement spec-authoring session. Confirm the loaded template is `references/templates/enhancement.md` with Parent feature/What/Why/Design changes/Technical changes, and that Task list contains nested checkbox stories/tasks/acceptance criteria. Check delivered provider paths and retain any separate reviewer-completion failure for its own issue.

## Issue #117 validation

`pnpm validate` passes across all 13 projects (build, lint, tests and boundary checks). The seven negative integrity checks, canonical enhancement/nested-checkbox checks, provider content tests, fresh-upstream source/dist comparison and `pnpm nx verify-dist-assets execution` pass. Live provider tests remain opt-in; no running E2E backend is used.
