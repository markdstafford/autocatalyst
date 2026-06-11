---
created: 2026-06-11
last_updated: 2026-06-11
status: complete
issue: 37
specced_by: autocatalyst
---
# Feature: Runtime skills catalog resolution and agent-session materialization

## Product requirements

### What

Add a runtime-owned skills catalog that resolves provider-neutral skill refs before an agent session starts, then materializes the resolved skills into each supported agent backend.
A run can request a skill such as `mm:planning`. The runtime loads that skill from a committed catalog, follows its transitive dependencies, validates that all declared files and dependency refs exist, and carries the resolved set into the `ExecutionContext` and `MaterializedExecutionEnvironment`. If a requested skill is unknown, malformed, or part of a dependency cycle, the run fails before provider work starts.
For this feature, the catalog covers the B1 file-canonical spec-authoring skill set: `mm:planning` and the committed authoring support skill it genuinely invokes, `mm:writing-guidelines`. Route-to-skill configuration remains hard-coded for now: `spec.author` requests `mm:planning` only for the file-canonical workflows that author spec artifacts in this slice (`feature` and `enhancement`); the catalog dependency graph supplies the required support skills. Issue-canonical workflows such as `bug`, `chore`, and `file_issue` do not receive `mm:planning` in this slice. Their concept-canonical `mm:issue-triage` routing remains out of scope until the catalog expands beyond the B1 authoring manifest. Human-gate and pause steps such as `spec.awaiting_input` and `spec.human_review` do not receive the bundle. Declarative `(workflow, step, role)` skill routing is out of scope.
Autocatalyst owns each run's git branch, worktree, push, merge, PR, and session lifecycle. The runtime skills catalog must not provision skill guidance that instructs an agent to create branches or worktrees, switch branches, push, merge, or open PRs. Because runtime-ownership prompt instructions are not part of this issue, this feature avoids provisioning that guidance at the catalog asset level instead of relying on a guardrail that does not exist yet.
### Why

Autocatalyst delegates planning, triage, and implementation methods to runtime skills, but current execution only passes skill strings through as flat data. That creates a gap between the product contract and the running agent session: no catalog verifies that a skill exists, no dependency resolver ensures required support skills are present, and adapters do not receive a backend-ready skill bundle.
This feature makes skills a real runtime asset. It lets every agent backend run from the same committed catalog, fail fast on broken setup, and keep provider-specific representation inside the adapter. It also preserves the Execution Context as the single source of truth for what a run is allowed and expected to use.
### Goals

- Commit a runtime-owned skills catalog and index with the B1 manifest entries for `mm:planning` and `mm:writing-guidelines`.
- Vendor the genuine `mm:planning` and `mm:writing-guidelines` skill bodies into the runtime catalog, aligned for Autocatalyst spec authoring.
- Scope the vendored `mm:planning` body to authoring stages and remove or neutralize any implementation-handoff, branch, worktree, push, merge, or PR guidance before it can be provisioned to an agent session.
- Validate the catalog at startup or composition time so malformed entries, missing file paths, and missing dependency refs are caught before a session starts.
- Resolve requested skills transitively with deterministic ordering and cycle detection.
- Fail before provider work starts when a requested or depended-on skill is missing, malformed, or cyclic.
- Replace the current `ExecutionContext.skills` passthrough with a resolved skill bundle that records requested refs and resolved catalog entries.
- Carry resolved skills from core context resolution through execution materialization into agent adapters.
- Materialize resolved skills into the Claude agent cell using the actual skill/plugin input shape expected by the Claude Agent SDK path.
- Materialize resolved skills into the OpenAI agent cell as sandbox-visible files or capability data in the `UnixLocalSandboxClient` session.
- Keep provider-neutral skill refs and dependency resolution outside provider adapters.
- Keep provider-specific materialization details inside each adapter.
- Export the new resolver and catalog boundary from `packages/execution/src/index.ts` so core imports through `@autocatalyst/execution`, not deep `@autocatalyst/execution/src/*` paths.
- Cover both agent cells with tests that prove B1 skills are present in the backend session setup.
- Update agent-owned navigation docs during implementation for the new catalog, resolver, and materialization path.
### Non-goals

- Building the declarative `(workflow, step, role)` route-to-skill mapping. This feature hard-codes the B1 workflow-plus-step allowlist for file-canonical spec authoring.
- Changing model routing, role resolution, profile resolution, or provider selection.
- Implementing tool-policy routing or per-route least-privilege tool configuration.
- Emitting the future typed provisioning-visibility event at session start.
- Injecting the future runtime-ownership instruction block into skill-driven prompts.
- Supporting externally sourced skills, version pinning, startup integrity checks beyond committed catalog validation, or dependency-missing graceful disable.
- Expanding the catalog beyond the explicit B1 authoring manifest for `mm:planning` and `mm:writing-guidelines`.
- Provisioning `superpowers:using-git-worktrees`, `superpowers:finishing-a-development-branch`, or any other git/session-lifecycle skill.
- Provisioning `superpowers:writing-plans` for B1 unless a future approved spec expands the flow beyond spec authoring; the real `mm:planning` reference to that skill is in implementation handoff, not authoring.
- Provisioning `superpowers:brainstorming`; brainstorming belongs to a future brainstorming intent and is not a dependency of the planning skill today.
- Adding UI, desktop, or mobile surfaces for viewing skill provisioning.
- Adding branch, worktree, push, merge, or PR-management behavior.
### Personas

- **Enzo (Engineer)** needs a committed catalog and resolver so skills can be used in runs without copying ad hoc files into adapters.
- **Opal (Operator)** needs broken skill setup to fail before a paid provider session starts, with safe typed errors.
- **Phoebe (PM)** needs Autocatalyst's spec-authoring flow to use the same aligned `mm:planning` skill regardless of whether Claude or OpenAI runs the session.
- **Rina (Runtime maintainer)** needs provider-specific materialization to stay isolated in the adapter while the catalog and dependency graph stay provider-neutral.
### User stories

- As Enzo, I can inspect one committed skills index and see each skill ref, its file location, and its dependencies.
- As Enzo, I can request `mm:planning` and receive a resolved set that includes the B1 authoring support dependency named in the catalog manifest.
- As Enzo, I can test missing dependencies, transitive dependencies, and cycles without starting a provider session.
- As Opal, I can trust that malformed skills fail with safe typed errors before provider calls, process launches, or sandbox sessions begin.
- As Opal, I can run either Claude or OpenAI agent sessions and know the required B1 skills are available to the backend.
- As Phoebe, I can rely on spec-authoring runs having the planning skill available without asking humans to configure local editor plugins.
- As Rina, I can add a new backend materializer later without changing catalog dependency resolution.
### Acceptance criteria

#### Catalog and index

- A committed runtime skills catalog exists in the application source tree, separate from `context-agent/` and `context-human/`.
- The catalog index declares each skill by provider-neutral `namespace:skill` ref.
- Each catalog entry declares its file or directory location using a path relative to the catalog root or application root; catalog-relative `assetPath` is preferred over an absolute path in shared schemas.
- Each catalog entry declares dependency refs as provider-neutral `namespace:skill` strings.
- The B1 catalog includes exactly the manifest entries named in Catalog design: `mm:planning` and `mm:writing-guidelines`.
- The catalog does not include `superpowers:using-git-worktrees`, `superpowers:finishing-a-development-branch`, `superpowers:writing-plans`, or `superpowers:brainstorming` for this slice.
- Catalog paths are treated as runtime assets. They are not read from a developer's local editor configuration.
- The committed catalog vendors the genuine `mm:planning` and `mm:writing-guidelines` skill bodies, not placeholder-only `SKILL.md` stubs.
- The vendored `mm:planning` body is aligned to Autocatalyst ownership: authoring guidance is retained, while implementation-handoff and any branch, worktree, push, merge, or PR guidance is stripped or neutralized.
- The catalog's dependency edges are derived from the aligned authoring body that Autocatalyst provisions, not from raw upstream skill stages that are not provisioned.
- Tests assert that the committed index parses and that every declared file location exists.
- Tests assert that every dependency ref in the committed index resolves to another catalog entry.
- Tests inspect the vendored B1 assets enough to catch accidental inclusion of forbidden git/session-lifecycle refs or instructions.
#### Dependency resolution

- A skill resolver accepts a requested list of refs and returns the transitive closure of catalog entries.
- Resolution includes direct and transitive dependencies, not only the initially requested refs.
- Resolution is deterministic. Given the same catalog and requested refs, it returns the same ordered result.
- Duplicate requested refs or duplicate dependency paths do not produce duplicate resolved entries.
- Missing requested refs fail with a typed resolver error before provider work starts.
- Missing dependency refs fail with a typed resolver error before provider work starts.
- Malformed catalog entries fail with a typed resolver error before provider work starts.
- Dependency cycles fail with a typed resolver error before provider work starts.
- Tests cover successful B1 resolution, synthetic multi-hop transitive resolution, duplicate de-duplication, missing requested refs, missing dependency refs, malformed entries, and cycle detection.
#### Execution Context and materialized environment

- `ExecutionContext.skills` carries enough structured data to distinguish requested refs from resolved catalog entries.
- The post-resolution structure is defined in `packages/api-contract/src/execution-context.ts` with Zod schemas and inferred types.
- The shared schema should prefer catalog-relative `assetPath`; execution-side helpers can resolve those paths to absolute filesystem locations after validation for adapter use.
- `packages/core/src/execution-context-resolver.ts` resolves the hard-coded B1 skill request for file-canonical `spec.author` runs before returning an `ExecutionContext`.
- The hard-coded mapper keys on workflow plus step ID for this slice: `spec.author` in `feature` and `enhancement` workflows receives `mm:planning`; `spec.author` in `bug`, `chore`, and `file_issue` workflows receives no B1 planning bundle because those issue-canonical paths require the future `mm:issue-triage` catalog/routing work.
- Human steps keep their current behavior unless they explicitly request B1 skills through the resolver seam.
- `packages/execution/src/internal/execution-materializer.ts` carries the resolved skill bundle into `MaterializedExecutionEnvironment.skills` without re-resolving dependencies.
- The materializer fails before `AgentProviderAdapter.startSession`, Claude process launch, OpenAI sandbox creation, or provider traffic when the context contains an invalid resolved skill bundle. Creating a side-effect-free runner object before materialization is acceptable; starting provider work is not.
- Existing tests that construct execution contexts are updated to use the new shape.
- Tests assert that resolved skills are present in the `ExecutionContext` and still present in the `MaterializedExecutionEnvironment` delivered to runner code.
#### Claude agent materialization

- `packages/claude-agent-adapter/src/claude-agent-adapter.ts` no longer forwards only raw `env.skills.requested` strings as the skill contract.
- The Claude adapter receives resolved skill entries and materializes them into the actual plugin, skill, or option shape expected by the Claude Agent SDK path.
- The implementation verifies the Claude SDK skill/plugin input shape instead of assuming the current `options.skills` field and shape are correct.
- Plugin materialization uses catalog-declared file locations, not inferred local paths.
- The adapter fails with a sanitized typed error if a required resolved skill cannot be represented in the Claude backend.
- Tests assert that requesting `mm:planning` causes the Claude session setup to include the resolved B1 plugin tree or SDK-equivalent skill entries.
- Tests assert that no raw secrets, full prompts, or workspace file contents appear in Claude skill-materialization errors or logs.
#### OpenAI agent materialization

- `packages/openai-agent-adapter/src/openai-agent-adapter.ts` materializes resolved skills into the local sandbox session used by `UnixLocalSandboxClient`.
- Skill files are present in the sandbox-visible filesystem or capability representation before the OpenAI agent session starts.
- The OpenAI session input includes a discoverability contract for staged skills: a sandbox-visible skills root, a per-skill manifest mapping refs to sandbox-visible `SKILL.md` paths, and a safe prompt/capability/session-metadata hint that tells the agent where to find and how to load the staged runtime skills.
- Skill file materialization is scoped to declared runtime assets and does not expose unrelated repository files.
- OpenAI sandbox manifest construction remains rooted in declared workspace and runtime asset paths with containment checks.
- The adapter fails with a sanitized typed error if a required resolved skill cannot be represented in the OpenAI backend.
- Tests assert that requesting `mm:planning` causes the OpenAI sandbox manifest or fake sandbox session to receive the resolved B1 skill files.
- Tests assert that the OpenAI session setup receives the skill-discovery metadata or prompt/capability hint, not only that files were staged on the host.
- Tests assert that no raw secrets, full prompts, provider responses, or workspace file contents appear in OpenAI skill-materialization errors or logs.
#### Fail-before-session behavior

- Catalog and resolver failures occur before `AgentProviderAdapter.startSession` is called.
- Catalog and resolver failures occur before a Claude process is launched.
- Catalog and resolver failures occur before an OpenAI sandbox session is opened or provider call is made.
- Integration tests use fake adapters or spies to prove no provider session starts after a missing skill, malformed entry, or cycle error.
- Error objects use typed codes and safe details. They do not include raw file contents, prompt text, credentials, or provider responses.
#### Integration coverage and documentation

- Unit tests cover catalog parsing and dependency resolution.
- Execution tests cover context resolution and materialization of resolved skills.
- Claude adapter tests cover backend plugin materialization for the B1 skill set.
- OpenAI adapter tests cover sandbox materialization for the B1 skill set.
- At least one integration test drives an agent session through production seams for Claude and asserts B1 skills are materialized.
- At least one integration test drives an agent session through production seams for OpenAI and asserts B1 skills are materialized.
- `context-agent/wiki/code-map.md` is updated during implementation for the catalog location, resolver module, schema changes, and adapter materialization changes.
- `packages/execution/src/index.ts` exports the catalog values and `resolveSkills` API so boundary lint permits core imports through `@autocatalyst/execution`.
### References

- Issue: [https://github.com/markdstafford/autocatalyst/issues/37](https://github.com/markdstafford/autocatalyst/issues/37)
- `context-human/spec.md`
- `context-human/concepts/runtime-skills.md`
- `context-human/concepts/agent-runners.md`
- `context-human/concepts/execution-runtime.md`
- `context-human/concepts/model-routing.md`
- `context-human/concepts/workflow.md`
- `context-human/adrs/adr-010-agent-execution-context.md`
- `context-human/adrs/adr-012-llm-output-tolerance.md`
- `context-human/adrs/adr-022-runner-structure.md`
- `context-human/adrs/adr-023-request-alteration-boundary.md`
- `context-human/adrs/adr-025-workflow-step-catalog.md`
- `context-human/adrs/adr-027-step-contract-verification.md`
- `context-agent/standards/api-conventions.md`
- `context-agent/standards/logging.md`
- `context-agent/wiki/code-map.md`
- `packages/api-contract/src/execution-context.ts`
- `packages/core/src/execution-context-resolver.ts`
- `packages/execution/src/index.ts`
- `packages/execution/src/materialized-environment.ts`
- `packages/execution/src/internal/execution-materializer.ts`
- `packages/claude-agent-adapter/src/claude-agent-adapter.ts`
- `packages/openai-agent-adapter/src/openai-agent-adapter.ts`
## Design spec

### Design scope

This is a backend runtime feature. It adds no screens, visual components, or user-facing copy.
The design work is the shape of a committed catalog, the failure behavior around catalog resolution, the data carried in the Execution Context, and the backend materialization path for Claude and OpenAI agent sessions.
### Runtime experience

A run at a file-canonical `spec.author` AI step requests the B1 skill bundle. The runtime resolves `mm:planning`, follows its dependencies, and builds a resolved skill set. The agent backend receives materialized files or plugin configuration that makes those skills available during the session.
If the catalog is broken, the run fails during setup. The operator sees a safe failure code that identifies skill catalog setup, not a vague provider failure. No provider process, provider HTTP request, or sandbox session starts after a catalog-resolution error.
The runtime does not rely on deferred runtime-ownership instructions to override skill content. Instead, the skill content committed for this issue is already aligned to Autocatalyst ownership and does not tell the agent to perform git or session-lifecycle operations owned by Autocatalyst.
### Developer experience

The feature should feel like a normal execution-runtime extension:
1. **Catalog** — committed runtime assets and an index describe available skills and dependencies.
2. **Resolver** — execution resolves requested refs into a structured, provider-neutral result and exports that API through the package boundary.
3. **Execution Context** — the resolved result becomes part of the per-run declarative context.
4. **Materialized environment** — execution carries resolved skills to runner input unchanged.
5. **Adapter materializer** — each adapter turns resolved entries into backend-specific files or plugin options.
A developer should not add provider-specific fields to the catalog for this slice unless a small generic materialization hint is needed. Backend differences belong in adapter code, not in dependency resolution.
### Catalog design

The catalog should live under a runtime-owned source path, for example `packages/execution/src/skills/` or a new package-level asset directory if the implementation chooses to share it across core and execution. It should not live under `context-human/` or `context-agent/`, because those directories are documentation and agent memory, not runtime assets.
The index should use a simple structured format that TypeScript can parse and validate with Zod. JSON is preferred if the catalog is static data. A TypeScript module is acceptable if it improves bundling of asset paths, but the exported value must still be validated.
Each entry should contain:
- `ref`: provider-neutral skill ref, such as `mm:planning`.
- `assetPath`: path to the skill root directory or file set, relative to the runtime skills catalog root.
- `dependencies`: zero or more provider-neutral skill refs.
- `description`: short safe human-readable description for diagnostics.
The B1 catalog for this slice is explicit and limited to the following committed entries. If implementation discovers that the aligned authoring `mm:planning` body needs another committed support skill, that is a spec change rather than an implicit implementation choice.

Ref
Expected catalog asset path
Minimum committed files
Dependencies

`mm:planning`
`assets/mm/planning/`
Genuine aligned `SKILL.md` plus any authoring-stage template/reference files the vendored planning skill links to
`mm:writing-guidelines`

`mm:writing-guidelines`
`assets/mm/writing-guidelines/`
Genuine `SKILL.md` plus any linked writing-guidance files
none

The corresponding catalog index should be equivalent to this manifest excerpt, with `assetPath` values relative to `runtimeSkillsCatalogRoot`:
```typescript
[
  {
    ref: 'mm:planning',
    assetPath: 'assets/mm/planning',
    dependencies: ['mm:writing-guidelines'],
    description: 'Micromanager planning workflow for Autocatalyst spec authoring.'
  },
  {
    ref: 'mm:writing-guidelines',
    assetPath: 'assets/mm/writing-guidelines',
    dependencies: [],
    description: 'Writing guidance used when drafting planning artifacts.'
  }
]
```
Do not add `superpowers:using-git-worktrees` or `superpowers:finishing-a-development-branch`. The raw upstream planning skill references those in its implementation-handoff stage, where they drive branch/worktree setup and push/merge/PR decisions. That stage conflicts with Autocatalyst's owned per-run workspace and is not provisioned in this issue.
Do not add `superpowers:writing-plans` to the B1 authoring catalog. In the real planning skill, that support is referenced for implementation handoff, not spec authoring. Do not add `superpowers:brainstorming`; brainstorming is a separate future intent and is not a dependency of planning today.
The resolver should normalize catalog-relative paths to absolute runtime asset paths only inside execution-side code after validation. It must verify each asset exists and stays inside the allowed catalog asset root. It should expose safe display paths in diagnostics and avoid including file contents in errors.
### Vendored skill body alignment

The catalog must vendor real skill bodies rather than minimal placeholders. The intent of this slice is that the next spec-authoring agent can perform real planning work, not merely pass resolver tests.
The authoritative source for this slice is the micromanager skill bundle supplied in the run workspace at:
- `.agents/mm:planning/SKILL.md`
- `.agents/mm:writing-guidelines/SKILL.md`
Because `.agents/` is session input and not a runtime asset, implementation must copy the approved aligned content into the runtime catalog and record the source path plus SHA-256 for each source `SKILL.md` in a small catalog metadata file such as `assets/mm/SOURCE.json` or an equivalent checked-in fixture. Tests must assert that the recorded source metadata exists for both B1 skills so later updates are deliberate rather than accidental copies from a different local editor setup.
Vendoring `mm:planning` requires reconciliation with Autocatalyst ownership:
- Retain the real authoring stages and guidance that support drafting planning/spec artifacts.
- Retain the invocation of `mm:writing-guidelines` when drafting artifacts.
- Remove or neutralize the implementation-handoff stage if it tells the agent to create or switch branches, set up worktrees, push, merge, open PRs, or decide branch lifecycle.
- Remove references to `superpowers:using-git-worktrees`, `superpowers:finishing-a-development-branch`, and `superpowers:writing-plans` when those references are only part of the stripped handoff stage.
- Ensure dependency edges in the catalog match the aligned body that will be provisioned.
Objective post-alignment checks:
- `mm:planning/SKILL.md` retains the source frontmatter identity, `Core principles`, `When to use`, authoring-stage `Process overview`, `Shared concepts`, `Prerequisite checking`, `Section-by-section checkpoints`, `Approval gates`, `Artifact file management`, `Working with your human`, `Stage routing` for authoring stages, `Artifact structure`, `Roles`, `Scaling`, and `Writing style` content that supports drafting file-canonical specs.
- `mm:planning/SKILL.md` removes the source `Branch setup` section and removes or rewrites `Spec completion` / `Implementation handoff` content so the provisioned skill stops after approved authoring artifacts and returns control to Autocatalyst instead of telling the agent to manage branches, worktrees, implementation handoff, push/merge, or PR lifecycle.
- `mm:planning/SKILL.md` keeps exactly one B1 support-skill invocation, `mm:writing-guidelines`, and does not mention `superpowers:using-git-worktrees`, `superpowers:finishing-a-development-branch`, `superpowers:writing-plans`, or `superpowers:brainstorming`.
- `mm:writing-guidelines/SKILL.md` retains the source frontmatter identity plus `When to use`, `Style principles`, `Document-specific guidance`, `Review checklist`, and `When to break the rules`.
Tests should make this alignment hard to regress. At minimum, committed B1 asset tests should assert that forbidden support-skill refs are not declared and that obvious branch/worktree/push/merge/PR instruction phrases are absent from the provisioned runtime skill body.
### Skill ref and dependency behavior

Skill refs follow the existing concept contract: `namespace:skill`. The implementation should validate this format before resolution. A stricter regex such as `^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$` is acceptable as long as all B1 refs satisfy it.
Resolution should use depth-first traversal with a visited set and an active stack:
- `visited` prevents duplicate entries in the resolved result.
- `active` detects cycles and returns a typed cycle error.
- Dependencies are traversed before or after their parent consistently. Dependency-first ordering is preferred for file materialization because support skills appear before the skill that uses them.
The resolver should return a value, not mutate the catalog. A useful shape is:
```typescript
interface ResolvedSkillBundle {
  readonly requestedRefs: readonly string[];
  readonly resolved: readonly ResolvedSkill[];
}

interface ResolvedSkill {
  readonly ref: string;
  readonly assetPath: string;
  readonly dependencies: readonly string[];
  readonly description?: string;
}
```
The exact field names can change during implementation, but the API contract should preserve the distinction between requested refs and resolved entries. If an adapter requires absolute paths, use an execution-side helper to resolve `assetPath` against the validated catalog root rather than storing host-specific paths in the shared schema.
### Execution Context design

`packages/api-contract/src/execution-context.ts` currently defines:
```typescript
skills: {
  requested: string[];
  plugins?: string[];
}
```
This feature should replace that flat passthrough with a resolved shape. The preferred provider-neutral shape is:
```typescript
skills: {
  requested: string[];
  resolved: Array;
}
```
The schema should stay strict and all tests should construct valid contexts. The materialized environment can mirror this shape or wrap it in adapter-friendly helper types, but it should not re-run dependency resolution. Execution-side materialization may enrich entries with absolute filesystem paths after validating containment.
Hard-coded B1 mapping belongs in the resolver seam for now. The current default `['stub_runner']` is not a real skill contract for production agent sessions. A run whose workflow is `feature` or `enhancement` and whose step ID is exactly `spec.author` should request `mm:planning`; its support skills come from catalog dependencies. `bug`, `chore`, and `file_issue` runs should not receive `mm:planning` from this B1 mapper because their approved concept-canonical skill is `mm:issue-triage`, which is outside this catalog slice. Human steps in the spec phase, including `spec.awaiting_input` and `spec.human_review`, should not request B1 skills. Other steps may keep a no-skill path if tests require it.
Existing fixtures that currently build `skills: { requested: [...] }` or rely on the removed passthrough must be updated, including:
- `packages/core/src/execution-context-resolver.spec.ts` around the assertion that the `stub_runner` default is removed.
- `packages/execution/src/internal/execution-materializer.spec.ts` around the test that `plugins` passthrough is removed.
- `packages/execution/src/execution-run-unit-of-work.spec.ts` around existing execution context fixtures.
- `packages/execution/src/execution-entry-point.spec.ts` around existing execution context fixtures.
- `packages/claude-agent-adapter/src/claude-agent-adapter.spec.ts` around the existing skill option assertions.
### Fail-before-session flow

The setup flow should fail before provider work begins:
1. The run dispatch asks the execution context resolver for a context.
2. The context resolver determines the requested skill refs for the current step.
3. The skill resolver loads the committed catalog and resolves dependencies.
4. The context resolver returns an `ExecutionContext` with resolved skills.
5. Execution materialization validates that the resolved skill assets still exist and are within allowed roots.
6. Only then does execution start provider work by calling `AgentProviderAdapter.startSession`, launching a Claude process, opening an OpenAI sandbox session, or making provider traffic.
If implementation constraints make catalog resolution more natural inside `packages/execution`, the same product invariant still applies: the failure must happen before `AgentProviderAdapter.startSession`, Claude process launch, OpenAI sandbox creation, or provider traffic. A runner factory may create a side-effect-free runner object before this validation boundary if current composition already does so; tests should assert the exact no-provider-side-effect boundary rather than requiring the object factory to move.
### Claude materialization design

The Claude adapter already has a skills option path, but it forwards `env.skills.requested` directly. This feature should turn the resolved skill bundle into the Claude Agent SDK skill/plugin representation.
The implementation must verify the actual Claude Agent SDK input shape for runtime skills. The spec intentionally isolates this behind a helper because the current `options.skills` field may not be the final or correct target. Once verified, the helper should accept provider-neutral resolved skills and return the SDK-facing option shape.
The adapter should build the SDK input from validated catalog-declared asset locations. It should include every resolved B1 skill. It should not discover dependencies again by reading skill files or local editor metadata.
If Claude's SDK expects plugin names, directories, or config files, that mapping should live in a Claude-specific helper. Errors should name the skill ref and a safe reason, not raw file contents.
### OpenAI materialization design

The OpenAI adapter already builds a sandbox manifest from materialized workspace roots. This feature should add runtime skill files to that sandbox-visible environment without broadening access to unrelated repository files.
A safe design is to stage resolved skill directories under a generated skills directory in the scratch root or sandbox base, then grant the sandbox access to that staged directory. Another acceptable design is to add each resolved skill root as a read-only local directory grant if the SDK supports read-only mounts and containment checks remain strict. The implementation should prefer staging if read-only grants are not available or not clear.
The OpenAI adapter must pass a discoverability contract into the session, not only stage files. The contract should include:
- a stable sandbox-visible skills root, for example `/autocatalyst/runtime-skills` or the adapter's equivalent sandbox path;
- a per-skill manifest that maps each resolved ref to the sandbox-visible `SKILL.md` path and any staged linked files;
- a safe session instruction, capability field, or prompt metadata item that tells the OpenAI agent to read applicable runtime skills from that sandbox-visible root before performing the step.
The pointer should be generated by the adapter from the resolved skill bundle. It must use sandbox-visible paths rather than host-only paths.
The adapter must keep the existing no-op snapshot behavior and workspace containment checks. Skill materialization must not reintroduce snapshot persistence or ambient host access.
### Observability and logging design

This feature does not implement the future provisioning-visibility event, but it should still produce useful safe diagnostics in tests and errors.
Safe diagnostic fields include:
- requested skill refs
- resolved skill refs
- catalog entry count
- dependency count
- typed error code
- safe catalog-relative asset path
- provider adapter id
- backend materialization mode, such as `claude_plugin_tree` or `openai_sandbox_files`
Diagnostics must not include:
- skill file contents
- prompt text
- provider request or response bodies
- credential values
- decrypted secret values
- arbitrary workspace file contents
### Integration design

The integration proof should cover both agent cells with fake provider seams and no live network calls.
For Claude, the test should resolve the B1 bundle, dispatch through the agent runner factory or adapter start seam, and assert that the SDK/session options contain the expected plugin tree or SDK-equivalent entries for `mm:planning` and `mm:writing-guidelines`.
For OpenAI, the test should resolve the B1 bundle, dispatch through the OpenAI adapter with a fake sandbox client, and assert that the sandbox manifest or session factory receives the expected skill files or staged skills directory.
The OpenAI integration test should also assert that the fake session input includes the skills root and per-skill discovery manifest or equivalent prompt/capability metadata that an agent can actually use to find the staged `SKILL.md` files.
A separate fail-before-session test should inject a bad catalog or bad resolver result, then assert that no adapter `startSession`, Claude process launch, OpenAI sandbox session, or fetch transport call occurred.
## Tech spec

### Current state

The relevant seams already exist but are flat passthroughs:
- `packages/api-contract/src/execution-context.ts` defines `skillIntentSchema` as `{ requested: string[]; plugins?: string[] }`.
- `packages/core/src/execution-context-resolver.ts` defaults skills to `['stub_runner']` and copies optional `plugins` through.
- `packages/execution/src/materialized-environment.ts` mirrors the same `requested` / optional `plugins` shape.
- `packages/execution/src/internal/execution-materializer.ts` copies `context.skills` into the materialized environment without catalog lookup.
- `packages/claude-agent-adapter/src/claude-agent-adapter.ts` passes `env.skills.requested` as SDK skill options.
- `packages/openai-agent-adapter/src/openai-agent-adapter.ts` builds a sandbox manifest from workspace roots and does not include skill files.
The implementation should preserve existing runner boundaries: core and execution resolve provider-neutral data; adapters materialize backend-specific data.
### Proposed modules

The exact package placement can be adjusted during implementation, but the feature should introduce these responsibilities:
- `packages/api-contract/src/execution-context.ts`
	- Define strict schemas for requested and resolved skills.
	- Export inferred types used by core, execution, and adapters.
- `packages/execution/src/skills/catalog.ts` or equivalent
	- Export the committed B1 catalog index.
	- Define catalog entry validation schemas if the catalog lives in execution.
	- Provide the runtime asset root.
- `packages/execution/src/skills/skill-resolver.ts` or equivalent
	- Resolve requested refs into transitive `ResolvedSkill` entries.
	- Validate missing refs, malformed entries, paths, duplicates, and cycles.
	- Export typed errors with safe details.
- `packages/execution/src/index.ts`
	- Re-export `runtimeSkillsCatalog`, `runtimeSkillsCatalogRoot`, `resolveSkills`, catalog validation helpers needed by core, and resolver error types.
	- Avoid requiring core to import from deep `@autocatalyst/execution/src/*` paths.
- `packages/core/src/execution-context-resolver.ts`
	- Determine the hard-coded B1 skill request for `spec.author`.
	- Invoke the skill resolver through the execution package boundary or accept an injected resolver seam for tests.
	- Return an `ExecutionContext` with resolved skills.
- `packages/execution/src/internal/execution-materializer.ts`
	- Validate and carry resolved skills into `MaterializedExecutionEnvironment`.
	- Avoid dependency resolution here unless implementation chooses execution as the first fail-before-session boundary.
- `packages/claude-agent-adapter/src/skill-materialization.ts` or local helper
	- Convert resolved skills into the verified Claude SDK skill/plugin configuration.
- `packages/openai-agent-adapter/src/skill-materialization.ts` or local helper
	- Stage or mount resolved skill files into the local sandbox capability.
- `context-agent/wiki/code-map.md`
	- Document the new catalog, resolver, schemas, and adapter materialization helpers during implementation.
### API contract shape

A recommended Zod shape is:
```typescript
export const skillRefSchema = z.string().regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u);

export const resolvedSkillSchema = z.object({
  ref: skillRefSchema,
  assetPath: z.string().min(1),
  dependencies: z.array(skillRefSchema),
  description: z.string().min(1).optional()
}).strict();

export const skillIntentSchema = z.object({
  requested: z.array(skillRefSchema),
  resolved: z.array(resolvedSkillSchema)
}).strict();
```
The important invariant is that the shared schema distinguishes requested refs from resolved catalog entries. Catalog-relative `assetPath` is preferred because `ExecutionContext` is shared and host-agnostic, even though it is not a public wire surface. Execution-side helpers can resolve `assetPath` to absolute paths for adapters after validating containment.
### Resolver error contract

The resolver should throw a typed error such as `SkillCatalogResolutionError` with codes like:
- `catalog_entry_malformed`
- `skill_ref_invalid`
- `skill_not_found`
- `skill_dependency_missing`
- `skill_dependency_cycle`
- `skill_asset_missing`
- `skill_asset_outside_catalog`
Safe details may include the requested ref, dependency ref, cycle refs, and catalog-relative path. They must not include file contents.
When these errors cross into execution materialization or run work results, they should map to the existing setup-failure path with sanitized reason text such as `Execution failed: skill_not_found` or a more specific safe setup message. Do not leak raw exception messages into persisted terminal results.
### Hard-coded B1 mapping

Until declarative skill routing exists, the implementation should use a small function near context resolution:
```typescript
function requestedSkillsForWorkflowStep(workflow: string, step: string): readonly string[] {
  if ((workflow === 'feature' || workflow === 'enhancement') && step === 'spec.author') {
    return ['mm:planning'];
  }
  return [];
}
```
Do not use `step.startsWith('spec.')` for this slice. `spec.awaiting_input` and `spec.human_review` are human pause/gate steps and must return no requested skills unless an explicit caller override requests skills through the resolver seam. Do not route `mm:planning` to `bug`, `chore`, or `file_issue` runs in this slice; those paths need `mm:issue-triage`, and adding that skill is a future catalog expansion. Prefer expressing support skills through catalog dependencies so `mm:planning` is enough for file-canonical callers.
The function should be easy to replace when route-to-skill configuration lands.
### Catalog asset strategy

The committed B1 catalog should contain genuine aligned runtime skill assets. The implementation should not point at `.agents/` because those files are session-provided skill instructions, not application-owned runtime assets.
If the initial implementation must reuse checked-in skill bodies from an existing location, copy or vendor them into the runtime catalog path and treat that location as canonical for Autocatalyst runs. Do not vendor raw upstream stages that conflict with Autocatalyst's git and session-lifecycle ownership.
Catalog validation should use filesystem APIs and path containment checks. Do not use fragile string prefix checks without resolving paths first.
### Claude adapter changes

The Claude adapter should replace this pattern:
```typescript
const requestedSkills = [...env.skills.requested];
options: { skills: requestedSkills }
```
with a helper that consumes resolved skills and returns the verified SDK shape:
```typescript
const skillPlugins = materializeClaudeSkillPlugins(env.skills.resolved);
options: { skills: skillPlugins }
```
The exact SDK option type may differ. Confirm the Claude Agent SDK skill/plugin input before finalizing the helper return type, and keep that provider-specific mapping inside the adapter package. The adapter should no longer treat requested ref strings as enough to load skills.
Tests should inject fake resolved skills and assert the SDK-facing options contain the expected paths or plugin entries. Also test a missing required asset path if that validation is adapter-owned.
### OpenAI adapter changes

The OpenAI adapter should integrate skill files into sandbox setup near manifest construction. It should keep workspace-root manifest behavior intact.
Recommended approach:
1. Create a deterministic skills staging directory under scratch root or the sandbox workspace base for the session.
2. Copy or link resolved skill directories into the staging directory using safe path operations.
3. Add the staging directory to the sandbox manifest with a stable sandbox-visible path.
4. Pass a safe skill-location hint plus per-skill discovery manifest to the agent session using sandbox-visible paths.
5. Remove staged temporary files when the session closes if they live outside scratch retention.
The implementation must ensure staged files are inside an allowed path and avoid following symlinks out of catalog roots unless deliberately supported with containment checks.
Tests should use a fake sandbox client factory and assert the manifest includes the staged skills directory or equivalent file grants.
### Test plan

Targeted tests should include:
- Catalog index parses and all committed B1 paths exist.
- Catalog dependency refs resolve.
- Committed B1 assets are real aligned skill bodies, not empty placeholders.
- Committed B1 assets do not declare or provision forbidden git/session-lifecycle support skills or obvious branch/worktree/push/merge/PR instructions.
- `resolveSkills(['mm:planning'])` includes `mm:writing-guidelines` as the B1 support dependency declared by the catalog manifest.
- Synthetic catalog fixtures prove multi-hop transitive resolution remains supported even though the B1 authoring bundle has one dependency edge.
- Duplicate requested refs resolve once.
- Missing requested skill fails with typed error.
- Missing dependency fails with typed error.
- Malformed entry fails with typed error.
- Dependency cycle fails with typed error.
- Execution context resolver includes resolved skills for `feature` and `enhancement` `spec.author` steps.
- Execution context resolver returns no B1 planning skills for `bug`, `chore`, `file_issue`, `spec.awaiting_input`, `spec.human_review`, and non-spec steps unless explicit requested skills are supplied.
- Execution materializer preserves resolved skills.
- Bad skill resolution prevents provider session start.
- Claude adapter materializes resolved B1 skills into the verified SDK plugin/skill options.
- OpenAI adapter materializes resolved B1 skills into sandbox files or manifest grants.
- OpenAI adapter passes a sandbox-visible skills root and per-skill discovery manifest or equivalent prompt/capability metadata into session setup.
- Sanitization tests assert fake secrets, prompt text, and file contents do not appear in errors or logs.
- Boundary tests assert core imports resolver/catalog APIs from `@autocatalyst/execution`, not deep source paths.
Existing fixtures that should be explicitly revisited include:
- `packages/core/src/execution-context-resolver.spec.ts` near the `stub_runner` default assertion.
- `packages/execution/src/internal/execution-materializer.spec.ts` near the `plugins` passthrough assertion.
- `packages/execution/src/execution-run-unit-of-work.spec.ts`.
- `packages/execution/src/execution-entry-point.spec.ts`.
- `packages/claude-agent-adapter/src/claude-agent-adapter.spec.ts` around both existing skill assertions.
Suggested commands after implementation:
```bash
pnpm nx test api-contract -- execution-context.spec.ts
pnpm nx test core -- execution-context-resolver.spec.ts
pnpm nx test execution -- skill-resolver.spec.ts
pnpm nx test execution -- execution-materializer.spec.ts
pnpm nx test claude-agent-adapter
pnpm nx test openai-agent-adapter
pnpm nx test control-plane
pnpm test:boundaries
pnpm validate
```
Exact targeted test names can change based on where modules land.
### Rollout and compatibility

This is an internal contract change before public production use. It can update test fixtures and internal schemas in one feature branch. Existing `plugins` passthrough behavior does not need public compatibility unless current tests or adapter seams still depend on it.
If compatibility is needed during implementation, keep `plugins` optional only at an internal adapter boundary and derive it from resolved skills. Do not allow `plugins` to become a second source of truth.
### Risks and open questions

- **Skill asset reconciliation:** the implementation must vendor real skill bodies while removing or neutralizing the upstream implementation-handoff content that conflicts with Autocatalyst ownership.
- **Claude SDK plugin shape:** the exact plugin tree or skill input expected by the Claude Agent SDK must be verified before final wiring.
- **OpenAI sandbox representation:** if the SDK lacks read-only file grants, staging into scratch may be safer than direct mounts.
- **Catalog-relative paths:** using `assetPath` keeps shared schemas host-agnostic, but execution and adapters need careful resolution and containment helpers.
- **Spec-step detection:** hard-coded `(workflow in ['feature', 'enhancement']) && step === 'spec.author'` is intentionally temporary. It should be isolated so declarative route-to-skill mapping can replace it and add `mm:issue-triage` for issue-canonical workflows.
## Task list

### Story 1: Define the resolved skill API contract

#### Task 1.1: Replace flat skill intent schemas with resolved skill bundle schemas

**Description:** Update `packages/api-contract/src/execution-context.ts` so `skills` uses the agreed provider-neutral shape: requested skill refs plus resolved catalog entries.
**Acceptance criteria:**
- `skillRefSchema`, `resolvedSkillSchema`, and `skillIntentSchema` define the strict requested-plus-resolved contract.
- `resolvedSkillSchema` uses catalog-relative `assetPath` unless implementation documents why an absolute path is unavoidable internally.
- `skillIntentSchema` rejects unknown fields, including the previous `plugins` passthrough.
- Exported `SkillRef`, `ResolvedSkill`, and `SkillIntent` types are available to core, execution, and adapter packages.
- Existing API-contract tests and fixtures are updated to construct valid resolved skill bundles.
- Tests cover valid refs, invalid refs, valid resolved entries, and rejection of unknown fields.
**Dependencies:** None.
#### Task 1.2: Update materialized environment skill typing

**Description:** Update `packages/execution/src/materialized-environment.ts` so `MaterializedExecutionEnvironment.skills` mirrors the resolved `SkillIntent` shape from the API contract or an execution-enriched equivalent.
**Acceptance criteria:**
- `MaterializedSkillIntent` is exported as the resolved skill bundle type or an equivalent adapter-ready type derived from it.
- Materialized environment types no longer expose `plugins` as a provider-neutral source of truth.
- Tests and type fixtures that build materialized environments use `requested` plus `resolved`.
**Dependencies:** Task 1.1.
### Story 2: Add the runtime skills catalog and resolver

#### Task 2.1: Commit the B1 runtime skills catalog assets

**Description:** Add a runtime-owned skills catalog under `packages/execution/src/skills/` or an equivalent application source path. Include the exact B1 authoring manifest from Catalog design: `mm:planning` and `mm:writing-guidelines`, with the declared dependency edge from `mm:planning` to `mm:writing-guidelines`.
**Acceptance criteria:**
- The catalog does not point at `.agents/`, `context-agent/`, or `context-human/`.
- `runtimeSkillsCatalog` and `runtimeSkillsCatalogRoot` are exported from `packages/execution/src/skills/catalog.ts` or the chosen equivalent.
- The catalog values and resolver entry points are re-exported from `packages/execution/src/index.ts`.
- Each entry contains `ref`, `assetPath`, `dependencies`, and optional `description` fields.
- The committed refs, asset paths, minimum genuine skill files, and dependency edges match the B1 catalog manifest in Catalog design.
- The committed catalog vendors the real aligned `mm:planning` and `mm:writing-guidelines` bodies, not placeholder stubs.
- Source metadata records the source path and SHA-256 for the vendored `mm:planning` and `mm:writing-guidelines` `SKILL.md` files.
- The vendored `mm:planning` body is scoped to authoring stages and excludes implementation-handoff, branch, worktree, push, merge, and PR instructions.
- Tests assert the required retained sections and required removed/neutralized sections listed in Vendored skill body alignment.
- The catalog does not include `superpowers:using-git-worktrees`, `superpowers:finishing-a-development-branch`, `superpowers:writing-plans`, or `superpowers:brainstorming`.
- Catalog paths are relative to the runtime catalog root or another explicitly allowed application root.
- Tests assert that the committed index parses, each declared root exists, and forbidden git/session-lifecycle refs are absent.
**Dependencies:** Task 1.1.
#### Task 2.2: Implement catalog validation with safe typed errors

**Description:** Implement `validateSkillCatalog` and the `SkillCatalogResolutionError` contract in `packages/execution/src/skills/skill-resolver.ts` or equivalent.
**Acceptance criteria:**
- Catalog validation uses the strict catalog-entry schema.
- Duplicate refs fail with `catalog_entry_malformed`.
- Dependency refs that do not exist in the catalog fail with `skill_dependency_missing`.
- Missing asset roots fail with `skill_asset_missing`.
- Asset roots that resolve outside the allowed catalog root fail with `skill_asset_outside_catalog`.
- Safe details include refs and safe relative paths only, not file contents, prompts, secrets, or provider payloads.
- Unit tests cover malformed entries, duplicate refs, missing dependency refs, missing assets, and escaped asset paths.
**Dependencies:** Task 2.1.
#### Task 2.3: Implement deterministic transitive skill resolution

**Description:** Implement `resolveSkills` so callers can request provider-neutral refs and receive a resolved skill bundle with transitive dependencies.
**Acceptance criteria:**
- Requested refs are validated with `skillRefSchema`.
- Missing requested refs fail with `skill_not_found`.
- Invalid requested or dependency refs fail with `skill_ref_invalid`.
- Dependency traversal detects cycles and fails with `skill_dependency_cycle`.
- Duplicate requested refs and duplicate dependency paths produce one resolved entry per ref.
- Resolution order is deterministic and defaults to dependency-first ordering.
- `resolveSkills(['mm:planning'])` includes `mm:writing-guidelines`.
- Unit tests cover successful B1 resolution, synthetic transitive resolution, de-duplication, missing requested refs, invalid refs, and cycle detection.
**Dependencies:** Task 2.2.
### Story 3: Resolve skills before execution materialization

#### Task 3.1: Add the hard-coded B1 skill request seam to context resolution

**Description:** Update `packages/core/src/execution-context-resolver.ts` so file-canonical `spec.author` runs request the B1 planning skill bundle through the resolved skill resolver seam.
**Acceptance criteria:**
- `createExecutionContextResolver` accepts options including an optional async `resolveSkills` test seam.
- `resolveExecutionContext` remains exported and returns an `ExecutionContext` with resolved skills.
- Core imports production resolver/catalog APIs through `@autocatalyst/execution` exports, not deep source paths.
- A module-local mapper requests `mm:planning` for workflow `feature` or `enhancement` at step ID `spec.author` and returns no skills for `bug`, `chore`, `file_issue`, `spec.awaiting_input`, `spec.human_review`, and non-spec steps unless explicit requested skills are provided.
- The mapper's temporary workflow-plus-step hard-coding is documented in tests so future route-to-skill configuration can replace it.
- Explicit `skills.requested` options remain a construction-time seam for callers that intentionally request refs.
- The previous `stub_runner` default is removed as a production skill default.
- The previous `skills.plugins` passthrough is removed and not silently copied.
- Resolver failures propagate before execution materialization or provider setup.
- Tests cover `feature` and `enhancement` `spec.author` B1 resolution; no-skill behavior for `bug`, `chore`, `file_issue`, `spec.awaiting_input`, `spec.human_review`, and non-spec steps; explicit requested skills; injected resolver usage; and resolver failure propagation.
**Dependencies:** Tasks 1.1, 2.3.
#### Task 3.2: Validate and carry resolved skills through execution materialization

**Description:** Update `packages/execution/src/internal/execution-materializer.ts` to validate the resolved skill bundle and copy it into `MaterializedExecutionEnvironment` without re-running dependency resolution.
**Acceptance criteria:**
- `validateMaterializedSkills` validates the strict resolved skill bundle shape.
- Invalid skill bundle shape fails with `catalog_entry_malformed` or another documented safe setup code.
- Existing materialization behavior for workspace, secrets, and capabilities remains unchanged.
- Resolved skill assets are re-verified for existence before `AgentProviderAdapter.startSession`, Claude process launch, OpenAI sandbox creation, or provider traffic.
- Allowed-root containment checks are implemented through execution materializer options or helper hooks.
- Tests assert that valid skills are preserved unchanged from `ExecutionContext` to `MaterializedExecutionEnvironment`.
- Tests assert that invalid shapes, missing assets, and escaped assets fail before `AgentProviderAdapter.startSession`, Claude process launch, OpenAI sandbox creation, or provider traffic.
**Dependencies:** Tasks 1.2, 3.1.
#### Task 3.3: Prove catalog failures stop before provider sessions

**Description:** Add fail-before-session coverage through production seams using fake adapters, spies, or injected bad resolver results.
**Acceptance criteria:**
- Missing skill errors occur before `AgentProviderAdapter.startSession` is called.
- Malformed catalog or materialized skill errors occur before Claude process launch.
- Cycle errors occur before OpenAI sandbox creation or provider calls.
- Persisted or surfaced failure messages use typed safe codes and do not include raw exception details.
- Tests include fake secret, prompt, and file-content strings and assert those strings are absent from errors and logs.
**Dependencies:** Tasks 2.3, 3.2.
### Story 4: Materialize resolved skills for Claude agent sessions

#### Task 4.1: Add Claude skill plugin materialization helper

**Description:** Implement `packages/claude-agent-adapter/src/skill-materialization.ts` to convert provider-neutral resolved skills into the verified Claude SDK skill/plugin entries.
**Acceptance criteria:**
- `materializeClaudeSkillPlugins` accepts `readonly ResolvedSkill[]` or the chosen resolved skill type and returns the verified Claude SDK skill/plugin option shape.
- The helper verifies and documents the actual Claude Agent SDK input shape used by this adapter.
- The helper uses each catalog-declared asset path resolved by execution; it does not infer paths from refs or read local editor metadata.
- Custom filesystem hooks require both `exists` and `stat` behavior so missing and unsupported roots are testable.
- Missing roots or unsupported file/directory forms fail with `ClaudeSkillMaterializationError`.
- Error safe details include skill refs, safe paths, and `claude_plugin_tree` mode only.
- Unit tests cover valid directory roots, valid file roots if supported, missing roots, unsupported roots, and sanitized errors.
**Dependencies:** Tasks 1.1, 2.3.
#### Task 4.2: Wire Claude adapter session setup to resolved plugin entries

**Description:** Update `packages/claude-agent-adapter/src/claude-agent-adapter.ts` so Claude session options are built from resolved skill entries instead of raw `env.skills.requested` strings.
**Acceptance criteria:**
- The adapter calls `materializeClaudeSkillPlugins(env.skills.resolved)` or the equivalent helper for the verified SDK shape.
- The SDK-facing skill option contains plugin entries for `mm:planning` and every resolved B1 dependency.
- The adapter does not pass raw requested refs as the complete skill contract.
- Adapter errors from skill materialization are sanitized before logging or surfacing.
- Tests assert that a B1 materialized environment produces the expected Claude plugin tree or SDK-equivalent skill input.
- Tests assert that secrets, full prompts, provider responses, and workspace file contents do not appear in Claude skill-materialization errors or logs.
**Dependencies:** Tasks 3.2, 4.1.
### Story 5: Materialize resolved skills for OpenAI agent sessions

#### Task 5.1: Add OpenAI sandbox skill-file materialization helper

**Description:** Implement `packages/openai-agent-adapter/src/skill-materialization.ts` to stage or mount resolved runtime skill assets for `UnixLocalSandboxClient`.
**Acceptance criteria:**
- `materializeOpenAISkillFiles` accepts resolved skills and documented OpenAI skill materialization options.
- The default mode stages skill files under a deterministic staging root unless a safe read-only mount mode is explicitly selected.
- Staged or mounted paths pass containment checks for both source catalog roots and target staging roots.
- The result includes skill refs, host staging path, sandbox-visible skills path, per-skill discovery manifest entries, and sandbox manifest entries.
- Only declared runtime skill assets are exposed; unrelated repository files are not copied or granted.
- Unit tests cover staging directories, manifest entry creation, missing source paths, escaped source paths, escaped target paths, and sanitized errors.
**Dependencies:** Tasks 1.1, 2.3.
#### Task 5.2: Wire OpenAI adapter sandbox setup to materialized skill files

**Description:** Update `packages/openai-agent-adapter/src/openai-agent-adapter.ts` so resolved skills are present in the sandbox-visible environment before the OpenAI agent session starts.
**Acceptance criteria:**
- Sandbox manifest construction includes the staged skills directory or equivalent read-only grants returned by `materializeOpenAISkillFiles`.
- Existing workspace-root manifest behavior, no-op snapshot behavior, and containment checks remain intact.
- The agent receives a skill-location hint or equivalent session metadata, and it uses sandbox-visible paths rather than host-only paths.
- Session input includes a per-skill discovery manifest that maps `mm:planning` and `mm:writing-guidelines` to their staged sandbox-visible `SKILL.md` paths.
- Skill materialization failures stop before sandbox session start or provider calls.
- Tests with a fake sandbox client assert that B1 skill files or grants are passed to the sandbox setup.
- Tests with a fake session assert that the OpenAI session input includes the skills root plus per-skill discovery manifest or equivalent prompt/capability metadata.
- Tests assert that secrets, full prompts, provider responses, and workspace file contents do not appear in OpenAI skill-materialization errors or logs.
**Dependencies:** Tasks 3.2, 5.1.
### Story 6: Add end-to-end coverage and agent documentation

#### Task 6.1: Add integration coverage for both supported agent cells

**Description:** Add integration tests that drive agent-session setup through production seams for Claude and OpenAI without live network calls.
**Acceptance criteria:**
- A Claude integration test resolves the B1 bundle, reaches the adapter start seam, and asserts the SDK/session options include `mm:planning` and `mm:writing-guidelines` as plugin entries or SDK-equivalent skill inputs.
- An OpenAI integration test resolves the B1 bundle, reaches the fake sandbox setup seam, and asserts the sandbox manifest or session receives B1 skill files or grants.
- A shared or separate integration test proves missing, malformed, or cyclic skill setup prevents provider session start.
- Integration tests use fake provider seams and do not make live provider calls.
**Dependencies:** Tasks 4.2, 5.2.
#### Task 6.2: Update agent-owned navigation docs

**Description:** Update `context-agent/wiki/code-map.md` so future agents can find the runtime skills catalog, resolver, schema changes, materializer validation, and adapter materialization helpers.
**Acceptance criteria:**
- The code map names the catalog asset location and resolver module.
- The code map notes that `ExecutionContext.skills` and `MaterializedExecutionEnvironment.skills` use requested refs plus resolved entries.
- The code map names the Claude and OpenAI skill materialization helper files.
- The doc states that provider-neutral dependency resolution stays outside provider adapters.
**Dependencies:** Tasks 2.3, 3.2, 4.2, 5.2.
#### Task 6.3: Run targeted and broad validation

**Description:** Run the relevant test and validation commands after implementation, starting with targeted package tests and ending with broader project validation.
**Acceptance criteria:**
- Targeted tests pass for API contract, core context resolution, execution resolver/materializer, Claude adapter, and OpenAI adapter changes.
- Integration coverage for both agent cells passes without live provider calls.
- `pnpm test:boundaries` passes if available.
- `pnpm validate` passes, or any skipped command is documented with the exact reason.
- The final implementation handoff lists any remaining provider-specific uncertainty, especially Claude SDK plugin shape or OpenAI sandbox grant limitations.
**Dependencies:** Tasks 6.1, 6.2.