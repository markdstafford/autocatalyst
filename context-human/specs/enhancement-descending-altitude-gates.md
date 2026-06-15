---
created: 2026-06-15
last_updated: 2026-06-15
status: complete
issue: 61
specced_by: autocatalyst
---
# Enhancement: Descending altitude gates for implementation convergence

## Product requirements

### What

Autocatalyst should run `implementation.build` through a configured ladder of descending altitude gates before it advances to human implementation review. The ladder is selected from workflow step data and maps depth to ordered gates:
- `build_only` → `build`
- `layout` → `layout`, `build`
- `public_api` → `layout`, `public_api`, `build`
- `full` → `layout`, `public_api`, `private_api`, `build`
Each altitude runs the existing in-step implementer/reviewer convergence loop from issue 59. The run cannot descend to a lower altitude until the current altitude has converged or escalated. Between accepted gates, the host captures an internal git ref checkpoint so later gates can compare the build result against accepted earlier contracts.
Early altitudes constrain what the implementer may commit. `layout`, `public_api`, and `private_api` allow declarations, signatures, interfaces, exported shapes, and source layout. They reject function or method bodies, executable statements, and tests. The final `build` altitude admits full implementation and validates that accepted earlier contracts did not drift.
### Why

The current convergence loop reviews a whole implementation step. That is useful, but it still lets structural and API choices form at the same time as implementation details. Issue 61 adds the finer quality mechanism described in the workflow and review concepts: converge on layout first, then public API, then private API, then complete code.
This keeps hard-to-reverse decisions visible earlier. It also gives the build gate a concrete contract to preserve. If a later round removes or renames an export accepted at `public_api`, the build gate should block the run instead of letting a final diff hide that drift.
### Goals

- Let `implementation.build` read an optional depth config from the existing workflow convergence policy path.
- Preserve issue 59 behavior when no depth is configured: one build-altitude convergence loop.
- Run the existing implementer/reviewer round loop independently at each selected altitude.
- Block descent until the current altitude converges, escalates, or fails safely.
- Enforce deterministic early-altitude contracts that reject bodies, executable statements, and test files.
- Capture host-owned internal git refs between accepted altitude gates.
- Record each checkpoint's altitude, ref, and commit in durable run-step convergence data.
- Detect build-time contract drift against accepted earlier checkpoints, including removed or renamed source files, exports, public type shapes, and private helper signatures when `private_api` depth is configured.
- Apply altitude-scoped finding filtering so only findings relevant to the current altitude block that altitude.
- Persist deterministic altitude contract and drift findings as first-class `Feedback` through the existing convergence-feedback path.
- Extend convergence round records to include the altitude for each round and the accepted checkpoint refs.
- Prove the behavior with real production-path coverage, including a happy path and a forced-drift path.
### Non-goals

- Automatically selecting depth from a complexity classifier.
- Expressing altitude gates as separately composed workflow steps.
- Parallel reviewers within one altitude.
- Human reply handling for advancing or revising after a convergence escalation.
- Letting agents create checkpoint refs, switch branches, push, merge, or open pull requests.
- Adding new UI screens or visual components.
- Building provider-specific read-only guarantees beyond the existing reviewed-dispatcher contract; providers that cannot enforce reviewer read-only access must fail safely or grant no file/git access.
### Personas

#### Enzo

- **Role:** Engineer maintaining workflow, orchestration, convergence, and workspace-git code.
- **Cares about:** Reusing the issue 59 convergence engine without turning each altitude into a bespoke workflow step.
- **Constraints:** Needs depth, altitude contracts, checkpoints, and drift checks to stay data-driven and testable.
#### Phoebe

- **Role:** Human reviewer at the implementation gate.
- **Cares about:** Seeing whether the run followed the agreed layout/API contracts and which findings blocked or did not block each gate.
- **Constraints:** Should not need to inspect raw git refs or provider logs to understand why the build is held.
#### Opal

- **Role:** Operator watching real runs.
- **Cares about:** Bounded cost, safe pauses, sanitized diagnostics, and no agent-owned git refs.
- **Constraints:** Needs deterministic failures for contract violations and provider/tool-policy limitations.
### Narratives

#### Enzo configures the full ladder

Enzo configures `implementation.build` with depth `full`. A run reaches the step and starts at `layout`. The implementer creates source files and declarations but no bodies. The critic reviews only layout-level concerns. Autocatalyst validates the diff deterministically, accepts the gate, and captures a host-owned internal checkpoint ref.
The run then descends through `public_api`, `private_api`, and `build`. Each altitude gets its own bounded convergence loop and durable round records. Enzo can inspect the step checkpoint and see which altitude each round ran at and which internal refs were captured between gates.
#### Phoebe reviews a blocked build drift

Phoebe opens a run at the implementation gate and sees that the build gate is held. The earlier `public_api` checkpoint accepted an exported function named `createWidget`. During `build`, the implementer renamed it to `makeWidget`. The drift checker raised a blocking finding against the build altitude.
The finding appears as normal implementation feedback with the gate and source-path context. Phoebe can see that the critic did not invent the contract; Autocatalyst compared the build result to an accepted earlier checkpoint.
#### Opal verifies a clean depth fallback

Opal runs an older workflow with no depth configured. `implementation.build` behaves as it did after issue 59: one convergence loop at `build`. No early-altitude validators run, no ladder checkpoint refs are required, and the run advances on convergence. Opal gets compatibility without changing existing workflow data.
### User stories

- As Enzo, I want implementation depth to be configured on `implementation.build`, so workflows can choose how much incremental convergence a run needs.
- As Enzo, I want each altitude to reuse the existing convergence loop, so implementer/reviewer behavior stays consistent across gates.
- As Enzo, I want deterministic early-altitude validation, so layout and API gates cannot sneak in bodies, executable code, or tests.
- As Enzo, I want the host to capture internal git refs after accepted gates, so later gates have stable comparison points.
- As Phoebe, I want drift findings to appear as normal `Feedback`, so model, deterministic, and human feedback use one review model.
- As Phoebe, I want altitude and checkpoint data in the round record, so I can tell where each finding came from.
- As Opal, I want `info` and out-of-scope findings to be non-blocking at early gates, so runs do not stall on work that belongs to a lower altitude.
- As Opal, I want old workflows with no depth config to behave unchanged, so the rollout does not surprise existing runs.
- As Opal, I want a production-path end-to-end proof of a clean ladder and a forced drift, so the feature proves the implementer/reviewer dispatch path and not only unit-tested policy code.
### Acceptance criteria

- `implementation.build` reads an optional depth config as per-step workflow data extending `StepConvergencePolicy` and `getStepConvergencePolicy`.
- With no depth configured, `implementation.build` behaves like issue 59: one build-altitude convergence loop.
- Depth maps to altitude ladders exactly as: `build_only` → `[build]`; `layout` → `[layout, build]`; `public_api` → `[layout, public_api, build]`; `full` → `[layout, public_api, private_api, build]`.
- Each altitude runs the issue 59 implementer/reviewer round loop to convergence or escalation before the next altitude starts.
- The run does not reach a lower altitude until the current altitude is accepted.
- Early-altitude validation runs at `layout`, `public_api`, and `private_api` after each implementer commit and before reviewer acceptance.
- Early-altitude validation admits declarations, signatures, interface/type shapes, source layout, and other non-executable contract shapes.
- Early-altitude validation rejects function or method bodies, executable statements, and test files.
- Early-altitude violations become blocking deterministic findings that hold the current altitude and are persisted as `Feedback`.
- Deterministic altitude-contract and build-drift findings are recomputed from the committed diff each round and clear only when the committed work complies.
- Deterministic altitude-contract and build-drift findings cannot be declined, dismissed, or made non-blocking by implementer dispositions; only model reviewer findings flow through the implementer decline/disposition unblock path.
- The `build` altitude admits complete implementation work.
- After each accepted non-final gate, the host captures an internal git ref under a run-scoped `refs/autocatalyst/...` namespace.
- Agents never create internal refs; the host git port owns checkpoint capture.
- Durable convergence data records each accepted checkpoint's altitude, ref, and commit.
- Build-contract preservation runs at the `build` altitude.
- Build-contract preservation raises blocking findings for removed, renamed, or changed accepted source file paths, exported names, public signatures, public type shapes, and private helper signatures covered by the configured depth. Accepted source file paths are immutable for this v0 contract; moving an accepted contract to a new path is treated as removal plus addition and blocks even if an equivalent export exists at the new path.
- Adding new exports and filling in bodies is allowed at `build` unless it changes an accepted earlier contract.
- Altitude-scoped filtering makes `info` findings non-blocking at every altitude.
- At early altitudes, findings outside the gate allowlist or scoped to a lower altitude are recorded as non-blocking notes.
- Build-gate findings are unfiltered except for `info` severity remaining non-blocking.
- Round records include the altitude each round ran at.
- Round numbering resets per altitude, with `altitude` as the discriminator in the checkpoint's flat `rounds` array.
- The convergence checkpoint includes altitude checkpoint refs and accepted commits.
- Deterministic altitude-contract and drift findings flow through `packages/core/src/convergence-feedback.ts` as first-class `Feedback`.
- Shared schemas in `packages/api-contract/src/convergence.ts` and `packages/api-contract/src/run-step.ts` validate the new altitude and checkpoint data.
- Required non-skippable CI production-path smoke positions a run at `implementation.build` with full depth on a real workspace and git branch, using the production orchestrator and role dispatcher with a deterministic scripted provider adapter at the provider-response seam. It does not require live provider credentials.
- The required non-skippable CI production-path smoke proves a happy path descending `layout → public_api → private_api → build`, with implementer dispatch creating commits at each altitude, reviewer dispatch reviewing each altitude, checkpoint refs captured between altitudes, build converged, and the run advanced.
- The required non-skippable CI production-path smoke proves a forced-drift path where the build result renames or removes an export or accepted source path from an earlier checkpoint, raising a blocking build finding and holding convergence.
- The required non-skippable CI production-path smoke proves early altitudes reject a body or test as a contract violation.
- Deterministic non-live production-path coverage may use scripted provider responses, but it must still exercise the production orchestrator, role dispatcher, altitude prompts/context, session records, workspace git commits/refs, feedback persistence, run-step persistence, deterministic validators, drift checker, and run transitions. It must not inject altitude outcomes, bypass implementer/reviewer dispatch, bypass prompt construction, or directly seed findings as the ladder result.
- Optional live-provider smoke variants may run the same happy-path and forced-drift scenarios with real provider credentials, but they are not the non-skippable acceptance gate and may be skipped when credentials are absent.
- `context-agent/wiki/code-map.md` is updated during implementation for altitude policy, validation, checkpoint, drift, filtering, and tests.
### Non-functional requirements

- **Safety:** Checkpoint refs are host-owned. Agents do not switch branches, create refs, push, merge, or manage PRs.
- **Security:** Logs and failures do not include raw provider output, prompts, secrets, credential handles, file dumps, or unsanitized shell output.
- **Compatibility:** Existing reviewed-step behavior remains unchanged when no depth config is present.
- **Determinism:** Altitude contracts, finding filtering, checkpoint capture, and drift detection are deterministic host behavior.
- **Durability:** Accepted checkpoint metadata and per-round altitude data persist before the run descends.
- **Cost control:** Max-round and oscillation bounds apply per altitude. A full ladder has a worst-case ceiling of roughly four times `maxRounds` implementer/reviewer pairs, so depth remains configured data.
- **Observability:** Sessions, round records, findings, checkpoints, and logs should identify run, step, altitude, role, and round where practical.
### Devil's advocate pass

- **The largest risk is overloading the existing convergence checkpoint.** The current checkpoint schema stores rounds and outcomes for one build-depth loop. Adding altitude rounds and accepted refs must stay structured enough for review surfaces and drift detection to trust it.
- **Early-altitude validation can be brittle if implemented as simple text matching.** The validator should prefer language-aware or parser-backed checks where available, with conservative fallback behavior and targeted tests for TypeScript source shapes.
- **Build drift detection needs a precise contract boundary.** It should compare accepted source paths, public exports, and signatures, not arbitrary formatting. Accepted source paths are immutable for v0. Private helper checking should only run when `private_api` depth created an accepted private contract.
- **Altitude filtering must not hide real blockers.** Findings demoted at early gates should remain visible as notes, and build must review the full result without early-gate allowlists.
- **The production-path end-to-end test can become expensive or flaky.** The acceptance suite must include a required non-skippable CI smoke for the full ladder's happy path and forced drift. It may use scripted provider responses at the provider-response seam, but those scripts must pass through the real dispatcher and prompt/session machinery so a missing altitude prompt or broken per-altitude dispatch cannot be hidden. Live-provider variants are supplemental and may remain environment-gated.
### Reviewer pass

This enhancement fits ADR-025 because implementation depth remains workflow data and `implementation.build` stays the closing implementation step. It fits ADR-026 because each altitude reuses the implementer/reviewer loop within the step. It preserves the issue 59 fallback for workflows without depth config, which lowers rollout risk.
The design intentionally keeps altitude gates inside `implementation.build` for this slice. It does not introduce separately composed workflow steps for layout or API definition. That keeps issue 61 focused on the v0 depth model described in the issue while leaving workflow-step composition as a future design edge.
## Design spec

### Design scope

This is a backend workflow and orchestration enhancement. It adds no user interface components. The design covers run behavior, altitude selection, per-altitude convergence, deterministic contract validation, host checkpoint refs, build-time drift detection, altitude-scoped findings, and durable records that future review surfaces can render.
### User flows

#### Flow 1: No depth configured

1. A run reaches `implementation.build`.
2. The workflow has no depth value for the step.
3. Autocatalyst selects the implicit `build_only` ladder.
4. The existing convergence loop runs once at `build`.
5. No early-altitude validation or inter-gate internal ref is required.
6. The run advances or escalates exactly as issue 59 behavior allows.
#### Flow 2: Full ladder converges cleanly

1. A run reaches `implementation.build` with depth `full`.
2. Autocatalyst expands the ladder to `layout`, `public_api`, `private_api`, `build`.
3. The `layout` altitude runs implementer/reviewer rounds.
4. After each implementer commit, the altitude validator checks that the diff contains only layout-level declarations and no bodies or tests.
5. The altitude converges.
6. The host captures an internal checkpoint ref for the accepted layout state.
7. The run repeats the same pattern for `public_api` and `private_api`.
8. The `build` altitude fills in bodies and tests.
9. Build-contract preservation compares the final state to the accepted earlier checkpoints.
10. No drift is found, the build altitude converges, and the run advances to `implementation.human_review`.
#### Flow 3: Early altitude violates its contract

1. A run is at `public_api`.
2. The implementer commits an exported function with a body or adds a test file.
3. The host validator detects executable code or test files in the committed diff.
4. Autocatalyst creates a deterministic blocking finding for the current altitude.
5. The finding is persisted as implementation feedback and included in the next implementer round.
6. The run stays at `public_api` until the implementer removes the violation or the loop escalates.
#### Flow 4: Build drifts from an accepted public API checkpoint

1. The `public_api` altitude accepts an export and captures a checkpoint ref.
2. At `build`, the implementer renames or removes that export while filling in code.
3. The drift checker compares the build state against the accepted `public_api` checkpoint.
4. Autocatalyst raises a blocking build finding that names the changed contract.
5. The build altitude remains unconverged until the implementer restores the accepted contract or a human resolves the escalation.
#### Flow 5: Early reviewer reports lower-altitude concerns

1. The `layout` altitude reviewer reports a finding about an implementation detail that belongs at `build`.
2. Altitude filtering records the finding as a non-blocking note because it is outside the `layout` allowlist.
3. The finding remains visible in the round record and feedback model.
4. The layout altitude can still converge if no layout-scoped blockers remain.
### States and behavior

- `implementation.build` remains the run step shown in the workflow machine.
- Altitude is sub-step execution state inside the convergence checkpoint, not a new `Run.currentStep` value.
- `build_only` is the compatibility mode and the default when depth is absent.
- Early altitudes are accepted only after model review convergence plus deterministic altitude validation.
- Accepted early altitudes produce host-owned internal refs.
- `build` is the only altitude that can produce complete bodies, executable statements, and tests.
- Max-round or oscillation escalation pauses through the existing `implementation.build` `needs_input` transition to `implementation.awaiting_input`.
- Deterministic findings use the same feedback target as implementation reviewer findings.
- Deterministic findings are system-authored feedback. This extends the review model, which primarily describes model-authored findings, with a system principal for host-computed contract and drift findings.
- Deterministic findings are not reviewer findings for disposition purposes: the implementer may explain or fix them, but cannot decline them. They are recomputed from the current committed state each round and stop blocking only after the validator or drift checker no longer emits them.
- Deterministic finding identity is stable across rounds. The host computes a deterministic key from `source`, `ruleId`, `altitude`, normalized source path, symbol name when known, accepted checkpoint altitude/ref when relevant, and a canonical signature of the violation. Re-emitting the same key updates or reuses the existing open `Feedback` instead of creating duplicate open feedback.
- When a deterministic key emitted in a prior round is no longer emitted for the current committed state, the host auto-resolves that deterministic `Feedback` with a system resolution reason such as `deterministic_check_passed`. It is then removed from `openFeedbackIds` and no longer blocks human or altitude gates. If the feedback repository cannot persist a resolved status yet, the checkpoint must still omit the stale id from `openFeedbackIds` and record resolution metadata in the round finding; implementations should add status persistence rather than leaving stale deterministic feedback open.
- A finding's blocking status is evaluated against the current altitude and severity.
### Components and interactions

- **Layered convergence policy:** Extends step convergence policy with implementation depth and maps depth to altitude arrays.
- **Layered convergence coordinator:** Iterates selected altitudes and invokes the existing convergence engine mechanics for each altitude.
- **Altitude context:** Supplies current altitude, allowed finding categories, prior checkpoint metadata, and contract rules to role dispatch and validators.
- **Altitude contract validator:** Deterministically validates early-altitude diffs and emits blocking findings for bodies, executable statements, and tests.
- **Finding filter:** Applies altitude allowlists and severity rules before the convergence gate decides whether the altitude can advance.
- **Git checkpoint port:** Captures host-owned internal refs for accepted altitudes and can resolve commits/trees at those refs for later comparison.
- **Build contract preservation checker:** Compares build state to accepted checkpoints and emits blocking drift findings.
- **Convergence feedback writer:** Persists reviewer, altitude-contract, and drift findings as `Feedback`.
- **Run-step checkpoint recorder:** Stores altitude rounds, accepted checkpoint refs, open feedback ids, and final outcome in `RunStep.checkpointResult`.
- **Production-path tests:** Drive the real coordinator through workspace git, persistence, route dispatch, checkpoint refs, validation, feedback, and transition behavior.
### Altitude allowlists

- `layout` blocks only findings about source layout, module boundaries, missing or misplaced files, declaration skeletons, and contract violations for executable code or tests.
- `public_api` blocks findings about exported names, public signatures, public types, public constants, source paths that define public surface, and contract violations.
- `private_api` blocks findings about internal helper signatures, internal type shapes, module-private contracts, and contract violations.
- `build` evaluates all implementation findings except `info`, which remains non-blocking.
The exact category names should be shared contract data so model findings, deterministic findings, and filters agree on vocabulary.
### Accessibility and responsive behavior

No UI work is included. Future surfaces should render altitude, severity, blocking status, checkpoint ref, and disposition with readable labels and keyboard-accessible navigation.
### Design system updates

None.
### Reviewer pass

The design keeps the human-visible workflow simple: the run is still at `implementation.build` until it either advances to implementation review or pauses for input. Altitudes are durable execution detail, not extra top-level steps. This avoids workflow churn while still making each accepted gate auditable.
The main design pressure is whether deterministic validators and model reviewers both create findings. They should. The source differs, but the review model should not. A contract violation, a model critique, and a drift finding all become feedback with enough metadata to explain why they blocked or did not block an altitude.
## Tech spec

### Overview

Extend the issue 59 reviewed-step convergence implementation so `implementation.build` can run a layered altitude ladder. The current code already has these anchors:
- `packages/core/src/convergence-engine.ts` runs bounded implementer/reviewer rounds for reviewed producing steps.
- `packages/core/src/convergence-policy.ts` resolves `maxRounds` from workflow step policy.
- `packages/core/src/run-workflows.ts` carries optional `convergence` data per workflow step.
- `packages/api-contract/src/convergence.ts` defines reviewer findings, dispositions, round records, and convergence checkpoints.
- `packages/core/src/run-workspace-git.ts` defines the host workspace git port and reviewer read-only policy.
- `apps/control-plane/src/run-workspace-git-port.ts` provides the concrete git implementation.
- `packages/core/src/convergence-feedback.ts` maps reviewed findings to `Feedback`.
- `DefaultOrchestrator.#isReviewedProducingStep` currently scopes reviewed dispatch to `implementation.build`.
Issue 61 should layer altitude behavior around the existing engine path instead of replacing it. The cleanest implementation is to introduce a layered coordinator that uses the same role dispatcher, git port, feedback repository, run-step repository, routing resolver, policy resolver, and logger already composed for convergence.
### Architecture

#### Policy model

Extend `StepConvergencePolicy` with a depth field for `implementation.build`:
```typescript
export const implementationConvergenceDepthSchema = z.enum([
  'build_only',
  'layout',
  'public_api',
  'full'
]);

export type ImplementationConvergenceDepth = z.infer;

export interface StepConvergencePolicy {
  readonly maxRounds?: number;
  readonly depth?: ImplementationConvergenceDepth;
}
```
`getStepConvergencePolicy(workflow, step)` should return `depth: 'build_only'` when depth is absent. A helper such as `getImplementationAltitudeLadder(policy)` should return:
```typescript
type ImplementationAltitude = 'layout' | 'public_api' | 'private_api' | 'build';
```
The depth value is meaningful only for `implementation.build`. If other steps set it, the policy resolver can ignore it or validate workflow definitions in tests.
#### Layered coordinator

Add `packages/core/src/layered-convergence-engine.ts` or a similarly named module. It should own altitude iteration and leave per-round role dispatch to the existing convergence code. Two implementation approaches are viable:
1. Refactor `createConvergenceEngine` so it can run one altitude when given an `altitudeContext` and return an accepted-altitude result.
2. Wrap the existing engine with a coordinator that invokes an altitude-aware round runner extracted from `convergence-engine.ts`.
Prefer the first approach if it avoids duplicating round logic. The core invariant is one round loop implementation; altitude should be context, not a copy of the engine.
Coordinator algorithm:
1. Resolve policy and ladder.
2. If ladder is `[build]`, run the current convergence path with `altitude: 'build'` and no required early checkpoint comparison.
3. For each altitude in order:
	1. Run the implementer/reviewer loop with current altitude context.
	2. After each implementer commit in early altitudes, run deterministic altitude-contract validation.
	3. Recompute deterministic findings from the committed diff, persist them before the convergence gate evaluates blocking status, and keep them outside the implementer declined-finding signature path.
	4. Apply altitude-scoped finding filtering.
	5. On convergence of a non-final accepted altitude, capture a host git checkpoint ref.
	6. Record accepted checkpoint metadata in the run-step checkpoint.
	7. Descend to the next altitude.
4. At `build`, run build-contract preservation before convergence can be accepted.
5. Return the existing `RunWorkResult` directive: `advance` on clean build convergence, `needs_input` on max-round or oscillation escalation, `needs_input` on recoverable checkpoint-capture failure after one or more accepted non-final altitudes, or `fail` on configuration/validation/git failures that cannot be represented as convergence findings or safely retried.
#### Keeping `Run.currentStep` stable

Do not add `implementation.layout`, `implementation.public_api`, or `implementation.private_api` workflow steps. The run remains at `implementation.build` while the checkpoint records `currentAltitude`, per-round altitudes, and accepted checkpoints. This matches the issue's v0 model and avoids transition table changes.
#### Orchestrator selection

`DefaultOrchestrator` should still route only eligible reviewed steps to the convergence path. Since issue 61 is scoped to `implementation.build`, reviewed dispatch can remain scoped to that step unless another approved issue wires `spec.author` convergence. The layered coordinator should be composed in the same place as the current convergence engine so production dispatch gets depth behavior automatically.
### Data contracts

#### Altitude and category schemas

Extend `packages/api-contract/src/convergence.ts` with shared schemas:
```typescript
export const implementationAltitudeSchema = z.enum(['layout', 'public_api', 'private_api', 'build']);
export const implementationConvergenceDepthSchema = z.enum(['build_only', 'layout', 'public_api', 'full']);
export const convergenceFindingSourceSchema = z.enum(['reviewer', 'altitude_contract', 'build_drift']);
export const convergenceFindingCategorySchema = z.enum([
  'layout',
  'public_api',
  'private_api',
  'build',
  'contract_violation',
  'build_drift'
]);
```
Extend reviewer findings or convergence round findings with optional altitude metadata:
```typescript
type ConvergenceRoundFinding = ReviewerFindingContext & {
  source?: 'reviewer' | 'altitude_contract' | 'build_drift';
  altitude?: ImplementationAltitude;
  category?: ConvergenceFindingCategory;
  blocking: boolean;
  signature: string;
  blockingReason?: string;
};
```
#### Round records

Extend `convergenceRoundRecordSchema` with `altitude`:
```typescript
type ConvergenceRoundRecord = {
  round: number;
  altitude: ImplementationAltitude;
  implementerSessionId?: string;
  reviewerSessionId?: string;
  implementerCommitSha?: string | null;
  changedFileCount: number;
  findings: ConvergenceRoundFinding[];
  dispositions: FindingDisposition[];
  outcome: 'continue' | 'converged' | 'max_rounds' | 'oscillation';
};
```
Round numbering resets for each altitude. The flat `rounds` array is disambiguated by the required `altitude` field, so `{ altitude: 'public_api', round: 1 }` and `{ altitude: 'build', round: 1 }` are distinct records. Max-round and oscillation detection use the per-altitude round sequence, not the whole-step array. With `full` depth, the worst-case cost ceiling is approximately `4 × maxRounds` implementer/reviewer pairs.
#### Accepted checkpoints

Add a durable checkpoint record:
```typescript
type AltitudeCheckpointRef = {
  altitude: 'layout' | 'public_api' | 'private_api';
  ref: string;
  commitSha: string;
  acceptedAt: string;
};
```
Extend `ConvergenceCheckpoint`:
```typescript
type ConvergenceCheckpoint = {
  kind: 'convergence_review';
  step: string;
  maxRounds: number;
  depth?: ImplementationConvergenceDepth;
  currentAltitude?: ImplementationAltitude;
  acceptedCheckpoints?: AltitudeCheckpointRef[];
  rounds: ConvergenceRoundRecord[];
  outcome: 'converged' | 'max_rounds' | 'oscillation' | 'needs_input';
  openFeedbackIds: string[];
  lastPositions: { implementer?: string; reviewer?: string };
};
```
Keep `RunStep.checkpointResult` as typed JSON. Validate `kind: 'convergence_review'` payloads at the repository boundary before persistence.
`openFeedbackIds` contains only feedback ids that are blocking or still open for the current committed state. Deterministic `altitude_contract` and `build_drift` ids from prior rounds are removed from `openFeedbackIds` when the recomputed validator/checker output no longer includes their deterministic key. Reviewer-authored feedback continues to follow the existing reviewer/disposition lifecycle.
### Host git checkpoint port

Extend `RunWorkspaceGitPort` with internal-ref and read-at-ref capabilities:
```typescript
interface RunWorkspaceGitPort {
  commitFiles(input: RunWorkspaceCommitFilesInput): Promise;
  captureCheckpointRef(input: CaptureCheckpointRefInput): Promise;
  readFileAtRef(input: ReadFileAtRefInput): Promise;
  listFilesAtRef(input: ListFilesAtRefInput): Promise;
  readonly reviewerPolicy: ReviewerWorkspacePolicy;
}

type CaptureCheckpointRefInput = {
  runId: string;
  workspaceRepoRoot: string;
  altitude: Exclude;
  commitSha: string;
};

type CaptureCheckpointRefResult = {
  ref: string;
  commitSha: string;
};
```
The concrete implementation in `apps/control-plane/src/run-workspace-git-port.ts` should use argument-array git commands, containment checks, and a ref namespace like:
```plain text
refs/autocatalyst/runs//implementation.build//
```
The port must not switch branches, push, merge, or expose ref creation to agents. It should reject invalid run ids or altitude segments that could escape the namespace.
### Altitude contract validation

Add `packages/core/src/altitude-contract-validator.ts`. It should inspect the implementer's committed diff for early altitudes and return deterministic findings, not throw for ordinary contract violations.
Validation inputs:
```typescript
type ValidateAltitudeContractInput = {
  altitude: 'layout' | 'public_api' | 'private_api';
  workspaceRepoRoot: string;
  baseRef?: string;
  headCommitSha: string;
  changedFiles: readonly string[];
};
```
Validation rules:
- Reject added or modified test files at early altitudes. Treat common patterns such as `*.spec.ts`, `*.test.ts`, `__tests__/`, and test directories as tests.
- Reject function and method bodies in TypeScript source at every early altitude.
- Reject executable top-level statements at early altitudes.
- Allow type declarations, interfaces, exported signatures, ambient declarations, and source file creation.
- Allow comments and imports that are needed to express types.
- At `private_api`, allow private/internal signatures and helper shapes, but still reject bodies and tests.
The validator should use this AST-level contract table:

File or syntax kind
Early-altitude behavior

`.ts` and `.tsx` files
Parse with the TypeScript compiler API. Parse failure emits a blocking `altitude_contract` finding with a safe message.

Test files (`*.spec.*`, `*.test.*`, `__tests__/`, test directories)
Always blocking at `layout`, `public_api`, and `private_api`, including declaration-only content.

`.tsx` JSX syntax
Blocking. TSX files may contain type-only declarations, but JSX elements/expressions are executable/renderable implementation.

Non-TypeScript source files (`.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.go`, `.rs`, etc.)
Conservative blocking when added or modified at early altitudes unless the implementation explicitly adds a parser-backed allowlist with equivalent body/statement checks.

Generated or vendored files
Blocking when added or modified at early altitudes unless the path is already marked generated/vendor and unchanged from the comparison base; generated changes belong at `build`.

Comments, whitespace, `import type`, `export type`, type-only named imports/exports
Allowed.

Side-effect imports (`import './setup'`) and value imports/exports used at runtime
Blocking unless they are inside an ambient declaration file and do not emit runtime code.

Interfaces, type aliases, ambient module/namespace declarations, `declare` functions/classes/constants/enums
Allowed when they contain no executable initializer or body.

Function, method, constructor, accessor, arrow-function, and function-expression bodies
Blocking. Overload signatures and ambient `declare function` signatures are allowed.

Class declarations
Allowed only when ambient (`declare`) or when every member is a non-emitting declaration/signature. Method/accessor/constructor bodies, static blocks, decorators, and field initializers are blocking.

Field/property declarations
Allowed only with no initializer and no decorator; definite-assignment/type annotations are allowed.

Constants, variables, and top-level `const`/`let`/`var`
Allowed only as ambient declarations such as `declare const NAME: Type`. Runtime initializers, including literal initializers, are blocking.

Enums
`declare enum` is allowed. Runtime `enum` and `const enum` declarations are blocking unless the extractor proves they are non-emitting under the project compiler options; the v0 validator should block them.

Top-level expression, control-flow, loop, `try`, `throw`, `return`, `await`, assignment, call, or new-expression statements
Blocking.

Prefer TypeScript AST parsing for `.ts`/`.tsx` files over regular expressions. If parsing fails, return a blocking contract finding with a safe message rather than accepting an unknown executable shape.
### Build contract preservation

Add `packages/core/src/build-contract-preservation.ts`. It should compare the final build state to accepted checkpoints.
Inputs:
```typescript
type ValidateBuildContractInput = {
  workspaceRepoRoot: string;
  buildCommitSha: string;
  acceptedCheckpoints: readonly AltitudeCheckpointRef[];
};
```
Checks:
- Source file paths present at accepted checkpoints are immutable for this v0 contract. A removed or renamed accepted source path blocks, even when an equivalent export or type appears at a new path.
- Public exports accepted at `public_api` still exist at `build`.
- Public function, method, class, interface, type alias, enum, and constant signatures/types accepted at `public_api` remain compatible.
- Private helper signatures accepted at `private_api` remain compatible when full depth included `private_api`.
- Bodies may be added at `build`.
- New exports may be added at `build`.
- Formatting-only differences do not block.
Prefer AST extraction of TypeScript export/type signatures. Store or compute a canonical signature representation so comparison is not sensitive to whitespace. Drift findings should include source path, symbol name when known, accepted altitude, accepted ref, and build commit.
### Altitude-scoped finding filtering

Add `packages/core/src/layered-finding-filter.ts`. It should take raw reviewer findings plus deterministic findings and return persisted findings with blocking decisions.
Suggested shape:
```typescript
type FilterAltitudeFindingsInput = {
  altitude: ImplementationAltitude;
  findings: readonly ReviewerFinding[];
};

type FilteredFinding = ReviewerFinding & {
  source: 'reviewer' | 'altitude_contract' | 'build_drift';
  category?: ConvergenceFindingCategory;
  blocking: boolean;
  blockingReason?: string;
};
```
Rules:
- `info` never blocks.
- `layout` allows layout and contract-violation blockers only.
- `public_api` allows public API and contract-violation blockers only.
- `private_api` allows private API and contract-violation blockers only.
- `build` leaves all non-`info` findings blocking, including build drift.
- Deterministic `altitude_contract` and `build_drift` findings are always recomputed for the current committed state and are not eligible for implementer disposition decline. A deterministic finding may be non-blocking only when the deterministic rule itself classifies it as non-blocking; implementer dispositions must not alter that status.
- Out-of-allowlist early-altitude findings are persisted as non-blocking notes with a reason such as `outside_altitude_scope`.
- Findings scoped to lower altitudes are non-blocking until that lower altitude runs.
Reviewer result contracts may need optional `category` and `altitudeScope` fields. If models omit category, the filter can conservatively treat `blocker`/`warning` as in-scope for `build` and out-of-scope or warning-only for early gates unless the altitude prompt requires categories.
### Feedback integration

Extend `createReviewerFeedback` or add a sibling helper so deterministic findings use the same persistence path. Persisted feedback should include:
- `target: 'implementation'`.
- A title and body safe for humans.
- Optional anchor when source path/range can be represented.
- A thread author principal representing the model reviewer for reviewer findings or a system principal for deterministic findings.
- Metadata in the round record for altitude, source, category, blocking status, signature, and checkpoint refs.
If the current `Feedback` schema cannot store metadata directly, keep metadata in `ConvergenceRoundFinding` and make the feedback body explicit enough for humans.
The system principal is an intentional extension to the existing review framing: model reviewers still author reviewer findings, while the host authors deterministic contract and drift findings. This keeps all findings visible through one feedback path without pretending a model principal observed a host-computed invariant.
Deterministic feedback lifecycle:
1. Before persisting deterministic findings for a round, compute each finding's stable deterministic key from `source`, `ruleId`, `altitude`, normalized path, symbol when known, accepted checkpoint context when relevant, and canonical violation signature.
2. Query existing open deterministic feedback for the run step by deterministic key.
3. For an emitted key that already has open feedback, attach the existing feedback id to the current round finding and update safe title/body/metadata if the repository supports updates; do not create duplicate open feedback for the same key.
4. For an emitted key with no open feedback, create system-authored `Feedback` through the convergence feedback path and attach the new id to the round finding.
5. For a previously open deterministic key that is not emitted by the current committed-state check, auto-resolve the feedback with system reason `deterministic_check_passed`, record the resolution in the round/checkpoint metadata, and remove the id from `openFeedbackIds`.
6. Human gates and altitude convergence must consider only current-round blocking deterministic findings plus unresolved reviewer feedback. Previous-round deterministic feedback that has been auto-resolved or omitted from the current recomputation must not block descent, build convergence, or human review.
### Execution context and prompts

The role dispatcher should receive altitude context for both implementer and reviewer sessions:
- Current altitude and altitude-round number.
- The allowed work for the altitude.
- Required disposition format for carried-forward blockers.
- Previously accepted checkpoint refs and summaries.
- A reminder that early altitudes must not add bodies, executable statements, or tests.
- Reviewer category allowlist and severity rules for the current altitude.
Prompt text is not a security boundary. The deterministic validators and reviewer read-only tool policy enforce the behavior.
### Error handling and escalation

- Invalid depth config should fail safely with a sanitized workflow configuration reason.
- Internal ref capture failure after an accepted non-final altitude should not discard converged work when recovery is plausible. The run must not descend without the checkpoint; after persisting the accepted altitude state and sanitized error context, return `needs_input` for operator/human recovery. Only unrecoverable workspace/git integrity failures should return `fail`.
- Altitude contract violations are findings, not system failures.
- Build drift is a finding, not a system failure.
- Git command failures, workspace containment failures, and invalid checkpoint-ref namespaces are system failures with sanitized diagnostics.
- Max rounds or oscillation at any altitude returns `needs_input` through the existing `implementation.build` transition.
- The checkpoint should record the current altitude and accepted refs before escalation whenever possible.
### Testing strategy

#### Unit tests

- Depth-to-ladder mapping for all four depth values and absent depth fallback.
- Policy parsing and default behavior in `getStepConvergencePolicy`.
- Altitude validator allows declarations, interfaces, type aliases, imports, comments, and signatures.
- Altitude validator rejects bodies, executable statements, parse failures, and test file patterns at early gates.
- Finding filter makes `info` non-blocking and demotes out-of-scope early findings.
- Finding filter leaves build non-`info` findings blocking.
- Git checkpoint ref namespace construction rejects unsafe path/ref segments.
- Build drift checker detects removed or renamed accepted source paths, removed exports, renamed exports, changed public signatures, changed public type shapes, and changed private helper signatures at full depth. Moving an accepted export to a new source path blocks as accepted-path drift even if the exported name is preserved.
- Build drift checker allows new exports, added bodies, and formatting-only changes.
- Convergence checkpoint schema validates altitude, depth, round altitude, and accepted checkpoint refs.
#### Integration tests

- `implementation.build` with no depth config follows the existing single build-altitude convergence behavior.
- `implementation.build` with `layout` depth converges layout, captures a layout ref, then converges build.
- `implementation.build` with `full` depth records rounds for `layout`, `public_api`, `private_api`, and `build`.
- Early-altitude contract violations persist feedback and block descent.
- Checkpoint refs are captured by the host port and stored on the run-step checkpoint.
- Build drift findings persist as `Feedback` and block build convergence.
- Max-round escalation at an early altitude moves the run to `implementation.awaiting_input` and records current altitude.
#### Real production-path coverage

Add or extend control-plane smoke coverage so it drives the production dispatch path over a real workspace and git branch:
- Required non-skippable CI command: `pnpm test -- --run production-path-smoke` or the nearest repository-specific equivalent recorded with the implementation. It must run without live provider credentials by using a deterministic scripted provider adapter at the provider-response seam.
- Required non-skippable CI happy path: full ladder descends through all four altitudes, implementer dispatch creates commits at each altitude, reviewer dispatch reviews each altitude, checkpoint refs are captured between early gates, build converges, and the run advances.
- Required non-skippable CI forced-drift path: an export or accepted source path accepted at `public_api` is removed or renamed at `build`; the ladder reaches build, build drift is raised as a blocking finding, and convergence holds.
- Early-contract path: an early altitude attempts a body or test; the deterministic validator raises a blocking contract finding.
- Assertions cover persisted `Feedback`, run-step checkpoint altitude data, internal refs, session role/round data, and run transition state.
- Deterministic non-live production-path coverage may script provider responses, but only at the provider-response seam. The real seams under test are orchestration, layered coordinator, implementer/reviewer role dispatch, altitude prompt/context construction, session recording, workspace git commits, checkpoint ref capture, deterministic validation, drift checking, feedback writing, run-step checkpoint persistence, and run transition handling.
Live-provider variants may stay opt-in behind environment variables and may be skipped when credentials are absent. The acceptance gate is the non-skippable production-path smoke above: fake/scripted provider responses through the real dispatcher are required in CI; live provider execution is optional supplemental coverage.
### Rollout and compatibility

Ship depth as optional workflow data. Existing workflows that do not configure depth continue as `build_only`. Add tests around the fallback before enabling any deeper depth in default workflows. If a workflow later opts into full depth, ensure model-routing and provider read-only support are already configured for reviewed implementation sessions.
### Implementation discovery notes

- `packages/api-contract/src/convergence.ts` already includes `ConvergenceOutcome` with `needs_input`; the new altitude fields should preserve existing valid checkpoints or include migration-tolerant parsing for older checkpoint payloads.
- `packages/core/src/convergence-engine.ts` currently builds checkpoints with one flat `rounds` array and no altitude. The refactor should avoid duplicating its blocking/disposition logic.
- `DefaultOrchestrator.#isReviewedProducingStep` intentionally scopes reviewed dispatch to `implementation.build` today. Issue 61 can keep that scope.
- The concrete git port lives in the control-plane app, not core. Add checkpoint-ref operations there while keeping core provider-neutral.
- Provider adapters that cannot enforce reviewer read-only tools remain unsupported for reviewed reviewer sessions and must fail safely or grant no file/git access.
## Task list

### Story 1: Define shared altitude contracts and policy parsing

#### Task 1.1: Add altitude-aware convergence schemas

**Description:** Extend `packages/api-contract/src/convergence.ts` and `packages/api-contract/src/run-step.ts` with the agreed altitude, depth, finding source/category, accepted checkpoint, round record, and checkpoint schemas. Keep old build-only checkpoint payloads readable by defaulting missing round altitude to `build`.
**Acceptance criteria:**
- `implementationAltitudeSchema`, `implementationConvergenceDepthSchema`, finding source/category schemas, `altitudeCheckpointRefSchema`, and updated convergence schemas are exported with the names and semantics described in the Data contracts section.
- `convergenceRoundRecordSchema` accepts legacy records without `altitude` and returns parsed records with `altitude: 'build'`.
- `round` is interpreted as per-altitude round number; schema tests cover repeated round numbers across different altitudes in the same flat checkpoint array.
- `runStepCheckpointResultSchema` validates altitude-aware `convergence_review` checkpoint payloads.
- Existing convergence schema tests still pass, and new tests cover valid altitude checkpoints plus migration-tolerant legacy checkpoint parsing.
**Dependencies:** None.
#### Task 1.2: Parse implementation depth and map ladders

**Description:** Extend workflow convergence policy parsing so `implementation.build` reads optional `depth`, normalizes absent depth to `build_only`, and maps depth values to ordered altitude ladders.
**Acceptance criteria:**
- `StepConvergencePolicy` exposes resolved non-optional `depth: ImplementationConvergenceDepth`.
- `getStepConvergencePolicy` returns `build_only` when workflow depth is absent and rejects malformed depth or `maxRounds` values with sanitized configuration errors.
- `getImplementationAltitudeLadder` maps `build_only`, `layout`, `public_api`, and `full` to the exact ladders in the acceptance criteria.
- Workflow step convergence config accepts optional depth without adding new top-level workflow steps.
- Unit tests cover all ladder mappings, absent-depth fallback, invalid depth, and non-`implementation.build` compatibility behavior.
**Dependencies:** Task 1.1.
### Story 2: Add host-owned checkpoint git operations

#### Task 2.1: Extend the workspace git port contract

**Description:** Add checkpoint ref capture and read/list-at-ref operations to `packages/core/src/run-workspace-git.ts` so core code can create host-owned comparison points without checking out refs.
**Acceptance criteria:**
- `RunWorkspaceGitPort` includes `captureCheckpointRef`, `readFileAtRef`, and `listFilesAtRef` with the input and result types described in the Host git checkpoint port section.
- The checkpoint capture input only accepts non-build altitudes.
- Core types keep checkpoint creation behind the host git port and do not expose ref creation to agents.
- Type tests or compile checks prove downstream callers must supply the new port operations.
**Dependencies:** Task 1.1.
#### Task 2.2: Implement safe checkpoint refs in control-plane

**Description:** Implement the new git port operations in `apps/control-plane/src/run-workspace-git-port.ts` using argument-array git commands, containment checks, and a run-scoped `refs/autocatalyst/...` namespace.
**Acceptance criteria:**
- `captureCheckpointRef` creates or updates an internal ref under `refs/autocatalyst/runs//implementation.build//...` for the supplied commit without switching branches.
- `readFileAtRef` reads a repository-relative file from a ref or commit and returns `null` when the file is absent.
- `listFilesAtRef` lists tracked files at a ref or commit without checking out the ref.
- Invalid run ids, altitude segments, refs, paths, and repository roots fail safely with sanitized errors.
- Unit or integration tests cover valid capture/read/list behavior and namespace/path rejection cases.
**Dependencies:** Task 2.1.
### Story 3: Enforce early-altitude contracts and finding scope

#### Task 3.1: Implement the altitude contract validator

**Description:** Add `packages/core/src/altitude-contract-validator.ts` to inspect committed early-altitude source with injected git reads and return deterministic convergence findings for contract violations.
**Acceptance criteria:**
- The validator rejects added or modified test files matching common test path patterns at `layout`, `public_api`, and `private_api`.
- The validator uses TypeScript AST parsing for `.ts` and `.tsx` files to reject function or method bodies and executable top-level statements at early altitudes.
- The validator implements the AST allow/deny table from the tech spec, including class members, field and const initializers, enums, side-effect imports, ambient declarations, TSX JSX syntax, generated files, and unsupported non-TypeScript source files.
- Parse failures produce blocking `altitude_contract` findings with safe messages instead of accepting unknown executable shapes.
- Returned findings include altitude, source, category, blocking status, signature, and useful file context.
- Returned deterministic findings are recomputed from committed files on each round and do not accept or store implementer decline dispositions as a clearing mechanism.
- Unit tests cover allowed declarations and rejected bodies, statements, tests, class bodies, initializers, enums, side-effect imports, JSX/TSX, unsupported languages, generated files, and parse failures.
**Dependencies:** Task 1.1, Task 2.1.
#### Task 3.2: Implement altitude-scoped finding filtering

**Description:** Add `packages/core/src/layered-finding-filter.ts` to classify reviewer and deterministic findings before convergence gates decide whether the current altitude can advance.
**Acceptance criteria:**
- `filterAltitudeFindings` promotes raw reviewer findings into `ConvergenceRoundFinding` records when needed.
- `info` severity findings never block.
- Early altitudes only block findings in their allowlist plus contract violations.
- Deterministic `altitude_contract` and `build_drift` findings keep their deterministic blocking status and cannot be demoted by implementer declined signatures or other disposition state.
- Filtering ignores stale deterministic findings that are not re-emitted for the current committed state; those ids are auto-resolved or removed from `openFeedbackIds` by the deterministic feedback lifecycle.
- Out-of-scope and lower-altitude findings are persisted as non-blocking notes with a clear `blockingReason`.
- `build` leaves all non-`info` findings blocking, including build drift.
- Unit tests cover each altitude, uncategorized reviewer findings, `info` demotion, out-of-scope demotion, and build behavior.
**Dependencies:** Task 1.1.
#### Task 3.3: Persist deterministic and reviewer findings through one feedback path

**Description:** Extend `packages/core/src/convergence-feedback.ts` so reviewer, altitude-contract, and build-drift findings all persist as first-class `Feedback` while preserving altitude metadata in convergence round records.
**Acceptance criteria:**
- `createConvergenceFeedback` accepts the agreed input shape, including run id, step, altitude, round, target, findings, author, and optional anchor.
- Deterministic findings use a system author principal, reviewer findings use a reviewer author principal, and all feedback targets implementation.
- Feedback titles and bodies are human-readable and sanitized.
- Created feedback ids are attached back to round findings when available.
- Deterministic findings use stable deterministic keys to deduplicate across rounds, reuse/update existing open feedback, and auto-resolve previous deterministic feedback when recomputation passes.
- Existing `createReviewerFeedback` behavior remains compatible or delegates safely to the new helper.
- Tests cover reviewer, altitude-contract, and build-drift feedback creation, deterministic deduplication across rounds, and auto-resolution/removal from `openFeedbackIds` after compliance.
**Dependencies:** Task 1.1, Task 3.2.
### Story 4: Detect build-time contract drift

#### Task 4.1: Extract canonical TypeScript contract signatures

**Description:** Build reusable contract extraction inside `packages/core/src/build-contract-preservation.ts` for public exports and private helper signatures, using TypeScript AST data rather than whitespace-sensitive text comparison.
**Acceptance criteria:**
- The extractor records source path, symbol name, export/private scope, kind, and canonical signature/type shape.
- Public extraction covers function, method, class, interface, type alias, enum, and constant surfaces.
- Private extraction covers internal helper signatures when a `private_api` checkpoint exists.
- Bodies and formatting are ignored for compatibility comparison.
- Parse or git-read failures return safe contract extraction errors for the caller to convert into findings or system failures according to the tech spec.
- Unit tests cover stable canonical output across formatting changes.
**Dependencies:** Task 1.1, Task 2.1.
#### Task 4.2: Implement build contract preservation checks

**Description:** Compare the final build commit against accepted early-altitude checkpoints and emit blocking `build_drift` findings for removed, renamed, or incompatible accepted contracts.
**Acceptance criteria:**
- `validateBuildContractPreservation` reads accepted checkpoint files and build files through injected `readFileAtRef` and `listFilesAtRef` operations.
- Removed or renamed accepted source paths, missing accepted exports, renamed exports, changed public signatures, changed public type shapes, and changed full-depth private helper signatures produce blocking build-drift findings. New files are allowed, but they do not replace an accepted source path for v0 drift purposes.
- Added bodies, new exports, and formatting-only changes do not block.
- Findings include build altitude, accepted checkpoint altitude, checkpoint ref, build commit, source path, symbol when known, category, blocking status, and signature.
- Build-drift findings are recomputed at each build round from the accepted checkpoints and current build commit and cannot be cleared by implementer decline dispositions.
- Tests cover removed/renamed accepted source paths, removed/renamed exports, changed public contracts, changed private contracts, added bodies, new exports, and formatting-only changes.
**Dependencies:** Task 4.1.
### Story 5: Coordinate per-altitude convergence without changing the top-level workflow step

#### Task 5.1: Extract an altitude-aware single-loop runner

**Description:** Refactor `packages/core/src/convergence-engine.ts` so the existing implementer/reviewer round logic can run one altitude with explicit dependencies and altitude context, while preserving legacy build-only behavior.
**Acceptance criteria:**
- `runConvergenceAltitude` is exported with the agreed input and result types.
- The runner uses the existing dispatcher, routing, feedback, persistence, max-round, oscillation, disposition, and blocking logic instead of duplicating it.
- Implementer and reviewer sessions receive current altitude, altitude round, allowed work, prior checkpoint context, and finding category guidance.
- Max-round and oscillation tracking are scoped to the current altitude, with `round` reset to 1 when a new altitude starts.
- Early-altitude validation runs after each implementer commit and before acceptance checks when a validator is supplied.
- Build preservation runs before build acceptance when a validator is supplied.
- Deterministic validator and drift findings are merged after reviewer dispositions are processed but before blocking evaluation, so implementer decline dispositions cannot remove deterministic blockers.
- Existing issue 59 build-only convergence tests pass with `altitude: 'build'`.
**Dependencies:** Task 1.1, Task 3.1, Task 3.2, Task 3.3, Task 4.2.
#### Task 5.2: Add the layered convergence coordinator

**Description:** Add `packages/core/src/layered-convergence-engine.ts` to resolve the ladder, run each altitude to convergence or escalation, capture accepted non-final checkpoints, and return the existing orchestrator directives.
**Acceptance criteria:**
- `createLayeredConvergenceEngine` coordinates the selected ladder for `implementation.build`.
- `[build]` depth follows the existing single-loop behavior with no early checkpoints required.
- Non-final accepted altitudes capture host-owned checkpoint refs before descent.
- The coordinator does not descend if an altitude has blocking findings, reaches max rounds, oscillates, or lacks a captured checkpoint.
- Recoverable checkpoint capture failure after an accepted non-final altitude returns `needs_input` with the accepted work preserved; unrecoverable workspace/git integrity failures return `fail`.
- `currentAltitude`, per-round altitude data, accepted checkpoint refs, open feedback ids, and final outcome are persisted in the run-step checkpoint.
- `needs_input`, `advance`, and `fail` directives match the existing run workflow transition expectations.
- Tests cover clean `build_only`, `layout`, and `full` ladders plus early escalation, per-altitude round reset, and recoverable checkpoint capture failure.
**Dependencies:** Task 2.2, Task 5.1.
#### Task 5.3: Wire layered convergence into the orchestrator

**Description:** Compose the layered coordinator where `DefaultOrchestrator` currently routes reviewed producing steps, keeping reviewed dispatch scoped to `implementation.build`.
**Acceptance criteria:**
- `implementation.build` uses the layered coordinator in production dispatch.
- No new `Run.currentStep` values are introduced for layout, public API, or private API.
- Existing workflows without depth configured still advance, pause, or fail exactly as the issue 59 build-only path did.
- Invalid depth config fails safely with sanitized workflow configuration output.
- Tests assert that other workflow steps do not accidentally run layered implementation convergence.
**Dependencies:** Task 5.2.
### Story 6: Prove behavior across unit, integration, and production paths

#### Task 6.1: Add focused unit and integration coverage

**Description:** Fill the test matrix from the tech spec across schemas, policy, validators, filtering, git refs, drift checking, feedback, checkpoint persistence, and orchestrator behavior.
**Acceptance criteria:**
- Unit tests cover every validator, filter, policy, schema, git namespace, and drift rule listed in the tech spec.
- Integration tests prove no-depth fallback, `layout` depth checkpoint capture, `full` depth round recording, early contract feedback blocking, build drift feedback blocking, and early max-round escalation.
- Integration tests prove deterministic blockers persist even if the implementer attempts to decline or dismiss them, and clear only after the committed diff complies.
- Tests assert deterministic findings are persisted through the convergence-feedback path.
- Tests assert checkpoint metadata survives repository persistence and schema parsing.
- Targeted package test commands pass locally.
**Dependencies:** Task 5.3.
#### Task 6.2: Add production-path control-plane smoke coverage

**Description:** Add or extend control-plane smoke tests that drive the real production dispatch path over a real workspace and git branch without mocking altitude outcomes directly. The required CI suite uses deterministic non-live scripted provider responses only at the provider-response seam while still exercising the real dispatcher. Optional live-provider variants may run the same scenarios when credentials are available.
**Acceptance criteria:**
- Required non-skippable CI happy-path coverage descends `layout → public_api → private_api → build`, drives implementer commits at each altitude and reviewer reviews at each altitude through the real role dispatcher, captures internal refs between early gates, converges build, and advances the run.
- Required non-skippable CI forced-drift coverage accepts a public API checkpoint, removes or renames the accepted export or accepted source path at build, raises blocking build feedback, and holds convergence.
- Early-contract coverage attempts a body or test during an early altitude and raises a blocking contract finding.
- Assertions cover persisted feedback, run-step checkpoint altitude data, internal checkpoint refs, session role/round data, and run transition state.
- Deterministic production-path coverage runs without live credentials by scripting provider responses only at the provider-response seam; it still exercises real orchestrator, dispatcher, altitude prompt/context, session, workspace git, checkpoint, validator, drift, feedback, persistence, and transition seams.
- Additional live-provider variants may be environment-gated and skipped when credentials are absent; the required non-live full-ladder happy and forced-drift smoke is acceptance coverage and must not be skipped as optional.
**Dependencies:** Task 6.1.
### Story 7: Update agent navigation and rollout documentation

#### Task 7.1: Update the code map for future agents

**Description:** Update `context-agent/wiki/code-map.md` after implementation so future agents can find altitude policy, validation, checkpoint capture, drift preservation, finding filtering, and tests.
**Acceptance criteria:**
- The code map lists every new or significantly changed module for altitude schemas, policy, validation, checkpoint refs, drift preservation, finding filtering, layered coordination, orchestrator wiring, and production-path smoke tests.
- The code map points to the main unit, integration, and production-path tests for this feature.
- The entry notes that agents must not create checkpoint refs directly; the host git port owns them.
- The entry notes that provider adapters without reviewer read-only support remain unsupported and must fail safely or grant no file/git access.
**Dependencies:** Task 6.2.
#### Task 7.2: Verify compatibility and handoff notes

**Description:** Run the agreed validation commands and record any unsupported provider behavior or skipped live-provider checks in the implementation handoff.
**Acceptance criteria:**
- Existing no-depth workflows are confirmed to use the `build_only` fallback.
- Validation results include targeted tests for policy, schemas, validators, filtering, git port, drift checks, layered coordinator, orchestrator wiring, and production-path smoke coverage.
- Any skipped live-provider checks are called out with the exact missing environment requirement.
- Remaining provider limitations are stated directly: providers that cannot enforce reviewer read-only access remain unsupported for reviewed reviewer sessions and must fail safely or provide no file/git access.
**Dependencies:** Task 7.1.