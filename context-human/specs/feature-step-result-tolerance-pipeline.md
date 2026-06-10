---
created: 2026-06-09
last_updated: 2026-06-10
status: complete
issue: 22
specced_by: markdstafford
---
# Feature: Step result tolerance pipeline

## Product requirements

### What

Add a reusable tolerance pipeline that validates each runner step result before any downstream logic consumes it. A step declares its expected result as a Zod schema from `@autocatalyst/api-contract`. The runner reads the step's structured result from the scratch root, normalizes safe deviations, validates the result, asks the agent to correct nonconforming output within a bounded loop, and either returns a typed validated value across the `Runner` boundary or fails the run with a sanitized reason.
The pipeline implements the ADR-012 order:
1. deterministic normalization;
2. schema validation;
3. bounded correction loop;
4. graceful degradation for missing optional signals.
The hard rule is unchanged: a coercion is applied only when it is deterministic and unambiguous. Ambiguous input must not be guessed. It falls through to the correction loop.
### Why

The runner boundary from issue 21 can dispatch a run, materialize a workspace, stream typed runner events, and return a terminal directive. It does not yet verify that the step result the agent produced matches the contract the next step expects.
Autocatalyst's run lifecycle depends on trusted step handoffs. A malformed result can otherwise move from execution into orchestration and fail later in a less clear place. This feature makes result validation a boundary rule: execution reads the scratch-root result, repairs only known safe deviations, validates against the declared schema, asks the agent to fix recoverable violations, and refuses to silently pass bad output downstream.
### Goals

- Add a reusable tolerance pipeline utility that runs deterministic normalization, schema validation, bounded correction, and optional-signal degradation in that order.
- Add an extensible normalizer registry where each normalizer declares the unambiguous pattern it handles.
- Enforce the ADR-012 hard rule: deterministic repairs only; ambiguous input is never coerced by guesswork.
- Let each executable step declare its expected result schema through the shared `@autocatalyst/api-contract` Zod toolchain.
- Read structured result files from the materialized scratch root on the execution side of the boundary.
- Return only validated typed results across the `Runner` boundary.
- Return fixable violations to the agent through the stub runner in a bounded correction loop.
- Make the maximum correction attempts configurable.
- Fail terminally when the correction loop is exhausted.
- Degrade gracefully when optional result signals are missing, while still rejecting missing required fields.
- Prove deterministic repair, ambiguous-input handling, bounded correction exhaustion, optional-signal degradation, and boundary integration with tests.
- Update `context-agent/wiki/code-map.md` during implementation to record the tolerance pipeline, normalizer registry, per-step result schemas, and correction-loop seams.
### Non-goals

- Persisting runner events, re-streaming them over SSE, or recording validated results onto `RunStep`.
- Adding durable step checkpoints or recovery/resume behavior beyond the existing checkpoint event vocabulary.
- Implementing structured progress tools such as `update_plan`, `report_progress`, or `notify`.
- Adding real Claude, OpenAI, direct-provider, gateway, or model-routing adapters.
- Implementing provider-specific result repair behavior.
- Building a human-facing UI for validation failures.
- Opening pull requests, pushing branches, merging, or publishing remote git changes.
### Personas

- **Enzo (Engineer)** needs one reusable result-validation path so future steps and providers do not each invent their own parsing and correction behavior.
- **Opal (Operator)** needs malformed step output to fail clearly and safely before it changes downstream run state.
- **Phoebe (PM)** needs confidence that Autocatalyst can tolerate common model-output mistakes without silently corrupting a run.
- **Dani (Designer)** is not a direct user of this backend feature, but future progress and failure displays depend on clear typed validation outcomes.
### User stories

- As Enzo, I can declare a step result schema once in `@autocatalyst/api-contract` and have the runner validate that result before returning it to the control plane.
- As Enzo, I can register a deterministic normalizer without changing the core pipeline.
- As Enzo, I can see ambiguous deviations rejected from deterministic repair and routed to correction instead.
- As Opal, I can configure how many correction attempts a run may make before failing.
- As Opal, I can trust that exhausted corrections produce a terminal failure rather than a malformed successful result.
- As Phoebe, I can see tests proving a known filename alias or URL-wrapped identifier is repaired without a model round-trip.
- As a future runner adapter author, I can implement provider-specific correction by satisfying a small correction interface rather than rewriting validation.
### Acceptance criteria

#### Tolerance pipeline

- A reusable pipeline function accepts raw result data, a declared Zod schema, registered normalizers, correction options, and optional-signal degradation policy.
- The pipeline runs deterministic normalization before schema validation.
- The pipeline validates normalized output against the declared schema.
- The pipeline invokes a bounded correction loop only after normalization plus validation still fail.
- The pipeline applies graceful degradation only for configured optional signals.
- The pipeline returns a typed validated value on success.
- The pipeline returns or throws a typed failure with sanitized details when validation cannot be repaired.
- The pipeline exposes enough structured metadata for tests and future telemetry to tell whether the result was accepted directly, normalized, corrected, degraded, or failed.
#### Normalizer registry

- The normalizer registry accepts normalizers as independent entries rather than hardcoding every repair in the pipeline.
- Each normalizer declares a stable id, the field or pattern it handles, and the condition that makes the repair deterministic and unambiguous.
- A known filename alias can be mapped to a canonical value without invoking correction.
- An identifier wrapped in a URL can be extracted without invoking correction when the URL shape is unambiguous.
- An ambiguous input is not coerced by any normalizer.
- Tests prove that a new normalizer can be registered without changing pipeline control flow.
#### Step result schemas

- Step result schemas live in `packages/api-contract` and are exported from the package entry point.
- Initial schemas cover the current runner terminal handoff shape needed by the stub runner integration.
- Each executable step selects a contract by a stable `(step, schemaId)` pair. Contract declarations include the Zod schema, optional degradation policy, and the default scratch result filename for that contract.
- Execution resolves the active contract through an explicit contract registry or resolver for the current run/step before reading a result file. Missing, unknown, or duplicate contract registrations fail deterministically with sanitized contract-resolution failures; execution must not silently fall back to a generic handoff schema.
- The schema declarations reuse existing Zod conventions and inferred TypeScript types.
- Missing required fields fail validation.
- Missing optional signals degrade only when the schema or pipeline policy marks them optional.
#### Scratch-root result handling

- Execution-side code resolves the result file path only inside the materialized scratch root.
- Reading a result outside `scratchRoot` itself is rejected, even if the resolved path would remain inside another materialized workspace root such as `repoRoot`.
- Malformed JSON, missing result files, or unreadable result files produce typed validation failures with sanitized details.
- The control plane never reads the execution plane's filesystem to validate the result.
#### Correction loop

- A correction interface returns a candidate replacement result for a validation violation.
- The stub runner supports deterministic correction scenarios for tests without calling a model provider.
- The correction loop maximum attempts is configurable and defaults to a safe finite value.
- The loop makes exactly the configured number of correction attempts before failing.
- Each correction attempt re-runs deterministic normalization and schema validation before another attempt is requested.
- Exhausting correction attempts returns a terminal failure for the run rather than passing malformed output downstream.
#### Boundary integration

- The execution entry point validates the step result through the pipeline before the core unit-of-work adapter maps the runner outcome to `RunWorkResult`.
- A successful execution returns the validated typed result across the boundary along with the directive needed by orchestration.
- The core adapter and orchestrator do not consume raw scratch-root result data.
- The execution entry point validates the raw runner stream before converting it to boundary events: raw events still must match `runnerEventSchema`, use the expected run id, contain exactly one terminal event, and contain no post-terminal events.
- After validation and terminal buffering, the stream shape changes to `ExecutionBoundaryEvent`; core validates that shape instead of applying the strict raw `runnerEventSchema` to the enriched terminal handoff.
- An integration test dispatches the stub runner through the execution boundary and asserts the validated result is handed back to orchestration.
#### Tests

- Unit tests cover a deterministic repair that passes with no correction round-trip.
- Unit tests cover an ambiguous input that is not coerced and enters the correction loop.
- Unit tests cover malformed output that drives exactly the configured number of correction attempts and then fails.
- Unit tests cover missing optional signal degradation without failing the run.
- Unit tests cover missing required field failure.
- Unit tests cover contract selection, missing/unknown contract failures, and duplicate contract registration.
- Unit tests cover scratch-root containment for result-file reads, including traversal into a sibling materialized root.
- Unit tests cover throwing normalizers returning sanitized `normalizer_failed`.
- Boundary tests cover duplicate terminal events, post-terminal events, wrong run id, and terminal handoff schema validation in the `ExecutionBoundaryEvent` stream.
- Contract tests cover exported step result schemas.
- Integration tests cover stub-runner dispatch through the boundary with result validation.
## Design spec

### Design scope

This is a backend execution-runtime feature. There is no visual UI, desktop screen, or human-facing copy in this pass.
The design work is the developer and operator experience around result contracts: where schemas live, how deterministic repair is extended, how correction requests are modeled, and how failures are reported without leaking sensitive paths or raw model output.
### Developer experience

A step author should add or select one result schema and pass it to the runner result-validation path. They should not write ad hoc JSON parsing, hand-maintained TypeScript-only types, or one-off correction loops.
A normalizer author should implement one focused repair:
1. declare an id and description;
2. inspect a candidate result;
3. return either no change, one unambiguous repair, or an explicit ambiguous/no-match outcome;
4. never guess.
A runner adapter author should implement a correction interface. For the stub runner, that interface can return scripted candidates for tests. Future provider adapters can translate a typed violation into a model prompt, but the pipeline should not know provider details.
### Operator experience

Operational behavior should be predictable:
- Known safe deviations are fixed locally, which saves time and model cost.
- Ambiguous deviations are not guessed, which protects downstream run state.
- Nonconforming output gets a bounded number of correction attempts.
- Exhausted correction fails the run with a clear sanitized reason.
- Missing optional signals reduce richness but do not stop the run.
Validation outcomes should be easy to inspect in tests now and future telemetry later. The pipeline result should distinguish `accepted`, `normalized`, `corrected`, `degraded`, and `failed` outcomes without exposing secrets or full scratch paths.
### Result flow

The happy path is:
1. The runner finishes a step and writes structured result JSON into the scratch root.
2. The execution entry point resolves the declared result schema for the current step.
3. Execution reads the result file through a scratch-root-contained helper.
4. The tolerance pipeline applies registered deterministic normalizers.
5. The normalized result validates against the step schema.
6. The validated typed result is attached to the terminal handoff value.
7. The core unit-of-work adapter receives a boundary result that is already validated.
8. The orchestrator receives only the directive and validated typed data it is allowed to consume.
The recoverable path is:
1. Initial normalization and validation fail.
2. The pipeline builds a typed fixable violation that includes schema issues and normalized candidate metadata.
3. The correction interface asks the agent for a replacement result.
4. The replacement result re-enters the pipeline at deterministic normalization.
5. The loop stops on the first validated result or after the configured maximum attempts.
The terminal failure path is:
1. The result cannot be read, parsed, repaired, validated, or corrected within the attempt limit.
2. Execution returns a failure directive with a sanitized reason.
3. Malformed output does not cross the boundary as if it were valid.
### Normalization design

Normalizers should be small and composable. The registry owns order and applies entries one at a time to a candidate result. A normalizer can report:
- `unchanged` when it does not apply;
- `changed` with a repaired candidate and metadata when it applies safely;
- `ambiguous` when the input resembles a supported repair but is not uniquely repairable.
`ambiguous` is not an error by itself. It blocks deterministic coercion and lets the candidate continue to validation and correction. This preserves the ADR-012 hard rule while still giving future telemetry a way to show why a known-looking value was not repaired.
### Correction design

The correction interface should be provider-neutral:
```typescript
interface ResultCorrectionRequester {
  requestCorrection(input: ResultCorrectionRequest): Promise;
}
```
The request should include the current step, schema identifier, validation issues, safe excerpts of the candidate result, and the attempt number. It must not include secrets, ambient environment values, or absolute host paths.
The stub runner can implement correction with scripted responses:
- no correction response for direct failure tests;
- one valid corrected response for recovery tests;
- repeated malformed responses for attempt-exhaustion tests.
Future agent adapters can translate the same typed request into model-specific instructions.
### Degradation design

Graceful degradation is allowed only for optional signals or optional fields that are explicitly safe to omit. The pipeline should not use degradation to invent required result data.
For this feature, degradation policy may be configured beside the schema or passed into the pipeline call. Either way, the code must make the optional behavior explicit enough for tests to prove a missing optional signal proceeds while a missing required field fails.
Optional paths are exact arrays of string object keys and number array indexes. Degradation is recorded only for missing or `undefined` values after successful schema parsing; `null` is a present value and must be accepted or rejected by the schema. Degradation updates only metadata (`degraded`, `degradedPaths`, and tolerance events) and does not mutate the returned typed value.
### Error and observability design

Validation failures should use typed error codes rather than message parsing. Suggested codes:
- `result_file_missing`
- `result_file_unreadable`
- `result_json_invalid`
- `schema_validation_failed`
- `correction_attempts_exhausted`
- `correction_request_failed`
- `normalizer_failed`
- `result_contract_missing`
- `result_contract_unknown`
- `result_path_outside_scratch_root`
`ambiguous_normalization` is an event code, not a terminal failure code.
Error messages returned to orchestration should be sanitized. They may include stable codes and high-level step/schema identifiers. They should not include secret values, full raw model output, or sensitive host filesystem paths.
## Tech spec

### Current state

- `packages/api-contract/src/runner-events.ts` defines typed runner events and terminal directives.
- `packages/api-contract/src/execution-context.ts` defines the serializable `ExecutionContext`.
- `packages/execution/src/runner.ts` defines the public `Runner` interface.
- `packages/execution/src/stub-runner.ts` emits deterministic progress, assistant-turn, checkpoint, and terminal-result events.
- `packages/execution/src/execution-entry-point.ts` materializes an execution environment and streams runner events.
- `packages/core/src/runner-event-stream.ts` validates event protocol shape and terminal-event ordering.
- `packages/core/src/execution-run-unit-of-work.ts` maps validated terminal events to `RunWorkResult`.
- `packages/execution/src/internal/workspace-root-guard.ts` already rejects paths outside materialized workspace roots with sanitized errors, but result-file reads need a stricter scratch-root-specific containment check so traversal into a sibling materialized root is still rejected.
The missing piece is a result-contract layer between scratch-root output and the terminal handoff consumed by core.
### Proposed modules

Add execution-owned pipeline modules:
- `packages/execution/src/result-tolerance.ts` — public or package-level pipeline types and `validateStepResult`.
- `packages/execution/src/result-contracts.ts` — execution-owned step/schema-id contract registry and resolver.
- `packages/execution/src/result-normalizers.ts` — `ResultNormalizer`, `ResultNormalizerRegistry`, default normalizers, and test helpers.
- `packages/execution/src/result-correction.ts` — correction requester interfaces, request/response types, and attempt-loop helpers.
- `packages/execution/src/result-file.ts` — scratch-root-contained result-file reader and JSON parser.
- `packages/execution/src/execution-boundary-events.ts` — post-validation boundary event schema and stream validator.
Add contract-owned schemas:
- `packages/api-contract/src/step-results.ts` — initial step result schemas, schema ids, inferred result types, and exports.
- `packages/api-contract/src/index.ts` — export the new result schemas and types.
Update existing execution/core seams:
- `packages/execution/src/stub-runner.ts` — add optional scripted result writer/correction behavior for tests.
- `packages/execution/src/execution-entry-point.ts` — run the result pipeline before yielding or finalizing the terminal handoff.
- `packages/core/src/execution-run-unit-of-work.ts` — accept the validated terminal result shape without reading raw scratch data.
- `context-agent/wiki/code-map.md` — record the new pipeline, registry, schemas, and result-file behavior during implementation.
Exact filenames may change if implementation finds a cleaner package-private split, but the public ownership should remain: schemas in `api-contract`, result-file and tolerance execution in `execution`, orchestration state mutation in `core`.
### Data shapes

Representative pipeline result:
```typescript
type StepResultValidationOutcome =
  | {
      status: 'valid';
      value: unknown;
      schemaId: string;
      normalized: boolean;
      correctedAttempts: number;
      degraded: boolean;
      events: ResultToleranceEvent[];
    }
  | {
      status: 'failed';
      code: StepResultValidationFailureCode;
      schemaId: string;
      attempts: number;
      safeMessage: string;
      issues: ResultValidationIssue[];
      events: ResultToleranceEvent[];
    };
```
Representative normalizer:
```typescript
interface ResultNormalizer {
  readonly id: string;
  readonly description: string;
  normalize(input: ResultNormalizerInput): ResultNormalizerOutcome;
}
```
Representative correction request:
```typescript
interface ResultCorrectionRequest {
  readonly runId: string;
  readonly step: string;
  readonly schemaId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly issues: readonly ResultValidationIssue[];
  readonly safeCandidatePreview: unknown;
}
```
### Schema ownership

`packages/api-contract/src/step-results.ts` should start small and explicit. The first result schema should cover the current terminal handoff needed by the runner-boundary integration: a directive plus optional validated result payload. Follow ADR-007: Zod is the source of truth and TypeScript types are inferred.
Step-specific schemas are selected through a contract declaration and registry. A declaration is keyed by both executable step and schema id so a run can choose a precise contract instead of sharing one factory-level generic handoff schema:
```typescript
const stepResultContractSchema = z.object({
  step: z.string().min(1),
  schemaId: z.string().min(1)
}).strict();
```
The implementation should expose a `StepResultContractDefinition` shape that pairs the contract key with the Zod schema, optional default `resultFile`, and optional degradation policy. A `StepResultContractRegistry` or `StepResultContractResolver` must resolve the contract for the current run/step before result-file reading. Unknown step ids, unknown schema ids, and duplicate `(step, schemaId)` registrations are deterministic failures with sanitized messages. They must not fall back to `runnerTerminalHandoffResultSchema`.
The registry may live in execution or core as long as it references contract schemas and does not duplicate shapes. The execution entry point can accept either a concrete per-run/per-step validation config or a resolver callback that returns one for the current `ExecutionEntryPointInput`.
### Result-file handling

The execution plane should read result JSON from a configured filename beneath `scratchRoot`. The helper must:
- require a materialized workspace with a scratch root;
- resolve the candidate result path against the scratch root;
- assert that the final real/resolved path is contained by `scratchRoot` itself before reading;
- reject paths such as `../repo/result.json` that leave `scratchRoot`, even when the target is inside another materialized workspace root;
- parse JSON into `unknown`;
- return typed failures for missing, unreadable, or invalid files;
- avoid returning absolute paths in user-visible failure reasons.
For `workspace.shape === 'none'`, the result reader should fail with a typed result-file error unless a caller supplies an in-memory candidate for tests or direct-model steps.
### Pipeline algorithm

`validateStepResult` should follow this loop:
1. read or receive the raw candidate;
2. apply every deterministic normalizer in registry order;
3. validate the candidate with `schema.safeParse`;
4. if validation succeeds, apply optional-signal degradation metadata and return typed value;
5. if validation fails and attempts remain, build a correction request and ask the correction requester for a replacement candidate;
6. repeat normalization and validation for the replacement candidate;
7. if attempts are exhausted, return a typed failure.
The correction attempt count must count requests to the agent, not the initial validation pass. A configured `maxAttempts: 2` means the pipeline can ask for two replacements after the original candidate fails.
Normalizer exceptions are not implementation-defined. If a normalizer throws or rejects, the registry records one sanitized `normalizer_failed` event with the normalizer id and a generic message, stops the current normalization pass, and `validateStepResult` returns `status: 'failed'` with code `normalizer_failed`. The thrown error message, stack, candidate, and host paths must not be exposed.
### Optional-signal degradation semantics

Degradation is metadata-only. It never mutates, deletes, or invents fields on the typed value returned by successful schema validation. `StepResultValidationSuccess.value` is the Zod-parsed value, and degradation is reported through `degraded: true`, `degradedPaths`, and `ResultToleranceEvent` entries.
`ResultDegradationPolicy.optionalPaths` uses exact JSON-style paths represented as arrays of string object keys and number array indexes. There are no globs, prefixes, wildcards, negative indexes, or coercion between numeric strings and array indexes. For example, `['links', 0, 'url']` matches only the `url` property of the first element of a `links` array. Nested objects and arrays are traversed segment-by-segment; a missing parent marks only that configured path as degraded after the schema has already accepted the omission.
A configured optional path is degraded only when the value at that exact path is missing or `undefined` after successful schema parsing. `null` is treated as a present value, not as missing; if `null` is invalid for the schema, validation fails before degradation. Present optional values do not create degradation events. Missing required fields still fail schema validation and cannot be converted into degradation by policy.
### Boundary behavior

The terminal event remains the stream protocol marker, but the runner boundary must not treat it as sufficient proof of a valid step result. The execution entry point should validate the scratch-root result before the handoff is consumed by core. Two acceptable implementation shapes are:
1. enrich the terminal event result with a validated `stepResult` payload before core receives it; or
2. return a separate execution result object beside the terminal event while keeping the event stream unchanged.
Prefer the shape that minimizes churn while preserving the invariant: core and orchestration never consume raw scratch-root output.
The converged shape for this feature is an `ExecutionBoundaryEvent` stream. The execution entry point owns raw runner protocol validation before conversion: every raw runner event is checked against the strict runner event schema, the run id must match the dispatched run, exactly one raw terminal event must be observed, duplicate terminal events fail with `RunnerProtocolError`, and any event after the raw terminal fails with `RunnerProtocolError`. The raw terminal event is buffered and is not emitted directly. After result validation, execution emits exactly one `ExecutionTerminalResultEvent` whose `result` is validated against the post-validation handoff schema. Core and tests that consume the converted stream validate `ExecutionBoundaryEvent` with the execution-boundary schema/validator rather than validating the enriched terminal event against the strict raw `runnerEventSchema`.
If validation fails, execution should produce a terminal `fail` directive with a sanitized reason such as `Execution failed: schema_validation_failed` or `Execution failed: correction_attempts_exhausted`.
### Testing plan

Targeted tests:
- `packages/execution/src/result-tolerance.spec.ts` for pipeline order, success, normalization, ambiguity, degradation, and correction attempts.
- `packages/execution/src/result-contracts.spec.ts` for correct schema selection, duplicate registration, missing contract, and unknown contract failures.
- `packages/execution/src/result-normalizers.spec.ts` for registry behavior and default repair examples.
- `packages/execution/src/result-file.spec.ts` for scratch-root containment, sibling-root traversal rejection, missing files, unreadable files, and invalid JSON.
- `packages/execution/src/execution-boundary-events.spec.ts` for boundary event schema validation, duplicate terminal, post-terminal event, wrong run id, and terminal handoff schema failures.
- `packages/api-contract/src/step-results.spec.ts` for exported schema behavior.
- `packages/execution/src/stub-runner.spec.ts` updates for scripted result/correction behavior.
- `packages/core/src/execution-run-unit-of-work.spec.ts` updates for validated terminal payload mapping and failure behavior if the chosen boundary shape touches core.
- Existing control-plane execution-boundary integration tests extended or paired with a new test proving result validation through the stub runner path.
Suggested targeted commands:
```bash
pnpm nx test api-contract -- step-results.spec.ts
pnpm nx test execution -- result-contracts.spec.ts
pnpm nx test execution -- result-tolerance.spec.ts
pnpm nx test execution -- result-normalizers.spec.ts
pnpm nx test execution -- result-file.spec.ts
pnpm nx test execution -- execution-boundary-events.spec.ts
pnpm nx test core -- execution-run-unit-of-work.spec.ts
pnpm nx test control-plane -- control-plane-service.integration.spec.ts
pnpm test:boundaries
```
Run `pnpm validate` when practical after targeted tests pass.
### Risks and open edges

- Provider adapters may differ in how they ask an agent to correct output. This feature keeps that behavior behind a correction requester interface and proves only the stub path.
- The exact initial step-result schema surface may need to evolve as later workflow steps gain richer typed results.
- Optional-signal degradation must stay explicit. If it becomes broad or implicit, it could hide required-result failures.
- Validated result persistence is intentionally out of scope, so this feature proves the boundary handoff but does not make results durable on `RunStep`.
## Converged API

### Files

Path
Purpose
Exports

`packages/api-contract/src/step-results.ts`
Defines Zod-backed step result contracts shared across execution and orchestration. The terminal result schemas here are post-validation execution-to-core handoff shapes assembled by the execution entry point after scratch-root validation; they are not replacements for, nor extensions of, the strict runner_terminal_result streaming event payload in runner-events.ts. The initial validated result payload is deliberately constrained to a top-level JSON object so field-level optional-signal degradation can address stable paths. Contract metadata schemas identify executable step/schema-id pairs; concrete Zod schemas are held by execution-side registry definitions because Zod schema instances are runtime values, not JSON payloads.
`stepResultSchemaIdSchema`, `stepResultContractSchema`, `runnerTerminalStepResultSchema`, `runnerTerminalHandoffResultSchema`, `RunnerTerminalStepResult`, `RunnerTerminalHandoffResult`, `StepResultContract`

`packages/api-contract/src/index.ts`
Re-exports the new step result schemas and inferred TypeScript types from the api-contract package entry point. runner-events.ts remains unchanged and continues to define the strict raw runner event protocol.
`stepResultSchemaIdSchema`, `stepResultContractSchema`, `runnerTerminalStepResultSchema`, `runnerTerminalHandoffResultSchema`, `RunnerTerminalStepResult`, `RunnerTerminalHandoffResult`, `StepResultContract`

`packages/execution/src/result-contracts.ts`
Provides the execution-side registry/resolver for selecting a concrete Zod schema by `(step, schemaId)` for each run. The registry rejects duplicate contracts, resolves exact step/schema-id matches only, and returns sanitized `result_contract_missing` or `result_contract_unknown` failures for missing/unknown selections rather than using a generic fallback schema.
`createStepResultContractRegistry`, `resolveStepResultContract`, `StepResultContractDefinition`, `StepResultContractRegistry`, `StepResultContractResolver`, `StepResultContractResolution`, `StepResultContractResolutionFailure`

`packages/execution/src/result-tolerance.ts`
Provides the reusable ADR-012 tolerance pipeline that normalizes, validates, optionally records explicit optional-signal degradation, requests bounded corrections, and returns a typed validated result or sanitized failure metadata. File-read and contract-resolution failures promoted into this module map their codes 1:1 to the corresponding StepResultValidationFailureCode before schema validation begins.
`validateStepResult`, `defaultStepResultCorrectionMaxAttempts`, `StepResultValidationOutcome`, `StepResultValidationSuccess`, `StepResultValidationFailure`, `StepResultValidationFailureCode`, `ValidateStepResultInput`, `ResultValidationIssue`, `ResultToleranceEvent`, `ResultDegradationPolicy`

`packages/execution/src/result-normalizers.ts`
Defines the normalizer extension point, ordered registry, default deterministic repair examples, and helpers for registering independent deterministic normalizers without changing pipeline control flow. The registry records ambiguity as telemetry only; ambiguous input is never guessed and continues to schema validation and correction. Normalizer exceptions fail fast with sanitized `normalizer_failed` metadata.
`createResultNormalizerRegistry`, `defaultResultNormalizers`, `createFilenameAliasNormalizer`, `createUrlWrappedIdentifierNormalizer`, `ResultNormalizer`, `ResultNormalizerInput`, `ResultNormalizerOutcome`, `ResultNormalizerRegistry`, `FilenameAliasNormalizerOptions`, `UrlWrappedIdentifierNormalizerOptions`

`packages/execution/src/result-correction.ts`
Defines provider-neutral correction requester contracts and helpers for sanitized validation violation requests used by the bounded correction loop, including a no-op requester and request builder for adapters and tests.
`ResultCorrectionRequester`, `ResultCorrectionRequest`, `ResultCorrectionRequestInput`, `buildResultCorrectionRequest`, `createNoopResultCorrectionRequester`

`packages/execution/src/result-file.ts`
Reads and parses structured step result JSON from the materialized scratch root while enforcing scratch-root containment and returning typed sanitized file failures. A missing scratch root, including workspace.shape === 'none', is reported as result_file_missing because no result-file location exists. Traversal into sibling materialized roots such as repoRoot is rejected as outside the scratch root.
`readScratchStepResultFile`, `StepResultFileReadOutcome`, `StepResultFileReadSuccess`, `StepResultFileReadFailure`, `StepResultFileErrorCode`, `ReadScratchStepResultFileInput`

`packages/execution/src/stub-runner.ts`
Extends the existing stub runner options with scripted result-file writing and scripted correction behavior used by boundary and pipeline tests. StubRunner exposes getCorrectionRequester() so integration tests can wire the same scripted correction responses into CreateExecutionEntryPointOptions.resultValidation.correctionRequester.
`StubRunner`, `StubRunnerOptions`

`packages/execution/src/execution-boundary-events.ts`
Defines the post-validation execution-boundary event schema/validator. Non-terminal events remain raw RunnerEvent-compatible telemetry, while terminal events use the validated `ExecutionTerminalResultEvent` handoff schema. Core consumes this boundary validator after execution has already enforced raw runner protocol ordering.
`executionTerminalResultEventSchema`, `executionBoundaryEventSchema`, `validateExecutionBoundaryEvent`, `validateExecutionBoundaryEventStream`

`packages/execution/src/execution-entry-point.ts`
Wires result-file reading and tolerance validation into the execution boundary before core consumes terminal handoff data. It requires an explicit resultValidation mode or resolver: mode 'scratch_file' validates structured step results selected for the current run/step, while mode 'none' is the explicit opt-out for steps with no declared structured result. The execute stream validates raw runner events, buffers the raw runner terminal event, validates after the terminal is observed, then yields exactly one boundary terminal event: a validated terminal handoff on success or a synthesized fail terminal handoff with a sanitized reason on validation failure. Missing or invalid static resultValidation configuration is a programmer error and should throw TypeError during factory/config validation; missing or unknown per-run/per-step contract resolution is a sanitized validation failure.
`createExecutionEntryPoint`, `CreateExecutionEntryPointOptions`, `ExecutionEntryPoint`, `ExecutionEntryPointInput`, `ExecutionResultValidationConfig`, `ExecutionResultValidationResolver`, `ScratchFileExecutionResultValidationConfig`, `NoExecutionResultValidationConfig`, `ExecutionBoundaryEvent`, `ExecutionTerminalResultEvent`

`packages/execution/src/index.ts`
Re-exports package-level result contracts, tolerance, normalizer, correction, result-file, and execution-boundary APIs needed by adapters and tests. All public symbols referenced by contract resolution, validateStepResult, readScratchStepResultFile, correction requesters, and boundary result validation are re-exported from this entry point, including createExecutionEntryPoint itself.
`createStepResultContractRegistry`, `resolveStepResultContract`, `StepResultContractDefinition`, `StepResultContractRegistry`, `StepResultContractResolver`, `StepResultContractResolution`, `StepResultContractResolutionFailure`, `validateStepResult`, `defaultStepResultCorrectionMaxAttempts`, `createResultNormalizerRegistry`, `defaultResultNormalizers`, `createFilenameAliasNormalizer`, `createUrlWrappedIdentifierNormalizer`, `readScratchStepResultFile`, `buildResultCorrectionRequest`, `createNoopResultCorrectionRequester`, `ResultCorrectionRequester`, `ResultCorrectionRequest`, `ResultCorrectionRequestInput`, `ValidateStepResultInput`, `StepResultValidationOutcome`, `StepResultValidationSuccess`, `StepResultValidationFailure`, `StepResultValidationFailureCode`, `ResultValidationIssue`, `ResultToleranceEvent`, `ResultDegradationPolicy`, `ResultNormalizer`, `ResultNormalizerInput`, `ResultNormalizerOutcome`, `ResultNormalizerRegistry`, `FilenameAliasNormalizerOptions`, `UrlWrappedIdentifierNormalizerOptions`, `ReadScratchStepResultFileInput`, `StepResultFileReadOutcome`, `StepResultFileReadSuccess`, `StepResultFileReadFailure`, `StepResultFileErrorCode`, `executionTerminalResultEventSchema`, `executionBoundaryEventSchema`, `validateExecutionBoundaryEvent`, `validateExecutionBoundaryEventStream`, `createExecutionEntryPoint`, `CreateExecutionEntryPointOptions`, `ExecutionEntryPoint`, `ExecutionEntryPointInput`, `ExecutionResultValidationConfig`, `ExecutionResultValidationResolver`, `ScratchFileExecutionResultValidationConfig`, `NoExecutionResultValidationConfig`, `ExecutionBoundaryEvent`, `ExecutionTerminalResultEvent`

`packages/core/src/orchestrator.ts`
Owns the core RunUnitOfWork contract and RunWorkResult type consumed by orchestration. RunWorkResult's advance branch gains an optional validated result object supplied by execution-run-unit-of-work from the execution boundary terminal handoff; downstream exhaustive directive handling remains unchanged because directive values are not expanded.
`RunWorkInput`, `RunWorkResult`, `RunUnitOfWork`

`packages/core/src/execution-run-unit-of-work.ts`
Consumes the execution boundary's validated terminal handoff rather than raw scratch-root data. ExecutionRunUnitOfWorkOptions.execute continues to accept an ExecutionEntryPoint, but ExecutionEntryPoint.execute now yields ExecutionBoundaryEvent values instead of raw RunnerEvent values. createExecutionRunUnitOfWork consumes non-terminal RunnerEvent-compatible events for telemetry and maps the single ExecutionTerminalResultEvent.result to the orchestrator-owned RunWorkResult, including the validated result object when the directive advances. It never reads scratch-root files.
`ExecutionRunUnitOfWorkOptions`, `createExecutionRunUnitOfWork`

`packages/core/src/index.ts`
Continues to re-export orchestrator-owned RunWorkResult via export \* from ./orchestrator.js and re-exports createExecutionRunUnitOfWork plus ExecutionRunUnitOfWorkOptions. The existing core package entry point remains the public import path for the updated RunWorkResult shape.
`RunWorkInput`, `RunWorkResult`, `RunUnitOfWork`, `createExecutionRunUnitOfWork`, `ExecutionRunUnitOfWorkOptions`

`context-agent/wiki/code-map.md`
Documents the new tolerance pipeline, normalizer registry, result schemas, result-file helper, explicit execution result-validation modes, boundary terminal handoff shape, synthesized validation-failure terminal behavior, and correction-loop seams for future agents.

### Public API

#### `stepResultSchemaIdSchema`

```typescript
export const stepResultSchemaIdSchema: z.ZodString
```
- Returns: `z.ZodString`
#### `stepResultContractSchema`

```typescript
export const stepResultContractSchema: z.ZodObject
```
- Returns: `Zod schema for StepResultContract`
#### `runnerTerminalStepResultSchema`

```typescript
export const runnerTerminalStepResultSchema: z.ZodObject; reason?: z.ZodOptional; result?: z.ZodOptional> }>
```
- Returns: `Zod schema for RunnerTerminalStepResult. This is a post-validation execution-to-core handoff payload, not the strict runner_terminal_result event payload from runner-events.ts. The result field is intentionally top-level JSON-object-only to support field-path degradation policies.`
#### `runnerTerminalHandoffResultSchema`

```typescript
export const runnerTerminalHandoffResultSchema: z.ZodObject
```
- Returns: `Zod schema for RunnerTerminalHandoffResult`
#### `createStepResultContractRegistry`

```typescript
export function createStepResultContractRegistry(definitions?: readonly StepResultContractDefinition[]): StepResultContractRegistry
```
- Parameters:
	- `definitions: readonly StepResultContractDefinition[] | undefined` — Optional initial contract definitions keyed by exact `(step, schemaId)`.
- Returns: `StepResultContractRegistry`
- Errors:
	- `Throws Error when two definitions register the same step and schema id.`
#### `resolveStepResultContract`

```typescript
export function resolveStepResultContract(input: { readonly registry: StepResultContractRegistry; readonly step: string; readonly schemaId?: string }): StepResultContractResolution
```
- Parameters:
	- `input` — Registry plus the executable step and optional requested schema id for the current run.
- Returns: `StepResultContractResolution`
- Errors:
	- `Returns status 'failed' with code 'result_contract_missing' when no contract can be selected because the step or schema id was omitted.`
	- `Returns status 'failed' with code 'result_contract_unknown' when the requested step/schema-id pair is not registered.`
#### `validateStepResult`

```typescript
export async function validateStepResult(input: ValidateStepResultInput): Promise>>
```
- Parameters:
	- `input: ValidateStepResultInput` — Raw candidate, schema and schemaId, run/step identifiers, normalizer registry, optional correction requester, maximum correction attempts, and optional-signal degradation policy. The correction attempt count counts correction requests only, not the initial validation pass.
- Returns: `Promise>>`
- Errors:
	- `Returns status 'failed' with code 'schema_validation_failed' when validation fails and no correction attempts are available.`
	- `Returns status 'failed' with code 'correction_attempts_exhausted' when all configured correction requests return nonconforming candidates.`
	- `Returns status 'failed' with code 'correction_request_failed' when the correction requester throws or rejects.`
	- `Returns status 'failed' with code 'normalizer_failed' when a normalizer throws or rejects; the failure event is sanitized and the correction loop is not entered.`
	- `Ambiguous normalization is recorded as a ResultToleranceEvent code such as 'ambiguous_normalization' but is not a terminal failure code by itself.`
	- `Does not throw for normal validation failure paths; failures are represented as sanitized typed outcomes.`
#### `defaultStepResultCorrectionMaxAttempts`

```typescript
export const defaultStepResultCorrectionMaxAttempts: number
```
- Returns: `number`
#### `createResultNormalizerRegistry`

```typescript
export function createResultNormalizerRegistry(normalizers?: readonly ResultNormalizer[]): ResultNormalizerRegistry
```
- Parameters:
	- `normalizers: readonly ResultNormalizer[] | undefined` — Ordered normalizer entries to apply before schema validation. Omitted input creates an empty registry.
- Returns: `ResultNormalizerRegistry`
- Errors:
	- `Throws Error when duplicate normalizer ids are registered.`
#### `defaultResultNormalizers`

```typescript
export const defaultResultNormalizers: readonly ResultNormalizer[]
```
- Returns: `readonly ResultNormalizer[]`
#### `createFilenameAliasNormalizer`

```typescript
export function createFilenameAliasNormalizer(options: FilenameAliasNormalizerOptions): ResultNormalizer
```
- Parameters:
	- `options: FilenameAliasNormalizerOptions` — Normalizer id, target field path, and explicit alias-to-canonical filename map for deterministic canonicalization.
- Returns: `ResultNormalizer`
- Errors:
	- `Throws Error when alias mappings are empty or ambiguous for the same input value.`
#### `createUrlWrappedIdentifierNormalizer`

```typescript
export function createUrlWrappedIdentifierNormalizer(options: UrlWrappedIdentifierNormalizerOptions): ResultNormalizer
```
- Parameters:
	- `options: UrlWrappedIdentifierNormalizerOptions` — Normalizer id, target field path, accepted URL origin or pattern, and capture rule for extracting one unambiguous identifier.
- Returns: `ResultNormalizer`
- Errors:
	- `Throws Error when configuration cannot identify exactly one deterministic identifier capture rule.`
#### `ResultNormalizerRegistry.register`

```typescript
register(normalizer: ResultNormalizer): ResultNormalizerRegistry
```
- Parameters:
	- `normalizer: ResultNormalizer` — Independent deterministic normalizer to append to registry order.
- Returns: `ResultNormalizerRegistry`
- Errors:
	- `Throws Error when another normalizer with the same stable id is already registered.`
#### `ResultNormalizerRegistry.normalize`

```typescript
normalize(input: ResultNormalizerInput): { candidate: unknown; events: readonly ResultToleranceEvent[]; normalized: boolean; ambiguous: boolean; failed: boolean }
```
- Parameters:
	- `input: ResultNormalizerInput` — Candidate result plus step, schema, and attempt metadata supplied to each normalizer.
- Returns: `{ candidate: unknown; events: readonly ResultToleranceEvent[]; normalized: boolean; ambiguous: boolean; failed: boolean }. normalized means at least one normalizer produced a deterministic changed candidate; ambiguous means at least one normalizer reported ambiguity; failed means a normalizer threw or rejected and the current pass stopped. Ambiguity does not roll back prior deterministic changes and does not terminate the pipeline; the resulting candidate continues through validation and correction. Normalizer failure stops normalization and causes validateStepResult to return 'normalizer_failed'.`
- Errors:
	- `Normalizer exceptions are captured as sanitized tolerance events with code 'normalizer_failed'; thrown messages, stacks, candidates, and host paths are not exposed.`
#### `buildResultCorrectionRequest`

```typescript
export function buildResultCorrectionRequest(input: ResultCorrectionRequestInput): ResultCorrectionRequest
```
- Parameters:
	- `input: ResultCorrectionRequestInput` — Run id, step, schema id, attempt number, max attempts, validation issues, and candidate preview source.
- Returns: `ResultCorrectionRequest`
#### `createNoopResultCorrectionRequester`

```typescript
export function createNoopResultCorrectionRequester(): ResultCorrectionRequester
```
- Returns: `ResultCorrectionRequester`
#### `ResultCorrectionRequester.requestCorrection`

```typescript
requestCorrection(input: ResultCorrectionRequest): Promise
```
- Parameters:
	- `input: ResultCorrectionRequest` — Sanitized fixable validation violation sent to a runner adapter or provider-specific repair implementation.
- Returns: `Promise`
- Errors:
	- `May reject when the adapter cannot request or produce a correction; validateStepResult converts this to code 'correction_request_failed'.`
#### `readScratchStepResultFile`

```typescript
export async function readScratchStepResultFile(input: ReadScratchStepResultFileInput): Promise
```
- Parameters:
	- `input: ReadScratchStepResultFileInput` — Materialized execution environment plus scratch-root-relative result filename.
- Returns: `Promise`
- Errors:
	- `Returns status 'failed' with code 'result_file_missing' when the result file does not exist.`
	- `Returns status 'failed' with code 'result_file_unreadable' when the result file exists but cannot be read.`
	- `Returns status 'failed' with code 'result_json_invalid' when file contents are not valid JSON.`
	- `Returns status 'failed' with code 'result_path_outside_scratch_root' when the resolved path escapes scratchRoot, including traversal into another materialized root.`
	- `Returns status 'failed' with code 'result_file_missing' when no scratch root exists for workspace.shape 'none'.`
#### `StubRunner.getCorrectionRequester`

```typescript
getCorrectionRequester(): ResultCorrectionRequester
```
- Returns: `ResultCorrectionRequester backed by this StubRunner instance's scripted correctionResponses queue. Each request consumes one scripted response in order; when responses are exhausted the requester rejects so validateStepResult returns 'correction_request_failed' unless the max-attempt path is reached first.`
#### `ExecutionEntryPoint.execute`

```typescript
execute(input: ExecutionEntryPointInput): AsyncIterable
```
- Parameters:
	- `input: ExecutionEntryPointInput` — Execution context and optional correlation id for a run.
- Returns: `An async stream that forwards non-terminal raw RunnerEvent-compatible events, buffers the raw runner terminal event, performs configured result validation after the terminal is observed, and then yields one ExecutionTerminalResultEvent. On validation failure it yields a synthesized fail terminal handoff with a sanitized reason instead of throwing for ordinary validation failures.`
- Errors:
	- `Throws RunnerProtocolError for raw runner protocol violations that prevent a trustworthy terminal handoff.`
	- `Throws materialization or unexpected runner errors before a terminal handoff can be synthesized.`
	- `Throws TypeError before streaming when the entry point was constructed with invalid resultValidation configuration by an untyped caller.`
#### `validateExecutionBoundaryEvent`

```typescript
export function validateExecutionBoundaryEvent(event: unknown): ExecutionBoundaryEvent
```
- Parameters:
	- `event: unknown` — A candidate post-validation boundary event.
- Returns: `ExecutionBoundaryEvent`
- Errors:
	- `Throws RunnerProtocolError when a non-terminal event fails the raw runner event schema or when a terminal event fails the execution terminal handoff schema.`
#### `validateExecutionBoundaryEventStream`

```typescript
export async function validateExecutionBoundaryEventStream(events: AsyncIterable, expectedRunId: string): AsyncIterable
```
- Parameters:
	- `events: AsyncIterable` — Candidate post-validation boundary stream.
	- `expectedRunId: string` — Expected run id for all events in the stream.
- Returns: `AsyncIterable`
- Errors:
	- `Throws RunnerProtocolError for wrong run id, duplicate terminal boundary events, post-terminal events, missing terminal events, or terminal handoff schema violations.`
#### `createExecutionEntryPoint`

```typescript
export function createExecutionEntryPoint(options: CreateExecutionEntryPointOptions): ExecutionEntryPoint
```
- Parameters:
	- `options: CreateExecutionEntryPointOptions` — Runner, materializer, and required explicit resultValidation mode or resolver. Use resultValidation.mode 'scratch_file' for steps with declared structured results; use a resolver when schema selection varies by run/step; use mode 'none' only for steps that intentionally have no structured result contract.
- Returns: `ExecutionEntryPoint`
- Errors:
	- `Throws TypeError for missing, malformed, or unsupported resultValidation configuration supplied by runtime/JavaScript callers; this is a programmer error rather than a StepResultValidationFailureCode.`
#### `createExecutionRunUnitOfWork`

```typescript
export function createExecutionRunUnitOfWork(options: ExecutionRunUnitOfWorkOptions): RunUnitOfWork
```
- Parameters:
	- `options: ExecutionRunUnitOfWorkOptions` — Execution entry point, context resolver, and optional event observer. The entry point now yields ExecutionBoundaryEvent values; core consumes only the validated ExecutionTerminalResultEvent for terminal mapping.
- Returns: `RunUnitOfWork whose RunWorkResult includes the validated result object on advance when present.`
- Errors:
	- `Re-throws RunnerProtocolError for protocol violations.`
	- `Maps validation failure terminal handoffs to RunWorkResult { directive: 'fail', reason }.`
### Types

#### `RunnerTerminalStepResult`

```typescript
export type RunnerTerminalStepResult = z.infer;
```
#### `RunnerTerminalHandoffResult`

```typescript
export type RunnerTerminalHandoffResult = z.infer;
```
#### `StepResultContract`

```typescript
export type StepResultContract = z.infer;
```
#### `StepResultContractDefinition`

```typescript
export interface StepResultContractDefinition { readonly step: string; readonly schemaId: string; readonly schema: TSchema; readonly resultFile?: string; readonly degradationPolicy?: ResultDegradationPolicy; }
```
#### `StepResultContractRegistry`

```typescript
export interface StepResultContractRegistry { readonly contracts: readonly StepResultContractDefinition[]; register(definition: StepResultContractDefinition): StepResultContractRegistry; resolve(input: { readonly step: string; readonly schemaId?: string }): StepResultContractResolution; }
```
#### `StepResultContractResolver`

```typescript
export type StepResultContractResolver = (input: ExecutionEntryPointInput) => StepResultContractResolution | Promise;
```
#### `StepResultContractResolution`

```typescript
export type StepResultContractResolution = { readonly status: 'resolved'; readonly contract: StepResultContractDefinition } | StepResultContractResolutionFailure;
```
#### `StepResultContractResolutionFailure`

```typescript
export interface StepResultContractResolutionFailure { readonly status: 'failed'; readonly code: 'result_contract_missing' | 'result_contract_unknown'; readonly safeMessage: string; readonly issues: readonly ResultValidationIssue[]; }
```
#### `ValidateStepResultInput`

```typescript
export interface ValidateStepResultInput { readonly runId: string; readonly step: string; readonly schemaId: string; readonly schema: TSchema; readonly candidate: unknown; readonly normalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[]; readonly correctionRequester?: ResultCorrectionRequester; readonly maxCorrectionAttempts?: number; readonly degradationPolicy?: ResultDegradationPolicy; }
```
#### `StepResultValidationOutcome`

```typescript
export type StepResultValidationOutcome = StepResultValidationSuccess | StepResultValidationFailure;
```
#### `StepResultValidationSuccess`

```typescript
export interface StepResultValidationSuccess { readonly status: 'valid'; readonly value: TValue; readonly schemaId: string; readonly normalized: boolean; readonly correctedAttempts: number; readonly degraded: boolean; readonly degradedPaths: readonly (readonly (string | number)[])[]; readonly events: readonly ResultToleranceEvent[]; }
```
#### `StepResultValidationFailure`

```typescript
export interface StepResultValidationFailure { readonly status: 'failed'; readonly code: StepResultValidationFailureCode; readonly schemaId: string; readonly attempts: number; readonly safeMessage: string; readonly issues: readonly ResultValidationIssue[]; readonly events: readonly ResultToleranceEvent[]; }
```
#### `StepResultValidationFailureCode`

```typescript
export type StepResultValidationFailureCode = 'result_contract_missing' | 'result_contract_unknown' | 'result_file_missing' | 'result_file_unreadable' | 'result_json_invalid' | 'schema_validation_failed' | 'correction_attempts_exhausted' | 'correction_request_failed' | 'normalizer_failed' | 'result_path_outside_scratch_root';
```
#### `ResultValidationIssue`

```typescript
export interface ResultValidationIssue { readonly code: string; readonly path: readonly (string | number)[]; readonly message: string; }
```
#### `ResultToleranceEvent`

```typescript
export interface ResultToleranceEvent { readonly kind: 'accepted' | 'normalized' | 'ambiguous' | 'corrected' | 'degraded' | 'failed'; readonly code?: StepResultValidationFailureCode | 'ambiguous_normalization' | string; readonly path?: readonly (string | number)[]; readonly normalizerId?: string; readonly attempt?: number; readonly message: string; }
```
#### `ResultDegradationPolicy`

```typescript
export interface ResultDegradationPolicy { readonly optionalPaths: readonly (readonly (string | number)[])[]; }
```
`optionalPaths` are exact paths only. Missing or `undefined` values at those paths set degradation metadata; `null` and present values do not. Degradation never mutates `StepResultValidationSuccess.value`.
#### `ResultNormalizer`

```typescript
export interface ResultNormalizer { readonly id: string; readonly description: string; normalize(input: ResultNormalizerInput): ResultNormalizerOutcome; }
```
#### `ResultNormalizerInput`

```typescript
export interface ResultNormalizerInput { readonly candidate: unknown; readonly runId?: string; readonly step: string; readonly schemaId: string; readonly attempt: number; }
```
#### `ResultNormalizerOutcome`

```typescript
export type ResultNormalizerOutcome = { readonly status: 'unchanged' } | { readonly status: 'changed'; readonly candidate: unknown; readonly message: string } | { readonly status: 'ambiguous'; readonly message: string };
```
#### `ResultNormalizerRegistry`

```typescript
export interface ResultNormalizerRegistry { readonly normalizers: readonly ResultNormalizer[]; register(normalizer: ResultNormalizer): ResultNormalizerRegistry; normalize(input: ResultNormalizerInput): { candidate: unknown; events: readonly ResultToleranceEvent[]; normalized: boolean; ambiguous: boolean; failed: boolean }; }
```
#### `FilenameAliasNormalizerOptions`

```typescript
export interface FilenameAliasNormalizerOptions { readonly id: string; readonly description?: string; readonly path: readonly (string | number)[]; readonly aliases: Readonly>; }
```
#### `UrlWrappedIdentifierNormalizerOptions`

```typescript
export interface UrlWrappedIdentifierNormalizerOptions { readonly id: string; readonly description?: string; readonly path: readonly (string | number)[]; readonly allowedOrigins?: readonly string[]; readonly identifierPattern: RegExp; }
```
#### `ResultCorrectionRequester`

```typescript
export interface ResultCorrectionRequester { requestCorrection(input: ResultCorrectionRequest): Promise; }
```
#### `ResultCorrectionRequest`

```typescript
export interface ResultCorrectionRequest { readonly runId: string; readonly step: string; readonly schemaId: string; readonly attempt: number; readonly maxAttempts: number; readonly issues: readonly ResultValidationIssue[]; readonly safeCandidatePreview: unknown; }
```
#### `ResultCorrectionRequestInput`

```typescript
export interface ResultCorrectionRequestInput { readonly runId: string; readonly step: string; readonly schemaId: string; readonly attempt: number; readonly maxAttempts: number; readonly issues: readonly ResultValidationIssue[]; readonly candidate: unknown; readonly previewByteLimit?: number; }
```
#### `ReadScratchStepResultFileInput`

```typescript
export interface ReadScratchStepResultFileInput { readonly environment: MaterializedExecutionEnvironment; readonly resultFile: string; }
```
#### `StepResultFileReadOutcome`

```typescript
export type StepResultFileReadOutcome = StepResultFileReadSuccess | StepResultFileReadFailure;
```
#### `StepResultFileReadSuccess`

```typescript
export interface StepResultFileReadSuccess { readonly status: 'read'; readonly value: unknown; readonly relativePath: string; }
```
#### `StepResultFileReadFailure`

```typescript
export interface StepResultFileReadFailure { readonly status: 'failed'; readonly code: StepResultFileErrorCode; readonly safeMessage: string; readonly issues: readonly ResultValidationIssue[]; }
```
#### `StepResultFileErrorCode`

```typescript
export type StepResultFileErrorCode = 'result_file_missing' | 'result_file_unreadable' | 'result_json_invalid' | 'result_path_outside_scratch_root';
```
#### `StubRunnerOptions`

```typescript
export interface StubRunnerOptions { readonly scriptedEvents?: readonly RunnerEvent[]; readonly terminalDirective?: RunnerTerminalDirective; readonly resultFile?: { readonly relativePath: string; readonly value: unknown }; readonly correctionResponses?: readonly unknown[]; }
```
#### `NoExecutionResultValidationConfig`

```typescript
export interface NoExecutionResultValidationConfig { readonly mode: 'none'; }
```
#### `ScratchFileExecutionResultValidationConfig`

```typescript
export interface ScratchFileExecutionResultValidationConfig { readonly mode: 'scratch_file'; readonly step?: string; readonly schemaId?: string; readonly schema?: TSchema; readonly resultFile?: string; readonly contract?: StepResultContractDefinition; readonly contractRegistry?: StepResultContractRegistry; readonly normalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[]; readonly correctionRequester?: ResultCorrectionRequester; readonly maxCorrectionAttempts?: number; readonly degradationPolicy?: ResultDegradationPolicy; }
```
#### `ExecutionResultValidationConfig`

```typescript
export type ExecutionResultValidationConfig = NoExecutionResultValidationConfig | ScratchFileExecutionResultValidationConfig;
```
#### `ExecutionResultValidationResolver`

```typescript
export type ExecutionResultValidationResolver = (input: ExecutionEntryPointInput) => ExecutionResultValidationConfig | Promise;
```
#### `CreateExecutionEntryPointOptions`

```typescript
export interface CreateExecutionEntryPointOptions { readonly runner: Runner; readonly materialize: (context: ExecutionContext) => Promise; readonly resultValidation: ExecutionResultValidationConfig | ExecutionResultValidationResolver; }
```
#### `ExecutionEntryPointInput`

```typescript
export interface ExecutionEntryPointInput { readonly context: ExecutionContext; readonly correlationId?: string; }
```
#### `ExecutionTerminalResultEvent`

```typescript
export interface ExecutionTerminalResultEvent extends Omit { readonly result: RunnerTerminalStepResult; readonly resultContract?: { readonly step: string; readonly schemaId: string }; }
```
#### `ExecutionBoundaryEvent`

```typescript
export type ExecutionBoundaryEvent = Exclude | ExecutionTerminalResultEvent;
```
#### `ExecutionEntryPoint`

```typescript
export interface ExecutionEntryPoint { execute(input: ExecutionEntryPointInput): AsyncIterable; }
```
#### `ExecutionRunUnitOfWorkOptions`

```typescript
export interface ExecutionRunUnitOfWorkOptions { readonly execute: ExecutionEntryPoint; readonly resolveContext: (input: RunWorkInput) => Promise; readonly onEvent?: (event: ExecutionBoundaryEvent) => void | Promise; }
```
#### `RunWorkResult`

```typescript
export type RunWorkResult = { readonly directive: 'advance'; readonly result?: Readonly> } | { readonly directive: 'needs_input'; readonly question?: string } | { readonly directive: 'fail'; readonly reason: string };
```
### Notes

This revised artifact addresses the critic findings by making execution result validation explicit rather than silently optional, exposing StubRunner.getCorrectionRequester() for scripted correction-loop integration tests, completing package entry-point exports including createExecutionEntryPoint, preserving the raw runner event schema as strict and separate from the post-validation boundary handoff schema, reporting workspace.shape === 'none' as result_file_missing, defining exact metadata-only optional-path degradation semantics, removing ambiguous_normalization and the unreachable result_validation_not_configured as terminal failure codes, documenting core signature changes and RunWorkResult ownership in orchestrator.ts with core index re-export, and specifying that execution communicates validation failure by yielding a synthesized fail ExecutionTerminalResultEvent. This update also adds per-run/per-step result contract resolution, scratch-root-only file containment, execution-boundary event validation, and required `normalizer_failed` behavior for throwing normalizers. Provider-specific correction behavior remains unsupported in this round beyond the provider-neutral ResultCorrectionRequester contract and scripted stub-runner responses. Top-level structured step results are intentionally JSON objects, not arrays, for this initial boundary API so field-level degradation policies remain well-defined. Missing or malformed static resultValidation configuration is specified as a TypeError programmer error because the public options type requires an explicit mode or resolver; missing or unknown resolved contracts are sanitized validation failures.
## Task list

### Story 1: Publish shared step-result contracts

#### Task 1.1: Add step-result schemas to `@autocatalyst/api-contract`

**Description:** Create `packages/api-contract/src/step-results.ts` with the Zod-backed schema ids, step-result contract schema, post-validation runner terminal step-result schema, terminal handoff schema, and inferred TypeScript types from the Converged API.
**Acceptance criteria:**
- `stepResultSchemaIdSchema` validates non-empty schema id strings.
- `stepResultContractSchema` validates non-empty `step` and `schemaId` values.
- `runnerTerminalStepResultSchema` accepts the existing terminal directives and optional `question`, `reason`, and top-level JSON-object `result`.
- `runnerTerminalHandoffResultSchema` wraps `step`, `schemaId`, and the terminal handoff payload.
- The new schemas are separate from `runner-events.ts`; the raw `runner_terminal_result` event schema remains strict and unchanged.
- TypeScript types are inferred from Zod schemas rather than hand-maintained duplicate interfaces.
**Dependencies:** None.
#### Task 1.2: Add step-result contract tests

**Description:** Add `packages/api-contract/src/step-results.spec.ts` to prove the exported schemas accept valid terminal handoff data and reject malformed handoff data.
**Acceptance criteria:**
- Tests cover valid `advance`, `needs_input`, and `fail` terminal handoff payloads.
- Tests prove `result` accepts a top-level JSON object and rejects arrays or non-object payloads.
- Tests prove missing required `step`, `schemaId`, or `directive` fails validation.
- Tests prove malformed directive values fail validation.
- Tests document that these schemas model the post-validation execution-to-core handoff, not the raw runner event payload.
**Dependencies:** Task 1.1.
#### Task 1.3: Export step-result contracts from the api-contract entry point

**Description:** Update `packages/api-contract/src/index.ts` so consumers can import all new step-result schemas and inferred types from `@autocatalyst/api-contract`.
**Acceptance criteria:**
- The package entry point exports `stepResultSchemaIdSchema`, `stepResultContractSchema`, `runnerTerminalStepResultSchema`, and `runnerTerminalHandoffResultSchema`.
- The package entry point exports `RunnerTerminalStepResult`, `RunnerTerminalHandoffResult`, and `StepResultContract`.
- Existing api-contract exports remain available.
- The api-contract index test or TypeScript validation proves public entry-point imports work.
**Dependencies:** Tasks 1.1 and 1.2.
#### Task 1.4: Add execution step-result contract registry

**Description:** Create `packages/execution/src/result-contracts.ts` with the execution-side registry and resolver that bind executable steps and schema ids to concrete Zod schemas, default scratch result files, and optional degradation policies.
**Acceptance criteria:**
- `createStepResultContractRegistry` registers contracts keyed by exact `(step, schemaId)`.
- Duplicate `(step, schemaId)` registrations throw during registry construction or registration.
- `resolveStepResultContract` returns the matching contract for the requested current run/step selection.
- Missing step/schema selection returns sanitized `result_contract_missing`.
- Unknown step or schema id returns sanitized `result_contract_unknown`.
- Resolution never falls back to `runnerTerminalHandoffResultSchema` or any other generic schema.
- Unit tests cover correct schema selection, duplicate registration, missing selection, and unknown step/schema-id failure.
**Dependencies:** Tasks 1.1 and 1.3.
### Story 2: Implement the tolerance pipeline core

#### Task 2.1: Define pipeline outcome, failure, event, and input types

**Description:** Create `packages/execution/src/result-tolerance.ts` with the public pipeline types and `defaultStepResultCorrectionMaxAttempts`, then stub `validateStepResult` behind the agreed API.
**Acceptance criteria:**
- `ValidateStepResultInput`, `StepResultValidationOutcome`, success and failure types, failure codes, validation issues, tolerance events, and degradation policy types match the Converged API.
- Failure codes include file-read failure codes, contract-resolution failures, schema validation failure, correction attempts exhaustion, correction requester failure, normalizer failure, and scratch-root path escape.
- `ambiguous_normalization` is available only as an event code, not as a terminal failure code.
- Public failure messages and issues are structured for sanitization and do not require message parsing.
- The initial implementation compiles without importing `packages/core`.
**Dependencies:** Story 1.
#### Task 2.2: Build the normalizer registry and deterministic normalizer helpers

**Description:** Create `packages/execution/src/result-normalizers.ts` with ordered registry behavior, duplicate-id protection, default normalizers, filename alias normalizer, and URL-wrapped identifier normalizer.
**Acceptance criteria:**
- `createResultNormalizerRegistry` creates an empty or seeded ordered registry.
- `register` appends normalizers and rejects duplicate stable ids.
- `normalize` applies normalizers in order and returns candidate, events, `normalized`, and `ambiguous` flags.
- A filename alias normalizer maps explicit aliases to canonical values only when the mapping is unambiguous.
- A URL-wrapped identifier normalizer extracts exactly one deterministic identifier only when the URL shape and capture rule are unambiguous.
- Ambiguous outcomes record telemetry events and do not guess, throw, or roll back prior deterministic changes.
- A normalizer that throws or rejects produces a sanitized `normalizer_failed` event, stops the current normalization pass, and exposes no thrown message, stack, raw candidate, or host path.
**Dependencies:** Task 2.1.
#### Task 2.3: Build provider-neutral correction request helpers

**Description:** Create `packages/execution/src/result-correction.ts` with `ResultCorrectionRequester`, request types, `buildResultCorrectionRequest`, and `createNoopResultCorrectionRequester`.
**Acceptance criteria:**
- Correction requests include run id, step, schema id, attempt number, max attempts, validation issues, and safe candidate preview.
- Candidate previews are bounded by a configurable byte limit or safe default.
- Requests exclude secrets, ambient environment values, absolute host paths, and full raw model output.
- The no-op requester has deterministic behavior suitable for tests that expect no correction path.
- Rejected correction requests are compatible with `validateStepResult` mapping to `correction_request_failed`.
**Dependencies:** Task 2.1.
#### Task 2.4: Implement `validateStepResult`

**Description:** Complete the ADR-012 pipeline order in `validateStepResult`: deterministic normalization, schema validation, bounded correction, and explicit optional-signal degradation.
**Acceptance criteria:**
- The initial candidate is normalized before the first schema validation.
- Successful schema validation returns a typed value inferred from the supplied Zod schema.
- A non-empty degradation policy marks configured optional paths as degraded without inventing required data or mutating the returned typed value.
- Optional path matching follows exact string-key/number-index path arrays; missing or `undefined` values degrade, `null` is treated as present, and nested object/array paths are traversed segment-by-segment.
- Present optional fields do not set degraded metadata.
- Validation failure builds structured issues and enters correction only when attempts remain and a correction requester is available.
- `maxCorrectionAttempts` counts correction requests, not the initial validation pass.
- Each correction candidate re-enters the pipeline at deterministic normalization before validation.
- Exhausted corrections return `status: 'failed'` with code `correction_attempts_exhausted`.
- Validation failure with no available correction attempts returns `schema_validation_failed`.
- Correction requester rejection returns `correction_request_failed`.
- Normalizer exceptions return `normalizer_failed` and do not enter the correction loop.
- Normal validation and correction failures return typed outcomes rather than throwing.
**Dependencies:** Tasks 2.1, 2.2, and 2.3.
#### Task 2.5: Test pipeline and normalizer behavior

**Description:** Add `packages/execution/src/result-tolerance.spec.ts` and `packages/execution/src/result-normalizers.spec.ts` for the core pipeline and registry behavior.
**Acceptance criteria:**
- Tests prove deterministic repair succeeds with no correction round-trip.
- Tests prove ambiguous input is not coerced and enters correction when validation fails.
- Tests prove malformed output makes exactly the configured number of correction requests and then fails.
- Tests prove a valid correction succeeds after re-running normalization and validation.
- Tests prove missing optional signal degradation succeeds when the path is configured.
- Tests prove present optional fields do not degrade.
- Tests prove nested optional paths and missing parents are recorded in `degradedPaths` without mutating `value`.
- Tests prove `null` at an optional path is not treated as missing.
- Tests prove missing required fields fail.
- Tests prove a throwing normalizer returns sanitized `normalizer_failed`.
- Tests prove a new normalizer can be registered without changing pipeline control flow.
- Tests prove duplicate normalizer ids are rejected.
**Dependencies:** Tasks 2.2 and 2.4.
### Story 3: Read structured result files from scratch roots

#### Task 3.1: Add scratch-root-contained result-file reading

**Description:** Create `packages/execution/src/result-file.ts` with `readScratchStepResultFile`, typed read outcomes, and sanitized error codes for missing, unreadable, invalid, or escaped result files.
**Acceptance criteria:**
- The helper requires a materialized execution environment with a scratch root.
- `workspace.shape === 'none'` and any other missing scratch root return `result_file_missing`.
- The helper resolves `resultFile` relative to the scratch root and enforces containment by `scratchRoot` itself before reading.
- Result paths that escape `scratchRoot` return `result_path_outside_scratch_root`, even when the escaped target is inside another materialized workspace root.
- Missing files return `result_file_missing`.
- Unreadable files return `result_file_unreadable`.
- Malformed JSON returns `result_json_invalid`.
- Successful reads parse JSON into `unknown` and return only a scratch-root-relative path.
- User-visible messages do not expose absolute host paths or raw file contents.
**Dependencies:** Story 2.
#### Task 3.2: Test result-file safety and parsing

**Description:** Add `packages/execution/src/result-file.spec.ts` for scratch-root containment, read failures, parse failures, and successful reads.
**Acceptance criteria:**
- Tests cover successful JSON reads from inside `scratchRoot`.
- Tests cover missing result files.
- Tests cover invalid JSON.
- Tests cover paths that attempt to escape the scratch root.
- Tests cover sibling-root traversal such as `../repo/result.json` and prove it is rejected even when `repoRoot` is materialized.
- Tests cover environments with `workspace.shape === 'none'`.
- Tests assert sanitized failures do not include absolute host paths.
**Dependencies:** Task 3.1.
### Story 4: Wire validation into the execution boundary and stub runner

#### Task 4.1: Extend `StubRunner` for scripted result files and corrections

**Description:** Update `packages/execution/src/stub-runner.ts` so tests can script result-file writes and correction responses without model-provider calls.
**Acceptance criteria:**
- `StubRunnerOptions.resultFile` writes structured JSON to the configured scratch-relative result file when a scratch root exists.
- Stub result-file writing uses the same scratch-root containment rule as result-file reading.
- `StubRunnerOptions.correctionResponses` stores deterministic correction candidates in request order.
- `StubRunner.getCorrectionRequester()` returns a requester backed by the scripted response queue.
- Each correction request consumes at most one scripted response.
- Exhausted scripted responses reject so `validateStepResult` can surface `correction_request_failed` unless the configured exhaustion path is reached first.
- Existing default stub event order and terminal directive behavior remain intact.
**Dependencies:** Tasks 2.3 and 3.1.
#### Task 4.2: Require explicit execution result-validation configuration

**Description:** Update `packages/execution/src/execution-entry-point.ts` types and factory validation so callers must pass `resultValidation.mode: 'scratch_file'`, `resultValidation.mode: 'none'`, or a resolver that selects one of those modes for the current run/step.
**Acceptance criteria:**
- `CreateExecutionEntryPointOptions` requires a `resultValidation` config or resolver.
- `mode: 'scratch_file'` requires either an inline schema/schema id/result file, an inline `contract`, or a `contractRegistry` plus requested step/schema id.
- Resolver-based validation can select a different contract per `ExecutionEntryPointInput` without constructing a new entry-point factory.
- Missing or unknown per-run/per-step contract resolution yields sanitized `result_contract_missing` or `result_contract_unknown` terminal failure.
- `mode: 'none'` is the explicit opt-out for steps with no structured result contract.
- Missing, malformed, or unsupported runtime configuration throws `TypeError` during factory/config validation.
- Invalid configuration is not represented as a `StepResultValidationFailureCode`.
- Existing entry-point behavior is preserved when callers intentionally use `mode: 'none'`.
**Dependencies:** Tasks 1.4, 2.1, and 3.1.
#### Task 4.3: Validate scratch-root results before yielding the boundary terminal event

**Description:** Update the execution entry point to buffer the raw runner terminal event, read and validate the structured scratch-root result when configured, and yield one post-validation `ExecutionTerminalResultEvent`.
**Acceptance criteria:**
- `packages/execution/src/execution-boundary-events.ts` defines `executionTerminalResultEventSchema`, `executionBoundaryEventSchema`, `validateExecutionBoundaryEvent`, and `validateExecutionBoundaryEventStream`.
- The boundary validator accepts non-terminal raw RunnerEvent-compatible events and validates terminal handoffs against the post-validation terminal handoff schema rather than the strict raw terminal event schema.
- Non-terminal runner events continue to stream in order through the boundary.
- Raw runner events are validated against the strict raw runner event schema and expected run id before forwarding or buffering.
- The raw terminal event is buffered until result validation completes.
- In `scratch_file` mode, execution reads the result file through `readScratchStepResultFile`.
- File-read failures map 1:1 to the corresponding pipeline failure codes before schema validation begins.
- Contract-resolution failures map to synthesized fail terminal handoffs before file reading begins.
- Successful validation yields one `ExecutionTerminalResultEvent` with a `RunnerTerminalStepResult` handoff payload and `resultContract`.
- Validation failure yields one synthesized fail terminal handoff with a sanitized reason such as `Execution failed: correction_attempts_exhausted`.
- The core adapter never receives or reads raw scratch-root result data.
- Execution throws `RunnerProtocolError` for wrong run id, duplicate raw terminal events, and post-terminal raw events.
**Dependencies:** Tasks 1.4, 2.4, 3.1, and 4.2.
#### Task 4.4: Test execution-boundary validation behavior

**Description:** Update `packages/execution/src/execution-entry-point.spec.ts` and `packages/execution/src/stub-runner.spec.ts` for explicit validation modes, scripted result writing, scripted correction, and synthesized failure terminal handoffs.
**Acceptance criteria:**
- Tests cover `mode: 'none'` preserving intentional no-result behavior.
- Tests cover missing or malformed result-validation config throwing `TypeError`.
- Tests cover resolver-based per-run/per-step schema selection.
- Tests cover missing and unknown result contract failures.
- Tests cover successful scratch-file validation yielding a typed terminal handoff.
- Tests cover file-read validation failure yielding a synthesized fail terminal handoff.
- Tests cover schema-validation failure yielding a sanitized fail terminal handoff.
- Tests cover raw duplicate terminal events, post-terminal raw events, and wrong run id raising `RunnerProtocolError`.
- Tests cover terminal handoff schema validation for the emitted `ExecutionBoundaryEvent` shape.
- Tests cover stub-runner scripted correction recovery.
- Tests cover stub-runner correction-response exhaustion or rejection.
- Tests prove non-terminal events are still forwarded in order.
**Dependencies:** Tasks 4.1, 4.2, and 4.3.
### Story 5: Adapt core to consume validated boundary handoffs

#### Task 5.1: Update orchestrator-owned `RunWorkResult`

**Description:** Update `packages/core/src/orchestrator.ts` so the `advance` branch of `RunWorkResult` can carry the optional validated result object described by the Converged API.
**Acceptance criteria:**
- `RunWorkResult` remains owned and exported by `orchestrator.ts`.
- The `advance` branch accepts an optional readonly JSON-object result.
- Directive values are not expanded beyond `advance`, `needs_input`, and `fail`.
- Existing orchestrator directive handling remains exhaustive.
- Existing callers that ignore `result` continue to compile.
**Dependencies:** Story 1.
#### Task 5.2: Update `ExecutionRunUnitOfWork` for `ExecutionBoundaryEvent`

**Description:** Update `packages/core/src/execution-run-unit-of-work.ts` so it consumes the execution entry point's validated `ExecutionBoundaryEvent` stream and maps the single `ExecutionTerminalResultEvent.result` into `RunWorkResult`.
**Acceptance criteria:**
- `ExecutionRunUnitOfWorkOptions.execute` accepts an `ExecutionEntryPoint` yielding `ExecutionBoundaryEvent` values.
- The adapter uses the execution boundary event validator for the converted stream instead of applying the strict raw runner event schema to `ExecutionTerminalResultEvent`.
- Non-terminal RunnerEvent-compatible events still flow to the optional telemetry hook.
- The adapter maps `advance` terminal handoffs to `RunWorkResult` and includes the validated result object when present.
- The adapter maps synthesized validation-failure terminal handoffs to `RunWorkResult { directive: 'fail', reason }`.
- The adapter does not read scratch-root files or inspect raw runner output.
- Existing protocol errors continue to be re-thrown according to the runner boundary contract.
**Dependencies:** Tasks 4.3 and 5.1.
#### Task 5.3: Test core validated handoff mapping

**Description:** Update `packages/core/src/execution-run-unit-of-work.spec.ts` and related orchestrator tests for validated result mapping and synthesized validation-failure handoffs.
**Acceptance criteria:**
- Tests cover an `advance` terminal handoff with a validated result object.
- Tests cover `advance` without a result object.
- Tests cover synthesized validation failure mapping to a fail directive and sanitized reason.
- Tests cover `needs_input` question preservation.
- Tests cover `fail` reason preservation.
- Tests prove core does not read result files or depend on execution internals.
**Dependencies:** Task 5.2.
### Story 6: Publish execution exports and preserve package boundaries

#### Task 6.1: Export the new execution APIs from `@autocatalyst/execution`

**Description:** Update `packages/execution/src/index.ts` so adapters and tests can import the contract registry, tolerance pipeline, normalizer registry, correction requester helpers, result-file helper, execution entry point, and boundary event schema/validator types from the package entry point.
**Acceptance criteria:**
- All public symbols listed for `packages/execution/src/index.ts` in the Converged API are exported.
- Contract registry/resolver exports and execution boundary event schema/validator exports are included.
- Existing execution package exports remain available.
- Consumers do not need `@autocatalyst/execution/src/*` imports for the new APIs.
- The execution index test or TypeScript validation proves public entry-point imports work.
**Dependencies:** Stories 1, 2, 3, and 4.
#### Task 6.2: Keep core exports and package boundaries current

**Description:** Update `packages/core/src/index.ts` as needed for the updated `RunWorkResult`, `createExecutionRunUnitOfWork`, and `ExecutionRunUnitOfWorkOptions`, then verify package-boundary constraints.
**Acceptance criteria:**
- Core continues to export `RunWorkInput`, `RunWorkResult`, and `RunUnitOfWork` from the public entry point.
- Core exports `createExecutionRunUnitOfWork` and `ExecutionRunUnitOfWorkOptions`.
- `packages/execution` does not import `packages/core`.
- Control-plane or core consumers import execution APIs only from `@autocatalyst/execution`.
- Boundary validation catches no new internal-package imports or dependency cycles.
**Dependencies:** Tasks 5.2 and 6.1.
### Story 7: Prove integration behavior and update agent documentation

#### Task 7.1: Add boundary integration coverage for stub-runner validation

**Description:** Add or extend the existing execution-boundary integration test so a stub runner writes a structured scratch-root result, execution validates it, and core receives only the validated handoff.
**Acceptance criteria:**
- The test dispatches through the execution boundary using a materialized scratch root.
- The stub runner writes a valid result file.
- Execution validates the result through the tolerance pipeline before yielding the terminal handoff.
- Core maps the validated `advance` result to `RunWorkResult.result`.
- The test observes validated handoff behavior through public APIs, not execution internals.
- A paired failure test proves malformed scratch-root output becomes a sanitized fail directive instead of a raw malformed result.
**Dependencies:** Stories 4, 5, and 6.
#### Task 7.2: Update the agent code map

**Description:** Update `context-agent/wiki/code-map.md` with the new tolerance pipeline, result contract registry/resolver, normalizer registry, correction requester seam, scratch-root-contained result-file reader, step-result schemas, explicit execution result-validation modes/resolvers, boundary event validator, boundary terminal handoff shape, synthesized validation-failure terminal behavior, and core handoff mapping.
**Acceptance criteria:**
- The code map points future agents to each new or significantly changed module.
- The entry explains that schema metadata lives in `api-contract`, contract resolution/result validation/result-file reads/boundary event validation live in `execution`, and orchestration result mapping lives in `core`.
- The entry documents that provider-specific correction behavior is unsupported in this round beyond `ResultCorrectionRequester` and scripted stub responses.
- The entry documents that validated result persistence on `RunStep` remains out of scope.
**Dependencies:** Stories 1 through 6.
#### Task 7.3: Run targeted and broad validation

**Description:** Run the focused tests for new contracts, pipeline behavior, result-file handling, execution boundary behavior, core mapping, and boundary rules, then run broad project validation when practical.
**Acceptance criteria:**
- `pnpm nx test api-contract -- step-results.spec.ts` passes.
- `pnpm nx test execution -- result-contracts.spec.ts` passes.
- `pnpm nx test execution -- result-tolerance.spec.ts` passes.
- `pnpm nx test execution -- result-normalizers.spec.ts` passes.
- `pnpm nx test execution -- result-file.spec.ts` passes.
- `pnpm nx test execution -- execution-boundary-events.spec.ts` passes.
- `pnpm nx test execution -- execution-entry-point.spec.ts` passes.
- `pnpm nx test execution -- stub-runner.spec.ts` passes.
- `pnpm nx test core -- execution-run-unit-of-work.spec.ts` passes.
- The integration test covering stub-runner dispatch through the boundary passes.
- `pnpm test:boundaries` passes.
- `pnpm validate` runs when practical.
- Any skipped validation is recorded with the exact reason.
**Dependencies:** Tasks 7.1 and 7.2.