---
created: 2026-06-13
last_updated: 2026-06-13
status: complete
issue: 46
specced_by: autocatalyst
---
# Feature: Author a real, conformant spec on `spec.author`

## Product requirements

### What

When a feature or enhancement run reaches `spec.author`, Autocatalyst should dispatch the real planning agent with a prompt and task inputs built from the run's conversation, topic, project, and work kind. The agent should use the materialized `mm:planning` skill to write a complete Markdown spec and a `step-result.json` file that satisfies `specAuthorResultSchema`.
On success, the system should validate the result through the existing step-result tolerance pipeline, commit the authored spec under `context-human/specs/feature-<slug>.md` or `context-human/specs/enhancement-<slug>.md`, record the file-canonical spec artifact through the existing completion path, and pause the run at `spec.human_review` with `waitingOn: "human"`.
This feature turns the wired `spec.author` step from a placeholder execution into the first end-to-end run step that produces a durable, reviewable product artifact through the real agent path.
### Why

Issue 39 created the spec-authoring completion path, artifact behavior, and review gate. Issue 45 made the run auto-dispatch through `intake` and `spec.author` until it reaches the spec gate. However, production dispatch still supplies a placeholder prompt and empty task inputs. A live agent can start, but it does not have the context or contract needed to author a useful spec.
Autocatalyst's core promise is that a person can submit work and receive a reviewable spec before implementation starts. This feature supplies the missing prompt and task-input bridge so `spec.author` can produce that artifact through the same runtime skill, workspace, validation, credential, commit, and gate machinery that production runs use.
### Goals

- Build a real `spec.author` prompt from the run's conversation, topic, project, issue context when available, work kind, and runtime ownership rules.
- Build task inputs that give the agent the exact `specAuthorResultSchema` contract, expected output path rules, required frontmatter fields, and review-gate stopping point.
- Preserve the existing runtime skill path so `mm:planning` is resolved in `ExecutionContext` and materialized by the selected agent adapter.
- Replace the placeholder default prompt and empty production task inputs for feature and enhancement `spec.author` runs.
- Require the agent to write `step-result.json` in the schema shape registered for `spec.author`.
- Validate the authored result through the step-result tolerance pipeline and existing spec-authoring completion path before committing a spec.
- Commit a conformant draft spec under `context-human/specs/` on the run workspace branch.
- Pause the run at `spec.human_review` and expose `waitingOn: "human"` after successful authoring.
- Prove the behavior with an end-to-end test that uses the real prompt and real result contract, with either a real SDK call or a harness that honors both.
- Prove Claude Agent SDK process-environment credential mapping and redaction with CI-runnable boundary tests, and define an opt-in live-provider authentication check for configured environments.
- Update `context-agent/wiki/code-map.md` during implementation for the prompt, task-input, and test wiring.
### Non-goals

- Implementing in-step adversarial convergence between implementer and reviewer roles.
- Classifying human replies at `spec.human_review` into advance or revise directives.
- Re-dispatching `spec.author` to revise a spec after gate feedback.
- Changing the spec approval, feedback, artifact, or frontmatter status lifecycle already defined by issue 39.
- Reading `docs_root` from a project's `mm.toml`; this feature keeps the established `context-human/specs/` location.
- Adding a new public API route for prompt previews, spec authoring, or manual dispatch.
- Changing workflow step IDs or adding new workflow steps.
- Pushing branches, opening pull requests, merging, or changing workspace branch ownership.
- Expanding file-canonical authoring to bug, chore, file-issue, or question workflows.
### Personas

- **Phoebe (Product owner)** needs a generated feature or enhancement spec that is concrete enough to review before implementation starts.
- **Enzo (Engineer)** needs `spec.author` to reuse the existing runner, skill, workspace, schema, and completion boundaries instead of adding a one-off authoring path.
- **Opal (Operator)** needs failures to be safe and diagnosable: no malformed specs committed, no secrets leaked, and run state that clearly shows whether the run is waiting on a human or failed.
- **A provider integrator** needs Claude Agent SDK credential injection to work against configured gateways without special-case local environment setup.
### User stories

- As Phoebe, I can submit a feature request and later review a committed draft spec under `context-human/specs/`.
- As Phoebe, I can see the run paused at `spec.human_review`, so I know Autocatalyst is waiting for my review rather than silently continuing.
- As Enzo, I can inspect the `spec.author` prompt inputs and see the run context, output contract, and runtime ownership instructions that the planning agent receives.
- As Enzo, I can rely on `specAuthorResultSchema` validation before any spec file is committed or artifact completion side effects run.
- As Opal, I can diagnose a malformed or missing `step-result.json` as a typed execution/result failure without exposing raw provider output or secrets.
- As a provider integrator, I can route `spec.author` through the Claude Agent SDK and know credentials are injected via configured environment variables or endpoint auth settings.
### Acceptance criteria

- On `spec.author` for a feature or enhancement run, the execution context resolver receives a real prompt built from the run's conversation, topic, project, work kind, and available issue/request text instead of `Complete the ${run.currentStep} step.`.
- Production control-plane wiring supplies real task inputs for `spec.author` in place of `{}`.
- The task inputs include the `specAuthorResultSchema` shape or an equivalent machine-readable contract: `kind`, `slug`, `relativePath`, `frontmatter`, and `body`.
- The prompt tells the agent to use `mm:planning`, treat feature runs as features and enhancement runs as enhancements, skip branch/push/merge/PR ownership, write requirements/design/tech spec, include a conformant hierarchical `## Task list` with stories/tasks, descriptions, acceptance criteria, and dependencies, and write `step-result.json` exactly in the registered schema shape.
- The expected `relativePath` is exactly `context-human/specs/feature-<slug>.md` for `kind: "feature_spec"` and `context-human/specs/enhancement-<slug>.md` for `kind: "enhancement_spec"`, where `<slug>` is the schema-valid `slug` field from the same result.
- The frontmatter has `status: "draft"`, `created`, `last_updated`, `specced_by`, and an integer `issue` when the run has a linked tracker issue.
- The result uses a non-empty `body` containing the Markdown spec body, not only a file path or prose summary.
- The result `body` includes a real, complete, top-level `## Task list` section with hierarchical stories/tasks, descriptions, acceptance criteria, and dependencies. The prompt, task inputs, and contract-aware harness must treat a placeholder, TODO-only, intentionally empty, or deferred task-list section as unacceptable authoring output; production schema validation for this feature remains limited to deterministic `specAuthorResultSchema` fields plus existing completion invariants.
- The existing `mm:planning` runtime skill mapping remains the path that materializes planning behavior for file-canonical `spec.author` runs.
- The authored `step-result.json` passes the registered `spec.author` result contract and tolerance pipeline before spec commit or artifact completion side effects occur.
- A successful run commits a conformant spec file under `context-human/specs/` on the current run workspace branch.
- After the spec commit and existing spec-authoring completion path, the run lands on `spec.human_review`, remains non-terminal, and `GET /v1/runs/:id` reports `waitingOn: "human"`.
- CI-runnable credential-boundary tests prove agent-mode credential injection maps configured credentials to Claude Agent SDK process environment variables and redacts secrets. An opt-in live-provider check authenticates a real Claude Agent SDK session through configured process-environment settings when secrets and gateway configuration are available; unsupported gateway behavior is documented without logging secrets.
- The end-to-end proof drives create → auto-dispatch → agent/harness authoring → conformant spec commit → `spec.human_review` pause. The harness, if used, must consume the real prompt and validate against the real contract rather than returning a baked success fixture.
- `context-agent/wiki/code-map.md` is updated during implementation for the spec-authoring prompt builder, task-input construction, production wiring, credential behavior if changed, and end-to-end proof.
### Non-functional requirements

- **Safety:** No malformed frontmatter or mismatched path/kind/slug result is committed.
- **Security:** Logs, failure reasons, validation reports, and test diagnostics must not include secret values, raw credentials, or unredacted provider authorization headers.
- **Workspace ownership:** The implementation must not create, switch, push, merge, or open branches. It uses the branch and workspace that Autocatalyst already owns for the run.
- **Compatibility:** Existing feature and enhancement workflows keep their step IDs. Bug, chore, file-issue, and question workflows keep their current behavior.
- **Observability:** Existing runner events and run state-transition events remain the progress surface. The feature may add safe diagnostics for prompt/task-input selection, but not raw prompt dumps in ordinary logs.
- **Determinism:** Prompt and task-input construction should be deterministic for the same run context so tests can assert the contract without brittle prose matching.
### Devil's advocate pass

- **A prompt-only change is too weak.** The feature must thread task inputs and schema selection through production wiring so the execution boundary validates a real `step-result.json`, not merely hope the model follows prose.
- **A baked test harness can hide the product risk.** The end-to-end test must prove the harness reads the real prompt and writes a value accepted by the real schema. Otherwise it only proves issue 39's completion path again.
- **Raw context can leak sensitive text into logs.** Conversation and issue text belong in the prompt/task inputs given to the agent, but ordinary diagnostics should log only safe identifiers, counts, and schema IDs.
- **Credential fixes can become provider-specific hacks.** Any authentication adjustment should stay in the existing endpoint/request-alteration boundary or Claude adapter process-launch mapping, not in `spec.author` business logic.
### Reviewer pass

This feature is correctly classified as a feature because it creates a new standalone capability for the run lifecycle: real spec production through the agent path. It builds on existing spec artifact and auto-dispatch work, but the user-facing behavior is new.
The requirements align with ADR-010 by using `ExecutionContext`, ADR-012 and ADR-027 by validating the result contract before side effects, ADR-017 by committing file-canonical specs, and the runtime-skills concept by using `mm:planning` through the resolved skill catalog. The biggest remaining ambiguity is how much run context is available in `apps/control-plane/src/server.ts` when resolving execution context. The technical design addresses this by using the existing workspace-context loading seam and adding a focused prompt/task-input construction layer there.
## Design spec

### Design scope

This is a backend workflow feature. It changes what the `spec.author` agent receives and what the end-to-end run can prove. It adds no screens, visual components, or new public routes.
The design covers the human-visible service experience through existing artifacts: committed Markdown spec file, runner events, run state, and `waitingOn: "human"` at the spec review gate.
### Service experience

A successful feature run should look like this to a caller:
1. The caller creates a conversation with a feature request.
2. Auto-dispatch moves the run through `intake` to `spec.author`.
3. `spec.author` starts an agent session with `mm:planning` materialized.
4. The agent receives a prompt that includes the request context, feature/enhancement classification, output path convention, frontmatter contract, lifecycle ownership rules, and the instruction to produce the planning spec through the tech spec plus the required hierarchical task decomposition.
5. The agent writes `step-result.json` in scratch with the `specAuthorResultSchema` fields.
6. The execution entry point validates that result.
7. The existing spec-authoring completion path commits the spec file and records the spec artifact.
8. The run transitions to `spec.human_review`.
9. A read of the run reports `waitingOn: "human"`.
The caller should not need to understand the execution boundary. They should see a durable spec ready for review and a run paused at the expected gate.
### Prompt behavior

The prompt should be direct and operational. It should tell the agent:
- Use the materialized `mm:planning` skill.
- Treat `workKind: "feature"` as a feature and `workKind: "enhancement"` as an enhancement.
- Use the request, conversation, topic, project, and linked issue context as the source material.
- Follow Autocatalyst runtime ownership rules: stay on the current branch, do not create worktrees, do not push, do not merge, and do not open PRs.
- Author requirements, design spec, and tech spec before the task decomposition.
- Include a conformant top-level `## Task list` with hierarchical stories/tasks, descriptions, acceptance criteria, and dependencies as required by `mm:planning`; the task list is planning output only and does not authorize implementation.
- Write the Markdown spec under `context-human/specs/` using the schema-compatible filename.
- Write `step-result.json` with the exact fields that `specAuthorResultSchema` expects.
- Return no alternate result shape.
The prompt may include a short checklist of validation rules, but the schema remains authoritative at the execution boundary.
### Task input behavior

Task inputs should give the model structured facts instead of burying everything in prose. Suggested input groups:
- `run`: run id, tenant, work kind, current step, workflow expectations, and linked issue number when known.
- `project`: project id, owner/tenant, repository display data, and any safe project description available from persisted project data.
- `conversation`: topic title/slug and relevant inbound request messages in chronological order.
- `request`: normalized work request text, issue title/body/labels when available, and explicit feature/enhancement classification.
- `outputContract`: schema id, expected result file name, kind/path mapping, expected path prefix, slug rules, and frontmatter rules.
- `bodyContract`: non-empty Markdown spec body requirements, including `requiresCompleteTopLevelTaskList: true`, `taskListPlaceholderAllowed: false`, and measurable task-list completeness guidance for prompt/task-input consumers and the test harness.
- `runtimeOwnership`: no branch creation, no worktree creation, no push, no merge, no PR, current branch only.
- `planningScope`: author requirements/design/tech spec, then include the required hierarchical `## Task list` decomposition while stopping the run at human review before implementation.
Inputs should avoid secrets and provider configuration. If a value is not available, the builder should omit it or use a clearly safe nullable field rather than inventing context.
### Human gate behavior

No new gate behavior is introduced. The feature depends on existing behavior:
- `spec.author` is AI-active and dispatchable.
- `spec.human_review` waits on a human and is not dispatchable.
- Successful authoring advances to `spec.human_review`.
- Reads derive `waitingOn` from the run-step catalog.
The prompt should not ask the agent to approve the spec, open a PR, or continue into implementation. The run lifecycle owns that transition.
### Failure behavior

If the agent writes missing, malformed, or semantically inconsistent output, the step-result tolerance pipeline should handle deterministic normalization and correction according to existing behavior. If validation still fails, the step should fail safely without committing a spec.
Common safe failures include:
- missing `step-result.json`;
- invalid JSON;
- unknown `kind`;
- slug with invalid characters;
- `relativePath` that does not match `kind` and `slug`;
- frontmatter with non-draft status for initial authoring;
- `issue` as a URL or string instead of an integer;
- empty `body`.
Failures should expose typed, sanitized reasons through existing run state and event surfaces. They should not log raw provider responses, complete prompts, credentials, or unredacted environment variables.
### Credential behavior

The user-visible design is simple: a real Claude Agent SDK `spec.author` run authenticates through configured provider settings. The implementation should keep credential behavior behind the existing agent connection and request-alteration boundary.
For process-environment Claude sessions, credential material should be injected through the configured Anthropic-owned environment variable, defaulting to `ANTHROPIC_API_KEY` unless endpoint settings specify another target. Endpoint custom headers should continue to be encoded through `ANTHROPIC_CUSTOM_HEADERS` when supported. If the gateway requires API-key semantics rather than bearer semantics, the configuration or request-alteration layer should express that without leaking the secret or adding `spec.author`-specific provider logic.
### Reviewer pass

The design keeps the human experience focused on the existing run artifacts instead of adding a new surface. It also keeps model behavior constrained by both prompt and schema. The only deliberate flexibility is the test backend: a real SDK call is preferred for confidence, but a harness is acceptable when it reads the real prompt/task inputs and validates the real contract.
## Tech spec

### Current state

The relevant code paths are:
- `packages/api-contract/src/spec-authoring.ts` defines `specAuthorResultSchema` with `kind`, `slug`, `relativePath`, `frontmatter`, and `body`.
- `packages/execution/src/result-contracts.ts` registers `SPEC_AUTHOR_SCHEMA_ID` for `step: "spec.author"`, `resultFile: "step-result.json"`, and `specAuthorResultSchema`.
- `packages/core/src/execution-context-resolver.ts` maps file-canonical `spec.author` runs to runtime skills, but defaults prompt to `Complete the ${run.currentStep} step.` and task inputs to `{}` unless options supply overrides.
- `apps/control-plane/src/server.ts` creates the production execution context resolver with workspace context but does not currently supply a `spec.author` prompt or task-input builder.
- `packages/execution/src/request-alteration.ts` builds Claude process-launch environment variables, defaults credentials to `ANTHROPIC_API_KEY`, supports endpoint-selected `authEnvironmentVariable`, and redacts process-launch logs.
- Existing issue 39 code owns validated spec completion: committing the spec, recording the artifact, and pausing at the spec gate.
- Existing issue 45 code owns auto-dispatch to `spec.author` and stopping at `spec.human_review`.
The missing piece is a production authoring context: the real prompt, structured task inputs, schema selection in the execution entry point, and an end-to-end proof that the result is produced through that path.
### Architecture

Add a focused prompt/task-input construction layer near the execution context resolver wiring. The layer should be reusable from tests and deterministic enough to assert without matching the whole prompt word-for-word.
Suggested shape:
```typescript
interface SpecAuthorPromptInput {
  readonly run: Run;
  readonly project?: Project;
  readonly conversation?: Conversation;
  readonly topic?: Topic;
  readonly messages?: readonly Message[];
  readonly linkedIssue?: { readonly number: number; readonly title?: string; readonly body?: string; readonly labels?: readonly string[] };
}

interface SpecAuthorContextBuilders {
  buildPrompt(input: SpecAuthorPromptInput): string;
  buildTaskInputs(input: SpecAuthorPromptInput): Record;
}
```
The exact module names can follow project conventions. A good default location is `packages/core` if the builders only depend on domain and contract types, with `apps/control-plane/src/server.ts` responsible for loading the required persisted context and passing it into `createExecutionContextResolver` options. If the current resolver input does not carry enough context, extend the production `resolveContext` wrapper rather than making the resolver reach into repositories directly.
Keep provider authentication out of this module. Prompt builders should know about work kind and schema, not Claude, Anthropic, OpenAI, or gateway headers.
### Prompt construction

The prompt builder should branch only on the workflow/work kind and current step:
- For `currentStep !== "spec.author"`, preserve existing default behavior unless another caller supplies a prompt.
- For `workKind: "feature"`, instruct feature requirements and produce `kind: "feature_spec"`.
- For `workKind: "enhancement"`, instruct enhancement-oriented planning and produce `kind: "enhancement_spec"`.
- For unsupported work kinds at `spec.author`, fail context resolution with a typed safe error or fall back to the existing unsupported-work-kind path before dispatch.
The prompt should include the runtime ownership block from `runtime-skills`: Autocatalyst owns branches, worktrees, push, merge, and PR lifecycle for the run. It should also include the planning scope required by `mm:planning`: requirements, design spec, tech spec, and a hierarchical `## Task list` with stories/tasks, descriptions, acceptance criteria, and dependencies. The task list is an authoring artifact only; the run still stops at `spec.human_review` before implementation.
Do not require the prompt to embed the whole Zod schema as TypeScript. Prefer a concise JSON contract example plus field rules. The schema object or equivalent machine-readable summary should be in task inputs.
### Task input construction

The task-input builder should return JSON-serializable data with a stable grouped structure. The task-input contract for this feature is:
```json
{
  "outputContract": {
    "schemaId": "autocatalyst.spec_author.v1",
    "resultFile": "step-result.json",
    "expectedKind": "feature_spec",
    "expectedPathPrefix": "context-human/specs/feature-",
    "expectedRelativePathPattern": "context-human/specs/feature-<slug>.md",
    "slug": {
      "required": true,
      "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
      "relativePathMustUseSameSlug": true
    },
    "frontmatter": {
      "status": "draft",
      "required": ["created", "last_updated", "status", "specced_by"],
      "issueType": "positive integer when present"
    }
  },
  "bodyContract": {
    "required": true,
    "requiresCompleteTopLevelTaskList": true,
    "taskListPlaceholderAllowed": false,
    "taskListRequirements": [
      "top-level ## Task list heading",
      "hierarchical stories and tasks",
      "descriptions",
      "acceptance criteria",
      "dependencies"
    ]
  },
  "planningScope": {
    "stages": ["requirements", "design", "tech_spec"],
    "taskList": "include hierarchical stories/tasks with descriptions, acceptance criteria, and dependencies"
  }
}
```
Enhancement runs use the same grouped structure with `outputContract.expectedKind: "enhancement_spec"`, `outputContract.expectedPathPrefix: "context-human/specs/enhancement-"`, and `outputContract.expectedRelativePathPattern: "context-human/specs/enhancement-<slug>.md"`. The actual structure may add fields inside these groups, but it should keep these group names stable and remain safe to log only as keys or summaries. It must not encode the `## Task list` requirement as a placeholder requirement. If the task-list contract is represented with booleans, the names and values must unambiguously require a complete authored task list and disallow placeholders. Include message and issue body text only in the execution context sent to the agent, not in ordinary diagnostics.

Task-list completeness is intentionally not a new production Markdown semantic validator in this feature because `specAuthorResultSchema` validates `body` as a non-empty string and the existing completion path owns only deterministic schema and file-canonical invariants. The enforcement points for complete task-list authoring are the prompt requirements, the grouped `bodyContract`, and the contract-aware harness/end-to-end assertions. A future feature may add a deterministic Markdown task-list validator if product wants production rejection of semantically incomplete task lists.
### Production wiring

Update `apps/control-plane/src/server.ts` where it calls `createExecutionContextResolver` during real runner dispatch. The wrapper already loads workspace context for feature/enhancement runs. Extend that path to load or pass the conversation, topic, project, message/request, and linked issue context needed by the prompt/task-input builders.
Then call `createExecutionContextResolver` with function-valued options:
- `prompt: (workInput) => ...`
- `taskInputs: (workInput) => ...`
Those functions should return spec-authoring context only for `spec.author`; other steps should keep existing behavior or future step-specific builders.
If the production execution entry point does not already select `SPEC_AUTHOR_SCHEMA_ID` for `spec.author`, wire the registered contract there. The validation mode must read `step-result.json` from scratch and validate with `specAuthorResultSchema` before core receives the terminal `advance.result`.
### Result and completion flow

The expected data flow is:
1. Auto-dispatch calls the execution unit of work for a run at `spec.author`.
2. The context resolver builds `ExecutionContext.task.prompt` and `ExecutionContext.task.inputs` from run context.
3. The execution materializer resolves skills and workspace roots.
4. The selected agent adapter starts a session and materializes `mm:planning`.
5. The agent writes `/step-result.json`.
6. The execution entry point reads and validates the file using the `spec.author` contract.
7. Core receives a validated `RunnerTerminalStepResult` with `advance.result` set to the parsed `SpecAuthorResult`.
8. The existing spec-authoring completion code validates semantic invariants, writes and commits `context-human/specs/(feature|enhancement)-<slug>.md`, records the artifact, and advances the run.
9. The orchestrator transitions the run to `spec.human_review` and stops auto-dispatch because the step waits on a human.
The feature should not duplicate file commit or artifact creation if issue 39's completion path already owns it. It should supply the missing input context and prove the integrated path.
### Claude Agent SDK credential checks

Inspect the real Claude adapter path and endpoint settings used by the end-to-end test. The CI-runnable credential-boundary tests must cover this expected process-environment behavior without making a live provider call:
- endpoint `baseUrl` maps to `ANTHROPIC_BASE_URL`;
- credential maps to `endpoint.authEnvironmentVariable` or defaults to `ANTHROPIC_API_KEY`;
- custom header rewrites map to `ANTHROPIC_CUSTOM_HEADERS` JSON;
- redaction marks the credential variable as secret.
If a gateway requires `ANTHROPIC_AUTH_TOKEN`, set `authEnvironmentVariable` to that value in configuration or adapt the endpoint mapping if the schema cannot express it. If a gateway requires a custom API-key header, represent it through the existing endpoint/custom-header mechanism where possible. Only change `request-alteration.ts` or adapter connection code if the current boundary cannot express the required real call. Do not add special credential handling to `spec.author` prompt or completion code.
A live Claude Agent SDK authentication proof is optional and must be opt-in, gated on available secrets and endpoint configuration. When run, it should assert only sanitized metadata. When unavailable in CI or the local workspace, document the skipped live-provider prerequisite while keeping the credential-boundary tests and end-to-end harness proof mandatory.
### API, SDK, and persistence impact

No public API schema changes are required for the first version. Existing surfaces should observe the result:
- `POST /v1/conversations` creates the run and auto-dispatches as issue 45 defines.
- `GET /v1/runs/:id` reports `currentStep: "spec.human_review"` and `waitingOn: "human"` after success.
- `GET /v1/runs/:id/events` streams runner and transition events from the same event store.
- Existing spec review routes can read the artifact once issue 39's completion path records it.
Persistence changes are not expected unless the current production context lacks a repository method needed to load messages or linked issue data. Prefer existing domain repositories and additive read helpers over new tables.
### Test plan

Add targeted unit tests for the prompt/task-input builders:
- feature runs produce feature-oriented instructions, `outputContract.expectedKind: "feature_spec"`, `outputContract.expectedPathPrefix: "context-human/specs/feature-"`, and `context-human/specs/feature-<slug>.md` rules;
- enhancement runs produce enhancement-oriented instructions, `outputContract.expectedKind: "enhancement_spec"`, `outputContract.expectedPathPrefix: "context-human/specs/enhancement-"`, and `context-human/specs/enhancement-<slug>.md` rules;
- the prompt includes runtime ownership instructions, requirements/design/tech-spec guidance, and the hierarchical task-list decomposition rule;
- task inputs include `outputContract.schemaId`, `outputContract.resultFile`, frontmatter rules under `outputContract.frontmatter`, and non-empty request context when supplied;
- unsupported work kinds do not silently produce a file-canonical prompt.
Add or update integration coverage for production wiring:
- `apps/control-plane` real dispatch wiring supplies non-placeholder prompt and non-empty task inputs for `spec.author`.
- The execution entry point validates `step-result.json` against the registered `SPEC_AUTHOR_SCHEMA_ID` contract.
- A malformed harness result fails safely before commit.
- A conformant harness result commits a spec and pauses at `spec.human_review`.
Add the required end-to-end proof:
- Drive create → auto-dispatch through the production server/service path.
- Use either a real Claude Agent SDK session or a harness that receives the real `ExecutionContext.task.prompt` and `task.inputs`.
- Have the agent/harness write `step-result.json` from the real prompt/task-input contract rather than a baked fixture.
- Assert the committed spec exists under `context-human/specs/` with draft frontmatter.
- Assert the result passes `specAuthorResultSchema`.
- Assert the run pauses at `spec.human_review` and reads `waitingOn: "human"`.
For credential behavior, split mandatory boundary coverage from optional live-provider coverage:
- Unit-test `buildClaudeProcessLaunchEnvironment` for `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or configured `authEnvironmentVariable` behavior.
- Unit-test custom header environment encoding and redacted diagnostics without logging secret values or authorization headers.
- If the environment supports a real Claude Agent SDK gateway call, run one opt-in integration proof with secrets supplied through the secret store and assert only sanitized logs/metadata.
- If the real call is not practical in CI or this workspace, keep the harness proof required and document the manual/opt-in real SDK check and its prerequisites.
### Validation

Recommended targeted validation after implementation:
```bash
pnpm nx test core -- spec-authoring-prompt.spec.ts
pnpm nx test execution -- result-contracts.spec.ts
pnpm nx test execution -- execution-entry-point.spec.ts
pnpm nx test claude-agent-adapter
pnpm nx test control-plane -- integration.spec.ts
pnpm nx test control-plane -- control-plane-service.integration.spec.ts
pnpm test:boundaries
```
Run `pnpm validate` when practical after targeted tests pass.
### Risks and mitigations

- **The agent may ignore prose instructions.** The result schema and scratch-file validation are the enforcement layer. Prompt text helps, but validation and safe failure are required.
- **The prompt may omit important request context.** Keep the builder close to the existing production workspace-context loading path and include tests that exercise conversation/topic/project/message input.
- **The harness may become a fixture in disguise.** Require the harness to inspect the real prompt/task inputs and write output through the real contract. Avoid hard-coded success events that bypass schema validation.
- **Provider credential requirements may differ by gateway.** Keep adjustments inside endpoint configuration, request alteration, or adapter connection code. Record unsupported gateway behavior directly if the boundary cannot support it.
- **A spec could be committed on the wrong branch if git ownership is confused.** The prompt must tell the skill not to manage branches, and completion code must operate only inside the run workspace branch.
- **Sensitive context could leak through logs.** Log schema IDs, run IDs, and safe summaries. Do not log raw issue bodies, prompts, provider responses, or secrets by default.
### Devil's advocate pass

- **Planning output could be confused with implementation authorization.** The required hierarchical task list must be present for `mm:planning` conformance, but the prompt, task inputs, and run lifecycle must state that no task execution starts before `spec.human_review`.
- **Credential tests can either be too fake or too brittle.** CI must prove deterministic environment mapping and redaction without a provider dependency, while the live SDK proof remains opt-in so unavailable secrets or gateway variance do not block normal validation.
- **Builder drift can make prompt and task inputs disagree.** Production wiring should prefer `buildSpecAuthorContext` so prompt and task inputs are derived from the same validated input.
### Reviewer pass

The technical design uses existing seams: `ExecutionContext` for prompt and inputs, runtime skills for `mm:planning`, the execution entry point for scratch result validation, and the spec-authoring completion path for file/artifact side effects. It does not move provider authentication into business logic, and it keeps branch ownership with Autocatalyst.
The main implementation decision is module placement for prompt/task-input builders. The safest path is a small core builder with no provider imports and production server wiring that supplies loaded domain context. That keeps tests focused and prevents the control-plane server from accumulating prompt prose inline.

## Task list

### Story 1 — Build deterministic [spec.author](http://spec.author) context builders

**Description:** Add the core module that turns a loaded feature or enhancement run context into one consistent prompt and task-input contract for `spec.author`.
**Dependencies:** None.
#### Task 1.1 — Add public builder types, errors, and safe diagnostics

**Description:** Create `packages/core/src/spec-authoring-context.ts` with exported builder input/output types, `SpecAuthorContextError`, `assertSupportedSpecAuthorWorkKind`, and `toSafeDetails`.
**Acceptance criteria:**
- The module exports stable types and helpers for the prompt input, combined prompt/task-input output, task-input output contract, safe diagnostics, supported-work-kind assertion, and typed context errors.
- `assertSupportedSpecAuthorWorkKind` accepts only `"feature"` and `"enhancement"` and throws a typed safe error for other work kinds.
- `toSafeDetails` brands sanitized details and rejects unsafe key names such as `prompt`, `body`, `response`, `secret`, `token`, `credential`, `authorization`, and `header`.
- Builder errors expose only safe codes and safe details; they do not include raw prompts, issue bodies, provider responses, or secrets.
- Core source imports only domain/contract-safe dependencies and no provider-specific code.
#### Task 1.2 — Implement `buildSpecAuthorPrompt`

**Description:** Implement prompt construction for feature and enhancement `spec.author` runs using request, conversation, project, topic, and linked issue context when supplied.
**Acceptance criteria:**
- The prompt is not `Complete the ${run.currentStep} step.` for supported `spec.author` runs.
- The prompt tells the agent to use `mm:planning` and treat feature and enhancement runs according to the agreed work-kind mapping.
- The prompt includes Autocatalyst runtime ownership rules: current branch only, no branch creation or switching, no worktrees, no push, no merge, and no PR.
- The prompt instructs the agent to preserve the planning boundary: requirements, design spec, tech spec, and a hierarchical `## Task list` with stories/tasks, descriptions, acceptance criteria, and dependencies, while stopping before implementation.
- The prompt instructs the agent to write `step-result.json` with `kind`, `slug`, `relativePath`, `frontmatter`, and `body` in the registered schema shape.
- Missing required current step, work kind, run identifiers, or actionable request context fails with `SpecAuthorContextError`.
#### Task 1.3 — Implement `buildSpecAuthorTaskInputs`

**Description:** Implement deterministic JSON-safe task inputs for run, project, conversation, request, output contract, runtime ownership, and planning scope.
**Acceptance criteria:**
- Feature runs produce `outputContract.expectedKind: "feature_spec"`, `outputContract.expectedPathPrefix: "context-human/specs/feature-"`, and `outputContract.expectedRelativePathPattern: "context-human/specs/feature-<slug>.md"`.
- Enhancement runs produce `outputContract.expectedKind: "enhancement_spec"`, `outputContract.expectedPathPrefix: "context-human/specs/enhancement-"`, and `outputContract.expectedRelativePathPattern: "context-human/specs/enhancement-<slug>.md"`.
- Task inputs include `outputContract.schemaId: "autocatalyst.spec_author.v1"` and `outputContract.resultFile: "step-result.json"`.
- Task inputs include frontmatter rules for `created`, `last_updated`, `status: "draft"`, `specced_by`, and integer `issue` when present.
- Task inputs include `bodyContract` rules that require a complete top-level `## Task list` and explicitly disallow placeholders for prompt/task-input consumers and harness assertions.
- Task inputs include runtime ownership and planning-scope fields matching the task input behavior in this spec.
- Task inputs include request/conversation/issue context when supplied and omit unavailable optional context without inventing facts.
#### Task 1.4 — Implement `buildSpecAuthorContext`

**Description:** Implement the combined builder so production wiring derives prompt and task inputs from the same validated input.
**Acceptance criteria:**
- `buildSpecAuthorContext(input).prompt` equals the prompt builder output for the same input.
- `buildSpecAuthorContext(input).taskInputs` equals the task-input builder output for the same input.
- Unsupported step, unsupported work kind, missing request text, invalid slug, or impossible path/kind mapping fails before either output is returned.
- Direct builders and the combined builder use the same validation path to avoid drift.
#### Task 1.5 — Cover core builder behavior with unit tests

**Description:** Add `packages/core/src/__tests__/spec-authoring-context.spec.ts` and `packages/core/src/__tests__/spec-authoring-prompt.spec.ts`.
**Acceptance criteria:**
- Tests cover feature and enhancement `outputContract` expected kinds, path prefixes, slug-derived relative path patterns, exact result file name, and frontmatter rules.
- Tests assert the prompt includes `mm:planning`, work-kind classification, branch/worktree/push/merge/PR prohibitions, requirements/design/tech-spec guidance, and the hierarchical `## Task list` instruction.
- Tests assert task inputs include `outputContract.schemaId`, request context, conversation messages in chronological order, linked issue fields when present, `bodyContract` rules requiring a complete task list rather than a placeholder, and safe omission when issue metadata is unavailable.
- Tests assert unsupported work kinds and unsafe diagnostic keys fail safely.
- Tests avoid brittle full-prompt snapshots while proving the placeholder prompt is not used.
### Story 2 — Load safe production context for spec authoring

**Description:** Add a control-plane loader that gathers the run, project, conversation, topic, messages, request text, and linked issue metadata needed by the core builders without importing provider logic.
**Dependencies:** Story 1 for `SpecAuthorPromptInput` and safe error types.
#### Task 2.1 — Add `spec-authoring-context-loader`

**Description:** Create `apps/control-plane/src/spec-authoring-context-loader.ts` with `loadSpecAuthorPromptInput`, loader dependency types, request types, and the optional `IssueContextReader` seam.
**Acceptance criteria:**
- The loader exports `loadSpecAuthorPromptInput`, loader dependency types, request types, and the optional `IssueContextReader` seam.
- The loader requires `tenantId` unless `repositoriesEnforceTenantIsolation` is explicitly true.
- The loader fails safely when the run is missing, not at `spec.author`, or has an unsupported work kind.
- The loader preserves run identifiers, tenant/project/topic/conversation ids, issue number, and current step in the returned prompt input.
- The loader does not import Claude, provider adapter, endpoint, or credential code.
#### Task 2.2 — Load request, conversation, topic, project, and message context

**Description:** Use existing repository seams or minimal additive read helpers to populate safe authoring context for production runs.
**Acceptance criteria:**
- The loader includes normalized request text and slug/title data from the best available conversation, topic, issue, or manual request source.
- Conversation messages are returned in chronological order with safe role, text, and timestamp fields.
- Project and topic fields are included only when available and tenant-scoped.
- Missing optional project, topic, conversation, or message data does not crash the loader when the request context remains actionable.
- Required repository failures propagate as typed or repository-specific read errors without exposing secrets.
#### Task 2.3 — Load linked issue metadata when available

**Description:** Wire optional issue-context reading so issue title, body, and labels can enrich the prompt input without making issue integration mandatory.
**Acceptance criteria:**
- When `deps.issues` is present and the run has `issueNumber`, the loader asks it for issue metadata with run, tenant, project, and issue identifiers.
- When `deps.issues` is absent, the loader does not throw solely because `issueNumber` is present.
- The numeric issue number remains available for task inputs and frontmatter guidance even when linked issue metadata is omitted.
- Issue reader failures are surfaced as safe load failures unless existing repository policy already classifies them as optional misses.
#### Task 2.4 — Test loader scoping and optional context behavior

**Description:** Add focused control-plane unit tests for the loader with fake repositories and issue readers.
**Acceptance criteria:**
- Tests cover tenant-id requirement and the `repositoriesEnforceTenantIsolation` escape hatch.
- Tests cover unsupported step/work-kind failures.
- Tests cover complete context loading with project, topic, conversation messages, request text, and linked issue metadata.
- Tests cover missing optional issue reader while preserving `issueNumber`.
- Tests prove provider or credential data is not required by the loader.
### Story 3 — Wire real prompt and task inputs into production dispatch

**Description:** Connect the loader and core builders to the execution context resolver used by real `spec.author` dispatch while preserving default behavior for other steps.
**Dependencies:** Stories 1 and 2.
#### Task 3.1 — Ensure resolver callbacks support [spec.author](http://spec.author) context

**Description:** Extend or confirm `packages/core/src/execution-context-resolver.ts` supports function-valued `prompt` and `taskInputs` options with the existing `ExecutionContextWorkInput` resolver shape.
**Acceptance criteria:**
- `createExecutionContextResolver` accepts prompt and task-input callbacks that can return values, `undefined`, or promises.
- Callback errors propagate as safe context-resolution failures.
- Non-`spec.author` steps keep their current default prompt and task-input behavior when callbacks return `undefined`.
- Existing resolver tests continue to pass.
- New resolver tests cover async callback values and callback failure propagation if coverage does not already exist.
#### Task 3.2 — Add production control-plane wiring

**Description:** Update `apps/control-plane/src/server.ts` so real runner dispatch loads authoring context and supplies the built prompt/task inputs for feature and enhancement `spec.author` runs.
**Acceptance criteria:**
- Production wiring calls `loadSpecAuthorPromptInput` and then `buildSpecAuthorContext` for supported `spec.author` runs.
- `ExecutionContext.task.prompt` receives the real prompt and `ExecutionContext.task.inputs` receives non-empty real task inputs.
- Non-`spec.author` steps and unsupported non-file-canonical workflows keep existing behavior.
- The wiring uses the existing run workspace and never creates, switches, pushes, merges, or opens branches.
- Safe diagnostics log identifiers, counts, schema ids, or enums only; ordinary logs do not include raw prompt text, issue bodies, message bodies, provider responses, or secrets.
#### Task 3.3 — Cover production resolver wiring with integration tests

**Description:** Add or update `apps/control-plane/src/integration.spec.ts` to prove production dispatch receives the real authoring context.
**Acceptance criteria:**
- A feature `spec.author` dispatch receives a non-placeholder prompt and non-empty task inputs through the production resolver.
- An enhancement `spec.author` dispatch receives enhancement-specific expected kind and path rules.
- A non-`spec.author` dispatch retains default behavior or its existing step-specific behavior.
- The test harness observes the actual `ExecutionContext.task.prompt` and `ExecutionContext.task.inputs` passed to the runner.
- Test diagnostics do not print raw credentials or authorization headers.
### Story 4 — Enforce the [spec.author](http://spec.author) result contract at the execution boundary

**Description:** Confirm or add the execution-entry-point selection that validates `step-result.json` with the registered `spec.author` result contract before any completion side effects run.
**Dependencies:** Story 3 for real task-input wiring; existing `SPEC_AUTHOR_SCHEMA_ID` registry.
#### Task 4.1 — Select `SPEC_AUTHOR_SCHEMA_ID` for `spec.author`

**Description:** Update `packages/execution/src/execution-entry-point.ts` only if needed so `spec.author` reads `step-result.json` and validates with the registered `SPEC_AUTHOR_SCHEMA_ID`.
**Acceptance criteria:**
- `spec.author` uses `SPEC_AUTHOR_SCHEMA_ID` from `packages/execution/src/result-contracts.ts`.
- The entry point reads the registered result file name `step-result.json` from scratch.
- Validation happens before terminal `advance.result` is accepted by core completion handling.
- Existing validation behavior for unrelated steps is unchanged.
- No duplicate spec file commit or artifact recording is introduced in the execution layer.
#### Task 4.2 — Reject malformed or inconsistent authoring output before side effects

**Description:** Add execution-entry-point checks or tests that prove invalid authoring results fail safely before spec completion can commit a file.
**Acceptance criteria:**
- Missing `step-result.json`, invalid JSON, unknown `kind`, invalid slug, mismatched kind/path/slug, non-draft frontmatter, invalid `issue`, and empty `body` fail through the existing tolerance/validation path.
- Failure details are typed and sanitized.
- No malformed spec is committed and no spec artifact is recorded when validation fails.
- Raw provider output and raw prompt text are not persisted as durable step results.
#### Task 4.3 — Add execution-entry-point contract tests

**Description:** Add or update `packages/execution/src/execution-entry-point.spec.ts`.
**Acceptance criteria:**
- Tests prove `spec.author` selects `SPEC_AUTHOR_SCHEMA_ID`.
- Tests prove a conformant `step-result.json` becomes the parsed terminal `advance.result`.
- Tests prove malformed authoring output fails before any injected completion-side-effect spy can run.
- Tests prove unrelated steps keep existing result-contract behavior.
### Story 5 — Keep Claude credential handling behind the existing connection boundary

**Description:** Verify and, only if needed, narrowly adjust Claude Agent SDK process-environment credential mapping without adding provider logic to spec-authoring code.
**Dependencies:** Existing request-alteration and adapter wiring; Story 3 for integrated dispatch context.
#### Task 5.1 — Inspect and preserve process-launch credential mapping

**Description:** Confirm `packages/execution/src/request-alteration.ts` maps endpoint and credential settings to Claude Agent SDK process environment variables as required.
**Acceptance criteria:**
- Endpoint `baseUrl` maps to `ANTHROPIC_BASE_URL`.
- Credentials map to `endpoint.authEnvironmentVariable` or default to `ANTHROPIC_API_KEY`.
- Custom headers map to `ANTHROPIC_CUSTOM_HEADERS` when representable.
- Redaction metadata marks credential variables and custom-header values as secret.
- No `spec.author` prompt, task-input, loader, or completion module imports or branches on Claude credential behavior.
#### Task 5.2 — Add credential-boundary tests

**Description:** Add or update `packages/execution/src/request-alteration.spec.ts` for Claude process-launch environment behavior.
**Acceptance criteria:**
- Tests cover default `ANTHROPIC_API_KEY` mapping.
- Tests cover configured auth variables such as `ANTHROPIC_AUTH_TOKEN`.
- Tests cover custom-header environment encoding when supported.
- Tests prove logs and redacted launch diagnostics exclude known secret values and unredacted authorization headers.
- Tests document any unsupported gateway behavior if the existing endpoint/request-alteration boundary cannot express it.
#### Task 5.3 — Add optional real SDK credential proof or documented skip

**Description:** Run or document the narrowest practical real Claude Agent SDK authentication proof through configured process-environment settings.
**Acceptance criteria:**
- If secrets and gateway configuration are available, one opt-in integration proof authenticates a Claude Agent SDK session without logging secret values.
- If a real call is not practical in CI or this workspace, the implementation documents the exact reason and keeps the harness proof required by Story 6.
- Any required gateway-specific auth behavior is represented through endpoint/request-alteration configuration when possible, not through spec-authoring business logic.
### Story 6 — Prove end-to-end spec authoring through the real contract

**Description:** Add service-level proof that create → auto-dispatch → real prompt/task inputs → agent or harness output → validated spec commit → human review pause works.
**Dependencies:** Stories 1 through 5.
#### Task 6.1 — Build a contract-aware authoring harness

**Description:** Add a test harness that receives the real `ExecutionContext.task.prompt` and `task.inputs`, derives a conformant `step-result.json`, and refuses to act like a baked success fixture.
**Acceptance criteria:**
- The harness asserts the prompt includes the planning skill, runtime ownership rules, planning-scope stop point, and `step-result.json` contract.
- The harness reads `outputContract` from task inputs to choose `kind`, `relativePath`, required frontmatter, and result file name.
- The harness reads `bodyContract` from task inputs and refuses outputs that would satisfy only a placeholder `## Task list`.
- The harness writes `step-result.json` into scratch with `kind`, `slug`, `relativePath`, `frontmatter`, and non-empty `body`.
- The harness can intentionally write malformed output for failure-path tests.
- The harness does not bypass `specAuthorResultSchema` or the execution-entry-point validation path.
#### Task 6.2 — Add successful service-level end-to-end coverage

**Description:** Add or update `apps/control-plane/src/control-plane-service.integration.spec.ts` to drive the production service path to `spec.human_review`.
**Acceptance criteria:**
- The test creates a feature or enhancement request through the normal create/conversation service path.
- Auto-dispatch moves through `intake` to `spec.author` without manual step injection beyond existing test controls.
- The harness or real SDK receives the actual production prompt and task inputs.
- The resulting `step-result.json` passes `specAuthorResultSchema`.
- A draft spec is committed under the expected `context-human/specs/feature-<slug>.md` or `context-human/specs/enhancement-<slug>.md` path derived from the validated result slug.
- `GET /v1/runs/:id` or equivalent service read reports `currentStep: "spec.human_review"` and `waitingOn: "human"`.
#### Task 6.3 — Add malformed-output end-to-end coverage

**Description:** Add a service-level failure-path test where the harness writes invalid authoring output.
**Acceptance criteria:**
- The run fails or records the existing safe validation failure state before any spec file commit.
- No spec artifact completion side effects run for the malformed output.
- Failure diagnostics are sanitized and do not include raw prompt text, issue bodies, provider responses, or secrets.
- The test covers at least one semantic mismatch, such as `kind` not matching `relativePath`, in addition to basic malformed JSON or missing file behavior if practical.
### Story 7 — Update agent documentation and run validation

**Description:** Record the implemented module map for future agents and run targeted validation before broader checks.
**Dependencies:** Stories 1 through 6.
#### Task 7.1 — Update `context-agent/wiki/code-map.md`

**Description:** Document the new and changed spec-authoring modules, production wiring, validation boundary, credential behavior if changed, and test locations.
**Acceptance criteria:**
- The code map names `packages/core/src/spec-authoring-context.ts` and its prompt/task-input responsibilities.
- The code map names `apps/control-plane/src/spec-authoring-context-loader.ts` and production server wiring responsibilities.
- The code map names the execution-entry-point schema selection and result-contract validation location.
- The code map names credential-boundary behavior if `request-alteration.ts` changes.
- The code map lists the relevant unit, integration, and end-to-end tests added for this feature.
#### Task 7.2 — Record any new durable technical decision

**Description:** Add a terse decision note under `context-agent/decisions/` only if implementation makes a durable decision not already captured by this spec or existing ADRs.
**Acceptance criteria:**
- No unnecessary decision file is added for straightforward implementation of this spec.
- Any added decision follows the repository format in `AGENTS.md`.
- Any added decision is reflected in an index if an applicable `context-agent` index exists.
#### Task 7.3 — Run targeted and broad validation

**Description:** Run focused tests first, then broader repository validation when practical.
**Acceptance criteria:**
- Targeted validation includes the core builder tests, control-plane loader/wiring tests, execution-entry-point tests, request-alteration credential tests, and service-level end-to-end proof.
- Boundary validation runs with `pnpm test:boundaries`.
- `pnpm validate` runs after targeted checks when practical.
- Any skipped validation command is documented with the exact reason.