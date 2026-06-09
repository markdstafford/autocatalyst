---
created: 2026-06-09
last_updated: 2026-06-09
status: implementing
issue: 21
specced_by: markdstafford
---
# Feature: Runner boundary, execution context, and stub runner

## Product requirements

### What

Add Autocatalyst's first executable runner boundary. The control plane can dispatch a non-terminal run through the existing `RunUnitOfWork` seam, resolve a declarative per-run `ExecutionContext`, send that serializable context across the execution boundary, receive a typed runner event stream, and apply the returned directive through the orchestrator.
The feature keeps execution co-located and in-process for this slice, but it must preserve the no-shared-memory contract from ADR-003. Control-plane code passes a self-contained unit of work and receives typed events plus a terminal result. It does not reach into execution-plane internals, filesystem state, or memory.
The stub runner is deterministic and makes no real model call. It exists to prove the contract, event vocabulary, execution-context resolution, execution-side materialization, least-privilege posture, workspace provisioning integration, and orchestrator dispatch wiring before provider adapters and result-tolerance work are added.
### Why

The orchestrator can already create runs, queue dispatch, and call a test `RunUnitOfWork` stub. The execution package can already provision a two-root workspace. Those pieces are not yet connected through an execution boundary that behaves like the future runner layer.
This feature turns the architectural contracts in `execution-runtime`, ADR-003, ADR-010, and ADR-022 into code. It proves that a run can cross the control/execution boundary with one declarative context, be materialized inside the execution plane, stream typed execution events, and return a directive that advances the run through the orchestrator. It also creates the seam that later result validation, event persistence/SSE re-streaming, real provider adapters, and model routing can build on. Model routing attaches to control-side context resolution, so the resolution/materialization boundary must exist before routing work lands.
### Goals

- Define a public `Runner` contract whose `run()` returns an async stream of typed events and whose `close()` handles teardown.
- Define a shared typed runner event vocabulary with Zod schemas in `@autocatalyst/api-contract` and TypeScript types exported for execution and control-plane code.
- Define a shared declarative `ExecutionContext` in `@autocatalyst/api-contract` so the control plane and execution plane do not depend on each other for the boundary payload type.
- Include event types for assistant turns, tool activity, structured progress or intent, importance hints, severity-tagged notifications, durable step checkpoints, and a terminal result.
- Resolve one declarative `ExecutionContext` per run in the control plane from the run, work kind, route defaults, project data, workspace intent, secret declarations, tool policy, declared skill/plugin intent, and capability requirements.
- Keep the declarative `ExecutionContext` serializable and portable: it carries decisions and inputs, not materialized workspace paths or decrypted secret values.
- Materialize the execution environment in the execution plane by provisioning the workspace, resolving declared secret handles, constructing scoped environment variables, and setting capability availability flags.
- Materialize a two-root workspace for implementing runs by calling the existing `provisionWorkspace` API from the execution plane.
- Resolve per-run secrets from the secret store by declared handle only, and inject them into a scoped environment object rather than reading the ambient host environment.
- Include a provisioned-capabilities seam for bash, canonical paths, and an LSP hook, while leaving real shell/LSP backend provisioning to later runner work.
- Implement a core-owned `RunUnitOfWork` adapter that backs `DefaultOrchestrator.dispatch` by resolving the declarative context, invoking an execution entry point, consuming its event stream, and returning the directive the orchestrator applies.
- Implement an in-process stub or echo runner that receives the materialized environment, emits deterministic typed events, and returns a terminal result without calling a model provider.
- Keep tool permissions broad but scoped to the materialized workspace, matching the trusted single-host posture in ADR-010.
- Prove the feature with an integration test that dispatches a non-terminal run through the orchestrator against a real temporary two-root workspace.
- Update `context-agent/wiki/code-map.md` during implementation with the runner contract, event vocabulary, declarative context resolution, execution materialization, core adapter, and stub runner modules.
### Non-goals

- Real Claude, OpenAI, direct-model, or gateway provider adapters.
- Provider/model routing by `(step, role)`, per-endpoint request alteration, or adapter selection beyond the stub runner.
- The result contract tolerance pipeline: deterministic normalization, schema validation, bounded correction, and graceful degradation.
- Persisting the execution event stream, re-streaming runner events over SSE, or recording durable runner events onto `RunStep`.
- Implementing a real shell, LSP server, container sandbox, network-egress controls, or hardened per-run least privilege.
- Skills materialization beyond declared intent in the context.
- Recovery, resume-on-load, re-invocation from durable checkpoints, or true in-flight session resume.
- Pushing branches, opening pull requests, merging, or any git remote publication.
- A human-facing UI for runner events.
### Personas

- **Enzo (Engineer)** needs one typed runner boundary and context shape so future provider adapters can plug in without changing orchestrator dispatch.
- **Opal (Operator)** needs secrets and tools scoped to a run, with no ambient environment leakage and no control-plane reads of execution internals.
- **Phoebe (PM)** needs a visible proof that an Autocatalyst run can cross into execution, produce progress, and advance without a real model yet.
- **Dani (Designer)** is not a direct user of this backend feature, but future progress displays depend on the typed event vocabulary this feature establishes.
### User stories

- As Enzo, I can import a public `Runner` contract from `@autocatalyst/execution` and implement a runner that yields typed events.
- As Enzo, I can dispatch a run through the orchestrator and know that execution happens through the core `RunUnitOfWork` adapter, not through ad hoc lifecycle calls.
- As Enzo, I can consume runner event schemas and the declarative `ExecutionContext` type from `@autocatalyst/api-contract` without parsing free text.
- As Enzo, I can add future provider adapters behind the same event and materialized runner-input contract.
- As Opal, I can verify that a run receives only declared secrets from the store and never inherits the host process environment as its secret boundary.
- As Opal, I can verify that tools are scoped to the materialized workspace roots.
- As Phoebe, I can see an integration test where a non-terminal run dispatches, streams progress, returns a terminal result, and advances.
- As a future UI author, I can rely on structured event kinds and importance hints rather than scraping model output.
### Acceptance criteria

#### Runner contract

- `@autocatalyst/execution` exports a `Runner` contract whose `run(input)` returns an async iterable or async generator of typed runner events.
- The same public contract exposes `close()` for teardown.
- The contract accepts a self-contained runner input that includes the execution-plane materialized environment and any run-scoped correlation data needed for event IDs or telemetry.
- The contract returns its terminal outcome as a typed terminal event in the stream.
- Control-plane callers interact with execution only through public package entry points: `@autocatalyst/execution` for execution behavior and `@autocatalyst/api-contract` for shared schemas/types.
- Control-plane packages do not import `@autocatalyst/execution/src/*` or execution internals.
- Existing boundary tests continue to pass.
#### Typed event vocabulary

- `packages/api-contract` defines Zod schemas and inferred types for runner events.
- The event union is discriminated by a stable `type` field.
- The vocabulary includes an assistant-turn event.
- The vocabulary includes a tool-activity event.
- The vocabulary includes structured progress or intent events, including a plan and task-progress shape.
- The vocabulary includes severity-tagged notifications.
- The vocabulary includes an importance hint so downstream surfaces can decide what to show.
- The vocabulary includes step-checkpoint events with a stable serializable checkpoint shape and `durable: true` marker for future persistence/recovery work.
- The vocabulary includes a terminal-result event carrying the orchestrator directive to apply.
- Event values are serializable across a future network or queue boundary.
- Event schemas are exported from `packages/api-contract/src/index.ts`.
#### Declarative execution context resolution

- `packages/api-contract` defines and exports a serializable declarative `ExecutionContext` type.
- A core resolver creates one declarative `ExecutionContext` for a run before invoking execution.
- The context includes run identity, work kind, current step, tenant, task prompt, and task-specific inputs.
- Operational configuration is used as resolver input and is not handed to the agent as free-form configuration.
- Workspace context is an intent, not a materialized workspace. It includes the requested workspace shape plus provisioning inputs: project descriptor, root references, `topicSlug`, `shortRunId`, and optional `defaultBranch`.
- The declarative context does not include materialized `repoRoot`, `scratchRoot`, branch checkout paths, absolute workspace paths, decrypted secret values, or host environment dumps.
- Secret declarations include handles and target environment variable names only.
- The resolver never reads secrets from `process.env` as the run's secret source.
- The context includes a per-run tool policy expressed against workspace intent and allowed tool categories.
- The context includes declared skill/plugin intent, even when the stub runner only records or echoes it.
- The context includes capability requirements for bash, canonical paths, and an LSP hook. It does not set execution-time availability flags.
- Unsupported work kinds or workspace shapes fail with typed errors rather than silently falling back.
#### Execution materialization

- `@autocatalyst/execution` exposes an execution entry point that accepts the declarative `ExecutionContext` and returns a typed runner event stream plus terminal handling behavior to the core adapter.
- The execution plane materializes the environment before invoking a runner.
- Implementing work kinds materialize a two-root workspace by calling `provisionWorkspace` with explicit project/workspace provisioning inputs from the declarative context and execution-side root resolution.
- The materialized workspace context names `repoRoot`, `scratchRoot`, and `branchName` distinctly.
- The execution plane resolves only declared secret handles through a `SecretResolver` and injects plaintext values into `environment.variables` with matching `secretVariableNames`.
- Secret values are placed only into the scoped materialized environment for the runner.
- The materializer never scans or copies `process.env` as the run's secret source.
- The materialized environment includes a tool policy scoped to materialized workspace roots.
- For `none` workspace intent, the materializer does not call `provisionWorkspace` and produces `workspaceRoots: []`.
- For `scratch_only` workspace intent, the materializer provisions or creates only a scratch workspace root, does not create a repository checkout, and produces `workspaceRoots: [scratchRoot]`.
- The materialized environment sets capability `available` flags for bash, canonical paths, and LSP without requiring real shell or LSP backend provisioning.
- Missing or undecryptable declared secrets fail before runner invocation with sanitized errors.
#### Core unit-of-work adapter

- `packages/core` implements the `RunUnitOfWork` interface used by `DefaultOrchestrator.dispatch`.
- The adapter resolves the declarative `ExecutionContext` in the control plane before invoking execution.
- The adapter invokes a public execution entry point from `@autocatalyst/execution`; `packages/execution` does not import `packages/core`.
- The adapter consumes the runner event stream through completion, recording the first terminal-result event and continuing only to validate that no duplicate terminal result or post-terminal event appears.
- The adapter maps the terminal event to the `RunWorkResult` shape expected by the orchestrator.
- The adapter returns `advance`, `needs_input`, or `fail` directives without mutating run state itself.
- The orchestrator remains the only component that applies directives and records run transitions.
- Resolution, materialization, runner, and telemetry failures follow the failure mapping table in `### Error design`; every failure path uses sanitized details.
- The adapter ensures `runner.close()` is called through the execution entry point during teardown or after stream completion according to the contract.
#### Stub runner

- The execution package provides an in-process stub or echo runner implementation.
- The stub runner emits a deterministic event stream for a given materialized environment.
- The stream includes at least one assistant-turn or progress event before the terminal result.
- The stream ends with exactly one terminal-result event.
- The terminal result can produce an `advance` directive for the happy path.
- The stub does not call any model provider, external AI SDK, or network service.
- The stub exercises the provisioned-capabilities seam without requiring real shell or LSP backend provisioning.
- The stub does not read or write outside the materialized workspace roots.
#### Least-privilege posture

- The declarative context resolver accepts declared secret handles and target environment variable names only.
- The execution materializer resolves only those declared handles.
- Missing, locked, unavailable, or undecryptable declared secrets fail before runner invocation.
- Secret values are redacted from errors, diagnostics, and test snapshots.
- Tool permissions are represented as an explicit policy in the declarative context and as a workspace-root-scoped policy in the materialized environment.
- The default policy grants broad non-interactive permissions only inside the materialized workspace roots.
- This slice's observable enforcement surface is policy construction plus guarded helper checks used by the stub runner for any optional file access; real shell/tool backend enforcement is reserved for later shell/tool runner work.
- The stub runner receives no ambient host environment dump.
- Tests assert that a sentinel environment variable outside declared handles is not exposed as a run secret.
#### Integration proof

- An integration test creates or uses a real temporary git repository suitable for two-root workspace provisioning.
- The test creates a non-terminal implementing run through existing orchestrator or service ingress seams.
- The test configures the orchestrator with the core `RunUnitOfWork` adapter and an execution entry point backed by the stub runner.
- Dispatching the run resolves a declarative context before execution is invoked.
- Dispatching the run invokes `provisionWorkspace` during execution materialization and produces distinct repo and scratch roots.
- A targeted integration or materialization test covers a question/no-workspace run and asserts `provisionWorkspace` is not called and `workspaceRoots` is empty.
- A targeted integration or materialization test covers a file-issue/scratch-only run and asserts repository checkout is not materialized and `workspaceRoots` contains only `scratchRoot`.
- Dispatching the run consumes a typed runner event stream through successful completion with exactly one terminal-result event and no post-terminal events.
- The returned directive is applied by the orchestrator, and the run advances to the next workflow step.
- The test asserts control-plane code consumes only the returned stream and result, not execution-plane internals.
- The test proves execution internals remain inaccessible through existing boundary checks.
## Design spec

### Design scope

This is a backend execution-runtime feature. There is no visual screen, layout, or human-facing copy in this pass.
The design work is the developer and operator experience: the shape of the runner contract, the event stream, the declarative `ExecutionContext`, the execution-side materialized environment, the dispatch adapter, and the proof that a run advances through the orchestrator after execution returns a directive.
### Developer experience

A future runner author should be able to implement one small interface:
1. Receive a materialized environment with task, workspace paths, scoped environment variables, tool policy, skill intent, and capability availability.
2. Yield typed events as work progresses.
3. Yield one terminal result that tells the orchestrator adapter what directive to return.
4. Clean up through `close()`.
A control-plane developer should not need to understand execution internals. They configure `DefaultOrchestrator` with a `RunUnitOfWork`. The implementation of that unit of work lives in `packages/core`: it resolves the declarative context, calls a public execution entry point, and still returns only `RunWorkResult` to the orchestrator. The orchestrator remains the sole run-state writer.
### Operator experience

The operator-facing behavior is about safety and debuggability rather than UI:
- Every run gets a clear workspace intent before crossing the boundary and a named repo/scratch workspace after execution materialization when the work kind needs a workspace.
- The event stream carries progress as typed data, so logs and future clients can show useful status without parsing raw model text.
- Secrets cross the boundary as handles and target environment variable names; plaintext exists only inside the scoped materialized environment.
- Tool permissions are explicit and scoped to materialized workspace roots.
- Provider behavior is not involved yet, so failures in this slice should be local, deterministic, and testable.
### Dispatch flow

The happy-path dispatch flow is:
1. `DefaultOrchestrator.dispatch({ runId, tenant })` loads and validates a non-terminal run.
2. The dispatch queue admits the run according to the configured concurrency limit.
3. The core `RunUnitOfWork` adapter receives `RunWorkInput`.
4. The adapter resolves a declarative `ExecutionContext` from the run, project/workspace inputs, route defaults, secret declarations, tool policy, skill intent, and capability requirements.
5. The adapter calls a public execution entry point with the declarative `ExecutionContext`.
6. The execution entry point materializes the environment: it provisions the workspace, resolves declared secret handles, scopes environment variables, builds materialized tool policy, and sets capability availability.
7. The execution entry point invokes the configured `Runner` with the materialized environment.
8. The runner yields typed events.
9. The core adapter validates event shapes, records the first terminal-result event, then drains the stream to completion only to enforce the protocol rule that no duplicate terminal result or post-terminal event appears.
10. After the stream completes with exactly one terminal result, the adapter maps that terminal result to `RunWorkResult`.
11. The orchestrator applies the directive through `applyDirective` and publishes the existing run-state transition event.
### Event design

Runner events should be canonical execution events, distinct from the existing `run_state_transition` SSE event. The runner stream describes what happened inside execution. The existing run-state event describes how the orchestrator changed durable run state.
A representative event union is:
```typescript
type RunnerEvent =
  | RunnerAssistantTurnEvent
  | RunnerToolActivityEvent
  | RunnerProgressEvent
  | RunnerNotificationEvent
  | RunnerStepCheckpointEvent
  | RunnerTerminalResultEvent;
```
Representative fields:
```typescript
interface RunnerEventBase {
  id: string;
  type: string;
  runId: string;
  step: string;
  importance: 'low' | 'normal' | 'high';
  createdAt: string;
}

interface RunnerTerminalResultEvent extends RunnerEventBase {
  type: 'runner_terminal_result';
  result: {
    directive: 'advance' | 'needs_input' | 'fail';
    question?: string;
    reason?: string;
  };
}
```
Exact names may follow implementation conventions, but values should follow existing API conventions: JSON fields are camelCase and enum values are snake_case.
For this slice, `runner_step_checkpoint.checkpoint.durable: true` means the checkpoint payload is intentionally stable, serializable, and suitable for future durable storage or resume semantics. It does not require this feature to persist runner events, acknowledge checkpoint writes, record `RunStep` checkpoint rows, or resume execution from checkpoints; those behaviors remain explicit non-goals.
### Execution Context shape

The boundary has two related shapes: a declarative context resolved by the control plane and a materialized environment produced by the execution plane. The declarative context is the payload that crosses the boundary. The runner receives only the materialized environment.
A representative declarative context shape is:
```typescript
interface ExecutionContext {
  run: {
    id: string;
    workKind: string;
    currentStep: string;
    tenant: string;
  };
  task: {
    prompt: string;
    inputs: Record;
  };
  workspaceIntent:
    | { shape: 'none' }
    | {
        shape: 'scratch_only';
        provisioning: WorkspaceProvisioningIntent;
      }
    | {
        shape: 'two_roots';
        provisioning: WorkspaceProvisioningIntent;
      };
  secretBindings: Array;
  toolPolicy: {
    allowedTools: string[];
    workspaceScope: 'declared_workspace';
  };
  skills: {
    requested: string[];
    plugins?: string[];
  };
  capabilityRequirements: {
    shell: { kind: 'bash'; required: boolean };
    paths: { canonicalWorkspacePaths: boolean };
    lsp: { requested: boolean };
  };
}

interface WorkspaceProvisioningIntent {
  project: ProjectWorkspaceDescriptor;
  roots: WorkspaceRootRefs;
  topicSlug: string;
  shortRunId: string;
  defaultBranch?: string;
}
```
The declarative context must be JSON-serializable and portable across a future extracted worker boundary. It carries decisions and provisioning inputs, not materialized state. `WorkspaceRootRefs` are explicit provisioning root references from control-plane configuration, not materialized `repoRoot` or `scratchRoot` paths. If the current `provisionWorkspace` implementation requires local filesystem paths, the execution materializer maps those root references to local execution-side paths before calling the provisioner.
A representative materialized environment shape is:
```typescript
interface MaterializedExecutionEnvironment {
  context: ExecutionContext;
  workspace:
    | { shape: 'none'; workspaceRoots: string[] }
    | { shape: 'scratch_only'; scratchRoot: string; workspaceRoots: string[] }
    | {
        shape: 'two_roots';
        repoRoot: string;
        scratchRoot: string;
        branchName: string;
        workspaceRoots: string[];
      };
  environment: {
    variables: Record;
    secretVariableNames: string[];
  };
  toolPolicy: {
    allowedTools: string[];
    workspaceRoots: string[];
  };
  skills: {
    requested: string[];
    plugins?: string[];
  };
  capabilities: {
    shell: { kind: 'bash'; available: boolean };
    paths: { repoRoot?: string; scratchRoot?: string };
    lsp: { requested: boolean; available: boolean };
  };
}
```
The control-plane resolver can start with simple defaults for prompt construction, tool policy, and skill intent. The important design rule is that all defaults are explicit resolver outputs, not implicit behavior inside a runner. The execution materializer turns those declarative decisions into local paths, plaintext scoped variables, and availability flags immediately before invoking the runner.
Workspace shapes are supported intentionally in this slice, not just described in the schemas:
- `none` is used for question/no-workspace work. The resolver emits no provisioning intent, the materializer must not call `provisionWorkspace`, and the materialized workspace has `workspaceRoots: []`.
- `scratch_only` is used for file-issue or scratch-only work. The resolver emits scratch provisioning inputs, the materializer creates or provisions only a scratch root, and the materialized workspace has `workspaceRoots: [scratchRoot]` with no `repoRoot` or `branchName`.
- `two_roots` is used for implementing work. The resolver emits full project and root-reference provisioning inputs, the materializer calls `provisionWorkspace`, and the materialized workspace has distinct `repoRoot`, `scratchRoot`, `branchName`, and `workspaceRoots: [repoRoot, scratchRoot]`.
### Stub runner behavior

The stub runner should act like a predictable provider adapter without model behavior. For a happy path it can yield:
1. A progress event announcing that the stub received the task.
2. An assistant-turn event with deterministic text.
3. A step-checkpoint event marking the stub's checkpoint with a serializable payload and `durable: true`.
4. A terminal-result event with `directive: 'advance'`.
Tests can inject variants that emit `needs_input`, `fail`, malformed events, or a missing terminal result. The production default should be the happy-path stub until real provider adapters replace it.
### Tool policy enforcement surface

This feature constructs least-privilege data and proves that the stub obeys it; it does not implement the future shell or tool backend that will enforce every command. The measurable enforcement surface for this slice is:
- The resolver emits an explicit policy scoped to the declared workspace intent.
- The materializer narrows that policy to concrete `workspaceRoots`.
- Execution exposes guarded helper checks, such as `assertPathWithinWorkspaceRoots(path, workspaceRoots)`, for code that needs to verify local file access.
- The stub runner must use those checks before any optional workspace file read or write and must fail safely when a path is outside the materialized workspace roots.
Actual shell command interception, tool backend authorization, container sandboxing, and network controls remain non-goals for this slice.
### Error design

Expected failures should be typed and sanitized:
- Missing run, forbidden run, terminal run, or invalid transition remain orchestrator errors.
- Missing project, malformed or duplicate secret declarations, unsupported workspace shape, and unsupported work kind during control-side resolution become `ExecutionContextResolutionError` failures before the boundary crossing.
- Workspace provisioning failures retain existing `WorkspaceProvisioningError` codes when wrapped as materialization failures.
- Missing, locked, unavailable, or undecryptable declared secrets become materialization failures before runner invocation.
- Runner stream validation failure becomes a runner-protocol error.
- Runner failure before a terminal event becomes a failed unit-of-work result with a sanitized reason, unless teardown fails and the close-failure precedence rule below applies.
No error should include secret values, raw environment dumps, credential-bearing URLs, absolute paths that are not already safe provisioner details, or unsanitized provider output.
Adapter dispatch failure mapping is intentionally fixed for this slice:

Failure class
Dispatch outcome
Close behavior and precedence

Missing run, forbidden run, terminal run, invalid transition, unknown work kind before unit-of-work invocation
Orchestrator rejects with its existing typed orchestrator error.
The execution entry point is not invoked, so it does not call `runner.close()`.

Missing project, missing workspace intent inputs, unsupported workspace shape, unsupported work kind inside control-side resolution, malformed secret declaration, duplicate target environment variable name, declared secrets without a resolver declaration
The core unit of work rejects with `ExecutionContextResolutionError`. The orchestrator does not apply a `fail` directive because execution was not dispatched.
The execution entry point was not invoked, so `runner.close()` is not required. This resolves the run-transition ambiguity: resolution failure is a dispatch failure, not a runner-produced failed result.

Transient project lookup or control-side resolver dependency unavailable before boundary crossing
The core unit of work rejects with a retryable dispatch error if the dependency reports retryability; otherwise it rejects with `ExecutionContextResolutionError`. The orchestrator does not apply a directive.
The execution entry point was not invoked, so `runner.close()` is not required.

Workspace root reference cannot be mapped to execution-side provisioning roots, `provisionWorkspace` fails, declared secret is missing/locked/unavailable/undecryptable, or capability materialization fails before runner invocation
The execution entry point returns or throws a sanitized materialization failure outcome across the boundary; the core adapter maps it to a failed unit-of-work result unless the failure is explicitly marked retryable dispatch failure.
If the runner stream was not opened, `runner.close()` is not required. If a future implementation acquires runner resources before materialization completes, it must close them and preserve the materialization error as primary.

Malformed runner event, wrong run id, duplicate terminal result, event after terminal, completed stream without terminal result
Reject with `RunnerProtocolError` using the matching protocol code.
`runner.close()` runs in `finally`; if close also fails, the original protocol error remains primary and sanitized close details may be attached.

Runner throws while creating or iterating the stream before any terminal result
Return `{ directive: 'fail', reason }` with a sanitized deterministic reason so the orchestrator can apply the failed run transition.
`runner.close()` runs in `finally`; if close fails, reject with `RunnerProtocolError` code `runner_close_failed` instead of returning the fail result because teardown integrity is unknown.

Runner throws after a terminal result while the adapter is draining the stream for post-terminal validation
Reject with `RunnerProtocolError` code `runner_failed`; the terminal result is not applied because the stream did not complete successfully.
`runner.close()` runs in `finally`; the runner failure remains primary if close also fails.

Terminal result with `directive: 'advance'`
Return `{ directive: 'advance' }`.
If `runner.close()` fails after an otherwise successful stream, reject with `RunnerProtocolError` code `runner_close_failed`.

Terminal result with `directive: 'needs_input'`
Return `{ directive: 'needs_input', question }` preserving the optional sanitized question.
If `runner.close()` fails after an otherwise successful stream, reject with `RunnerProtocolError` code `runner_close_failed`.

Terminal result with `directive: 'fail'`
Return `{ directive: 'fail', reason }` preserving the sanitized reason.
If `runner.close()` fails after an otherwise successful stream, reject with `RunnerProtocolError` code `runner_close_failed`.

`onEvent` telemetry hook throws
Reject with `RunnerProtocolError` code `runner_failed`; telemetry hooks are not allowed to mutate state or partially succeed silently.
`runner.close()` runs in `finally`; the telemetry failure remains primary if close also fails.

## Tech spec

### Current state

The repository already has the foundation for this feature:
- `packages/core/src/orchestrator.ts` defines `RunUnitOfWork`, `RunWorkInput`, `RunWorkResult`, and `DefaultOrchestrator.dispatch`.
- `DefaultOrchestrator.dispatch` loads a run, gates terminal/tenant cases, enqueues work through `RunDispatchQueue`, calls `unitOfWork.run(...)`, maps `fail` and `needs_input`, and applies the directive through `applyDirective`.
- `apps/control-plane/src/server.ts` accepts an optional `unitOfWork` for tests and wires it into `DefaultOrchestrator`.
- `packages/execution/src/index.ts` currently exports a scaffold `Runner` with `run(input): Promise` plus workspace APIs.
- `packages/execution/src/workspace.ts` exports `provisionWorkspace`, teardown, prune, typed workspace shapes, and sanitized workspace errors.
- `packages/api-contract/src/run-events.ts` defines existing orchestrator run-state transition SSE events, not runner execution events.
- `packages/persistence/src/secret-store.ts` can create encrypted secrets, but the core `SecretStore` interface currently exposes only `createSecret`.
- Boundary rules allow control-plane packages to import `@autocatalyst/execution` and reject imports from execution internals.
### Proposed package shape

Keep shared schemas and serializable boundary types in `packages/api-contract`. Keep runner and materialization code in `packages/execution`. Put the `RunUnitOfWork` implementation in `packages/core` so the dependency direction is `core -> execution`, and `packages/execution` does not import `packages/core`.
Recommended files:
- `packages/api-contract/src/runner-events.ts` — Zod schemas, event names, event union, terminal-result directive schema, and inferred types.
- `packages/api-contract/src/execution-context.ts` — declarative `ExecutionContext`, workspace intent, secret binding, tool policy, skill intent, and capability requirement schemas/types.
- `packages/api-contract/src/index.ts` — exports runner event schemas/types and declarative execution-context schemas/types.
- `packages/core/src/secret.ts` — core-side `SecretResolver` and sanitized `SecretResolutionError` types used by control-plane wiring and persistence adapters.
- `packages/core/src/execution-context-resolver.ts` — control-side resolver that produces declarative `ExecutionContext` values.
- `packages/core/src/execution-run-unit-of-work.ts` — core adapter implementing `RunUnitOfWork`, invoking the public execution entry point, validating events, and mapping terminal results.
- `packages/execution/src/runner.ts` — public `Runner`, `RunnerRunInput`, `RunnerCloseResult` if needed, and runner protocol error types.
- `packages/execution/src/secret-resolver.ts` — execution-owned materialization-time secret resolver interface and sanitized secret materialization error mapping; it is structurally compatible with the core-side resolver but does not import `packages/core`.
- `packages/execution/src/materialized-environment.ts` — public materialized environment types and materialization error types.
- `packages/execution/src/execution-entry-point.ts` — public function or class that accepts a declarative `ExecutionContext`, materializes it, drives a `Runner`, and returns/streams events to the core adapter.
- `packages/execution/src/internal/execution-materializer.ts` — execution-side materializer that calls workspace provisioning, resolves secrets, builds scoped environment, and sets capabilities.
- `packages/execution/src/internal/runner-event-validation.ts` — event validation helpers using `api-contract` schemas if they are shared with the core adapter; otherwise keep validation in core and avoid duplicating stateful stream rules.
- `packages/execution/src/stub-runner.ts` — deterministic in-process stub runner.
- `packages/execution/src/index.ts` — exports only public runner, materialized environment, execution entry point, stub, and workspace APIs.
This placement eliminates the cycle concern rather than managing it as a fallback. Core owns orchestration and unit-of-work adaptation. Execution owns materialization and runner invocation. Shared schemas/types live in `api-contract`.
The materialization-time secret read port is intentionally structural. `packages/execution` defines the interface it accepts, for example `ExecutionSecretResolver.resolveSecret(handle): Promise`, because execution may not import `packages/core`. `packages/core` may define and export the same-shaped `SecretResolver` for control-plane assembly, and `packages/persistence` may implement that core contract. The core adapter passes a resolver instance into the public execution entry point by TypeScript structural typing; no runtime dependency from execution to core or persistence is introduced.
### API contract additions

Add a new runner event schema family instead of overloading `run_state_transition`:
- `runnerEventBaseSchema`
- `runnerAssistantTurnEventSchema`
- `runnerToolActivityEventSchema`
- `runnerProgressEventSchema`
- `runnerNotificationEventSchema`
- `runnerStepCheckpointEventSchema`
- `runnerTerminalResultEventSchema`
- `runnerEventSchema` as a discriminated union
Add a declarative execution-context schema family:
- `executionContextSchema`
- `executionRunContextSchema`
- `executionTaskContextSchema`
- `workspaceIntentSchema`
- `workspaceProvisioningIntentSchema`
- `secretBindingSchema`
- `toolPolicySchema`
- `skillIntentSchema`
- `capabilityRequirementsSchema`
Use existing conventions:
- JSON fields use camelCase.
- Enum values use snake_case.
- Runner events carry `id`, `type`, `runId`, `step`, `importance`, and `createdAt` where applicable.
- Terminal directives map to `advance`, `needs_input`, and `fail`.
- Declarative context values are serializable and contain no decrypted secret values or materialized workspace paths.
Do not add OpenAPI route exposure for these events in this feature. Runner event persistence and SSE re-streaming are follow-up work.
### Runner contract

Replace or supersede the scaffold in `packages/execution/src/index.ts` with a streaming contract:
```typescript
export interface Runner {
  run(input: RunnerRunInput): AsyncIterable;
  close(): Promise;
}
```
`RunnerRunInput` should carry the materialized environment and any run-scoped correlation data needed for event IDs or telemetry. A runner must not receive broad control-plane repositories or services.
The adapter should enforce these protocol rules:
- Every yielded event validates against `runnerEventSchema`.
- Events belong to the dispatched run id.
- The stream must contain exactly one terminal-result event and then complete without yielding any additional events.
- A second terminal-result event is a protocol error.
- Any non-terminal event yielded after a terminal-result event is a protocol error.
- A completed stream without a terminal-result event is a protocol error.
- The adapter drains the stream after the first terminal-result event only to detect duplicate terminal results, post-terminal events, or thrown errors; it maps the terminal directive only after the stream has completed successfully.
- `runner.close()` runs in a `finally` path.
### Declarative Execution Context resolver

The resolver lives in `packages/core` and accepts a request that includes at least:
- The `RunWorkInput` values from core.
- Project/workspace intent inputs: a serializable project workspace descriptor, root references, `topicSlug`, `shortRunId`, and optional `defaultBranch`.
- Declared secret handles and their target environment variable names.
- Tool policy defaults for the work kind.
- Skill/plugin intent defaults for the work kind or current step.
- Capability requirements.
- Prompt and input overrides when tests or future routing need explicit task shaping.
The resolver does not call `provisionWorkspace`, does not decrypt secrets, and does not set capability availability. It decides the workspace shape, handle set, tool policy, skill intent, capability requirements, prompt, and task inputs. It returns a declarative `ExecutionContext` from `@autocatalyst/api-contract`.
Because the current core `SecretStore` interface only supports creating secrets, this feature should add a narrow read interface for materialization rather than expose persistence internals. A representative interface is:
```typescript
export interface SecretResolver {
  resolveSecret(handle: string): Promise;
}
```
`SqliteSecretStore` can implement the core-side version after unlock. The resolver validates secret declarations but does not call `resolveSecret`; execution materialization performs the actual read through its execution-owned, structurally compatible interface. Neither resolver nor materializer should expose secret values in diagnostics.
Project lookup and workspace intent may be passed into the core adapter through constructor options for this slice if no project repository read path is convenient yet. The integration test can create a project in persistence and provide a small project lookup seam. That seam must return the exact declarative provisioning inputs rather than a partial repository path:
```typescript
interface ExecutionWorkspaceProvisioningIntent {
  project: ProjectWorkspaceDescriptor;
  roots: WorkspaceRootRefs;
  topicSlug: string;
  shortRunId: string;
  defaultBranch?: string;
}
```
`topicSlug` and `shortRunId` are explicit resolver inputs or explicit lookup outputs; the implementation must not infer them from display titles, branch names, or repository paths. The important boundary is that execution-context resolution receives explicit inputs and emits explicit decisions; it must not read arbitrary global process configuration inside the runner.
### Execution materialization

The execution entry point should accept a declarative `ExecutionContext` and materialization options that include at least:
- A configured `Runner`.
- An execution-owned `ExecutionSecretResolver` or same-shaped object capable of returning plaintext values by declared handle; this type lives in `packages/execution` and must not import the core `SecretResolver`.
- A root-reference resolver or execution configuration that maps `WorkspaceRootRefs` to the local arguments required by `provisionWorkspace`.
- Optional capability probes or overrides for tests.
- Optional clock and event ID/correlation inputs.
For implementing work kinds, the materializer calls `provisionWorkspace` with `{ runId: context.run.id, runKind: context.run.workKind, ...workspaceProvisioningInputs }` after mapping the declarative workspace intent to the provisioner's local input shape. It maps the provisioner result into `MaterializedExecutionEnvironment.workspace` with distinct `repoRoot`, `scratchRoot`, and `branchName` values.
For question/no-workspace contexts, the materializer skips workspace provisioning and returns the `none` materialized workspace shape with an empty `workspaceRoots` list. For file-issue/scratch-only contexts, the materializer creates or provisions only a scratch root through the execution-side root configuration and returns the `scratch_only` materialized workspace shape with `workspaceRoots` containing that scratch root only. Unsupported workspace shapes still fail with typed materialization errors.
The materializer resolves only the declared secret handles from `context.secretBindings` and places plaintext values into `environment.variables` under the declared environment names. It also records those names in `secretVariableNames`. It must not scan, copy, or merge `process.env` into the runner environment.
Capability requirements stay declarative. Materialization sets `available` flags and canonical path values based on what the execution plane actually provides for this slice. Bash and LSP may be represented as available/unavailable testable seams without starting a real shell or LSP backend.
### Core RunUnitOfWork adapter

The adapter should implement the core-compatible shape in `packages/core`:
```typescript
export interface ExecutionRunUnitOfWorkOptions {
  execute: ExecutionEntryPoint;
  resolveContext(input: RunWorkInput): Promise;
  onEvent?: (event: RunnerEvent) => void | Promise;
}
```
At runtime it should:
1. Resolve the declarative context in core.
2. Call the public execution entry point with that context.
3. Validate each event with `runnerEventSchema`.
4. Record events in memory for this issue only if tests need inspection.
5. Record the first terminal-result event.
6. Continue iterating until the runner stream completes so duplicate terminal results, post-terminal events, and thrown errors after terminal are observable protocol failures.
7. Map the terminal result to `RunWorkResult` only after successful stream completion.
8. Ensure runner teardown occurs through the execution entry point's `finally` behavior.
The adapter should not call `applyDirective`, write `RunStep`, publish run-state transition events, or mutate persistence. Those remain orchestrator responsibilities.
### Stub runner

Implement a deterministic `StubRunner` in `packages/execution`.
Constructor options may include event ID generation and clock injection for stable tests. The default stream should be stable enough for snapshot-free assertions:
- `runner_progress` with a received-task message.
- `runner_assistant_turn` with deterministic text derived from run id and current step.
- `runner_step_checkpoint` with the current step.
- `runner_terminal_result` with `{ directive: 'advance' }`.
The stub should inspect the materialized environment enough to assert workspace and capability wiring in tests, but it should not perform external IO beyond optional safe reads/writes inside scratch if needed for proof.
### Control-plane wiring

For this feature, production server startup may continue to use an injected `unitOfWork` or may wire the core adapter plus execution stub as the default. If the stub becomes the default, make that explicit in `apps/control-plane/src/server.ts` and keep real provider configuration out of scope.
Integration tests should prefer explicit wiring:
- Create the database and repositories.
- Create a project and non-terminal run through existing service/orchestrator ingress.
- Build a core `RunUnitOfWork` with a declarative context resolver and a public execution entry point backed by `StubRunner`.
- Dispatch through `DefaultOrchestrator.dispatch` or `ControlPlaneService.tick`.
- Assert the run advances and runner events were consumed.
### Tests

Recommended targeted coverage:
- `packages/api-contract/src/runner-events.spec.ts` validates each event kind and rejects malformed terminal/progress shapes.
- `packages/api-contract/src/execution-context.spec.ts` validates serializable declarative contexts and rejects materialized workspace paths or plaintext secret values if schema refinements can enforce that.
- `packages/core/src/secret.spec.ts` asserts the secret-read seam and sanitized `SecretResolutionError` behavior.
- `packages/core/src/execution-context-resolver.spec.ts` asserts workspace intent, secret bindings, tool policy, skill intent, capability requirements, unsupported work kinds, unsupported workspace shapes, and sanitized resolution errors.
- `packages/execution/src/execution-materializer.spec.ts` asserts workspace provisioning, scoped environment, declared secrets only, capability availability, missing workspace settings, workspace provisioning failure, secret resolution failure, and ambient environment exclusion.
- `packages/execution/src/stub-runner.spec.ts` asserts deterministic stream order and one terminal result.
- `packages/core/src/execution-run-unit-of-work.spec.ts` asserts terminal mapping, missing terminal protocol failure, double terminal protocol failure, malformed event rejection, and close behavior surfaced through the execution entry point.
- An integration test dispatches an implementing run through `DefaultOrchestrator` with a real temporary git repository and the existing workspace provisioner.
- Existing `pnpm test:boundaries` continues to prove control-plane code does not import execution internals.
### Documentation updates

Implementation should update `context-agent/wiki/code-map.md` with:
- Runner event schemas and declarative `ExecutionContext` schemas in `packages/api-contract`.
- Public runner contract, materialized environment, execution entry point, materializer, and stub runner in `packages/execution`.
- Core declarative context resolver and `RunUnitOfWork` adapter in `packages/core`.
- Any new secret-read seam.
No `context-human` concept or ADR update is required for this feature unless implementation changes an accepted contract. If implementation discovers a need to change the no-shared-memory boundary, the Execution Context model, or runner factoring, stop and propose an ADR amendment before coding that change.
### Risks and open decisions

- **Provider behavior remains unsupported.** The stub runner is the only runner behavior in scope. Real Claude, OpenAI, direct-model, gateway, model-routing, request-alteration, and result-tolerance behavior remain explicit follow-up work.
- **Secret resolver wiring depends on structural typing.** Execution owns the materialization-time resolver interface so it does not import core. Core and persistence may expose same-shaped implementations. If TypeScript package boundaries or build tooling make that structural handoff awkward, add a small adapter at the composition root rather than creating an execution-to-core dependency.
- **Tool enforcement is partial in this slice.** The slice proves workspace-scoped policy data and guarded helper checks used by the stub. Full command/tool interception, sandboxing, and network control remain later backend work.
- **Workspace shape behavior must stay explicit.** `none`, `scratch_only`, and `two_roots` have different provisioning behavior. Future resolver defaults must not silently upgrade a no-workspace or scratch-only run into a repository checkout.
- **Event durability is not implemented.** Durable checkpoint events are stable payloads for future persistence and resume work, but this slice does not persist or replay runner events.
## Task list

### Story 1: Publish shared runner event, declarative context, and secret-read contracts

#### Task 1.1: Add runner event schemas to `@autocatalyst/api-contract`

**Description:** Create `packages/api-contract/src/runner-events.ts` with event schemas, inferred types, discriminated union, event type enum, importance enum, and terminal directive enum.
**Acceptance criteria:**
- `runnerEventSchema` validates all six event kinds: assistant turn, tool activity, progress, notification, step checkpoint, and terminal result.
- The union discriminates on the stable `type` field and uses camelCase JSON fields with snake_case enum values.
- Progress payloads include `plan`, `task_progress`, and `intent` variants.
- Step checkpoint payloads are stable, serializable, and include `checkpoint.durable: true`; tests do not expect checkpoint persistence or resume behavior in this slice.
- Terminal results allow only `advance`, `needs_input`, and `fail` directives.
- Malformed event shapes fail Zod validation in targeted tests.
**Dependencies:** None.
#### Task 1.2: Add declarative `ExecutionContext` schemas to `@autocatalyst/api-contract`

**Description:** Create `packages/api-contract/src/execution-context.ts` with serializable declarative context schemas and inferred types for run identity, task, workspace intent, secret bindings, tool policy, skill intent, and capability requirements.
**Acceptance criteria:**
- `executionContextSchema` validates run identity, task prompt/inputs, workspace intent, secret bindings, tool policy, skill/plugin intent, and capability requirements.
- Workspace shapes include `none`, `scratch_only`, and `two_roots` as intent shapes.
- Workspace intent carries project descriptor, root references, `topicSlug`, `shortRunId`, and optional `defaultBranch` when provisioning is required.
- Secret bindings carry handles and target environment variable names only.
- Capability values are requirements, not execution-time availability flags.
- The schema and type shape do not include `repoRoot`, `scratchRoot`, `branchName` checkout paths, plaintext secret values, or scoped environment variables.
**Dependencies:** None.
#### Task 1.3: Export shared contracts from the public API package entry point

**Description:** Update `packages/api-contract/src/index.ts` so execution and control-plane-facing code can import runner event schemas/types and declarative execution-context schemas/types without reaching into package internals.
**Acceptance criteria:**
- Runner event schemas and inferred types are exported.
- Declarative execution-context schemas and inferred types are exported.
- Existing api-contract exports remain available.
- Import tests or existing TypeScript checks prove consumers can import from `@autocatalyst/api-contract`.
**Dependencies:** Tasks 1.1 and 1.2.
#### Task 1.4: Add the narrow core secret read seam

**Description:** Add `packages/core/src/secret.ts` with a core-side `SecretResolver` and sanitized `SecretResolutionError`, then export them from `packages/core/src/index.ts`. This is the control-plane/persistence assembly contract; execution defines its own same-shaped materialization-time interface and accepts implementations by structural typing.
**Acceptance criteria:**
- `SecretResolver.resolveSecret(handle)` returns `Promise` and exposes no persistence-specific API.
- `SecretResolutionError` supports `missing_secret`, `locked`, `undecryptable`, and `unavailable` codes.
- Error messages and details include the declared handle but never include plaintext secret values.
- `packages/execution` does not import this core interface; any resolver passed to execution is accepted through the execution-owned same-shaped interface.
- Existing core exports and orchestrator behavior remain unchanged.
**Dependencies:** None.
#### Task 1.5: Implement declared-handle secret reads in persistence

**Description:** Extend `SqliteSecretStore` with `resolveSecret(handle)` that implements the core `SecretResolver` contract after the store is unlocked.
**Acceptance criteria:**
- A known handle resolves to plaintext only after unlock.
- A locked store throws `SecretResolutionError` with code `locked`.
- An unknown handle throws `SecretResolutionError` with code `missing_secret`.
- Decryption or authentication failures throw `SecretResolutionError` with code `undecryptable`.
- Tests assert plaintext and ciphertext are absent from thrown error messages, details, and snapshots.
**Dependencies:** Task 1.4.
### Story 2: Define the public execution runner and materialized environment API

#### Task 2.1: Replace the scaffold runner API with the streaming `Runner` contract

**Description:** Create or update `packages/execution/src/runner.ts` so the public runner boundary is `run(input): AsyncIterable` and `close(): Promise`.
**Acceptance criteria:**
- `Runner`, `RunnerRunInput`, `RunnerCloseResult`, `RunnerProtocolError`, and `RunnerProtocolErrorCode` are defined as public types.
- The old scaffold `Promise` shape is removed or superseded without leaving conflicting public exports.
- The runner input carries a `MaterializedExecutionEnvironment` and optional correlation id.
- Protocol errors use sanitized messages and stable machine-readable codes.
**Dependencies:** Tasks 1.1 and 1.3.
#### Task 2.2: Define public materialized environment and execution entry point types

**Description:** Add `packages/execution/src/materialized-environment.ts`, `packages/execution/src/secret-resolver.ts`, and `packages/execution/src/execution-entry-point.ts` with materialized environment types, the execution-owned materialization-time secret resolver interface, materialization options, execution entry point interface, and typed materialization errors.
**Acceptance criteria:**
- `MaterializedExecutionEnvironment` includes the declarative context, materialized workspace, scoped environment, materialized tool policy, skill intent, and capabilities with availability flags.
- Workspace shapes include `none`, `scratch_only`, and `two_roots` with distinct repo and scratch roots for `two_roots`.
- For `none`, `workspaceRoots` is empty and no workspace provisioning is required.
- For `scratch_only`, only `scratchRoot` is present and `workspaceRoots` contains only that root.
- The execution-owned secret resolver interface is structurally compatible with the core `SecretResolver` but has no import from `packages/core`.
- `ExecutionMaterializationErrorCode` includes missing workspace roots, workspace provisioning failure, secret resolution failure, unsupported workspace shape, and capability materialization failure codes.
- The execution entry point accepts the declarative `ExecutionContext` from `@autocatalyst/api-contract` and does not expose control-plane repositories or persistence internals to runners.
**Dependencies:** Tasks 1.2, 1.3, and 1.4.
#### Task 2.3: Export the execution public API surface

**Description:** Update `packages/execution/src/index.ts` to export the runner contract, materialized environment types, execution entry point API, stub runner API, protocol/materialization errors, and existing workspace APIs exactly through the public package entry point.
**Acceptance criteria:**
- Public exports include runner types, materialized environment types, execution entry point types/factory, stub runner types, protocol errors, and materialization errors.
- Existing workspace exports, including `provisionWorkspace`, `teardownWorkspace`, and `pruneWorkspacePath`, remain public.
- Control-plane packages can import only from `@autocatalyst/execution`, not `@autocatalyst/execution/src/*`.
**Dependencies:** Tasks 2.1 and 2.2; final export completion also depends on Stories 4 and 5.
### Story 3: Implement control-side declarative Execution Context resolution

#### Task 3.1: Build the resolver implementation shell in core

**Description:** Implement `packages/core/src/execution-context-resolver.ts` and wire `createExecutionContextResolver(options)` to return a resolver that produces declarative `ExecutionContext` values.
**Acceptance criteria:**
- Resolver construction or resolution fails with `invalid_secret_declaration` when declared secrets are malformed, duplicate environment names are supplied, or declared secrets exist without a materialization-time secret resolver declaration.
- Resolver requests combine `RunWorkInput`, prompt override, input override, and explicit resolver options into one declarative context.
- Unsupported work kinds fail with `unsupported_work_kind` rather than falling back silently.
- Unsupported workspace shapes fail with `unsupported_workspace_shape`.
- Errors are `ExecutionContextResolutionError` instances with sanitized messages and details.
- The resolver does not call `provisionWorkspace`, does not resolve secrets, and does not set capability availability flags.
**Dependencies:** Tasks 1.2 and 1.3.
#### Task 3.2: Resolve workspace intent for implementing runs

**Description:** In the core context resolver, select the workspace shape and gather the provisioning intent needed by execution materialization.
**Acceptance criteria:**
- Implementing runs produce a `two_roots` workspace intent with explicit project/workspace provisioning inputs.
- Resolver inputs provide the full declarative provisioning dependencies: project descriptor, root references, `topicSlug`, `shortRunId`, and optional `defaultBranch`.
- The declarative context does not include `repoRoot`, `scratchRoot`, `branchName`, or materialized checkout paths.
- Missing project data in the workspace provisioning intent fails with `missing_project`.
- Missing root references, `topicSlug`, `shortRunId`, or other required workspace settings fail with `missing_workspace_settings`.
- Workspace provisioning itself is not attempted in this story.
**Dependencies:** Task 3.1.
#### Task 3.2a: Resolve no-workspace and scratch-only workspace intent

**Description:** In the core context resolver, map question/no-workspace work to `none` workspace intent and file-issue/scratch-only work to `scratch_only` workspace intent.
**Acceptance criteria:**
- Question/no-workspace runs produce `workspaceIntent.shape: 'none'` with no provisioning payload.
- File-issue/scratch-only runs produce `workspaceIntent.shape: 'scratch_only'` with explicit scratch provisioning inputs.
- The declarative context for both shapes omits `repoRoot`, `scratchRoot`, `branchName`, and materialized checkout paths.
- Missing scratch provisioning inputs for `scratch_only` fail with `missing_workspace_settings`.
- Tests assert these shapes do not silently fall back to `two_roots`.
**Dependencies:** Task 3.1.
#### Task 3.3: Validate declared secret bindings without decrypting secrets

**Description:** Have the resolver validate declared secret handles and target environment variable names, then place only those declarations into `ExecutionContext.secretBindings`.
**Acceptance criteria:**
- Only declared handles are included; the resolver does not scan or copy `process.env`.
- Malformed declarations, duplicate environment names, and missing materialization-time secret resolver configuration fail before boundary crossing with `invalid_secret_declaration`.
- Secret values do not appear in the declarative context.
- Error messages, details, diagnostics, and test snapshots redact secret values.
- Tests prove a sentinel host environment variable is not exposed as a secret binding unless explicitly declared.
**Dependencies:** Tasks 1.4 and 3.1.
#### Task 3.4: Populate task, tool policy, skill intent, and capability requirements

**Description:** Complete resolver output for task prompt/inputs, broad but workspace-scoped tool policy intent, declared skill/plugin intent, and capability requirements for bash, canonical paths, and LSP.
**Acceptance criteria:**
- Task prompt and task inputs come from explicit request data or deterministic resolver defaults.
- Operational configuration influences resolver output but is not passed to the runner as free-form configuration.
- Default tool policy grants broad non-interactive permissions against the declared workspace scope only.
- Skill intent records requested skills and optional plugins even when the stub only echoes or records them.
- Capability requirements include bash, canonical repo/scratch paths where requested, and an LSP requested seam without starting a real shell or LSP server.
- The resolver does not set `available` flags.
**Dependencies:** Tasks 3.2 and 3.3.
#### Task 3.5: Test declarative context resolution behavior and sanitization

**Description:** Add targeted tests for context resolution success and failure cases.
**Acceptance criteria:**
- Tests cover two-root workspace intent, secret bindings, tool policy, skill intent, and capability requirements.
- Tests cover unsupported work kind, unsupported workspace shape, missing project, missing workspace settings, invalid secret declarations, and duplicate target environment variable names.
- Tests assert secret redaction and absence of ambient environment leakage.
- Tests assert the resolver does not call workspace provisioning or secret decryption.
- Tests do not require real model providers, network services, real shell provisioning, or real LSP provisioning.
**Dependencies:** Tasks 3.1 through 3.4.
### Story 4: Materialize execution environments and adapt runner streams

#### Task 4.1: Implement execution-side materialization

**Description:** Add `packages/execution/src/internal/execution-materializer.ts` and wire the public execution entry point to materialize declarative contexts before invoking a runner.
**Acceptance criteria:**
- The materializer accepts an `ExecutionContext` from `@autocatalyst/api-contract`.
- Implementing runs call `provisionWorkspace` with explicit project/workspace settings derived from workspace intent and execution-side root resolution.
- The materialized environment names `repoRoot`, `scratchRoot`, and `branchName` distinctly.
- `none` workspace intent does not call `provisionWorkspace` and materializes with `workspaceRoots: []`.
- `scratch_only` workspace intent does not create a repository checkout and materializes with only `scratchRoot` in `workspaceRoots`.
- Missing or unmappable root references fail with a sanitized materialization error.
- `WorkspaceProvisioningError` failures are wrapped as `workspace_provisioning_failed` without exposing sensitive paths beyond sanitized provisioner details.
- The materializer resolves only declared secrets through `SecretResolver` and injects them into scoped `environment.variables` with `secretVariableNames`.
- Missing, locked, unavailable, or undecryptable secrets fail before runner invocation with `secret_resolution_failed`.
- Capability `available` flags are set in the materialized environment.
**Dependencies:** Stories 1, 2, and 3.
#### Task 4.2: Implement runner event validation helpers

**Description:** Add validation helpers in `packages/core` or a shared public execution helper that validate events with `runnerEventSchema` and enforce stream protocol invariants without requiring `packages/execution` to import `packages/core`.
**Acceptance criteria:**
- Invalid events produce `RunnerProtocolError` with code `invalid_event`.
- Events whose `runId` differs from the dispatched run produce code `wrong_run`.
- A second terminal-result event produces code `duplicate_terminal_result`.
- Any event yielded after a terminal-result event produces code `event_after_terminal`; the adapter drains after terminal specifically to observe this violation.
- A completed stream without a terminal-result event produces code `missing_terminal_result`.
- Validation helpers do not mutate run state or call orchestrator APIs.
**Dependencies:** Tasks 1.1 and 2.1.
#### Task 4.3: Implement `ExecutionRunUnitOfWork` in core

**Description:** Add `packages/core/src/execution-run-unit-of-work.ts` with `ExecutionRunUnitOfWork` and `createExecutionRunUnitOfWork(options)` implementing core's `RunUnitOfWork` interface.
**Acceptance criteria:**
- The adapter resolves the declarative `ExecutionContext` before invoking execution.
- The adapter invokes only the public execution entry point from `@autocatalyst/execution`.
- `packages/execution` does not import `packages/core`.
- The adapter consumes the event stream through completion, requires exactly one terminal result, and rejects duplicate terminal or post-terminal events.
- Terminal directives map to core `RunWorkResult` values for `advance`, `needs_input`, and `fail`.
- The adapter does not call `applyDirective`, write `RunStep`, publish run-state transitions, or mutate persistence.
- The optional `onEvent` hook receives validated events in stream order and remains a telemetry hook, not state mutation.
**Dependencies:** Tasks 2.1, 2.2, 3.1, and 4.2.
#### Task 4.4: Handle materialization, runner failures, and close semantics

**Description:** Complete adapter and execution entry point error handling so materialization, runner creation, iteration, validation, and terminal mapping failures produce safe errors or failed unit-of-work results according to the contract.
**Acceptance criteria:**
- Control-side resolution failures reject before boundary crossing and do not leave the run partially transitioned.
- Materialization failures return across the boundary as sanitized failures and are mapped according to `### Error design`.
- `runner.close()` runs in a `finally` path after success, protocol failure, materialization failure after runner acquisition if applicable, and thrown runner errors.
- Runner-thrown errors before a terminal result map to a typed failed unit-of-work result with a sanitized reason, unless `runner.close()` also fails and the close-failure precedence rule applies.
- Runner-thrown errors after a terminal result while draining map to `RunnerProtocolError` code `runner_failed`.
- `needs_input` terminal results preserve the question field expected by the orchestrator.
- `fail` terminal results preserve a sanitized reason.
- Tests prove close is called on success and failure, and that close failure after an otherwise returnable result rejects with `RunnerProtocolError` code `runner_close_failed`.
**Dependencies:** Task 4.3.
#### Task 4.5: Test materialization, adapter protocol, and directive mapping

**Description:** Add targeted tests for materialization, terminal mapping, protocol errors, failure paths, and close behavior.
**Acceptance criteria:**
- Tests cover workspace materialization, declared secret injection, ambient environment exclusion, capability availability, and sanitized materialization failures.
- Tests cover `none` and `scratch_only` materialization, including whether `provisionWorkspace` is called and the exact `workspaceRoots` contents.
- Tests cover `advance`, `needs_input`, and `fail` terminal directives.
- Tests cover malformed event, wrong run id, duplicate terminal result, event after terminal when observed, missing terminal result, and thrown runner errors.
- Tests prove the adapter returns directives without applying them to run state.
- Tests prove `onEvent` receives validated events and does not receive malformed rejected events.
**Dependencies:** Tasks 4.1 through 4.4.
### Story 5: Provide the deterministic in-process stub runner

#### Task 5.1: Implement `StubRunner`

**Description:** Add `packages/execution/src/stub-runner.ts` with a deterministic in-process runner that emits representative typed events and one terminal result without model or network calls.
**Acceptance criteria:**
- The default stream emits `runner_progress`, `runner_assistant_turn`, `runner_step_checkpoint`, and exactly one `runner_terminal_result` in that order.
- The default terminal result is `{ directive: 'advance' }`.
- Event content is deterministic for a given run id, current step, clock, and event id generator.
- Constructor options support a clock, event id generator, and terminal directive override for tests.
- The stub receives `MaterializedExecutionEnvironment`, not the declarative context alone.
- The stub does not call model providers, external AI SDKs, or network services.
**Dependencies:** Tasks 2.1 and 2.2.
#### Task 5.2: Exercise workspace and capability seams safely in the stub

**Description:** Have the stub inspect the materialized environment enough to prove workspace roots and capabilities are wired, while avoiding filesystem access outside the materialized workspace roots.
**Acceptance criteria:**
- The stub can include workspace/capability facts in deterministic progress, assistant, or checkpoint event payloads.
- Any optional file access in the stub uses the execution workspace-root guard helper before reading or writing.
- The stub never reads or writes outside `repoRoot` or `scratchRoot` when workspace roots exist.
- The stub does not require real shell execution or a real LSP backend.
- Inconsistent materialized environment data that prevents valid event creation fails with sanitized `RunnerProtocolError`.
**Dependencies:** Task 5.1.
#### Task 5.3: Test stub stream behavior

**Description:** Add stub runner tests for deterministic output, terminal-result uniqueness, override behavior, close behavior, and safety constraints.
**Acceptance criteria:**
- Tests assert event order and event types without relying on brittle full snapshots.
- Tests assert exactly one terminal-result event.
- Tests cover `advance`, `needs_input`, and `fail` terminal override options.
- Tests prove `close()` resolves to the public `RunnerCloseResult` type.
- Tests verify the stub does not require provider credentials or network access.
**Dependencies:** Tasks 5.1 and 5.2.
### Story 6: Prove orchestrator dispatch through the execution boundary

#### Task 6.1: Wire explicit test construction for the core execution unit of work

**Description:** Build test helpers or integration setup that configures `DefaultOrchestrator` or `ControlPlaneService.tick` with the core `createExecutionRunUnitOfWork`, core `createExecutionContextResolver`, and an execution entry point backed by `StubRunner`.
**Acceptance criteria:**
- Tests can inject the unit of work without importing execution internals.
- Resolver options use explicit workspace intent inputs or a lookup returning project descriptor, root references, `topicSlug`, `shortRunId`, and optional `defaultBranch`, plus secret declarations, tool defaults, skill defaults, and capability requirements as needed by the test.
- Execution materialization options map root references to temporary local provisioning roots and provide a `SecretResolver` when secrets are declared.
- Production server behavior remains explicit: it either keeps accepting injected unit-of-work dependencies or clearly wires the stub as the temporary default without adding provider configuration.
- No branch, push, merge, PR, provider adapter, event persistence, or SSE runner re-streaming behavior is added.
**Dependencies:** Stories 3, 4, and 5.
#### Task 6.2: Add the temporary two-root workspace integration proof

**Description:** Add an integration test that dispatches a non-terminal implementing run through the orchestrator against a real temporary git repository and scratch workspace base.
**Acceptance criteria:**
- The test creates or uses a real temporary git repository suitable for `provisionWorkspace`.
- The test creates a non-terminal implementing run through existing orchestrator or service ingress seams.
- Dispatch resolves a declarative context before execution is invoked.
- Execution materialization invokes `provisionWorkspace` and resolves distinct repo and scratch roots.
- Dispatch consumes a typed runner event stream through successful completion with exactly one terminal-result event and no post-terminal events.
- The orchestrator applies the returned directive and advances the run to the next workflow step.
- The test observes events through the adapter's public telemetry hook or returned result path, not through execution internals.
**Dependencies:** Task 6.1.
#### Task 6.3: Preserve boundary protections

**Description:** Keep existing boundary rules passing while adding the core adapter and public execution/API imports.
**Acceptance criteria:**
- Control-plane code imports execution code only from `@autocatalyst/execution`.
- No control-plane package imports `@autocatalyst/execution/src/*` or internal execution modules.
- `packages/execution` does not import `packages/core`.
- Existing boundary tests continue to pass.
- The dependency graph remains acyclic with `packages/core` owning the `RunUnitOfWork` adapter and depending only on public execution and api-contract exports.
**Dependencies:** Tasks 2.3 and 4.3.
### Story 7: Update agent documentation and run validation

#### Task 7.1: Update the code map for new modules and seams

**Description:** Update `context-agent/wiki/code-map.md` with the runner event schemas, declarative `ExecutionContext` schemas, core context resolver, core unit-of-work adapter, materialized environment, execution entry point, materializer, stub runner, and secret-read seam.
**Acceptance criteria:**
- The code map points future agents to all new or significantly changed modules.
- The entry documents that the adapter lives in `packages/core`, while execution owns materialization and runner invocation.
- The entry documents that runner event persistence, SSE re-streaming, real providers, model routing, hardened shell/LSP backends, and result tolerance remain out of scope.
**Dependencies:** Stories 1 through 6.
#### Task 7.2: Run targeted and boundary validation

**Description:** Run the focused test suites for the new contracts and the existing boundary checks, then run the broader project validation that is practical for the repository.
**Acceptance criteria:**
- Runner event schema tests pass.
- Declarative execution-context schema tests pass.
- Secret resolver tests pass.
- Core Execution Context resolver tests pass.
- Execution materializer tests pass.
- Stub runner tests pass.
- Core execution unit-of-work adapter tests pass.
- The orchestrator dispatch integration test passes.
- Existing boundary validation, including `pnpm test:boundaries` if available, passes.
- Any skipped validation is recorded with the exact reason.
**Dependencies:** Task 7.1.