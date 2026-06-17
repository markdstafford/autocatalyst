---
created: 2026-06-17
last_updated: 2026-06-17
status: complete
issue: 75
specced_by: autocatalyst
---
# Enhancement: Tolerate near-miss reviewer results

## Product requirements

### What

Route `implementation.build` reviewer-result validation in both convergence engines through the existing step-result tolerance pipeline instead of directly calling `reviewerResultSchema.safeParse(...)`.
When a reviewer returns a common near-miss clean-review shape, such as `{}` or `{ "findings": [] }`, Autocatalyst normalizes it to:
```json
{ "status": "satisfied", "findings": [] }
```
If deterministic normalization cannot repair the result, Autocatalyst asks the reviewer to correct the result through the bounded correction path when a `ResultCorrectionRequester` is configured for reviewer results. When no correction requester is configured, invalid output may fail after normalization and schema validation. The terminal failure reason remains `reviewer_result_invalid` after configured correction is exhausted or unavailable.
This enhancement applies to both current convergence implementations:
- `packages/core/src/convergence-engine.ts`
- `packages/core/src/layered-convergence-engine.ts`
### Why

A real feature run can currently fail during `implementation.build` after a reviewer completes a trivially correct review but emits a near-miss contract result. The reviewer prompt already asks for the correct JSON, and the execution boundary already owns a tolerance pipeline for model result contracts. The gap is that the convergence engines bypass that pipeline and validate the reviewer result with a strict schema parse.
That makes a clean review brittle. A bare `{}` or `{ "findings": [] }` can stop the run before the PR phase with `reviewer_result_invalid`, even though the intended meaning is clear and unambiguous.
This enhancement closes that gap by applying the same ADR-012 soft-contract rule to convergence reviewer results: normalize what is safe, validate the result, ask the model to fix what remains invalid when a correction requester is configured, and otherwise fail safely after bounded recovery is exhausted or unavailable.
### Goals

- Prevent common clean-review near misses from hard-failing an otherwise correct run.
- Reuse the existing `validateStepResult` tolerance pipeline rather than adding a second reviewer-result repair path.
- Normalize only deterministic, unambiguous reviewer results.
- Preserve strict schema validation for all reviewer outputs after normalization and correction.
- Ask the reviewer to correct invalid output before failing the convergence round when a reviewer-result correction requester is configured.
- Keep `reviewer_result_missing` behavior for truly absent reviewer results.
- Keep `reviewer_result_invalid` as the terminal failure reason when validation still fails after tolerance handling.
- Preserve ADR-026 behavior: a same-model implementer/reviewer pairing records a warning and is not fatal.
- Prove the behavior through unit coverage and one required production-path end-to-end test that drives the real convergence dispatch and tolerance path.
### Non-goals

- Do not change the reviewer prompt in `implementation-build-context.ts`; it already asks for the desired contract.
- Do not change role-distinct routing fallback logic except to preserve the existing warning behavior.
- Do not implement full ADR-027 contract verification for every step boundary.
- Do not add the feedback resolution check keyed to a real item.
- Do not change the `reviewerResultSchema` contract shape for valid reviewer outputs.
- Do not treat ambiguous reviewer output as satisfied.
- Do not add UI for tolerance warnings or reviewer correction attempts in this slice.
### Personas

- **Opal (Operator)** needs real runs to recover from obvious clean-review formatting misses instead of stopping before PR creation.
- **Enzo (Engineer)** needs convergence validation to reuse the shared tolerance pipeline so result-repair behavior is consistent across execution paths.
- **Phoebe (PM)** needs Autocatalyst to be reliable enough that a trivial reviewer JSON miss does not waste a feature run.
### User stories

- As Opal, I can run a feature through `implementation.build` when the reviewer returns `{}` and see the run proceed past the implementation gate instead of failing immediately.
- As Enzo, I can inspect unit and integration tolerance events when Autocatalyst recovered from a near-miss reviewer result in this slice.
- As Enzo, I can add reviewer-result normalizers through the existing normalizer registry instead of writing custom parsing in each convergence engine.
- As Enzo, I can rely on the same normalize → validate → ask-to-fix flow for reviewer results in both build-only and layered convergence.
- As Phoebe, I can trust that single-model implementer/reviewer routing degrades loudly with a warning and never stops the run only because the roles resolved to the same model.
### Acceptance criteria

#### Reviewer-result tolerance

- Both convergence engines validate reviewer results through `validateStepResult` from `packages/execution/src/result-tolerance.ts`.
- The direct `reviewerResultSchema.safeParse(...)` calls in `packages/core/src/convergence-engine.ts` and `packages/core/src/layered-convergence-engine.ts` are replaced.
- The pipeline uses the existing reviewer result schema registered under `REVIEWER_RESULT_SCHEMA_ID` / `autocatalyst.reviewer_result.v1`.
- A reviewer result of `{}` normalizes to `{ "status": "satisfied", "findings": [] }`.
- A reviewer result of `{ "findings": [] }` normalizes to `{ "status": "satisfied", "findings": [] }`.
- The normalizer does not change any result with non-empty findings and no `status`, because that is ambiguous.
- The normalizer does not change malformed findings, unknown statuses, or partially valid finding objects in a way that guesses reviewer intent.
#### Correction and failure behavior

- A reviewer result that cannot be normalized routes to the bounded correction retry when a reviewer-result correction requester is configured.
- A valid corrected reviewer result lets the convergence round continue.
- A still-invalid corrected reviewer result fails with `reviewer_result_invalid` only after the retry limit is exhausted or correction is unavailable.
- A missing reviewer result still fails with `reviewer_result_missing`.
- Reviewer dispatch failures and `needs_input` results keep their current precedence and are returned before reviewer-result tolerance handling.
- No raw model output, provider diagnostics, secrets, or host paths are exposed in failure reasons.
#### Single-model reviewer behavior

- If distinct implementer/reviewer routing cannot be satisfied, Autocatalyst falls back to per-role resolution as it does today.
- The convergence record keeps `warningCode: "role_distinct_unsatisfied"` for the degraded pairing.
- Same-model implementer/reviewer routing is never fatal by itself.
- The reviewer session still runs even when it resolves to the same model as the implementer.
#### Tests

- Unit tests cover `{}` reviewer output normalizing to a satisfied reviewer result.
- Unit tests cover `{ "findings": [] }` reviewer output normalizing to a satisfied reviewer result.
- Unit tests cover ambiguous or malformed reviewer output routing to correction when a requester is configured.
- Unit tests cover correction success and correction exhaustion.
- Unit tests cover both `convergence-engine.ts` and `layered-convergence-engine.ts`.
- Unit tests preserve `reviewer_result_missing`, reviewer dispatch failure, and reviewer `needs_input` behavior.
- Tests prove single-model routing records the warning and proceeds rather than failing.
- A required end-to-end test drives a real feature run through `implementation.build` reviewer dispatch, returns a near-miss reviewer result such as `{}`, recovers through normalization or correction, and proceeds past the implementation gate. The test must use the real convergence dispatch and tolerance path, not an injected final verdict.
## Design spec

### Design scope

This is a backend reliability enhancement. There is no new screen, workflow surface, or human-facing UI copy in this slice.
The design work is the run behavior and developer/operator experience around reviewer-result recovery:
- reviewer output still has one contract;
- near misses recover through a shared tolerance path;
- unrecoverable output fails with the same public-safe reason as today;
- degraded same-model review remains visible as a warning.
### Operator experience

The expected operator-visible behavior is simple:
1. A feature run reaches `implementation.build`.
2. The reviewer reads the implementer's committed change.
3. If the reviewer emits `{}` or `{ "findings": [] }`, the run treats that as a clean review. For this slice, the recorded tolerance event must be inspectable in unit and integration pipeline results; no production operator-facing checkpoint or UI surface is required.
4. The convergence loop continues as if the reviewer had emitted the full satisfied shape.
5. The run can proceed to the PR phase when the implementation gate is satisfied.
The operator should not need to know which convergence engine handled the run. Build-only and layered convergence should recover the same way.
When the result is not safely repairable, the run should fail or pause exactly as it does today, but only after the bounded correction path gets a chance to recover it when a correction requester is configured. If no correction requester is configured, invalid output may fail after normalization and validation.
### Developer experience

Convergence code should stop owning ad hoc reviewer-result parsing. A developer reading the engines should see one helper or seam that:
1. accepts the raw reviewer result;
2. invokes `validateStepResult` with the reviewer schema and reviewer normalizers;
3. optionally invokes a correction requester;
4. returns a typed `ReviewerResult` or a mapped convergence failure.
This helper should be shared by both convergence engines if practical. If it stays local to each engine for implementation simplicity, both call sites should still use the same normalizer and pipeline options.
The normalizer should live with the existing execution result-normalizer infrastructure, because it is a deterministic result-shape repair. It should not live in the convergence engines as bespoke conditionals.
### Result flow

The recovered path is:
1. Reviewer dispatch returns `advance` with a raw result value.
2. The convergence engine confirms the raw result exists.
3. The engine calls the reviewer-result tolerance helper.
4. The helper runs deterministic reviewer normalizers.
5. `{}` and `{ "findings": [] }` become `{ "status": "satisfied", "findings": [] }`.
6. `reviewerResultSchema` validates the normalized value.
7. The engine continues with `findings = []`.
8. The round can converge normally.
The correction path is:
1. Reviewer dispatch returns a raw result that does not normalize to a valid value.
2. `validateStepResult` builds validation issues for the reviewer schema.
3. When configured, the correction requester asks the reviewer to return only the contract shape.
4. The corrected candidate re-enters normalization and validation.
5. A valid corrected value continues the round.
6. Exhausted correction, or unavailable correction when no requester is configured, maps back to `reviewer_result_invalid`.
The missing-result path is unchanged:
1. Reviewer dispatch advances without `reviewerResult` and without `workResult.result`.
2. The convergence engine returns `reviewer_result_missing`.
3. The tolerance pipeline is not called because there is no candidate to validate.
### Normalization rules

The reviewer normalizer is intentionally narrow:
- If the candidate is exactly an object with no own keys, return satisfied with no findings.
- If the candidate is an object with only `findings` and that value is an empty array, return satisfied with no findings.
- If the candidate already has a `status`, leave it to schema validation.
- If `findings` is non-empty and `status` is missing, do not guess whether the reviewer intended `findings`; route to correction when a requester is configured, otherwise leave it to fail validation safely.
- If the candidate is not a plain object, do not normalize it.
This keeps ADR-012's hard rule: deterministic repairs only, no silent guessing.
### Warning and telemetry behavior

The existing route-distinct fallback warning remains the source of truth for single-model review degradation. This enhancement should not turn `role_distinct_unsatisfied` into a failure.
Tolerance outcomes must be observable in unit and integration tests through the pipeline result events. If production run-step checkpoint data already has a safe place to carry warning metadata, the implementation may also record the reviewer-result normalization there, but this slice does not require a production operator-facing checkpoint or UI surface for reviewer-result normalization events.
## Tech spec

### Current state

- `packages/api-contract/src/convergence.ts` defines `reviewerResultSchema` as a discriminated union on `status`.
- `packages/execution/src/result-tolerance.ts` already implements `validateStepResult`, which runs normalization, schema validation, bounded correction, and optional degradation.
- `packages/execution/src/result-normalizers.ts` already owns the normalizer registry. Its default registry is currently empty.
- `packages/execution/src/result-contracts.ts` already defines `REVIEWER_RESULT_SCHEMA_ID` and `registerReviewerResultContract()` for `implementation.build`.
- `packages/core/src/convergence-engine.ts` directly validates reviewer output with `reviewerResultSchema.safeParse(rawResult)`.
- `packages/core/src/layered-convergence-engine.ts` directly validates reviewer output with `reviewerResultSchema.safeParse(rawResult)`.
- `packages/core/src/implementation-build-context.ts` already prompts the reviewer to emit the full valid JSON shape, so prompt changes are not needed.
- `resolveReviewedRoutes()` already falls back on `role_distinct_unsatisfied`, logs a sanitized warning, and returns routing metadata with `warningCode`.
### Proposed implementation shape

Add a reviewer-result normalizer to the existing result-normalizer layer:
- Export a focused normalizer factory or default normalizer from `packages/execution/src/result-normalizers.ts`.
- Register it for `REVIEWER_RESULT_SCHEMA_ID` or make it conditional on `schemaId === REVIEWER_RESULT_SCHEMA_ID`.
- Keep the default normalizer deterministic and schema-specific so it does not affect unrelated step contracts.
Add a core helper for convergence reviewer validation:
- Suggested file: `packages/core/src/reviewer-result-validation.ts`.
- Inputs include `runId`, `step`, `rawResult`, optional correction requester, and any tolerance options needed by tests.
- It calls `validateStepResult({ schema: reviewerResultSchema, schemaId: REVIEWER_RESULT_SCHEMA_ID, step, candidate: rawResult, ... })`.
- It returns either `{ status: "valid", value: ReviewerResult, events }` or `{ status: "failed", reason: "reviewer_result_invalid", events }`.
- It does not handle `undefined`; callers keep `reviewer_result_missing` logic.
Update both convergence engines:
- Replace direct `reviewerResultSchema.safeParse(...)` calls with the helper.
- Keep reviewer dispatch failure and reviewer `needs_input` checks before validation.
- Keep the current checkpoint-building behavior when validation fails.
- Preserve the existing `findings` derivation from the typed `ReviewerResult`.
- Preserve route warning propagation into convergence round records.
Wire correction support:
- Prefer the same correction seam used by execution result validation.
- If the current reviewer dispatch path cannot yet issue a provider-backed correction request directly from core, add an injectable `ResultCorrectionRequester` option to the convergence engine and use scripted correction in tests.
- In production, connect that requester to the same reviewer model/session mechanism only if that seam already exists. If not, correction is required only when a requester is configured; without one, normalization still lands first and unnormalized invalid reviewer output fails safely as `reviewer_result_invalid`.
### Test plan

Targeted tests:
- `pnpm nx test execution -- result-normalizers.spec.ts`
- `pnpm nx test execution -- result-tolerance.spec.ts`
- `pnpm nx test core -- convergence-engine.spec.ts`
- `pnpm nx test core -- layered-convergence-engine.spec.ts`
- `pnpm nx test control-plane -- implementation-build-convergence.smoke.spec.ts`
Required new or updated coverage:
- Execution normalizer tests for `{}` and `{ "findings": [] }`.
- Core helper tests for valid, normalized, corrected, and exhausted reviewer results.
- Convergence engine tests proving normalized clean-review output converges.
- Layered convergence engine tests proving normalized clean-review output converges at build altitude.
- Route-distinct fallback tests proving `warningCode: "role_distinct_unsatisfied"` remains non-fatal.
- A production-path end-to-end test in the control-plane smoke suite that drives real convergence dispatch, returns a near-miss reviewer result from the reviewer session, and observes the run progress past the implementation gate.
### Risks and edge cases

- A too-broad normalizer could hide real reviewer mistakes. Keep normalization limited to empty clean-review shapes.
- Core may not currently have a production correction requester for reviewer results. If that seam is missing, implement the injectable shape and test correction behavior without claiming unsupported provider correction is complete; production then normalizes first and may fail invalid unrepaired output as `reviewer_result_invalid`.
- Providers that cannot enforce reviewer read-only tool policy remain unsupported for reviewer sessions and must fail safely or grant no file/git access, as existing convergence docs state.
- The layered engine must apply the same validation behavior at every altitude where reviewer output is consumed.
## Converged API

### Files

Path
Purpose
Exports

`packages/execution/src/result-normalizers.ts`
Add a schema-specific reviewer-result normalizer const to the existing deterministic result-normalizer registry so common clean-review near misses are repaired before schema validation.
`reviewerResultNormalizer`, `defaultResultNormalizers`

`packages/execution/src/index.ts`
Re-export the reviewer-result normalizer const from the execution package public surface alongside the existing result tolerance APIs.
`reviewerResultNormalizer`

`packages/core/src/reviewer-result-validation.ts`
Provide the shared convergence helper that validates raw [implementation.build](http://implementation.build) reviewer output through validateStepResult using REVIEWER_RESULT_SCHEMA_ID and maps unrecoverable failures to reviewer_result_invalid.
`validateReviewerResult`, `ValidateReviewerResultInput`, `ReviewerResultValidationOutcome`, `ReviewerResultValidationSuccess`, `ReviewerResultValidationFailure`

`packages/core/src/convergence-engine.ts`
Replace direct reviewerResultSchema.safeParse calls with the shared reviewer-result tolerance helper while preserving dispatch-failure, needs_input, missing-result, checkpoint, and role-distinct warning behavior.
`createConvergenceEngine`, `ConvergenceEngineOptions`

`packages/core/src/layered-convergence-engine.ts`
Apply the same reviewer-result tolerance helper at layered convergence reviewer-consumption points, including the build altitude path.
`createLayeredConvergenceEngine`, `LayeredConvergenceEngineOptions`

`packages/core/src/index.ts`
Expose the shared reviewer-result validation helper and its types from the core package if the project keeps convergence helpers on the package public surface.
`validateReviewerResult`, `ValidateReviewerResultInput`, `ReviewerResultValidationOutcome`, `ReviewerResultValidationSuccess`, `ReviewerResultValidationFailure`

`apps/control-plane/src/implementation-build-convergence.smoke.spec.ts`
Update the existing control-plane smoke test to drive real [implementation.build](http://implementation.build) convergence dispatch through the tolerance path with a near-miss reviewer result such as \{\} and assert the run proceeds past the implementation gate.

### Public API

#### `reviewerResultNormalizer`

```typescript
export const reviewerResultNormalizer: ResultNormalizer
```
- Returns: `ResultNormalizer`
#### `defaultResultNormalizers`

```typescript
export const defaultResultNormalizers: readonly ResultNormalizer[]
```
- Returns: `readonly ResultNormalizer[]`
#### `validateReviewerResult`

```typescript
export function validateReviewerResult(input: ValidateReviewerResultInput): Promise
```
- Parameters:
	- `input: ValidateReviewerResultInput` — Reviewer-result validation request containing run metadata, the raw reviewer candidate, and optional tolerance/correction seams. Undefined candidates are intentionally not accepted; callers keep reviewer_result_missing handling.
- Returns: `Promise`
#### `createConvergenceEngine`

```typescript
export function createConvergenceEngine(options: ConvergenceEngineOptions): ConvergenceEngine
```
- Parameters:
	- `options: ConvergenceEngineOptions` — Build-only convergence engine dependencies. The options type gains optional reviewer result tolerance seams for bounded correction and test control.
- Returns: `ConvergenceEngine`
- Errors:
	- `ConvergenceEngineConfigurationError when required convergence roles are missing or the step is unsupported.`
#### `createLayeredConvergenceEngine`

```typescript
export function createLayeredConvergenceEngine(options: LayeredConvergenceEngineOptions): ConvergenceEngine
```
- Parameters:
	- `options: LayeredConvergenceEngineOptions` — Layered convergence engine dependencies. The options type gains the same optional reviewer result tolerance seams as the build-only engine.
- Returns: `ConvergenceEngine`
- Errors:
	- `ConvergenceEngineConfigurationError when required convergence roles are missing or the step is unsupported.`
### Types

#### `ValidateReviewerResultInput`

```typescript
interface ValidateReviewerResultInput { readonly runId: string; readonly step: string; readonly rawResult: unknown; readonly correctionRequester?: ResultCorrectionRequester; readonly maxCorrectionAttempts?: number; readonly normalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[]; }
```
#### `ReviewerResultValidationOutcome`

```typescript
type ReviewerResultValidationOutcome = ReviewerResultValidationSuccess | ReviewerResultValidationFailure;
```
#### `ReviewerResultValidationSuccess`

```typescript
interface ReviewerResultValidationSuccess { readonly status: "valid"; readonly value: ReviewerResult; readonly events: readonly ResultToleranceEvent[]; readonly normalized: boolean; readonly correctedAttempts: number; }
```
#### `ReviewerResultValidationFailure`

```typescript
interface ReviewerResultValidationFailure { readonly status: "failed"; readonly reason: "reviewer_result_invalid"; readonly events: readonly ResultToleranceEvent[]; }
```
#### `ConvergenceEngineOptions`

```typescript
interface ConvergenceEngineOptions { readonly dispatcher: ReviewedRoleDispatcher; readonly git: RunWorkspaceGitPort; readonly feedback: FeedbackRepository; readonly runSteps: RunStepRepository; readonly routing: ModelRoutingResolver; readonly getPolicy?: (workflow: RunWorkflowDefinition, step: RunStepId) => ResolvedStepConvergencePolicy; readonly logger?: { warn(message: string, details?: unknown): void }; readonly clock?: () => string; readonly idGenerator?: () => string; readonly reviewerPrincipal?: Principal; readonly feedbackLifecycle?: FeedbackLifecycleDependencies; readonly reviewerResultCorrectionRequester?: ResultCorrectionRequester; readonly reviewerResultMaxCorrectionAttempts?: number; readonly reviewerResultNormalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[]; }
```
#### `LayeredConvergenceEngineOptions`

```typescript
interface LayeredConvergenceEngineOptions { readonly dispatcher: ReviewedRoleDispatcher; readonly git: RunWorkspaceGitPort; readonly feedback: FeedbackRepository; readonly runSteps: RunStepRepository; readonly routing: ModelRoutingResolver; readonly getPolicy?: (workflow: RunWorkflowDefinition, step: RunStepId) => ResolvedStepConvergencePolicy; readonly logger?: { warn(message: string, details?: unknown): void }; readonly clock?: () => string; readonly idGenerator?: () => string; readonly reviewerPrincipal?: Principal; readonly workspaceContextRefresher?: (runId: string) => Promise; readonly reviewerResultCorrectionRequester?: ResultCorrectionRequester; readonly reviewerResultMaxCorrectionAttempts?: number; readonly reviewerResultNormalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[]; }
```
### Notes

No api-contract schema shape change is proposed: reviewerResultSchema remains the strict discriminated union on status. The new normalizer is exported as the named const reviewerResultNormalizer, not a zero-argument factory, and defaultResultNormalizers includes that const directly. The normalizer is deliberately narrow and schema-specific for REVIEWER_RESULT_SCHEMA_ID/autocatalyst.reviewer_result.v1: exactly \{\} and exactly \{ findings: \[\] \} normalize to \{ status: "satisfied", findings: \[\] \}; non-empty findings without status, malformed findings, unknown statuses, non-plain objects, and partially valid finding objects are left for schema validation and bounded correction. validateReviewerResult exposes only the spec-mandated failure shape \{ status: "failed", reason: "reviewer_result_invalid", events \}; any internal schema-validation or correction-exhaustion distinctions must stay private or appear only as safe ResultToleranceEvent data. The repository's control-plane smoke suite lives under apps/control-plane, so apps/control-plane/src/implementation-build-convergence.smoke.spec.ts will be updated for the required end-to-end coverage using real convergence dispatch and the tolerance path rather than an injected final verdict. Production provider-backed correction depends on a configured ResultCorrectionRequester; without one, normalization still occurs and invalid reviewer output fails safely as reviewer_result_invalid.
## Task list

### Story 1: Add deterministic reviewer-result normalization

#### Task 1.1: Implement the reviewer-result normalizer

**Description:** Add `reviewerResultNormalizer` in `packages/execution/src/result-normalizers.ts` and register it in `defaultResultNormalizers` for `REVIEWER_RESULT_SCHEMA_ID` / `autocatalyst.reviewer_result.v1`.
**Acceptance criteria:**
- `reviewerResultNormalizer` is exported as a named `ResultNormalizer` const.
- `defaultResultNormalizers` includes `reviewerResultNormalizer`.
- Exactly `{}` normalizes to `{ status: "satisfied", findings: [] }`.
- Exactly `{ findings: [] }` normalizes to `{ status: "satisfied", findings: [] }`.
- The normalizer leaves already-statused reviewer results unchanged for schema validation.
- The normalizer leaves non-empty findings without `status`, malformed findings, unknown statuses, arrays, `null`, and non-object candidates unchanged.
- The normalizer applies only to the reviewer-result schema id and does not affect unrelated step contracts.
**Dependencies:** None.
#### Task 1.2: Export the normalizer from the execution package

**Description:** Update `packages/execution/src/index.ts` so downstream packages can import `reviewerResultNormalizer` through the execution package public surface.
**Acceptance criteria:**
- `reviewerResultNormalizer` is re-exported from `packages/execution/src/index.ts`.
- Existing result-tolerance and result-normalizer exports remain source-compatible.
- TypeScript consumers can import the const from the execution package without deep imports.
**Dependencies:** Task 1.1.
#### Task 1.3: Cover reviewer normalizer behavior with execution tests

**Description:** Add or update tests in `packages/execution/src/result-normalizers.spec.ts` and, where useful, `packages/execution/src/result-tolerance.spec.ts` to prove the reviewer normalizer participates in the existing tolerance pipeline.
**Acceptance criteria:**
- Tests prove `{}` normalizes to a satisfied reviewer result.
- Tests prove `{ findings: [] }` normalizes to a satisfied reviewer result.
- Tests prove ambiguous non-empty findings without `status` are not normalized.
- Tests prove malformed findings, unknown statuses, and non-object values are not normalized.
- Tests prove the normalizer is schema-specific and does not repair unrelated contracts.
- Tolerance tests prove normalized reviewer output validates through `validateStepResult`.
**Dependencies:** Task 1.1.
### Story 2: Add the shared core reviewer-result validation helper

#### Task 2.1: Implement `validateReviewerResult`

**Description:** Add `packages/core/src/reviewer-result-validation.ts` with the converged helper and types. The helper should call `validateStepResult` with `reviewerResultSchema`, `REVIEWER_RESULT_SCHEMA_ID`, the raw reviewer candidate, configured normalizers, and optional correction settings.
**Acceptance criteria:**
- The file exports `validateReviewerResult`, `ValidateReviewerResultInput`, `ReviewerResultValidationOutcome`, `ReviewerResultValidationSuccess`, and `ReviewerResultValidationFailure`.
- The helper accepts only defined `rawResult` values; callers remain responsible for `reviewer_result_missing`.
- Successful validation returns `{ status: "valid", value, events, normalized, correctedAttempts }`.
- Unrecoverable validation returns `{ status: "failed", reason: "reviewer_result_invalid", events }`.
- Internal validation and correction failure details do not leak raw model output, provider diagnostics, secrets, or host paths.
- The helper supports optional `correctionRequester`, `maxCorrectionAttempts`, and `normalizers` inputs as defined in the Converged API.
- The helper uses the reviewer-result schema id `REVIEWER_RESULT_SCHEMA_ID`.
**Dependencies:** Tasks 1.1 and 1.2.
#### Task 2.2: Export the helper from the core package if public helpers are exported there

**Description:** Update `packages/core/src/index.ts` to expose the reviewer-result validation helper and its types when that matches the package’s existing public-surface pattern.
**Acceptance criteria:**
- `validateReviewerResult` and its types are exported from `packages/core/src/index.ts` if comparable convergence helpers are exported there.
- If the project keeps this helper internal, the decision is documented in code comments or the task implementation notes and no Converged API type names are renamed.
- Existing core exports remain source-compatible.
**Dependencies:** Task 2.1.
#### Task 2.3: Cover helper outcomes with focused core tests

**Description:** Add focused tests for the helper, either in a new `reviewer-result-validation.spec.ts` or in the closest existing core convergence test file.
**Acceptance criteria:**
- Tests cover already-valid reviewer results.
- Tests cover `{}` and `{ findings: [] }` normalized to valid satisfied results.
- Tests cover correction success for an initially invalid reviewer result.
- Tests cover correction exhaustion or missing correction support mapping to `reviewer_result_invalid`.
- Tests assert `events`, `normalized`, and `correctedAttempts` are populated consistently with the tolerance pipeline.
- Tests assert failure output uses only the public-safe `reviewer_result_invalid` reason.
**Dependencies:** Task 2.1.
### Story 3: Route build-only convergence through reviewer-result tolerance

#### Task 3.1: Replace direct reviewer schema parsing in `convergence-engine.ts`

**Description:** Update `packages/core/src/convergence-engine.ts` so implementation-build reviewer results are validated through `validateReviewerResult` instead of direct `reviewerResultSchema.safeParse(...)`.
**Acceptance criteria:**
- Direct `reviewerResultSchema.safeParse(rawResult)` validation is removed from the reviewer-result consumption path.
- Reviewer dispatch failures still return before reviewer-result tolerance handling.
- Reviewer `needs_input` results still return before reviewer-result tolerance handling.
- Truly absent reviewer results still return `reviewer_result_missing` without calling the tolerance helper.
- Invalid reviewer results fail with `reviewer_result_invalid` only after normalization and configured correction are exhausted or correction is unavailable.
- Findings are derived from the typed `ReviewerResult` returned by the helper.
- Existing checkpoint construction and safe failure-reason behavior are preserved.
**Dependencies:** Task 2.1.
#### Task 3.2: Add build-only convergence options for reviewer tolerance seams

**Description:** Extend `ConvergenceEngineOptions` in `packages/core/src/convergence-engine.ts` with optional `reviewerResultCorrectionRequester`, `reviewerResultMaxCorrectionAttempts`, and `reviewerResultNormalizers`.
**Acceptance criteria:**
- The options match the Converged API names and types.
- Default behavior uses the execution package default normalizers.
- Tests can inject scripted correction behavior without provider calls.
- Production behavior fails safely as `reviewer_result_invalid` when no correction requester is configured and normalization cannot repair the value.
- Existing engine construction sites continue to compile without passing the new options.
**Dependencies:** Task 3.1.
#### Task 3.3: Cover build-only convergence behavior

**Description:** Update `packages/core/src/convergence-engine.spec.ts` to prove the build-only engine uses the tolerance helper and preserves existing precedence rules.
**Acceptance criteria:**
- Tests prove `{}` reviewer output converges as a satisfied clean review.
- Tests prove `{ findings: [] }` reviewer output converges as a satisfied clean review.
- Tests prove ambiguous or malformed reviewer output routes to correction when a requester is configured.
- Tests prove corrected reviewer output lets the convergence round continue.
- Tests prove correction exhaustion fails with `reviewer_result_invalid`.
- Tests preserve `reviewer_result_missing`, reviewer dispatch failure, and reviewer `needs_input` behavior.
- Tests prove `warningCode: "role_distinct_unsatisfied"` remains recorded and non-fatal for same-model implementer/reviewer routing.
**Dependencies:** Tasks 3.1 and 3.2.
### Story 4: Route layered convergence through reviewer-result tolerance

#### Task 4.1: Replace direct reviewer schema parsing in `layered-convergence-engine.ts`

**Description:** Update `packages/core/src/layered-convergence-engine.ts` so every reviewer-result consumption point, including the build altitude path, uses `validateReviewerResult`.
**Acceptance criteria:**
- Direct `reviewerResultSchema.safeParse(rawResult)` validation is removed from layered reviewer-result consumption paths.
- Reviewer dispatch failures still return before reviewer-result tolerance handling.
- Reviewer `needs_input` results still return before reviewer-result tolerance handling.
- Missing reviewer results still return `reviewer_result_missing` without calling the tolerance helper.
- Invalid reviewer results fail with `reviewer_result_invalid` only after normalization and configured correction are exhausted or correction is unavailable.
- Findings and convergence decisions use the typed `ReviewerResult` returned by the helper.
- The same behavior applies at every layered altitude where reviewer output is consumed.
**Dependencies:** Task 2.1.
#### Task 4.2: Add layered convergence options for reviewer tolerance seams

**Description:** Extend `LayeredConvergenceEngineOptions` in `packages/core/src/layered-convergence-engine.ts` with optional `reviewerResultCorrectionRequester`, `reviewerResultMaxCorrectionAttempts`, and `reviewerResultNormalizers`.
**Acceptance criteria:**
- The options match the Converged API names and types.
- Default behavior uses the execution package default normalizers.
- Tests can inject scripted correction behavior without provider calls.
- Production behavior fails safely as `reviewer_result_invalid` when no correction requester is configured and normalization cannot repair the value.
- Existing layered engine construction sites continue to compile without passing the new options.
**Dependencies:** Task 4.1.
#### Task 4.3: Cover layered convergence behavior

**Description:** Update `packages/core/src/layered-convergence-engine.spec.ts` to prove layered convergence uses the tolerance helper and preserves existing precedence rules.
**Acceptance criteria:**
- Tests prove `{}` reviewer output converges as a satisfied clean review at the build altitude.
- Tests prove `{ findings: [] }` reviewer output converges as a satisfied clean review at the build altitude.
- Tests prove ambiguous or malformed reviewer output routes to correction when a requester is configured.
- Tests prove corrected reviewer output lets the layered convergence round continue.
- Tests prove correction exhaustion fails with `reviewer_result_invalid`.
- Tests preserve `reviewer_result_missing`, reviewer dispatch failure, and reviewer `needs_input` behavior.
- Tests prove `warningCode: "role_distinct_unsatisfied"` remains recorded and non-fatal for same-model implementer/reviewer routing.
**Dependencies:** Tasks 4.1 and 4.2.
### Story 5: Prove the production convergence path

#### Task 5.1: Update the control-plane smoke test for real reviewer tolerance

**Description:** Update `apps/control-plane/src/implementation-build-convergence.smoke.spec.ts` so a real feature run drives `implementation.build` reviewer dispatch through the convergence engine and tolerance path with a near-miss reviewer result such as `{}`.
**Acceptance criteria:**
- The test uses the real convergence dispatch and tolerance path, not an injected final verdict.
- The reviewer session returns a near-miss result such as `{}` or `{ findings: [] }`.
- The run proceeds past the implementation gate after normalization or correction.
- The test observes the run state or step records that prove the implementation gate was satisfied.
- The test remains deterministic and does not require live provider calls.
- Existing smoke coverage for implementation-build convergence remains intact.
**Dependencies:** Stories 1, 2, 3, and 4.
#### Task 5.2: Verify targeted test commands

**Description:** Run the targeted validation commands named in the tech spec and fix any regressions they expose.
**Acceptance criteria:**
- `pnpm nx test execution -- result-normalizers.spec.ts` passes.
- `pnpm nx test execution -- result-tolerance.spec.ts` passes.
- `pnpm nx test core -- convergence-engine.spec.ts` passes.
- `pnpm nx test core -- layered-convergence-engine.spec.ts` passes.
- `pnpm nx test control-plane -- implementation-build-convergence.smoke.spec.ts` passes.
- Any skipped command is documented with the exact reason it could not run.
**Dependencies:** Tasks 1.3, 2.3, 3.3, 4.3, and 5.1.
### Story 6: Preserve integration contracts and handoff notes

#### Task 6.1: Confirm no prompt or API-contract schema changes are needed

**Description:** Review `packages/core/src/implementation-build-context.ts` and the reviewer result schema in `packages/api-contract/src/convergence.ts` during implementation to ensure this slice does not change the prompt or valid reviewer result contract.
**Acceptance criteria:**
- `implementation-build-context.ts` is unchanged unless a test fixture requires a non-contractual adjustment.
- `reviewerResultSchema` remains a strict discriminated union on `status`.
- No new accepted reviewer-result shape is added to `packages/api-contract`.
- Near-miss handling lives in normalization before schema validation, not in the schema itself.
**Dependencies:** Stories 1 and 2.
#### Task 6.2: Document unsupported production correction behavior in implementation notes if the provider seam is absent

**Description:** If core cannot issue provider-backed reviewer correction requests in production, record that limitation in implementation notes while keeping the injectable correction seam and test coverage.
**Acceptance criteria:**
- The implementation does not claim production provider-backed correction works unless a real `ResultCorrectionRequester` is connected.
- Without a correction requester, unnormalized invalid reviewer output fails safely as `reviewer_result_invalid`.
- Tests still cover correction through the injectable requester.
- The final handoff explicitly mentions any unsupported provider-backed correction behavior.
**Dependencies:** Stories 2, 3, and 4.