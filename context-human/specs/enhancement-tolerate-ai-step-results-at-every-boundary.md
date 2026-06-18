---
created: 2026-06-18
last_updated: 2026-06-18
status: implementing
issue: 83
issue_url: [https://github.com/markdstafford/autocatalyst/issues/83](https://github.com/markdstafford/autocatalyst/issues/83)
specced_by: autocatalyst
---
# Enhancement: Tolerate AI-step results at every step boundary

## Product requirements

### What

Autocatalyst should route every structured AI-step result through the existing result-tolerance pipeline before core workflow logic consumes it. This enhancement extends the pipeline beyond the currently covered reviewer and `spec.author` paths so `spec.author` frontmatter near-misses and `pr.finalize` empty or malformed reviewer results recover through deterministic normalization or a bounded correction request instead of failing the run immediately. The design keeps system-owned spec frontmatter authoritative and makes pipeline adoption the standard contract-registration path for new AI steps, not a per-step parsing patch.
### Parent feature

This enhances the step-result tolerance and workflow-boundary behavior defined by:
- `context-human/specs/feature-step-result-tolerance-pipeline.md`, which introduced `validateStepResult`, contract lookup, deterministic normalizers, correction, and sanitized validation failures.
- `context-human/specs/feature-author-real-conformant-spec.md`, which wired `spec.author` to the real spec-authoring result contract.
- `context-human/specs/feature-review-open-merge-pull-request.md`, which introduced `pr.finalize` as the final AI reviewer pass before spec freeze and PR opening.
- ADR-012 and ADR-027, which require soft-contract model output handling and step-boundary contract verification.
### Current behavior

`implementation.build` reviewer output has a helper path that calls `validateStepResult` before convergence consumes the reviewer verdict. The execution entry point also validates `spec.author` scratch output through the registered `autocatalyst.spec_author.v1` contract, but its system-stamp preprocessing still keeps other model-supplied frontmatter fields as-is. Because `specAuthorFrontmatterSchema` is strict, common model near-misses still fail: optional fields emitted as `null`, and unknown frontmatter keys preserved by the stamp.
`pr.finalize` is different: the orchestrator receives `RunWorkResult.advance.result` and parses it with `parsePullRequestFinalizeResult`, which calls `prFinalizeResultSchema.safeParse` directly. An empty `{}` result, which usually means the model found nothing to flag, fails because `directive` is required. The run then fails with `pr_finalize_invalid_result` before deterministic normalization, correction, or graceful recovery can run.
The result is inconsistent. Some structured AI-step outputs use the tolerance pipeline, while others still rely on local strict parsing or incomplete preprocessing.
### Proposed behavior

All structured AI-step results should declare a step/schema contract and use `validateStepResult` as the standard boundary before workflow-specific logic runs. For issue 83, the required coverage is:
- `spec.author` keeps system-owned frontmatter authoritative, drops unknown model frontmatter keys, and coerces optional `null` values to absent before validation. This spec chooses the normalizer route, not the “model produces only the body” route, because the existing `specAuthorResultSchema` and completion path already expect a full result object and only need safer frontmatter normalization.
- `pr.finalize` registers a real result contract and validates its result through `validateStepResult` before the orchestrator calls PR-finalize-specific side effects. Its normalizer maps `{}` and other clean “nothing to flag” near-misses to `{ directive: "advance", findings: [] }`.
- Any validation failure that can be corrected goes through the existing correction requester seam before the run fails.
- The orchestrator consumes only validated, normalized `pr.finalize` data when deciding whether to freeze the spec, open a PR, or revise to implementation review.
- A new structured AI step gets the same behavior by registering a contract, normalizers, and optional correction behavior, not by adding a bespoke parser in the orchestrator.
### Why

Issue 83 comes from real full-run failures after earlier tolerance work fixed only one boundary. The core product promise depends on Autocatalyst recovering from small model-output mistakes: a model emitting `null` for an optional frontmatter field, adding an extra YAML key, or returning `{}` to mean “no PR blockers” should not waste the entire run. The tolerance pipeline already exists to handle exactly this class of near-miss. Applying it uniformly makes run behavior more predictable, reduces duplicated parsing paths, and keeps workflow logic from consuming raw model-shaped data.
### Goals

- `spec.author` accepts the recurring frontmatter near-misses from issue 83 when they are deterministic to normalize: unknown keys are dropped, system-owned fields are stamped, and optional `null` fields become absent.
- `pr.finalize` validates through `validateStepResult` before any PR-finalize workflow logic parses the result or applies side effects.
- `{}` from `pr.finalize` normalizes to a clean advance result with no findings.
- Step/schema contract registration becomes the required pattern for every structured AI-step result.
- Existing sanitized failure behavior remains: unrecoverable result problems fail with stable safe reasons and do not expose raw model output, prompts, secrets, or host paths.
- End-to-end coverage proves a real run recovers at both `spec.author` and `pr.finalize` boundaries without mocks, injected final results, or test-only hooks.
### Non-goals

- The resolution-keyed-to-a-real-feedback-item check on feedback paths.
- Resuming a failed run from the failed step. Failed runs remain terminal and rerun from scratch until separate recovery work lands.
- Reworking the spec-authoring contract so the model produces only the spec body.
- Adding new public API routes or UI surfaces for result validation.
- Changing PR lifecycle behavior beyond validating `pr.finalize` results through the tolerance pipeline.
### Personas

- **Phoebe, product owner:** needs feature or enhancement runs to reach spec review when model-authored frontmatter contains harmless near-misses.
- **Riley, release reviewer:** needs clean `pr.finalize` reviewer output to advance even when the model returns an empty object for “nothing to flag.”
- **Enzo, platform engineer:** needs one contract-registration pattern for adding structured AI-step results without orchestrator-specific parsing patches.
- **Opal, operator:** needs safe, stable diagnostics for true malformed output while deterministic near-misses recover automatically.
### User stories

- As Phoebe, I can start a feature or enhancement run and still get a spec review even if the model adds harmless extra frontmatter or writes `null` for an optional frontmatter field.
- As Riley, I can rely on `pr.finalize` to advance a clean PR-review result even when the model returns an empty object for “nothing to flag.”
- As Enzo, I can add a new structured AI step by registering a result contract and normalizers instead of writing a one-off parse-and-fail block.
- As Opal, I can diagnose true malformed output through stable safe failure codes while common near-misses recover automatically.
### Acceptance criteria

#### Standard AI-step result route

- `spec.author` and `pr.finalize` structured results go through `validateStepResult` in the order ADR-012 requires: normalize, validate, request correction when configured, then fail only if recovery is exhausted or unavailable.
- The codebase has one obvious registration path for structured AI-step contracts. Adding a new AI-step result should mean registering `(step, schemaId, schema, resultFile or candidate source, normalizers, correction policy)` rather than adding local parser logic in an orchestrator branch.
- Workflow-specific code consumes typed validated values after the pipeline succeeds. It does not parse raw scratch files, raw runner output, or raw `RunWorkResult.result` candidates directly.
- Existing reviewed-step validation for `implementation.build` keeps working and does not lose its reviewer-specific correction seam.
#### `spec.author` frontmatter tolerance

- System-owned fields remain authoritative: `created`, `last_updated`, `status`, `issue` when tracked, and `specced_by` are stamped or overridden by Autocatalyst before validation.
- Unknown model-supplied frontmatter keys are dropped before `specAuthorFrontmatterSchema.strict()` validates.
- Optional frontmatter fields emitted as `null` are treated as absent when the schema does not accept `null`.
- Non-frontmatter result fields still validate strictly against `specAuthorResultSchema`; this enhancement does not make arbitrary malformed specs acceptable.
- Tests prove the normalizer route chosen by this spec, including stray keys and optional `null` frontmatter values.
#### `pr.finalize` tolerance

- `pr.finalize` has a registered step result contract, schema id, and validation path that uses `validateStepResult`.
- `{}` normalizes to a clean advance result: `directive: "advance"`, `findings: []`, and no blocker feedback.
- Near-miss clean results such as missing `findings`, empty findings, or omitted optional summary/title fields normalize or validate without failure when the intent is unambiguous.
- Results with real blocker findings still validate and map to `directive: "revise"` behavior exactly as the PR lifecycle feature specifies.
- Ambiguous or contradictory PR-finalize results do not get guessed. They go to correction when configured, then fail safely if still invalid.
#### End-to-end proof

- A real end-to-end or realistic production-path integration test drives a run where `spec.author` emits stray or `null` frontmatter and the run still reaches the spec review gate with a conformant committed spec.
- The same test, or a second production-path test, drives the run to `pr.finalize` where the AI step emits `{}` and the run recovers by normalization or correction, then continues toward PR opening instead of failing with `pr_finalize_invalid_result`.
- The proof must not inject parsed step results directly into the orchestrator or use test-only hooks that skip the production result contract path. For `spec.author`, that means the test must not bypass `createExecutionEntryPoint` scratch-file validation. For `pr.finalize`, that means the test must drive the real `RunWorkResult.result` boundary and core `validatePullRequestFinalizeResult` bridge rather than injecting a parsed or pre-normalized result.
- The test asserts that the persisted checkpoints or resulting run state reflect validated values, not raw near-miss candidates.
- If implementation moves or adds modules, `context-agent/wiki/code-map.md` is updated.
### Non-functional requirements

- **Safety:** The system must never commit malformed spec frontmatter or open a PR based on an unvalidated final-review result.
- **Security:** Validation failures, logs, and test diagnostics must not include raw prompts, raw model transcripts, secret values, provider credentials, full scratch paths, or raw `gh` output.
- **Compatibility:** Existing successful `spec.author`, `implementation.build` reviewer, direct-call, and PR lifecycle paths keep their current public behavior.
- **Extensibility:** The contract registry and normalizer structure should support future structured AI steps without changing orchestrator control flow for each one.
- **Observability:** Safe diagnostics should identify the step, schema id, and validation outcome class (`normalized`, `corrected`, `failed`) where existing logging or test seams expose them.
### Impact on existing behavior

- `spec.author` becomes more tolerant of model-authored frontmatter details while keeping Autocatalyst-owned fields stricter and more authoritative.
- `pr.finalize` no longer fails immediately on an empty clean result; it treats that as clean advance when no contrary evidence exists.
- `pr_finalize_invalid_result` remains available for unrecoverable PR-finalize result failures, but it should happen after pipeline normalization and correction attempts, not before them.
- Existing `implementation.build` reviewer validation remains the reference behavior and should not be duplicated or bypassed.
- No database schema migration is expected. The work changes validation, contract registration, and tests.
### Product devil's advocate pass

- **Normalizing too much could hide real model mistakes.** The normalizers must handle only deterministic cases. Unknown frontmatter keys can be dropped because the system owns the committed frontmatter contract; contradictory `pr.finalize` fields must not be guessed.
- **A per-step fix would solve the immediate failure faster but repeat the architectural problem.** The enhancement should make contract registration the pattern so the next AI step does not add another local parse path.
- **The e2e requirement can be weakened accidentally by a fake unit of work.** The proof must still execute through the real result boundary and show raw near-miss candidates become validated results before orchestration side effects.
### Product reviewer pass

The requirements align with ADR-012 and ADR-027: model output is a soft contract, but downstream logic sees only verified values. Classifying this as an enhancement is appropriate because it extends the existing tolerance-pipeline and PR lifecycle features rather than adding standalone user-facing functionality. The most important design choice is explicit: this spec keeps the existing `specAuthorResultSchema` shape and normalizes model-supplied frontmatter instead of redesigning spec authoring around body-only model output.
## Design spec

### Design scope

This is a backend workflow and execution-boundary enhancement. It adds no screens, routes, or new human-review surface. The visible change is that runs recover from small structured-output mistakes and continue to the same existing gates and PR lifecycle steps.
### Successful recovery experience

For `spec.author`, a successful recovery looks like this:
1. The agent writes `step-result.json` with a valid spec body and path, but frontmatter includes a stray key or an optional field set to `null`.
2. The execution entry point reads the scratch result and resolves the `spec.author` contract.
3. The spec-author normalizer removes the stray key, removes optional `null` values, and stamps system-owned fields.
4. The normalized result validates against `specAuthorResultSchema`.
5. The existing spec-authoring completion path commits the conformant spec and pauses at `spec.human_review`.
For `pr.finalize`, a successful recovery looks like this:
1. The reviewer session emits `{}` to mean it found no blockers.
2. The result is treated as the raw candidate for the registered `pr.finalize` contract.
3. The PR-finalize normalizer recognizes the empty object as an unambiguous clean result and maps it to `directive: "advance"` with `findings: []`.
4. The normalized result validates.
5. The orchestrator stores the PR-finalize checkpoint, freezes the spec, and advances to `pr.open` as the PR lifecycle already defines.
### Failure experience

If a result is not deterministically recoverable, the user-visible behavior stays safe and predictable. The pipeline asks for correction when a requester exists. If correction is unavailable or exhausted, the run fails with an existing stable failure reason such as `pr_finalize_invalid_result` or a sanitized execution failure code. The failure should identify the step/schema id class for operators, but it must not expose raw model text, prompts, credentials, or full host paths.
Examples that should not be guessed:
- `pr.finalize` returns both an advance directive and blocker findings with no clear intended outcome.
- `pr.finalize` returns an unknown directive.
- `spec.author` returns a body/path/kind mismatch that existing spec-authoring validation rejects.
- A normalizer throws or cannot safely classify the candidate.
### Normalizer behavior

Normalizers should remain small and contract-specific. They can live in the existing execution normalizer registry if they are schema-id keyed, or beside contract registration if that keeps the step/schema relationship clearer.
The `spec.author` normalizer should run before `specAuthorResultSchema` validation and after, or as part of, system stamping. It should produce a candidate whose frontmatter contains only allowed frontmatter keys plus Autocatalyst-stamped system-owned keys. It should remove optional-key `null` values rather than changing them to empty strings or invented defaults.
The `pr.finalize` normalizer should treat only truly empty or omission-only success candidates as clean advances. `{}`, `{ findings: [] }`, and an object with only omitted optional fields are safe. A candidate with non-empty findings, unknown fields, or contradictory directive data should be left for schema validation and correction rather than coerced.
### Contract registration experience

A step author should see a single pattern:
1. Define or export the Zod schema for the structured result.
2. Assign a stable schema id.
3. Register the contract for `(step, schemaId)` with the result source, normalizers, and correction behavior.
4. Configure the execution or core boundary for that step to call `validateStepResult` with the registered contract.
5. Consume the typed validated value in step-specific workflow logic.
`implementation.build` reviewer results and `spec.author` scratch-file results already approximate this pattern. `pr.finalize` should join it instead of keeping a bare parser in core.
### Boundary ownership

The execution entry point remains the owner of scratch-file validation for agent steps whose result comes from `step-result.json`; that is the required production boundary for `spec.author`. Core owns workflow-specific interpretation after validation. Because `pr.finalize` currently reaches the orchestrator as an in-memory `RunWorkResult.result`, this slice requires a core-side `validatePullRequestFinalizeResult` bridge as the authoritative production boundary for `pr.finalize`.
The bridge must wrap `validateStepResult` with the registered `pr.finalize` schema id, shared schema, and contract-local normalizers before any PR-finalize side effects run. It is not a second parser or a custom tolerance path. The PR-finalize contract registration still exists so the schema id, schema, normalizers, and future correction policy have one obvious definition; the current production consumer of that contract is the core bridge rather than execution-entry-point scratch-file validation.
If `pr.finalize` later moves to `step-result.json`, that future change may replace or simplify the bridge. It is not part of this slice.
### End-to-end test design

The proof should use a production dispatch path with controlled fake provider behavior. The fake adapter or harness may emit malformed candidates, but it must do so through the same scratch result file or runner result path a real provider uses. `spec.author` proof uses the execution-entry-point `step-result.json` boundary. `pr.finalize` proof uses the current production `RunWorkResult.result` boundary plus the core validation bridge. The test should verify both recovery points in one run if practical:
1. Create a feature or enhancement run from issue-like input.
2. Let `spec.author` write a spec result containing stray or `null` frontmatter.
3. Assert the run reaches `spec.human_review` and the committed spec has conformant frontmatter.
4. Approve through existing reply/orchestrator paths until the run reaches `pr.finalize`.
5. Let `pr.finalize` emit `{}`.
6. Assert the bridge validates the raw `{}` through `validateStepResult`, the run does not fail with `pr_finalize_invalid_result`, and instead advances toward `pr.open` or `pr.human_review`, depending on the available PR lifecycle harness.
If one test becomes too slow or brittle, split it into two production-path tests. Do not replace the AI-step boundary with a hand-supplied `RunUnitOfWork` result that has already been normalized.
### Design reviewer pass

The design keeps the user experience unchanged except for better recovery. The main technical risk is boundary placement for `pr.finalize`, because it currently has core-specific parsing and side effects. The design requires the core bridge wrapping `validateStepResult` for this slice and rejects both execution-entry-point scratch validation for the current production path and any new parser-only workaround.
## Tech spec

### Current state

Relevant implementation points in the current workspace are:
- `packages/execution/src/result-tolerance.ts` exports `validateStepResult`, the ADR-012 normalize/validate/correct/fail pipeline.
- `packages/execution/src/result-contracts.ts` registers `SPEC_AUTHOR_SCHEMA_ID` for `spec.author` and `REVIEWER_RESULT_SCHEMA_ID` for `implementation.build` reviewer output.
- `stampSpecAuthorResultIdentity` stamps system-owned spec frontmatter fields but currently preserves other model frontmatter keys, which lets strict-schema unknown keys and `null` optional values fail validation.
- `packages/execution/src/execution-entry-point.ts` can validate scratch-file results through an inline schema, a direct contract, or a contract registry.
- `apps/control-plane/src/server.ts` configures scratch result validation for `spec.author` and `implementation.build` reviewer sessions, but not for `pr.finalize`.
- `packages/core/src/pr-finalize.ts` owns `prFinalizeResultSchema`, `parsePullRequestFinalizeResult`, `buildPullRequestFinalizePrompt`, checkpoint construction, and feedback mapping.
- `packages/core/src/orchestrator.ts` calls `parsePullRequestFinalizeResult(result.result)` directly after `pr.finalize` advances. On parse failure, it fails the run with `pr_finalize_invalid_result`.
- `packages/core/src/reviewer-result-validation.ts` is an example of a core helper that wraps `validateStepResult` for reviewer result candidates.
### Architecture

The enhancement should add contract-level validation for PR finalization and tighten spec-author normalization without replacing the existing pipeline.
Proposed ownership:
- `packages/api-contract` should export a shared PR-finalize result schema so execution contract registration and core validation use the same contract-owned shape without a package cycle.
- `packages/execution/src/result-contracts.ts` should expose a `PR_FINALIZE_SCHEMA_ID`, a `createPullRequestFinalizeResultContract`, and a `registerPullRequestFinalizeResultContract` as the single registration path for the PR-finalize contract definition.
- `packages/execution/src/result-normalizers.ts` or a contract-local normalizer module should provide spec-author frontmatter and PR-finalize clean-result normalizers.
- `packages/core/src/pr-finalize-result-validation.ts` should expose the required core bridge, so orchestrator code receives `PullRequestFinalizeResult` only after tolerance validation.
- `apps/control-plane/src/server.ts` should continue to configure scratch-file validation for steps that use `createExecutionEntryPoint`; it should register PR-finalize contracts for the shared registry pattern without making scratch-file validation the current production boundary for `pr.finalize`.
The required core bridge for this slice is:
```typescript
async function validatePullRequestFinalizeResult(input: {
  runId: string;
  candidate: unknown;
  normalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[];
  correctionRequester?: ResultCorrectionRequester;
}): Promise {
  const validation = await validateStepResult({
    runId: input.runId,
    step: 'pr.finalize',
    schemaId: PR_FINALIZE_SCHEMA_ID,
    schema: prFinalizeResultSchema,
    candidate: input.candidate,
    normalizers: input.normalizers ?? defaultPrFinalizeNormalizers,
    correctionRequester: input.correctionRequester,
  });
  // map valid to typed result, failed to pr_finalize_invalid_result-compatible failure
}
```
This keeps the pipeline standard while minimizing execution-boundary churn.
### Spec-author frontmatter normalization

Update the spec-author result preprocessing so the model does not control committed frontmatter shape. The current `stampSpecAuthorResultIdentity` should either call a focused sanitizer before spreading model fields, or replace the spread with an allowlist builder.
The sanitizer should:
- accept only known `specAuthorFrontmatterSchema` keys that are model-owned or safe to preserve;
- drop unknown keys;
- drop any optional known key whose value is `null` unless that key's schema explicitly accepts `null`;
- then apply Autocatalyst-owned values for `created`, `last_updated`, `status`, tracked `issue`, and `specced_by`;
- avoid changing non-frontmatter fields such as `kind`, `slug`, `relativePath`, and `body`.
Frontmatter ownership is:

Key
Ownership
`null` handling
Normalization behavior

`created`
System-owned
Not removable as model data; overwritten before validation
Stamp from Autocatalyst's trusted clock/date. Ignore any model value.

`last_updated`
System-owned
Not removable as model data; overwritten before validation
Stamp from Autocatalyst's trusted clock/date. Ignore any model value.

`status`
System-owned
Not removable as model data; overwritten before validation
Stamp to the system-required initial value, currently `draft`. Ignore any model value.

`issue`
System-owned when the run has a tracked issue
Remove `null`; ignore model value
If the run has a tracked issue, stamp that issue number. If the run has no tracked issue, omit `issue` even when the model supplies one.

`specced_by`
System-owned
Not removable as model data; overwritten before validation
Stamp from Autocatalyst's trusted `specced_by` identity. Ignore any model value.

`implemented_by`
Model-preserved allowed key
Remove `null` because the schema accepts only string or absent
Preserve a valid model value for later strict schema validation.

`supersedes`
Model-preserved allowed key
Remove `null` because the schema accepts only string or absent
Preserve a valid model value for later strict schema validation.

`superseded_by`
Model-preserved allowed key
Remove `null` because the schema accepts only string or absent
Preserve a valid model value for later strict schema validation.

Any other key, including `issue_url`
Not allowed/model-owned unknown
Drop before validation
Do not preserve or reinterpret unknown frontmatter keys.

Tests should cover:
- `frontmatter: { extra: "x" }` validates after normalization and does not include `extra` in the final value;
- `frontmatter` optional key emitted as `null` is absent in the final value;
- model-provided system-owned fields are overwritten;
- truly invalid non-frontmatter fields still fail.
### PR-finalize schema and normalizer

Move the PR-finalize result schema to a contract-consumable `packages/api-contract` export. The existing shape is appropriate:
```typescript
const prFinalizeResultSchema = z.object({
  directive: z.enum(['advance', 'revise']),
  reconciledSummary: z.string().optional(),
  titleSubject: z.string().optional(),
  validationSummary: z.array(z.string()).optional(),
  findings: z.array(prFinalizeFindingSchema).default([]),
}).strict();
```
Add a normalizer that receives a candidate and returns a changed candidate only when the input is an object with no meaningful fields or an omission-only clean shape. Suggested mappings:
- `{}` → `{ directive: 'advance', findings: [] }`.
- `{ findings: [] }` → `{ directive: 'advance', findings: [] }`.
- `{ validationSummary: [] }` → `{ directive: 'advance', validationSummary: [], findings: [] }`.
Do not normalize:
- unknown keys, because the schema is strict and the model may need correction;
- non-empty `findings` without a directive, because blocker versus warning semantics matter;
- invalid directive values;
- candidates with both clean and blocker-like signals that conflict.
Tests should prove successful normalization and non-normalization for ambiguous cases.
### Orchestrator integration

Replace direct use of `parsePullRequestFinalizeResult(result.result)` in `DefaultOrchestrator.dispatch` with a pipeline-backed validation call. After validation succeeds, the existing PR-finalize behavior remains:
- `directive: 'revise'` maps to workflow `revise`, records PR-finalize feedback targeted at `implementation`, and does not run spec freeze.
- `directive: 'advance'` stores the validated checkpoint, runs spec freeze, and advances to `pr.open`.
- validation failure after normalization and correction fails with `pr_finalize_invalid_result` or an equivalent existing safe failure reason.
Because this slice chooses the core bridge for `pr.finalize`, the orchestrator should call `validatePullRequestFinalizeResult(result.result)` for raw AI-step candidates. It may keep a narrow type guard or assertion after a successful bridge outcome if useful for internal invariants, but it should not reintroduce bare schema parsing as the recovery gate.
### Contract registry and server wiring

Update the default and production contract registries to include `pr.finalize` as a first-class structured AI-step contract, even though the current production validation boundary is the core bridge:
- default registry in `apps/control-plane/src/server.ts`;
- per-run registry that also stamps spec-author identity;
- any test registry helpers that expect all production structured AI-step contracts.
Do not move `pr.finalize` to `resolveScratchResultValidationConfig` in this slice. Its result reaches core as an in-memory `RunWorkResult.result`, so the core helper is the required production path and documents why `pr.finalize` is the current exception while still using `validateStepResult`.
### Correction requester behavior

Use existing correction requester seams where available. This enhancement does not need to invent provider-specific correction prompts, but the validation helper should accept a `ResultCorrectionRequester` so production can wire correction later or reuse an existing requester. Without a correction requester, deterministic normalization plus validation still improves the two issue-83 failures.
For `pr.finalize`, a future correction request should include only safe schema issues and a bounded candidate excerpt. It should not include full branch diffs, full prompts, secrets, or raw provider responses.
### Testing strategy

Add targeted unit tests:
- `result-contracts` or normalizer tests for spec-author unknown-key dropping and optional-`null` removal.
- PR-finalize validation tests showing `{}` becomes clean advance through `validateStepResult`.
- PR-finalize validation tests for ambiguous candidates that are not normalized.
- Orchestrator tests proving `pr.finalize` no longer fails on `{}` and still fails safely on unrecoverable invalid candidates.
- Regression tests proving existing valid `pr.finalize` advance and revise behavior still works.
Add production-path integration coverage:
- A spec-authoring run where the harness writes near-miss frontmatter through `step-result.json`; assert the committed spec is conformant and the run reaches `spec.human_review`.
- A PR lifecycle run where the provider/harness emits `{}` at `pr.finalize` through the real result boundary; assert the run advances past `pr.finalize` and does not record `pr_finalize_invalid_result`.
- Redaction assertions for any captured logs or thrown errors that include validation failure details.
Suggested targeted validation commands after implementation:
```bash
pnpm nx test execution -- result-contracts.spec.ts result-tolerance.spec.ts execution-entry-point.spec.ts
pnpm nx test core -- pr-finalize.spec.ts orchestrator.spec.ts
pnpm nx test control-plane -- integration.spec.ts pr-lifecycle.integration.spec.ts control-plane-service.integration.spec.ts
```
The exact command set may change with test placement.
### Operational concerns

- **Failure modes:** Normalizer failures should become `normalizer_failed` and map to sanitized run failure behavior. Schema failures after correction should preserve existing safe failure reasons.
- **Observability:** Existing tolerance events already record normalized/corrected/failed outcomes. Implementation should keep these events available in tests and safe logs where currently exposed.
- **Performance:** Deterministic normalizers are in-memory transformations over small result objects and should not add meaningful latency.
- **Rollout:** No feature flag is required if tests show existing valid outputs still pass. The behavior is a strict improvement for known near-misses.
- **Provider behavior:** Provider adapters that cannot perform correction still benefit from deterministic normalization. Unsupported correction behavior should not block the deterministic normalization part of this issue.
### Resolved technical decisions and open question

- `prFinalizeResultSchema` should move to `packages/api-contract` so execution registration and the core bridge share the same schema without a package cycle.
- Production `pr.finalize` should validate the returned in-memory `RunWorkResult.result` with the core `validatePullRequestFinalizeResult` bridge for now; it should not be moved to execution-entry-point `step-result.json` validation in this slice.
- Is there already a correction requester available for `pr.finalize` agent sessions, or should this issue only support deterministic normalization plus validation until a provider-backed correction requester is wired?
### Technical devil's advocate pass

- **Core-side validation could become a precedent for bypassing execution contracts.** This implementation intentionally chooses a core helper only for the current `pr.finalize` in-memory result source. It must stay a thin wrapper around `validateStepResult`, use the registered schema id and contract-local normalizers, and be documented as a bridge rather than a custom parser.
- **Dropping unknown spec frontmatter is safe only because frontmatter is system-owned.** The normalizer must not drop arbitrary unknown top-level result fields outside the frontmatter contract unless the schema/contract explicitly owns those fields.
- **An empty PR-finalize result might hide a provider failure.** The normalizer should only see candidates that came from a successful AI terminal result. Missing terminal results, invalid JSON, or provider errors must still fail before candidate normalization.
### Technical reviewer pass

The technical plan reuses the existing `validateStepResult` pipeline and keeps workflow side effects behind validated values. It names the main integration risk: `pr.finalize` currently parses in core after one-shot AI dispatch. The required core bridge preserves the architectural rule that validation happens before PR-finalize side effects while matching the current in-memory production result source. The spec-author frontmatter decision is intentionally narrow and should fix issue 83 without broadening the spec-authoring schema beyond its current contract.
## Converged API

### Files

Path
Purpose
Exports

`packages/api-contract/src/step-results.ts`
Add shared contract-owned Zod schemas and inferred types for pr.finalize structured AI-step results so execution and core can use the same schema without a package cycle.
`prFinalizeFindingSchema`, `prFinalizeResultSchema`, `PullRequestFinalizeFinding`, `PullRequestFinalizeResult`

`packages/execution/src/result-contracts.ts`
Make step-result contracts the obvious registration path for structured AI results by allowing contract-owned normalizers/correction/degradation policy and by registering [spec.author](http://spec.author) and pr.finalize contracts. Contract factories should attach their own deterministic normalizers by default: [spec.author](http://spec.author) gets the stamped frontmatter normalizer and pr.finalize gets prFinalizeCleanResultNormalizer unless callers explicitly override the contract options.
`StepResultContractDefinition`, `SPEC_AUTHOR_SCHEMA_ID`, `PR_FINALIZE_SCHEMA_ID`, `SpecAuthorResultContractOptions`, `PullRequestFinalizeResultContractOptions`, `createPullRequestFinalizeResultContract`, `registerPullRequestFinalizeResultContract`, `createSpecAuthorResultContract`, `registerSpecAuthorResultContract`, `stampSpecAuthorResultIdentity`

`packages/execution/src/result-normalizers.ts`
Add deterministic contract-specific normalizers for [spec.author](http://spec.author) frontmatter near-misses and clean pr.finalize omission-only results. Both new normalizers must be schema-id gated before acting: createSpecAuthorFrontmatterNormalizer only changes candidates for SPEC_AUTHOR_SCHEMA_ID, and prFinalizeCleanResultNormalizer only changes candidates for PR_FINALIZE_SCHEMA_ID. Keep defaultResultNormalizers at its current minimal global scope rather than adding these contract-specific normalizers globally; callers receive the new normalizers through the [spec.author](http://spec.author) and pr.finalize contract factories or explicit validation helper defaults.
`createSpecAuthorFrontmatterNormalizer`, `prFinalizeCleanResultNormalizer`, `defaultResultNormalizers`, `ResultNormalizer`, `ResultNormalizerRegistry`

`packages/execution/src/execution-entry-point.ts`
Apply contract-supplied normalizers, correction requester, max attempts, and degradation policy when validating scratch-file step results through validateStepResult. Normalizer precedence is additive, not config-wins replacement: when both contract.normalizers and config.normalizers are present, compose them in deterministic order with contract normalizers first and config normalizers second, so contract defaults such as spec-author frontmatter stamping still run for callers that provide per-run normalizers. Config correctionRequester, maxCorrectionAttempts, and degradationPolicy continue to override contract values when explicitly provided.
`ScratchFileExecutionResultValidationConfig`, `ExecutionResultValidationConfig`, `createExecutionEntryPoint`

`packages/execution/src/index.ts`
Re-export the new execution contract and normalizer symbols from @autocatalyst/execution, including symmetric first-class [spec.author](http://spec.author) and pr.finalize registration APIs so production wiring does not import result-contracts.ts by sub-path.
`SPEC_AUTHOR_SCHEMA_ID`, `PR_FINALIZE_SCHEMA_ID`, `SpecAuthorResultContractOptions`, `PullRequestFinalizeResultContractOptions`, `createSpecAuthorResultContract`, `registerSpecAuthorResultContract`, `createPullRequestFinalizeResultContract`, `registerPullRequestFinalizeResultContract`, `stampSpecAuthorResultIdentity`, `createSpecAuthorFrontmatterNormalizer`, `prFinalizeCleanResultNormalizer`

`packages/execution/src/result-contracts.spec.ts`
Unit-test structured result contract registration APIs, including [spec.author](http://spec.author) and pr.finalize defaults, duplicate-registration behavior, contract-level normalizer/correction/degradation policy propagation, and parity of SpecAuthorResultContractOptions with PullRequestFinalizeResultContractOptions.

`packages/execution/src/result-normalizers.spec.ts`
Unit-test deterministic normalizers: [spec.author](http://spec.author) drops stray frontmatter keys, removes optional null frontmatter values, overwrites system-owned fields, leaves invalid non-frontmatter fields for schema validation, and schema-id gates changes; pr.finalize normalizes \{\}, \{ findings: \[\] \}, and omission-only clean results, while leaving unknown keys, non-empty findings without directive, invalid directives, and contradictory candidates unchanged for validation/correction.

`packages/execution/src/execution-entry-point.spec.ts`
Regression-test scratch-file validation policy resolution, especially additive composition of contract.normalizers with config.normalizers and config override semantics for correction requester, max attempts, and degradation policy.

`packages/core/src/pr-finalize-result-validation.ts`
Provide a core-side bridge for validating in-memory pr.finalize RunWorkResult.result candidates through validateStepResult before PR-finalize workflow logic consumes them. The helper should default to the pr.finalize contract-local clean-result normalizer when no explicit normalizers are supplied, without relying on defaultResultNormalizers.
`ValidatePullRequestFinalizeResultInput`, `PullRequestFinalizeResultValidationOutcome`, `PullRequestFinalizeResultValidationSuccess`, `PullRequestFinalizeResultValidationFailure`, `validatePullRequestFinalizeResult`

`packages/core/src/pr-finalize.ts`
Consume the shared pr.finalize schema/types from api-contract, keep existing prompt/checkpoint/feedback helpers, and make parsePullRequestFinalizeResult a strict legacy parser only for already-tolerated or direct-call paths. Mark parsePullRequestFinalizeResult with @deprecated JSDoc to steer workflow code to validatePullRequestFinalizeResult for AI-step candidates.
`PullRequestFinalizePromptInput`, `PullRequestFinalizeFinding`, `PullRequestFinalizeResult`, `buildPullRequestFinalizePrompt`, `parsePullRequestFinalizeResult`, `buildPullRequestFinalizeCheckpoint`, `feedbackInputsFromPullRequestFinalizeFindings`

`packages/core/src/pr-finalize.spec.ts`
Regression-test public pr.finalize helpers and parser behavior, including existing valid advance/revise shapes, feedback mapping for blocker/warning/info findings, checkpoint construction from typed validated values, and the deprecated parser remaining strict for legacy direct-call paths.

`packages/core/src/pr-finalize-result-validation.spec.ts`
Unit-test the core validation bridge through validateStepResult: \{\} becomes a typed clean advance, omission-only clean results validate, ambiguous candidates are not normalized, correction requester attempts are bounded when configured, and failures return sanitized pr_finalize_invalid_result outcomes without raw model output.

`packages/core/src/orchestrator.ts`
Replace direct pr.finalize parsing with validatePullRequestFinalizeResult and continue PR-finalize side effects only after a typed validated result is returned.

`packages/core/src/orchestrator.spec.ts`
Integration-test orchestrator behavior: pr.finalize \{\} no longer fails with pr_finalize_invalid_result and advances using the validated clean result; existing valid advance behavior still freezes/spec-checkpoints and proceeds to PR opening; valid revise behavior still records implementation feedback and avoids PR-opening side effects; unrecoverable invalid candidates fail safely after pipeline recovery is exhausted.

`packages/core/src/index.ts`
Re-export the new core pr.finalize validation helper and outcome types from @autocatalyst/core. Keep parsePullRequestFinalizeResult exported only for compatibility, with the symbol itself marked @deprecated in pr-finalize.ts.
`ValidatePullRequestFinalizeResultInput`, `PullRequestFinalizeResultValidationOutcome`, `PullRequestFinalizeResultValidationSuccess`, `PullRequestFinalizeResultValidationFailure`, `validatePullRequestFinalizeResult`

`apps/control-plane/src/server.ts`
Wire production/default structured-result contract registries so [spec.author](http://spec.author) keeps its stamped frontmatter normalizer and pr.finalize is registered as the shared contract definition consumed by the core bridge. Server wiring must construct contract-local normalizers deliberately and should guard or prevalidate spec-author stamp options because factory-time ZodErrors are not caught by validateStepResult normalizer handling.

`apps/control-plane/src/pr-lifecycle.integration.spec.ts`
Production-path integration proof for pr.finalize recovery: drive the real dispatch/result boundary with a controlled provider or harness that emits \{\} at pr.finalize, without injecting a parsed result into the orchestrator or using test-only hooks that bypass the core validation bridge/result contract path; assert the run advances past pr.finalize toward PR opening/review and persisted checkpoints/run state contain the validated clean result rather than the raw \{\} candidate.

`apps/control-plane/src/spec-author.integration.spec.ts`
Production-path integration proof for [spec.author](http://spec.author) recovery: drive a run where the provider or harness writes step-result.json with stray frontmatter and optional null frontmatter values through the real execution entry point; assert the run reaches spec.human_review and the committed/persisted spec frontmatter is conformant, system-stamped, and free of raw near-miss keys.

`apps/control-plane/src/control-plane-service.integration.spec.ts`
If one full production-path test is practical, cover both recovery points in a single run from [spec.author](http://spec.author) near-miss output through pr.finalize \{\} output, with assertions that neither path injects parsed results or bypasses contract validation and that safe diagnostics do not expose raw prompts, provider transcripts, credentials, full scratch paths, or raw code-host output.

`context-agent/wiki/code-map.md`
Document the new pr-finalize validation bridge, contract-local normalizer registration pattern, execution-entry-point normalizer composition semantics, and updated structured step-result contract registration pattern for future agents.

### Public API

#### `prFinalizeFindingSchema`

```typescript
export const prFinalizeFindingSchema: z.ZodObject; summary: z.ZodString; target: z.ZodOptional; }, "strict">
```
- Returns: `Zod schema for one pr.finalize finding object`
#### `prFinalizeResultSchema`

```typescript
export const prFinalizeResultSchema: z.ZodObject; reconciledSummary: z.ZodOptional; titleSubject: z.ZodOptional; validationSummary: z.ZodOptional>; findings: z.ZodDefault>; }, "strict">
```
- Returns: `Zod schema for a typed pr.finalize structured result`
#### `SPEC_AUTHOR_SCHEMA_ID`

```typescript
export const SPEC_AUTHOR_SCHEMA_ID = 'autocatalyst.spec_author.v1' as const
```
- Returns: `'autocatalyst.spec_author.v1'`
#### `PR_FINALIZE_SCHEMA_ID`

```typescript
export const PR_FINALIZE_SCHEMA_ID = 'autocatalyst.pr_finalize.v1' as const
```
- Returns: `'autocatalyst.pr_finalize.v1'`
#### `createPullRequestFinalizeResultContract`

```typescript
export function createPullRequestFinalizeResultContract(options?: PullRequestFinalizeResultContractOptions): StepResultContractDefinition
```
- Parameters:
	- `options: PullRequestFinalizeResultContractOptions | undefined` — Optional result file, normalizer, correction, and validation policy overrides for the pr.finalize step contract. If normalizers is omitted, the contract includes prFinalizeCleanResultNormalizer as a contract-local default.
- Returns: `StepResultContractDefinition`
#### `registerPullRequestFinalizeResultContract`

```typescript
export function registerPullRequestFinalizeResultContract(registry: StepResultContractRegistry, options?: PullRequestFinalizeResultContractOptions): StepResultContractRegistry
```
- Parameters:
	- `registry: StepResultContractRegistry` — Registry that should receive the pr.finalize contract keyed by step and schema id.
	- `options: PullRequestFinalizeResultContractOptions | undefined` — Optional result file, normalizer, correction, and validation policy overrides passed to createPullRequestFinalizeResultContract.
- Returns: `StepResultContractRegistry`
- Errors:
	- `Error when the registry already contains a contract for step 'pr.finalize' and schema id 'autocatalyst.pr_finalize.v1'.`
#### `createSpecAuthorResultContract`

```typescript
export function createSpecAuthorResultContract(options?: SpecAuthorResultContractOptions): StepResultContractDefinition
```
- Parameters:
	- `options: SpecAuthorResultContractOptions | undefined` — Optional system stamp, normalizer, correction, and validation policy overrides for the [spec.author](http://spec.author) step contract. If normalizers is omitted, the contract includes createSpecAuthorFrontmatterNormalizer(options) as a contract-local default.
- Returns: `StepResultContractDefinition`
- Errors:
	- `ZodError can be thrown at factory-call time if the stamp options used to construct the default spec-author frontmatter normalizer are invalid; callers that construct production registries should guard or prevalidate these options.`
#### `registerSpecAuthorResultContract`

```typescript
export function registerSpecAuthorResultContract(registry: StepResultContractRegistry, options?: SpecAuthorResultContractOptions): StepResultContractRegistry
```
- Parameters:
	- `registry: StepResultContractRegistry` — Registry that should receive the [spec.author](http://spec.author) contract keyed by step and schema id.
	- `options: SpecAuthorResultContractOptions | undefined` — Optional trusted specced_by, clock, tracked issue number, normalizer, correction, max-attempt, and degradation policy settings passed to createSpecAuthorResultContract.
- Returns: `StepResultContractRegistry`
- Errors:
	- `Error when the registry already contains a contract for step 'spec.author' and schema id 'autocatalyst.spec_author.v1'.`
	- `ZodError can be thrown at factory-call time if default normalizer stamp options are invalid; this is construction-time validation, not a validateStepResult normalizer_failed event.`
#### `createSpecAuthorFrontmatterNormalizer`

```typescript
export function createSpecAuthorFrontmatterNormalizer(options?: SpecAuthorResultContractOptions): ResultNormalizer
```
- Parameters:
	- `options: SpecAuthorResultContractOptions | undefined` — System stamp options, including trusted specced_by, clock, and tracked issue number, used when normalizing [spec.author](http://spec.author) frontmatter.
- Returns: `ResultNormalizer that is schema-id gated to SPEC_AUTHOR_SCHEMA_ID before changing candidates`
- Errors:
	- `ZodError can be thrown at factory-call time, before any ResultNormalizer is returned, when trustedSpeccedBy, trackedIssueNumber, or clock-derived date values do not satisfy specAuthorFrontmatterSchema. This construction-time error is not caught by ResultNormalizerRegistry.normalize() or validateStepResult normalizer_failed handling; server wiring should guard the factory call or prevalidate stamp options.`
#### `prFinalizeCleanResultNormalizer`

```typescript
export const prFinalizeCleanResultNormalizer: ResultNormalizer
```
- Returns: `ResultNormalizer that first checks input.schemaId === PR_FINALIZE_SCHEMA_ID, then maps only unambiguous clean or omission-only pr.finalize objects such as {}, { findings: [] }, and { validationSummary: [] } to advance results; all other schemas and ambiguous candidates return unchanged`
#### `defaultResultNormalizers`

```typescript
export const defaultResultNormalizers: readonly ResultNormalizer[]
```
- Returns: `readonly ResultNormalizer[]; remains the minimal global default set for existing consumers, currently reviewer-oriented normalizers only. The new spec.author and pr.finalize normalizers are intentionally not added here and are installed through contract factories or explicit validation helper defaults.`
#### `stampSpecAuthorResultIdentity`

```typescript
export function stampSpecAuthorResultIdentity(candidate: unknown, optionsOrTrustedSpeccedBy?: SpecAuthorResultContractOptions | string): unknown
```
- Parameters:
	- `candidate: unknown` — Raw [spec.author](http://spec.author) candidate object, typically read from step-result.json before schema validation.
	- `optionsOrTrustedSpeccedBy: SpecAuthorResultContractOptions | string | undefined` — System-owned frontmatter stamp settings or legacy trusted specced_by string.
- Returns: `unknown`
- Errors:
	- `ZodError can be thrown at call time when stamp options are invalid; candidate shape problems are returned unchanged for schema validation rather than thrown. When this function is called inside a normalizer.normalize implementation, registry exception handling can convert thrown errors to normalizer_failed events; when called during factory/server wiring, callers must guard it themselves.`
#### `validatePullRequestFinalizeResult`

```typescript
export async function validatePullRequestFinalizeResult(input: ValidatePullRequestFinalizeResultInput): Promise
```
- Parameters:
	- `input: ValidatePullRequestFinalizeResultInput` — Run id, raw pr.finalize candidate, and optional normalizer/correction policy used to validate through validateStepResult. If input.normalizers is omitted, the helper uses prFinalizeCleanResultNormalizer as its contract-local default, not defaultResultNormalizers.
- Returns: `Promise`
#### `parsePullRequestFinalizeResult`

```typescript
/** @deprecated Use validatePullRequestFinalizeResult for AI-step candidates so normalization and correction run before workflow logic. */ export function parsePullRequestFinalizeResult(value: unknown): PullRequestFinalizeResult
```
- Parameters:
	- `value: unknown` — A value expected to already be a strict pr.finalize result. This parser is not the tolerance boundary and must not be used by orchestrator branches for raw AI-step candidates.
- Returns: `PullRequestFinalizeResult`
- Errors:
	- `Error when value does not satisfy prFinalizeResultSchema. Orchestrator code should prefer validatePullRequestFinalizeResult for AI-step candidates.`
### Types

#### `PullRequestFinalizeFinding`

```typescript
export type PullRequestFinalizeFinding = { severity: 'blocker' | 'warning' | 'info'; summary: string; target?: string | undefined; }
```
#### `PullRequestFinalizeResult`

```typescript
export type PullRequestFinalizeResult = { directive: 'advance' | 'revise'; reconciledSummary?: string | undefined; titleSubject?: string | undefined; validationSummary?: string[] | undefined; findings: PullRequestFinalizeFinding[]; }
```
#### `StepResultContractDefinition`

```typescript
export interface StepResultContractDefinition { readonly step: string; readonly schemaId: string; readonly schema: TSchema; readonly resultFile?: string; readonly normalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[]; readonly correctionRequester?: ResultCorrectionRequester; readonly maxCorrectionAttempts?: number; readonly degradationPolicy?: ResultDegradationPolicy; }
```
#### `PullRequestFinalizeResultContractOptions`

```typescript
export interface PullRequestFinalizeResultContractOptions { readonly resultFile?: string; readonly normalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[]; readonly correctionRequester?: ResultCorrectionRequester; readonly maxCorrectionAttempts?: number; readonly degradationPolicy?: ResultDegradationPolicy; }
```
#### `SpecAuthorResultContractOptions`

```typescript
export interface SpecAuthorResultContractOptions { readonly trustedSpeccedBy?: string; readonly clock?: () => string; readonly trackedIssueNumber?: number; readonly normalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[]; readonly correctionRequester?: ResultCorrectionRequester; readonly maxCorrectionAttempts?: number; readonly degradationPolicy?: ResultDegradationPolicy; }
```
#### `ValidatePullRequestFinalizeResultInput`

```typescript
export interface ValidatePullRequestFinalizeResultInput { readonly runId: string; readonly rawResult: unknown; readonly correctionRequester?: ResultCorrectionRequester; readonly maxCorrectionAttempts?: number; readonly normalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[]; readonly degradationPolicy?: ResultDegradationPolicy; }
```
#### `PullRequestFinalizeResultValidationOutcome`

```typescript
export type PullRequestFinalizeResultValidationOutcome = PullRequestFinalizeResultValidationSuccess | PullRequestFinalizeResultValidationFailure
```
#### `PullRequestFinalizeResultValidationSuccess`

```typescript
export interface PullRequestFinalizeResultValidationSuccess { readonly status: 'valid'; readonly value: PullRequestFinalizeResult; readonly events: readonly ResultToleranceEvent[]; readonly normalized: boolean; readonly correctedAttempts: number; }
```
#### `PullRequestFinalizeResultValidationFailure`

```typescript
export interface PullRequestFinalizeResultValidationFailure { readonly status: 'failed'; readonly reason: 'pr_finalize_invalid_result'; readonly events: readonly ResultToleranceEvent[]; }
```
### Notes

This artifact proposes code-facing API changes only; it adds no HTTP routes, UI surfaces, database schema, branch operations, push/merge behavior, or PR-opening API. Schema ownership is packages/api-contract/src/step-results.ts so @autocatalyst/execution can register pr.finalize without depending on @autocatalyst/core and the core bridge can validate against the same contract-owned schema. Normalizer policy is explicit: contract-specific normalizers are schema-id gated and contract-local by default, defaultResultNormalizers remains the existing minimal global default, and execution-entry-point scratch validation composes contract.normalizers before config.normalizers rather than letting config.normalizers silently drop contract defaults. Config correction requester, max attempts, and degradation policy remain explicit overrides. SpecAuthorResultContractOptions includes degradationPolicy for parity with pr.finalize and StepResultContractDefinition. @autocatalyst/execution must re-export SPEC_AUTHOR_SCHEMA_ID, SpecAuthorResultContractOptions, createSpecAuthorResultContract, registerSpecAuthorResultContract, and stampSpecAuthorResultIdentity from packages/execution/src/index.ts alongside the pr.finalize peers so apps/control-plane/src/server.ts and other production wiring use the package boundary rather than result-contracts.ts sub-path imports. createSpecAuthorFrontmatterNormalizer may throw option-validation ZodErrors at factory-call time, which validateStepResult does not catch; production server wiring should guard construction or validate stamp options before startup. parsePullRequestFinalizeResult remains exported for compatibility but should be marked @deprecated and must not be used as the recovery gate for raw AI-step candidates. packages/core/src/pr-finalize-result-validation.ts is the explicit production bridge for current pr.finalize results: it still calls validateStepResult and should be removed or simplified only if pr.finalize later moves fully to execution-entry-point scratch validation. Provider adapters without correction support still get deterministic normalization; unrecoverable or ambiguous candidates continue to fail safely with pr_finalize_invalid_result after pipeline recovery is exhausted. The listed test files cover unit normalizer behavior, orchestrator advance/revise/failure regressions, and production-path e2e proofs that do not inject parsed results or bypass the applicable production result boundary: createExecutionEntryPoint for [spec.author](http://spec.author) and the core validation bridge for pr.finalize.
## Task list

### Story 1: Shared PR-finalize contract schema

Provide a shared, contract-owned PR-finalize result schema so core and execution validate the same shape without creating a package cycle.
#### Task 1.1: Add shared PR-finalize step-result schemas

**Description:** Add `packages/api-contract/src/step-results.ts` with `prFinalizeFindingSchema`, `prFinalizeResultSchema`, and inferred `PullRequestFinalizeFinding` and `PullRequestFinalizeResult` types. Preserve the agreed strict schema shape from `## Converged API`, including defaulted `findings`.
**Acceptance criteria:**
- The new schema and types match the `## Converged API` signatures and do not add extra fields.
- `prFinalizeResultSchema` accepts valid `advance` and `revise` results and rejects unknown fields.
- Existing package export conventions are followed so downstream packages can import from the public package boundary.
**Dependencies:** None.
#### Task 1.2: Re-export shared step-result schema APIs

**Description:** Update the relevant `packages/api-contract` index/export file so execution and core can import the PR-finalize schemas and types through the package public API.
**Acceptance criteria:**
- `prFinalizeFindingSchema`, `prFinalizeResultSchema`, `PullRequestFinalizeFinding`, and `PullRequestFinalizeResult` are exported from `@autocatalyst/api-contract`.
- No downstream package imports the new file by an internal sub-path unless that is already the package convention.
- TypeScript compilation resolves the new public exports.
**Dependencies:** Task 1.1.
### Story 2: Contract-local normalizers for structured AI-step near-misses

Make deterministic normalization explicit, schema-id gated, and local to the contracts that need it.
#### Task 2.1: Add the spec-author frontmatter normalizer

**Description:** Implement `createSpecAuthorFrontmatterNormalizer` in `packages/execution/src/result-normalizers.ts`. The normalizer must act only for `SPEC_AUTHOR_SCHEMA_ID`, drop unknown frontmatter keys, remove optional `null` frontmatter values that the schema does not accept, and stamp Autocatalyst-owned fields through the agreed spec-author stamp options.
**Acceptance criteria:**
- The normalizer returns unchanged candidates when `schemaId` is not `SPEC_AUTHOR_SCHEMA_ID`.
- Unknown model-supplied frontmatter keys are absent from the normalized candidate.
- Optional known frontmatter fields with `null` are removed rather than converted to empty strings or invented defaults.
- System-owned fields (`created`, `last_updated`, `status`, tracked `issue`, and `specced_by`) are overwritten by trusted values.
- Invalid top-level result fields remain available for normal schema validation failure.
**Dependencies:** None.
#### Task 2.2: Add the PR-finalize clean-result normalizer

**Description:** Implement `prFinalizeCleanResultNormalizer` in `packages/execution/src/result-normalizers.ts`. The normalizer must act only for `PR_FINALIZE_SCHEMA_ID` and map unambiguous clean omission-only candidates to typed clean advance candidates.
**Acceptance criteria:**
- `{}` normalizes to `{ directive: 'advance', findings: [] }`.
- `{ findings: [] }` normalizes to `{ directive: 'advance', findings: [] }`.
- `{ validationSummary: [] }` normalizes to `{ directive: 'advance', validationSummary: [], findings: [] }`.
- Candidates with unknown keys, invalid directives, non-empty findings without a directive, or contradictory signals are returned unchanged for validation or correction.
- The normalizer returns unchanged candidates when `schemaId` is not `PR_FINALIZE_SCHEMA_ID`.
**Dependencies:** Story 1.
#### Task 2.3: Test contract-specific normalizer behavior

**Description:** Add or update `packages/execution/src/result-normalizers.spec.ts` to cover the deterministic normalization rules for spec-author and PR-finalize candidates.
**Acceptance criteria:**
- Tests prove spec-author stray frontmatter keys are dropped.
- Tests prove spec-author optional `null` frontmatter values are removed.
- Tests prove spec-author system-owned fields are overwritten.
- Tests prove spec-author schema-id gating and invalid non-frontmatter passthrough.
- Tests prove PR-finalize clean omissions normalize and ambiguous candidates do not.
**Dependencies:** Tasks 2.1 and 2.2.
### Story 3: First-class step-result contract registration

Make `spec.author` and `pr.finalize` use symmetric contract factories so future structured AI steps follow one obvious registration pattern.
#### Task 3.1: Extend step-result contract definitions

**Description:** Update `packages/execution/src/result-contracts.ts` so `StepResultContractDefinition` supports contract-owned normalizers, correction requester, max correction attempts, and degradation policy as specified in `## Converged API`.
**Acceptance criteria:**
- `StepResultContractDefinition` includes the agreed optional validation policy fields.
- Existing reviewer and spec-author contracts remain compatible with existing callers.
- Duplicate-registration behavior remains stable and tested.
**Dependencies:** None.
#### Task 3.2: Update spec-author contract factory and stamping API

**Description:** Update `createSpecAuthorResultContract`, `registerSpecAuthorResultContract`, `SpecAuthorResultContractOptions`, and `stampSpecAuthorResultIdentity` to match the converged API. The default spec-author contract should install `createSpecAuthorFrontmatterNormalizer(options)` unless callers explicitly supply normalizers.
**Acceptance criteria:**
- Public spec-author factory and registration APIs match the converged signatures.
- The default spec-author contract includes the frontmatter normalizer.
- Caller-supplied normalizers override the factory default only where the converged API says they do.
- Factory-time Zod errors for invalid stamp options are documented by behavior and tests.
- Legacy `stampSpecAuthorResultIdentity(candidate, trustedSpeccedBy)` usage remains compatible.
**Dependencies:** Task 2.1 and Task 3.1.
#### Task 3.3: Add PR-finalize contract factory and registration API

**Description:** Add `PR_FINALIZE_SCHEMA_ID`, `PullRequestFinalizeResultContractOptions`, `createPullRequestFinalizeResultContract`, and `registerPullRequestFinalizeResultContract` to `packages/execution/src/result-contracts.ts`.
**Acceptance criteria:**
- `PR_FINALIZE_SCHEMA_ID` equals `'autocatalyst.pr_finalize.v1'`.
- The PR-finalize contract uses `prFinalizeResultSchema` from `@autocatalyst/api-contract`.
- The default PR-finalize contract includes `prFinalizeCleanResultNormalizer`.
- Duplicate registration for `pr.finalize` and `autocatalyst.pr_finalize.v1` throws the expected error.
**Dependencies:** Story 1, Task 2.2, and Task 3.1.
#### Task 3.4: Re-export execution contract and normalizer APIs

**Description:** Update `packages/execution/src/index.ts` to export all agreed spec-author and PR-finalize contract and normalizer symbols.
**Acceptance criteria:**
- Public exports match the list in `## Converged API`.
- Production wiring can import from `@autocatalyst/execution` without `result-contracts.ts` or `result-normalizers.ts` sub-path imports.
- Existing public exports remain available.
**Dependencies:** Tasks 2.1, 2.2, 3.2, and 3.3.
#### Task 3.5: Test contract registration APIs

**Description:** Add or update `packages/execution/src/result-contracts.spec.ts` to cover spec-author and PR-finalize contract defaults, duplicate-registration behavior, policy propagation, and options parity.
**Acceptance criteria:**
- Tests prove both factories attach their contract-local default normalizers when no explicit normalizers are supplied.
- Tests prove correction requester, max attempts, and degradation policy are propagated through contract definitions.
- Tests prove `SpecAuthorResultContractOptions` and `PullRequestFinalizeResultContractOptions` support the agreed policy fields.
- Tests prove duplicate registrations fail with stable messages.
**Dependencies:** Tasks 3.2 and 3.3.
### Story 4: Execution-boundary validation policy composition

Ensure scratch-file validation applies contract defaults and per-run overrides without silently losing contract-owned normalizers.
#### Task 4.1: Compose contract and config normalizers in the execution entry point

**Description:** Update `packages/execution/src/execution-entry-point.ts` so scratch-file validation composes `contract.normalizers` before `config.normalizers` when both are present. Keep config correction requester, max attempts, and degradation policy as explicit overrides over contract values.
**Acceptance criteria:**
- Contract normalizers run before config normalizers.
- Supplying config normalizers does not silently drop contract defaults.
- Config correction requester, max correction attempts, and degradation policy override contract values when provided.
- Existing inline schema and direct-contract validation paths keep working.
**Dependencies:** Task 3.1.
#### Task 4.2: Test execution-entry-point validation policy resolution

**Description:** Add regression coverage in `packages/execution/src/execution-entry-point.spec.ts` for additive normalizer composition and validation-policy override semantics.
**Acceptance criteria:**
- Tests prove contract and config normalizers both run in deterministic order.
- Tests prove config policy fields override contract policy fields.
- Tests prove existing scratch-file validation still validates successful step results.
- Tests cover a spec-author path where contract-local frontmatter stamping still runs even with per-run normalizers.
**Dependencies:** Task 4.1.
### Story 5: PR-finalize validation bridge in core

Validate in-memory `pr.finalize` AI-step candidates through the tolerance pipeline before orchestrator workflow logic consumes them.
#### Task 5.1: Add `validatePullRequestFinalizeResult`

**Description:** Create `packages/core/src/pr-finalize-result-validation.ts` with the agreed input, success, failure, and outcome types. The helper should call `validateStepResult` with `step: 'pr.finalize'`, `PR_FINALIZE_SCHEMA_ID`, `prFinalizeResultSchema`, and `prFinalizeCleanResultNormalizer` as the default normalizer when no explicit normalizers are supplied.
**Acceptance criteria:**
- `{}` returns a successful typed clean advance outcome with normalization events.
- Valid advance and revise candidates return typed success outcomes.
- Ambiguous invalid candidates return `{ status: 'failed', reason: 'pr_finalize_invalid_result', events }` after configured recovery is exhausted.
- Correction requester and max attempts are passed through to `validateStepResult`.
- Failure outcomes do not expose raw model output, prompts, secrets, full scratch paths, or raw code-host output.
**Dependencies:** Story 1, Task 2.2, and Task 3.3.
#### Task 5.2: Update PR-finalize helpers to consume shared schema and mark strict parser as legacy

**Description:** Update `packages/core/src/pr-finalize.ts` to import the shared schema and types from `@autocatalyst/api-contract`. Keep `parsePullRequestFinalizeResult` strict for direct-call or already-tolerated paths and mark it with the agreed `@deprecated` JSDoc.
**Acceptance criteria:**
- Public helper behavior for prompt building, checkpoint building, feedback mapping, and strict parsing remains compatible.
- The strict parser still rejects `{}` and unknown fields.
- The parser JSDoc directs AI-step candidates to `validatePullRequestFinalizeResult`.
- No duplicate PR-finalize schema remains in core.
**Dependencies:** Story 1.
#### Task 5.3: Re-export PR-finalize validation APIs from core

**Description:** Update `packages/core/src/index.ts` to export `validatePullRequestFinalizeResult` and its outcome/input types while keeping existing PR-finalize exports compatible.
**Acceptance criteria:**
- Public core exports match the `## Converged API` list.
- Existing consumers of PR-finalize helpers still compile.
- New orchestrator code can import the validation helper through the package boundary or local module according to existing core conventions.
**Dependencies:** Tasks 5.1 and 5.2.
#### Task 5.4: Test the core PR-finalize validation bridge

**Description:** Add `packages/core/src/pr-finalize-result-validation.spec.ts` to verify the bridge calls the tolerance pipeline and returns safe typed outcomes.
**Acceptance criteria:**
- Tests prove `{}` and omission-only clean results normalize to clean advance.
- Tests prove ambiguous candidates are not normalized.
- Tests prove correction attempts are bounded when configured.
- Tests prove invalid failures return sanitized `pr_finalize_invalid_result` outcomes.
- Tests prove the helper does not rely on `defaultResultNormalizers`.
**Dependencies:** Task 5.1.
#### Task 5.5: Regression-test existing PR-finalize helpers

**Description:** Update `packages/core/src/pr-finalize.spec.ts` for the shared-schema migration and legacy strict parser behavior.
**Acceptance criteria:**
- Existing valid `advance` and `revise` result shapes still parse.
- Feedback mapping for blocker, warning, and info findings remains unchanged.
- Checkpoint construction uses typed validated values.
- The deprecated parser remains strict for `{}` and unknown fields.
**Dependencies:** Task 5.2.
### Story 6: Orchestrator and production wiring

Route production structured AI-step candidates through registered contracts and consume only validated PR-finalize values in workflow side effects.
#### Task 6.1: Replace direct PR-finalize parsing in the orchestrator

**Description:** Update `packages/core/src/orchestrator.ts` so `DefaultOrchestrator.dispatch` calls `validatePullRequestFinalizeResult` for raw `RunWorkResult.result` values from `pr.finalize` before any PR-finalize side effects run.
**Acceptance criteria:**
- The orchestrator no longer calls `parsePullRequestFinalizeResult(result.result)` for raw AI-step candidates.
- `directive: 'advance'` stores the validated checkpoint, freezes the spec, and advances to PR opening as before.
- `directive: 'revise'` records implementation-targeted feedback and avoids PR-opening side effects as before.
- Validation failure after normalization and correction fails the run with `pr_finalize_invalid_result` or the agreed equivalent safe reason.
- Persisted checkpoints or run state reflect the validated result, not raw `{}` candidates.
**Dependencies:** Story 5.
#### Task 6.2: Wire production/default contract registries

**Description:** Update `apps/control-plane/src/server.ts` so production/default structured-result contract registries use the public execution registration APIs for spec-author and PR-finalize contracts. `spec.author` continues to use execution-entry-point scratch validation; `pr.finalize` is registered as the shared contract definition consumed by the required core bridge for this slice.
**Acceptance criteria:**
- Spec-author registry setup preserves the stamped frontmatter normalizer.
- PR-finalize is registered with `registerPullRequestFinalizeResultContract` so the core bridge and any future execution-boundary move use the same schema id, schema, normalizer, and policy definition.
- Server wiring imports contract APIs from `@autocatalyst/execution`.
- Spec-author stamp options are prevalidated or construction-time Zod errors are guarded as described in the spec.
- Existing `implementation.build` reviewer validation remains wired.
**Dependencies:** Story 3 and Story 4.
#### Task 6.3: Test orchestrator PR-finalize outcomes

**Description:** Update `packages/core/src/orchestrator.spec.ts` to cover normalized advance, existing advance, existing revise, and unrecoverable invalid PR-finalize outcomes.
**Acceptance criteria:**
- `{}` at `pr.finalize` no longer fails with immediate `pr_finalize_invalid_result`.
- Existing valid advance behavior still freezes/checkpoints and proceeds toward PR opening.
- Existing valid revise behavior still records implementation feedback and skips PR-opening side effects.
- Unrecoverable invalid candidates fail safely after pipeline recovery is exhausted.
- Tests assert workflow logic sees typed validated values.
**Dependencies:** Task 6.1.
### Story 7: Production-path recovery proof

Prove the issue-83 failures recover through real result boundaries rather than direct parsed-result injection.
#### Task 7.1: Add spec-author production-path integration coverage

**Description:** Add or update `apps/control-plane/src/spec-author.integration.spec.ts` so a controlled provider or harness writes `step-result.json` with stray frontmatter and optional `null` frontmatter values through the real execution entry point.
**Acceptance criteria:**
- The test drives the same scratch result boundary production uses for `spec.author`.
- The run reaches `spec.human_review`.
- The committed or persisted spec frontmatter is conformant, system-stamped, and free of stray near-miss keys.
- The test does not inject a parsed spec-author result directly into core logic.
- Captured diagnostics do not expose raw prompts, provider transcripts, credentials, or full scratch paths.
**Dependencies:** Stories 2, 3, 4, and Task 6.2.
#### Task 7.2: Add PR-finalize production-path integration coverage

**Description:** Add or update `apps/control-plane/src/pr-lifecycle.integration.spec.ts` so a controlled provider or harness emits `{}` at `pr.finalize` through the real dispatch/result boundary.
**Acceptance criteria:**
- The test does not inject a parsed PR-finalize result into the orchestrator.
- The run advances past `pr.finalize` toward PR opening or PR human review.
- The run does not record `pr_finalize_invalid_result` for the clean empty result.
- Persisted checkpoints or run state contain the validated clean advance result rather than raw `{}`.
- Captured diagnostics do not expose raw prompts, provider transcripts, credentials, full scratch paths, or raw code-host output.
**Dependencies:** Story 5 and Story 6.
#### Task 7.3: Add optional combined full-run coverage if practical

**Description:** If the existing control-plane harness can do this without brittle timing or excessive runtime, add a combined scenario in `apps/control-plane/src/control-plane-service.integration.spec.ts` that exercises spec-author frontmatter recovery and PR-finalize `{}` recovery in one run.
**Acceptance criteria:**
- The combined test uses real production-path result boundaries for both AI steps.
- The run reaches the same lifecycle points as the separate tests.
- Assertions verify validated values and safe diagnostics at both recovery points.
- If the combined test is not practical, the implementation notes why the separate integration tests are the supported proof.
**Dependencies:** Tasks 7.1 and 7.2.
### Story 8: Documentation and agent handoff

Keep repository navigation docs current for future agents that touch structured AI-step contracts.
#### Task 8.1: Update the agent code map

**Description:** Update `context-agent/wiki/code-map.md` to document the new PR-finalize validation bridge, contract-local normalizer registration pattern, execution-entry-point normalizer composition behavior, and structured step-result contract registration flow.
**Acceptance criteria:**
- The code map points future agents to the new API-contract, execution, core, and control-plane files.
- The notes distinguish contract-local normalizers from `defaultResultNormalizers`.
- The notes mention that config normalizers compose after contract normalizers.
- The notes mention that `parsePullRequestFinalizeResult` is strict legacy behavior, not the AI-step tolerance boundary.
**Dependencies:** Stories 1 through 6.
### Story 9: Verification

Run targeted checks that cover schema exports, normalizers, contract registration, execution-boundary policy, core PR-finalize behavior, orchestrator behavior, and production-path integrations.
#### Task 9.1: Run execution package tests

**Description:** Run the targeted execution test set for result contracts, result normalizers, result tolerance, and execution-entry-point validation policy.
**Acceptance criteria:**
- Execution tests pass for the changed contract, normalizer, and scratch-validation behavior.
- Any skipped or unavailable test is documented with the reason.
- Failures, if any, are resolved or captured as follow-up blockers.
**Dependencies:** Stories 2, 3, and 4.
#### Task 9.2: Run core package tests

**Description:** Run the targeted core test set for PR-finalize helpers, PR-finalize validation, and orchestrator behavior.
**Acceptance criteria:**
- Core tests pass for valid advance, valid revise, normalized `{}`, and unrecoverable invalid PR-finalize candidates.
- Existing strict parser compatibility remains covered.
- Any skipped or unavailable test is documented with the reason.
**Dependencies:** Stories 5 and 6.
#### Task 9.3: Run control-plane integration tests

**Description:** Run the targeted control-plane integration tests for spec-author recovery, PR lifecycle recovery, and any combined full-run coverage that was added.
**Acceptance criteria:**
- Integration tests prove recovery through production-path result boundaries.
- Tests assert persisted validated values rather than raw near-miss candidates.
- Redaction assertions pass for logs or errors that include validation diagnostics.
- Any skipped or unavailable test is documented with the reason.
**Dependencies:** Story 7.
#### Task 9.4: Run broader validation required by the repository

**Description:** Run the broader project validation command set if the repository defines one, or the closest practical typecheck/test command set for the changed packages.
**Acceptance criteria:**
- Broader validation passes, or any failures are documented with root cause and relation to this change.
- The final implementation handoff lists exact commands run and outcomes.
- No branch, push, merge, worktree, or PR operation is performed by the agent.
**Dependencies:** Tasks 9.1, 9.2, and 9.3.