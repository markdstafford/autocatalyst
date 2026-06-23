---
created: 2026-06-23
last_updated: 2026-06-23
status: implementing
issue: 100
specced_by: autocatalyst
---
# Feature: Structured agent step results

## Product requirements

### What

Autocatalyst should capture producing and reviewing agent step results as provider-enforced structured data instead of parsing the model's whole final prose message as JSON. For every agent step that has a declared step-result contract, the selected provider adapter should receive the expected schema, configure the backend to produce that schema, capture the parsed result object from the provider-specific structured-output mechanism, and write `step-result.json` from that object.
This is a feature because it adds a new execution-runtime capability: schema-aware result capture at the agent-provider boundary. The existing tolerance pipeline remains the execution boundary's defense-in-depth validator, but malformed final-message prose should stop being the normal way a successful agent run fails.
Initial coverage includes the producing and reviewing steps called out in issue 100:
- `spec.author` with `autocatalyst.spec_author.v1`.
- `implementation.build` implementer disposition results with `autocatalyst.implementer_dispositions.v1`.
- `implementation.build` reviewer verdicts with `autocatalyst.reviewer_result.v1`.
- `pr.finalize` with `autocatalyst.pr_finalize.v1`.
### Why

Today both agent adapters can complete useful work and still fail result packaging because they write unstructured final output into the scratch result file. Claude writes `pendingResult.output` from the SDK result event. OpenAI writes `terminal.output` from `finalOutput`. The execution entry point then reads `step-result.json` and runs `JSON.parse` before schema validation.
That path assumes the model's entire final message is the result JSON. The system does not enforce that assumption, and reasoning models often append a prose review summary or omit JSON when they believe the work is done. The observed failures are product failures, not quality failures: a correct reviewer verdict or authored spec can be trapped behind `result_json_invalid` because the final message was prose-wrapped or prose-only.
The run lifecycle depends on trusted step handoffs. Result capture should be structured where the provider supports it, then validated again at the execution boundary before downstream orchestration uses it.
### Goals

- Give agent adapters first-class access to the active step-result contract: step, schema id, schema, result file, and role-specific result-file name when applicable.
- Configure OpenAI agent sessions with structured output using the Agents SDK `outputType` or the nearest supported equivalent for the active contract.
- Configure Claude agent sessions with a result-submission tool such as `submit_result`, where the tool input schema is the active contract schema.
- Capture the typed provider output or submitted tool arguments as the step result object.
- Write `step-result.json` from the captured structured object, not from `finalOutput` or Claude result prose.
- Preserve the execution entry point's scratch-file validation, normalizers, correction loop, result contract metadata, and fail-safe terminal behavior.
- Let read-only reviewer sessions submit a structured verdict without granting write access to the repository workspace.
- Keep provider-specific details inside provider adapters and shared adapter/orchestrator seams, not in control-plane business logic.
- Preserve safe diagnostics: log schema id, step, role, result-capture mechanism, and failure codes, but not raw model output, full prompts, secrets, or unredacted scratch content.
- Prove that prose before or after a final response no longer causes `result_json_invalid` when the provider returns a structured result.
### Non-goals

- Replacing the step-result tolerance pipeline. It remains the boundary validator and fallback repair path.
- Changing the Zod schemas for `spec.author`, implementation reviewer verdicts, implementer dispositions, or `pr.finalize` unless a provider bridge requires a lossless schema projection helper.
- Adding new public API routes, UI screens, or human review gates.
- Changing workflow step ids, run transitions, or convergence semantics.
- Making direct-model calls use this agent-session mechanism; direct adapters already have separate structured validation paths.
- Implementing broad provider support beyond the current OpenAI agent adapter and Claude agent adapter.
- Persisting raw model transcripts or rejected result bodies for diagnostics.
- Creating branches, switching branches, creating worktrees, pushing, merging, or opening PRs.
### Personas

- **Enzo (Engineer)** needs agent result capture to use the same step contracts that execution validation already uses, so every provider adapter stops inventing its own final-message parsing rule.
- **Opal (Operator)** needs a correct agent run to advance when it produced a valid structured result, and needs failures to expose safe provider/contract diagnostics rather than opaque `result_json_invalid` failures.
- **Phoebe (Product owner)** needs planning, implementation review, and PR finalization runs to reach their human gates reliably when the model did the requested work.
- **A provider integrator** needs a clear adapter contract for mapping Autocatalyst schemas to each provider's structured-output feature.
### User stories

- As Enzo, I can start an agent step and know the adapter receives the exact result contract selected for that step and role.
- As Enzo, I can inspect adapter code and see OpenAI `outputType` or equivalent structured output configured from the selected schema.
- As Enzo, I can inspect Claude adapter code and see a `submit_result` tool whose input schema is the selected result schema.
- As Opal, I can run a reviewer model that adds prose to its final message and still receive the structured reviewer verdict captured by the provider mechanism.
- As Opal, I can run a read-only reviewer and still receive its verdict without allowing repository writes.
- As Phoebe, I can submit a feature request and not lose a valid `spec.author` result because the model also wrote an explanatory recap.
- As a provider integrator, I can see unsupported structured-output behavior reported as a safe capability failure rather than silently falling back to parsing prose.
### Acceptance criteria

- Agent sessions for `spec.author`, `implementation.build` implementer, `implementation.build` reviewer, and `pr.finalize` receive a structured result capture contract derived from the same selected step-result contract used by execution validation.
- OpenAI agent sessions configure the Agents SDK with `outputType` or the current SDK-supported equivalent for the active result schema.
- OpenAI adapter captures the parsed structured output object and writes that object to the configured scratch result file.
- OpenAI adapter no longer writes `runResult.finalOutput` or terminal prose verbatim to `step-result.json` when structured result capture is active.
- Claude agent sessions expose a result-submission tool, named consistently such as `submit_result`, with an input schema equivalent to the active step-result schema.
- Claude adapter captures the `submit_result` tool arguments and writes those arguments to the configured scratch result file.
- Claude adapter no longer writes the SDK result-event prose output verbatim to `step-result.json` when structured result capture is active.
- Read-only reviewer sessions can call the result-submission mechanism even when repository write tools are unavailable.
- If a provider session ends without a structured result for a contract-required step, the adapter fails safely with a typed provider protocol or capability error; it does not manufacture a result from prose.
- The execution entry point still reads the scratch result file, validates it with the selected schema, runs configured normalizers and correction where applicable, and attaches `resultContract` to successful terminal events.
- Regression tests prove that a prose final message plus a valid structured OpenAI result packages cleanly.
- Regression tests prove that a prose Claude final result plus a valid `submit_result` tool call packages cleanly.
- Regression tests prove that a read-only `implementation.build` reviewer can submit `{ "status": "satisfied", "findings": [] }` through the structured mechanism.
- Tests cover missing structured result, malformed structured result, wrong schema, and no-contract steps.
- Safe logs or metadata identify the result capture mechanism, schema id, step, and failure code without logging raw result bodies, prompts, secrets, or full filesystem paths.
### Non-functional requirements

- **Safety:** Downstream orchestration consumes only execution-boundary-validated results.
- **Security:** Structured result diagnostics must redact secrets and avoid storing raw model transcript text in ordinary logs.
- **Compatibility:** Existing no-contract or `mode: "none"` execution paths continue to work.
- **Provider isolation:** OpenAI- and Claude-specific structured-output code stays in their adapters or shared adapter contracts.
- **Determinism:** Tests use injected SDK seams and deterministic fixtures rather than live provider calls by default.
- **Workspace ownership:** Implementation stays on the current Autocatalyst-owned branch and does not perform git lifecycle actions outside the current branch.
### Devil's advocate pass

- **Structured output cannot be only a prompt instruction.** The feature must use provider mechanisms that return parsed output or schema-checked tool arguments. Otherwise the system still depends on a model choosing to end with raw JSON.
- **The boundary validator is still required.** Provider validation lowers the chance of malformed output, but execution must still validate the file before control-plane logic consumes it.
- **Provider schema support may be uneven.** The implementation must handle SDK limitations explicitly. If a schema cannot be expressed for a provider, fail with a safe unsupported-capability reason instead of silently reverting to prose parsing for contract-required steps.
- **Read-only review cannot mean no result channel.** The reviewer must remain unable to change repository files, but the structured result channel is control-plane machinery and must stay available.
- **Zod version mismatches are likely.** The OpenAI adapter depends on `zod` v4 while `@autocatalyst/api-contract` uses the repo's shared Zod schemas. The adapter needs a tested bridge rather than ad hoc casting if the SDK requires a different schema representation.
### Reviewer pass

This feature aligns with ADR-007, ADR-012, ADR-022, and ADR-027. It keeps the contract source in `@autocatalyst/api-contract`, keeps provider identity in adapters, and preserves execution-boundary validation. The main design risk is Claude Agent SDK custom-tool support: the spec requires a result-submission tool because issue 100 names that as the structured mechanism, but implementation must confirm how the SDK exposes local tools or MCP-style tools and report unsupported behavior directly if the installed SDK cannot enforce tool input schemas.
## Design spec

### Design scope

This is a backend execution-runtime and provider-adapter feature. It adds no visual UI. The human-visible change is fewer false run failures at producing and reviewing steps when the model did the work but wrote a prose final message.
The design covers the agent-session result channel, the adapter experience, safe operator diagnostics, and how the existing scratch-file validation remains in place.
### Service experience

A successful structured-result run should look like this:
1. The control plane dispatches a run step with its normal execution context.
2. The execution entry point resolves the active scratch-file result validation contract before starting the runner.
3. The runner passes a structured result capture contract to the agent orchestrator and provider adapter.
4. The provider adapter configures the backend's structured-output feature for the selected contract.
5. The agent performs the work and submits or returns a schema-shaped result object.
6. The adapter writes that structured object to the configured scratch result file.
7. The adapter may still emit assistant turns, tool activity, progress, and a terminal advance event.
8. The execution entry point reads the scratch file, runs the existing tolerance pipeline, and yields a terminal event with the validated `result` and `resultContract`.
The user's experience is unchanged except that valid runs are less likely to fail at result packaging.
### Result capture model

Structured result capture should be explicit in the runner input rather than inferred from prompt prose. A shared shape should describe:
- `step`: the workflow step that owns the contract.
- `schemaId`: the stable contract id.
- `schema`: the canonical Zod schema selected by execution validation.
- `resultFile`: the scratch-relative result file name to write.
- `required`: whether absence of a structured result is a provider protocol failure.
This neutral descriptor deliberately excludes provider-selected capture-mechanism metadata. Adapters derive the provider mechanism, such as `openai_output_type` or `claude_submit_result_tool`, from provider schema projection and use that projection metadata for logs and tests.
For no-contract steps, the field is absent and adapters keep their existing behavior or no-op result-file handling. For contract-required steps, adapters must not fall back to final-message parsing unless the execution configuration explicitly marks such fallback as allowed. This feature does not add that fallback allowance.
### OpenAI design

The OpenAI agent adapter should configure the `SandboxAgent` with the active result schema through `outputType` or the SDK's current structured-output option. The adapter should treat the SDK's parsed final output as the source of truth for the scratch result file.
The OpenAI flow should be:
1. Build the normal progress tools.
2. Build or project the active result schema into the shape accepted by `@openai/agents`.
3. Create `SandboxAgent` with `outputType` when structured capture is active.
4. Run the session as before.
5. Read the parsed structured final output from the SDK result object.
6. Write the parsed object as JSON to `resultFile` inside scratch.
7. Ignore `finalOutput` prose for result-file writing.
If the SDK returns both a parsed object and a prose final message, the parsed object wins. If the SDK returns no parsed object for a contract-required step, the adapter should throw a safe provider protocol error such as `missing_structured_result`.
### Claude design

The Claude agent adapter should expose a result-submission tool, for example `submit_result`, whose input schema is equivalent to the active result schema. The agent uses normal filesystem and review tools for the task, then calls `submit_result({...})` once with the step result.
The Claude flow should be:
1. Map the normal allowed tool policy for repository work or read-only review.
2. Add the result-submission tool to the session even when the workspace is read-only.
3. Describe in the prompt or session options that the step advances only after calling `submit_result`.
4. Capture the first valid `submit_result` tool arguments as the pending structured result.
5. Treat duplicate submissions as a provider protocol error unless the SDK guarantees a single final tool call.
6. Write the captured arguments as JSON to `resultFile` inside scratch after the stream ends.
7. Ignore the SDK result-event prose for result-file writing.
If Claude Agent SDK cannot register local tools with enforced input schemas in the installed version, the implementation should surface an unsupported provider capability for contract-required structured capture. It should not silently revert to whole-final-message parsing for the covered steps.
### Read-only reviewer design

Read-only review means the agent cannot modify repository files. It must not prevent the adapter-owned result channel.
For OpenAI, `outputType` is not a repository write and should work with read-only sandbox grants. For Claude, `submit_result` should be outside the repository tool allowlist or added as an adapter-owned tool that remains available alongside read-only tools such as `Read`, `Glob`, and `Grep`. The tool should not grant write access to the repo or scratch beyond the adapter's own controlled write of the validated arguments.
### Failure and fallback design

Structured capture should make failures more precise:
- `structured_result_unsupported` when the provider cannot express the active schema.
- `missing_structured_result` when a contract-required session ends without typed output or a result tool call.
- `duplicate_structured_result` when the provider reports more than one result submission and the adapter cannot choose safely.
- `structured_result_invalid` when provider output cannot be serialized or fails a pre-write schema parse.
- Existing execution-boundary errors such as `result_file_missing`, `result_json_invalid`, and `schema_validation_failed` remain possible as defense-in-depth failures.
The optional tolerance-pipeline fallback from issues 83 and 86 can still extract JSON from prose-wrapped output after scratch-file read. It is not the primary path for the covered agent steps.
### Diagnostics design

Safe diagnostics should help operators understand which path ran without exposing sensitive text. Adapter logs and test metadata may include:
- run id;
- step;
- role when available;
- provider kind;
- adapter id;
- schema id;
- result file name;
- result capture mechanism;
- success or failure code.
Diagnostics must not include raw prompts, full final messages, raw result JSON bodies, secret values, authorization headers, or absolute host paths. If a rejected result excerpt is added later for issue 99-style diagnosability, it must be redacted, length-bounded, and explicitly safe.
### Reviewer pass

The design keeps structured result capture close to provider behavior while retaining the current scratch-file contract for the execution boundary. It deliberately does not make control-plane code understand provider-specific result mechanics. The strongest remaining uncertainty is Claude tool registration; that uncertainty is isolated as a provider capability risk rather than hidden behind final-output parsing.
## Tech spec

### Current state

Relevant current code paths:
- `packages/execution/src/result-contracts.ts` registers result contracts for `spec.author`, `implementation.build` reviewer results, `implementation.build` implementer dispositions, and `pr.finalize`.
- `packages/execution/src/execution-entry-point.ts` resolves scratch-file validation config after the runner stream completes, reads the configured result file, validates it through `validateStepResult`, and attaches `resultContract` to a successful terminal event.
- `packages/execution/src/result-file.ts` reads JSON from scratch and still returns `result_json_invalid` when the whole file is not valid JSON.
- `packages/core/src/spec-authoring-context.ts` and `packages/core/src/implementation-build-context.ts` already put output-contract facts in task inputs and prompts, but those facts are prompt/task guidance, not an adapter-enforced result channel.
- `packages/openai-agent-adapter/src/openai-agent-adapter.ts` creates `SandboxAgent` without `outputType`, then writes `terminal.output` from `runResult.finalOutput` to scratch.
- `packages/claude-agent-adapter/src/claude-agent-adapter.ts` captures Claude SDK result-event `output` as `pendingResult.output`, then writes that string to scratch.
- The OpenAI adapter has local progress tools. The Claude adapter maps tool-use events but currently does not show an equivalent local custom tool registration seam in the inspected code.
### Architecture

Resolve structured result capture before the runner starts. The execution entry point already has the result validation configuration; it should resolve the active contract early, then pass a provider-neutral structured result capture descriptor into `RunnerRunInput`.
Suggested types:
```typescript
export interface StructuredAgentResultCapture {
  readonly step: string;
  readonly schemaId: string;
  readonly schema: z.ZodTypeAny;
  readonly resultFile: string;
  readonly required: true;
}

export interface RunnerRunInput {
  readonly environment: MaterializedExecutionEnvironment;
  readonly correlationId?: string;
  readonly structuredResultCapture?: StructuredAgentResultCapture;
}
```
The exact names can follow project conventions. The important boundary is that the descriptor is resolved from the same contract source as post-run validation. This prevents prompt/task-input drift and keeps adapter behavior tied to the canonical contract registry.
The execution entry point should still perform post-run validation from the scratch file. To avoid resolving contracts twice with divergent answers, the entry point can keep the resolved contract in local state and reuse it when building the terminal boundary event.
### Execution entry point changes

Update `createExecutionEntryPoint` so scratch-file validation config is resolved before `options.runner.run(runnerInput)` when `mode: "scratch_file"`. If the config resolves to a contract with a non-empty `resultFile`, attach `structuredResultCapture` to `runnerInput`.
Important behavior:
- For `mode: "none"`, no structured capture is attached.
- For non-advance terminal directives, post-run scratch validation remains skipped as it is today.
- If contract resolution fails before runner start, fail safely using the existing missing/unknown contract behavior rather than starting a provider session that cannot submit a result.
- If a contract exists but has no `resultFile`, preserve the existing `result_file_missing` behavior.
- Include result-capture metadata in safe logs or telemetry if a logger seam already exists.
### Agent orchestrator changes

`packages/execution/src/agent-orchestrator-runner.ts` should pass `RunnerRunInput.structuredResultCapture` through to the provider adapter as part of `AgentProviderSessionInput`. This keeps provider adapters from reaching into execution-entry-point internals.
Suggested addition:
```typescript
export interface AgentProviderSessionInput {
  readonly runInput: RunnerRunInput;
  readonly profile: ResolvedAgentRunnerProfile;
  readonly connection: AgentConnection;
  readonly telemetryContext: AgentConnectionTelemetryContext;
  readonly structuredResultCapture?: StructuredAgentResultCapture;
}
```
The orchestrator can either pass it directly as `structuredResultCapture: input.structuredResultCapture` or let adapters read `input.runInput.structuredResultCapture`. A dedicated top-level field is easier to test and document.
### Shared schema projection

Provider SDKs may not accept the repository's Zod v3 schemas directly. Add a small adapter-facing helper if needed:
- Input: `schemaId` and `z.ZodTypeAny` from `@autocatalyst/api-contract`.
- Output for OpenAI: the schema representation accepted by `@openai/agents` `outputType`.
- Output for Claude: a JSON Schema-like tool input schema accepted by the Claude Agent SDK or its local-tool/MCP mechanism.
If a schema cannot be projected without weakening required fields, strictness, discriminated unions, or provider-enforceable refinements, return a typed unsupported-capability failure. Do not drop strictness silently.
Some canonical Zod refinements, especially `superRefine` cross-field invariants, are not expected to be enforceable by every provider schema mechanism. Projection should preserve the object shape and provider-enforceable constraints needed to capture the result, while execution-boundary validation remains authoritative for boundary-only refinements. Covered contracts such as `spec.author` and `pr.finalize` must not be rejected merely because their cross-field invariants are enforced after capture instead of by the provider.
### OpenAI adapter changes

Update the OpenAI run session seam so tests can assert the agent is created with structured output:
- Extend `OpenAIRunSessionInput` with `structuredResultCapture`.
- When present, pass the projected schema to `new SandboxAgent({ ..., outputType })` or the supported SDK equivalent.
- Extend the non-stream run result view to expose the parsed structured output field returned by the SDK.
- Resolve the terminal result with `structuredOutput` or similar, not only `output`.
- Write the structured object to scratch with `maybeWriteResultFile` using JSON serialization.
- Keep final prose available only as an assistant turn or ignored terminal text; it must not be the result-file source for structured sessions.
Testing should use the existing injected `runAgentSession` seam and fake SDK result objects. Tests should not require a live OpenAI call.
### Claude adapter changes

Add a result-submission tool path to the Claude adapter:
- Define a constant result tool name such as `submit_result`.
- Project the active schema into the tool input schema.
- Register the tool with the Claude Agent SDK session if supported by the installed SDK.
- Ensure `allowedTools` includes the result tool even for read-only reviewer sessions.
- Update `mapNativeEvent` or adjacent stream handling so `tool_use` events for `submit_result` capture `tool.input` as the pending structured result instead of emitting ordinary tool activity.
- Reject duplicate result tool calls unless the SDK gives a clear final-call signal.
- Write the captured structured input object to scratch after the stream ends.
- Do not use `result.output` as the result-file source for structured sessions.
If the SDK only reports tool calls but cannot register local tools with schemas, implementation should add a provider capability check and fail structured capture for Claude until a supported registration mechanism exists.
### Result file writing

The current `maybeWriteResultFile` helpers should accept `unknown` structured data in addition to strings, or a new helper should be added. The helper should:
- resolve the result path inside scratch using the existing containment-safe path utilities;
- serialize structured values with `JSON.stringify(value, null, 2)`;
- write only objects that pass the provider-side schema parse when a schema is available;
- preserve existing safe failure behavior for missing scratch roots and path escapes.
String writes may remain for no-contract legacy sessions, but contract-required structured sessions should write object values.
### Contract-specific behavior

- `spec.author`: output object must match `specAuthorResultSchema` after system-stamped frontmatter preprocessing during boundary validation. Provider-side schema projection may use the raw schema or a projection that still requires `kind`, `slug`, `relativePath`, `frontmatter`, and `body`.
- `implementation.build` reviewer: read-only session captures `reviewerResultSchema`; the result file should be the role/round-specific reviewer file selected by implementation build context, not a shared default if a role-specific file is configured.
- `implementation.build` implementer: captures `implementerDispositionsResultSchema`; `{}` remains valid when there are no dispositions.
- `pr.finalize`: captures `prFinalizeResultSchema`; contradictory `advance` with blocker findings should still fail validation or correction through existing schema refinement.
### Test plan

Add focused unit tests before broad integration tests:
- OpenAI adapter passes `outputType` or equivalent when `structuredResultCapture` is present.
- OpenAI adapter writes parsed structured output to scratch and ignores prose `finalOutput` for result-file writing.
- OpenAI adapter fails safely when structured capture is required but the SDK returns no parsed object.
- Claude adapter registers or requests the `submit_result` tool when `structuredResultCapture` is present.
- Claude adapter captures `submit_result` input and ignores result-event prose for result-file writing.
- Claude adapter keeps `submit_result` available for read-only reviewer sessions.
- Claude adapter fails safely on missing or duplicate structured result submissions.
- Execution entry point passes the resolved contract to the runner before stream execution and still validates the scratch file after terminal advance.
- End-to-end or integration-level tests cover a reasoning-style `spec.author` and an `implementation.build` reviewer where prose appears in final output but structured result capture succeeds.
- Existing tests for scratch-root containment, contract resolution, result normalizers, and boundary validation continue to pass.
### Observability and diagnostics

Extend existing safe adapter logs where practical:
- `structuredResultCapture: true` or equivalent.
- `schemaId`.
- `resultFile` basename or scratch-relative path.
- provider projection mechanism, such as `projection.mechanism`.
- Failure code for unsupported, missing, duplicate, or invalid structured result.
Do not log raw structured result bodies by default. If a future diagnostic snippet is added, it must be redacted and length-bounded.
### Compatibility and migration

This feature can be added without a data migration. It changes runtime behavior for future agent sessions only.
No-contract steps and direct-provider calls keep their existing paths. Contract-required producing and reviewing agent steps should move to structured capture in one change so a provider cannot pass tests by using structured output for one step but prose parsing for another covered step.
### Open risks

- Claude Agent SDK custom tool registration and input-schema enforcement must be verified against the installed peer version. If unsupported, Claude structured result capture should fail with a safe unsupported-capability error until the adapter has a supported tool bridge.
- OpenAI Agents SDK `outputType` may require Zod v4 or another schema representation. The implementation must bridge schemas intentionally and prove strict/discriminated shapes are preserved.
- Some Zod refinements may not be expressible in provider JSON schema. Boundary validation remains authoritative for those refinements, and projection support should fail only when the provider shape would silently weaken required fields, strictness, discriminated unions, or refinements the projection claims to enforce.
## Converged API

### Files

Path
Purpose
Exports

`packages/execution/src/structured-result-capture.ts`
Defines the provider-neutral structured agent result capture descriptor, capture mechanisms used by adapter projections, non-throwing capture resolution outcomes, and helpers for deriving adapter capture input from resolved step-result contracts.
`StructuredAgentResultCapture`, `StructuredAgentResultCaptureMechanism`, `CreateStructuredAgentResultCaptureInput`, `StructuredAgentResultCaptureResolution`, `StructuredAgentResultCaptureResolutionSuccess`, `StructuredAgentResultCaptureResolutionSkipped`, `StructuredAgentResultCaptureResolutionFailure`, `createStructuredAgentResultCapture`, `assertSerializableStructuredResult`

`packages/execution/src/runner.ts`
Extends runner input so execution can pass the active structured result contract to agent runners before the provider session starts.
`RunnerRunInput`

`packages/execution/src/agent-provider-adapter.ts`
Extends the agent provider adapter session contract with structured result capture metadata and typed provider failure codes for unsupported, missing, duplicate, or invalid structured results.
`AgentProviderSessionInput`, `ProviderProtocolErrorCode`, `UnsupportedProviderCapabilityErrorCode`, `ProviderProtocolError`, `UnsupportedProviderCapabilityError`

`packages/execution/src/agent-orchestrator-runner.ts`
Passes RunnerRunInput.structuredResultCapture through to AgentProviderSessionInput so adapters do not reach into execution-entry-point internals.
`createAgentOrchestratorRunner`

`packages/execution/src/execution-entry-point.ts`
Resolves scratch-file result validation once before runner execution, converts pre-run contract/capture failures into existing fail-terminal boundary events, attaches structured result capture for contract-required scratch results, then reuses the cached validation resolution for post-run scratch-file validation and resultContract attachment.
`createExecutionEntryPoint`, `ExecutionResultValidationConfig`, `ScratchFileExecutionResultValidationConfig`

`packages/execution/src/result-file.ts`
Adds a containment-safe writer for structured JSON results in scratch, including optional schema validation before write, while preserving existing scratch-file read validation.
`WriteScratchStepResultFileInput`, `StepResultFileWriteErrorCode`, `StepResultFileWriteOutcome`, `StepResultFileWriteSuccess`, `StepResultFileWriteFailure`, `writeScratchStepResultFile`, `readScratchStepResultFile`, `resolveScratchRootCandidatePath`

`packages/execution/src/provider-schema-projection.ts`
Provides adapter-facing schema projection helpers from canonical Zod contracts to provider-ready structured-output or tool-input schema representations, failing safely when a schema cannot be projected losslessly. Provider-selected result-capture mechanism metadata is surfaced on the projection, not on the neutral capture descriptor. Projection unsupported errors are UnsupportedProviderCapabilityError subclasses so adapter-boundary capability handling remains consistent.
`ProviderSchemaProjectionTarget`, `ProviderStructuredOutputSchema`, `ProviderSchemaProjection`, `ProviderSchemaProjectionError`, `projectStepResultSchemaForProvider`

`packages/openai-agent-adapter/src/openai-agent-adapter.ts`
Extends the OpenAI agent run seam with an explicit structured result configuration derived from provider schema projection and writes the SDK parsed finalOutput object to the scratch result file instead of final prose when capture is active. The adapter constructs this configuration through createOpenAIStructuredResultConfiguration so the SDK outputType always comes from projection.schema.
`OpenAIStructuredResultConfiguration`, `createOpenAIStructuredResultConfiguration`, `OpenAIRunSessionInput`, `OpenAIRunOutcome`, `OpenAIRunAgentSession`, `createOpenAIAgentAdapter`

`packages/claude-agent-adapter/src/claude-agent-adapter.ts`
Adds a Claude submit_result tool channel for structured step results, keeps it available for read-only reviewer sessions, captures tool arguments, and writes those arguments to the scratch result file instead of result-event prose.
`CLAUDE_STRUCTURED_RESULT_TOOL_NAME`, `ClaudeStructuredResultToolDefinition`, `ClaudeNativeEvent`, `ClaudeSessionLaunchOptions`, `ClaudeSessionLaunch`, `createClaudeAgentAdapter`

### Public API

#### `StructuredAgentResultCapture`

```typescript
export interface StructuredAgentResultCapture { readonly step: string; readonly schemaId: string; readonly schema: z.ZodTypeAny; readonly resultFile: string; readonly required: true; }
```
- Returns: `StructuredAgentResultCapture`
#### `StructuredAgentResultCaptureMechanism`

```typescript
export type StructuredAgentResultCaptureMechanism = 'openai_output_type' | 'claude_submit_result_tool';
```
- Returns: `StructuredAgentResultCaptureMechanism`
#### `createStructuredAgentResultCapture`

```typescript
export function createStructuredAgentResultCapture(input: CreateStructuredAgentResultCaptureInput): StructuredAgentResultCaptureResolution
```
- Parameters:
	- `input: CreateStructuredAgentResultCaptureInput` — Resolved scratch-file validation contract used to build the adapter-facing structured result descriptor. Returns a discriminated skipped outcome for mode none or other no-contract execution paths and a discriminated failure outcome for pre-run contract issues such as a missing result file. It does not require provider identity and does not populate provider mechanism metadata.
- Returns: `StructuredAgentResultCaptureResolution`
#### `assertSerializableStructuredResult`

```typescript
export function assertSerializableStructuredResult(value: unknown): void
```
- Parameters:
	- `value: unknown` — Provider-captured structured result object to check before scratch-file serialization. Required adapter call sequence is: first call assertSerializableStructuredResult(value) to reject non-JSON-safe values with ProviderProtocolError, then call writeScratchStepResultFile(\{ ..., value, schema: capture.schema \}) to enforce schema conformance and perform the contained write.
- Returns: `void`
- Errors:
	- `ProviderProtocolError with code structured_result_invalid when value cannot be safely serialized to JSON`
#### `RunnerRunInput`

```typescript
export interface RunnerRunInput { readonly environment: MaterializedExecutionEnvironment; readonly correlationId?: string; readonly structuredResultCapture?: StructuredAgentResultCapture; }
```
- Returns: `RunnerRunInput`
#### `AgentProviderSessionInput`

```typescript
export interface AgentProviderSessionInput { readonly runInput: RunnerRunInput; readonly profile: ResolvedAgentRunnerProfile; readonly connection: AgentConnection; readonly telemetryContext: AgentConnectionTelemetryContext; readonly structuredResultCapture?: StructuredAgentResultCapture; }
```
- Returns: `AgentProviderSessionInput`
#### `ProviderProtocolErrorCode`

```typescript
export type ProviderProtocolErrorCode = 'event_mapping_failed' | 'invalid_provider_event' | 'impossible_session_sequence' | 'missing_structured_result' | 'duplicate_structured_result' | 'structured_result_invalid';
```
- Returns: `ProviderProtocolErrorCode`
#### `UnsupportedProviderCapabilityErrorCode`

```typescript
export type UnsupportedProviderCapabilityErrorCode = 'inference_setting_unsupported' | 'tool_policy_unsupported' | 'skill_unsupported' | 'header_operation_unsupported' | 'sandbox_client_unsupported' | 'sandbox_snapshot_unsupported' | 'workspace_containment_violation' | 'structured_result_unsupported';
```
- Returns: `UnsupportedProviderCapabilityErrorCode`
#### `writeScratchStepResultFile`

```typescript
export function writeScratchStepResultFile(input: WriteScratchStepResultFileInput): Promise
```
- Parameters:
	- `input: WriteScratchStepResultFileInput` — Materialized environment, scratch-relative result file path, structured JSON value, and optional Zod schema to validate before writing inside the scratch root. Adapter protocol is to call assertSerializableStructuredResult(value) first, then call this helper with schema: capture.schema; schema mismatches are returned as result_schema_invalid and serialization/write failures are returned as write-specific StepResultFileWriteFailure codes.
- Returns: `Promise`
#### `projectStepResultSchemaForProvider`

```typescript
export function projectStepResultSchemaForProvider(input: { readonly schemaId: string; readonly schema: z.ZodTypeAny; readonly target: ProviderSchemaProjectionTarget; }): ProviderSchemaProjection
```
- Parameters:
	- `input.schemaId: string` — Stable Autocatalyst result contract id used for diagnostics and projection decisions.
	- `input.schema: z.ZodTypeAny` — Canonical step-result schema selected by execution validation.
	- `input.target: ProviderSchemaProjectionTarget` — Provider schema target such as OpenAI Agents outputType or Claude tool input schema.
- Returns: `ProviderSchemaProjection`
- Errors:
- `ProviderSchemaProjectionError when the Zod schema cannot be projected without silently weakening required fields, strictness, discriminated unions, or provider-enforceable refinements. Boundary-only Zod refinements such as cross-field `superRefine` invariants may remain enforced by the execution-boundary parse instead of the provider projection. ProviderSchemaProjectionError extends UnsupportedProviderCapabilityError with code structured_result_unsupported, so adapter-boundary instanceof UnsupportedProviderCapabilityError checks also catch projection failures.`
#### `OpenAIStructuredResultConfiguration`

```typescript
export interface OpenAIStructuredResultConfiguration { readonly capture: StructuredAgentResultCapture; readonly projection: ProviderSchemaProjection & { readonly target: 'openai_agents_output_type'; readonly mechanism: 'openai_output_type'; }; }
```
- Returns: `OpenAIStructuredResultConfiguration`
#### `createOpenAIStructuredResultConfiguration`

```typescript
export function createOpenAIStructuredResultConfiguration(capture: StructuredAgentResultCapture): OpenAIStructuredResultConfiguration
```
- Parameters:
	- `capture: StructuredAgentResultCapture` — Provider-neutral capture descriptor. The factory projects capture.schema with target openai_agents_output_type and returns a configuration whose projection.schema is the only value the OpenAI adapter may pass as the SDK outputType.
- Returns: `OpenAIStructuredResultConfiguration`
- Errors:
	- `ProviderSchemaProjectionError, an UnsupportedProviderCapabilityError subclass with code structured_result_unsupported, when the active schema cannot be bridged losslessly to the OpenAI Agents SDK outputType representation`
#### `OpenAIRunSessionInput`

```typescript
export interface OpenAIRunSessionInput { readonly prompt: string; readonly model: string; readonly instructions: string; readonly tools: ReturnType[]; readonly manifest: Manifest; readonly session: OpenAISandboxSession; readonly modelProvider: OpenAIProvider; readonly modelSettings: Readonly>; readonly structuredResult?: OpenAIStructuredResultConfiguration; }
```
- Returns: `OpenAIRunSessionInput`
#### `OpenAIRunOutcome`

```typescript
export interface OpenAIRunOutcome { readonly items: AsyncIterable | Iterable; readonly result: Promise; }
```
- Returns: `OpenAIRunOutcome`
#### `createOpenAIAgentAdapter`

```typescript
export function createOpenAIAgentAdapter(options?: OpenAIAgentAdapterOptions): AgentProviderAdapter
```
- Parameters:
	- `options: OpenAIAgentAdapterOptions | undefined` — Adapter options including injectable SDK run seam; structured capture is supplied per session through AgentProviderSessionInput and projected inside the adapter by createOpenAIStructuredResultConfiguration before the run seam is called. The SDK outputType must be structuredResult.projection.schema, never structuredResult.capture.schema.
- Returns: `AgentProviderAdapter`
- Errors:
	- `UnsupportedProviderCapabilityError with code structured_result_unsupported when the active result schema cannot be configured as OpenAI structured output; projection failures surface as ProviderSchemaProjectionError, which extends UnsupportedProviderCapabilityError, unless the adapter chooses to wrap with the base capability class while preserving the same code and safe metadata`
	- `ProviderProtocolError with code missing_structured_result when a contract-required session advances without parsed finalOutput from the configured OpenAI structured-output run`
	- `ProviderProtocolError with code structured_result_invalid when finalOutput cannot be serialized by assertSerializableStructuredResult or fails the pre-write schema parse performed by writeScratchStepResultFile`
#### `CLAUDE_STRUCTURED_RESULT_TOOL_NAME`

```typescript
export const CLAUDE_STRUCTURED_RESULT_TOOL_NAME = 'submit_result' as const;
```
- Returns: `'submit_result'`
#### `ClaudeStructuredResultToolDefinition`

```typescript
export interface ClaudeStructuredResultToolDefinition { readonly name: typeof CLAUDE_STRUCTURED_RESULT_TOOL_NAME; readonly description: string; readonly inputSchema: ProviderStructuredOutputSchema; readonly projection: ProviderSchemaProjection & { readonly target: 'claude_tool_input_schema'; readonly mechanism: 'claude_submit_result_tool'; }; }
```
- Returns: `ClaudeStructuredResultToolDefinition`
#### `ClaudeSessionLaunchOptions`

```typescript
export interface ClaudeSessionLaunchOptions { readonly prompt: string; readonly cwd?: string; readonly env?: Record; readonly allowedTools?: string[]; readonly options?: Record; readonly structuredResultTool?: ClaudeStructuredResultToolDefinition; }
```
- Returns: `ClaudeSessionLaunchOptions`
#### `createClaudeAgentAdapter`

```typescript
export function createClaudeAgentAdapter(options?: ClaudeAgentAdapterOptions): AgentProviderAdapter
```
- Parameters:
	- `options: ClaudeAgentAdapterOptions | undefined` — Adapter options including injectable Claude session launch seam; structured capture is supplied per session through AgentProviderSessionInput and projected inside the adapter before registering the submit_result tool.
- Returns: `AgentProviderAdapter`
- Errors:
	- `UnsupportedProviderCapabilityError with code structured_result_unsupported when the installed Claude SDK cannot register an enforced submit_result tool for the active schema; schema projection failures surface as ProviderSchemaProjectionError, which extends UnsupportedProviderCapabilityError, unless the adapter chooses to wrap with the base capability class while preserving the same code and safe metadata`
	- `ProviderProtocolError with code missing_structured_result when a contract-required session advances without a submit_result tool call`
	- `ProviderProtocolError with code duplicate_structured_result when more than one submit_result call is observed and no safe final-call signal exists`
	- `ProviderProtocolError with code structured_result_invalid when submitted arguments cannot be serialized by assertSerializableStructuredResult or fail the pre-write schema parse performed by writeScratchStepResultFile`
### Types

#### `StructuredAgentResultCapture`

```typescript
interface StructuredAgentResultCapture { readonly step: string; readonly schemaId: string; readonly schema: z.ZodTypeAny; readonly resultFile: string; readonly required: true; }
```
#### `StructuredAgentResultCaptureMechanism`

```typescript
type StructuredAgentResultCaptureMechanism = 'openai_output_type' | 'claude_submit_result_tool';
```
#### `CreateStructuredAgentResultCaptureInput`

```typescript
interface CreateStructuredAgentResultCaptureInput { readonly mode: 'none' | 'scratch_file'; readonly step?: string; readonly contract?: StepResultContractDefinition; }
```
#### `StructuredAgentResultCaptureResolution`

```typescript
type StructuredAgentResultCaptureResolution = StructuredAgentResultCaptureResolutionSuccess | StructuredAgentResultCaptureResolutionSkipped | StructuredAgentResultCaptureResolutionFailure;
```
#### `StructuredAgentResultCaptureResolutionSuccess`

```typescript
interface StructuredAgentResultCaptureResolutionSuccess { readonly status: 'capture'; readonly capture: StructuredAgentResultCapture; }
```
#### `StructuredAgentResultCaptureResolutionSkipped`

```typescript
interface StructuredAgentResultCaptureResolutionSkipped { readonly status: 'skipped'; readonly reason: 'mode_none' | 'no_contract'; }
```
#### `StructuredAgentResultCaptureResolutionFailure`

```typescript
interface StructuredAgentResultCaptureResolutionFailure { readonly status: 'failed'; readonly code: 'result_file_missing' | 'step_result_contract_unknown'; readonly safeMessage: string; readonly issues?: readonly ResultValidationIssue[]; }
```
#### `RunnerRunInput`

```typescript
interface RunnerRunInput { readonly environment: MaterializedExecutionEnvironment; readonly correlationId?: string; readonly structuredResultCapture?: StructuredAgentResultCapture; }
```
#### `AgentProviderSessionInput`

```typescript
interface AgentProviderSessionInput { readonly runInput: RunnerRunInput; readonly profile: ResolvedAgentRunnerProfile; readonly connection: AgentConnection; readonly telemetryContext: AgentConnectionTelemetryContext; readonly structuredResultCapture?: StructuredAgentResultCapture; }
```
#### `WriteScratchStepResultFileInput`

```typescript
interface WriteScratchStepResultFileInput { readonly environment: MaterializedExecutionEnvironment; readonly resultFile: string; readonly value: unknown; readonly schema?: z.ZodTypeAny; }
```
#### `StepResultFileWriteErrorCode`

```typescript
type StepResultFileWriteErrorCode = 'result_path_outside_scratch_root' | 'result_write_failed' | 'result_json_invalid' | 'result_schema_invalid';
```
#### `StepResultFileWriteOutcome`

```typescript
type StepResultFileWriteOutcome = StepResultFileWriteSuccess | StepResultFileWriteFailure;
```
#### `StepResultFileWriteSuccess`

```typescript
interface StepResultFileWriteSuccess { readonly status: 'written'; readonly relativePath: string; }
```
#### `StepResultFileWriteFailure`

```typescript
interface StepResultFileWriteFailure { readonly status: 'failed'; readonly code: StepResultFileWriteErrorCode; readonly safeMessage: string; readonly issues: readonly ResultValidationIssue[]; }
```
#### `ProviderSchemaProjectionTarget`

```typescript
type ProviderSchemaProjectionTarget = 'openai_agents_output_type' | 'claude_tool_input_schema';
```
#### `ProviderStructuredOutputSchema`

```typescript
type ProviderStructuredOutputSchema = unknown;
```
#### `ProviderSchemaProjection`

```typescript
interface ProviderSchemaProjection { readonly schemaId: string; readonly target: ProviderSchemaProjectionTarget; readonly schema: ProviderStructuredOutputSchema; readonly mechanism: StructuredAgentResultCaptureMechanism; }
```
#### `ProviderSchemaProjectionError`

```typescript
class ProviderSchemaProjectionError extends UnsupportedProviderCapabilityError { readonly code: 'structured_result_unsupported'; readonly schemaId: string; readonly target: ProviderSchemaProjectionTarget; readonly safeDetails?: unknown; }
```
#### `OpenAIStructuredResultConfiguration`

```typescript
interface OpenAIStructuredResultConfiguration { readonly capture: StructuredAgentResultCapture; readonly projection: ProviderSchemaProjection & { readonly target: 'openai_agents_output_type'; readonly mechanism: 'openai_output_type'; }; }
```
#### `OpenAIRunSessionInput`

```typescript
interface OpenAIRunSessionInput { readonly prompt: string; readonly model: string; readonly instructions: string; readonly tools: ReturnType[]; readonly manifest: Manifest; readonly session: OpenAISandboxSession; readonly modelProvider: OpenAIProvider; readonly modelSettings: Readonly>; readonly structuredResult?: OpenAIStructuredResultConfiguration; }
```
#### `OpenAIRunOutcome`

```typescript
interface OpenAIRunOutcome { readonly items: AsyncIterable | Iterable; readonly result: Promise; }
```
#### `ClaudeStructuredResultToolDefinition`

```typescript
interface ClaudeStructuredResultToolDefinition { readonly name: typeof CLAUDE_STRUCTURED_RESULT_TOOL_NAME; readonly description: string; readonly inputSchema: ProviderStructuredOutputSchema; readonly projection: ProviderSchemaProjection & { readonly target: 'claude_tool_input_schema'; readonly mechanism: 'claude_submit_result_tool'; }; }
```
#### `ClaudeSessionLaunchOptions`

```typescript
interface ClaudeSessionLaunchOptions { readonly prompt: string; readonly cwd?: string; readonly env?: Record; readonly allowedTools?: string[]; readonly options?: Record; readonly structuredResultTool?: ClaudeStructuredResultToolDefinition; }
```
#### `ClaudeNativeEvent`

```typescript
interface ClaudeNativeEvent { readonly type: 'assistant' | 'tool_use' | 'tool_result' | 'result' | 'system' | string; readonly content?: string; readonly tool?: { readonly name: string; readonly input?: unknown }; readonly result?: { readonly type?: string; readonly output?: string; readonly is_error?: boolean; readonly total_tokens?: number; readonly input_tokens?: number; readonly output_tokens?: number }; readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number }; readonly [key: string]: unknown; }
```
### Notes

The artifact proposes backend TypeScript API/seam changes only. It intentionally adds no public HTTP routes or UI APIs. Provider-specific structured-output mechanics remain in provider adapters, while execution keeps the scratch-file validation boundary authoritative. The neutral StructuredAgentResultCapture no longer contains provider mechanism metadata; adapters log the result-capture mechanism from ProviderSchemaProjection.mechanism after projection. createStructuredAgentResultCapture is non-throwing so pre-run failures can become existing fail-terminal boundary events. The execution entry point resolves validation once per execute() invocation and reuses that cached resolution for post-run validation to avoid divergent resolver results. OpenAI structured sessions use the SDK finalOutput seam as output; when structured capture is active that output must be the parsed object returned by outputType/projection.schema. Claude support remains explicitly unsupported with structured_result_unsupported if the installed SDK cannot register an enforced submit_result tool. Projection failures are modeled as ProviderSchemaProjectionError extending UnsupportedProviderCapabilityError, preserving the documented adapter capability error surface and instanceof behavior. OpenAI structured configuration is built through createOpenAIStructuredResultConfiguration; projection.schema, not capture.schema, is the SDK outputType, while capture.schema remains for validation and diagnostics. Adapter structured-result write protocol is explicit: run assertSerializableStructuredResult first, then writeScratchStepResultFile with the capture schema and map any invalid write outcome to structured_result_invalid.
## Task list

### Story 1: Add the shared structured-result capture foundation

Create the provider-neutral contracts, provider error codes, and scratch-file writer that every adapter uses for structured agent step results.
#### T-001: Define structured-result capture types and resolution helper

**Description:** Add `packages/execution/src/structured-result-capture.ts` with the agreed capture descriptor, mechanism type, resolution outcomes, `createStructuredAgentResultCapture`, and `assertSerializableStructuredResult`. The helper should derive capture input from the same resolved step-result contract used by execution validation.
**Acceptance criteria:**
- `StructuredAgentResultCapture` and related resolution types match the `## Converged API` section.
- `createStructuredAgentResultCapture` returns `capture`, `skipped`, or `failed` outcomes without throwing for normal contract-resolution failures.
- `mode: "none"` and no-contract paths return skipped outcomes.
- Missing result files and unknown contracts return safe failure outcomes with existing result-validation issue shapes where applicable.
- `assertSerializableStructuredResult` rejects non-JSON-safe values with `ProviderProtocolError` code `structured_result_invalid`.
**Dependencies:** none.
#### T-002: Extend runner and provider adapter contracts

**Description:** Update `packages/execution/src/runner.ts` and `packages/execution/src/agent-provider-adapter.ts` so runner inputs and provider session inputs can carry `structuredResultCapture`. Add provider protocol and unsupported-capability error codes for structured result failures.
**Acceptance criteria:**
- `RunnerRunInput` includes optional `structuredResultCapture`.
- `AgentProviderSessionInput` includes optional top-level `structuredResultCapture`.
- `ProviderProtocolErrorCode` includes `missing_structured_result`, `duplicate_structured_result`, and `structured_result_invalid`.
- `UnsupportedProviderCapabilityErrorCode` includes `structured_result_unsupported`.
- Existing provider adapters and tests compile without requiring structured capture on no-contract sessions.
**Dependencies:** T-001.
#### T-003: Add containment-safe structured result file writing

**Description:** Extend `packages/execution/src/result-file.ts` with `writeScratchStepResultFile` and related write outcome types. The writer should serialize structured values to JSON inside the scratch root and optionally validate with the active schema before writing.
**Acceptance criteria:**
- The writer resolves result paths with the existing scratch-root containment protections.
- Structured values are written with `JSON.stringify(value, null, 2)`.
- Schema mismatches return `result_schema_invalid` without writing a trusted result file.
- Path escapes, invalid JSON serialization, and filesystem write failures return safe failure outcomes.
- Existing scratch-file read behavior and tests remain compatible.
**Dependencies:** T-001.
#### T-004: Export the shared execution APIs

**Description:** Update `packages/execution/src/index.ts` to export the new structured capture, provider error, provider projection, and result-file writer APIs that are part of the agreed surface.
**Acceptance criteria:**
- Public exports match the execution-related entries in `## Converged API`.
- Existing public exports remain available.
- Downstream packages import new shared types through `@autocatalyst/execution` unless an existing local import convention applies.
**Dependencies:** T-001, T-002, and T-003.
#### T-005: Test shared capture and writer behavior

**Description:** Add focused unit coverage for structured capture resolution, serializability checks, provider error codes, and scratch result file writing.
**Acceptance criteria:**
- Tests cover capture, skipped, and failed resolution outcomes.
- Tests prove non-serializable structured results map to `structured_result_invalid`.
- Tests prove schema-invalid values do not produce successful scratch writes.
- Tests prove path containment, missing scratch roots, and successful formatted JSON writes.
**Dependencies:** T-001, T-002, and T-003.
### Story 2: Project canonical result schemas for provider mechanisms

Provide one adapter-facing projection seam so OpenAI and Claude can configure structured output without weakening canonical Autocatalyst schemas.
#### T-006: Implement provider schema projection helper

**Description:** Add `packages/execution/src/provider-schema-projection.ts` with the agreed projection target, projection result, and `ProviderSchemaProjectionError`. Implement `projectStepResultSchemaForProvider` for OpenAI Agents output type and Claude tool input schema targets.
**Acceptance criteria:**
- The projection API matches the `## Converged API` signatures.
- OpenAI projections return target `openai_agents_output_type` and mechanism `openai_output_type`.
- Claude projections return target `claude_tool_input_schema` and mechanism `claude_submit_result_tool`.
- Unsupported or lossy projections fail with `ProviderSchemaProjectionError` extending `UnsupportedProviderCapabilityError` and code `structured_result_unsupported`.
- Projection does not silently drop required fields, strictness, discriminated unions, or provider-enforceable refinements.
- Tests document that boundary-only cross-field refinements for covered contracts remain authoritative at execution validation and do not make provider projection unsupported by themselves.
**Dependencies:** T-002.
#### T-007: Test provider schema projection outcomes

**Description:** Add unit tests for projection success and unsupported-capability failure behavior using the step-result schemas named in the spec.
**Acceptance criteria:**
- Tests cover `autocatalyst.spec_author.v1`, `autocatalyst.implementer_dispositions.v1`, `autocatalyst.reviewer_result.v1`, and `autocatalyst.pr_finalize.v1` where projection support exists.
- Tests prove OpenAI and Claude targets set the expected mechanism metadata.
- Tests prove unsupported projection failures are safe capability errors and do not expose raw schema internals beyond safe metadata.
- Tests document any provider schema limits that must be decided during implementation.
**Dependencies:** T-006.
### Story 3: Resolve and pass structured capture through execution

Attach the active result contract before the provider session starts, then keep the existing execution-boundary validation authoritative after the runner completes.
#### T-008: Resolve structured capture before runner execution

**Description:** Update `packages/execution/src/execution-entry-point.ts` so scratch-file validation config is resolved once before `options.runner.run(runnerInput)`. Convert the resolved contract into `structuredResultCapture` for contract-required scratch-file steps.
**Acceptance criteria:**
- `mode: "none"` does not attach structured capture.
- Contract-required scratch-file steps attach the same step, schema id, schema, and result file selected for post-run validation.
- Pre-run contract failures become existing safe fail-terminal boundary events instead of starting a provider session.
- Contract definitions with no result file preserve existing `result_file_missing` behavior.
- Post-run validation still reads the scratch file, applies normalizers/correction, and attaches `resultContract` on successful terminal advance.
**Dependencies:** T-001 and T-002.
#### T-009: Pass capture through the agent orchestrator runner

**Description:** Update `packages/execution/src/agent-orchestrator-runner.ts` so `RunnerRunInput.structuredResultCapture` is passed into `AgentProviderSessionInput`. Adapters should not need to reach into execution-entry-point internals.
**Acceptance criteria:**
- Provider adapter session input receives the top-level `structuredResultCapture` when runner input has one.
- No-contract runs preserve existing provider session behavior.
- Existing telemetry and progress event behavior remains unchanged.
**Dependencies:** T-002 and T-008.
#### T-010: Test execution and orchestrator pass-through

**Description:** Add regression tests in `packages/execution/src/execution-entry-point.spec.ts` and `packages/execution/src/agent-orchestrator-runner.spec.ts` for pre-run capture resolution and provider pass-through.
**Acceptance criteria:**
- Tests prove the runner receives capture before stream execution for each covered contract-required step shape.
- Tests prove pre-run failures produce safe terminal failure events.
- Tests prove post-run scratch validation still validates and attaches `resultContract`.
- Tests prove no-contract and `mode: "none"` paths do not attach capture.
- Tests prove the provider adapter receives the same capture object passed by the runner.
**Dependencies:** T-008 and T-009.
### Story 4: Use OpenAI structured output for step result files

Configure OpenAI agent sessions with the projected structured output schema and write the parsed SDK output object instead of terminal prose.
#### T-011: Add OpenAI structured result configuration

**Description:** Update `packages/openai-agent-adapter/src/openai-agent-adapter.ts` with `OpenAIStructuredResultConfiguration` and `createOpenAIStructuredResultConfiguration`. The factory should project `capture.schema` for the OpenAI target and expose only `projection.schema` as the SDK `outputType`.
**Acceptance criteria:**
- The exported configuration types and factory match the `## Converged API`.
- Projection failures surface as `structured_result_unsupported` capability errors.
- The adapter does not pass the raw Zod capture schema directly as the SDK `outputType`.
**Dependencies:** T-006.
#### T-012: Pass OpenAI output type into the run seam

**Description:** Extend `OpenAIRunSessionInput` and the `SandboxAgent` creation path so structured sessions include `structuredResult` and configure `outputType` or the installed SDK's supported equivalent.
**Acceptance criteria:**
- `OpenAIRunSessionInput` includes optional `structuredResult`.
- `SandboxAgent` receives the projected schema when structured capture is active.
- No-contract OpenAI sessions keep their current agent creation behavior.
- Tests can assert structured configuration through the injected `runAgentSession` seam without live OpenAI calls.
**Dependencies:** T-011.
#### T-013: Write parsed OpenAI structured output to scratch

**Description:** Update OpenAI terminal handling so structured sessions write the parsed SDK output object to `capture.resultFile` through `assertSerializableStructuredResult` and `writeScratchStepResultFile`. Do not write `finalOutput` prose to the result file when capture is active.
**Acceptance criteria:**
- Parsed structured output is the only source for structured result-file writes.
- Prose `finalOutput` may still appear as assistant output or terminal text, but it is ignored for result-file writing.
- Missing parsed output on an advance terminal result fails with `ProviderProtocolError` code `missing_structured_result`.
- Serialization or schema-write failures map to `structured_result_invalid`.
- Existing legacy string result-file behavior remains only for no-contract sessions.
**Dependencies:** T-003 and T-012.
#### T-014: Test OpenAI structured result behavior

**Description:** Add or update `packages/openai-agent-adapter/src/openai-agent-adapter.spec.ts` for OpenAI structured output configuration, result capture, and failure paths.
**Acceptance criteria:**
- Tests prove `outputType` or equivalent is configured from `structuredResult.projection.schema`.
- Tests prove a prose `finalOutput` plus parsed structured output writes the structured object to scratch.
- Tests prove missing parsed output fails with `missing_structured_result`.
- Tests prove invalid structured output fails with `structured_result_invalid`.
- Tests prove no-contract sessions still behave as before.
**Dependencies:** T-011, T-012, and T-013.
### Story 5: Use a Claude `submit_result` tool for step result files

Add an adapter-owned Claude result submission channel that remains available in read-only sessions and writes submitted tool arguments to scratch.
#### T-015: Define Claude structured result tool projection

**Description:** Update `packages/claude-agent-adapter/src/claude-agent-adapter.ts` with `CLAUDE_STRUCTURED_RESULT_TOOL_NAME`, `ClaudeStructuredResultToolDefinition`, and projection setup for `claude_tool_input_schema`.
**Acceptance criteria:**
- The tool name is exported as `'submit_result'`.
- The tool definition includes description, projected input schema, and projection metadata.
- Projection failures surface as `structured_result_unsupported` capability errors.
- If the installed Claude SDK cannot register enforced local tools, the adapter returns a safe unsupported-capability error instead of falling back to prose parsing.
**Dependencies:** T-006.
#### T-016: Register `submit_result` without granting repository writes

**Description:** Extend Claude session launch options and tool policy construction so structured sessions include the result tool even when repository access is read-only. The result tool should be adapter-owned control-plane machinery, not a repository write tool.
**Acceptance criteria:**
- `ClaudeSessionLaunchOptions` includes optional `structuredResultTool`.
- `submit_result` is included for structured sessions with normal repository tools.
- `submit_result` is included for read-only reviewer sessions alongside read-only tools such as `Read`, `Glob`, and `Grep`.
- Adding the result tool does not enable repository file writes in read-only sessions.
- No-contract Claude sessions keep existing tool policy behavior.
**Dependencies:** T-015.
#### T-017: Capture Claude `submit_result` arguments and write scratch result

**Description:** Update Claude native event mapping or adjacent stream handling so `submit_result` tool calls capture their input as the pending structured result. After the stream ends, write the captured object to `capture.resultFile` through the shared serializability and scratch writer helpers.
**Acceptance criteria:**
- The first valid `submit_result` input is captured as the structured result.
- Duplicate result submissions fail with `ProviderProtocolError` code `duplicate_structured_result` unless the SDK provides a safe final-call signal.
- Missing result submission on an advance terminal result fails with `missing_structured_result`.
- Submitted arguments that cannot be serialized or fail schema validation fail with `structured_result_invalid`.
- Claude result-event prose is not used as the result-file source when structured capture is active.
**Dependencies:** T-003 and T-016.
#### T-018: Test Claude structured result behavior

**Description:** Add or update `packages/claude-agent-adapter/src/claude-agent-adapter.spec.ts` for tool registration, read-only availability, event capture, and failure paths.
**Acceptance criteria:**
- Tests prove structured sessions register or request the `submit_result` tool with the projected input schema.
- Tests prove read-only reviewer sessions can submit `{ "status": "satisfied", "findings": [] }` without write tools.
- Tests prove result-event prose is ignored when `submit_result` provides a valid object.
- Tests prove missing, duplicate, unsupported, and invalid structured-result paths fail with the agreed safe codes.
- Tests prove no-contract sessions keep their current behavior.
**Dependencies:** T-015, T-016, and T-017.
### Story 6: Prove covered contracts, diagnostics, and compatibility

Add cross-cutting coverage and safe diagnostics so the implementation proves the feature works for every covered step without exposing sensitive output.
#### T-019: Add contract-specific regression coverage

**Description:** Add integration-level or high-level unit tests that exercise the covered `spec.author`, `implementation.build` implementer, `implementation.build` reviewer, and `pr.finalize` contracts through the structured capture path.
**Acceptance criteria:**
- A `spec.author` test proves prose around a final response no longer causes `result_json_invalid` when a structured provider result is present.
- An `implementation.build` implementer test proves implementer dispositions write the structured object, including `{}` when valid.
- An `implementation.build` reviewer test proves a read-only reviewer can submit a satisfied verdict through structured capture.
- A `pr.finalize` test proves the structured PR-finalize result reaches boundary validation and still honors existing schema refinements or correction behavior.
- Tests do not require live provider calls by default.
**Dependencies:** T-010, T-014, and T-018.
#### T-020: Add safe structured-result diagnostics

**Description:** Extend existing adapter or execution logs where practical with safe structured-result metadata. Diagnostics should identify the active mechanism and failure code without logging raw prompts, raw result bodies, full provider transcripts, secrets, or absolute host paths.
**Acceptance criteria:**
- Success or failure diagnostics can include step, role when available, provider kind, adapter id, schema id, scratch-relative result file, capture mechanism, and failure code.
- Diagnostics do not include raw result JSON bodies, raw final messages, full prompts, credentials, authorization headers, or absolute host paths.
- Tests or assertions with sentinel secrets prove sensitive values are not emitted by the new diagnostics.
- Unsupported Claude structured-result behavior is reported directly as `structured_result_unsupported`.
**Dependencies:** T-014 and T-018.
#### T-021: Update agent-facing code map after implementation

**Description:** Update `context-agent/wiki/code-map.md` once code changes land so future agents can find the structured-result capture resolver, provider schema projection helper, result writer, and adapter-specific OpenAI and Claude capture paths.
**Acceptance criteria:**
- The code map names the new execution foundation files and their responsibilities.
- The code map names the OpenAI structured output path and Claude `submit_result` path.
- The code map records that execution-boundary scratch validation remains authoritative after provider capture.
**Dependencies:** T-004, T-014, and T-018.
#### T-022: Run targeted and broad validation

**Description:** Run focused tests for the changed execution and adapter packages first, then run broader validation as practical for the repository.
**Acceptance criteria:**
- Targeted execution tests pass for structured capture, result file writing, provider projection, entry point, and orchestrator pass-through.
- Targeted OpenAI adapter tests pass.
- Targeted Claude adapter tests pass or document explicit unsupported SDK behavior covered by safe failure tests.
- `pnpm nx run-many -t build lint test` or the repository's practical equivalent is run before handoff, or any skipped command is documented with the reason.
- Boundary tests remain passing if code changes affect execution boundaries.
**Dependencies:** T-005, T-007, T-010, T-014, T-018, T-019, and T-020.
### Dependency graph

- **Critical path:** T-001 → T-002 → T-008 → T-009 → T-010 → T-019 → T-022.
- **Shared writer path:** T-001 → T-003 → T-013 and T-017.
- **Projection path:** T-002 → T-006 → T-011/T-015 → T-012/T-016 → T-013/T-017.
- **Parallel work:** T-003, T-006, and T-008 can begin after T-001/T-002 are stable. OpenAI tasks T-011 through T-014 and Claude tasks T-015 through T-018 can proceed in parallel after T-006. Diagnostics T-020 and code-map work T-021 should wait until adapter behavior is implemented.
### Reviewer pass

The task list covers every agreed API file and behavior from the requirements, design, tech spec, and `## Converged API` sections. The decomposition keeps the execution boundary authoritative, isolates provider-specific behavior inside adapters, and makes schema projection a shared failure-aware seam rather than ad hoc casting. Acceptance criteria call out the risky paths: OpenAI parsed output versus prose, Claude tool registration support, read-only reviewer result submission, safe failure codes, and diagnostics redaction.
The main implementation risk remains Claude Agent SDK support for enforced custom tools. The tasks require explicit `structured_result_unsupported` behavior if the installed SDK cannot register `submit_result` with an input schema, so unsupported provider behavior does not silently regress to final-message parsing.