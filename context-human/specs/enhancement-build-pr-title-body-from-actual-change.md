---
created: 2026-06-18
last_updated: 2026-06-18
status: implementing
issue: 84
specced_by: autocatalyst
---
# Enhancement: Build pull-request title and body from the run's actual change

## Product requirements

### What

Autocatalyst should open a pull request whose title and body describe the real cumulative change produced by the run, even when `pr.finalize` returns no `reconciledSummary` or `titleSubject`. The conventional-commit prefix still comes from the run work kind through the shared title derivation. The subject, summary, and changed-files section must come from the run's folded implementation result and the actual branch diff, not from round-count placeholders.
This enhancement keeps `reconciledSummary` and `titleSubject` as optional refinements. They can improve the PR content when present, but their absence must never let placeholder strings such as `Round 1: implementation passed review` or `round 1: 3 file(s) changed` reach the opened pull request.
### Parent feature

This enhances `feature-review-open-merge-pull-request.md`, which introduced `pr.finalize`, spec freeze, `pr.open`, code-host adapters, shared conventional titles, and a cumulative implementation summary for pull-request content. It also depends on the tolerance behavior from issue 83: a clean `{}` `pr.finalize` result can advance, so the fallback PR content must be real without relying on model-authored summary fields.
### Current behavior

The title and body builders already have the right shape. `packages/core/src/conventional-title.ts` derives conventional-commit titles from the run work kind plus `titleSubject`, `reconciledSummary`, or the cumulative summary. `packages/core/src/pr-content.ts` builds the PR body from `CumulativeImplementationSummary`, optional final-review fields, the issue URL, changed files, validation, follow-ups, and non-goals.
The problem is upstream. When `DefaultOrchestrator` folds the `implementation.build` convergence checkpoint into `CumulativeImplementationSummary`, it currently synthesizes fallback round text. A clean round with no reviewer findings contributes `Round N: implementation passed review` as the summary. A round with changed files contributes `round N: M file(s) changed` as a changed-file entry. If `pr.finalize` returns `{}` or otherwise omits `reconciledSummary` and `titleSubject`, `pr.open` uses those placeholders as the deterministic fallback content.
The run workspace git port already returns `changedFilePaths` when host-controlled commits are created, but the convergence checkpoint schema and summary-folding path do not preserve those real paths for `pr.open`.
### Proposed behavior

Autocatalyst should preserve real changed file paths and a real implementation-change description from `implementation.build` through `pr.open`.
For changed files, each committed implementation round should record the actual changed paths returned by host-controlled git operations. The cumulative summary should deduplicate and carry those paths. The PR body changed-files section should list those real paths, formatted as file paths, and should not contain count-only strings.
For the PR title and summary fallback, the cumulative summary should not invent round-pass text. It should use the best available real implementation signal in this order:
1. Structured implementer-provided round summary from the implementation result or disposition summaries when they describe actual changes.
2. A deterministic diff-derived subject from real changed paths when model summary text is absent.
3. A safe generic fallback such as `complete approved implementation` only when no summary text and no changed file path can be determined.
`pr.finalize.reconciledSummary` and `pr.finalize.titleSubject` continue to override or refine the deterministic content when present. When they are absent, the title and body still describe the real branch diff and changed paths.
### Why

The pull request is the human review artifact that represents the run's final work. If it says only that a round passed review or that some number of files changed, reviewers cannot understand the actual change without opening the diff. Worse, the placeholder content makes Autocatalyst look as though it lost the implementation context, even though the workspace and git history contain enough information to produce a useful fallback.
Issue 83 makes a clean empty `pr.finalize` result valid. That means the deterministic fallback path must stand on its own. The model-authored `reconciledSummary` and `titleSubject` should improve a real default, not rescue an otherwise placeholder PR.
### Goals

- Preserve actual changed file paths from implementation commits into the cumulative implementation summary.
- Build the PR body's changed-files section from real paths, never from count-only strings.
- Keep conventional-commit title derivation centralized in `deriveConventionalTitle` and prefix titles from work kind.
- Make absent `reconciledSummary` and `titleSubject` safe: the PR still has a meaningful title and body based on real cumulative changes.
- Prevent placeholder strings from reaching PR titles, PR body summaries, cumulative summaries, and related tests.
- Cover the `{}` `pr.finalize` path so clean-final-review normalization still opens a useful PR.
### Non-goals

- Improving model-authored summary quality.
- Adding another code-host provider or changing GitHub adapter behavior.
- Adding pull-request comments, review comments, or issue comments.
- Changing merge detection, spec freeze behavior, or the `pr.finalize` result schema.
- Building a UI for editing PR titles or bodies before opening.
- Requiring a live model or live GitHub call for this proof.
### Personas

- **Riley, code reviewer:** needs the pull request title and body to describe what changed so review starts with useful context.
- **Phoebe, product owner:** needs the opened PR to connect the implementation back to the requested issue without reading raw run logs.
- **Enzo, platform engineer:** needs fallback PR content to come from deterministic run state and git diff data, not from ad hoc placeholder strings.
- **Opal, operator:** needs safe behavior when model output is sparse, including no raw paths outside the repo, secrets, prompts, or provider diagnostics in PR content.
### User stories

- As Riley, I can open an Autocatalyst-created pull request and see a conventional-commit title whose subject describes the actual change, even when final review returned `{}`.
- As Riley, I can read the PR body and see the real changed file paths instead of `N file(s) changed` placeholders.
- As Phoebe, I can trust the PR summary to describe the complete cumulative run output, not only the last review round.
- As Enzo, I can trace PR content back to persisted implementation summary data and real branch diff data.
- As Opal, I can rely on deterministic fallback content that does not leak secrets, raw provider output, absolute workspace paths, or hidden prompts.
### Acceptance criteria

#### Real changed files

- `implementation.build` convergence checkpoints preserve actual changed file paths for each implementation commit when the host git port reports them.
- The cumulative implementation summary folds those real paths across rounds and deduplicates them by repository-relative path.
- The PR body's `## Changed files` section lists real repository-relative file paths.
- The changed-files section never contains `round N: M file(s) changed`, `N file(s) changed`, or any other count-only placeholder.
- Deleted files are represented if available from the branch diff source. If the current commit-level port only reports added/modified/renamed paths, the final branch diff source must fill deletions before PR content is built.
#### Real title and summary fallback

- A clean implementation round with no reviewer findings does not contribute `Round N: implementation passed review` to `cumulativeSummary`.
- When `pr.finalize.titleSubject` is present, `deriveConventionalTitle` uses it as it does today.
- When `titleSubject` is absent but `reconciledSummary` is present, `deriveConventionalTitle` uses the first useful sentence or heading from `reconciledSummary` as it does today.
- When both are absent, the title subject is derived from real cumulative implementation content or real changed paths.
- If no real implementation summary text or changed path exists, the existing safe fallback `complete approved implementation` is allowed.
- No PR title contains `round N`, `implementation passed review`, or a changed-file count placeholder.
#### `pr.finalize` optional refinement

- `reconciledSummary` and `titleSubject`, when present, refine the PR body and title.
- `reconciledSummary` and `titleSubject`, when absent, do not cause placeholder content to be used.
- A run whose `pr.finalize` result normalizes from `{}` to clean advance opens a PR with a real conventional-commit title and real changed-file entries.
- `pr.finalize` blocker and revise behavior remains unchanged.
#### Branch diff source

- The implementation defines one deterministic branch-diff source for PR content fallback.
- The diff source compares the run branch to the intended base branch or a stored base ref, not to an arbitrary working-tree state.
- Diff paths are repository-relative, normalized with forward slashes, deduplicated, and sorted for stable output.
- Diff summary extraction stays inside host-controlled git ports or core seams. Agents and routes do not shell out directly for PR content.
#### Tests and documentation

- Unit tests cover cumulative summary folding with real changed paths and no placeholder strings.
- Unit tests cover `buildPullRequestContent` and `deriveConventionalTitle` fallback behavior when `titleSubject` and `reconciledSummary` are absent.
- Integration coverage drives `implementation.build` through `pr.finalize` returning `{}` and then `pr.open`; the captured PR create call has a real conventional-commit title and real file paths in the body.
- Regression tests assert placeholder strings do not appear in the title or body.
- `context-agent/wiki/code-map.md` is updated during implementation if modules are added, moved, or significantly changed.
### Non-functional requirements

- **Security:** PR content must not include secrets, credentials, raw provider transcripts, prompts, absolute workspace paths, scratch paths, raw `gh` output, or raw filesystem errors.
- **Compatibility:** The change does not alter public API schemas. It does require an internal persistence change for nullable `run_workspace_metadata.provisioned_base_ref`, plus additive convergence-checkpoint JSON tolerance for `changedFilePaths`.
- **Determinism:** Given the same implementation checkpoint and branch diff, PR content is stable across process restarts.
- **Provider neutrality:** Core uses provider-neutral code-host and workspace-git seams. GitHub remains one adapter behind the code-host boundary.
- **Resilience:** Missing summary text should degrade to changed-path-derived content before using the generic fallback title subject.
### Impact on existing behavior

PRs opened without model-authored `reconciledSummary` or `titleSubject` become more specific. Their titles and bodies may change from placeholder round text to file- and change-based summaries. Existing PR lifecycle states, spec freeze behavior, merge detection, and code-host adapter contracts remain unchanged.
Persisted convergence checkpoints that lack changed-path arrays should remain readable. For old checkpoints, the final branch diff source can still recover real changed files at `pr.open` time when workspace metadata and base branch data are available.
### Product devil's advocate pass

- **A file-list-derived title can be too mechanical.** It is still better than `round 1`, and it is only a fallback after model or implementer summary text. The title should prefer actual summary text when available.
- **Commit-level changed paths may miss deletions.** The current host git port documents added/modified paths only. The implementation must use a final branch diff before PR content is opened so deletions are not silently omitted.
- **Diffing against the wrong base can produce noisy PR content.** The diff source needs an explicit base branch or base ref from workspace/code-host configuration. It should not diff against whatever branch happens to be checked out locally.
- **Adding more summary fields could duplicate the PR-finalize reconciler.** The goal is not another AI summary pass. The deterministic path should preserve real implementation data and simple diff-derived fallback content.
### Product reviewer pass

This is correctly scoped as an enhancement to the PR lifecycle. The title and body builders already support the desired fallback hierarchy, but the data they consume is polluted with placeholder strings. The most important implementation constraint is to fix the source data and branch-diff seam rather than adding string filters only at PR rendering time.
### References

- [Issue 84](https://github.com/markdstafford/autocatalyst/issues/84) — source request and acceptance criteria.
- [Issue 73](https://github.com/markdstafford/autocatalyst/issues/73) — parent PR lifecycle feature.
- [Issue 83](https://github.com/markdstafford/autocatalyst/issues/83) — clean `{}` `pr.finalize` result tolerance.
- [context-human/concepts/](../concepts/trackers.md)[trackers.md](http://trackers.md) — cumulative final change and conventional titles.
- [context-agent/standards/](../../context-agent/standards/commit-and-title-conventions.md)[commit-and-title-conventions.md](http://commit-and-title-conventions.md) — shared title mapping and formatting.
- `packages/core/src/orchestrator.ts` — current implementation-summary folding point.
- `packages/core/src/implementation-summary.ts` — cumulative implementation summary builder.
- `packages/core/src/conventional-title.ts` — conventional title derivation.
- `packages/core/src/pr-content.ts` — PR body builder.
- `packages/core/src/pr-open-handler.ts` — `pr.open` content assembly.
- `packages/core/src/run-workspace-git.ts` and `apps/control-plane/src/run-workspace-git-port.ts` — host-controlled git seam and concrete implementation.
## Design spec

### Design scope

This is a backend workflow and PR-content design. It adds no screens, routes, SDK methods, or design-system components. The visible change is the content of pull requests opened by Autocatalyst.
### Successful fallback experience

A successful sparse-final-review flow looks like this:
1. `implementation.build` commits real changes to the run branch through the host git port.
2. The convergence checkpoint records the implementer summary when available and the real changed file paths from git.
3. The orchestrator folds implementation rounds into a cumulative summary without placeholder round-pass strings.
4. A human approves `implementation.human_review`.
5. `pr.finalize` returns `{}` and issue 83 normalizes it to clean advance with no `reconciledSummary` or `titleSubject`.
6. `pr.open` builds PR content from the persisted cumulative summary plus the final branch diff.
7. The opened PR has a `feat:`, `fix:`, or `chore:` title whose subject comes from real implementation content or changed paths.
8. The PR body lists real changed file paths and summarizes the cumulative change.
### Content rules

The PR title subject uses the existing source order, with one stronger invariant: every source before the generic fallback must be real change content.
1. `pr.finalize.titleSubject` when non-empty.
2. First sentence or heading from `pr.finalize.reconciledSummary` when non-empty.
3. First sentence or heading from cumulative implementation summary when non-empty and not placeholder text.
4. A deterministic changed-path-derived subject, such as `update control-plane PR lifecycle tests`, when changed paths exist.
5. `complete approved implementation` only when no richer source exists.
The PR body summary uses `reconciledSummary` when present. Without it, it uses the cumulative implementation summary when non-empty. If that text is absent, it uses a short deterministic sentence derived from the final diff, for example: `Updates 3 files: packages/core/src/orchestrator.ts, packages/core/src/implementation-summary.ts, and apps/control-plane/src/pr-lifecycle.integration.spec.ts.` This sentence should be stable and bounded; long file lists belong in `## Changed files`.
The `## Changed files` section always uses repository-relative paths. It should include additions, modifications, renames, and deletions when the branch diff can report them. It should not include counts as stand-ins for paths.
### Failure and degradation experience

If the implementation checkpoint has no usable summary text, the system should degrade to final branch diff data. If branch diff data is unavailable but the run still has a valid cumulative summary, the PR may open with summary text and no changed-files section. If neither summary text nor changed paths are available, the PR may open only with the generic fallback subject after logging a safe diagnostic, because the existing PR lifecycle should not fail solely because optional descriptive content is sparse.
A malformed or inaccessible workspace diff must not leak paths or raw git errors. If `pr.open` already has enough valid persisted summary data, it can continue without the diff-derived changed-files enhancement. If it does not, it should fail with an existing sanitized PR-open failure path only when the missing diff indicates a true internal invariant problem such as missing workspace metadata.
### Component interactions

- **Implementation build convergence:** captures `RunWorkspaceCommitResult.changedFilePaths` from `commitFiles` and stores them on each convergence round or adjacent checkpoint data.
- **Cumulative summary builder:** folds real round summaries, validation, follow-ups, non-goals, and changed paths. It does not create human-facing placeholder summary text.
- **Branch diff provider:** supplies final repository-relative changed paths for `pr.open`, including deletions when possible.
- **PR finalization:** optionally stores `reconciledSummary` and `titleSubject`. It does not have to provide them for the PR to be useful.
- **PR open handler:** combines final-review fields, cumulative summary, and branch diff data before calling `buildPullRequestContent`.
- **PR content builder:** renders the title and body. It may include guardrails against known placeholder strings, but the main fix is upstream data quality.
### Design reviewer pass

The design keeps the user-visible behavior focused: better PR content with no new workflow steps. The main risk is making changed-path recovery too dependent on a specific git state. The implementation should prefer persisted round paths for determinism, then reconcile with a final base-to-head branch diff at `pr.open` so deleted files and restart scenarios are covered.
## Tech spec

### Current state

Relevant implementation points in the current workspace are:
- `packages/core/src/orchestrator.ts` builds a `CumulativeImplementationSummary` after `implementation.build` convergence. It maps each convergence round to an `ImplementationSummaryRoundInput`, but for clean rounds it synthesizes `Round N: implementation passed review`, and for changed files it writes `round N: M file(s) changed`.
- `packages/api-contract/src/convergence.ts` defines `convergenceRoundRecordSchema` with `changedFileCount`, but no changed-file path array.
- `packages/core/src/run-workspace-git.ts` already defines `RunWorkspaceCommitResult.changedFilePaths` as paths added or modified in a commit.
- `apps/control-plane/src/run-workspace-git-port.ts` already computes `changedFilePaths` with `git diff-tree --name-only --diff-filter=ACMR` after commit.
- `packages/core/src/implementation-summary.ts` folds round `fixSummary`, `changedFiles`, validation, follow-ups, and non-goals into `CumulativeImplementationSummary`.
- `packages/core/src/pr-open-handler.ts` loads the latest `pr.finalize` checkpoint and the latest `implementation.build` cumulative summary, then calls `buildPullRequestContent`.
- `packages/core/src/pr-content.ts` renders the body changed-files section directly from `cumulativeSummary.changedFiles`.
- `packages/core/src/conventional-title.ts` falls back from final-review title fields to `cumulativeSummary`, then to `complete approved implementation`.
### Architecture

The enhancement should make actual change data flow through existing seams instead of adding PR-render-time string hacks.
#### Data capture

Add an optional `changedFilePaths` field to the convergence round record contract in `packages/api-contract/src/convergence.ts`:
```typescript
const convergenceRoundRecordBaseSchema = z.object({
  // existing fields
  changedFileCount: z.number().int().min(0),
  changedFilePaths: z.array(z.string().min(1)).default([]),
  // existing fields
}).strict();
```
Use preprocess/default behavior so older checkpoints without this field still parse. Populate this field in both convergence engines from `RunWorkspaceCommitResult.changedFilePaths` wherever `changedFileCount` is currently assigned.
Normalize paths before persistence:
- repository-relative only;
- no leading `/`;
- no `..` segment;
- forward slash separator;
- no empty strings;
- deduplicated and sorted within a round.
If a provider or test seam only returns `changedFileCount`, preserve compatibility by storing an empty path array and allowing `pr.open` to recover paths from the final branch diff.
#### Branch diff source

Extend the host-controlled workspace git seam rather than shelling out from PR code directly. Add a method to `RunWorkspaceGitPort` or a small adjacent port such as `RunWorkspaceDiffPort`:
```typescript
export interface GetChangedFilesInput {
  readonly workspaceRepoRoot: string;
  readonly baseRef: string;
  readonly headRef?: string;
}

export interface ChangedFileEntry {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'renamed' | 'deleted';
  readonly previousPath?: string;
}

getChangedFiles(input: GetChangedFilesInput): Promise;
```
The concrete control-plane implementation should use argument-array git commands, not shell strings. A suitable command is `git diff --name-status --find-renames ...` from the contained run workspace. It should map Git statuses to the neutral enum, choose the new path as `path` for renames, store the old path as `previousPath`, and validate containment before running git.
Base ref selection should be explicit. Prefer the code-host binding base branch or stored workspace base ref used to create the run branch. If the code currently has only `binding.baseBranch`, use the local fetched base ref that the workspace provisioner guarantees, and document any limitation in tests. Do not infer base from the current checked-out branch name.
#### Summary folding

Update `ImplementationSummaryRoundInput` and `buildCumulativeImplementationSummary` only as needed to distinguish real changed paths from placeholders. The existing `changedFiles: readonly string[]` can remain if callers now pass only real paths. Add a helper such as `buildImplementationSummaryRoundInputs(checkpoint)` to keep placeholder prevention centralized outside the orchestrator method body.
The mapping from `ConvergenceRoundRecord` to `ImplementationSummaryRoundInput` should:
- use disposition summaries for actual fixed findings;
- use any future structured implementer round summary when available;
- not synthesize `Round N: implementation passed review`;
- pass `round.changedFilePaths`, not `round ${n}: ${count} file(s) changed`;
- include validation summary if a round records deterministic validation in the future;
- omit empty fields rather than filling them with placeholders.
After building the summary, merge in final branch diff paths at `pr.open` before rendering. This can be done by creating a new summary object:
```typescript
const changedFiles = mergeChangedFiles(
  cumulativeSummary.changedFiles,
  diffEntries.map(entry => entry.path)
);

const renderableSummary = {
  ...cumulativeSummary,
  cumulativeSummary: cumulativeSummary.cumulativeSummary || summarizeChangedPaths(changedFiles),
  changedFiles
};
```
`mergeChangedFiles` should normalize, deduplicate, and sort paths. `summarizeChangedPaths` should create a bounded sentence for fallback summary text, not a replacement for the changed-files list.
#### Title fallback

Keep `getConventionalTitleType`, `formatConventionalTitle`, and the main `deriveConventionalTitle` API in `packages/core/src/conventional-title.ts`. Add or reuse a helper that can derive a subject from changed paths when summary text is absent. The helper should be deterministic and conservative.
Examples:
- One path: `update packages/core/src/orchestrator.ts`.
- Multiple paths in one package: `update core package implementation summary handling` if a simple package/root commonality can be identified.
- Multiple unrelated paths: derive a non-count subject from deterministic path structure, such as `update packages and apps changes` for top-level directory groups or `update changed implementation files` when no useful commonality exists. Count-only subjects are not allowed.
The changed-path-derived subject must never include absolute paths or changed-file counts and should still pass `normalizeConventionalSubject`.
A minimal implementation can avoid changing the public title function by ensuring `cumulativeSummary.cumulativeSummary` contains the deterministic changed-path sentence before `buildPullRequestContent` calls `deriveConventionalTitle`. A richer implementation may add `changedFiles?: readonly string[]` to `deriveConventionalTitle` input. If the latter is chosen, update tests for callers and keep the function backward-compatible.
#### PR content rendering

`buildPullRequestContent` should continue to render `reconciledSummary` over cumulative summary text for the body. It should render `changedFiles` only after they have been normalized to real paths. Add a defensive guard that drops known legacy placeholder entries matching count-only round strings so older checkpoints do not leak them when a branch diff is available.
This guard is a safety net, not the primary fix. Tests should fail if new summary folding code creates those strings.
#### Persistence and compatibility

An internal persistence change is required for nullable `run_workspace_metadata.provisioned_base_ref` storage so `pr.open` can recover the exact base ref after restarts. This is not a public API schema change. Legacy metadata rows may leave the value null and must be handled by the fallback rules below.
Beyond the internal `run_workspace_metadata.provisioned_base_ref` storage change, no SQL migration is required for convergence round changed paths because convergence checkpoints are stored as JSON in `RunStep.checkpointResult`. The Zod schema change for `changedFilePaths` is additive and should tolerate old checkpoint JSON.
For old checkpoints or tests that lack `changedFilePaths`, `pr.open` should attempt final branch diff recovery using `RunWorkspaceMetadata.provisionedBaseRef` when available. If diff recovery is unavailable, it may omit the changed-files section rather than rendering placeholders.
### Security and boundary rules

- Only host-controlled core/control-plane seams run git commands.
- Git commands use argument arrays and a contained `cwd` under the configured workspaces root.
- PR content receives repository-relative paths only.
- Errors from diff extraction are logged with safe codes and do not include raw stderr, absolute paths, tokens, prompts, or provider output.
- Agents do not call `gh pr`, `git diff`, or code-host operations directly for this behavior.
- The existing `tools/boundary-tests/assert-gh-pr-boundary.mjs` remains valid; add a git-boundary test only if the implementation creates a new non-port git execution site.
### Test plan

Targeted tests should include:
- `packages/core/src/implementation-summary.spec.ts`: folds real changed paths, deduplicates paths, preserves summary text, and does not create placeholder text for clean rounds.
- `packages/core/src/conventional-title.spec.ts`: derives fallback titles from real cumulative summary or changed-path-derived summary when `titleSubject` and `reconciledSummary` are absent.
- `packages/core/src/pr-content.spec.ts`: renders real changed paths, omits or filters legacy count placeholders, and keeps `reconciledSummary` precedence.
- `packages/core/src/orchestrator.spec.ts`: `implementation.build` checkpoint enrichment uses `changedFilePaths` and never writes `Round N: implementation passed review`.
- `apps/control-plane/src/run-workspace-git-port.spec.ts`: final branch diff method returns added, modified, renamed, and deleted repository-relative paths and rejects paths outside the workspace root.
- `apps/control-plane/src/pr-lifecycle.integration.spec.ts`: a run with `pr.finalize` returning `{}` reaches `pr.open`; captured `gh pr create` title is a real conventional title; body includes real changed paths and excludes `round N`, `implementation passed review`, and `file(s) changed` placeholders.
Useful targeted commands:
```bash
pnpm nx test core -- implementation-summary.spec conventional-title.spec pr-content.spec orchestrator.spec pr-open-handler.spec
pnpm nx test control-plane -- run-workspace-git-port.spec pr-lifecycle.integration.spec
pnpm test:boundaries
```
Run broader validation with `pnpm validate` when practical.
### Open questions

- Should deleted file paths be included in `CumulativeImplementationSummary.changedFiles` as plain paths, or should a richer `ChangedFileEntry` eventually replace the string array? This spec keeps the PR-rendered list as paths but allows the branch-diff seam to carry status internally.
- Is there already a structured implementer summary field in provider outputs that should be preserved? If not, changed-path-derived fallback text is acceptable for this slice.
### Tech reviewer pass

The least risky path is additive: persist changed path arrays in checkpoint JSON, stop generating placeholder strings, and add a final branch-diff reconciliation step before `buildPullRequestContent`. This keeps title and body generation centralized while fixing the data quality problem at the source. The main implementation risk is base-ref selection for the branch diff; it should be explicit and tested because an incorrect base can make the changed-files section noisy or misleading.
## Converged API

### Files

Path
Purpose
Exports

`packages/api-contract/src/convergence.ts`
Additive checkpoint contract support for persisted repository-relative changed file paths on each convergence round while preserving old checkpoint compatibility. Use a field-level changedFilePaths default/readonly array on the object schema, not a top-level ZodEffects transform, so nested validation error paths remain stable.
`convergenceRoundRecordSchema`, `ConvergenceRoundRecord`

`packages/core/src/domain-repositories.ts`
Extend the internal run workspace metadata contract so the exact base ref resolved during run-branch provisioning is persisted and exposed through RunWorkspaceMetadataRepository.findByRunId for [pr.open](http://pr.open) branch-diff recovery.
`UpsertRunWorkspaceMetadataInput`, `RunWorkspaceMetadata`, `RunWorkspaceMetadataRepository`

`packages/execution/src/workspace.ts`
Expose the provisioned base ref on two_roots ProvisionWorkspaceResult values so control-plane metadata persistence can store the exact ref used to create the run branch.
`ProvisionWorkspaceResult`, `provisionWorkspace`

`packages/execution/src/internal/workspace-provisioner.ts`
Return the resolved baseRef as provisionedBaseRef after addWorktree succeeds, closing the base-ref persistence gap without asking [pr.open](http://pr.open) to infer git state later.
`WorkspaceProvisioner`, `createWorkspaceProvisioner`

`packages/persistence/src/schema.ts`
Add nullable internal run_workspace_metadata.provisioned_base_ref storage for the exact workspace provisioning base ref; legacy rows may remain null and are handled by [pr.open](http://pr.open) fallback rules.
`runWorkspaceMetadata`

`packages/persistence/src/domain-repositories.ts`
Persist and hydrate RunWorkspaceMetadata.provisionedBaseRef through DrizzleRunWorkspaceMetadataRepository while preserving compatibility for legacy rows without the value.
`DrizzleRunWorkspaceMetadataRepository`

`packages/core/src/run-workspace-git.ts`
Extend the host-controlled workspace git seam with deterministic branch-diff retrieval for PR content fallback, including added, modified, renamed, and deleted paths.
`ChangedFileStatus`, `ChangedFileEntry`, `GetChangedFilesInput`, `RunWorkspaceGitPort`

`apps/control-plane/src/run-workspace-git-port.ts`
Implement RunWorkspaceGitPort.getChangedFiles using contained argument-array git commands, explicit base/head refs supplied by core, and repository-relative path normalization.
`createRunWorkspaceGitPort`

`packages/core/src/implementation-summary.ts`
Provide reusable summary/path helpers and centralized convergence-round-to-summary-input mapping so cumulative summaries fold real changed paths without synthesizing round-pass or count-only placeholder text.
`ImplementationSummaryRoundInput`, `CumulativeImplementationSummary`, `buildImplementationSummaryRoundInputs`, `buildCumulativeImplementationSummary`, `mergeChangedFiles`, `summarizeChangedPaths`

`packages/core/src/orchestrator.ts`
Populate each [implementation.build](http://implementation.build) convergence round checkpoint with normalized RunWorkspaceCommitResult.changedFilePaths, and replace inline placeholder synthesis with buildImplementationSummaryRoundInputs before building the cumulative implementation summary.
`DefaultOrchestrator`

`packages/core/src/conventional-title.ts`
Keep conventional title derivation centralized while adding a deterministic changed-path-derived subject fallback when final-review and cumulative summary text are absent.
`DeriveConventionalTitleInput`, `deriveChangedPathSubject`, `deriveConventionalTitle`

`packages/core/src/pr-content.ts`
Render PR content from real cumulative summary data, changed paths, and optional final-review refinements while defensively dropping legacy count-only placeholders.
`BuildPullRequestContentInput`, `buildPullRequestContent`

`packages/core/src/pr-open-handler.ts`
Resolve the intended base ref from RunWorkspaceMetadata.provisionedBaseRef or configured code-host base branch data, recover final base-to-head branch changed files before opening a PR, merge them with persisted cumulative summary paths, and pass renderable real-change content to PR content builders.
`PullRequestOpenHandlerDependencies`, `handlePullRequestOpen`

`apps/control-plane/src/server.ts`
When workspace provisioning or workspace-root callbacks persist run workspace metadata, include provisionedBaseRef from the two_roots provisioning result so [pr.open](http://pr.open) can diff against the exact branch creation base after restarts.

### Public API

#### `convergenceRoundRecordSchema`

```typescript
export const convergenceRoundRecordSchema: typeof convergenceRoundRecordBaseSchema
```
- Returns: `Zod object schema that parses ConvergenceRoundRecord values and defaults missing changedFilePaths to an empty readonly array for old checkpoints. The default is applied on the changedFilePaths field with z.array(z.string().min(1)).default([]).readonly() or an equivalent field-level schema; the artifact intentionally does not require a top-level ZodEffects transform, so nested changedFilePaths validation failures retain their normal Zod issue path.`
- Errors:
	- `ZodError when changedFilePaths contains empty strings or when any other convergence round field violates the checkpoint contract. Because defaulting is field-level, errors for invalid changedFilePaths entries should point at changedFilePaths and the failing index rather than at a top-level transform boundary.`
#### `RunWorkspaceMetadataRepository.findByRunId`

```typescript
findByRunId(runId: string): Promise
```
- Parameters:
	- `runId: string` — Run identifier whose internal workspace metadata should be loaded for [pr.open](http://pr.open) and other server-side workspace operations.
- Returns: `Promise, where RunWorkspaceMetadata.provisionedBaseRef is the exact ref resolved by workspace provisioning and passed to git worktree add when available. Legacy metadata rows may return provisionedBaseRef as null or undefined.`
- Errors:
	- `Repository-specific persistence errors, wrapped by callers in their existing persistence failure paths.`
#### `RunWorkspaceMetadataRepository.upsert`

```typescript
upsert(input: UpsertRunWorkspaceMetadataInput): Promise
```
- Parameters:
	- `input: UpsertRunWorkspaceMetadataInput` — Internal workspace metadata to persist. New callers that receive a two_roots ProvisionWorkspaceResult must include provisionedBaseRef; compatibility callers may omit it only when no repository worktree/base ref exists.
- Returns: `Promise`
- Errors:
	- `Repository-specific persistence errors, wrapped by callers in their existing persistence failure paths.`
#### `RunWorkspaceGitPort.getChangedFiles`

```typescript
getChangedFiles(input: GetChangedFilesInput): Promise
```
- Parameters:
	- `input: GetChangedFilesInput` — Workspace repo root plus explicit base and optional head refs used to compute a deterministic branch diff for PR content. baseRef must be the exact RunWorkspaceMetadata.provisionedBaseRef when available; only legacy rows without that metadata may fall back to the configured project/code-host binding base branch tracking ref. The current checked-out branch name must never be used as baseRef.
- Returns: `Promise`
- Errors:
	- `Error with sanitized code workspace_containment_violation when workspaceRepoRoot is outside the configured workspaces root in the concrete control-plane implementation.`
	- `Error with sanitized code changed_files_ref_invalid when baseRef or headRef is malformed, unsafe, or omitted where the concrete implementation cannot safely default headRef to checked-out run branch HEAD.`
	- `Error with sanitized code changed_files_path_invalid when git reports a non-repository-relative or otherwise unsafe path.`
#### `createRunWorkspaceGitPort`

```typescript
export function createRunWorkspaceGitPort(options: RunWorkspaceGitPortOptions): RunWorkspaceGitPort
```
- Parameters:
	- `options: RunWorkspaceGitPortOptions` — Control-plane workspace git port options, including the root under which run workspaces must be contained.
- Returns: `RunWorkspaceGitPort`
#### `buildImplementationSummaryRoundInputs`

```typescript
export function buildImplementationSummaryRoundInputs(rounds: readonly ConvergenceRoundRecord[]): readonly ImplementationSummaryRoundInput[]
```
- Parameters:
	- `rounds: readonly ConvergenceRoundRecord[]` — Parsed convergence round checkpoint records from [implementation.build](http://implementation.build). The helper maps only real implementation signals: disposition/finding summaries when they describe actual changes, future structured implementer summaries when present, and round.changedFilePaths.
- Returns: `readonly ImplementationSummaryRoundInput[]`
#### `buildCumulativeImplementationSummary`

```typescript
export function buildCumulativeImplementationSummary(input: { readonly rounds: readonly ImplementationSummaryRoundInput[]; readonly completedAt: string; }): CumulativeImplementationSummary
```
- Parameters:
	- `input: { readonly rounds: readonly ImplementationSummaryRoundInput[]; readonly completedAt: string; }` — Implementation round summary inputs and completion timestamp. Callers must pass only real change summaries and real repository-relative changed paths. Use buildImplementationSummaryRoundInputs for convergence checkpoints.
- Returns: `CumulativeImplementationSummary`
- Errors:
	- `MissingCumulativeImplementationSummaryError when no implementation rounds are provided.`
#### `mergeChangedFiles`

```typescript
export function mergeChangedFiles(...sources: ReadonlyArray): readonly string[]
```
- Parameters:
	- `sources: ReadonlyArray` — One or more changed-path lists from persisted convergence rounds and final branch diff recovery.
- Returns: `readonly string[]`
#### `summarizeChangedPaths`

```typescript
export function summarizeChangedPaths(changedFiles: readonly string[]): string
```
- Parameters:
	- `changedFiles: readonly string[]` — Normalized repository-relative changed file paths used to create a bounded deterministic fallback summary sentence.
- Returns: `string`
#### `deriveChangedPathSubject`

```typescript
export function deriveChangedPathSubject(changedFiles: readonly string[]): string | null
```
- Parameters:
	- `changedFiles: readonly string[]` — Normalized repository-relative paths used as a deterministic title subject fallback.
- Returns: `string | null`
#### `deriveConventionalTitle`

```typescript
export function deriveConventionalTitle(input: DeriveConventionalTitleInput): string | null
```
- Parameters:
	- `input: DeriveConventionalTitleInput` — Work kind plus optional titleSubject, reconciledSummary, cumulativeSummary, and changedFiles fallback inputs.
- Returns: `string | null`
- Errors:
	- `Error when the derived conventional title type or subject is empty after normalization.`
#### `buildPullRequestContent`

```typescript
export function buildPullRequestContent(input: BuildPullRequestContentInput): PullRequestContent
```
- Parameters:
	- `input: BuildPullRequestContentInput` — Work kind, optional issue URL, cumulative implementation summary reconciled with final branch diff paths, and optional final-review title/body refinements.
- Returns: `PullRequestContent`
- Errors:
	- `MissingCumulativeImplementationSummaryError when cumulativeSummary is missing.`
	- `Error when workKind does not map to a pull-request-producing conventional title type.`
#### `handlePullRequestOpen`

```typescript
export async function handlePullRequestOpen(runId: string, tenant: string, deps: PullRequestOpenHandlerDependencies): Promise
```
- Parameters:
	- `runId: string` — Run identifier currently positioned at [pr.open](http://pr.open).
	- `tenant: string` — Tenant scope used for repository lookups and state transitions.
	- `deps: PullRequestOpenHandlerDependencies` — Repositories, code-host registry, workspace git diff seam, credential resolver, event publisher, directive applier, and clock. The handler resolves GetChangedFilesInput.baseRef from runWorkspaceMetadata.findByRunId(runId).provisionedBaseRef, which is captured when the run branch is provisioned. Only if that field is absent on legacy workspace metadata may it fall back to the project/code-host binding base branch as a provisioner-guaranteed local tracking ref; it must not use the current checkout branch name.
- Returns: `Promise`
- Errors:
	- `PullRequestOpenHandlerError with existing codes for missing run, invalid step, terminal run, missing project/code-host/workspace/finalize/summary state, provider branch lookup or PR creation failures through the code-host boundary, persistence failures, PR recovery conflicts, or sanitized branch-diff recovery failures.`
### Types

#### `ConvergenceRoundRecord`

```typescript
type ConvergenceRoundRecord = { readonly round: number; readonly implementerSessionId?: string; readonly reviewerSessionId?: string; readonly implementerCommitSha?: string | null; readonly changedFileCount: number; readonly changedFilePaths: readonly string[]; readonly findings: readonly ConvergenceRoundFinding[]; readonly dispositions: readonly FindingDisposition[]; readonly outcome: ConvergenceRoundOutcome; readonly altitude: ImplementationAltitude; }
```
#### `UpsertRunWorkspaceMetadataInput`

```typescript
interface UpsertRunWorkspaceMetadataInput { readonly runId: string; readonly workspaceHandle: string; readonly workspaceRepoRoot: string; readonly provisionedBaseRef?: string | null; readonly createdAt: string; }
```
#### `RunWorkspaceMetadata`

```typescript
interface RunWorkspaceMetadata { readonly runId: string; readonly workspaceHandle: string; readonly workspaceRepoRoot: string; readonly provisionedBaseRef?: string | null; readonly createdAt: string; }
```
#### `RunWorkspaceMetadataRepository`

```typescript
interface RunWorkspaceMetadataRepository { upsert(input: UpsertRunWorkspaceMetadataInput): Promise; findByRunId(runId: string): Promise; }
```
#### `ProvisionWorkspaceResult`

```typescript
type ProvisionWorkspaceResult = { readonly shape: 'none'; readonly runId: string; } | { readonly shape: 'scratch_only'; readonly runId: string; readonly workspaceRoot: string; readonly runRoot: string; readonly scratchRoot: string; } | { readonly shape: 'two_roots'; readonly runId: string; readonly workspaceRoot: string; readonly runRoot: string; readonly repoRoot: string; readonly scratchRoot: string; readonly hostRepositoryPath: string; readonly branchName: string; readonly provisionedBaseRef: string; }
```
#### `ChangedFileStatus`

```typescript
type ChangedFileStatus = 'added' | 'modified' | 'renamed' | 'deleted';
```
#### `ChangedFileEntry`

```typescript
interface ChangedFileEntry { readonly path: string; readonly status: ChangedFileStatus; readonly previousPath?: string; }
```
#### `GetChangedFilesInput`

```typescript
interface GetChangedFilesInput { readonly workspaceRepoRoot: string; readonly baseRef: string; readonly headRef?: string; }
```
#### `RunWorkspaceGitPort`

```typescript
interface RunWorkspaceGitPort { commitFiles(input: RunWorkspaceCommitFilesInput): Promise; captureCheckpointRef(input: CaptureCheckpointRefInput): Promise; readFileAtRef(input: ReadFileAtRefInput): Promise; listFilesAtRef(input: ListFilesAtRefInput): Promise; getChangedFiles(input: GetChangedFilesInput): Promise; readonly reviewerPolicy: ReviewerWorkspacePolicy; }
```
#### `ImplementationSummaryRoundInput`

```typescript
interface ImplementationSummaryRoundInput { readonly fixSummary?: string; readonly changedFiles?: readonly string[]; readonly validation?: readonly string[]; readonly followUps?: readonly string[]; readonly nonGoals?: readonly string[]; }
```
#### `CumulativeImplementationSummary`

```typescript
interface CumulativeImplementationSummary { readonly kind: 'cumulative_implementation_summary'; readonly cumulativeSummary: string; readonly changedFiles: readonly string[]; readonly validationSummary: readonly string[]; readonly followUps: readonly string[]; readonly nonGoals: readonly string[]; readonly sourceRoundCount: number; readonly completedAt: string; }
```
#### `DeriveConventionalTitleInput`

```typescript
interface DeriveConventionalTitleInput { readonly workKind: string; readonly titleSubject?: string | null; readonly reconciledSummary?: string | null; readonly cumulativeSummary?: string | null; readonly changedFiles?: readonly string[]; }
```
#### `BuildPullRequestContentInput`

```typescript
interface BuildPullRequestContentInput { readonly workKind: string; readonly issueUrl?: string | null; readonly cumulativeSummary: CumulativeImplementationSummary; readonly reconciledSummary?: string | null; readonly titleSubject?: string | null; }
```
#### `PullRequestOpenHandlerDependencies`

```typescript
interface PullRequestOpenHandlerDependencies { readonly runs: RunRepository; readonly conversations: ConversationRepository; readonly topics: TopicRepository; readonly projects: ProjectRepository; readonly pullRequests: PullRequestRepository; readonly runSteps: RunStepRepository; readonly runWorkspaceMetadata: RunWorkspaceMetadataRepository; readonly runWorkspaceGit: Pick; readonly codeHosts: CodeHostRegistry; readonly resolveCredential: (ref: unknown) => Promise; readonly events: RunEventPublisher; readonly applyDirective: (input: ApplyOrchestratedDirectiveInput) => Promise; readonly clock: () => string; }
```
### Notes

This artifact proposes additive TypeScript APIs for issue 84. It intentionally does not add routes, SDK methods, UI components, code-host providers, or PR lifecycle schema changes beyond checkpoint JSON tolerance. It does require nullable internal `run_workspace_metadata.provisioned_base_ref` storage/hydration. Existing title/content functions remain centralized; optional changed-path inputs and helpers are backward-compatible fallbacks. The root placeholder source is addressed in packages/core/src/orchestrator.ts by persisting RunWorkspaceCommitResult.changedFilePaths and using buildImplementationSummaryRoundInputs instead of inline placeholder synthesis. The base-ref decision is resolved by adding RunWorkspaceMetadata.provisionedBaseRef: packages/execution/src/internal/workspace-provisioner.ts returns the exact resolved baseRef used for git worktree creation, apps/control-plane/src/server.ts persists it via RunWorkspaceMetadataRepository.upsert, and packages/core/src/pr-open-handler.ts passes it to RunWorkspaceGitPort.getChangedFiles. Legacy workspace metadata may lack provisionedBaseRef; only in that case may [pr.open](http://pr.open) use the configured project/code-host binding base branch as the provisioner-guaranteed local tracking ref, never the currently checked-out branch name. Because current persistence does not expose this field, implementation must add internal nullable storage/hydration for run_workspace_metadata.provisioned_base_ref or an equivalent metadata column; this is internal metadata, not a public API schema. convergenceRoundRecordSchema intentionally follows the spec's field-level default pattern for changedFilePaths instead of a top-level ZodEffects wrapper, preserving nested Zod error paths while still producing a readonly changedFilePaths type. Unsupported or unavailable final branch diff recovery should degrade to persisted real summary data and must not render legacy placeholder strings.
## Task list

### Story 1: Preserve real changed paths in implementation checkpoints

**Description:** Carry repository-relative changed file paths from host-controlled implementation commits into each `implementation.build` convergence round without changing public workflow schemas.
**Dependencies:** None.
#### Task T-001: Add `changedFilePaths` to convergence round records

**Description:** Update `packages/api-contract/src/convergence.ts` so `convergenceRoundRecordSchema` accepts and returns a readonly `changedFilePaths` array with a field-level default of `[]`.
**Acceptance criteria:**
- `ConvergenceRoundRecord` includes `readonly changedFilePaths: readonly string[]`.
- Old checkpoint JSON without `changedFilePaths` still parses and returns an empty array.
- Invalid entries, including empty strings, produce normal nested Zod errors at `changedFilePaths[index]`.
- Existing `changedFileCount` behavior remains unchanged.
**Dependencies:** None.
#### Task T-002: Normalize and persist commit changed paths in convergence rounds

**Description:** Update `packages/core/src/orchestrator.ts` and any convergence-engine checkpoint writers so implementation rounds store normalized `RunWorkspaceCommitResult.changedFilePaths` alongside `changedFileCount`.
**Acceptance criteria:**
- Paths are repository-relative, use forward slashes, contain no leading slash, and contain no `..` segment.
- Per-round changed paths are deduplicated and sorted before persistence.
- Test seams that only provide a count can still persist an empty path array.
- No checkpoint writer adds count-only strings to changed path fields.
**Dependencies:** T-001.
#### Task T-003: Cover checkpoint path persistence with orchestrator tests

**Description:** Add or update `packages/core/src/orchestrator.spec.ts` coverage for `implementation.build` convergence checkpoint enrichment.
**Acceptance criteria:**
- A successful implementation commit with real `changedFilePaths` records those paths in the convergence round checkpoint.
- A clean reviewed round does not write `Round N: implementation passed review` into checkpoint-derived summary data.
- A count-only commit result does not invent `round N: M file(s) changed`.
- Tests cover path normalization and deduplication through the checkpoint path.
**Dependencies:** T-002.
### Story 2: Persist and expose the exact workspace base ref

**Description:** Store the base ref used when the run branch is provisioned so `pr.open` can diff against the intended base after process restarts.
**Dependencies:** None.
#### Task T-004: Return `provisionedBaseRef` from workspace provisioning

**Description:** Update `packages/execution/src/workspace.ts` and `packages/execution/src/internal/workspace-provisioner.ts` so `two_roots` provisioning returns the exact base ref passed to worktree creation.
**Acceptance criteria:**
- `ProvisionWorkspaceResult` for `two_roots` includes `provisionedBaseRef`.
- The value matches the resolved base ref used by the worktree driver.
- Non-repository workspace shapes keep their current result shapes.
- Workspace provisioning tests assert the new field for `two_roots` workspaces.
**Dependencies:** None.
#### Task T-005: Persist `provisionedBaseRef` in run workspace metadata

**Description:** Update `packages/core/src/domain-repositories.ts`, `packages/persistence/src/schema.ts`, and `packages/persistence/src/domain-repositories.ts` to store and hydrate nullable `provisionedBaseRef`.
**Acceptance criteria:**
- `UpsertRunWorkspaceMetadataInput` and `RunWorkspaceMetadata` include optional nullable `provisionedBaseRef`.
- The persistence schema includes a nullable internal metadata column or equivalent storage.
- Repository upsert writes the value when supplied and preserves compatibility when omitted.
- Repository reads return `null` or `undefined` for legacy rows without the value.
**Dependencies:** T-004.
#### Task T-006: Wire base-ref metadata persistence from control-plane server setup

**Description:** Update `apps/control-plane/src/server.ts` wherever workspace provisioning or workspace-root callbacks persist run workspace metadata so the `two_roots` `provisionedBaseRef` is included.
**Acceptance criteria:**
- Run workspace metadata created during production dispatch includes `provisionedBaseRef` for repository-backed runs.
- Existing scratch-only and no-workspace paths still persist only their supported metadata.
- Tests or existing integration helpers prove `findByRunId` can return the stored base ref after provisioning.
**Dependencies:** T-005.
### Story 3: Add a host-controlled branch diff seam

**Description:** Provide deterministic base-to-head changed-file recovery through the existing workspace-git boundary, including deletions and renames.
**Dependencies:** T-004, T-005, T-006.
#### Task T-007: Extend `RunWorkspaceGitPort` with branch diff types and method

**Description:** Update `packages/core/src/run-workspace-git.ts` with `ChangedFileStatus`, `ChangedFileEntry`, `GetChangedFilesInput`, and `RunWorkspaceGitPort.getChangedFiles`.
**Acceptance criteria:**
- The new types match the Converged API section.
- `getChangedFiles` requires an explicit `baseRef` and accepts optional `headRef`.
- Existing port consumers compile after adding the method to test fakes or narrowed dependency picks.
- No agent, route, or PR-rendering code shells out directly for diff data.
**Dependencies:** T-005.
#### Task T-008: Implement branch diff recovery in the control-plane git port

**Description:** Update `apps/control-plane/src/run-workspace-git-port.ts` so `getChangedFiles` runs a contained argument-array git diff and maps results to provider-neutral entries.
**Acceptance criteria:**
- The implementation validates `workspaceRepoRoot` containment before running git.
- The git invocation uses argument arrays, not shell strings.
- Added, modified, renamed, and deleted files are returned as repository-relative normalized paths.
- Rename entries use the new path as `path` and the old path as `previousPath`.
- Unsafe refs or unsafe paths fail with sanitized codes described in the Converged API.
**Dependencies:** T-007.
#### Task T-009: Test the concrete branch diff port

**Description:** Add `apps/control-plane/src/run-workspace-git-port.spec.ts` coverage for `getChangedFiles`.
**Acceptance criteria:**
- Tests cover added, modified, renamed, and deleted paths.
- Tests prove output paths are normalized, deduplicated or stable as specified, and repository-relative.
- Tests reject workspace roots outside configured workspace containment.
- Tests reject malformed refs and unsafe reported paths with sanitized errors.
**Dependencies:** T-008.
### Story 4: Build cumulative implementation summaries from real signals only

**Description:** Centralize convergence-round-to-summary mapping so cumulative summaries preserve real implementation content and never create human-facing placeholders.
**Dependencies:** T-001, T-002, T-003.
#### Task T-010: Add summary path helpers and round-input builder

**Description:** Update `packages/core/src/implementation-summary.ts` with `buildImplementationSummaryRoundInputs`, `mergeChangedFiles`, and `summarizeChangedPaths`.
**Acceptance criteria:**
- `buildImplementationSummaryRoundInputs` maps disposition summaries and real `changedFilePaths` into `ImplementationSummaryRoundInput`.
- The helper omits empty fields instead of filling them with placeholder text.
- `mergeChangedFiles` normalizes, deduplicates, and sorts repository-relative paths from multiple sources.
- `summarizeChangedPaths` returns a bounded deterministic sentence when changed paths exist and an empty string when they do not.
**Dependencies:** T-001, T-002.
#### Task T-011: Remove placeholder synthesis from cumulative summary folding

**Description:** Update `buildCumulativeImplementationSummary` callers so clean rounds do not synthesize `Round N: implementation passed review` and changed files come from real paths only.
**Acceptance criteria:**
- `packages/core/src/orchestrator.ts` uses `buildImplementationSummaryRoundInputs` instead of inline placeholder mapping.
- `CumulativeImplementationSummary.changedFiles` contains real paths only.
- `CumulativeImplementationSummary.cumulativeSummary` does not include round-pass text or count-only changed-file text.
- Missing real summary text degrades to changed-path-derived text only at the rendering/fallback stage.
**Dependencies:** T-010.
#### Task T-012: Cover implementation summary behavior with unit tests

**Description:** Update `packages/core/src/implementation-summary.spec.ts` for real changed paths, path merging, fallback summaries, and placeholder regression cases.
**Acceptance criteria:**
- Tests prove changed paths fold across rounds, deduplicate, and sort.
- Tests prove real fix summaries are preserved.
- Tests prove clean rounds with no findings add no placeholder summary text.
- Tests prove `round N`, `implementation passed review`, and `file(s) changed` placeholders are not produced.
**Dependencies:** T-011.
### Story 5: Render PR titles and bodies from reconciled real-change data

**Description:** Merge persisted implementation paths with final branch diff paths at `pr.open`, then use that renderable summary to build the PR title and body.
**Dependencies:** T-006, T-008, T-010, T-011, T-012.
#### Task T-013: Add changed-path-derived conventional title fallback

**Description:** Update `packages/core/src/conventional-title.ts` with `deriveChangedPathSubject` and optional `changedFiles` input support for `deriveConventionalTitle`.
**Acceptance criteria:**
- `titleSubject` remains the first source when present.
- `reconciledSummary` remains the next source when present.
- Cumulative summary text remains preferred over path-derived subjects when it contains real content.
- Changed paths can produce a deterministic conventional title subject when summary text is absent.
- The derived subject never contains absolute paths and still passes existing normalization.
**Dependencies:** T-010.
#### Task T-014: Harden PR content rendering against legacy placeholders

**Description:** Update `packages/core/src/pr-content.ts` so the body renders real changed paths and defensively drops known count-only placeholder entries from older checkpoints.
**Acceptance criteria:**
- `buildPullRequestContent` renders `## Changed files` with repository-relative paths only.
- `reconciledSummary` continues to take precedence over cumulative summary text.
- Legacy entries matching `round N: M file(s) changed` or `M file(s) changed` are not rendered.
- The defensive filter does not hide valid file names or replace the upstream fixes.
**Dependencies:** T-010, T-013.
#### Task T-015: Recover final branch diff paths in `pr.open`

**Description:** Update `packages/core/src/pr-open-handler.ts` to load run workspace metadata, resolve the explicit base ref, call `RunWorkspaceGitPort.getChangedFiles`, merge those paths with persisted cumulative paths, and pass the renderable summary into PR content builders.
**Acceptance criteria:**
- `PullRequestOpenHandlerDependencies` includes `runWorkspaceMetadata` and `runWorkspaceGit: Pick`.
- `baseRef` uses `RunWorkspaceMetadata.provisionedBaseRef` when available.
- Legacy rows without `provisionedBaseRef` may fall back only to the configured binding base branch tracking ref.
- The current checked-out branch name is never used as the base ref.
- Diff recovery failures are sanitized and degrade only as allowed by the tech spec.
- The renderable summary merges persisted paths with final diff paths before `buildPullRequestContent`.
**Dependencies:** T-006, T-008, T-014.
#### Task T-016: Cover PR title, body, and open-handler fallback behavior

**Description:** Add targeted tests in `packages/core/src/conventional-title.spec.ts`, `packages/core/src/pr-content.spec.ts`, and `packages/core/src/pr-open-handler.spec.ts`.
**Acceptance criteria:**
- Title tests cover absent `titleSubject` and `reconciledSummary` with real summary text, changed paths, and the generic fallback.
- Body tests cover real changed paths, reconciled-summary precedence, and legacy placeholder filtering.
- Open-handler tests prove final diff paths are merged before PR creation.
- Regression assertions fail if title or body contains `round N`, `implementation passed review`, or count-only `file(s) changed` placeholders.
**Dependencies:** T-013, T-014, T-015.
### Story 6: Prove the sparse `pr.finalize` flow end to end

**Description:** Exercise the issue 84 behavior through integration tests and keep repository navigation and validation current.
**Dependencies:** T-001, T-002, T-003, T-004, T-005, T-006, T-007, T-008, T-009, T-010, T-011, T-012, T-013, T-014, T-015, T-016.
#### Task T-017: Add sparse-finalize PR lifecycle integration coverage

**Description:** Update `apps/control-plane/src/pr-lifecycle.integration.spec.ts` so a run whose `pr.finalize` result normalizes from `{}` to clean advance opens a PR with real fallback content.
**Acceptance criteria:**
- The test drives `implementation.build` through `pr.finalize` returning `{}` and then `pr.open`.
- The captured PR create call has a conventional-commit title with a real subject.
- The PR body includes real repository-relative changed paths.
- The PR title and body exclude `round N`, `implementation passed review`, and count-only `file(s) changed` placeholders.
- Existing blocker and revise behavior for `pr.finalize` remains covered or unchanged.
**Dependencies:** T-015, T-016.
#### Task T-018: Update exports, package fakes, and boundary coverage

**Description:** Export new helpers and types from the appropriate package entry points, update test fakes for added port methods, and keep existing boundary tests green.
**Acceptance criteria:**
- Public package exports include only the helpers and types named in the Converged API section.
- Existing tests compile after all `RunWorkspaceGitPort` fakes are updated or narrowed.
- `tools/boundary-tests/assert-gh-pr-boundary.mjs` remains valid.
- Any new git execution site is covered by an appropriate boundary test or is contained in the existing workspace-git port.
**Dependencies:** T-007, T-010, T-013, T-015.
#### Task T-019: Update agent navigation documentation

**Description:** Update `context-agent/wiki/code-map.md` for changed checkpoint schema, workspace metadata base-ref persistence, branch diff recovery, summary helpers, PR content rendering, and the new tests.
**Acceptance criteria:**
- The code map points future agents to the new or changed modules.
- The notes mention `provisionedBaseRef` as the source for `pr.open` branch diff base selection.
- The notes mention that changed-file PR content flows through `RunWorkspaceGitPort.getChangedFiles`, not direct shelling from PR code.
- No human-facing requirements, design, tech spec, or Converged API text is changed as part of this documentation task unless implementation discovers an approved spec gap.
**Dependencies:** T-018.
#### Task T-020: Run targeted and broad validation

**Description:** Run the targeted tests from the tech spec and the broader validation suite when practical.
**Acceptance criteria:**
- The targeted core tests run: `implementation-summary.spec`, `conventional-title.spec`, `pr-content.spec`, `orchestrator.spec`, and `pr-open-handler.spec`.
- The targeted control-plane tests run: `run-workspace-git-port.spec` and `pr-lifecycle.integration.spec`.
- `pnpm test:boundaries` runs after boundary-affecting changes.
- `pnpm validate` runs when practical, or the implementation handoff states exactly why it was skipped.
- Any failing check is either fixed or documented with the exact failure and remaining risk.
**Dependencies:** T-017, T-018, T-019.
### Dependency graph summary

- Story 1 can start immediately and feeds summary folding in Story 4.
- Story 2 can start immediately and feeds branch diff recovery in Story 3.
- Story 3 depends on base-ref persistence from Story 2.
- Story 4 depends on changed-path checkpoint support from Story 1.
- Story 5 depends on the branch diff seam from Story 3 and summary helpers from Story 4.
- Story 6 validates the end-to-end flow after Stories 1 through 5 are complete.